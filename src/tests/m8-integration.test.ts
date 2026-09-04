import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Clock } from '../platform/core.js';
import { PostgresDatabase } from '../platform/database/db.js';
import { appendOutboxEvent, makeDomainEvent, PostgresOutboxWorker } from '../platform/outbox/outbox.js';
import { IdentityService } from '../modules/identity/service.js';
import { NotificationReminderScheduler } from '../modules/notification/reminder-scheduler.js';
import { NotificationRepository } from '../modules/notification/repository.js';
import { NotificationConsumer, NotificationService, PushDeliveryWorker, type PushGateway, type PushMessage } from '../modules/notification/service.js';
import { ParticipationRepository } from '../modules/participation/repository.js';
import { ParticipationService } from '../modules/participation/service.js';
import { RoomLifecycleService } from '../modules/room/lifecycle-service.js';
import { RoomRepository } from '../modules/room/repository.js';
import { RoomService, type CommandMeta } from '../modules/room/service.js';

const integration = process.env.DATABASE_URL ? describe : describe.skip;
const sportId = '10000000-0000-4000-8000-000000000001';
const hostId = '20000000-0000-4000-8000-000000000001';
const playerId = '20000000-0000-4000-8000-000000000002';

class MutableClock implements Clock {
  constructor(public current = new Date('2026-12-01T07:00:00.000Z')) {}
  now(): Date { return new Date(this.current); }
}

class FailingPushGateway implements PushGateway {
  async send(_message: PushMessage): Promise<void> { throw new Error('provider unavailable'); }
}

const meta = (actorUserId: string, key: string, commandType: string, request: unknown = {}): CommandMeta => ({
  actorUserId,
  idempotency: { key, actorUserId, commandType, request },
});

integration('M8 Share, Notifications & Repeat Room (PostgreSQL)', () => {
  let db: PostgresDatabase;
  let clock: MutableClock;
  let rooms: RoomService;
  let participation: ParticipationService;
  let lifecycle: RoomLifecycleService;
  let notifications: NotificationService;
  let notificationRepository: NotificationRepository;
  let consumer: NotificationConsumer;
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
    lifecycle = new RoomLifecycleService(db, roomRepository, participationRepository, undefined, clock);
    notificationRepository = new NotificationRepository();
    notifications = new NotificationService(db, notificationRepository, clock);
    consumer = new NotificationConsumer(db, notificationRepository, clock);
    await db.query(`TRUNCATE
      push_deliveries, push_devices, notifications, notification_preferences,
      reliability_adjustments, participation_cancellations, slot_recovery_records, room_refill_states,
      player_reliability_stats, host_stats, participant_attendance_logs, room_participants,
      room_application_members, room_applications, party_members, parties, friendships,
      room_availability_projections, room_change_logs, room_equipment_options, room_equipment_policies,
      rooms, search_telemetry_events, event_consumptions, event_outbox, idempotency_keys,
      user_sport_profiles, users CASCADE`);
    await db.query(
      `INSERT INTO users (id, phone, display_name, status, home_area, created_at, updated_at) VALUES
       ($1, '0910000001', 'M8 HOST', 'ACTIVE', NULL, NOW(), NOW()),
       ($2, '0910000002', 'M8 Player', 'ACTIVE', NULL, NOW(), NOW())`,
      [hostId, playerId],
    );
    await db.query(
      `INSERT INTO user_sport_profiles (user_id, sport_id, skill_state, skill_score, created_at, updated_at) VALUES
       ($1, $3, 'RANKED', 6, NOW(), NOW()), ($2, $3, 'RANKED', 6, NOW(), NOW())`,
      [hostId, playerId, sportId],
    );
  });

  afterAll(async () => { await db.close(); });

  const createPublishedRoom = async (input: { startAt?: Date; endAt?: Date; title?: string; participationFeePerPerson?: number } = {}) => {
    const startAt = input.startAt ?? new Date('2026-12-01T12:00:00.000Z');
    const created = await rooms.create(meta(hostId, key('create'), 'CreateRoom', input), {
      sportCode: 'BADMINTON', title: input.title ?? 'M8 Room', venue: { name: 'Sân M8', address: 'Quận 1', latitude: 10.776, longitude: 106.700 },
      scheduledStartAt: startAt, scheduledEndAt: input.endAt ?? new Date(startAt.getTime() + 2 * 60 * 60 * 1000),
      capacity: 4, hostParticipates: true, reservedExternalCount: 0, priceAmount: 100_000, participationFeePerPerson: input.participationFeePerPerson ?? 0, currency: 'VND',
      preferredSkill: null, equipment: { supplyMode: 'PLAYER_BRINGS', allowedOptions: [{ displayName: 'Vợt cá nhân' }] },
      allowEmergencyReplacement: true,
    });
    const published = await rooms.publish(created.body.roomId, meta(hostId, key('publish'), 'PublishRoom', {}));
    return { roomId: created.body.roomId, shareToken: published.body.publicShareToken! };
  };

  const emit = async (eventType: string, aggregateId: string, payload: Record<string, unknown> = {}) => {
    await db.transaction(async (tx) => appendOutboxEvent(tx, makeDomainEvent({
      eventType, aggregateType: 'ROOM', aggregateId, actorUserId: hostId, correlationId: null, causationId: null,
      schemaVersion: 1, payload,
    }, clock)));
  };

  const runConsumer = async () => new PostgresOutboxWorker(db, clock).runOnce(consumer, 100);

  it('creates one stable high-entropy token on publish and resolves live public Room state without private host/rank data', async () => {
    const { roomId, shareToken } = await createPublishedRoom();
    expect(shareToken.length).toBeGreaterThanOrEqual(32);
    const initial = await rooms.getSharedRoom(shareToken);
    expect(initial.room.id).toBe(roomId);
    expect(initial.room.status).toBe('OPEN');
    expect(initial.availability.availablePublicSlots).toBe(3);

    await rooms.update(roomId, meta(hostId, key('update'), 'UpdateRoom', { title: 'Updated public title' }), { title: 'Updated public title' });
    const live = await rooms.getSharedRoom(shareToken);
    expect(live.room.title).toBe('Updated public title');
    expect(live.room.publicShareToken).toBe(shareToken);
  });

  it('repeats only a completed Room into DRAFT and copies template fields without copying participants or share capability', async () => {
    const sourceStart = new Date(clock.now().getTime() + 15 * 60 * 1000);
    const { roomId } = await createPublishedRoom({
      title: 'Completed source', startAt: sourceStart, endAt: new Date(sourceStart.getTime() + 2 * 60 * 60 * 1000),
      participationFeePerPerson: 50_000,
    });
    await lifecycle.manualStart(roomId, meta(hostId, key('manual-start'), 'ManualStartRoom', {}));
    await lifecycle.complete(roomId, meta(hostId, key('complete'), 'CompleteRoom', {}));
    const repeated = await rooms.repeat(roomId, meta(hostId, key('repeat'), 'RepeatRoom', {}), {
      scheduledStartAt: new Date('2026-12-08T12:00:00.000Z'), scheduledEndAt: new Date('2026-12-08T14:00:00.000Z'),
    });
    const draft = await rooms.getRoom(repeated.body.roomId);
    expect(draft.room.status).toBe('DRAFT');
    expect(draft.room.title).toBe('Completed source');
    expect(draft.room.publicShareToken).toBeNull();
    expect(draft.room.participationFeePerPerson).toBe(50_000);
    expect(draft.availability.availablePublicSlots).toBe(3);
    const copiedParticipants = await db.query(`SELECT 1 FROM room_participants WHERE room_id=$1`, [draft.room.id]);
    expect(copiedParticipants.rowCount).toBe(0);
  });

  it('projects join notifications exactly once, honors ordinary preferences, and lets critical cancellation bypass room preference', async () => {
    const { roomId } = await createPublishedRoom();
    await emit('JOIN_REQUEST_CREATED', roomId, { room_id: roomId });
    await runConsumer();
    await runConsumer();
    let feed = await notifications.listNotifications(hostId, { limit: 50 });
    expect(feed.data.filter((item) => item.type === 'JOIN_REQUEST_CREATED')).toHaveLength(1);

    await notifications.updatePreferences({ joinRequestsEnabled: false, roomUpdatesEnabled: false }, meta(hostId, key('prefs'), 'UpdateNotificationPreferences', {}));
    await emit('JOIN_REQUEST_CREATED', roomId, { room_id: roomId });
    await runConsumer();
    feed = await notifications.listNotifications(hostId, { limit: 50 });
    expect(feed.data.filter((item) => item.type === 'JOIN_REQUEST_CREATED')).toHaveLength(1);

    const application = await participation.createApplication(roomId, meta(playerId, key('apply'), 'CreateJoinApplication', {}), {});
    await participation.acceptApplication(application.body.applicationId, meta(hostId, key('accept'), 'AcceptJoinApplication', {}));
    await emit('ROOM_CANCELLED', roomId, { room_id: roomId });
    await runConsumer();
    const playerFeed = await notifications.listNotifications(playerId, { limit: 50 });
    const cancellation = playerFeed.data.find((item) => item.type === 'ROOM_CANCELLED');
    expect(cancellation).toMatchObject({ isCritical: true, category: 'ROOM_UPDATES' });
  });

  it('marks an owned notification read idempotently and never exposes another user feed record', async () => {
    const { roomId } = await createPublishedRoom();
    await emit('JOIN_REQUEST_CREATED', roomId, { room_id: roomId });
    await runConsumer();
    const notification = (await notifications.listNotifications(hostId, { limit: 1 })).data[0]!;
    const first = await notifications.markRead(notification.id, meta(hostId, 'mark-read', 'MarkNotificationRead', {}));
    const replay = await notifications.markRead(notification.id, meta(hostId, 'mark-read', 'MarkNotificationRead', {}));
    expect(first.body.readAt).not.toBeNull();
    expect(replay.replayed).toBe(true);
    await expect(notifications.markRead(notification.id, meta(playerId, key('other-user-read'), 'MarkNotificationRead', {}))).rejects.toMatchObject({ code: 'NOTIFICATION_NOT_FOUND' });
  });

  it('creates per-device delivery records and turns provider failures into retryable records without rolling back notification projection', async () => {
    const { roomId } = await createPublishedRoom();
    await notifications.registerPushDevice({ platform: 'WEB', pushToken: 'm8-test-push-token' }, meta(hostId, key('device'), 'RegisterPushDevice', {}));
    await emit('JOIN_REQUEST_CREATED', roomId, { room_id: roomId });
    await runConsumer();
    const worker = new PushDeliveryWorker(db, notificationRepository, new FailingPushGateway(), clock);
    expect(await worker.runOnce()).toBe(1);
    const delivery = await db.query<{ status: string; attempt_count: number; last_error: string | null }>('SELECT status, attempt_count, last_error FROM push_deliveries');
    expect(delivery.rows).toEqual([expect.objectContaining({ status: 'FAILED_RETRYABLE', attempt_count: 1, last_error: 'provider unavailable' })]);
    expect((await notifications.listNotifications(hostId, { limit: 10 })).data).toHaveLength(1);
  });

  it('emits each start reminder once through outbox and does not alter the Room aggregate', async () => {
    const startAt = new Date(clock.now().getTime() + 60 * 60 * 1000);
    const { roomId } = await createPublishedRoom({ startAt, endAt: new Date(startAt.getTime() + 2 * 60 * 60 * 1000) });
    const scheduler = new NotificationReminderScheduler(db, notificationRepository, clock);
    expect(await scheduler.runOnce()).toBe(1);
    expect(await scheduler.runOnce()).toBe(0);
    const events = await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM event_outbox WHERE event_type='ROOM_START_REMINDER' AND aggregate_id=$1`, [roomId]);
    expect(Number(events.rows[0]?.count ?? 0)).toBe(1);
    expect((await rooms.getRoom(roomId)).room.status).toBe('OPEN');
  });
});
