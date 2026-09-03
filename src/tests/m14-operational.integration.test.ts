import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OperationsService } from '../modules/operations/operations-service.js';
import type { Clock } from '../platform/core.js';
import { PostgresDatabase } from '../platform/database/db.js';
import { appendOutboxEvent, makeDomainEvent, PostgresOutboxWorker } from '../platform/outbox/outbox.js';
import { validateProductionConfig } from '../platform/operations/production-config.js';

const integration = process.env.DATABASE_URL ? describe : describe.skip;
const aggregateId = 'd14d0000-0000-4000-8000-000000000001';
const operatorId = 'd14d0000-0000-4000-8000-000000000002';

class FixedClock implements Clock {
  now(): Date { return new Date('2026-12-16T10:00:00.000Z'); }
}

integration('M14-D Operational Hardening (PostgreSQL)', () => {
  let db: PostgresDatabase;
  const clock = new FixedClock();

  const createEvent = async (eventType: string): Promise<string> => {
    const event = makeDomainEvent({
      eventType, aggregateType: 'ROOM', aggregateId, actorUserId: null,
      correlationId: 'd14d0000-0000-4000-8000-000000000003', causationId: null, schemaVersion: 1, payload: {},
    }, clock);
    await db.transaction(async (tx) => appendOutboxEvent(tx, event));
    return event.id;
  };

  beforeAll(async () => { db = new PostgresDatabase(); await db.query('SELECT 1'); });
  beforeEach(async () => { await db.query('TRUNCATE internal_operation_audits, event_consumptions, event_outbox RESTART IDENTITY CASCADE'); });
  afterAll(async () => { await db.close(); });

  it('requires a terminal retryable state, preserves the event, and audits the approved operator', async () => {
    const eventId = await createEvent('M14_REPLAY_GUARD');
    const operations = new OperationsService(db, clock);
    expect(await operations.retryOutboxEvent(eventId, 'd14d0000-0000-4000-8000-000000000003', operatorId)).toBeNull();
    await db.query("UPDATE event_outbox SET publish_status = 'DEAD_LETTER', last_error = 'fault injected' WHERE id = $1", [eventId]);
    expect((await operations.retryOutboxEvent(eventId, 'd14d0000-0000-4000-8000-000000000004', operatorId))?.publishStatus).toBe('PENDING');
    const persisted = await operations.inspectOutboxEvent(eventId);
    expect(persisted).toMatchObject({ id: eventId, eventType: 'M14_REPLAY_GUARD', publishStatus: 'PENDING' });
    const audit = await db.query<{ outcome: string; metadata_json: { operator_id?: string; source?: string }; correlation_id: string }>(
      "SELECT outcome::text, metadata_json, correlation_id FROM internal_operation_audits WHERE action = 'RETRY_OUTBOX_EVENT' AND correlation_id = $1",
      ['d14d0000-0000-4000-8000-000000000004'],
    );
    expect(audit.rows[0]).toMatchObject({ outcome: 'QUEUED', correlation_id: 'd14d0000-0000-4000-8000-000000000004', metadata_json: { operator_id: operatorId, source: 'OPERATIONS_SERVICE' } });
  });

  it('recovers a dead-letter event without duplicating its consumer side effect', async () => {
    const eventId = await createEvent('M14_CONSUMER_RECOVERY');
    await db.query("UPDATE event_outbox SET publish_status = 'DEAD_LETTER', last_error = 'fault injected' WHERE id = $1", [eventId]);
    await db.query("INSERT INTO event_consumptions (consumer_name, event_id, processed_at) VALUES ('m14-idempotent-consumer', $1, NOW())", [eventId]);
    const operations = new OperationsService(db, clock);
    await operations.retryOutboxEvent(eventId, 'd14d0000-0000-4000-8000-000000000005', operatorId);
    let sideEffects = 0;
    const worker = new PostgresOutboxWorker(db, clock);
    await worker.runOnce({ name: 'm14-idempotent-consumer', handle: async () => { sideEffects += 1; } });
    expect(sideEffects).toBe(0);
    expect((await operations.inspectOutboxEvent(eventId))?.publishStatus).toBe('PUBLISHED');
  });

  it('rejects production configuration that relies on development safety fallbacks', () => {
    expect(validateProductionConfig({ NODE_ENV: 'development' })).toMatchObject({ valid: true, environment: 'development' });
    const result = validateProductionConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://example', ANALYTICS_HASH_SALT: 'vaotran-development-analytics-salt', ALLOW_DEV_ACTOR_HEADER: 'true' });
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      'INTERNAL_OPS_TOKEN is required in production.',
      'INTERNAL_OPS_ALLOWLIST is required in production.',
      'ANALYTICS_HASH_SALT must be a non-development secret in production.',
      'ALLOW_DEV_ACTOR_HEADER must not be true in production.',
    ]));
  });
});
