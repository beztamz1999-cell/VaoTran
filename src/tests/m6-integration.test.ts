import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { type Clock } from '../platform/core.js';
import { PostgresDatabase } from '../platform/database/db.js';
import { ParticipationRepository } from '../modules/participation/repository.js';
import { ParticipationService } from '../modules/participation/service.js';
import { ReliabilityRepository } from '../modules/reliability/repository.js';
import { ReliabilityService } from '../modules/reliability/service.js';
import { RankingRepository } from '../modules/ranking/repository.js';
import { SkillCompletionRequirements, SkillService } from '../modules/ranking/service.js';
import { evaluateTierTransition } from '../modules/ranking/domain.js';
import { RoomLifecycleService } from '../modules/room/lifecycle-service.js';
import { RoomRepository } from '../modules/room/repository.js';
import { RoomService, type CommandMeta } from '../modules/room/service.js';

const integration = process.env.DATABASE_URL ? describe : describe.skip;
const sportId = '10000000-0000-4000-8000-000000000001';
const hostId = '20000000-0000-4000-8000-000000000001';
const playerOneId = '20000000-0000-4000-8000-000000000002';
const playerTwoId = '20000000-0000-4000-8000-000000000003';

class MutableClock implements Clock {
  constructor(public current = new Date('2026-12-01T07:00:00.000Z')) {}
  now(): Date { return new Date(this.current); }
  set(value: Date | string): void { this.current = new Date(value); }
}

const meta = (actorUserId: string, key: string, commandType: string, request: unknown = {}): CommandMeta => ({
  actorUserId,
  idempotency: { key, actorUserId, commandType, request },
});

integration('M6 Skill, Calibration & Ranking (PostgreSQL)', () => {
  let db: PostgresDatabase;
  let roomRepository: RoomRepository;
  let participationRepository: ParticipationRepository;
  let rankingRepository: RankingRepository;
  let reliabilityRepository: ReliabilityRepository;
  let reliability: ReliabilityService;
  let rooms: RoomService;
  let participation: ParticipationService;
  let skill: SkillService;
  let lifecycle: RoomLifecycleService;
  let clock: MutableClock;
  let sequence = 0;
  const key = (label: string): string => `m6-${label}-${++sequence}`;

  beforeAll(async () => {
    db = new PostgresDatabase();
    roomRepository = new RoomRepository();
    participationRepository = new ParticipationRepository();
    rankingRepository = new RankingRepository();
    reliabilityRepository = new ReliabilityRepository();
    await db.query('SELECT 1');
  });

  beforeEach(async () => {
    sequence = 0;
    clock = new MutableClock();
    reliability = new ReliabilityService(db, roomRepository, participationRepository, reliabilityRepository, clock);
    rooms = new RoomService(db, roomRepository, clock, participationRepository, reliability);
    participation = new ParticipationService(db, roomRepository, participationRepository, clock, reliability);
    skill = new SkillService(db, roomRepository, rankingRepository, clock);
    lifecycle = new RoomLifecycleService(
      db, roomRepository, participationRepository, new SkillCompletionRequirements(skill), clock, reliability, skill,
    );
    await db.query(`TRUNCATE
      skill_ratings, reliability_adjustments, participation_cancellations, slot_recovery_records, room_refill_states,
      player_reliability_stats, host_stats, participant_attendance_logs, room_participants,
      room_application_members, room_applications, room_availability_projections, room_change_logs,
      room_equipment_options, room_equipment_policies, rooms, search_telemetry_events,
      event_consumptions, event_outbox, idempotency_keys, user_sport_profiles, users CASCADE`);
    await db.query(
      `INSERT INTO users (id, phone, display_name, status, created_at, updated_at) VALUES
       ($1, '0900000001', 'HOST', 'ACTIVE', NOW(), NOW()),
       ($2, '0900000002', 'Player One', 'ACTIVE', NOW(), NOW()),
       ($3, '0900000003', 'Player Two', 'ACTIVE', NOW(), NOW())`,
      [hostId, playerOneId, playerTwoId],
    );
    await db.query(
      `INSERT INTO user_sport_profiles (
        user_id, sport_id, skill_state, skill_score, rank_tier, valid_rating_count,
        completed_match_count, unique_valid_rater_count, last_rank_change_rating_count, created_at, updated_at
      ) VALUES
       ($1, $4, 'RANKED', 8.00, 8, 10, 10, 4, 10, NOW(), NOW()),
       ($2, $4, 'UNRANKED', NULL, NULL, 0, 0, 0, 0, NOW(), NOW()),
       ($3, $4, 'UNRANKED', NULL, NULL, 0, 0, 0, 0, NOW(), NOW())`,
      [hostId, playerOneId, playerTwoId, sportId],
    );
  });

  afterAll(async () => { await db.close(); });

  const createStartedRoom = async (playerIds: string[], startAt = clock.now()): Promise<{ roomId: string; participantIds: string[] }> => {
    const created = await rooms.create(meta(hostId, key('create'), 'CreateRoom', { player_count: playerIds.length }), {
      sportCode: 'BADMINTON', title: 'M6 skill room', venue: { name: 'Sân M6', latitude: 10.776, longitude: 106.700 },
      scheduledStartAt: startAt, scheduledEndAt: new Date(startAt.getTime() + 2 * 60 * 60 * 1000),
      capacity: playerIds.length + 1, hostParticipates: true, reservedExternalCount: 0, priceAmount: null, currency: 'VND',
      preferredSkill: { minScore: 3, maxScore: 9 }, equipment: { supplyMode: 'PLAYER_BRINGS' }, allowEmergencyReplacement: false,
    });
    await rooms.publish(created.body.roomId, meta(hostId, key('publish'), 'PublishRoom', {}));
    const participantIds: string[] = [];
    for (const playerId of playerIds) {
      const application = await participation.createApplication(created.body.roomId, meta(playerId, key('apply'), 'CreateJoinApplication', {}), {});
      const accepted = await participation.acceptApplication(application.body.applicationId, meta(hostId, key('accept'), 'AcceptJoinApplication', {}));
      participantIds.push(accepted.body.participantIds[0]!);
    }
    await lifecycle.manualStart(created.body.roomId, meta(hostId, key('start'), 'StartRoom', {}));
    for (const participantId of participantIds) {
      await participation.markPresent(participantId, meta(hostId, key('present'), 'MarkParticipantPresent', {}));
    }
    return { roomId: created.body.roomId, participantIds };
  };

  it('blocks completion only for eligible PRESENT rating, then completes atomically after rating', async () => {
    const { roomId, participantIds } = await createStartedRoom([playerOneId]);
    await expect(lifecycle.complete(roomId, meta(hostId, key('complete-missing'), 'CompleteRoom', {})))
      .rejects.toMatchObject({ code: 'ROOM_COMPLETION_INCOMPLETE', details: { missing_rating_participant_ids: [participantIds[0]] } });

    const rating = await skill.submitRating(participantIds[0]!, meta(hostId, key('rate'), 'SubmitSkillRating', { rating_value: 6.5 }), { ratingValue: 6.5 });
    expect(rating.body).toMatchObject({ ratingValue: 6.5, effectiveRatingValue: 6.5, isOutlier: false, profile: { skillState: 'CALIBRATING', validRatingCount: 1 } });
    await expect(lifecycle.complete(roomId, meta(hostId, key('complete'), 'CompleteRoom', {})))
      .resolves.toMatchObject({ body: { status: 'COMPLETED' } });

    const completed = await db.query<{ completed_match_count: number }>(
      'SELECT completed_match_count FROM user_sport_profiles WHERE user_id = $1 AND sport_id = $2', [playerOneId, sportId],
    );
    expect(completed.rows[0]?.completed_match_count).toBe(1);
  });

  it('persists raw rating evidence while capping a post-calibration outlier, and idempotent replay is side-effect free', async () => {
    await db.query(
      `UPDATE user_sport_profiles
       SET skill_state = 'RANKED', skill_score = 6.00, rank_tier = 6, valid_rating_count = 3,
           unique_valid_rater_count = 2, last_rank_change_rating_count = 0
       WHERE user_id = $1 AND sport_id = $2`,
      [playerOneId, sportId],
    );
    const { roomId, participantIds } = await createStartedRoom([playerOneId]);
    const command = meta(hostId, 'm6-outlier-replay', 'SubmitSkillRating', { rating_value: 10 });
    const first = await skill.submitRating(participantIds[0]!, command, { ratingValue: 10 });
    const replay = await skill.submitRating(participantIds[0]!, command, { ratingValue: 10 });
    expect(first.body).toMatchObject({ ratingValue: 10, effectiveRatingValue: 8, isOutlier: true });
    expect(replay.replayed).toBe(true);
    const rows = await db.query<{ rating_value: string; effective_rating_value: string; is_outlier: boolean }>(
      'SELECT rating_value, effective_rating_value, is_outlier FROM skill_ratings WHERE room_id = $1', [roomId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ rating_value: '10.00', effective_rating_value: '8.00', is_outlier: true });
  });

  it('enforces one raw rating per room/player and rejects same-tier HOST authority', async () => {
    const { participantIds } = await createStartedRoom([playerOneId]);
    await skill.submitRating(participantIds[0]!, meta(hostId, key('first'), 'SubmitSkillRating', {}), { ratingValue: 6 });
    await expect(skill.submitRating(participantIds[0]!, meta(hostId, key('duplicate'), 'SubmitSkillRating', {}), { ratingValue: 6 }))
      .rejects.toMatchObject({ code: 'RATING_NOT_ALLOWED', details: { eligibility_reason: 'INELIGIBLE_DUPLICATE_ROOM_RATING' } });

    await db.query(
      `UPDATE user_sport_profiles
       SET skill_state = 'RANKED', skill_score = 6, rank_tier = 6
       WHERE user_id = ANY($1::uuid[]) AND sport_id = $2`, [[hostId, playerTwoId], sportId],
    );
    clock.set('2026-12-01T10:00:00.000Z');
    const second = await createStartedRoom([playerTwoId], clock.now());
    await expect(skill.submitRating(second.participantIds[0]!, meta(hostId, key('same-tier'), 'SubmitSkillRating', {}), { ratingValue: 6 }))
      .rejects.toMatchObject({ code: 'RATING_NOT_ALLOWED', details: { eligibility_reason: 'INELIGIBLE_HOST_NOT_HIGHER_TIER' } });
  });

  it('treats batch rating as atomic when any target is ineligible', async () => {
    const { roomId, participantIds } = await createStartedRoom([playerOneId, playerTwoId]);
    await db.query(
      `UPDATE user_sport_profiles
       SET skill_state = 'TOP_TIER_LOCKED', skill_score = 10, rank_tier = 10
       WHERE user_id = $1 AND sport_id = $2`,
      [playerTwoId, sportId],
    );
    await expect(skill.submitBatch(roomId, meta(hostId, key('batch'), 'SubmitSkillRatingsBatch', {}), {
      ratings: [
        { participantId: participantIds[0]!, ratingValue: 6 },
        { participantId: participantIds[1]!, ratingValue: 10 },
      ],
    })).rejects.toMatchObject({ code: 'RATING_NOT_ALLOWED', details: { eligibility_reason: 'INELIGIBLE_TOP_TIER_LOCKED' } });
    const stored = await db.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM skill_ratings WHERE room_id = $1', [roomId]);
    expect(Number(stored.rows[0]!.count)).toBe(0);
  });

  it('publishes initial rank after ten ratings with trimmed mean and keeps tier changes hysteretic', async () => {
    const values = [1, 5, 5, 5, 6, 6, 7, 7, 7, 10];
    for (let index = 0; index < values.length; index += 1) {
      const when = new Date(Date.parse('2026-12-01T07:00:00.000Z') + index * 3 * 60 * 60 * 1000);
      clock.set(when);
      const { roomId, participantIds } = await createStartedRoom([playerOneId], when);
      await skill.submitRating(participantIds[0]!, meta(hostId, key('calibrate'), 'SubmitSkillRating', { value: values[index] }), { ratingValue: values[index]! });
      await lifecycle.complete(roomId, meta(hostId, key('complete-calibration'), 'CompleteRoom', {}));
    }
    const profile = await rankingRepository.findProfile(db, playerOneId, sportId);
    expect(profile).toMatchObject({ skillState: 'RANKED', skillScore: 6, rankTier: 6, validRatingCount: 10, uniqueValidRaterCount: 1, confidenceLevel: 'LOW' });

    const config = await rankingRepository.getActiveRuleConfig(db, sportId);
    expect(config).not.toBeNull();
    const stable = evaluateTierTransition({ ...profile!, validRatingCount: 13, lastRankChangeRatingCount: 10 }, 7.05, config!);
    const promoted = evaluateTierTransition({ ...profile!, validRatingCount: 13, lastRankChangeRatingCount: 10 }, 7.1, config!);
    expect(stable).toMatchObject({ nextTier: 6, transition: null });
    expect(promoted).toMatchObject({ nextTier: 7, transition: 'PROMOTED' });
  });
});
