import { newId, systemClock, type Clock, DomainError } from '../../platform/core.js';
import type { PostgresDatabase } from '../../platform/database/db.js';
import type { DomainEvent, OutboxConsumer } from '../../platform/outbox/outbox.js';
import { PostgresIdempotencyGate, type IdempotencyResult } from '../../platform/idempotency.js';
import { metrics } from '../../platform/observability/metrics.js';
import type { CommandMeta } from '../room/service.js';
import {
  preferenceFieldFor,
  retryDelayMs,
  type NotificationCategory,
  type NotificationFeedPage,
  type NotificationPreferences,
  type NotificationRecord,
  type PushDevice,
} from './domain.js';
import { NotificationRepository, type ClaimedPushDelivery, type NewNotification } from './repository.js';

export interface UpdateNotificationPreferencesInput {
  roomUpdatesEnabled?: boolean;
  joinRequestsEnabled?: boolean;
  partyInvitesEnabled?: boolean;
  emergencyOpportunitiesEnabled?: boolean;
  matchRemindersEnabled?: boolean;
  rankUpdatesEnabled?: boolean;
}

export interface RegisterPushDeviceInput {
  platform: PushDevice['platform'];
  pushToken: string;
  deviceId?: string | null;
  enabled?: boolean;
}

export interface PushMessage {
  notificationId: string;
  userId: string;
  deviceToken: string;
  platform: PushDevice['platform'];
  title: string;
  body: string;
  entityType: string | null;
  entityId: string | null;
  action: string;
}

export interface PushGateway {
  send(message: PushMessage): Promise<void>;
}

export class NoopPushGateway implements PushGateway {
  async send(_message: PushMessage): Promise<void> {
    // The adapter is intentionally inert until an OS provider is configured. In-app notifications remain durable source of delivery UX.
  }
}

type NotificationIntent = Omit<NewNotification, 'userId' | 'createdAt'> & { userId: string };

const stringPayload = (payload: Record<string, unknown>, key: string): string | null => typeof payload[key] === 'string' ? payload[key] : null;

const roomIdFor = (event: DomainEvent): string | null => stringPayload(event.payload, 'room_id') ?? (event.aggregateType === 'ROOM' ? event.aggregateId : null);

const stableUnique = (ids: Array<string | null>): string[] => [...new Set(ids.filter((id): id is string => Boolean(id)))];

export class NotificationConsumer implements OutboxConsumer {
  readonly name = 'notification-consumer-v1';

  constructor(
    private readonly db: PostgresDatabase,
    private readonly notifications: NotificationRepository,
    private readonly clock: Clock = systemClock,
  ) {}

  async handle(event: DomainEvent): Promise<void> {
    const now = this.clock.now();
    const intents = await this.intentsFor(event, now);
    for (const intent of intents) {
      if (intent.expiresAt && intent.expiresAt <= now) continue;
      const preferences = await this.notifications.getPreferences(this.db, intent.userId, now);
      if (!intent.isCritical && !preferences[preferenceFieldFor(intent.category)]) continue;
      const notification = await this.notifications.insertNotification(this.db, { ...intent, createdAt: now });
      if (notification) await this.notifications.createDeliveries(this.db, notification.id, now);
    }
  }

  private async intentsFor(event: DomainEvent, now: Date): Promise<NotificationIntent[]> {
    const roomId = roomIdFor(event);
    const schedule = roomId ? await this.notifications.findRoomSchedule(this.db, roomId) : null;
    const roomExpiry = schedule ? (schedule.scheduledStartAt > now ? schedule.scheduledStartAt : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)) : null;
    const roomParams = roomId ? { room_id: roomId } : {};
    const roomIntent = (userId: string, type: string, category: NotificationCategory, title: string, body: string, extras: Partial<NotificationIntent> = {}): NotificationIntent => ({
      userId, type, category, entityType: roomId ? 'ROOM' : null, entityId: roomId,
      title, body, templateKey: `notification.${type.toLowerCase()}`,
      params: roomParams, dedupeKey: `${type}:${event.id}:${userId}`,
      isCritical: false, expiresAt: roomExpiry, ...extras,
    });

    switch (event.eventType) {
      case 'JOIN_REQUEST_CREATED': {
        if (!roomId) return [];
        const hostUserId = await this.notifications.findRoomHostUserId(this.db, roomId);
        return hostUserId ? [roomIntent(hostUserId, event.eventType, 'JOIN_REQUESTS', 'Yêu cầu tham gia mới', 'Có người chơi mới đang chờ bạn xét duyệt.')] : [];
      }
      case 'JOIN_REQUEST_ACCEPTED': {
        const applicationId = stringPayload(event.payload, 'application_id');
        if (!applicationId) return [];
        const recipients = await this.notifications.listApplicationUserIds(this.db, applicationId);
        return recipients.map((userId) => roomIntent(userId, event.eventType, 'ROOM_UPDATES', 'Yêu cầu tham gia đã được chấp nhận', 'Bạn đã có một chỗ trong trận này.'));
      }
      case 'JOIN_REQUEST_REJECTED': {
        const applicationId = stringPayload(event.payload, 'application_id');
        if (!applicationId) return [];
        const recipients = await this.notifications.listApplicationUserIds(this.db, applicationId);
        return recipients.map((userId) => roomIntent(userId, event.eventType, 'ROOM_UPDATES', 'Yêu cầu tham gia chưa được chấp nhận', 'HOST chưa thể nhận yêu cầu của bạn cho trận này.'));
      }
      case 'ROOM_CANCELLED':
      case 'ROOM_MATERIAL_CHANGED': {
        if (!roomId) return [];
        const recipients = await this.notifications.listRoomParticipantUserIds(this.db, roomId);
        const cancelled = event.eventType === 'ROOM_CANCELLED';
        return recipients.map((userId) => roomIntent(
          userId, event.eventType, 'ROOM_UPDATES',
          cancelled ? 'Trận đã bị huỷ' : 'Trận có thay đổi quan trọng',
          cancelled ? 'Trận bạn đã tham gia đã bị huỷ. Vui lòng kiểm tra lịch của bạn.' : 'Thông tin quan trọng của trận đã thay đổi. Vui lòng xem lại trước khi tham gia.',
          { isCritical: true, dedupeKey: `${event.eventType}:${roomId}:${userId}` },
        ));
      }
      case 'PARTY_MEMBER_INVITED': {
        const partyMemberId = stringPayload(event.payload, 'party_member_id');
        if (!partyMemberId) return [];
        const recipient = await this.notifications.findPartyMemberUserId(this.db, partyMemberId);
        return recipient ? [{
          userId: recipient, type: event.eventType, category: 'PARTY_INVITES', entityType: 'PARTY', entityId: event.aggregateId,
          title: 'Bạn được mời vào Party', body: 'Hãy xác nhận lời mời để Party có thể sẵn sàng tham gia trận.',
          templateKey: 'notification.party_member_invited', params: { party_id: event.aggregateId, party_member_id: partyMemberId },
          dedupeKey: `${event.eventType}:${partyMemberId}:${recipient}`, isCritical: false, expiresAt: null,
        }] : [];
      }
      case 'PLAYER_LATE_CANCELLED':
      case 'PUBLIC_SLOT_OPENED':
      case 'REPLACEMENT_CANDIDATE_AVAILABLE': {
        if (!roomId) return [];
        const hostUserId = await this.notifications.findRoomHostUserId(this.db, roomId);
        if (!hostUserId) return [];
        const emergency = event.eventType === 'REPLACEMENT_CANDIDATE_AVAILABLE';
        const title = event.eventType === 'PLAYER_LATE_CANCELLED' ? 'Có người chơi huỷ sát giờ' : emergency ? 'Đã có ứng viên thay thế' : 'Trận có chỗ trống';
        const body = event.eventType === 'PLAYER_LATE_CANCELLED' ? 'Một người chơi đã huỷ sát giờ. Hãy kiểm tra phương án lấp chỗ.' : emergency ? 'Có ứng viên phù hợp cho chỗ trống khẩn cấp.' : 'Room của bạn vừa có thêm chỗ trống công khai.';
        return [roomIntent(hostUserId, event.eventType, emergency ? 'EMERGENCY_OPPORTUNITIES' : 'ROOM_UPDATES', title, body)];
      }
      case 'ROOM_START_REMINDER': {
        if (!roomId) return [];
        const recipients = await this.notifications.listRoomParticipantUserIds(this.db, roomId);
        return recipients.map((userId) => roomIntent(userId, event.eventType, 'MATCH_REMINDERS', 'Trận sắp bắt đầu', 'Trận của bạn sẽ bắt đầu trong khoảng hai giờ.'));
      }
      case 'ROOM_COMPLETION_REMINDER':
      case 'ROOM_COMPLETED': {
        if (!roomId) return [];
        const hostUserId = await this.notifications.findRoomHostUserId(this.db, roomId);
        if (!hostUserId) return [];
        const reminder = event.eventType === 'ROOM_COMPLETION_REMINDER';
        return [roomIntent(hostUserId, event.eventType, 'ROOM_UPDATES', reminder ? 'Hãy hoàn tất trận' : 'Trận đã hoàn tất', reminder ? 'Hãy xác nhận attendance và hoàn tất trận vừa rồi.' : 'Bạn có thể tạo một trận tương tự từ trận đã hoàn tất.', { expiresAt: reminder ? new Date(now.getTime() + 24 * 60 * 60 * 1000) : null })];
      }
      case 'PLAYER_INITIAL_RANK_PUBLISHED': {
        const recipient = stringPayload(event.payload, 'rated_user_id');
        return recipient ? [{
          userId: recipient, type: event.eventType, category: 'RANK_UPDATES', entityType: 'USER_SPORT_PROFILE', entityId: event.aggregateId,
          title: 'Thứ hạng ban đầu của bạn đã sẵn sàng', body: 'Hồ sơ kỹ năng của bạn đã có thứ hạng ban đầu.',
          templateKey: 'notification.player_initial_rank_published', params: { sport_id: stringPayload(event.payload, 'sport_id') },
          dedupeKey: `${event.eventType}:${event.aggregateId}:${recipient}`, isCritical: false, expiresAt: null,
        }] : [];
      }
      default:
        return [];
    }
  }
}

export class NotificationService {
  private readonly idempotency: PostgresIdempotencyGate;

  constructor(
    private readonly db: PostgresDatabase,
    private readonly notifications: NotificationRepository,
    private readonly clock: Clock = systemClock,
  ) {
    this.idempotency = new PostgresIdempotencyGate(db, clock);
  }

  async listNotifications(userId: string, input: { limit: number; cursor?: string }): Promise<NotificationFeedPage> {
    let cursor: { createdAt: Date; id: string } | null = null;
    if (input.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as { created_at: string; id: string };
        const createdAt = new Date(decoded.created_at);
        if (Number.isNaN(createdAt.getTime()) || !decoded.id) throw new Error('Invalid cursor');
        cursor = { createdAt, id: decoded.id };
      } catch {
        throw new DomainError('VALIDATION_ERROR', 'Notification cursor is invalid.');
      }
    }
    return this.notifications.listFeed(this.db, userId, this.clock.now(), input.limit, cursor);
  }

  async markRead(notificationId: string, meta: CommandMeta): Promise<IdempotencyResult<NotificationRecord>> {
    return this.idempotency.execute(meta.idempotency, 200, async (tx) => {
      const notification = await this.notifications.markRead(tx, notificationId, meta.actorUserId, this.clock.now());
      if (!notification) throw new DomainError('NOTIFICATION_NOT_FOUND', 'Notification was not found.');
      return notification;
    });
  }

  async getPreferences(userId: string): Promise<NotificationPreferences> {
    return this.notifications.getPreferences(this.db, userId, this.clock.now());
  }

  async updatePreferences(input: UpdateNotificationPreferencesInput, meta: CommandMeta): Promise<IdempotencyResult<NotificationPreferences>> {
    return this.idempotency.execute(meta.idempotency, 200, async (tx) => this.notifications.updatePreferences(tx, meta.actorUserId, input, this.clock.now()));
  }

  async registerPushDevice(input: RegisterPushDeviceInput, meta: CommandMeta): Promise<IdempotencyResult<PushDevice>> {
    if (!input.pushToken.trim()) throw new DomainError('VALIDATION_ERROR', 'push_token is required.');
    return this.idempotency.execute(meta.idempotency, 201, async (tx) => {
      const now = this.clock.now();
      return this.notifications.upsertDevice(tx, {
        id: newId(), userId: meta.actorUserId, platform: input.platform, pushToken: input.pushToken.trim(),
        deviceId: input.deviceId?.trim() || null, enabled: input.enabled ?? true, lastSeenAt: now, createdAt: now, updatedAt: now,
      });
    });
  }
}

export class PushDeliveryWorker {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly notifications: NotificationRepository,
    private readonly gateway: PushGateway = new NoopPushGateway(),
    private readonly clock: Clock = systemClock,
  ) {}

  async runOnce(batchSize = 25): Promise<number> {
    const startedAt = performance.now();
    const now = this.clock.now();
    const deliveries = await this.db.transaction((tx) => this.notifications.claimDueDeliveries(tx, now, batchSize));
    metrics.increment('vaotran_notification_deliveries_claimed_total', {}, deliveries.length);
    for (const delivery of deliveries) {
      metrics.observe('vaotran_notification_delivery_lag_ms', Math.max(0, now.getTime() - delivery.created_at.getTime()), { platform: delivery.platform });
      await this.dispatch(delivery);
    }
    metrics.observe('vaotran_notification_worker_duration_ms', performance.now() - startedAt, { claimed: deliveries.length });
    return deliveries.length;
  }

  private async dispatch(delivery: ClaimedPushDelivery): Promise<void> {
    const now = this.clock.now();
    try {
      await this.gateway.send({
        notificationId: delivery.notification_id, userId: delivery.user_id, deviceToken: delivery.push_token,
        platform: delivery.platform, title: delivery.title, body: delivery.body,
        entityType: delivery.entity_type, entityId: delivery.entity_id, action: 'OPEN_NOTIFICATION',
      });
      await this.db.transaction((tx) => this.notifications.markDeliverySent(tx, delivery.id, now));
      metrics.increment('vaotran_notification_deliveries_total', { outcome: 'sent', platform: delivery.platform });
    } catch (error) {
      const nextAttemptAt = delivery.attempt_count >= 5 ? null : new Date(now.getTime() + retryDelayMs(delivery.attempt_count));
      await this.db.transaction((tx) => this.notifications.markDeliveryFailed(
        tx, delivery.id, delivery.attempt_count, nextAttemptAt,
        error instanceof Error ? error.message : 'Unknown push delivery error', now,
      ));
      metrics.increment('vaotran_notification_deliveries_total', { outcome: nextAttemptAt ? 'retryable' : 'dead_letter', platform: delivery.platform });
      if (nextAttemptAt) metrics.increment('vaotran_notification_retries_total', { platform: delivery.platform });
    }
  }
}
