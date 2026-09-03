import { createHash } from 'node:crypto';
import { DomainError, config, systemClock, type Clock } from './core.js';
import type { PostgresDatabase, Transaction } from './database/db.js';
import { metrics } from './observability/metrics.js';

export interface IdempotencyContext {
  key: string;
  actorUserId: string;
  commandType: string;
  request: unknown;
}

interface StoredIdempotencyRow {
  key: string;
  actor_user_id: string | null;
  command_type: string;
  request_hash: string;
  response_status: number | null;
  response_json: unknown | null;
}

export interface IdempotencyResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

export const requestHash = (value: unknown): string => (
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
);

export class PostgresIdempotencyGate {
  constructor(private readonly db: PostgresDatabase, private readonly clock: Clock = systemClock) {}

  async execute<T>(
    context: IdempotencyContext,
    successStatus: number,
    operation: (tx: Transaction) => Promise<T>,
  ): Promise<IdempotencyResult<T>> {
    const fingerprint = requestHash(context.request);
    return this.db.transaction(async (tx) => {
      const found = await tx.query<StoredIdempotencyRow>(
        `SELECT key, actor_user_id, command_type, request_hash, response_status, response_json
         FROM idempotency_keys WHERE key = $1 FOR UPDATE`,
        [context.key],
      );
      const stored = found.rows[0];
      if (stored) {
        if (stored.actor_user_id !== context.actorUserId || stored.command_type !== context.commandType || stored.request_hash !== fingerprint) {
          metrics.increment('vaotran_idempotency_conflicts_total', { command: context.commandType });
          throw new DomainError('IDEMPOTENCY_CONFLICT', 'Idempotency key has already been used for a different command or request.');
        }
        if (stored.response_status !== null && stored.response_json !== null) {
          metrics.increment('vaotran_idempotency_replays_total', { command: context.commandType });
          return { status: stored.response_status, body: stored.response_json as T, replayed: true };
        }
      } else {
        const expiresAt = new Date(this.clock.now().getTime() + config.idempotencyTtlHours * 60 * 60 * 1000);
        await tx.query(
          `INSERT INTO idempotency_keys (
            key, actor_user_id, command_type, request_hash, response_status, response_json, created_at, expires_at
          ) VALUES ($1,$2,$3,$4,NULL,NULL,$5,$6)`,
          [context.key, context.actorUserId, context.commandType, fingerprint, this.clock.now(), expiresAt],
        );
      }
      const body = await operation(tx);
      await tx.query(
        `UPDATE idempotency_keys SET response_status = $2, response_json = $3::jsonb WHERE key = $1`,
        [context.key, successStatus, JSON.stringify(body)],
      );
      return { status: successStatus, body, replayed: false };
    });
  }
}
