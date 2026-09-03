import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DomainError } from '../platform/core.js';
import { PostgresDatabase } from '../platform/database/db.js';
import { ParticipationRepository } from '../modules/participation/repository.js';
import { ParticipationService } from '../modules/participation/service.js';
import { RoomRepository } from '../modules/room/repository.js';
import { RoomService, type CommandMeta } from '../modules/room/service.js';

const integration = process.env.DATABASE_URL ? describe : describe.skip;
const sportId = '10000000-0000-4000-8000-000000000001';
const hostId = '20000000-0000-4000-8000-000000000001';
const playerOneId = '20000000-0000-4000-8000-000000000002';
const playerTwoId = '20000000-0000-4000-8000-000000000003';

const meta = (actorUserId: string, key: string, commandType: string, request: unknown = {}): CommandMeta => ({
  actorUserId,
  idempotency: { key, actorUserId, commandType, request },
});

integration('M2 Join Application + HOST Approval (PostgreSQL)', () => {
  let db: PostgresDatabase;
  let rooms: RoomService;
  let participation: ParticipationService;
  let roomRepository: RoomRepository;
  let participationRepository: ParticipationRepository;
  let sequence = 0;

  const key = (label: string): string => `${label}-${++sequence}`;

  beforeAll(async () => {
    db = new PostgresDatabase();
    roomRepository = new RoomRepository();
    participationRepository = new ParticipationRepository();
    rooms = new RoomService(db, roomRepository, undefined, participationRepository);
    participation = new ParticipationService(db, roomRepository, participationRepository);
    await db.query('SELECT 1');
  });

  beforeEach(async () => {
    sequence = 0;
    await db.query('TRUNCATE room_participants, room_application_members, room_applications, room_availability_projections, room_change_logs, room_equipment_options, room_equipment_policies, rooms, event_consumptions, event_outbox, idempotency_keys, user_sport_profiles, users CASCADE');
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

  afterAll(async () => {
    await db.close();
  });

  const createPublishedRoom = async (capacity = 2): Promise<string> => {
    const created = await rooms.create(meta(hostId, key('create-room'), 'CreateRoom', { capacity }), {
      sportCode: 'BADMINTON', title: 'M2 test room', venue: { name: 'Sân M2' },
      scheduledStartAt: new Date('2026-10-01T12:00:00.000Z'), scheduledEndAt: new Date('2026-10-01T14:00:00.000Z'),
      capacity, hostParticipates: true, reservedExternalCount: 0, priceAmount: null, currency: 'VND',
      preferredSkill: null, equipment: { supplyMode: 'PLAYER_BRINGS' }, allowEmergencyReplacement: true,
    });
    await rooms.publish(created.body.roomId, meta(hostId, key('publish-room'), 'PublishRoom', {}));
    return created.body.roomId;
  };

  const request = (roomId: string, playerId: string, suffix: string) => participation.createApplication(
    roomId, meta(playerId, key(`request-${suffix}`), 'CreateJoinApplication', {}), {},
  );

  it('1. REQUESTED không làm giảm slot', async () => {
    const roomId = await createPublishedRoom();
    await request(roomId, playerOneId, 'one');
    expect((await rooms.getRoom(roomId)).availability.availablePublicSlots).toBe(1);
  });

  it('2. ACCEPTED giảm đúng một slot; 3. last slot chuyển OPEN sang FULL', async () => {
    const roomId = await createPublishedRoom();
    const application = await request(roomId, playerOneId, 'one');
    const accepted = await participation.acceptApplication(application.body.applicationId, meta(hostId, key('accept'), 'AcceptJoinApplication', {}));
    expect(accepted.body.availablePublicSlots).toBe(0);
    expect(accepted.body.roomStatus).toBe('FULL');
    expect((await rooms.getRoom(roomId)).availability.occupiedSlots).toBe(2);
  });

  it('4. HOST remove participant mở lại FULL sang OPEN', async () => {
    const roomId = await createPublishedRoom();
    const application = await request(roomId, playerOneId, 'one');
    const accepted = await participation.acceptApplication(application.body.applicationId, meta(hostId, key('accept'), 'AcceptJoinApplication', {}));
    const removed = await participation.removeParticipantByHost(accepted.body.participantIds[0]!, meta(hostId, key('remove'), 'RemoveParticipantByHost', {}));
    expect(removed.body.roomStatus).toBe('OPEN');
    expect(removed.body.availablePublicSlots).toBe(1);
  });

  it('5. hai accept cạnh tranh last slot: chỉ một thành công', async () => {
    const roomId = await createPublishedRoom();
    const first = await request(roomId, playerOneId, 'one');
    const second = await request(roomId, playerTwoId, 'two');
    const results = await Promise.allSettled([
      participation.acceptApplication(first.body.applicationId, meta(hostId, key('accept-one'), 'AcceptJoinApplication', {})),
      participation.acceptApplication(second.body.applicationId, meta(hostId, key('accept-two'), 'AcceptJoinApplication', {})),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') expect((rejected.reason as DomainError).code).toBe('INSUFFICIENT_CAPACITY');
    expect(await participationRepository.countActiveParticipants(db, roomId)).toBe(1);
  });

  it('6. chặn duplicate active application', async () => {
    const roomId = await createPublishedRoom();
    await request(roomId, playerOneId, 'one');
    await expect(request(roomId, playerOneId, 'duplicate')).rejects.toMatchObject({ code: 'APPLICATION_ALREADY_EXISTS' });
  });

  it('7. non-HOST không accept hoặc reject', async () => {
    const roomId = await createPublishedRoom();
    const application = await request(roomId, playerOneId, 'one');
    await expect(participation.acceptApplication(application.body.applicationId, meta(playerTwoId, key('non-host-accept'), 'AcceptJoinApplication', {}))).rejects.toMatchObject({ code: 'NOT_ROOM_HOST' });
    await expect(participation.rejectApplication(application.body.applicationId, meta(playerTwoId, key('non-host-reject'), 'RejectJoinApplication', {}))).rejects.toMatchObject({ code: 'NOT_ROOM_HOST' });
  });

  it('8. withdraw REQUESTED không penalty và không ảnh hưởng capacity', async () => {
    const roomId = await createPublishedRoom();
    const application = await request(roomId, playerOneId, 'one');
    await participation.withdrawApplication(application.body.applicationId, meta(playerOneId, key('withdraw'), 'WithdrawJoinApplication', {}));
    expect((await rooms.getRoom(roomId)).availability.availablePublicSlots).toBe(1);
    const row = await participationRepository.findApplication(db, application.body.applicationId);
    expect(row?.status).toBe('WITHDRAWN');
    expect(row?.rejectionReasonCode).toBeNull();
  });

  it('Accept tự withdraw các pending application trùng lịch của player được nhận', async () => {
    const acceptedRoomId = await createPublishedRoom();
    const pendingRoomId = await createPublishedRoom();
    const acceptedApplication = await request(acceptedRoomId, playerOneId, 'accepted');
    const pendingApplication = await request(pendingRoomId, playerOneId, 'pending');
    await participation.acceptApplication(acceptedApplication.body.applicationId, meta(hostId, key('accept-overlap'), 'AcceptJoinApplication', {}));
    expect((await participationRepository.findApplication(db, pendingApplication.body.applicationId))?.status).toBe('WITHDRAWN');
  });

  it('9. Accept idempotency replay không tạo participant hoặc event trùng; 10. outbox event atomic với Accept', async () => {
    const roomId = await createPublishedRoom();
    const application = await request(roomId, playerOneId, 'one');
    const acceptMeta = meta(hostId, 'accept-idempotent-key', 'AcceptJoinApplication', {});
    const first = await participation.acceptApplication(application.body.applicationId, acceptMeta);
    const replay = await participation.acceptApplication(application.body.applicationId, acceptMeta);
    expect(replay.replayed).toBe(true);
    expect(replay.body).toEqual(first.body);
    expect(await participationRepository.countActiveParticipants(db, roomId)).toBe(1);
    const events = await db.query<{ event_type: string }>(
      `SELECT event_type FROM event_outbox WHERE aggregate_id = $1 ORDER BY occurred_at`, [application.body.applicationId],
    );
    expect(events.rows.map((event) => event.event_type)).toContain('JOIN_REQUEST_ACCEPTED');
    expect(events.rows.filter((event) => event.event_type === 'JOIN_REQUEST_ACCEPTED')).toHaveLength(1);
  });
});
