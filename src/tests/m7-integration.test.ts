import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Clock } from '../platform/core.js';
import { PostgresDatabase } from '../platform/database/db.js';
import { IdentityService } from '../modules/identity/service.js';
import { PartyRepository } from '../modules/party/repository.js';
import { PartyService } from '../modules/party/service.js';
import { ParticipationRepository } from '../modules/participation/repository.js';
import { ParticipationService } from '../modules/participation/service.js';
import { ReliabilityRepository } from '../modules/reliability/repository.js';
import { ReliabilityService } from '../modules/reliability/service.js';
import { RoomRepository } from '../modules/room/repository.js';
import { RoomService, type CommandMeta } from '../modules/room/service.js';
import { SearchRepository } from '../modules/search/repository.js';
import { SearchService } from '../modules/search/service.js';

const integration = process.env.DATABASE_URL ? describe : describe.skip;
const sportId = '10000000-0000-4000-8000-000000000001';
const hostId = '20000000-0000-4000-8000-000000000001';
const ownerId = '20000000-0000-4000-8000-000000000002';
const friendId = '20000000-0000-4000-8000-000000000003';
const claimantId = '20000000-0000-4000-8000-000000000004';
const soloId = '20000000-0000-4000-8000-000000000005';

class MutableClock implements Clock {
  constructor(public current = new Date('2026-12-01T07:00:00.000Z')) {}
  now(): Date { return new Date(this.current); }
}

const meta = (actorUserId: string, key: string, commandType: string, request: unknown = {}): CommandMeta => ({
  actorUserId,
  idempotency: { key, actorUserId, commandType, request },
});

integration('M7 Party, Friends & Guests (PostgreSQL)', () => {
  let db: PostgresDatabase;
  let clock: MutableClock;
  let rooms: RoomService;
  let participation: ParticipationService;
  let parties: PartyService;
  let partyRepository: PartyRepository;
  let participationRepository: ParticipationRepository;
  let reliability: ReliabilityService;
  let search: SearchService;
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
    participationRepository = new ParticipationRepository();
    partyRepository = new PartyRepository();
    reliability = new ReliabilityService(db, roomRepository, participationRepository, new ReliabilityRepository(), clock);
    rooms = new RoomService(db, roomRepository, clock, participationRepository, reliability);
    participation = new ParticipationService(db, roomRepository, participationRepository, clock, reliability, partyRepository);
    parties = new PartyService(db, partyRepository, clock);
    search = new SearchService(db, new SearchRepository(), new IdentityService(db), clock, undefined, partyRepository);
    await db.query(`TRUNCATE
      reliability_adjustments, participation_cancellations, slot_recovery_records, room_refill_states,
      player_reliability_stats, host_stats, participant_attendance_logs, room_participants,
      room_application_members, room_applications, party_members, parties, friendships,
      room_availability_projections, room_change_logs, room_equipment_options, room_equipment_policies,
      rooms, search_telemetry_events, event_consumptions, event_outbox, idempotency_keys,
      user_sport_profiles, users CASCADE`);
    await db.query(
      `INSERT INTO users (id, phone, display_name, status, home_area, created_at, updated_at) VALUES
       ($1, '0900000001', 'HOST', 'ACTIVE', NULL, NOW(), NOW()),
       ($2, '0900000002', 'Party Owner', 'ACTIVE', NULL, NOW(), NOW()),
       ($3, '0900000003', 'Confirmed Friend', 'ACTIVE', NULL, NOW(), NOW()),
       ($4, '0900000004', 'Guest Claimant', 'ACTIVE', NULL, NOW(), NOW()),
       ($5, '0900000005', 'Solo Player', 'ACTIVE', NULL, NOW(), NOW())`,
      [hostId, ownerId, friendId, claimantId, soloId],
    );
    await db.query(
      `INSERT INTO user_sport_profiles (user_id, sport_id, skill_state, skill_score, created_at, updated_at) VALUES
       ($1, $6, 'RANKED', 6, NOW(), NOW()), ($2, $6, 'RANKED', 5, NOW(), NOW()),
       ($3, $6, 'RANKED', 8, NOW(), NOW()), ($4, $6, 'UNRANKED', NULL, NOW(), NOW()),
       ($5, $6, 'RANKED', 5, NOW(), NOW())`,
      [hostId, ownerId, friendId, claimantId, soloId, sportId],
    );
  });

  afterAll(async () => { await db.close(); });

  const createPublishedRoom = async (input: { capacity?: number; title?: string; startAt?: Date; endAt?: Date; preferredSkill?: { minScore: number | null; maxScore: number | null } | null } = {}): Promise<string> => {
    const startAt = input.startAt ?? new Date('2026-12-01T12:00:00.000Z');
    const created = await rooms.create(meta(hostId, key('create-room'), 'CreateRoom', input), {
      sportCode: 'BADMINTON', title: input.title ?? 'M7 test room', venue: { name: 'Sân M7', latitude: 10.776, longitude: 106.700 },
      scheduledStartAt: startAt, scheduledEndAt: input.endAt ?? new Date(startAt.getTime() + 2 * 60 * 60 * 1000),
      capacity: input.capacity ?? 4, hostParticipates: true, reservedExternalCount: 0,
      priceAmount: null, currency: 'VND', preferredSkill: input.preferredSkill ?? null,
      equipment: { supplyMode: 'PLAYER_BRINGS' }, allowEmergencyReplacement: true,
    });
    await rooms.publish(created.body.roomId, meta(hostId, key('publish-room'), 'PublishRoom', {}));
    return created.body.roomId;
  };

  const createPartyWithConfirmedFriend = async (): Promise<{ partyId: string; friendMemberId: string }> => {
    const friendship = await parties.requestFriendship(friendId, meta(ownerId, key('friend-request'), 'RequestFriendship', { target_user_id: friendId }));
    await parties.acceptFriendship(friendship.body.id, meta(friendId, key('friend-accept'), 'AcceptFriendship', {}));
    const party = await parties.createParty({ sportCode: 'BADMINTON' }, meta(ownerId, key('party-create'), 'CreateParty', {}));
    const invited = await parties.addMember(party.body.party.id, { memberType: 'REGISTERED_USER', userId: friendId }, meta(ownerId, key('party-invite'), 'AddPartyMember', {}));
    await parties.confirmMember(party.body.party.id, invited.body.member.id, meta(friendId, key('party-confirm'), 'ConfirmPartyMember', {}));
    return { partyId: party.body.party.id, friendMemberId: invited.body.member.id };
  };

  const addGuest = async (partyId: string, label = 'Guest seat'): Promise<{ memberId: string; claimToken: string }> => {
    const guest = await parties.addMember(partyId, { memberType: 'GUEST', guestLabel: label }, meta(ownerId, key('guest-add'), 'AddPartyMember', {}));
    expect(guest.body.claimToken).not.toBeNull();
    return { memberId: guest.body.member.id, claimToken: guest.body.claimToken! };
  };

  const createPartyApplication = async (roomId: string, partyId: string, idempotencyKey = key('party-apply')) => participation.createApplication(
    roomId, meta(ownerId, idempotencyKey, 'CreateJoinApplication', { party_id: partyId }), { partyId },
  );

  it('enforces friendship consent and Party READY before application, then freezes the submitted Party snapshot', async () => {
    const party = await parties.createParty({ sportCode: 'BADMINTON' }, meta(ownerId, key('party-create'), 'CreateParty', {}));
    await expect(parties.addMember(party.body.party.id, { memberType: 'REGISTERED_USER', userId: friendId }, meta(ownerId, key('invite-without-friendship'), 'AddPartyMember', {})))
      .rejects.toMatchObject({ code: 'FRIENDSHIP_REQUIRED' });

    const friendship = await parties.requestFriendship(friendId, meta(ownerId, key('friend-request'), 'RequestFriendship', {}));
    await parties.acceptFriendship(friendship.body.id, meta(friendId, key('friend-accept'), 'AcceptFriendship', {}));
    const invited = await parties.addMember(party.body.party.id, { memberType: 'REGISTERED_USER', userId: friendId }, meta(ownerId, key('party-invite'), 'AddPartyMember', {}));
    const roomId = await createPublishedRoom();
    await expect(createPartyApplication(roomId, party.body.party.id)).rejects.toMatchObject({ code: 'PARTY_NOT_READY' });

    await parties.confirmMember(party.body.party.id, invited.body.member.id, meta(friendId, key('party-confirm'), 'ConfirmPartyMember', {}));
    const application = await createPartyApplication(roomId, party.body.party.id);
    expect(application.body).toMatchObject({ status: 'REQUESTED', requestedSlotCount: 2 });
    const snapshot = await participationRepository.getApplicationMembers(db, application.body.applicationId);
    expect(snapshot).toHaveLength(2);
    expect(snapshot.every((member) => member.sourcePartyMemberId !== null)).toBe(true);
    await expect(parties.removeMember(party.body.party.id, invited.body.member.id, meta(ownerId, key('remove-active-member'), 'RemovePartyMember', {})))
      .rejects.toMatchObject({ code: 'PARTY_APPLICATION_ACTIVE' });
  });

  it('accepts a Party all-or-none, with no partial participants and one idempotent outbox result', async () => {
    const { partyId } = await createPartyWithConfirmedFriend();
    await addGuest(partyId);
    const roomId = await createPublishedRoom({ capacity: 4 });
    const application = await createPartyApplication(roomId, partyId, 'party-application-idempotency');
    const acceptMeta = meta(hostId, 'party-accept-idempotency', 'AcceptJoinApplication', {});
    const accepted = await participation.acceptApplication(application.body.applicationId, acceptMeta);
    const replay = await participation.acceptApplication(application.body.applicationId, acceptMeta);

    expect(accepted.body).toMatchObject({ status: 'ACCEPTED', participantIds: expect.any(Array), roomStatus: 'FULL', availablePublicSlots: 0 });
    expect(accepted.body.participantIds).toHaveLength(3);
    expect(replay.replayed).toBe(true);
    expect(replay.body).toEqual(accepted.body);
    expect(await participationRepository.countActiveParticipants(db, roomId)).toBe(3);
    const acceptedEvents = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM event_outbox WHERE aggregate_id = $1 AND event_type = 'JOIN_REQUEST_ACCEPTED'`, [application.body.applicationId],
    );
    expect(Number(acceptedEvents.rows[0]?.count ?? 0)).toBe(1);
  });

  it('rejects Party acceptance atomically when any registered member has an accepted overlapping Room', async () => {
    const { partyId } = await createPartyWithConfirmedFriend();
    const blockerId = await createPublishedRoom({ capacity: 3, title: 'Friend blocker' });
    const blocker = await participation.createApplication(blockerId, meta(friendId, key('friend-blocker-apply'), 'CreateJoinApplication', {}), {});
    await participation.acceptApplication(blocker.body.applicationId, meta(hostId, key('friend-blocker-accept'), 'AcceptJoinApplication', {}));

    const targetId = await createPublishedRoom({ capacity: 4, title: 'Party conflict target' });
    const application = await createPartyApplication(targetId, partyId);
    await expect(participation.acceptApplication(application.body.applicationId, meta(hostId, key('party-conflict-accept'), 'AcceptJoinApplication', {})))
      .rejects.toMatchObject({ code: 'SCHEDULE_CONFLICT' });
    expect(await participationRepository.countActiveParticipants(db, targetId)).toBe(0);
    expect((await participationRepository.findApplication(db, application.body.applicationId))?.status).toBe('REQUESTED');
  });

  it('handles a last-slot race as Party-all-or-none: Party gets every seat or none', async () => {
    const { partyId } = await createPartyWithConfirmedFriend();
    const roomId = await createPublishedRoom({ capacity: 3 });
    const partyApplication = await createPartyApplication(roomId, partyId);
    const soloApplication = await participation.createApplication(roomId, meta(soloId, key('solo-apply'), 'CreateJoinApplication', {}), {});
    const results = await Promise.allSettled([
      participation.acceptApplication(partyApplication.body.applicationId, meta(hostId, key('party-race-accept'), 'AcceptJoinApplication', {})),
      participation.acceptApplication(soloApplication.body.applicationId, meta(hostId, key('solo-race-accept'), 'AcceptJoinApplication', {})),
    ]);
    const active = await participationRepository.countActiveParticipants(db, roomId);
    const partyStatus = (await participationRepository.findApplication(db, partyApplication.body.applicationId))?.status;
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    if (partyStatus === 'ACCEPTED') expect(active).toBe(2);
    else {
      expect(partyStatus).toBe('REQUESTED');
      expect(active).toBe(1);
    }
  });

  it('claims a Guest seat in place without mutating capacity or creating another participant', async () => {
    const { partyId } = await createPartyWithConfirmedFriend();
    const guest = await addGuest(partyId, 'Claimable guest');
    const roomId = await createPublishedRoom({ capacity: 4 });
    const application = await createPartyApplication(roomId, partyId);
    await participation.acceptApplication(application.body.applicationId, meta(hostId, key('accept-guest-party'), 'AcceptJoinApplication', {}));
    const before = await rooms.getRoom(roomId);
    const countBefore = await participationRepository.countActiveParticipants(db, roomId);

    const claim = await parties.claimGuest(guest.claimToken, claimantId, meta(claimantId, key('claim-guest'), 'ClaimPartyGuest', {}));
    const after = await rooms.getRoom(roomId);
    const claimed = await db.query<{ user_id: string; member_type: string }>(
      `SELECT p.user_id, p.member_type FROM room_participants p
       JOIN room_application_members m ON m.id = p.application_member_id
       WHERE m.source_party_member_id = $1`, [guest.memberId],
    );
    expect(claim.body).toMatchObject({ partyId, partyMemberId: guest.memberId, claimedUserId: claimantId });
    expect(after.availability).toEqual(before.availability);
    expect(await participationRepository.countActiveParticipants(db, roomId)).toBe(countBefore);
    expect(claimed.rows).toEqual([{ user_id: claimantId, member_type: 'USER' }]);
  });

  it('owner cancellation releases only unclaimed Guest seats, preserving accepted registered friends', async () => {
    const { partyId } = await createPartyWithConfirmedFriend();
    await addGuest(partyId, 'Owner-linked guest');
    const roomId = await createPublishedRoom({ capacity: 4 });
    const application = await createPartyApplication(roomId, partyId);
    const accepted = await participation.acceptApplication(application.body.applicationId, meta(hostId, key('accept-owner-cancel-party'), 'AcceptJoinApplication', {}));
    const rows = await db.query<{ id: string; user_id: string | null; member_type: string }>(
      `SELECT id, user_id, member_type FROM room_participants WHERE application_id = $1 ORDER BY id`, [application.body.applicationId],
    );
    const ownerParticipant = rows.rows.find((row) => row.user_id === ownerId);
    const friendParticipant = rows.rows.find((row) => row.user_id === friendId);
    const guestParticipant = rows.rows.find((row) => row.member_type === 'GUEST');
    expect(ownerParticipant && friendParticipant && guestParticipant).toBeTruthy();

    const cancelled = await reliability.cancelParticipant(ownerParticipant!.id, meta(ownerId, key('owner-cancel'), 'CancelParticipant', {}), { reasonCode: 'PLANS_CHANGED' });
    const statuses = await db.query<{ id: string; status: string }>(`SELECT id, status FROM room_participants WHERE application_id = $1`, [application.body.applicationId]);
    const statusById = new Map(statuses.rows.map((row) => [row.id, row.status]));
    expect(cancelled.body).toMatchObject({ status: 'CANCELLED', availablePublicSlots: 2 });
    expect(statusById.get(ownerParticipant!.id)).toBe('CANCELLED');
    expect(statusById.get(guestParticipant!.id)).toBe('CANCELLED');
    expect(statusById.get(friendParticipant!.id)).toBe('ACTIVE');
    expect(await participationRepository.countActiveParticipants(db, roomId)).toBe(1);
    expect(accepted.body.participantIds).toHaveLength(3);
  });

  it('Party-aware search requires group capacity, excludes any member conflict, and exposes only soft aggregate skill signals', async () => {
    const { partyId } = await createPartyWithConfirmedFriend();
    await addGuest(partyId, 'Search guest');
    const exactCapacityRoom = await createPublishedRoom({ capacity: 4, title: 'Exactly three seats', preferredSkill: { minScore: 6, maxScore: 7 } });
    await createPublishedRoom({ capacity: 3, title: 'Only two seats', preferredSkill: { minScore: 6, maxScore: 7 } });
    const initial = await search.search({ actorUserId: ownerId, sportCode: 'BADMINTON', partyId });
    expect(initial.data.map((card) => card.roomId)).toEqual([exactCapacityRoom]);
    expect(initial.data[0]).toMatchObject({ requiredSlots: 3 });
    expect(initial.data[0]?.badges).toEqual(expect.arrayContaining(['PARTY_EXACT_CAPACITY', 'PARTY_MEMBER_SKILL_MISMATCH', 'PARTY_HAS_UNRANKED_OR_GUEST']));
    expect(JSON.stringify(initial.data[0])).not.toContain('score');

    const blockerId = await createPublishedRoom({ capacity: 3, title: 'Search conflict blocker' });
    const blocker = await participation.createApplication(blockerId, meta(friendId, key('search-blocker-apply'), 'CreateJoinApplication', {}), {});
    await participation.acceptApplication(blocker.body.applicationId, meta(hostId, key('search-blocker-accept'), 'AcceptJoinApplication', {}));
    const filtered = await search.search({ actorUserId: ownerId, sportCode: 'BADMINTON', partyId });
    expect(filtered.data).toHaveLength(0);
  });
});
