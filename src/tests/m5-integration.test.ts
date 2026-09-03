import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Clock } from '../platform/core.js';
import { PostgresDatabase } from '../platform/database/db.js';
import { ParticipationRepository } from '../modules/participation/repository.js';
import { ParticipationService } from '../modules/participation/service.js';
import { ReliabilityRepository } from '../modules/reliability/repository.js';
import { ReliabilityService } from '../modules/reliability/service.js';
import { RoomLifecycleService } from '../modules/room/lifecycle-service.js';
import { RoomRepository } from '../modules/room/repository.js';
import { RoomService, type CommandMeta } from '../modules/room/service.js';

const integration = process.env.DATABASE_URL ? describe : describe.skip;
const sportId = '10000000-0000-4000-8000-000000000001';
const hostId = '20000000-0000-4000-8000-000000000001';
const playerOneId = '20000000-0000-4000-8000-000000000002';
const playerTwoId = '20000000-0000-4000-8000-000000000003';
const playerThreeId = '20000000-0000-4000-8000-000000000004';

class MutableClock implements Clock {
  constructor(public current = new Date('2026-11-01T07:00:00.000Z')) {}
  now(): Date { return new Date(this.current); }
  set(iso: string): void { this.current = new Date(iso); }
}

const meta = (actorUserId: string, key: string, commandType: string, request: unknown = {}): CommandMeta => ({
  actorUserId,
  idempotency: { key, actorUserId, commandType, request },
});

integration('M5 Reliability + HOST Protection (PostgreSQL)', () => {
  let db: PostgresDatabase;
  let roomRepository: RoomRepository;
  let participationRepository: ParticipationRepository;
  let reliabilityRepository: ReliabilityRepository;
  let reliability: ReliabilityService;
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
    reliabilityRepository = new ReliabilityRepository();
    await db.query('SELECT 1');
  });

  beforeEach(async () => {
    sequence = 0;
    clock = new MutableClock();
    reliability = new ReliabilityService(db, roomRepository, participationRepository, reliabilityRepository, clock);
    rooms = new RoomService(db, roomRepository, clock, participationRepository, reliability);
    participation = new ParticipationService(db, roomRepository, participationRepository, clock, reliability);
    lifecycle = new RoomLifecycleService(db, roomRepository, participationRepository, undefined, clock, reliability);
    await db.query(`TRUNCATE
      reliability_adjustments, participation_cancellations, slot_recovery_records, room_refill_states,
      player_reliability_stats, host_stats, participant_attendance_logs, room_participants,
      room_application_members, room_applications, room_availability_projections, room_change_logs,
      room_equipment_options, room_equipment_policies, rooms, search_telemetry_events,
      event_consumptions, event_outbox, idempotency_keys, user_sport_profiles, users CASCADE`);
    await db.query(
      `INSERT INTO users (id, phone, display_name, status, created_at, updated_at) VALUES
       ($1, '0900000001', 'HOST', 'ACTIVE', NOW(), NOW()),
       ($2, '0900000002', 'Player One', 'ACTIVE', NOW(), NOW()),
       ($3, '0900000003', 'Player Two', 'ACTIVE', NOW(), NOW()),
       ($4, '0900000004', 'Player Three', 'ACTIVE', NOW(), NOW())`,
      [hostId, playerOneId, playerTwoId, playerThreeId],
    );
    await db.query(
      `INSERT INTO user_sport_profiles (user_id, sport_id, skill_state, skill_score, created_at, updated_at) VALUES
       ($1, $5, 'RANKED', 5, NOW(), NOW()), ($2, $5, 'RANKED', 5, NOW(), NOW()),
       ($3, $5, 'RANKED', 4, NOW(), NOW()), ($4, $5, 'RANKED', 6, NOW(), NOW())`,
      [hostId, playerOneId, playerTwoId, playerThreeId, sportId],
    );
  });

  afterAll(async () => { await db.close(); });

  const createPublishedRoom = async (capacity = 2, input: { startAt?: Date; allowEmergencyReplacement?: boolean } = {}): Promise<string> => {
    const scheduledStartAt = input.startAt ?? new Date('2026-11-01T12:00:00.000Z');
    const created = await rooms.create(meta(hostId, key('create'), 'CreateRoom', { capacity }), {
      sportCode: 'BADMINTON', title: 'M5 reliability room', venue: { name: 'Sân M5', latitude: 10.776, longitude: 106.700 },
      scheduledStartAt, scheduledEndAt: new Date(scheduledStartAt.getTime() + 2 * 60 * 60 * 1000),
      capacity, hostParticipates: true, reservedExternalCount: 0, priceAmount: null, currency: 'VND',
      preferredSkill: { minScore: 3, maxScore: 7 }, equipment: { supplyMode: 'PLAYER_BRINGS' },
      allowEmergencyReplacement: input.allowEmergencyReplacement ?? true,
    });
    await rooms.publish(created.body.roomId, meta(hostId, key('publish'), 'PublishRoom', {}));
    return created.body.roomId;
  };

  const requestAndAccept = async (roomId: string, userId = playerOneId): Promise<string> => {
    const application = await participation.createApplication(roomId, meta(userId, key('request'), 'CreateJoinApplication', {}), {});
    const accepted = await participation.acceptApplication(application.body.applicationId, meta(hostId, key('accept'), 'AcceptJoinApplication', {}));
    return accepted.body.participantIds[0]!;
  };

  it('classifies early cancellation without penalty and reopens a full Room canonically', async () => {
    const roomId = await createPublishedRoom(2);
    const participantId = await requestAndAccept(roomId);
    const cancelled = await reliability.cancelParticipant(participantId, meta(playerOneId, key('early-cancel'), 'CancelParticipant', {}), { reasonCode: 'PLANS_CHANGED' });

    expect(cancelled.body).toMatchObject({ status: 'CANCELLED', classification: 'EARLY', reliabilityImpact: false, roomStatus: 'OPEN', availablePublicSlots: 1 });
    expect((await reliability.getReliabilityProfile(playerOneId, playerOneId)).score).toBe(100);
    const fact = await db.query<{ classification: string; penalty_applicable: boolean }>('SELECT classification, penalty_applicable FROM participation_cancellations WHERE room_participant_id = $1', [participantId]);
    expect(fact.rows[0]).toMatchObject({ classification: 'EARLY', penalty_applicable: false });
  });

  it('applies one -5 late-cancel adjustment under idempotent replay and activates refill', async () => {
    const roomId = await createPublishedRoom(2);
    const participantId = await requestAndAccept(roomId);
    clock.set('2026-11-01T09:00:00.000Z');
    const command = meta(playerOneId, 'm5-late-idempotency', 'CancelParticipant', { reason_code: 'LATE' });
    const first = await reliability.cancelParticipant(participantId, command, { reasonCode: 'LATE' });
    const replay = await reliability.cancelParticipant(participantId, command, { reasonCode: 'LATE' });

    expect(first.body).toMatchObject({ classification: 'LATE', reliabilityImpact: true, roomStatus: 'OPEN' });
    expect(replay.replayed).toBe(true);
    expect((await reliability.getReliabilityProfile(playerOneId, playerOneId)).score).toBe(95);
    expect((await reliability.getRefill(roomId, hostId)).active).toBe(true);
    const adjustments = await db.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM reliability_adjustments WHERE user_id = $1 AND reason = $2', [playerOneId, 'LATE_CANCEL']);
    expect(Number(adjustments.rows[0]!.count)).toBe(1);
  });

  it('uses a material-change waiver before scheduled start with no reliability penalty', async () => {
    const roomId = await createPublishedRoom(2);
    const participantId = await requestAndAccept(roomId);
    await rooms.update(roomId, meta(hostId, key('material-update'), 'UpdateRoom', { venue_name: 'Sân mới' }), {
      expectedVersion: undefined, title: undefined, venue: { name: 'Sân mới', latitude: 10.777, longitude: 106.701 },
      scheduledStartAt: undefined, scheduledEndAt: undefined, priceAmount: undefined, preferredSkill: undefined,
      equipment: undefined, reservedExternalCount: undefined, allowEmergencyReplacement: undefined,
    });
    const cancelled = await reliability.cancelParticipant(participantId, meta(playerOneId, key('waiver'), 'CancelParticipant', {}), {});
    expect(cancelled.body).toMatchObject({ classification: 'MATERIAL_CHANGE_WAIVER', reliabilityImpact: false });
    expect((await reliability.getReliabilityProfile(playerOneId, playerOneId)).score).toBe(100);
  });

  it('turns a no-show into penalty/loss then compensates audit, score, stats and refill when corrected to present', async () => {
    const roomId = await createPublishedRoom(2);
    const participantId = await requestAndAccept(roomId);
    clock.set('2026-11-01T11:30:00.000Z');
    await lifecycle.manualStart(roomId, meta(hostId, key('start'), 'StartRoom', {}));
    clock.set('2026-11-01T12:15:00.000Z');
    await participation.markNoShow(participantId, meta(hostId, key('no-show'), 'MarkParticipantNoShow', {}));
    expect((await reliability.getReliabilityProfile(playerOneId, playerOneId)).score).toBe(85);
    expect((await reliability.getRefill(roomId, hostId)).active).toBe(true);

    await participation.markPresent(participantId, meta(hostId, key('correct-present'), 'MarkParticipantPresent', {}));
    const profile = await reliability.getReliabilityProfile(playerOneId, playerOneId);
    expect(profile).toMatchObject({ score: 100, noShows: 0 });
    const loss = await db.query<{ voided_at: Date | null }>('SELECT voided_at FROM slot_recovery_records WHERE room_id = $1', [roomId]);
    expect(loss.rows[0]?.voided_at).not.toBeNull();
  });

  it('shows waitlist candidates without consuming capacity and recovers the oldest loss only after HOST accepts replacement', async () => {
    const roomId = await createPublishedRoom(2);
    const participantOneId = await requestAndAccept(roomId, playerOneId);
    const waitlisted = await participation.createApplication(roomId, meta(playerTwoId, key('waitlist-request'), 'CreateJoinApplication', {}), { allowWaitlistIfFull: true });
    expect(waitlisted.body.status).toBe('WAITLISTED');
    clock.set('2026-11-01T09:00:00.000Z');
    await reliability.cancelParticipant(participantOneId, meta(playerOneId, key('late-cancel'), 'CancelParticipant', {}), {});
    const candidates = await reliability.getWaitlist(roomId, hostId);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ applicationId: waitlisted.body.applicationId, currentlyFitsCapacity: true });

    const accepted = await participation.acceptApplication(waitlisted.body.applicationId, meta(hostId, key('accept-replacement'), 'AcceptJoinApplication', {}));
    expect(accepted.body.roomStatus).toBe('FULL');
    const recovery = await db.query<{ recovered: boolean; recovery_seconds: number | null }>('SELECT recovered, recovery_seconds FROM slot_recovery_records WHERE room_id = $1', [roomId]);
    expect(recovery.rows[0]).toMatchObject({ recovered: true });
    expect(recovery.rows[0]!.recovery_seconds).toBeGreaterThanOrEqual(0);
  });

  it('cascades host Room cancellation fairly: close pending/accepted records with no player penalty and stop refill', async () => {
    const roomId = await createPublishedRoom(3);
    const participantId = await requestAndAccept(roomId, playerOneId);
    await participation.createApplication(roomId, meta(playerTwoId, key('pending'), 'CreateJoinApplication', {}), {});
    await rooms.cancel(roomId, meta(hostId, key('room-cancel'), 'CancelRoom', { reason_code: 'WEATHER' }), undefined, 'WEATHER');

    expect((await rooms.getRoom(roomId)).room.status).toBe('CANCELLED');
    const participant = await db.query<{ status: string }>('SELECT status FROM room_participants WHERE id = $1', [participantId]);
    expect(participant.rows[0]?.status).toBe('CANCELLED');
    const cancelled = await db.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM participation_cancellations WHERE classification = $1', ['ROOM_CANCELLED']);
    expect(Number(cancelled.rows[0]!.count)).toBe(1);
    expect((await reliability.getReliabilityProfile(playerOneId, playerOneId)).score).toBe(100);
  });

  it('recovers +1 exactly after five completed present matches following a penalty', async () => {
    await db.transaction(async (tx) => {
      await reliabilityRepository.applyPlayerAdjustment(tx, {
        id: '30000000-0000-4000-8000-000000000001', userId: playerThreeId,
        sourceEventId: '40000000-0000-4000-8000-000000000001', adjustment: -5, reason: 'LATE_CANCEL', now: clock.now(),
      });
      for (let index = 0; index < 5; index += 1) {
        await reliabilityRepository.recordPresentCompletion(tx, {
          userId: playerThreeId, sourceEventId: `50000000-0000-4000-8000-00000000000${index + 1}`,
          adjustmentId: `60000000-0000-4000-8000-00000000000${index + 1}`, now: clock.now(),
        });
      }
    });
    const profile = await reliability.getReliabilityProfile(playerThreeId, playerThreeId);
    expect(profile).toMatchObject({ score: 96, completedMatches: 5 });
  });
});
