import { newId, systemClock, type Clock } from '../../platform/core.js';
import type { PostgresDatabase, SqlExecutor } from '../../platform/database/db.js';

export interface InternalOutboxEvent {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  actorUserId: string | null;
  correlationId: string | null;
  occurredAt: Date;
  publishStatus: string;
  attemptCount: number;
  nextAttemptAt: Date | null;
  publishedAt: Date | null;
  lastError: string | null;
}

export interface InternalDelivery {
  id: string;
  notificationId: string;
  userId: string;
  platform: string;
  status: string;
  attemptCount: number;
  nextAttemptAt: Date | null;
  sentAt: Date | null;
  deliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const mapOutbox = (row: Record<string, unknown>): InternalOutboxEvent => ({
  id: String(row.id),
  eventType: String(row.event_type),
  aggregateType: String(row.aggregate_type),
  aggregateId: String(row.aggregate_id),
  actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
  correlationId: row.correlation_id ? String(row.correlation_id) : null,
  occurredAt: new Date(String(row.occurred_at)),
  publishStatus: String(row.publish_status),
  attemptCount: Number(row.attempt_count),
  nextAttemptAt: row.next_attempt_at ? new Date(String(row.next_attempt_at)) : null,
  publishedAt: row.published_at ? new Date(String(row.published_at)) : null,
  lastError: row.last_error ? String(row.last_error) : null,
});

const mapDelivery = (row: Record<string, unknown>): InternalDelivery => ({
  id: String(row.id),
  notificationId: String(row.notification_id),
  userId: String(row.user_id),
  platform: String(row.platform),
  status: String(row.status),
  attemptCount: Number(row.attempt_count),
  nextAttemptAt: row.next_attempt_at ? new Date(String(row.next_attempt_at)) : null,
  sentAt: row.sent_at ? new Date(String(row.sent_at)) : null,
  deliveredAt: row.delivered_at ? new Date(String(row.delivered_at)) : null,
  createdAt: new Date(String(row.created_at)),
  updatedAt: new Date(String(row.updated_at)),
});

export class OperationsService {
  constructor(private readonly db: PostgresDatabase, private readonly clock: Clock = systemClock) {}

  async inspectUser(userId: string): Promise<Record<string, unknown> | null> {
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT id, display_name, status::text, created_at, updated_at FROM users WHERE id = $1`, [userId],
    );
    return result.rows[0] ?? null;
  }

  async inspectRoom(roomId: string): Promise<Record<string, unknown> | null> {
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT r.id, r.sport_id, r.host_user_id, r.title, r.venue_name, r.scheduled_start_at, r.scheduled_end_at,
              r.capacity, r.host_participates, r.reserved_external_count, r.status::text, r.version,
              rap.host_slot, rap.active_app_count, rap.occupied_slots, rap.available_public_slots, rap.updated_at AS availability_updated_at
       FROM rooms r
       LEFT JOIN room_availability_projections rap ON rap.room_id = r.id
       WHERE r.id = $1`,
      [roomId],
    );
    return result.rows[0] ?? null;
  }

  async inspectApplication(applicationId: string): Promise<Record<string, unknown> | null> {
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT id, room_id, requested_by_user_id, party_id, application_owner_key, requested_slot_count,
              status::text, requested_at, accepted_at, rejected_at, withdrawn_at, rejection_reason_code, version
       FROM room_applications WHERE id = $1`,
      [applicationId],
    );
    return result.rows[0] ?? null;
  }

  async inspectParticipant(participantId: string): Promise<Record<string, unknown> | null> {
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT id, room_id, application_id, application_member_id, user_id, member_type::text, status::text,
              attendance_status::text, accepted_at, cancelled_at, removed_at, removal_reason_code, version
       FROM room_participants WHERE id = $1`,
      [participantId],
    );
    return result.rows[0] ?? null;
  }

  async inspectParty(partyId: string): Promise<Record<string, unknown> | null> {
    const party = await this.db.query<Record<string, unknown>>(
      `SELECT id, owner_user_id, sport_id, name, status::text, created_at, updated_at FROM parties WHERE id = $1`,
      [partyId],
    );
    if (!party.rows[0]) return null;
    const members = await this.db.query<Record<string, unknown>>(
      `SELECT id, member_type::text, user_id, guest_label, status::text, created_at, updated_at
       FROM party_members WHERE party_id = $1 ORDER BY created_at ASC`,
      [partyId],
    );
    return { ...party.rows[0], members: members.rows };
  }

  async inspectReliability(userId: string): Promise<Record<string, unknown>> {
    const [player, host, adjustments] = await Promise.all([
      this.db.query<Record<string, unknown>>(`SELECT * FROM player_reliability_stats WHERE user_id = $1`, [userId]),
      this.db.query<Record<string, unknown>>(`SELECT * FROM host_stats WHERE user_id = $1`, [userId]),
      this.db.query<Record<string, unknown>>(
        `SELECT id, subject_type::text, adjustment, reason, score_before, score_after, created_at
         FROM reliability_adjustments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [userId],
      ),
    ]);
    return { player: player.rows[0] ?? null, host: host.rows[0] ?? null, adjustments: adjustments.rows };
  }

  async inspectSkillProfile(userId: string, sportId: string): Promise<Record<string, unknown> | null> {
    const profile = await this.db.query<Record<string, unknown>>(
      `SELECT user_id, sport_id, skill_state::text, skill_score, rank_tier, valid_rating_count,
              completed_match_count, unique_valid_rater_count, confidence_level::text, last_valid_rating_at,
              last_rank_change_at, last_rank_change_rating_count, version, updated_at
       FROM user_sport_profiles WHERE user_id = $1 AND sport_id = $2`,
      [userId, sportId],
    );
    if (!profile.rows[0]) return null;
    const ratings = await this.db.query<Record<string, unknown>>(
      `SELECT id, room_id, rater_host_user_id, rating_value, effective_rating_value, eligibility_result,
              eligibility_reason, is_outlier, rule_version, created_at
       FROM skill_ratings WHERE rated_user_id = $1 AND sport_id = $2 ORDER BY created_at DESC LIMIT 50`,
      [userId, sportId],
    );
    return { ...profile.rows[0], recent_ratings: ratings.rows };
  }

  async listOutbox(status?: string, limit = 100): Promise<InternalOutboxEvent[]> {
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT id, event_type, aggregate_type, aggregate_id, actor_user_id, correlation_id, occurred_at,
              publish_status::text, attempt_count, next_attempt_at, published_at, last_error
       FROM event_outbox
       WHERE ($1::text IS NULL OR publish_status::text = $1)
       ORDER BY occurred_at DESC LIMIT $2`,
      [status ?? null, Math.min(Math.max(limit, 1), 200)],
    );
    return result.rows.map(mapOutbox);
  }

  async inspectOutboxEvent(eventId: string): Promise<InternalOutboxEvent | null> {
    const events = await this.db.query<Record<string, unknown>>(
      `SELECT id, event_type, aggregate_type, aggregate_id, actor_user_id, correlation_id, occurred_at,
              publish_status::text, attempt_count, next_attempt_at, published_at, last_error
       FROM event_outbox WHERE id = $1`,
      [eventId],
    );
    return events.rows[0] ? mapOutbox(events.rows[0]) : null;
  }

  async listDeliveries(status?: string, limit = 100): Promise<InternalDelivery[]> {
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT pd.id, pd.notification_id, pd.status::text, pd.attempt_count, pd.next_attempt_at, pd.sent_at,
              pd.delivered_at, pd.created_at, pd.updated_at, n.user_id, d.platform::text
       FROM push_deliveries pd
       JOIN notifications n ON n.id = pd.notification_id
       JOIN push_devices d ON d.id = pd.device_id
       WHERE ($1::text IS NULL OR pd.status::text = $1)
       ORDER BY pd.created_at DESC LIMIT $2`,
      [status ?? null, Math.min(Math.max(limit, 1), 200)],
    );
    return result.rows.map(mapDelivery);
  }

  async listFindings(state = 'OPEN', limit = 100): Promise<Record<string, unknown>[]> {
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT f.id, f.reconciliation_run_id, f.check_name, f.entity_type, f.entity_id, f.severity::text,
              f.state::text, f.expected_json, f.actual_json, f.created_at,
              r.status::text AS run_status, r.completed_at AS run_completed_at
       FROM reconciliation_findings f
       JOIN reconciliation_runs r ON r.id = f.reconciliation_run_id
       WHERE ($1::text IS NULL OR f.state::text = $1)
       ORDER BY f.created_at DESC LIMIT $2`,
      [state || null, Math.min(Math.max(limit, 1), 200)],
    );
    return result.rows;
  }

  async suspendUser(userId: string, correlationId: string): Promise<Record<string, unknown> | null> {
    return this.db.transaction(async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `UPDATE users
         SET status = 'SUSPENDED', updated_at = $2
         WHERE id = $1 AND status <> 'SUSPENDED'
         RETURNING id, status::text, updated_at`,
        [userId, this.clock.now()],
      );
      const user = result.rows[0] ?? null;
      const existing = user ? null : await tx.query<Record<string, unknown>>(
        `SELECT id, status::text, updated_at FROM users WHERE id = $1`, [userId],
      );
      const outcome = user ? 'SUSPENDED' : existing?.rows[0] ? 'ALREADY_SUSPENDED' : 'NOT_FOUND';
      await this.audit(tx, 'SUSPEND_USER', 'USER', userId, outcome, correlationId, {
        automated: false,
        prior_state_required: ['ACTIVE'],
      });
      return user ?? existing?.rows[0] ?? null;
    });
  }

  async retryOutboxEvent(eventId: string, correlationId: string, operatorId?: string): Promise<InternalOutboxEvent | null> {
    return this.db.transaction(async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `UPDATE event_outbox
         SET publish_status = 'PENDING', next_attempt_at = NOW(), last_error = NULL
         WHERE id = $1 AND publish_status IN ('FAILED_RETRYABLE', 'DEAD_LETTER')
         RETURNING id, event_type, aggregate_type, aggregate_id, actor_user_id, correlation_id, occurred_at,
                   publish_status::text, attempt_count, next_attempt_at, published_at, last_error`,
        [eventId],
      );
      const event = result.rows[0] ? mapOutbox(result.rows[0]) : null;
      await this.audit(tx, 'RETRY_OUTBOX_EVENT', 'EVENT_OUTBOX', eventId, event ? 'QUEUED' : 'NOT_ACTIONABLE', correlationId, {
        prior_state_required: ['FAILED_RETRYABLE', 'DEAD_LETTER'],
        operator_id: operatorId ?? null,
        source: 'OPERATIONS_SERVICE',
      });
      return event;
    });
  }

  async retryDelivery(deliveryId: string, correlationId: string): Promise<InternalDelivery | null> {
    return this.db.transaction(async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `UPDATE push_deliveries pd
         SET status = 'PENDING', next_attempt_at = NOW(), last_error = NULL, updated_at = NOW()
         WHERE pd.id = $1 AND pd.status IN ('FAILED_RETRYABLE', 'DEAD_LETTER')
         RETURNING pd.id, pd.notification_id, pd.status::text, pd.attempt_count, pd.next_attempt_at, pd.sent_at,
                   pd.delivered_at, pd.created_at, pd.updated_at,
                   (SELECT n.user_id FROM notifications n WHERE n.id = pd.notification_id) AS user_id,
                   (SELECT d.platform::text FROM push_devices d WHERE d.id = pd.device_id) AS platform`,
        [deliveryId],
      );
      const delivery = result.rows[0] ? mapDelivery(result.rows[0]) : null;
      await this.audit(tx, 'RETRY_PUSH_DELIVERY', 'PUSH_DELIVERY', deliveryId, delivery ? 'QUEUED' : 'NOT_ACTIONABLE', correlationId, {
        prior_state_required: ['FAILED_RETRYABLE', 'DEAD_LETTER'],
      });
      return delivery;
    });
  }

  private async audit(
    executor: SqlExecutor,
    action: string,
    targetType: string,
    targetId: string,
    outcome: string,
    correlationId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await executor.query(
      `INSERT INTO internal_operation_audits (
         id, action, target_type, target_id, outcome, correlation_id, metadata_json, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [newId(), action, targetType, targetId, outcome, correlationId, JSON.stringify(metadata), this.clock.now()],
    );
  }
}
