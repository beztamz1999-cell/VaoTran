import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { config, type Clock } from '../platform/core.js';
import { PostgresDatabase } from '../platform/database/db.js';
import { PostgresReadinessProbe } from '../platform/observability/readiness.js';
import { metrics } from '../platform/observability/metrics.js';
import { createApp } from '../platform/http/app.js';
import { appendOutboxEvent, makeDomainEvent } from '../platform/outbox/outbox.js';
import { IdentityService } from '../modules/identity/service.js';
import { OperationsService } from '../modules/operations/operations-service.js';
import { ReconciliationService } from '../modules/operations/reconciliation-service.js';
import { ParticipationRepository } from '../modules/participation/repository.js';
import { ParticipationService } from '../modules/participation/service.js';
import { RoomLifecycleService } from '../modules/room/lifecycle-service.js';
import { RoomRepository } from '../modules/room/repository.js';
import { RoomService, type CommandMeta } from '../modules/room/service.js';
import { SearchRepository } from '../modules/search/repository.js';
import { SearchService } from '../modules/search/service.js';

const integration = process.env.DATABASE_URL ? describe : describe.skip;
const sportId = '10000000-0000-4000-8000-000000000001';
const hostId = '20000000-0000-4000-8000-000000000001';

class MutableClock implements Clock {
  constructor(public current = new Date('2026-12-10T07:00:00.000Z')) {}
  now(): Date { return new Date(this.current); }
}

const meta = (actorUserId: string, key: string, commandType: string, request: unknown = {}): CommandMeta => ({
  actorUserId,
  idempotency: { key, actorUserId, commandType, request },
});

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

integration('M9 Pilot Hardening & Production Readiness (PostgreSQL)', () => {
  let db: PostgresDatabase;
  let clock: MutableClock;
  let rooms: RoomService;
  let participation: ParticipationService;
  let lifecycle: RoomLifecycleService;
  let identity: IdentityService;
  let search: SearchService;
  let operations: OperationsService;
  let reconciliation: ReconciliationService;
  let sequence = 0;
  const key = (label: string): string => `${label}-${++sequence}`;

  beforeAll(async () => {
    db = new PostgresDatabase();
    await db.query('SELECT 1');
  });

  beforeEach(async () => {
    sequence = 0;
    clock = new MutableClock();
    const roomRepository = new RoomRepository();
    const participationRepository = new ParticipationRepository();
    identity = new IdentityService(db);
    rooms = new RoomService(db, roomRepository, clock, participationRepository);
    participation = new ParticipationService(db, roomRepository, participationRepository, clock);
    lifecycle = new RoomLifecycleService(db, roomRepository, participationRepository, undefined, clock);
    search = new SearchService(db, new SearchRepository(), identity, clock);
    operations = new OperationsService(db, clock);
    reconciliation = new ReconciliationService(db, clock);
    await db.query(`TRUNCATE
      internal_operation_audits, reconciliation_findings, reconciliation_runs,
      push_deliveries, push_devices, notifications, notification_preferences,
      reliability_adjustments, participation_cancellations, slot_recovery_records, room_refill_states,
      player_reliability_stats, host_stats, participant_attendance_logs, room_participants,
      room_application_members, room_applications, party_members, parties, friendships,
      room_availability_projections, room_change_logs, room_equipment_options, room_equipment_policies,
      rooms, search_telemetry_events, event_consumptions, event_outbox, idempotency_keys,
      user_sport_profiles, users CASCADE`);
    await db.query(
      `INSERT INTO users (id, phone, display_name, status, home_area, created_at, updated_at)
       VALUES ($1, '0910000001', 'M9 HOST', 'ACTIVE', NULL, NOW(), NOW())`,
      [hostId],
    );
    await db.query(
      `INSERT INTO user_sport_profiles (user_id, sport_id, skill_state, skill_score, created_at, updated_at)
       VALUES ($1, $2, 'RANKED', 6, NOW(), NOW())`,
      [hostId, sportId],
    );
  });

  afterAll(async () => { await db.close(); });

  const createRoom = async () => rooms.create(meta(hostId, key('create'), 'CreateRoom', {}), {
    sportCode: 'BADMINTON', title: 'M9 Room', venue: { name: 'Sân M9', address: 'Quận 1', latitude: 10.776, longitude: 106.700 },
    scheduledStartAt: new Date('2026-12-10T12:00:00.000Z'), scheduledEndAt: new Date('2026-12-10T14:00:00.000Z'),
    capacity: 4, hostParticipates: true, reservedExternalCount: 0, priceAmount: 100_000, currency: 'VND',
    preferredSkill: null, equipment: { supplyMode: 'PLAYER_BRINGS', allowedOptions: [{ displayName: 'Vợt cá nhân' }] },
    allowEmergencyReplacement: true,
  });

  it('reports database readiness and records bounded database timing metrics without recording query data', async () => {
    const readiness = new PostgresReadinessProbe(db);
    expect(await readiness.check()).toMatchObject({ ready: true, database: 'ok' });
    await db.query('SELECT 1 AS probe');
    const snapshot = metrics.snapshot(clock.now());
    expect(snapshot.gauges).toContainEqual(expect.objectContaining({ name: 'vaotran_database_ready', value: 1 }));
    expect(snapshot.histograms.some((item) => item.name === 'vaotran_db_query_duration_ms')).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('SELECT 1 AS probe');
  });

  it('detects room projection drift and persists a finding without automatically repairing authoritative business data', async () => {
    const created = await createRoom();
    await db.query(
      `UPDATE room_availability_projections SET available_public_slots = 0, occupied_slots = 4 WHERE room_id = $1`,
      [created.body.roomId],
    );
    const run = await reconciliation.runOnce();
    expect(run.status).toBe('COMPLETED');
    expect(run.byCheck.ROOM_AVAILABILITY).toBeGreaterThanOrEqual(1);
    const finding = await db.query<{ check_name: string; state: string }>(
      `SELECT check_name, state::text FROM reconciliation_findings WHERE reconciliation_run_id = $1 AND entity_id = $2`,
      [run.runId, created.body.roomId],
    );
    expect(finding.rows).toContainEqual({ check_name: 'ROOM_AVAILABILITY', state: 'OPEN' });
    const projection = await db.query<{ available_public_slots: number }>(
      `SELECT available_public_slots FROM room_availability_projections WHERE room_id = $1`, [created.body.roomId],
    );
    expect(projection.rows[0]?.available_public_slots).toBe(0);
  });

  it('applies idempotent operator suspend and retry transitions while writing an audit trail for every attempt', async () => {
    const firstSuspend = await operations.suspendUser(hostId, 'm9-correlation-suspend-1');
    const secondSuspend = await operations.suspendUser(hostId, 'm9-correlation-suspend-2');
    expect(firstSuspend).toMatchObject({ id: hostId, status: 'SUSPENDED' });
    expect(secondSuspend).toMatchObject({ id: hostId, status: 'SUSPENDED' });

    await db.transaction(async (tx) => appendOutboxEvent(tx, makeDomainEvent({
      eventType: 'M9_RETRYABLE_EVENT', aggregateType: 'ROOM', aggregateId: '30000000-0000-4000-8000-000000000001',
      actorUserId: hostId, correlationId: '30000000-0000-4000-8000-000000000002', causationId: null, schemaVersion: 1, payload: {},
    }, clock)));
    const event = await db.query<{ id: string }>(`SELECT id FROM event_outbox WHERE event_type = 'M9_RETRYABLE_EVENT'`);
    const eventId = event.rows[0]!.id;
    await db.query(`UPDATE event_outbox SET publish_status = 'DEAD_LETTER' WHERE id = $1`, [eventId]);
    expect((await operations.retryOutboxEvent(eventId, 'm9-correlation-retry'))?.publishStatus).toBe('PENDING');
    expect(await operations.retryOutboxEvent(eventId, 'm9-correlation-retry-again')).toBeNull();

    const audits = await db.query<{ action: string; outcome: string }>(
      `SELECT action, outcome FROM internal_operation_audits ORDER BY created_at ASC`,
    );
    expect(audits.rows).toEqual(expect.arrayContaining([
      { action: 'SUSPEND_USER', outcome: 'SUSPENDED' },
      { action: 'SUSPEND_USER', outcome: 'ALREADY_SUSPENDED' },
      { action: 'RETRY_OUTBOX_EVENT', outcome: 'QUEUED' },
      { action: 'RETRY_OUTBOX_EVENT', outcome: 'NOT_ACTIONABLE' },
    ]));
  });

  it('denies internal inspection without both allowlist and token, then permits an authorized redacted inspection response', async () => {
    const previousToken = config.internalOpsToken;
    const previousAllowlist = new Set(config.internalOpsAllowlist);
    let server: Server | undefined;
    try {
      config.internalOpsToken = 'm9-test-secret';
      config.internalOpsAllowlist.clear();
      config.internalOpsAllowlist.add('127.0.0.1');
      const app = createApp({ rooms, identity, participation, lifecycle, search, operations, readiness: new PostgresReadinessProbe(db) });
      const bound = await listen(app);
      server = bound.server;

      const denied = await fetch(`${bound.url}/internal/users/${hostId}`);
      expect(denied.status).toBe(403);
      expect(JSON.stringify(await denied.json())).not.toContain('M9 HOST');

      const authorized = await fetch(`${bound.url}/internal/users/${hostId}`, { headers: { 'X-Internal-Ops-Token': 'm9-test-secret' } });
      expect(authorized.status).toBe(200);
      const payload = await authorized.json() as { data: Record<string, unknown> };
      expect(payload.data).toMatchObject({ id: hostId, display_name: 'M9 HOST', status: 'ACTIVE' });
      expect(Object.keys(payload.data)).not.toContain('phone');
    } finally {
      if (server) await close(server);
      config.internalOpsToken = previousToken;
      config.internalOpsAllowlist.clear();
      for (const value of previousAllowlist) config.internalOpsAllowlist.add(value);
    }
  });
});
