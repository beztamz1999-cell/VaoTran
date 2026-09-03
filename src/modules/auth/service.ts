import { createHash, randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import type { QueryResultRow } from 'pg';
import { DomainError, newId, systemClock, type Clock } from '../../platform/core.js';
import type { PostgresDatabase, Transaction } from '../../platform/database/db.js';
import { appendOutboxEvent, makeDomainEvent } from '../../platform/outbox/outbox.js';
import type { UserProfile } from '../identity/service.js';

const sessionTokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

const mapUser = (row: QueryResultRow & { id: string; phone: string; display_name: string; avatar_url: string | null; birth_year: number | null; gender: UserProfile['gender']; home_area: string | null; created_at: Date }): UserProfile => ({
  id: row.id, phone: row.phone, displayName: row.display_name, avatarUrl: row.avatar_url,
  birthYear: row.birth_year, gender: row.gender, homeArea: row.home_area, createdAt: row.created_at,
});

export interface SessionResult {
  user: UserProfile;
  token: string;
  expiresAt: Date;
}

interface UserWithCredentialRow extends QueryResultRow {
  id: string;
  phone: string;
  display_name: string;
  avatar_url: string | null;
  birth_year: number | null;
  gender: UserProfile['gender'];
  home_area: string | null;
  created_at: Date;
  password_hash: string;
}

export class AuthService {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly sessionTtlDays: number,
    private readonly clock: Clock = systemClock,
  ) {}

  async register(input: { email: string; password: string; displayName: string; phone: string }): Promise<SessionResult> {
    const email = normalizeEmail(input.email);
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    return this.db.transaction(async (tx) => {
      const now = this.clock.now();
      const userId = newId();
      const existingCredential = await tx.query<{ present: boolean }>(
        'SELECT EXISTS(SELECT 1 FROM auth_credentials WHERE email_normalized = $1) AS present', [email],
      );
      if (existingCredential.rows[0]?.present) {
        throw new DomainError('EMAIL_ALREADY_REGISTERED', 'An account already exists for this email.');
      }
      const created = await tx.query<UserWithCredentialRow>(
        `INSERT INTO users (id, phone, display_name, status, created_at, updated_at)
         VALUES ($1,$2,$3,'ACTIVE',$4,$4)
         ON CONFLICT (phone) DO NOTHING
         RETURNING id, phone, display_name, avatar_url, birth_year, gender, home_area, created_at, ''::text AS password_hash`,
        [userId, normalizePhone(input.phone), input.displayName.trim(), now],
      );
      if (!created.rows[0]) throw new DomainError('VALIDATION_ERROR', 'Phone is already associated with an account.');
      const credential = await tx.query<{ user_id: string }>(
        `INSERT INTO auth_credentials (user_id, email_normalized, password_hash, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$4)
         ON CONFLICT (email_normalized) DO NOTHING
         RETURNING user_id`,
        [userId, email, passwordHash, now],
      );
      if (!credential.rows[0]) throw new DomainError('EMAIL_ALREADY_REGISTERED', 'An account already exists for this email.');
      const sports = await tx.query<{ id: string }>("SELECT id FROM sports WHERE status = 'ACTIVE'");
      for (const sport of sports.rows) {
        await tx.query(
          `INSERT INTO user_sport_profiles (
            user_id, sport_id, skill_state, valid_rating_count, completed_match_count,
            unique_valid_rater_count, version, created_at, updated_at
          ) VALUES ($1,$2,'UNRANKED',0,0,0,1,$3,$3)`,
          [userId, sport.id, now],
        );
      }
      await appendOutboxEvent(tx, makeDomainEvent({
        eventType: 'USER_REGISTERED', aggregateType: 'USER', aggregateId: userId, actorUserId: userId,
        correlationId: null, causationId: null, schemaVersion: 1, payload: { user_id: userId },
      }, this.clock));
      return this.createSession(tx, mapUser(created.rows[0]), now);
    });
  }

  async login(input: { email: string; password: string }): Promise<SessionResult> {
    const email = normalizeEmail(input.email);
    const user = await this.db.query<UserWithCredentialRow>(
      `SELECT u.id, u.phone, u.display_name, u.avatar_url, u.birth_year, u.gender, u.home_area, u.created_at, c.password_hash
       FROM auth_credentials c JOIN users u ON u.id = c.user_id
       WHERE c.email_normalized = $1 AND u.status = 'ACTIVE'`,
      [email],
    );
    const row = user.rows[0];
    if (!row || !(await argon2.verify(row.password_hash, input.password))) {
      throw new DomainError('INVALID_CREDENTIALS', 'Invalid email or password.');
    }
    return this.db.transaction((tx) => this.createSession(tx, mapUser(row), this.clock.now()));
  }

  async logout(sessionId: string): Promise<void> {
    await this.db.query('UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE id = $1', [sessionId, this.clock.now()]);
  }

  async getEmailForUser(userId: string): Promise<string | null> {
    const result = await this.db.query<{ email_normalized: string }>(
      'SELECT email_normalized FROM auth_credentials WHERE user_id = $1', [userId],
    );
    return result.rows[0]?.email_normalized ?? null;
  }

  private async createSession(tx: Transaction, user: UserProfile, now: Date): Promise<SessionResult> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + this.sessionTtlDays * 24 * 60 * 60 * 1000);
    await tx.query(
      `INSERT INTO auth_sessions (id, user_id, token_hash, created_at, expires_at, last_used_at, revoked_at)
       VALUES ($1,$2,$3,$4,$5,$4,NULL)`,
      [newId(), user.id, sessionTokenHash(token), now, expiresAt],
    );
    return { user, token, expiresAt };
  }
}

export const normalizeEmail = (value: string): string => value.trim().toLowerCase();

const normalizePhone = (value: string): string => value.trim();
