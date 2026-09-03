import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Clock } from '../platform/core.js';
import { PostgresDatabase } from '../platform/database/db.js';
import { IdentityService } from '../modules/identity/service.js';
import { ParticipationRepository } from '../modules/participation/repository.js';
import { ParticipationService } from '../modules/participation/service.js';
import { RoomRepository } from '../modules/room/repository.js';
import { RoomService, type CommandMeta } from '../modules/room/service.js';
import { SearchRepository } from '../modules/search/repository.js';
import { SearchService } from '../modules/search/service.js';

const integration = process.env.DATABASE_URL ? describe : describe.skip;
const sportId = '10000000-0000-4000-8000-000000000001';
const hostId = '20000000-0000-4000-8000-000000000001';
const playerOneId = '20000000-0000-4000-8000-000000000002';
const playerTwoId = '20000000-0000-4000-8000-000000000003';

class MutableClock implements Clock {
  constructor(public current = new Date('2026-10-01T11:30:00.000Z')) {}
  now(): Date { return new Date(this.current); }
}

const meta = (actorUserId: string, key: string, commandType: string, request: unknown = {}): CommandMeta => ({
  actorUserId,
  idempotency: { key, actorUserId, commandType, request },
});

integration('M4 Search & Discovery (PostgreSQL)', () => {
  let db: PostgresDatabase;
  let rooms: RoomService;
  let participation: ParticipationService;
  let search: SearchService;
  let searchRepository: SearchRepository;
  let clock: MutableClock;
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
    rooms = new RoomService(db, roomRepository, clock, participationRepository);
    participation = new ParticipationService(db, roomRepository, participationRepository, clock);
    searchRepository = new SearchRepository();
    search = new SearchService(db, searchRepository, new IdentityService(db), clock);
    await db.query('TRUNCATE search_telemetry_events, participant_attendance_logs, room_participants, room_application_members, room_applications, room_availability_projections, room_change_logs, room_equipment_options, room_equipment_policies, rooms, event_consumptions, event_outbox, idempotency_keys, user_sport_profiles, users CASCADE');
    await db.query(
      `INSERT INTO users (id, phone, display_name, status, home_area, created_at, updated_at) VALUES
       ($1, '0900000001', 'HOST', 'ACTIVE', NULL, NOW(), NOW()),
       ($2, '0900000002', 'Player One', 'ACTIVE', 'fallback-district', NOW(), NOW()),
       ($3, '0900000003', 'Player Two', 'ACTIVE', NULL, NOW(), NOW())`,
      [hostId, playerOneId, playerTwoId],
    );
    await db.query(
      `INSERT INTO user_sport_profiles (user_id, sport_id, skill_state, skill_score, created_at, updated_at) VALUES
       ($1, $4, 'RANKED', 7.0, NOW(), NOW()),
       ($2, $4, 'RANKED', 5.0, NOW(), NOW()),
       ($3, $4, 'RANKED', 7.0, NOW(), NOW())`,
      [hostId, playerOneId, playerTwoId, sportId],
    );
  });

  afterAll(async () => { await db.close(); });

  const createPublishedRoom = async (input: {
    title?: string; capacity?: number; reservedExternalCount?: number; latitude?: number; longitude?: number;
    venueName?: string; venueAddress?: string; startAt?: Date; endAt?: Date; preferredSkill?: { minScore: number | null; maxScore: number | null } | null;
  } = {}): Promise<string> => {
    const created = await rooms.create(meta(hostId, key('create'), 'CreateRoom', input), {
      sportCode: 'BADMINTON', title: input.title ?? 'M4 Search Room',
      venue: { name: input.venueName ?? 'M4 Court', address: input.venueAddress, latitude: input.latitude, longitude: input.longitude },
      scheduledStartAt: input.startAt ?? new Date('2026-10-01T12:00:00.000Z'),
      scheduledEndAt: input.endAt ?? new Date('2026-10-01T14:00:00.000Z'),
      capacity: input.capacity ?? 3, hostParticipates: true, reservedExternalCount: input.reservedExternalCount ?? 0,
      priceAmount: 80_000, currency: 'VND', preferredSkill: input.preferredSkill ?? null,
      equipment: { supplyMode: 'PLAYER_BRINGS' }, allowEmergencyReplacement: true,
    });
    await rooms.publish(created.body.roomId, meta(hostId, key('publish'), 'PublishRoom', {}));
    return created.body.roomId;
  };

  const acceptPlayerOne = async (roomId: string): Promise<void> => {
    const application = await participation.createApplication(roomId, meta(playerOneId, key('apply'), 'CreateJoinApplication', {}), {});
    await participation.acceptApplication(application.body.applicationId, meta(hostId, key('accept'), 'AcceptJoinApplication', {}));
  };

  it('1. chỉ trả Room OPEN; 2. hiển thị chính xác available_public_slots; 3. search không mutation business state', async () => {
    const openRoomId = await createPublishedRoom({ capacity: 3, reservedExternalCount: 1, title: 'Open searchable' });
    const fullRoomId = await createPublishedRoom({ capacity: 2, title: 'Full hidden' });
    await acceptPlayerOne(fullRoomId);
    const inProgressRoomId = await createPublishedRoom({ capacity: 3, title: 'Started hidden' });
    await db.query(`UPDATE rooms SET status = 'IN_PROGRESS', actual_started_at = $2, start_source = 'MANUAL', updated_at = $2 WHERE id = $1`, [inProgressRoomId, clock.now()]);

    const before = await db.query<{ version: number; available_public_slots: number; events: string }>(
      `SELECT r.version, a.available_public_slots,
        (SELECT COUNT(*)::text FROM event_outbox WHERE aggregate_id = r.id) AS events
       FROM rooms r JOIN room_availability_projections a ON a.room_id = r.id WHERE r.id = $1`, [openRoomId],
    );
    const result = await search.search({ actorUserId: playerTwoId, sportCode: 'BADMINTON' });
    const after = await db.query<{ version: number; available_public_slots: number; events: string }>(
      `SELECT r.version, a.available_public_slots,
        (SELECT COUNT(*)::text FROM event_outbox WHERE aggregate_id = r.id) AS events
       FROM rooms r JOIN room_availability_projections a ON a.room_id = r.id WHERE r.id = $1`, [openRoomId],
    );

    expect(result.data.map((card) => card.roomId)).toEqual([openRoomId]);
    expect(result.data[0]?.availablePublicSlots).toBe(1);
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect((await rooms.getRoom(fullRoomId)).room.status).toBe('FULL');
  });

  it('4. progressive radius 5 → 10 → 20 km và không duplicate candidate', async () => {
    const nearSeven = await createPublishedRoom({ title: 'Seven km', latitude: 0.063, longitude: 0 });
    const nearTwelve = await createPublishedRoom({ title: 'Twelve km', latitude: 0.108, longitude: 0 });
    const result = await search.search({ actorUserId: playerTwoId, sportCode: 'BADMINTON', latitude: 0, longitude: 0 });
    expect(result.meta.radiusStepsConsidered).toEqual([5, 10, 20]);
    expect(result.meta.radiusKm).toBe(20);
    expect(result.meta.radiusExpanded).toBe(true);
    expect(result.data.map((card) => card.roomId).sort()).toEqual([nearSeven, nearTwelve].sort());
    expect(new Set(result.data.map((card) => card.roomId)).size).toBe(2);
    expect(await searchRepository.countTelemetry(db, 'SEARCH_RADIUS_EXPANDED')).toBe(2);
  });

  it('5. lọc time window; 6. fallback home_area không chặn search và không tính distance giả', async () => {
    const overlapping = await createPublishedRoom({ title: 'Overlap', venueName: 'fallback-district court', startAt: new Date('2026-10-01T12:00:00.000Z'), endAt: new Date('2026-10-01T14:00:00.000Z') });
    await createPublishedRoom({ title: 'Outside', venueName: 'other court', startAt: new Date('2026-10-01T16:00:00.000Z'), endAt: new Date('2026-10-01T18:00:00.000Z') });
    const result = await search.search({
      actorUserId: playerOneId, sportCode: 'BADMINTON', timeStart: new Date('2026-10-01T13:00:00.000Z'), timeEnd: new Date('2026-10-01T15:00:00.000Z'),
    });
    expect(result.meta.locationMode).toBe('AREA');
    expect(result.data.map((card) => card.roomId)).toEqual([overlapping]);
    expect(result.data[0]?.distanceKm).toBeNull();
  });

  it('7. same input luôn có stable order; 8. skill mismatch là soft ranking với badge rõ ràng', async () => {
    await db.query('UPDATE users SET home_area = NULL WHERE id = $1', [playerOneId]);
    const a = await createPublishedRoom({ title: 'A', preferredSkill: { minScore: 6, maxScore: 8 } });
    const b = await createPublishedRoom({ title: 'B', preferredSkill: { minScore: 6, maxScore: 8 } });
    const first = await search.search({ actorUserId: playerOneId, sportCode: 'BADMINTON' });
    const second = await search.search({ actorUserId: playerOneId, sportCode: 'BADMINTON' });
    expect(first.data.map((card) => card.roomId)).toEqual(second.data.map((card) => card.roomId));
    expect(first.data.map((card) => card.roomId).sort()).toEqual([a, b].sort());
    expect(first.data.every((card) => card.skillFit === 'BELOW_RANGE' && card.badges.includes('SKILL_BELOW_RANGE'))).toBe(true);
  });

  it('9. telemetry search/card/detail được ghi append-only mà không đổi Room capacity hay lifecycle', async () => {
    const roomId = await createPublishedRoom({ title: 'Telemetry room' });
    const before = await rooms.getRoom(roomId);
    await search.search({ actorUserId: playerTwoId, sportCode: 'BADMINTON' });
    await search.recordRoomCardViewed(playerTwoId, roomId);
    await search.recordRoomDetailOpened(playerTwoId, roomId);
    const after = await rooms.getRoom(roomId);
    expect(after.room.status).toBe(before.room.status);
    expect(after.room.version).toBe(before.room.version);
    expect(after.availability).toEqual(before.availability);
    expect(await searchRepository.countTelemetry(db, 'SEARCH_STARTED')).toBe(1);
    expect(await searchRepository.countTelemetry(db, 'ROOM_CARD_VIEWED')).toBe(1);
    expect(await searchRepository.countTelemetry(db, 'ROOM_DETAIL_OPENED')).toBe(1);
  });
});
