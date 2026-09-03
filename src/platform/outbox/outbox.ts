import { logger, newId, systemClock, type Clock } from '../core.js';
import type { Transaction } from '../database/db.js';
import { metrics } from '../observability/metrics.js';

export type OutboxPublishStatus = 'PENDING' | 'PROCESSING' | 'PUBLISHED' | 'FAILED_RETRYABLE' | 'DEAD_LETTER';

export interface DomainEvent {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  actorUserId: string | null;
  correlationId: string | null;
  causationId: string | null;
  /** Legacy envelope version retained for existing producers and historical rows. */
  schemaVersion: number;
  /** Semantic version of the event type. Absent legacy events are interpreted as v1. */
  eventVersion?: number;
  /** Version of the payload shape. Absent legacy events are interpreted as v1. */
  payloadSchemaVersion?: number;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

export type NewDomainEvent = Omit<DomainEvent, 'id' | 'occurredAt'> & Partial<Pick<DomainEvent, 'id' | 'occurredAt'>>;

export const makeDomainEvent = (event: NewDomainEvent, clock: Clock = systemClock): DomainEvent => ({
  id: event.id ?? newId(),
  eventType: event.eventType,
  aggregateType: event.aggregateType,
  aggregateId: event.aggregateId,
  actorUserId: event.actorUserId,
  correlationId: event.correlationId,
  causationId: event.causationId,
  schemaVersion: event.schemaVersion,
  eventVersion: event.eventVersion ?? 1,
  payloadSchemaVersion: event.payloadSchemaVersion ?? 1,
  payload: event.payload,
  occurredAt: event.occurredAt ?? clock.now(),
});

export const appendOutboxEvent = async (tx: Transaction, event: DomainEvent): Promise<void> => {
  await tx.query(
    `INSERT INTO event_outbox (
      id, event_type, aggregate_type, aggregate_id, actor_user_id, correlation_id, causation_id,
      schema_version, event_version, payload_schema_version, payload_json, occurred_at, publish_status, attempt_count
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, 'PENDING', 0)`,
    [
      event.id,
      event.eventType,
      event.aggregateType,
      event.aggregateId,
      event.actorUserId,
      event.correlationId,
      event.causationId,
      event.schemaVersion,
      event.eventVersion ?? 1,
      event.payloadSchemaVersion ?? 1,
      JSON.stringify(event.payload),
      event.occurredAt,
    ],
  );
};

export interface OutboxConsumer {
  name: string;
  handle(event: DomainEvent): Promise<void>;
}

const retryDelayMs = (attempt: number): number => {
  const schedule = [0, 10_000, 60_000, 300_000, 1_800_000];
  return schedule[Math.min(attempt, schedule.length - 1)] ?? 1_800_000;
};

type OutboxRow = {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  actor_user_id: string | null;
  correlation_id: string | null;
  causation_id: string | null;
  schema_version: number;
  event_version: number;
  payload_schema_version: number;
  payload_json: Record<string, unknown>;
  occurred_at: Date;
  attempt_count: number;
};

const toEvent = (row: OutboxRow): DomainEvent => ({
  id: row.id,
  eventType: row.event_type,
  aggregateType: row.aggregate_type,
  aggregateId: row.aggregate_id,
  actorUserId: row.actor_user_id,
  correlationId: row.correlation_id,
  causationId: row.causation_id,
  schemaVersion: row.schema_version,
  eventVersion: row.event_version ?? 1,
  payloadSchemaVersion: row.payload_schema_version ?? 1,
  payload: row.payload_json,
  occurredAt: row.occurred_at,
});

export class PostgresOutboxWorker {
  constructor(private readonly db: { transaction<T>(operation: (tx: Transaction) => Promise<T>): Promise<T> }, private readonly clock: Clock = systemClock) {}

  async runOnce(consumer: OutboxConsumer, batchSize = 25): Promise<number> {
    const startedAt = performance.now();
    const rows = await this.db.transaction(async (tx) => {
      const result = await tx.query<OutboxRow>(
        `WITH claimed AS (
          SELECT id
          FROM event_outbox
          WHERE publish_status IN ('PENDING', 'FAILED_RETRYABLE')
            AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
          ORDER BY occurred_at
          FOR UPDATE SKIP LOCKED
          LIMIT $2
        )
        UPDATE event_outbox e
        SET publish_status = 'PROCESSING', attempt_count = e.attempt_count + 1
        FROM claimed
        WHERE e.id = claimed.id
        RETURNING e.*`,
        [this.clock.now(), batchSize],
      );
      return result.rows;
    });
    metrics.increment('vaotran_outbox_events_claimed_total', { consumer: consumer.name }, rows.length);

    for (const row of rows) {
      const event = toEvent(row);
      try {
        await this.db.transaction(async (tx) => {
          const alreadyConsumed = await tx.query<{ event_id: string }>(
            `SELECT event_id FROM event_consumptions
             WHERE consumer_name = $1 AND event_id = $2`,
            [consumer.name, event.id],
          );
          if (!alreadyConsumed.rowCount) {
            await consumer.handle(event);
            await tx.query(
              `INSERT INTO event_consumptions (consumer_name, event_id, processed_at)
               VALUES ($1, $2, $3)
               ON CONFLICT (consumer_name, event_id) DO NOTHING`,
              [consumer.name, event.id, this.clock.now()],
            );
          }
          await tx.query(
            `UPDATE event_outbox
             SET publish_status = 'PUBLISHED', published_at = $2, next_attempt_at = NULL, last_error = NULL
             WHERE id = $1`,
            [event.id, this.clock.now()],
          );
        });
        metrics.increment('vaotran_outbox_events_published_total', { consumer: consumer.name, event_type: event.eventType });
      } catch (error) {
        const attempt = row.attempt_count;
        const deadLetter = attempt >= 5;
        await this.db.transaction(async (tx) => {
          await tx.query(
            `UPDATE event_outbox
             SET publish_status = $2,
                 next_attempt_at = $3,
                 last_error = $4
             WHERE id = $1`,
            [
              event.id,
              deadLetter ? 'DEAD_LETTER' : 'FAILED_RETRYABLE',
              deadLetter ? null : new Date(this.clock.now().getTime() + retryDelayMs(attempt)),
              error instanceof Error ? error.message.slice(0, 2048) : 'Unknown outbox consumer error',
            ],
          );
        });
        metrics.increment('vaotran_outbox_failures_total', { consumer: consumer.name, event_type: event.eventType, status: deadLetter ? 'dead_letter' : 'retryable' });
        logger.warn({ component: 'outbox', consumer: consumer.name, event_id: event.id, event_type: event.eventType, correlation_id: event.correlationId, attempt, dead_letter: deadLetter, err: error }, 'Outbox consumer handling failed');
      }
    }
    metrics.observe('vaotran_outbox_worker_duration_ms', performance.now() - startedAt, { consumer: consumer.name, claimed: rows.length });
    return rows.length;
  }
}
