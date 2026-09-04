import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import pino from 'pino';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
export const newId = (): string => randomUUID();

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL,
  roomImageStorageDir: process.env.ROOM_IMAGE_STORAGE_DIR?.trim() || '.room-image-storage',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  idempotencyTtlHours: Number(process.env.IDEMPOTENCY_TTL_HOURS ?? 24),
  autoStartIntervalMs: Number(process.env.AUTO_START_INTERVAL_MS ?? 60_000),
  emergencyReplacementWindowMinutes: Number(process.env.EMERGENCY_REPLACEMENT_WINDOW_MINUTES ?? 30),
  slowQueryMs: Number(process.env.SLOW_QUERY_MS ?? 250),
  workerMetricsIntervalMs: Number(process.env.WORKER_METRICS_INTERVAL_MS ?? 30_000),
  reconciliationIntervalMs: Number(process.env.RECONCILIATION_INTERVAL_MS ?? 300_000),
  analyticsValidationIntervalMs: Number(process.env.ANALYTICS_VALIDATION_INTERVAL_MS ?? 900_000),
  internalOpsToken: process.env.INTERNAL_OPS_TOKEN?.trim() || undefined,
  internalOpsAllowlist: new Set(
    (process.env.INTERNAL_OPS_ALLOWLIST ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  ),
  corsAllowedOrigins: new Set(
    (process.env.CORS_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  ),
  // DEV/TEST ONLY. A client-provided user ID is never a private-alpha credential.
  allowDevActorHeader: process.env.ALLOW_DEV_ACTOR_HEADER === 'true' || process.env.NODE_ENV === 'test',
  authSessionTtlDays: Number(process.env.AUTH_SESSION_TTL_DAYS ?? 30),
  // Production must set ANALYTICS_HASH_SALT to a stable secret. The fallback only keeps local/test projections deterministic.
  analyticsHashSalt: process.env.ANALYTICS_HASH_SALT?.trim() || 'vaotran-development-analytics-salt',
};

export const logger = pino({ level: config.logLevel, base: null });

export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'EMAIL_ALREADY_REGISTERED'
  | 'PHONE_ALREADY_REGISTERED'
  | 'FORBIDDEN'
  | 'NOT_ROOM_HOST'
  | 'NOT_PARTICIPANT'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_NOT_EDITABLE'
  | 'ROOM_NOT_JOINABLE'
  | 'ROOM_TERMINAL'
  | 'INVALID_CAPACITY'
  | 'INVALID_RESERVED_COUNT'
  | 'INVALID_TIME_WINDOW'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'SPORT_NOT_FOUND'
  | 'APPLICATION_NOT_FOUND'
  | 'APPLICATION_NOT_ACTIONABLE'
  | 'APPLICATION_ALREADY_EXISTS'
  | 'APPLICATION_ALREADY_RESOLVED'
  | 'INSUFFICIENT_CAPACITY'
  | 'SCHEDULE_CONFLICT'
  | 'START_TOO_EARLY'
  | 'ROOM_NOT_IN_PROGRESS'
  | 'ROOM_NOT_REPEATABLE'
  | 'NOTIFICATION_NOT_FOUND'
  | 'ATTENDANCE_NOT_ALLOWED'
  | 'NO_SHOW_TOO_EARLY'
  | 'ATTENDANCE_INCOMPLETE'
  | 'REFILL_NOT_ALLOWED'
  | 'REFILL_WINDOW_CLOSED'
  | 'RATING_NOT_ALLOWED'
  | 'RATING_DUPLICATE'
  | 'RATING_INVALID_VALUE'
  | 'RATINGS_INCOMPLETE'
  | 'ROOM_COMPLETION_INCOMPLETE'
  | 'RANKING_RULE_NOT_FOUND'
  | 'FRIENDSHIP_NOT_FOUND'
  | 'FRIENDSHIP_NOT_ACTIONABLE'
  | 'FRIENDSHIP_REQUIRED'
  | 'PARTY_NOT_FOUND'
  | 'PARTY_NOT_OWNER'
  | 'PARTY_NOT_READY'
  | 'PARTY_SPORT_MISMATCH'
  | 'PARTY_MEMBER_NOT_FOUND'
  | 'PARTY_MEMBER_NOT_ACTIONABLE'
  | 'PARTY_APPLICATION_ACTIVE'
  | 'GUEST_CLAIM_INVALID'
  | 'VALIDATION_ERROR';

const httpStatusByCode: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  EMAIL_ALREADY_REGISTERED: 409,
  PHONE_ALREADY_REGISTERED: 409,
  FORBIDDEN: 403,
  NOT_ROOM_HOST: 403,
  NOT_PARTICIPANT: 403,
  ROOM_NOT_FOUND: 404,
  SPORT_NOT_FOUND: 404,
  APPLICATION_NOT_FOUND: 404,
  ROOM_NOT_EDITABLE: 409,
  ROOM_NOT_JOINABLE: 409,
  ROOM_TERMINAL: 409,
  INVALID_CAPACITY: 409,
  INVALID_RESERVED_COUNT: 409,
  INVALID_TIME_WINDOW: 400,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  APPLICATION_NOT_ACTIONABLE: 409,
  APPLICATION_ALREADY_EXISTS: 409,
  APPLICATION_ALREADY_RESOLVED: 409,
  INSUFFICIENT_CAPACITY: 409,
  SCHEDULE_CONFLICT: 409,
  START_TOO_EARLY: 409,
  ROOM_NOT_IN_PROGRESS: 409,
  ROOM_NOT_REPEATABLE: 409,
  NOTIFICATION_NOT_FOUND: 404,
  ATTENDANCE_NOT_ALLOWED: 409,
  NO_SHOW_TOO_EARLY: 409,
  ATTENDANCE_INCOMPLETE: 409,
  REFILL_NOT_ALLOWED: 409,
  REFILL_WINDOW_CLOSED: 409,
  RATING_NOT_ALLOWED: 409,
  RATING_DUPLICATE: 409,
  RATING_INVALID_VALUE: 400,
  RATINGS_INCOMPLETE: 409,
  ROOM_COMPLETION_INCOMPLETE: 409,
  RANKING_RULE_NOT_FOUND: 409,
  FRIENDSHIP_NOT_FOUND: 404,
  FRIENDSHIP_NOT_ACTIONABLE: 409,
  FRIENDSHIP_REQUIRED: 403,
  PARTY_NOT_FOUND: 404,
  PARTY_NOT_OWNER: 403,
  PARTY_NOT_READY: 409,
  PARTY_SPORT_MISMATCH: 409,
  PARTY_MEMBER_NOT_FOUND: 404,
  PARTY_MEMBER_NOT_ACTIONABLE: 409,
  PARTY_APPLICATION_ACTIVE: 409,
  GUEST_CLAIM_INVALID: 409,
  VALIDATION_ERROR: 400,
};

export class DomainError extends Error {
  readonly status: number;

  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DomainError';
    this.status = httpStatusByCode[code];
  }
}

export const domainError = (
  code: ErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): never => {
  throw new DomainError(code, message, details);
};
