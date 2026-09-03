import type { SqlExecutor, Transaction } from '../../platform/database/db.js';
import { newId } from '../../platform/core.js';
import type {
  NotificationCategory,
  NotificationFeedPage,
  NotificationPreferences,
  NotificationRecord,
  PushDelivery,
  PushDevice,
  PushDeliveryStatus,
} from './domain.js';

type PreferenceRow = {
  user_id: string;
  room_updates_enabled: boolean;
  join_requests_enabled: boolean;
  party_invites_enabled: boolean;
  emergency_opportunities_enabled: boolean;
  match_reminders_enabled: boolean;
  rank_updates_enabled: boolean;
  created_at: Date;
  updated_at: Date;
};

type NotificationRow = {
  id: string;
  user_id: string;
  type: string;
  category: NotificationCategory;
  entity_type: string | null;
  entity_id: string | null;
  title: string;
  body: string;
  template_key: string;
  params_json: Record<string, unknown>;
  dedupe_key: string;
  is_critical: boolean;
  read_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
};

type PushDeviceRow = {
  id: string;
  user_id: string;
  platform: PushDevice['platform'];
  push_token: string;
  device_id: string | null;
  enabled: boolean;
  last_seen_at: Date;
  created_at: Date;
  updated_at: Date;
};

type PushDeliveryRow = {
  id: string;
  notification_id: string;
  device_id: string;
  status: PushDeliveryStatus;
  attempt_count: number;
  next_attempt_at: Date | null;
  last_error: string | null;
  sent_at: Date | null;
  delivered_at: Date | null;
  created_at: Date;
  updated_at: Date;
  user_id: string;
  push_token: string;
  platform: PushDevice['platform'];
  title: string;
  body: string;
  entity_type: string | null;
  entity_id: string | null;
};

const preferencesFrom = (row: PreferenceRow): NotificationPreferences => ({
  userId: row.user_id,
  roomUpdatesEnabled: row.room_updates_enabled,
  joinRequestsEnabled: row.join_requests_enabled,
  partyInvitesEnabled: row.party_invites_enabled,
  emergencyOpportunitiesEnabled: row.emergency_opportunities_enabled,
  matchRemindersEnabled: row.match_reminders_enabled,
  rankUpdatesEnabled: row.rank_updates_enabled,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const notificationFrom = (row: NotificationRow): NotificationRecord => ({
  id: row.id,
  userId: row.user_id,
  type: row.type,
  category: row.category,
  entityType: row.entity_type,
  entityId: row.entity_id,
  title: row.title,
  body: row.body,
  templateKey: row.template_key,
  params: row.params_json,
  dedupeKey: row.dedupe_key,
  isCritical: row.is_critical,
  readAt: row.read_at,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
});

const deviceFrom = (row: PushDeviceRow): PushDevice => ({
  id: row.id,
  userId: row.user_id,
  platform: row.platform,
  pushToken: row.push_token,
  deviceId: row.device_id,
  enabled: row.enabled,
  lastSeenAt: row.last_seen_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export interface NewNotification {
  id?: string;
  userId: string;
  type: string;
  category: NotificationCategory;
  entityType: string | null;
  entityId: string | null;
  title: string;
  body: string;
  templateKey: string;
  params: Record<string, unknown>;
  dedupeKey: string;
  isCritical: boolean;
  expiresAt: Date | null;
  createdAt: Date;
}

export class NotificationRepository {
  async getPreferences(executor: SqlExecutor, userId: string, now: Date): Promise<NotificationPreferences> {
    await executor.query(
      `INSERT INTO notification_preferences (
        user_id, room_updates_enabled, join_requests_enabled, party_invites_enabled,
        emergency_opportunities_enabled, match_reminders_enabled, rank_updates_enabled, created_at, updated_at
      ) VALUES ($1, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, $2, $2)
      ON CONFLICT (user_id) DO NOTHING`,
      [userId, now],
    );
    const result = await executor.query<PreferenceRow>(
      'SELECT * FROM notification_preferences WHERE user_id = $1',
      [userId],
    );
    return preferencesFrom(result.rows[0]!);
  }

  async updatePreferences(
    executor: SqlExecutor,
    userId: string,
    patch: Partial<Pick<NotificationPreferences,
      | 'roomUpdatesEnabled'
      | 'joinRequestsEnabled'
      | 'partyInvitesEnabled'
      | 'emergencyOpportunitiesEnabled'
      | 'matchRemindersEnabled'
      | 'rankUpdatesEnabled'>>,
    now: Date,
  ): Promise<NotificationPreferences> {
    const current = await this.getPreferences(executor, userId, now);
    const next = { ...current, ...patch, updatedAt: now };
    const result = await executor.query<PreferenceRow>(
      `UPDATE notification_preferences
       SET room_updates_enabled=$2, join_requests_enabled=$3, party_invites_enabled=$4,
           emergency_opportunities_enabled=$5, match_reminders_enabled=$6, rank_updates_enabled=$7, updated_at=$8
       WHERE user_id=$1
       RETURNING *`,
      [userId, next.roomUpdatesEnabled, next.joinRequestsEnabled, next.partyInvitesEnabled,
        next.emergencyOpportunitiesEnabled, next.matchRemindersEnabled, next.rankUpdatesEnabled, now],
    );
    return preferencesFrom(result.rows[0]!);
  }

  async insertNotification(executor: SqlExecutor, notification: NewNotification): Promise<NotificationRecord | null> {
    const result = await executor.query<NotificationRow>(
      `INSERT INTO notifications (
        id, user_id, type, category, entity_type, entity_id, title, body, template_key,
        params_json, dedupe_key, is_critical, read_at, expires_at, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,NULL,$13,$14)
      ON CONFLICT (user_id, dedupe_key) DO NOTHING
      RETURNING *`,
      [notification.id ?? newId(), notification.userId, notification.type, notification.category,
        notification.entityType, notification.entityId, notification.title, notification.body,
        notification.templateKey, JSON.stringify(notification.params), notification.dedupeKey,
        notification.isCritical, notification.expiresAt, notification.createdAt],
    );
    return result.rows[0] ? notificationFrom(result.rows[0]) : null;
  }

  async listFeed(executor: SqlExecutor, userId: string, now: Date, limit: number, cursor: { createdAt: Date; id: string } | null): Promise<NotificationFeedPage> {
    const result = await executor.query<NotificationRow>(
      `SELECT * FROM notifications
       WHERE user_id = $1
         AND (expires_at IS NULL OR expires_at > $2)
         AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
       ORDER BY created_at DESC, id DESC
       LIMIT $5`,
      [userId, now, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
    );
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const tail = rows.at(-1);
    return {
      data: rows.map(notificationFrom),
      nextCursor: hasMore && tail ? Buffer.from(JSON.stringify({ created_at: tail.created_at.toISOString(), id: tail.id })).toString('base64url') : null,
    };
  }

  async markRead(executor: SqlExecutor, notificationId: string, userId: string, now: Date): Promise<NotificationRecord | null> {
    const result = await executor.query<NotificationRow>(
      `UPDATE notifications
       SET read_at = COALESCE(read_at, $3)
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [notificationId, userId, now],
    );
    return result.rows[0] ? notificationFrom(result.rows[0]) : null;
  }

  async upsertDevice(executor: SqlExecutor, device: PushDevice): Promise<PushDevice> {
    const result = await executor.query<PushDeviceRow>(
      `INSERT INTO push_devices (
        id, user_id, platform, push_token, device_id, enabled, last_seen_at, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (push_token) DO UPDATE SET
        user_id=EXCLUDED.user_id, platform=EXCLUDED.platform, device_id=EXCLUDED.device_id,
        enabled=EXCLUDED.enabled, last_seen_at=EXCLUDED.last_seen_at, updated_at=EXCLUDED.updated_at
      RETURNING *`,
      [device.id, device.userId, device.platform, device.pushToken, device.deviceId, device.enabled,
        device.lastSeenAt, device.createdAt, device.updatedAt],
    );
    return deviceFrom(result.rows[0]!);
  }

  async createDeliveries(executor: SqlExecutor, notificationId: string, now: Date): Promise<void> {
    await executor.query(
      `INSERT INTO push_deliveries (
        id, notification_id, device_id, status, attempt_count, next_attempt_at, created_at, updated_at
      )
      SELECT gen_random_uuid(), $1, d.id, 'PENDING', 0, $2, $2, $2
      FROM push_devices d
      WHERE d.user_id = (SELECT user_id FROM notifications WHERE id = $1)
        AND d.enabled = TRUE
      ON CONFLICT (notification_id, device_id) DO NOTHING`,
      [notificationId, now],
    );
  }

  async claimDueDeliveries(executor: SqlExecutor, now: Date, limit: number): Promise<PushDeliveryRow[]> {
    const result = await executor.query<PushDeliveryRow>(
      `WITH claimed AS (
        SELECT id
        FROM push_deliveries
        WHERE status IN ('PENDING', 'FAILED_RETRYABLE')
          AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
        ORDER BY created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT $2
      )
      UPDATE push_deliveries d
      SET status='PROCESSING', attempt_count=d.attempt_count + 1, updated_at=$1
      FROM claimed, push_devices pd, notifications n
      WHERE d.id = claimed.id
        AND pd.id = d.device_id
        AND n.id = d.notification_id
      RETURNING d.*, pd.user_id, pd.push_token, pd.platform, n.title, n.body, n.entity_type, n.entity_id`,
      [now, limit],
    );
    return result.rows;
  }

  async markDeliverySent(executor: SqlExecutor, deliveryId: string, now: Date): Promise<void> {
    await executor.query(
      `UPDATE push_deliveries
       SET status='SENT', sent_at=$2, next_attempt_at=NULL, last_error=NULL, updated_at=$2
       WHERE id=$1`,
      [deliveryId, now],
    );
  }

  async markDeliverySkipped(executor: SqlExecutor, deliveryId: string, now: Date): Promise<void> {
    await executor.query(
      `UPDATE push_deliveries
       SET status='SKIPPED', next_attempt_at=NULL, updated_at=$2
       WHERE id=$1`,
      [deliveryId, now],
    );
  }

  async markDeliveryFailed(executor: SqlExecutor, deliveryId: string, attemptCount: number, nextAttemptAt: Date | null, error: string, now: Date): Promise<void> {
    await executor.query(
      `UPDATE push_deliveries
       SET status=$2, next_attempt_at=$3, last_error=$4, updated_at=$5
       WHERE id=$1`,
      [deliveryId, attemptCount >= 5 ? 'DEAD_LETTER' : 'FAILED_RETRYABLE', nextAttemptAt, error.slice(0, 2048), now],
    );
  }

  async findRoomSchedule(executor: SqlExecutor, roomId: string): Promise<{ scheduledStartAt: Date; scheduledEndAt: Date } | null> {
    const result = await executor.query<{ scheduled_start_at: Date; scheduled_end_at: Date }>(
      'SELECT scheduled_start_at, scheduled_end_at FROM rooms WHERE id=$1',
      [roomId],
    );
    const row = result.rows[0];
    return row ? { scheduledStartAt: row.scheduled_start_at, scheduledEndAt: row.scheduled_end_at } : null;
  }

  async findRoomHostUserId(executor: SqlExecutor, roomId: string): Promise<string | null> {
    const result = await executor.query<{ host_user_id: string }>('SELECT host_user_id FROM rooms WHERE id=$1', [roomId]);
    return result.rows[0]?.host_user_id ?? null;
  }

  async listApplicationUserIds(executor: SqlExecutor, applicationId: string): Promise<string[]> {
    const result = await executor.query<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM room_application_members
       WHERE application_id=$1 AND user_id IS NOT NULL`,
      [applicationId],
    );
    return result.rows.map((row) => row.user_id);
  }

  async listRoomParticipantUserIds(executor: SqlExecutor, roomId: string): Promise<string[]> {
    const result = await executor.query<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM room_participants
       WHERE room_id=$1 AND user_id IS NOT NULL AND status <> 'REMOVED_BY_HOST'`,
      [roomId],
    );
    return result.rows.map((row) => row.user_id);
  }

  async findPartyMemberUserId(executor: SqlExecutor, partyMemberId: string): Promise<string | null> {
    const result = await executor.query<{ user_id: string }>('SELECT user_id FROM party_members WHERE id=$1', [partyMemberId]);
    return result.rows[0]?.user_id ?? null;
  }

  async claimReminderRoomIds(tx: Transaction, now: Date, limit: number): Promise<string[]> {
    const result = await tx.query<{ id: string }>(
      `SELECT r.id
       FROM rooms r
       WHERE r.status IN ('OPEN', 'FULL')
         AND r.scheduled_start_at > $1
         AND r.scheduled_start_at <= $1::timestamptz + INTERVAL '2 hours'
         AND NOT EXISTS (
           SELECT 1 FROM event_outbox e
           WHERE e.event_type='ROOM_START_REMINDER' AND e.aggregate_id=r.id
         )
       ORDER BY r.scheduled_start_at, r.id
       FOR UPDATE SKIP LOCKED
       LIMIT $2`,
      [now, limit],
    );
    return result.rows.map((row) => row.id);
  }

  async claimCompletionReminderRoomIds(tx: Transaction, now: Date, limit: number): Promise<string[]> {
    const result = await tx.query<{ id: string }>(
      `SELECT r.id
       FROM rooms r
       WHERE r.status='IN_PROGRESS'
         AND r.scheduled_end_at <= $1::timestamptz - INTERVAL '30 minutes'
         AND NOT EXISTS (
           SELECT 1 FROM event_outbox e
           WHERE e.event_type='ROOM_COMPLETION_REMINDER' AND e.aggregate_id=r.id
         )
       ORDER BY r.scheduled_end_at, r.id
       FOR UPDATE SKIP LOCKED
       LIMIT $2`,
      [now, limit],
    );
    return result.rows.map((row) => row.id);
  }
}

export type ClaimedPushDelivery = PushDeliveryRow;
