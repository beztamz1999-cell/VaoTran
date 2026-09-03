import { DomainError, newId, systemClock, type Clock } from '../../platform/core.js';
import type { PostgresDatabase, Transaction } from '../../platform/database/db.js';
import { PostgresIdempotencyGate, type IdempotencyResult } from '../../platform/idempotency.js';
import { appendOutboxEvent, makeDomainEvent } from '../../platform/outbox/outbox.js';
import type { CommandMeta } from '../room/service.js';
import type { Room } from '../room/domain.js';
import { RoomRepository } from '../room/repository.js';
import type { CompletionRequirements } from '../room/lifecycle-service.js';
import {
  assertRatingValue,
  calculateConfidence,
  calculateRollingWeightedScore,
  calculateTrimmedMean,
  effectiveRatingForScore,
  evaluateRatingEligibility,
  evaluateTierTransition,
  isCalibrationOutlier,
  mapScoreToTier,
  type EligibilityReason,
  type EligibilityResult,
  type RankingRuleConfig,
  type SkillProfile,
  type StoredRating,
} from './domain.js';
import { RankingRepository, type RatingParticipant } from './repository.js';

export interface SubmitSkillRatingInput {
  ratingValue: number;
}

export interface BatchSkillRatingInput {
  ratings: Array<{ participantId: string; ratingValue: number }>;
}

export interface RatingEligibilityView extends EligibilityResult {
  participantId: string;
  playerUserId: string;
  ratingSubmitted: boolean;
}

export interface SkillRatingSummary {
  ratingId: string;
  roomId: string;
  participantId: string;
  ratedUserId: string;
  ratingValue: number;
  effectiveRatingValue: number;
  isOutlier: boolean;
  profile: {
    skillState: SkillProfile['skillState'];
    skillScore: number | null;
    rankTier: number | null;
    validRatingCount: number;
    uniqueValidRaterCount: number;
    confidenceLevel: SkillProfile['confidenceLevel'];
  };
}

const summary = (
  ratingId: string,
  roomId: string,
  participantId: string,
  ratedUserId: string,
  ratingValue: number,
  effectiveRatingValue: number,
  isOutlier: boolean,
  profile: SkillProfile,
): SkillRatingSummary => ({
  ratingId,
  roomId,
  participantId,
  ratedUserId,
  ratingValue,
  effectiveRatingValue,
  isOutlier,
  profile: {
    skillState: profile.skillState,
    skillScore: profile.skillScore,
    rankTier: profile.rankTier,
    validRatingCount: profile.validRatingCount,
    uniqueValidRaterCount: profile.uniqueValidRaterCount,
    confidenceLevel: profile.confidenceLevel,
  },
});

export class SkillCompletionRequirements implements CompletionRequirements {
  constructor(private readonly skill: SkillService) {}

  async assertSatisfied(tx: Transaction, room: Room): Promise<void> {
    await this.skill.assertCompletionRatingsSatisfied(tx, room);
  }
}

export class SkillService {
  private readonly idempotency: PostgresIdempotencyGate;

  constructor(
    private readonly db: PostgresDatabase,
    private readonly rooms: RoomRepository,
    private readonly ranking: RankingRepository,
    private readonly clock: Clock = systemClock,
  ) {
    this.idempotency = new PostgresIdempotencyGate(db, clock);
  }

  async submitRating(
    participantId: string,
    meta: CommandMeta,
    input: SubmitSkillRatingInput,
  ): Promise<IdempotencyResult<SkillRatingSummary>> {
    assertRatingValue(input.ratingValue);
    return this.idempotency.execute(meta.idempotency, 200, async (tx) => {
      const candidate = await this.ranking.findParticipantForRating(tx, participantId);
      if (!candidate) throw new DomainError('NOT_PARTICIPANT', 'Room participant was not found.');
      const room = await this.requireHostInProgressRoom(tx, candidate.roomId, meta.actorUserId);
      const participant = await this.requireParticipantLocked(tx, participantId, room.id);
      return this.submitLocked(tx, room, participant, meta.actorUserId, input.ratingValue);
    });
  }

  async submitBatch(
    roomId: string,
    meta: CommandMeta,
    input: BatchSkillRatingInput,
  ): Promise<IdempotencyResult<{ roomId: string; ratings: SkillRatingSummary[] }>> {
    if (input.ratings.length === 0) {
      throw new DomainError('VALIDATION_ERROR', 'At least one rating is required.');
    }
    const participantIds = new Set(input.ratings.map((entry) => entry.participantId));
    if (participantIds.size !== input.ratings.length) {
      throw new DomainError('VALIDATION_ERROR', 'Each participant may appear only once in a rating batch.');
    }
    for (const entry of input.ratings) assertRatingValue(entry.ratingValue);

    return this.idempotency.execute(meta.idempotency, 200, async (tx) => {
      const room = await this.requireHostInProgressRoom(tx, roomId, meta.actorUserId);
      const ratings: SkillRatingSummary[] = [];
      for (const entry of input.ratings) {
        const participant = await this.requireParticipantLocked(tx, entry.participantId, room.id);
        ratings.push(await this.submitLocked(tx, room, participant, meta.actorUserId, entry.ratingValue));
      }
      return { roomId: room.id, ratings };
    });
  }

  async getEligibility(participantId: string, hostUserId: string): Promise<RatingEligibilityView> {
    const participant = await this.ranking.findParticipantForRating(this.db, participantId);
    if (!participant) throw new DomainError('NOT_PARTICIPANT', 'Room participant was not found.');
    const room = await this.rooms.findById(this.db, participant.roomId);
    if (!room) throw new DomainError('ROOM_NOT_FOUND', 'Room was not found.');
    if (room.hostUserId !== hostUserId) throw new DomainError('NOT_ROOM_HOST', 'Only the Room HOST may view rating eligibility.');
    return this.eligibilityForParticipant(this.db, room, participant, hostUserId);
  }

  async assertCompletionRatingsSatisfied(tx: Transaction, room: Room): Promise<void> {
    const present = await this.ranking.listPresentParticipants(tx, room.id);
    const missing: string[] = [];
    for (const person of present) {
      const participant = await this.requireParticipantLocked(tx, person.participantId, room.id);
      const eligibility = await this.eligibilityForParticipant(tx, room, participant, room.hostUserId);
      if (eligibility.eligible && !eligibility.ratingSubmitted) {
        missing.push(participant.participantId);
      }
    }
    if (missing.length > 0) {
      throw new DomainError('ROOM_COMPLETION_INCOMPLETE', 'All PRESENT Players whom the HOST is eligible to rate must be rated before completion.', {
        room_id: room.id,
        missing_rating_participant_ids: missing,
      });
    }
  }

  async onRoomCompleted(tx: Transaction, room: Room, now: Date): Promise<void> {
    await this.ranking.incrementCompletedMatchCount(tx, room.id, room.sportId, now);
  }

  private async submitLocked(
    tx: Transaction,
    room: Room,
    participant: RatingParticipant,
    hostUserId: string,
    ratingValue: number,
  ): Promise<SkillRatingSummary> {
    const config = await this.requireConfig(tx, room.sportId);
    const playerProfile = await this.requireProfile(tx, participant.userId, room.sportId, true);
    const hostProfile = await this.requireProfile(tx, hostUserId, room.sportId, true);
    const alreadyRated = await this.ranking.hasRatingForRoomParticipant(tx, room.id, participant.userId, room.sportId);
    const eligibility = evaluateRatingEligibility({
      hostProfile,
      playerProfile,
      hostUserId,
      playerUserId: participant.userId,
      sportId: room.sportId,
      playerPresent: participant.status === 'ACTIVE' && participant.attendanceStatus === 'PRESENT',
      alreadyRated,
      config,
    });
    if (!eligibility.eligible) {
      throw new DomainError('RATING_NOT_ALLOWED', 'The HOST is not eligible to rate this Player.', {
        participant_id: participant.participantId,
        eligibility_reason: eligibility.reason,
      });
    }

    const ratingsBefore = await this.ranking.listRatingsForProfile(tx, participant.userId, room.sportId);
    const calibration = playerProfile.skillState === 'UNRANKED' || playerProfile.skillState === 'CALIBRATING';
    const capped = effectiveRatingForScore(ratingValue, calibration ? null : playerProfile.skillScore, config.outlierCap);
    const isOutlier = calibration
      ? isCalibrationOutlier(ratingValue, ratingsBefore.map((rating) => rating.ratingValue))
      : capped.isOutlier;
    const ratingId = newId();
    const now = this.clock.now();
    await this.ranking.insertSkillRating(tx, {
      id: ratingId,
      roomId: room.id,
      sportId: room.sportId,
      ratedUserId: participant.userId,
      raterHostUserId: hostUserId,
      ratingValue,
      effectiveRatingValue: capped.effectiveRating,
      playerProfile,
      hostProfile,
      eligibilityReason: eligibility.reason,
      isOutlier,
      ruleVersion: config.version,
      createdAt: now,
    });

    const updated = this.recomputeProjection(playerProfile, [...ratingsBefore, {
      id: ratingId,
      ratingValue,
      effectiveRatingValue: capped.effectiveRating,
      raterHostUserId: hostUserId,
      createdAt: now,
    }], config, now);
    await this.ranking.saveProfile(tx, updated.profile, now);
    await this.appendRatingEvents(tx, {
      room,
      participant,
      actorUserId: hostUserId,
      ratingId,
      ratingValue,
      effectiveRatingValue: capped.effectiveRating,
      isOutlier,
      eligibilityReason: eligibility.reason,
      ruleVersion: config.version,
      before: playerProfile,
      after: updated.profile,
      transition: updated.transition,
      initialRankPublished: updated.initialRankPublished,
      now,
    });
    return summary(ratingId, room.id, participant.participantId, participant.userId, ratingValue, capped.effectiveRating, isOutlier, updated.profile);
  }

  private recomputeProjection(
    before: SkillProfile,
    ratingsNewestFirst: StoredRating[],
    config: RankingRuleConfig,
    now: Date,
  ): { profile: SkillProfile; transition: 'PROMOTED' | 'DEMOTED' | null; initialRankPublished: boolean } {
    const validRatingCount = ratingsNewestFirst.length;
    const uniqueValidRaterCount = new Set(ratingsNewestFirst.map((rating) => rating.raterHostUserId)).size;
    const base: SkillProfile = {
      ...before,
      validRatingCount,
      uniqueValidRaterCount,
      lastValidRatingAt: now,
    };
    if (validRatingCount < config.calibrationRequiredRatings) {
      return {
        profile: { ...base, skillState: 'CALIBRATING', skillScore: null, rankTier: null, confidenceLevel: null },
        transition: null,
        initialRankPublished: false,
      };
    }

    const firstCalibrationRatings = [...ratingsNewestFirst]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, config.calibrationRequiredRatings)
      .map((rating) => rating.ratingValue);
    const initialRankPublished = before.skillState === 'UNRANKED' || before.skillState === 'CALIBRATING';
    const score = initialRankPublished
      ? calculateTrimmedMean(firstCalibrationRatings)
      : calculateRollingWeightedScore([...ratingsNewestFirst].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)), config);
    const confidenceLevel = calculateConfidence(validRatingCount, uniqueValidRaterCount, config.confidenceThresholds);

    if (initialRankPublished) {
      const tier = mapScoreToTier(score, config.tierBoundaries);
      return {
        profile: {
          ...base,
          skillState: tier === 10 ? 'TOP_TIER_LOCKED' : 'RANKED',
          skillScore: score,
          rankTier: tier,
          confidenceLevel,
          lastRankChangeAt: now,
          lastRankChangeRatingCount: validRatingCount,
        },
        transition: null,
        initialRankPublished: true,
      };
    }

    const tierEvaluation = evaluateTierTransition(before, score, config);
    const reachedTopTier = tierEvaluation.nextTier === 10;
    const profile: SkillProfile = {
      ...base,
      skillState: reachedTopTier ? 'TOP_TIER_LOCKED' : 'RANKED',
      skillScore: score,
      rankTier: tierEvaluation.nextTier,
      confidenceLevel,
      lastRankChangeAt: tierEvaluation.transition ? now : before.lastRankChangeAt,
      lastRankChangeRatingCount: tierEvaluation.transition ? validRatingCount : before.lastRankChangeRatingCount,
    };
    return { profile, transition: tierEvaluation.transition, initialRankPublished: false };
  }

  private async appendRatingEvents(tx: Transaction, input: {
    room: Room;
    participant: RatingParticipant;
    actorUserId: string;
    ratingId: string;
    ratingValue: number;
    effectiveRatingValue: number;
    isOutlier: boolean;
    eligibilityReason: EligibilityReason;
    ruleVersion: string;
    before: SkillProfile;
    after: SkillProfile;
    transition: 'PROMOTED' | 'DEMOTED' | null;
    initialRankPublished: boolean;
    now: Date;
  }): Promise<void> {
    const append = async (eventType: string, payload: Record<string, unknown>): Promise<void> => {
      await appendOutboxEvent(tx, makeDomainEvent({
        eventType,
        aggregateType: 'USER_SPORT_PROFILE',
        aggregateId: input.after.userId,
        actorUserId: input.actorUserId,
        correlationId: null,
        causationId: input.ratingId,
        schemaVersion: 1,
        payload: { room_id: input.room.id, participant_id: input.participant.participantId, sport_id: input.room.sportId, rating_id: input.ratingId, ...payload },
        occurredAt: input.now,
      }, this.clock));
    };
    await append('VALID_SKILL_RATING_SUBMITTED', {
      rated_user_id: input.after.userId,
      rating_value: input.ratingValue,
      effective_rating_value: input.effectiveRatingValue,
      eligibility_reason: input.eligibilityReason,
      rule_version: input.ruleVersion,
    });
    if (input.before.skillState === 'UNRANKED') {
      await append('PLAYER_CALIBRATION_STARTED', { rated_user_id: input.after.userId, valid_rating_count: input.after.validRatingCount });
    }
    if (input.after.skillState === 'CALIBRATING') {
      await append('PLAYER_CALIBRATION_PROGRESS_UPDATED', { rated_user_id: input.after.userId, valid_rating_count: input.after.validRatingCount });
    }
    if (input.initialRankPublished) {
      await append('PLAYER_INITIAL_RANK_PUBLISHED', { rated_user_id: input.after.userId, skill_score: input.after.skillScore, rank_tier: input.after.rankTier, confidence_level: input.after.confidenceLevel });
    } else {
      await append('PLAYER_SKILL_SCORE_UPDATED', { rated_user_id: input.after.userId, skill_score: input.after.skillScore, rank_tier: input.after.rankTier });
    }
    if (input.transition === 'PROMOTED') await append('PLAYER_RANK_PROMOTED', { rated_user_id: input.after.userId, rank_tier: input.after.rankTier });
    if (input.transition === 'DEMOTED') await append('PLAYER_RANK_DEMOTED', { rated_user_id: input.after.userId, rank_tier: input.after.rankTier });
    if (input.isOutlier) await append('RATING_OUTLIER_DETECTED', { rated_user_id: input.after.userId, raw_rating_value: input.ratingValue, effective_rating_value: input.effectiveRatingValue });
    if (input.after.skillState === 'TOP_TIER_LOCKED' && input.before.skillState !== 'TOP_TIER_LOCKED') {
      await append('TOP_TIER_REACHED', { rated_user_id: input.after.userId, rank_tier: input.after.rankTier });
    }
  }

  private async eligibilityForParticipant(
    executor: Transaction | PostgresDatabase,
    room: Room,
    participant: RatingParticipant,
    hostUserId: string,
  ): Promise<RatingEligibilityView> {
    const config = await this.requireConfig(executor, room.sportId);
    const playerProfile = await this.requireProfile(executor, participant.userId, room.sportId);
    const hostProfile = await this.requireProfile(executor, hostUserId, room.sportId);
    const ratingSubmitted = await this.ranking.hasRatingForRoomParticipant(executor, room.id, participant.userId, room.sportId);
    const result = evaluateRatingEligibility({
      hostProfile,
      playerProfile,
      hostUserId,
      playerUserId: participant.userId,
      sportId: room.sportId,
      playerPresent: participant.status === 'ACTIVE' && participant.attendanceStatus === 'PRESENT',
      alreadyRated: ratingSubmitted,
      config,
    });
    return { participantId: participant.participantId, playerUserId: participant.userId, ratingSubmitted, ...result };
  }

  private async requireHostInProgressRoom(tx: Transaction, roomId: string, actorUserId: string): Promise<Room> {
    const room = await this.rooms.findById(tx, roomId, true);
    if (!room) throw new DomainError('ROOM_NOT_FOUND', 'Room was not found.');
    if (room.hostUserId !== actorUserId) throw new DomainError('NOT_ROOM_HOST', 'Only the Room HOST may submit skill ratings.');
    if (room.status !== 'IN_PROGRESS') throw new DomainError('RATING_NOT_ALLOWED', 'Skill ratings may only be submitted while the Room is in progress.');
    return room;
  }

  private async requireParticipantLocked(tx: Transaction, participantId: string, roomId: string): Promise<RatingParticipant> {
    const participant = await this.ranking.findParticipantForRating(tx, participantId, true);
    if (!participant || participant.roomId !== roomId) throw new DomainError('NOT_PARTICIPANT', 'Room participant was not found in this Room.');
    return participant;
  }

  private async requireConfig(executor: Transaction | PostgresDatabase, sportId: string): Promise<RankingRuleConfig> {
    const config = await this.ranking.getActiveRuleConfig(executor, sportId);
    if (!config) throw new DomainError('RANKING_RULE_NOT_FOUND', 'No active ranking rule configuration exists for this sport.');
    return config;
  }

  private async requireProfile(executor: Transaction | PostgresDatabase, userId: string, sportId: string, lock = false): Promise<SkillProfile> {
    const profile = await this.ranking.findProfile(executor, userId, sportId, lock);
    if (!profile) throw new DomainError('RATING_NOT_ALLOWED', 'A sport profile is required to process skill ratings.', { user_id: userId, sport_id: sportId });
    return profile;
  }
}
