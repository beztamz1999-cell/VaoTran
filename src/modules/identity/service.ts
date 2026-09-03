import type { QueryResultRow } from 'pg';
import { DomainError, newId, systemClock, type Clock } from '../../platform/core.js';
import type { PostgresDatabase } from '../../platform/database/db.js';
import { appendOutboxEvent, makeDomainEvent } from '../../platform/outbox/outbox.js';

export interface UserProfile {
  id: string;
  phone: string;
  displayName: string;
  avatarUrl: string | null;
  birthYear: number | null;
  gender: 'MALE' | 'FEMALE' | 'OTHER' | 'UNSPECIFIED' | null;
  homeArea: string | null;
  createdAt: Date;
}

export interface UserSportProfile {
  userId: string;
  sportCode: string;
  skillState: 'UNRANKED' | 'CALIBRATING' | 'RANKED' | 'TOP_TIER_LOCKED';
  skillScore: number | null;
  rankTier: number | null;
  validRatingCount: number;
  completedMatchCount: number;
  confidenceLevel: 'LOW' | 'MEDIUM' | 'HIGH' | null;
}

interface UserRow extends QueryResultRow {
  id: string;
  phone: string;
  display_name: string;
  avatar_url: string | null;
  birth_year: number | null;
  gender: UserProfile['gender'];
  home_area: string | null;
  created_at: Date;
}

const mapUser = (row: UserRow): UserProfile => ({
  id: row.id, phone: row.phone, displayName: row.display_name, avatarUrl: row.avatar_url,
  birthYear: row.birth_year, gender: row.gender, homeArea: row.home_area, createdAt: row.created_at,
});

export class IdentityService {
  constructor(private readonly db: PostgresDatabase, private readonly clock: Clock = systemClock) {}

  async getMe(userId: string): Promise<UserProfile> {
    const result = await this.db.query<UserRow>(
      `SELECT id, phone, display_name, avatar_url, birth_year, gender, home_area, created_at
       FROM users WHERE id = $1 AND status = 'ACTIVE'`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) throw new DomainError('UNAUTHENTICATED', 'Authenticated user was not found or is inactive.');
    return mapUser(row);
  }

  async getBasicUser(userId: string): Promise<Pick<UserProfile, 'id' | 'displayName' | 'avatarUrl'>> {
    const result = await this.db.query<Pick<UserRow, 'id' | 'display_name' | 'avatar_url'>>(
      `SELECT id, display_name, avatar_url FROM users WHERE id = $1 AND status = 'ACTIVE'`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) throw new DomainError('ROOM_NOT_FOUND', 'Room host was not found.');
    return { id: row.id, displayName: row.display_name, avatarUrl: row.avatar_url };
  }

  async updateMe(userId: string, patch: Partial<Pick<UserProfile, 'displayName' | 'phone' | 'avatarUrl' | 'birthYear' | 'gender' | 'homeArea'>>): Promise<UserProfile> {
    if (patch.displayName !== undefined && !patch.displayName.trim()) throw new DomainError('VALIDATION_ERROR', 'Display name is required.');
    if (patch.birthYear !== undefined && patch.birthYear !== null && (!Number.isInteger(patch.birthYear) || patch.birthYear < 1900 || patch.birthYear > 2100)) {
      throw new DomainError('VALIDATION_ERROR', 'Birth year is invalid.');
    }
    if (patch.phone !== undefined) {
      const existing = await this.db.query<{ id: string }>('SELECT id FROM users WHERE phone = $1 AND id <> $2', [patch.phone.trim(), userId]);
      if (existing.rows[0]) throw new DomainError('PHONE_ALREADY_REGISTERED', 'Phone number is already registered.');
    }
    const result = await this.db.query<UserRow>(
      `UPDATE users SET
        display_name = COALESCE($2, display_name),
        phone = CASE WHEN $3 THEN $4 ELSE phone END,
        avatar_url = CASE WHEN $5 THEN $6 ELSE avatar_url END,
        birth_year = CASE WHEN $7 THEN $8 ELSE birth_year END,
        gender = CASE WHEN $9 THEN $10::gender ELSE gender END,
        home_area = CASE WHEN $11 THEN $12 ELSE home_area END,
        updated_at = $13
       WHERE id = $1 AND status = 'ACTIVE'
       RETURNING id, phone, display_name, avatar_url, birth_year, gender, home_area, created_at`,
      [
        userId,
        patch.displayName?.trim() ?? null,
        patch.phone !== undefined,
        patch.phone?.trim() ?? null,
        patch.avatarUrl !== undefined,
        patch.avatarUrl ?? null,
        patch.birthYear !== undefined,
        patch.birthYear ?? null,
        patch.gender !== undefined,
        patch.gender ?? null,
        patch.homeArea !== undefined,
        patch.homeArea ?? null,
        this.clock.now(),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new DomainError('UNAUTHENTICATED', 'Authenticated user was not found or is inactive.');
    return mapUser(row);
  }

  async listSportProfiles(userId: string): Promise<UserSportProfile[]> {
    const result = await this.db.query<QueryResultRow & { user_id: string; sport_code: string; skill_state: UserSportProfile['skillState']; skill_score: string | null; rank_tier: number | null; valid_rating_count: number; completed_match_count: number; confidence_level: UserSportProfile['confidenceLevel'] }>(
      `SELECT usp.user_id, s.code AS sport_code, usp.skill_state, usp.skill_score, usp.rank_tier,
              usp.valid_rating_count, usp.completed_match_count, usp.confidence_level
       FROM user_sport_profiles usp JOIN sports s ON s.id = usp.sport_id
       WHERE usp.user_id = $1 ORDER BY s.code`, [userId],
    );
    return result.rows.map((row) => ({ userId: row.user_id, sportCode: row.sport_code, skillState: row.skill_state, skillScore: row.skill_score === null ? null : Number(row.skill_score), rankTier: row.rank_tier, validRatingCount: row.valid_rating_count, completedMatchCount: row.completed_match_count, confidenceLevel: row.confidence_level }));
  }

  async getSportProfile(userId: string, sportCode: string): Promise<UserSportProfile> {
    const result = await this.db.query<QueryResultRow & {
      user_id: string; sport_code: string; skill_state: UserSportProfile['skillState']; skill_score: string | null;
      rank_tier: number | null; valid_rating_count: number; completed_match_count: number; confidence_level: UserSportProfile['confidenceLevel'];
    }>(
      `SELECT usp.user_id, s.code AS sport_code, usp.skill_state, usp.skill_score, usp.rank_tier,
              usp.valid_rating_count, usp.completed_match_count, usp.confidence_level
       FROM user_sport_profiles usp
       JOIN sports s ON s.id = usp.sport_id
       WHERE usp.user_id = $1 AND s.code = $2`,
      [userId, sportCode],
    );
    const row = result.rows[0];
    if (!row) throw new DomainError('SPORT_NOT_FOUND', 'User sport profile was not found.');
    return {
      userId: row.user_id, sportCode: row.sport_code, skillState: row.skill_state,
      skillScore: row.skill_score === null ? null : Number(row.skill_score), rankTier: row.rank_tier,
      validRatingCount: row.valid_rating_count, completedMatchCount: row.completed_match_count,
      confidenceLevel: row.confidence_level,
    };
  }

  async createDevelopmentUser(input: { phone: string; displayName: string }): Promise<UserProfile> {
    return this.db.transaction(async (tx) => {
      const existing = await tx.query<UserRow>(
        `SELECT id, phone, display_name, avatar_url, birth_year, gender, home_area, created_at
         FROM users WHERE phone = $1`, [input.phone],
      );
      if (existing.rows[0]) return mapUser(existing.rows[0]);
      const now = this.clock.now();
      const id = newId();
      const created = await tx.query<UserRow>(
        `INSERT INTO users (id, phone, display_name, status, created_at, updated_at)
         VALUES ($1,$2,$3,'ACTIVE',$4,$4)
         RETURNING id, phone, display_name, avatar_url, birth_year, gender, home_area, created_at`,
        [id, input.phone, input.displayName, now],
      );
      const sports = await tx.query<{ id: string }>("SELECT id FROM sports WHERE status = 'ACTIVE'");
      for (const sport of sports.rows) {
        await tx.query(
          `INSERT INTO user_sport_profiles (
            user_id, sport_id, skill_state, valid_rating_count, completed_match_count,
            unique_valid_rater_count, version, created_at, updated_at
          ) VALUES ($1,$2,'UNRANKED',0,0,0,1,$3,$3)`,
          [id, sport.id, now],
        );
      }
      await appendOutboxEvent(tx, makeDomainEvent({
        eventType: 'USER_REGISTERED', aggregateType: 'USER', aggregateId: id, actorUserId: id,
        correlationId: null, causationId: null, schemaVersion: 1, payload: { user_id: id },
      }, this.clock));
      return mapUser(created.rows[0]!);
    });
  }
}
