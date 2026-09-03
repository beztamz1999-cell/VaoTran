import { performance } from 'node:perf_hooks';
import { PostgresDatabase } from '../src/platform/database/db.js';
import { IdentityService } from '../src/modules/identity/service.js';
import { ParticipationRepository } from '../src/modules/participation/repository.js';
import { ParticipationService } from '../src/modules/participation/service.js';
import { RoomRepository } from '../src/modules/room/repository.js';
import { RoomService, type CommandMeta } from '../src/modules/room/service.js';
import { SearchRepository } from '../src/modules/search/repository.js';
import { SearchService } from '../src/modules/search/service.js';

const sportId = '10000000-0000-4000-8000-000000000001';
const hostId = '20000000-0000-4000-8000-000000000001';
const searcherId = '20000000-0000-4000-8000-000000000002';
const playerId = (index: number) => `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const actorMeta = (actorUserId: string, key: string, commandType: string, request: unknown = {}): CommandMeta => ({
  actorUserId,
  idempotency: { key, actorUserId, commandType, request },
});

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
};

const measured = async <T>(action: () => Promise<T>): Promise<{ value: T; durationMs: number }> => {
  const started = performance.now();
  const value = await action();
  return { value, durationMs: performance.now() - started };
};

const main = async (): Promise<void> => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the controlled performance baseline.');

  const db = new PostgresDatabase();
  const rooms = new RoomService(db, new RoomRepository(), undefined, new ParticipationRepository());
  const participation = new ParticipationService(db, new RoomRepository(), new ParticipationRepository());
  const search = new SearchService(db, new SearchRepository(), new IdentityService(db));
  const playerCount = 20;

  try {
    await db.query('SELECT 1');
    await db.query('TRUNCATE internal_operation_audits, reconciliation_findings, reconciliation_runs, push_deliveries, push_devices, notifications, notification_preferences, search_telemetry_events, participant_attendance_logs, room_participants, room_application_members, room_applications, party_members, parties, friendships, room_availability_projections, room_change_logs, room_equipment_options, room_equipment_policies, rooms, event_consumptions, event_outbox, idempotency_keys, user_sport_profiles, users CASCADE');

    const users = [hostId, searcherId, ...Array.from({ length: playerCount }, (_, index) => playerId(index + 1))];
    for (const [index, id] of users.entries()) {
      await db.query(
        `INSERT INTO users (id, phone, display_name, status, home_area, created_at, updated_at)
         VALUES ($1, $2, $3, 'ACTIVE', 'pilot-baseline', NOW(), NOW())`,
        [id, `099${String(index).padStart(7, '0')}`, `Baseline User ${index}`],
      );
      await db.query(
        `INSERT INTO user_sport_profiles (user_id, sport_id, skill_state, skill_score, created_at, updated_at)
         VALUES ($1, $2, 'RANKED', 5.0, NOW(), NOW())`,
        [id, sportId],
      );
    }

    const startAt = new Date('2026-12-01T12:00:00.000Z');
    const endAt = new Date('2026-12-01T14:00:00.000Z');
    const searchableRoomIds: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const created = await rooms.create(actorMeta(hostId, `baseline-create-${index}`, 'CreateRoom', { index }), {
        sportCode: 'BADMINTON', title: `Baseline Search Room ${index}`,
        venue: { name: `Court ${index}`, latitude: 10.776 + index * 0.001, longitude: 106.700 + index * 0.001 },
        scheduledStartAt: startAt, scheduledEndAt: endAt, capacity: 30, hostParticipates: true,
        reservedExternalCount: 0, priceAmount: null, currency: 'VND', preferredSkill: null,
        equipment: { supplyMode: 'PLAYER_BRINGS' }, allowEmergencyReplacement: true,
      });
      await rooms.publish(created.body.roomId, actorMeta(hostId, `baseline-publish-${index}`, 'PublishRoom', {}));
      searchableRoomIds.push(created.body.roomId);
    }

    const searchSamples: number[] = [];
    for (let index = 0; index < 30; index += 1) {
      const sample = await measured(() => search.search({
        actorUserId: searcherId, sportCode: 'BADMINTON', latitude: 10.776, longitude: 106.700, timeEnd: new Date('2026-12-02T00:00:00.000Z'),
      }));
      if (sample.value.data.length !== searchableRoomIds.length) throw new Error(`Search baseline expected ${searchableRoomIds.length} results, received ${sample.value.data.length}.`);
      searchSamples.push(sample.durationMs);
    }

    const capacity = playerCount + 1;
    const raceCreated = await rooms.create(actorMeta(hostId, 'baseline-race-create', 'CreateRoom', { capacity }), {
      sportCode: 'BADMINTON', title: 'Baseline Concurrent Accept Room', venue: { name: 'Race Court' },
      scheduledStartAt: new Date('2026-12-02T12:00:00.000Z'), scheduledEndAt: new Date('2026-12-02T14:00:00.000Z'),
      capacity, hostParticipates: true, reservedExternalCount: 0, priceAmount: null, currency: 'VND', preferredSkill: null,
      equipment: { supplyMode: 'PLAYER_BRINGS' }, allowEmergencyReplacement: true,
    });
    await rooms.publish(raceCreated.body.roomId, actorMeta(hostId, 'baseline-race-publish', 'PublishRoom', {}));
    const applications = await Promise.all(Array.from({ length: playerCount }, async (_, index) => {
      const id = playerId(index + 1);
      return participation.createApplication(raceCreated.body.roomId, actorMeta(id, `baseline-apply-${index}`, 'CreateJoinApplication', {}), {});
    }));

    const raceStarted = performance.now();
    const results = await Promise.allSettled(applications.map((application, index) => participation.acceptApplication(
      application.body.applicationId,
      actorMeta(hostId, `baseline-accept-${index}`, 'AcceptJoinApplication', {}),
    )));
    const concurrentAcceptMs = performance.now() - raceStarted;
    const accepted = results.filter((result) => result.status === 'fulfilled').length;
    if (accepted !== playerCount) throw new Error(`Concurrent accept expected ${playerCount} accepted applications, received ${accepted}.`);
    const active = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM room_participants WHERE room_id = $1 AND status = 'ACTIVE'`, [raceCreated.body.roomId],
    );
    if (Number(active.rows[0]?.count) !== playerCount) throw new Error('Concurrent accept capacity invariant failed.');

    const report = {
      generatedAt: new Date().toISOString(),
      scope: 'Controlled PostgreSQL baseline; not a production capacity commitment.',
      dataset: { searchableRooms: searchableRoomIds.length, concurrentApplicants: playerCount },
      searchMs: { samples: searchSamples.length, p50: Number(percentile(searchSamples, 0.5).toFixed(2)), p95: Number(percentile(searchSamples, 0.95).toFixed(2)), max: Number(Math.max(...searchSamples).toFixed(2)) },
      concurrentAccept: { attempted: playerCount, accepted, durationMs: Number(concurrentAcceptMs.toFixed(2)), activeParticipants: Number(active.rows[0]?.count ?? 0) },
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await db.close();
  }
};

await main();
