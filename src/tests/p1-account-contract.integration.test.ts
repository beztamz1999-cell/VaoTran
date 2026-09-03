import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresDatabase } from '../platform/database/db.js';
import { ParticipationRepository } from '../modules/participation/repository.js';
import { ParticipationService } from '../modules/participation/service.js';
import { RoomRepository } from '../modules/room/repository.js';
import { RoomService, type CommandMeta } from '../modules/room/service.js';

const integration = process.env.DATABASE_URL ? describe : describe.skip;
const sportId = '10000000-0000-4000-8000-000000000001';
const hostId = '29000000-0000-4000-8000-000000000001';
const otherHostId = '29000000-0000-4000-8000-000000000002';
const playerId = '29000000-0000-4000-8000-000000000003';

const meta = (actorUserId: string, key: string, commandType: string): CommandMeta => ({
  actorUserId, idempotency: { key, actorUserId, commandType, request: {} },
});

integration('P1 account and room-detail projections (PostgreSQL)', () => {
  let db: PostgresDatabase;
  let rooms: RoomService;
  let participation: ParticipationService;
  let sequence = 0;
  const key = (label: string) => `${label}-${++sequence}`;

  beforeAll(async () => {
    db = new PostgresDatabase();
    const roomRepository = new RoomRepository();
    const participationRepository = new ParticipationRepository();
    rooms = new RoomService(db, roomRepository, undefined, participationRepository);
    participation = new ParticipationService(db, roomRepository, participationRepository);
    await db.query('SELECT 1');
  });

  beforeEach(async () => {
    sequence = 0;
    await db.query('TRUNCATE room_participants, room_application_members, room_applications, room_availability_projections, room_change_logs, room_equipment_options, room_equipment_policies, rooms, event_consumptions, event_outbox, idempotency_keys, user_sport_profiles, users CASCADE');
    await db.query(
      `INSERT INTO users (id, phone, display_name, status, created_at, updated_at) VALUES
       ($1, '0920000001', 'Host', 'ACTIVE', NOW(), NOW()),
       ($2, '0920000002', 'Other host', 'ACTIVE', NOW(), NOW()),
       ($3, '0920000003', 'Player', 'ACTIVE', NOW(), NOW())`, [hostId, otherHostId, playerId],
    );
    await db.query(
      `INSERT INTO user_sport_profiles (user_id, sport_id, skill_state, created_at, updated_at) VALUES
       ($1, $4, 'UNRANKED', NOW(), NOW()), ($2, $4, 'UNRANKED', NOW(), NOW()), ($3, $4, 'UNRANKED', NOW(), NOW())`,
      [hostId, otherHostId, playerId, sportId],
    );
  });

  afterAll(async () => { await db.close(); });

  const createPublishedRoom = async (hostUserId: string, title: string) => {
    const created = await rooms.create(meta(hostUserId, key('create'), 'CreateRoom'), {
      sportCode: 'BADMINTON', title, venue: { name: 'P1 venue' },
      scheduledStartAt: new Date('2026-12-01T12:00:00.000Z'), scheduledEndAt: new Date('2026-12-01T14:00:00.000Z'),
      capacity: 2, hostParticipates: true, reservedExternalCount: 0, priceAmount: null, currency: 'VND',
      preferredSkill: null, equipment: { supplyMode: 'PLAYER_BRINGS' }, allowEmergencyReplacement: true,
    });
    await rooms.publish(created.body.roomId, meta(hostUserId, key('publish'), 'PublishRoom'));
    return created.body.roomId;
  };

  it('exposes only owned hosting rooms, with authoritative availability and state counts', async () => {
    const hostedRoomId = await createPublishedRoom(hostId, 'My room');
    await createPublishedRoom(otherHostId, 'Other room');
    const application = await participation.createApplication(hostedRoomId, meta(playerId, key('request'), 'CreateJoinApplication'), {});

    let mine = await participation.listMyMatches(hostId);
    expect(mine.hosting).toEqual([expect.objectContaining({ roomId: hostedRoomId, roomStatus: 'OPEN', availablePublicSlots: 1, acceptedParticipantCount: 0, pendingApplicationCount: 1 })]);
    expect((await participation.listMyMatches(otherHostId)).hosting).toHaveLength(1);

    await participation.acceptApplication(application.body.applicationId, meta(hostId, key('accept'), 'AcceptJoinApplication'));
    mine = await participation.listMyMatches(hostId);
    expect(mine.hosting[0]).toEqual(expect.objectContaining({ roomStatus: 'FULL', availablePublicSlots: 0, acceptedParticipantCount: 1, pendingApplicationCount: 0 }));
  });

  it('returns a viewer application before acceptance and participant after acceptance', async () => {
    const roomId = await createPublishedRoom(hostId, 'Viewer context');
    const application = await participation.createApplication(roomId, meta(playerId, key('request'), 'CreateJoinApplication'), {});
    expect((await participation.getViewerContext(roomId, playerId)).application).toMatchObject({ id: application.body.applicationId, status: 'REQUESTED' });
    expect((await participation.getViewerContext(roomId, playerId)).participant).toBeNull();

    await participation.acceptApplication(application.body.applicationId, meta(hostId, key('accept'), 'AcceptJoinApplication'));
    const context = await participation.getViewerContext(roomId, playerId);
    expect(context.application).toMatchObject({ status: 'ACCEPTED' });
    expect(context.participant).toMatchObject({ status: 'ACTIVE', attendanceStatus: 'NOT_SET' });
  });
});
