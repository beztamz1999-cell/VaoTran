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
  constructor(public current = new Date('2026-12-10T07:00:00.000Z')) {}
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

integration('M10 Pilot Growth Loop & Marketplace Learning (PostgreSQL)', () => {
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
    await db.query(`TRUNCATE analytics_experiment_exposures, analytics_experiment_assignments, analytics_user_profiles,
      analytics_completed_participations, analytics_participant_facts, analytics_application_facts, analytics_room_facts,
      analytics_activity_events, analytics_processed_events, event_consumptions, event_outbox CASCADE`);
  });

  afterAll(async () => { await db.close(); });

  const event = (eventType: string, payload: Record<string, unknown>, options: { aggregateType?: string; aggregateId?: string; actorUserId?: string | null; occurredAt?: Date } = {}) => makeDomainEvent({
    eventType, aggregateType: options.aggregateType ?? 'ROOM', aggregateId: options.aggregateId ?? newId(), actorUserId: Object.prototype.hasOwnProperty.call(options, 'actorUserId') ? options.actorUserId! : '10000000-0000-4000-8000-000000000001',
    correlationId: null, causationId: null, schemaVersion: 1, payload, occurredAt: options.occurredAt ?? clock.now(),
  }, clock);

  it('projects only pseudonymous read-side facts and deduplicates replay of the same source event', async () => {
    const rawRoomId = '20000000-0000-4000-8000-000000000001';
    const rawUserId = '30000000-0000-4000-8000-000000000001';
    const created = event('ROOM_CREATED', {
      room_id: rawRoomId, sport_code: 'BADMINTON', area_bucket: 'GEO_10.7_106.7', scheduled_hour_utc: 12, capacity: 4,
    }, { aggregateId: rawRoomId, actorUserId: rawUserId });
    expect(await analytics.project(created)).toBe(true);
    expect(await analytics.project(created)).toBe(false);
    await analytics.project(event('ROOM_PUBLISHED', { room_id: rawRoomId }, { aggregateId: rawRoomId, actorUserId: rawUserId }));
    await analytics.project(event('SEARCH_EXECUTED', {
      sport_code: 'BADMINTON', area_bucket: 'GEO_10.7_106.7', scheduled_hour_utc: 12, result_count: 0, user_id: rawUserId,
    }, { aggregateType: 'SEARCH', actorUserId: null }));

    const facts = await db.query<Record<string, unknown>>(`SELECT room_key, host_key, sport_code, area_bucket FROM analytics_room_facts`);
    expect(facts.rowCount).toBe(1);
    expect(JSON.stringify(facts.rows[0])).not.toContain(rawRoomId);
    expect(JSON.stringify(facts.rows[0])).not.toContain(rawUserId);
    const funnel = await analytics.getFunnel({ from: new Date('2026-12-01T00:00:00.000Z'), to: new Date('2026-12-20T00:00:00.000Z') });
    expect(funnel).toMatchObject({ host: { created: 1, published: 1 }, player: { searched: 1 } });
  });

  it('rebuilds derived analytics from event_outbox without changing source events or business data', async () => {
    const rawRoomId = '20000000-0000-4000-8000-000000000002';
    const rawUserId = '30000000-0000-4000-8000-000000000002';
    const sourceEvents = [
      event('ROOM_CREATED', { room_id: rawRoomId, sport_code: 'BADMINTON', area_bucket: 'GEO_10.7_106.7', scheduled_hour_utc: 12, capacity: 4 }, { aggregateId: rawRoomId, actorUserId: null }),
      event('ROOM_PUBLISHED', { room_id: rawRoomId }, { aggregateId: rawRoomId, actorUserId: null }),
      event('JOIN_REQUEST_CREATED', { application_id: newId(), room_id: rawRoomId, requested_by_user_id: rawUserId, requested_slot_count: 1 }, { aggregateType: 'ROOM_APPLICATION', actorUserId: null }),
    ];
    await db.transaction(async (tx) => {
      for (const sourceEvent of sourceEvents) await appendOutboxEvent(tx, sourceEvent);
    });
    const before = await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM event_outbox`);
    const rebuilt = await analytics.rebuildFromOutbox();
    const after = await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM event_outbox`);
    expect(rebuilt).toEqual({ replayed: 3, applied: 3 });
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    const funnel = await analytics.getFunnel({ from: new Date('2026-12-01T00:00:00.000Z'), to: new Date('2026-12-20T00:00:00.000Z') });
    expect(funnel).toMatchObject({ host: { created: 1, published: 1, first_application: 1 }, player: { join_created: 1 } });
  });

  it('uses a stable experiment assignment and idempotent exposure record without altering any product behavior', async () => {
    const userId = '30000000-0000-4000-8000-000000000003';
    const first = await analytics.assignExperiment({ userId, experimentKey: 'search-copy-v1', variants: ['control', 'treatment'] });
    const second = await analytics.assignExperiment({ userId, experimentKey: 'search-copy-v1', variants: ['treatment', 'control'] });
    expect(second).toEqual(first);
    expect(await analytics.recordExperimentExposure({ userId, experimentKey: first.experimentKey, variantKey: first.variantKey, exposureKey: 'search-results' })).toBe(true);
    expect(await analytics.recordExperimentExposure({ userId, experimentKey: first.experimentKey, variantKey: first.variantKey, exposureKey: 'search-results' })).toBe(false);
    const exposed = await db.query<{ subject_key: string; variant_key: string }>(`SELECT subject_key, variant_key FROM analytics_experiment_exposures`);
    expect(exposed.rowCount).toBe(1);
    expect(exposed.rows[0]?.subject_key).not.toContain(userId);
  });

  it('protects analytics aggregates with the existing internal token and IP allowlist boundary', async () => {
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
      config.internalOpsToken = 'm10-test-secret';
      config.internalOpsAllowlist.clear();
      config.internalOpsAllowlist.add('127.0.0.1');
      const bound = await listen(createApp({ rooms, identity, participation, lifecycle, search, operations, analytics }));
      server = bound.server;
      expect((await fetch(`${bound.url}/internal/analytics/funnels`)).status).toBe(403);
      const authorized = await fetch(`${bound.url}/internal/analytics/funnels`, { headers: { 'X-Internal-Ops-Token': 'm10-test-secret' } });
      expect(authorized.status).toBe(200);
      expect(JSON.stringify(await authorized.json())).not.toContain('30000000-0000-4000-8000-000000000003');
      for (const path of ['host-performance', 'player-retention', 'marketplace-health']) {
        expect((await fetch(`${bound.url}/internal/analytics/${path}`, { headers: { 'X-Internal-Ops-Token': 'm10-test-secret' } })).status).toBe(200);
      }
    } finally {
      if (server) await close(server);
      config.internalOpsToken = previousToken;
      config.internalOpsAllowlist.clear();
      for (const value of previousAllowlist) config.internalOpsAllowlist.add(value);
    }
  });
});
