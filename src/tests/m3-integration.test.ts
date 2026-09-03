import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { DomainError, type Clock } from '../platform/core.js';
import { PostgresDatabase } from '../platform/database/db.js';
import { ParticipationRepository } from '../modules/participation/repository.js';
import { ParticipationService } from '../modules/participation/service.js';
import { RoomLifecycleService } from '../modules/room/lifecycle-service.js';
import { RoomRepository } from '../modules/room/repository.js';
import { RoomService, type CommandMeta } from '../modules/room/service.js';

const integration = process.env.DATABASE_URL ? describe : describe.skip;
const sportId = '10000000-0000-4000-8000-000000000001';
const hostId = '20000000-0000-4000-8000-000000000001';
const playerOneId = '20000000-0000-4000-8000-000000000002';
const playerTwoId = '20000000-0000-4000-8000-000000000003';

class MutableClock implements Clock {
  constructor(public current = new Date('2026-10-01T11:30:00.000Z')) {}
  now(): Date { return new Date(this.current); }
  set(iso: string): void { this.current = new Date(iso); }
}

const meta = (actorUserId: string, key: string, commandType: string, request: unknown = {}): CommandMeta => ({
  actorUserId,
  idempotency: { key, actorUserId, commandType, request },
});

integration('M3 Room Lifecycle + Attendance (PostgreSQL)', () => {
  let db: PostgresDatabase;
  let roomRepository: RoomRepository;
  let participationRepository: ParticipationRepository;
  let rooms: RoomService;
  let participation: ParticipationService;
  let lifecycle: RoomLifecycleService;
  let clock: MutableClock;
  let sequence = 0;
  const key = (label: string): string => `${label}-${++sequence}`;

  beforeAll(async () => {
    db = new PostgresDatabase();
    roomRepository = new RoomRepository();
    participationRepository = new ParticipationRepository();
    await db.query('SELECT 1');
  });

  beforeEach(async () => {
    sequence = 0;
    clock = new MutableClock();
    rooms = new RoomService(db, roomRepository, clock, participationRepository);
    participation = new ParticipationService(db, roomRepository, participationRepository, clock);
    lifecycle = new RoomLifecycleService(db, roomRepository, participationRepository, undefined, clock);
    await db.query('TRUNCATE participant_attendance_logs, room_participants, room_application_members, room_applications, room_availability_projections, room_change_logs, room_equipment_options, room_equipment_policies, rooms, event_consumptions, event_outbox, idempotency_keys, user_sport_profiles, users CASCADE');
    await db.query(
      `INSERT INTO users (id, phone, display_name, status, created_at, updated_at) VALUES
       ($1, '0900000001', 'HOST', 'ACTIVE', NOW(), NOW()),
       ($2, '0900000002', 'Player One', 'ACTIVE', NOW(), NOW()),
       ($3, '0900000003', 'Player Two', 'ACTIVE', NOW(), NOW())`,
      [hostId, playerOneId, playerTwoId],
    );
    await db.query(
      `INSERT INTO user_sport_profiles (user_id, sport_id, skill_state, created_at, updated_at) VALUES
       ($1, $4, 'UNRANKED', NOW(), NOW()), ($2, $4, 'UNRANKED', NOW(), NOW()), ($3, $4, 'UNRANKED', NOW(), NOW())`,
      [hostId, playerOneId, playerTwoId, sportId],
    );
  });

  afterAll(async () => { await db.close(); });

  const createPublishedRoom = async (capacity = 2): Promise<string> => {
    const created = await rooms.create(meta(hostId, key('create'), 'CreateRoom', { capacity }), {
      sportCode: 'BADMINTON', title: 'M3 test room', venue: { name: 'Sân M3' },
      scheduledStartAt: new Date('2026-10-01T12:00:00.000Z'), scheduledEndAt: new Date('2026-10-01T14:00:00.000Z'),
      capacity, hostParticipates: true, reservedExternalCount: 0, priceAmount: null, currency: 'VND',
      preferredSkill: null, equipment: { supplyMode: 'PLAYER_BRINGS' }, allowEmergencyReplacement: true,
    });
    await rooms.publish(created.body.roomId, meta(hostId, key('publish'), 'PublishRoom', {}));
    return created.body.roomId;
  };

  const acceptPlayer = async (roomId: string, playerId = playerOneId): Promise<string> => {
    const application = await participation.createApplication(roomId, meta(playerId, key('request'), 'CreateJoinApplication', {}), {});
    const accepted = await participation.acceptApplication(application.body.applicationId, meta(hostId, key('accept'), 'AcceptJoinApplication', {}));
    return accepted.body.participantIds[0]!;
  };

  it('1. OPEN Room manual start được; 2. FULL Room manual start được', async () => {
    const openRoomId = await createPublishedRoom(3);
    const openStarted = await lifecycle.manualStart(openRoomId, meta(hostId, key('start-open'), 'StartRoom', {}));
    expect(openStarted.body.status).toBe('IN_PROGRESS');
    expect(openStarted.body.startSource).toBe('MANUAL');

    const fullRoomId = await createPublishedRoom(2);
    await acceptPlayer(fullRoomId);
    const fullStarted = await lifecycle.manualStart(fullRoomId, meta(hostId, key('start-full'), 'StartRoom', {}));
    expect(fullStarted.body.status).toBe('IN_PROGRESS');
    expect((await rooms.getRoom(fullRoomId)).room.status).toBe('IN_PROGRESS');
  });

  it('3. manual start quá sớm hơn 30 phút bị reject', async () => {
    clock.set('2026-10-01T11:29:59.999Z');
    const roomId = await createPublishedRoom(3);
    await expect(lifecycle.manualStart(roomId, meta(hostId, key('early'), 'StartRoom', {}))).rejects.toMatchObject({ code: 'START_TOO_EARLY' });
  });

  it('4. auto-start Room đến giờ; 5. manual/auto race chỉ chuyển state và event một lần', async () => {
    const dueRoomId = await createPublishedRoom(3);
    clock.set('2026-10-01T12:00:00.000Z');
    expect(await lifecycle.autoStartDueRooms()).toBe(1);
    const due = await rooms.getRoom(dueRoomId);
    expect(due.room.status).toBe('IN_PROGRESS');
    expect(due.room.startSource).toBe('AUTO');

    const racedRoomId = await createPublishedRoom(3);
    const [manual, auto] = await Promise.all([
      lifecycle.manualStart(racedRoomId, meta(hostId, key('race-manual'), 'StartRoom', {})),
      lifecycle.autoStart(racedRoomId),
    ]);
    expect(manual.body.status).toBe('IN_PROGRESS');
    expect(auto.body.status).toBe('IN_PROGRESS');
    const events = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM event_outbox
       WHERE aggregate_id = $1 AND event_type IN ('ROOM_MANUALLY_STARTED', 'ROOM_AUTO_STARTED')`,
      [racedRoomId],
    );
    expect(Number(events.rows[0]!.count)).toBe(1);
  });

  it('6. no-show trước grace bị reject; 7. sau grace được phép; 8. manual early start không kéo grace sớm', async () => {
    const roomId = await createPublishedRoom(2);
    const participantId = await acceptPlayer(roomId);
    await lifecycle.manualStart(roomId, meta(hostId, key('start'), 'StartRoom', {}));
    clock.set('2026-10-01T11:45:00.000Z');
    await expect(participation.markNoShow(participantId, meta(hostId, key('early-noshow'), 'MarkParticipantNoShow', {}))).rejects.toMatchObject({ code: 'NO_SHOW_TOO_EARLY' });
    clock.set('2026-10-01T12:15:00.000Z');
    const marked = await participation.markNoShow(participantId, meta(hostId, key('noshow'), 'MarkParticipantNoShow', {}));
    expect(marked.body.attendanceStatus).toBe('NO_SHOW');
    expect(marked.body.noShowEligibleAt.toISOString()).toBe('2026-10-01T12:15:00.000Z');
  });

  it('9. PRESENT ↔ NO_SHOW được correction trước completion', async () => {
    const roomId = await createPublishedRoom(2);
    const participantId = await acceptPlayer(roomId);
    await lifecycle.manualStart(roomId, meta(hostId, key('start'), 'StartRoom', {}));
    const present = await participation.markPresent(participantId, meta(hostId, key('present'), 'MarkParticipantPresent', {}));
    expect(present.body.corrected).toBe(false);
    clock.set('2026-10-01T12:15:00.000Z');
    const corrected = await participation.markNoShow(participantId, meta(hostId, key('correct'), 'MarkParticipantNoShow', {}));
    expect(corrected.body.corrected).toBe(true);
    const logs = await db.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM participant_attendance_logs WHERE participant_id = $1', [participantId]);
    expect(Number(logs.rows[0]!.count)).toBe(2);
  });

  it('10. sau COMPLETED attendance không sửa được; 11. COMPLETED không quay lại OPEN/FULL', async () => {
    const roomId = await createPublishedRoom(2);
    const participantId = await acceptPlayer(roomId);
    await lifecycle.manualStart(roomId, meta(hostId, key('start'), 'StartRoom', {}));
    await participation.markPresent(participantId, meta(hostId, key('present'), 'MarkParticipantPresent', {}));
    const completed = await lifecycle.complete(roomId, meta(hostId, key('complete'), 'CompleteRoom', {}));
    expect(completed.body.status).toBe('COMPLETED');
    await expect(participation.markNoShow(participantId, meta(hostId, key('after-complete'), 'MarkParticipantNoShow', {}))).rejects.toMatchObject({ code: 'ROOM_TERMINAL' });
    await expect(lifecycle.manualStart(roomId, meta(hostId, key('restart'), 'StartRoom', {}))).rejects.toMatchObject({ code: 'ROOM_TERMINAL' });
    expect((await rooms.getRoom(roomId)).room.status).toBe('COMPLETED');
  });

  it('12. Start/attendance/complete idempotency và outbox đều atomic', async () => {
    const roomId = await createPublishedRoom(2);
    const participantId = await acceptPlayer(roomId);
    const startMeta = meta(hostId, 'm3-start-idempotency', 'StartRoom', {});
    const first = await lifecycle.manualStart(roomId, startMeta);
    const replay = await lifecycle.manualStart(roomId, startMeta);
    expect(replay.replayed).toBe(true);
    expect(replay.body).toEqual(first.body);
    await participation.markPresent(participantId, meta(hostId, key('present'), 'MarkParticipantPresent', {}));
    await lifecycle.complete(roomId, meta(hostId, key('complete'), 'CompleteRoom', {}));
    const events = await db.query<{ event_type: string }>(
      `SELECT event_type FROM event_outbox WHERE aggregate_id IN ($1, $2) ORDER BY event_type`, [roomId, participantId],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual(expect.arrayContaining([
      'ROOM_MANUALLY_STARTED', 'PLAYER_MARKED_PRESENT', 'ROOM_COMPLETED',
    ]));
    expect(events.rows.filter((row) => row.event_type === 'ROOM_MANUALLY_STARTED')).toHaveLength(1);
  });
});
