import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { config, newId, type Clock } from '../platform/core.js';
import { PostgresDatabase } from '../platform/database/db.js';
import { appendOutboxEvent, makeDomainEvent } from '../platform/outbox/outbox.js';
import { AnalyticsService } from '../modules/analytics/analytics-service.js';
import { createApp } from '../platform/http/app.js';
import { IdentityService } from '../modules/identity/service.js';
import { RoomRepository } from '../modules/room/repository.js';
import { RoomService } from '../modules/room/service.js';
import { ParticipationRepository } from '../modules/participation/repository.js';
import { ParticipationService } from '../modules/participation/service.js';
import { RoomLifecycleService } from '../modules/room/lifecycle-service.js';
import { SearchRepository } from '../modules/search/repository.js';
import { SearchService } from '../modules/search/service.js';
import { OperationsService } from '../modules/operations/operations-service.js';

const integration = process.env.DATABASE_URL ? describe : describe.skip;

class MutableClock implements Clock {
  constructor(public current = new Date('2026-12-12T07:00:00.000Z')) {}
  now(): Date { return new Date(this.current); }
}

const listen = async (app: ReturnType<typeof createApp>): Promise<{ server: Server; url: string }> => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Unable to bind test HTTP server.');
    resolve({ server, url: `http://127.0.0.1:${address.port}` });
  });
});

const close = async (server: Server): Promise<void> => new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
});

type EventOptions = {
  aggregateType?: string;
  aggregateId?: string;
  actorUserId?: string | null;
  occurredAt?: Date;
  eventVersion?: number;
  payloadSchemaVersion?: number;
};

integration('M11 Analytics Operational Hardening (PostgreSQL)', () => {
  let db: PostgresDatabase;
  let clock: MutableClock;
  let analytics: AnalyticsService;

  beforeAll(async () => {
    db = new PostgresDatabase();
    await db.query('SELECT 1');
  });

  beforeEach(async () => {
    clock = new MutableClock();
    analytics = new AnalyticsService(db, clock);
    await db.query(`TRUNCATE analytics_validation_findings, analytics_validation_runs, analytics_rebuild_runs,
      analytics_projection_failures, analytics_consumer_health, analytics_experiment_exposures, analytics_experiment_assignments,
      analytics_user_profiles, analytics_completed_participations, analytics_participant_facts, analytics_application_facts,
      analytics_room_facts, analytics_activity_events, analytics_processed_events, event_consumptions, event_outbox CASCADE`);
  });

  afterAll(async () => { await db.close(); });

  const event = (eventType: string, payload: Record<string, unknown>, options: EventOptions = {}) => makeDomainEvent({
    eventType,
    aggregateType: options.aggregateType ?? 'ROOM',
    aggregateId: options.aggregateId ?? newId(),
    actorUserId: Object.prototype.hasOwnProperty.call(options, 'actorUserId') ? options.actorUserId! : '10000000-0000-4000-8000-000000000001',
    correlationId: null,
    causationId: null,
    schemaVersion: 1,
    eventVersion: options.eventVersion,
    payloadSchemaVersion: options.payloadSchemaVersion,
    payload,
    occurredAt: options.occurredAt ?? clock.now(),
  }, clock);

  it('defaults legacy events to v1/v1 and records unknown event versions safely without projection', async () => {
    const roomId = '20000000-0000-4000-8000-000000000011';
    const legacy = event('ROOM_CREATED', { room_id: roomId, sport_code: 'BADMINTON', area_bucket: 'AREA_A', capacity: 4 }, { aggregateId: roomId });
    expect(legacy.eventVersion).toBe(1);
    expect(legacy.payloadSchemaVersion).toBe(1);
    expect(await analytics.project(legacy)).toBe(true);

    const unsupported = event('ROOM_CREATED', { room_id: newId(), sport_code: 'BADMINTON', area_bucket: 'AREA_A', capacity: 4 }, {
      eventVersion: 2, payloadSchemaVersion: 2,
    });
    expect(await analytics.project(unsupported)).toBe(false);

    const processed = await db.query<{ event_version: number; payload_schema_version: number }>(
      `SELECT event_version, payload_schema_version FROM analytics_processed_events WHERE event_id = $1`, [unsupported.id],
    );
    expect(processed.rows[0]).toEqual({ event_version: 2, payload_schema_version: 2 });
    const facts = await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM analytics_room_facts`);
    expect(facts.rows[0]?.count).toBe('1');
    const health = await analytics.getConsumerHealth();
    expect(health).toMatchObject({ processedEventCount: 1, unknownEventCount: 1, failedProjectionCount: 0 });
  });

  it('records projection failure evidence and increments health counters without mutating canonical data', async () => {
    const roomsBefore = await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM rooms`);
    const invalid = event('ROOM_CREATED', {
      room_id: newId(), sport_code: 'BADMINTON', area_bucket: 'AREA_A', capacity: 0,
    });
    await expect(analytics.project(invalid)).rejects.toThrow();

    const health = await analytics.getConsumerHealth();
    expect(health.failedProjectionCount).toBe(1);
    expect(health.lastFailureCode).toBe('PROJECTION_FAILED');
    const failures = await db.query<{ event_type: string; event_version: number; failure_code: string }>(
      `SELECT event_type, event_version, failure_code FROM analytics_projection_failures WHERE event_id = $1`, [invalid.id],
    );
    expect(failures.rows[0]).toEqual({ event_type: 'ROOM_CREATED', event_version: 1, failure_code: 'PROJECTION_FAILED' });
    expect((await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM rooms`)).rows[0]?.count)
      .toBe(roomsBefore.rows[0]?.count);
  });

  it('validates outbox provenance and pseudonymous projection integrity after replay', async () => {
    const roomId = '20000000-0000-4000-8000-000000000012';
    const userId = '30000000-0000-4000-8000-000000000012';
    const applicationId = '40000000-0000-4000-8000-000000000012';
    const participantId = '50000000-0000-4000-8000-000000000012';
    const source = [
      event('ROOM_CREATED', { room_id: roomId, sport_code: 'BADMINTON', area_bucket: 'AREA_A', capacity: 4 }, { aggregateId: roomId, actorUserId: null }),
      event('JOIN_REQUEST_CREATED', { application_id: applicationId, room_id: roomId, requested_by_user_id: userId, requested_slot_count: 1 }, { aggregateType: 'ROOM_APPLICATION', aggregateId: applicationId, actorUserId: null }),
      event('JOIN_REQUEST_ACCEPTED', { application_id: applicationId, room_id: roomId, requested_by_user_id: userId }, { aggregateType: 'ROOM_APPLICATION', aggregateId: applicationId, actorUserId: null }),
      event('PARTICIPANT_CREATED', { participant_id: participantId, room_id: roomId, user_id: userId }, { aggregateType: 'ROOM_PARTICIPANT', aggregateId: participantId, actorUserId: null }),
      event('PLAYER_MARKED_PRESENT', { participant_id: participantId, room_id: roomId, user_id: userId, attendance_status: 'PRESENT' }, { aggregateType: 'ROOM_PARTICIPANT', aggregateId: participantId, actorUserId: null }),
      event('ROOM_COMPLETED', { room_id: roomId }, { aggregateId: roomId, actorUserId: null }),
    ];
    await db.transaction(async (tx) => {
      for (const item of source) await appendOutboxEvent(tx, item);
    });
    expect(await analytics.rebuildFromOutbox()).toEqual({ replayed: 6, applied: 6 });
    const rebuild = await db.query<{ status: string; drift_json: Record<string, unknown> }>(
      `SELECT status, drift_json FROM analytics_rebuild_runs ORDER BY completed_at DESC LIMIT 1`,
    );
    expect(rebuild.rows[0]).toMatchObject({
      status: 'DRIFT',
      drift_json: { processed_events: { before: 0, after: 6 }, rooms: { before: 0, after: 1 } },
    });

    const validation = await analytics.validateProjection();
    expect(validation.status).toBe('PASSED');
    expect(validation.findings.every((finding) => finding.findingCount === 0)).toBe(true);
    const persisted = await db.query<{ status: string; count: string }>(
      `SELECT run.status, COUNT(finding.id)::text AS count FROM analytics_validation_runs run
       JOIN analytics_validation_findings finding ON finding.run_id = run.id GROUP BY run.status`,
    );
    expect(persisted.rows[0]).toEqual({ status: 'PASSED', count: '6' });
    const rawProjection = await db.query<Record<string, unknown>>(
      `SELECT room_key, host_key FROM analytics_room_facts UNION ALL SELECT user_key, NULL FROM analytics_user_profiles`,
    );
    expect(JSON.stringify(rawProjection)).not.toContain(roomId);
    expect(JSON.stringify(rawProjection)).not.toContain(userId);
  });

  it('keeps analytics health and quality checks behind the existing internal token-plus-allowlist boundary', async () => {
    const identity = new IdentityService(db, clock);
    const roomRepository = new RoomRepository();
    const participationRepository = new ParticipationRepository();
    const rooms = new RoomService(db, roomRepository, clock, participationRepository);
    const participation = new ParticipationService(db, roomRepository, participationRepository, clock);
    const lifecycle = new RoomLifecycleService(db, roomRepository, participationRepository, undefined, clock);
    const search = new SearchService(db, new SearchRepository(), identity, clock);
    const operations = new OperationsService(db, clock);
    const previousToken = config.internalOpsToken;
    const previousAllowlist = new Set(config.internalOpsAllowlist);
    let server: Server | undefined;
    try {
      config.internalOpsToken = 'm11-test-secret';
      config.internalOpsAllowlist.clear();
      config.internalOpsAllowlist.add('127.0.0.1');
      const bound = await listen(createApp({ rooms, identity, participation, lifecycle, search, operations, analytics }));
      server = bound.server;
      expect((await fetch(`${bound.url}/internal/analytics/health`)).status).toBe(403);
      expect((await fetch(`${bound.url}/internal/analytics/quality-check`, { method: 'POST' })).status).toBe(403);
      const headers = { 'X-Internal-Ops-Token': 'm11-test-secret' };
      const health = await fetch(`${bound.url}/internal/analytics/health`, { headers });
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ data: { consumerName: 'analytics-consumer-v1' } });
      const quality = await fetch(`${bound.url}/internal/analytics/quality-check`, { method: 'POST', headers });
      expect(quality.status).toBe(200);
      expect(await quality.json()).toMatchObject({ data: { status: 'PASSED' } });
    } finally {
      if (server) await close(server);
      config.internalOpsToken = previousToken;
      config.internalOpsAllowlist.clear();
      for (const value of previousAllowlist) config.internalOpsAllowlist.add(value);
    }
  });
});
