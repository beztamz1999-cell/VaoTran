import type { SqlExecutor, Transaction } from '../../platform/database/db.js';
import type {
  ConfidenceLevel,
  RankingRuleConfig,
  SkillProfile,
  SkillState,
  StoredRating,
} from './domain.js';

interface ProfileRow {
  user_id: string;
  sport_id: string;
  skill_state: SkillState;
  skill_score: string | null;
  rank_tier: number | null;
  valid_rating_count: number;
  completed_match_count: number;
  unique_valid_rater_count: number;
  confidence_level: ConfidenceLevel | null;
  last_valid_rating_at: Date | null;
  last_rank_change_at: Date | null;
  last_rank_change_rating_count: number;
}

interface RuleRow {
  id: string;
  sport_id: string;
  version: string;
  calibration_required_ratings: number;
  calibration_host_min_score: string;
  rolling_window_size: number;
  tier_boundaries_json: unknown;
  recency_weights_json: unknown;
  confidence_thresholds_json: unknown;
  promotion_buffer: string;
  demotion_buffer: string;
  outlier_cap: string;
  min_ratings_since_tier_change: number;
}

interface RatingRow {
  id: string;
  rating_value: string;
  effective_rating_value: string | null;
  rater_host_user_id: string;
  created_at: Date;
}

export interface PresentParticipant {
  participantId: string;
  userId: string;
}

export interface RatingParticipant {
  participantId: string;
  roomId: string;
  userId: string;
  status: 'ACTIVE' | 'CANCELLED' | 'REMOVED_BY_HOST';
  attendanceStatus: 'NOT_SET' | 'PRESENT' | 'NO_SHOW';
}

export interface NewSkillRating {
  id: string;
  roomId: string;
  sportId: string;
  ratedUserId: string;
  raterHostUserId: string;
  ratingValue: number;
  effectiveRatingValue: number;
  playerProfile: SkillProfile;
  hostProfile: SkillProfile;
  eligibilityReason: string;
  isOutlier: boolean;
  ruleVersion: string;
  createdAt: Date;
}

const numberOrNull = (value: string | null): number | null => value === null ? null : Number(value);

const profileFromRow = (row: ProfileRow): SkillProfile => ({
  userId: row.user_id,
  sportId: row.sport_id,
  skillState: row.skill_state,
  skillScore: numberOrNull(row.skill_score),
  rankTier: row.rank_tier,
  validRatingCount: row.valid_rating_count,
  completedMatchCount: row.completed_match_count,
  uniqueValidRaterCount: row.unique_valid_rater_count,
  confidenceLevel: row.confidence_level,
  lastValidRatingAt: row.last_valid_rating_at,
  lastRankChangeAt: row.last_rank_change_at,
  lastRankChangeRatingCount: row.last_rank_change_rating_count,
});

const parseRule = (row: RuleRow): RankingRuleConfig => {
  const weights = row.recency_weights_json as Record<string, number>;
  const confidence = row.confidence_thresholds_json as {
    medium: { min_valid_ratings: number; min_unique_raters: number };
    high: { min_valid_ratings: number; min_unique_raters: number };
  };
  const boundaries = row.tier_boundaries_json as Array<{ tier: number; min_score: number }>;
  return {
    id: row.id,
    sportId: row.sport_id,
    version: row.version,
    calibrationRequiredRatings: row.calibration_required_ratings,
    calibrationHostMinScore: Number(row.calibration_host_min_score),
    rollingWindowSize: row.rolling_window_size,
    tierBoundaries: boundaries.map((entry) => ({ tier: Number(entry.tier), minScore: Number(entry.min_score) })),
    recencyWeights: {
      newest1To5: Number(weights.newest_1_5),
      next6To10: Number(weights.next_6_10),
      oldest11To20: Number(weights.oldest_11_20),
    },
    confidenceThresholds: {
      medium: {
        minValidRatings: Number(confidence.medium.min_valid_ratings),
        minUniqueRaters: Number(confidence.medium.min_unique_raters),
      },
      high: {
        minValidRatings: Number(confidence.high.min_valid_ratings),
        minUniqueRaters: Number(confidence.high.min_unique_raters),
      },
    },
    promotionBuffer: Number(row.promotion_buffer),
    demotionBuffer: Number(row.demotion_buffer),
    outlierCap: Number(row.outlier_cap),
    minRatingsSinceTierChange: row.min_ratings_since_tier_change,
  };
};

export class RankingRepository {
  async getActiveRuleConfig(executor: SqlExecutor, sportId: string): Promise<RankingRuleConfig | null> {
    const result = await executor.query<RuleRow>(
      `SELECT id, sport_id, version, calibration_required_ratings, calibration_host_min_score,
              rolling_window_size, tier_boundaries_json, recency_weights_json, confidence_thresholds_json,
              promotion_buffer, demotion_buffer, outlier_cap, min_ratings_since_tier_change
       FROM ranking_rule_configs
       WHERE sport_id = $1 AND active_from <= NOW() AND active_to IS NULL
       ORDER BY active_from DESC
       LIMIT 1`,
      [sportId],
    );
    return result.rows[0] ? parseRule(result.rows[0]) : null;
  }

  async findProfile(executor: SqlExecutor, userId: string, sportId: string, lock = false): Promise<SkillProfile | null> {
    const result = await executor.query<ProfileRow>(
      `SELECT user_id, sport_id, skill_state, skill_score, rank_tier, valid_rating_count,
              completed_match_count, unique_valid_rater_count, confidence_level,
              last_valid_rating_at, last_rank_change_at, last_rank_change_rating_count
       FROM user_sport_profiles WHERE user_id = $1 AND sport_id = $2${lock ? ' FOR UPDATE' : ''}`,
      [userId, sportId],
    );
    return result.rows[0] ? profileFromRow(result.rows[0]) : null;
  }

  async listRatingsForProfile(executor: SqlExecutor, userId: string, sportId: string): Promise<StoredRating[]> {
    const result = await executor.query<RatingRow>(
      `SELECT id, rating_value, effective_rating_value, rater_host_user_id, created_at
       FROM skill_ratings
       WHERE rated_user_id = $1 AND sport_id = $2 AND eligibility_result = TRUE
       ORDER BY created_at DESC, id DESC`,
      [userId, sportId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      ratingValue: Number(row.rating_value),
      effectiveRatingValue: numberOrNull(row.effective_rating_value),
      raterHostUserId: row.rater_host_user_id,
      createdAt: row.created_at,
    }));
  }

  async hasRatingForRoomParticipant(executor: SqlExecutor, roomId: string, ratedUserId: string, sportId: string): Promise<boolean> {
    const result = await executor.query<{ id: string }>(
      `SELECT id FROM skill_ratings WHERE room_id = $1 AND rated_user_id = $2 AND sport_id = $3 LIMIT 1`,
      [roomId, ratedUserId, sportId],
    );
    return Boolean(result.rows[0]);
  }

  async insertSkillRating(tx: Transaction, rating: NewSkillRating): Promise<void> {
    await tx.query(
      `INSERT INTO skill_ratings (
        id, room_id, sport_id, rated_user_id, rater_host_user_id, rating_value, effective_rating_value,
        player_skill_state_snapshot, player_skill_score_snapshot, player_rank_tier_snapshot,
        host_skill_state_snapshot, host_skill_score_snapshot, host_rank_tier_snapshot,
        eligibility_result, eligibility_reason, is_outlier, rule_version, created_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,TRUE,$14,$15,$16,$17
      )`,
      [
        rating.id, rating.roomId, rating.sportId, rating.ratedUserId, rating.raterHostUserId,
        rating.ratingValue, rating.effectiveRatingValue,
        rating.playerProfile.skillState, rating.playerProfile.skillScore, rating.playerProfile.rankTier,
        rating.hostProfile.skillState, rating.hostProfile.skillScore, rating.hostProfile.rankTier,
        rating.eligibilityReason, rating.isOutlier, rating.ruleVersion, rating.createdAt,
      ],
    );
  }

  async saveProfile(tx: Transaction, profile: SkillProfile, now: Date): Promise<void> {
    await tx.query(
      `UPDATE user_sport_profiles
       SET skill_state = $3, skill_score = $4, rank_tier = $5, valid_rating_count = $6,
           unique_valid_rater_count = $7, confidence_level = $8, last_valid_rating_at = $9,
           last_rank_change_at = $10, last_rank_change_rating_count = $11,
           version = version + 1, updated_at = $12
       WHERE user_id = $1 AND sport_id = $2`,
      [
        profile.userId, profile.sportId, profile.skillState, profile.skillScore, profile.rankTier,
        profile.validRatingCount, profile.uniqueValidRaterCount, profile.confidenceLevel,
        profile.lastValidRatingAt, profile.lastRankChangeAt, profile.lastRankChangeRatingCount, now,
      ],
    );
  }

  async findParticipantForRating(executor: SqlExecutor, participantId: string, lock = false): Promise<RatingParticipant | null> {
    const result = await executor.query<{
      id: string; room_id: string; user_id: string;
      status: RatingParticipant['status']; attendance_status: RatingParticipant['attendanceStatus'];
    }>(
      `SELECT id, room_id, user_id, status, attendance_status
       FROM room_participants WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
      [participantId],
    );
    const row = result.rows[0];
    return row ? {
      participantId: row.id, roomId: row.room_id, userId: row.user_id,
      status: row.status, attendanceStatus: row.attendance_status,
    } : null;
  }

  async listPresentParticipants(tx: Transaction, roomId: string): Promise<PresentParticipant[]> {
    const result = await tx.query<{ participant_id: string; user_id: string }>(
      `SELECT id AS participant_id, user_id
       FROM room_participants
       WHERE room_id = $1 AND status = 'ACTIVE' AND attendance_status = 'PRESENT'
       ORDER BY accepted_at, id`,
      [roomId],
    );
    return result.rows.map((row) => ({ participantId: row.participant_id, userId: row.user_id }));
  }

  async incrementCompletedMatchCount(tx: Transaction, roomId: string, sportId: string, now: Date): Promise<void> {
    await tx.query(
      `UPDATE user_sport_profiles profile
       SET completed_match_count = profile.completed_match_count + 1, version = profile.version + 1, updated_at = $3
       FROM room_participants participant
       WHERE participant.room_id = $1
         AND participant.status = 'ACTIVE'
         AND participant.attendance_status = 'PRESENT'
         AND profile.user_id = participant.user_id
         AND profile.sport_id = $2`,
      [roomId, sportId, now],
    );
  }
}
