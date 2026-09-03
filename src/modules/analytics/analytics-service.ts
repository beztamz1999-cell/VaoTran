import { createHash } from 'node:crypto';
import type { PostgresDatabase, Transaction } from '../../platform/database/db.js';
import { logger, newId, systemClock, type Clock } from '../../platform/core.js';
import type { DomainEvent, OutboxConsumer } from '../../platform/outbox/outbox.js';
import { metrics } from '../../platform/observability/metrics.js';
import { analyticsKey } from '../../platform/analytics/privacy.js';

export interface AnalyticsWindow {
  from: Date;
  to: Date;
  sportCode?: string;
  areaBucket?: string;
}

export interface ExperimentAssignmentInput {
  userId: string;
  experimentKey: string;
  variants: string[];
}

export interface ExperimentExposureInput {
  userId: string;
  experimentKey: string;
  variantKey: string;
  exposureKey: string;
}

const asString = (payload: Record<string, unknown>, key: string): string | null =>
  typeof payload[key] === 'string' && payload[key].trim() ? payload[key].trim() : null;

const asInteger = (payload: Record<string, unknown>, key: string): number | null =>
  typeof payload[key] === 'number' && Number.isInteger(payload[key]) ? payload[key] : null;

const eventRoomId = (event: DomainEvent): string | null =>
  asString(event.payload, 'room_id') ?? (event.aggregateType === 'ROOM' ? event.aggregateId : null);

const roomKeyFor = (event: DomainEvent): string | null => analyticsKey('room', eventRoomId(event));
const userKeyFor = (userId: string | null | undefined): string | null => analyticsKey('user', userId);
const appKeyFor = (applicationId: string | null | undefined): string | null => analyticsKey('application', applicationId);
const participantKeyFor = (participantId: string | null | undefined): string | null => analyticsKey('participant', participantId);

const validDimension = (value: string | null): string | null => value && /^[A-Z0-9_\-.]{1,64}$/i.test(value) ? value : null;
const validHour = (value: number | null): number | null => value !== null && value >= 0 && value <= 23 ? value : null;

const defaultWindow = (clock: Clock): AnalyticsWindow => {
  const to = clock.now();
  return { from: new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000), to };
};

const normalizedExperimentKey = (value: string): string => {
  const key = value.trim();
  if (!/^[A-Za-z0-9_.-]{1,96}$/.test(key)) throw new Error('experiment_key is invalid.');
  return key;
};

const normalizedVariant = (value: string): string => {
  const variant = value.trim();
  if (!/^[A-Za-z0-9_.-]{1,96}$/.test(variant)) throw new Error('variant_key is invalid.');
  return variant;
};

const ANALYTICS_CONSUMER_NAME = 'analytics-consumer-v1';
const SUPPORTED_EVENT_VERSION = 1;
const SUPPORTED_PAYLOAD_SCHEMA_VERSION = 1;

/** Events currently understood by the analytics read-side. Known-but-not-projected events are intentionally no-ops. */
const knownEventTypes = new Set([
  'ROOM_CREATED', 'ROOM_PUBLISHED', 'ROOM_SHARE_CREATED', 'ROOM_BECAME_FULL', 'ROOM_REOPENED', 'ROOM_UPDATED', 'ROOM_MATERIAL_CHANGED',
  'ROOM_MANUALLY_STARTED', 'ROOM_AUTO_STARTED', 'ROOM_CANCELLED', 'ROOM_COMPLETED', 'REPEAT_ROOM_CREATED',
  'JOIN_REQUEST_CREATED', 'JOIN_REQUEST_WAITLISTED', 'JOIN_REQUEST_ACCEPTED', 'JOIN_REQUEST_REJECTED', 'JOIN_REQUEST_WITHDRAWN', 'JOIN_REQUEST_EXPIRED',
  'PARTICIPANT_CREATED', 'PLAYER_EARLY_CANCELLED', 'PLAYER_LATE_CANCELLED', 'PLAYER_REMOVED_BY_HOST', 'PLAYER_MARKED_PRESENT', 'PLAYER_NO_SHOW', 'ATTENDANCE_CORRECTED',
  'PARTY_CREATED', 'PARTY_MEMBER_INVITED', 'PARTY_MEMBER_CONFIRMED', 'PARTY_MEMBER_DECLINED', 'PARTY_BECAME_READY', 'PARTY_CLOSED', 'GUEST_ADDED', 'GUEST_CLAIMED',
  'VALID_SKILL_RATING_SUBMITTED', 'PLAYER_CALIBRATION_STARTED', 'PLAYER_CALIBRATION_PROGRESS_UPDATED', 'PLAYER_INITIAL_RANK_PUBLISHED',
  'PLAYER_SKILL_SCORE_UPDATED', 'PLAYER_RANK_PROMOTED', 'PLAYER_RANK_DEMOTED', 'RATING_OUTLIER_DETECTED', 'TOP_TIER_REACHED',
  'PLAYER_RELIABILITY_ADJUSTED', 'HOST_RELIABILITY_ADJUSTED', 'RELIABILITY_RECOVERY_APPLIED',
  'PUBLIC_SLOT_OPENED', 'EMERGENCY_REFILL_STARTED', 'EMERGENCY_REFILL_STOPPED', 'REPLACEMENT_CANDIDATE_AVAILABLE', 'REPLACEMENT_ACCEPTED', 'PUBLIC_SLOT_RECOVERED', 'SLOT_RECOVERY_EXPIRED',
  'NOTIFICATION_CREATED', 'PUSH_DELIVERY_SUCCEEDED', 'PUSH_DELIVERY_FAILED',
  'SEARCH_EXECUTED', 'ROOM_CARD_VIEWED', 'ROOM_DETAIL_VIEWED', 'SHARE_VIEWED', 'USER_REGISTERED',
]);

type ProjectionOutcome = 'applied' | 'deduplicated' | 'unknown';

export interface AnalyticsValidationFinding {
  checkName: string;
  severity: 'INFO' | 'WARNING' | 'ERROR';
  findingCount: number;
  details: Record<string, unknown>;
}

export interface AnalyticsValidationReport {
  runId: string;
  status: 'PASSED' | 'FAILED';
  startedAt: string;
  completedAt: string;
  findings: AnalyticsValidationFinding[];
}

export interface AnalyticsConsumerHealth {
  consumerName: string;
  processedEventCount: number;
  failedProjectionCount: number;
  unknownEventCount: number;
  lastProcessedEventTime: string | null;
  lastFailureAt: string | null;
  lastFailureCode: string | null;
  updatedAt: string;
}

export class AnalyticsConsumer implements OutboxConsumer {
  readonly name = ANALYTICS_CONSUMER_NAME;

  constructor(private readonly analytics: AnalyticsService) {}

  async handle(event: DomainEvent): Promise<void> {
    await this.analytics.project(event);
  }
}

/**
 * Read-side M10 projection. It never writes authoritative product tables and may be
 * rebuilt from event_outbox without repairing or changing any business fact.
 */
export class AnalyticsService {
  constructor(private readonly db: PostgresDatabase, private readonly clock: Clock = systemClock) {}

  /**
   * Projects one immutable outbox event. Legacy rows without explicit M11 versions are
   * interpreted as event v1 / payload v1. Unsupported versions are recorded and safely
   * ignored, so a producer rollout cannot corrupt or block the analytics read-side.
   */
  async project(event: DomainEvent): Promise<boolean> {
    const startedAt = performance.now();
    const eventVersion = event.eventVersion ?? 1;
    const payloadSchemaVersion = event.payloadSchemaVersion ?? 1;
    let outcome: ProjectionOutcome = 'deduplicated';
    try {
      outcome = await this.db.transaction(async (tx) => {
        const claim = await tx.query<{ event_id: string }>(
          `INSERT INTO analytics_processed_events (event_id, event_type, event_version, payload_schema_version, processed_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (event_id) DO NOTHING
           RETURNING event_id`,
          [event.id, event.eventType, eventVersion, payloadSchemaVersion, this.clock.now()],
        );
        if (!claim.rowCount) return 'deduplicated';
        if (!this.isSupported(event)) {
          await this.bumpHealth(tx, { unknown: 1, lastProcessedAt: event.occurredAt });
          return 'unknown';
        }
        await this.projectClaimed(tx, { ...event, eventVersion, payloadSchemaVersion });
        await this.bumpHealth(tx, { processed: 1, lastProcessedAt: event.occurredAt });
        return 'applied';
      });
      const lagSeconds = Math.max(0, (this.clock.now().getTime() - event.occurredAt.getTime()) / 1000);
      metrics.increment('vaotran_analytics_events_processed_total', { event_type: event.eventType, outcome });
      if (outcome === 'unknown') metrics.increment('vaotran_analytics_unknown_events_total', { event_type: event.eventType, event_version: eventVersion });
      metrics.setGauge('vaotran_analytics_consumer_lag_seconds', lagSeconds, { consumer: ANALYTICS_CONSUMER_NAME });
      metrics.observe('vaotran_analytics_projection_duration_ms', performance.now() - startedAt, { event_type: event.eventType, outcome });
      return outcome === 'applied';
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown analytics projection error';
      await this.recordProjectionFailure(event, eventVersion, payloadSchemaVersion, 'PROJECTION_FAILED', message);
      metrics.increment('vaotran_analytics_failed_projections_total', { event_type: event.eventType, event_version: eventVersion });
      metrics.observe('vaotran_analytics_projection_duration_ms', performance.now() - startedAt, { event_type: event.eventType, outcome: 'failed' });
      logger.warn({ component: 'analytics', event_id: event.id, event_type: event.eventType, event_version: eventVersion, payload_schema_version: payloadSchemaVersion, correlation_id: event.correlationId, err: error }, 'Analytics projection failed');
      throw error;
    }
  }

  private isSupported(event: DomainEvent): boolean {
    return knownEventTypes.has(event.eventType)
      && (event.eventVersion ?? 1) === SUPPORTED_EVENT_VERSION
      && (event.payloadSchemaVersion ?? 1) === SUPPORTED_PAYLOAD_SCHEMA_VERSION;
  }

  private async bumpHealth(
    tx: Transaction,
    input: { processed?: number; unknown?: number; failed?: number; lastProcessedAt?: Date; failureCode?: string },
  ): Promise<void> {
    const now = this.clock.now();
    await tx.query(
      `INSERT INTO analytics_consumer_health (
         consumer_name, processed_event_count, failed_projection_count, unknown_event_count,
         last_processed_event_time, last_failure_at, last_failure_code, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (consumer_name) DO UPDATE SET
         processed_event_count = analytics_consumer_health.processed_event_count + EXCLUDED.processed_event_count,
         failed_projection_count = analytics_consumer_health.failed_projection_count + EXCLUDED.failed_projection_count,
         unknown_event_count = analytics_consumer_health.unknown_event_count + EXCLUDED.unknown_event_count,
         last_processed_event_time = CASE
           WHEN EXCLUDED.last_processed_event_time IS NULL THEN analytics_consumer_health.last_processed_event_time
           WHEN analytics_consumer_health.last_processed_event_time IS NULL THEN EXCLUDED.last_processed_event_time
           ELSE GREATEST(analytics_consumer_health.last_processed_event_time, EXCLUDED.last_processed_event_time)
         END,
         last_failure_at = COALESCE(EXCLUDED.last_failure_at, analytics_consumer_health.last_failure_at),
         last_failure_code = COALESCE(EXCLUDED.last_failure_code, analytics_consumer_health.last_failure_code),
         updated_at = EXCLUDED.updated_at`,
      [
        ANALYTICS_CONSUMER_NAME, input.processed ?? 0, input.failed ?? 0, input.unknown ?? 0,
        input.lastProcessedAt ?? null, input.failed ? now : null, input.failureCode ?? null, now,
      ],
    );
  }

  private async recordProjectionFailure(
    event: DomainEvent,
    eventVersion: number,
    payloadSchemaVersion: number,
    failureCode: string,
    _failureMessage: string,
  ): Promise<void> {
    try {
      await this.db.transaction(async (tx) => {
        const failedAt = this.clock.now();
        await tx.query(
          `INSERT INTO analytics_projection_failures (
             id, event_id, event_type, event_version, payload_schema_version, failure_code, failure_summary, occurred_at, failed_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (event_id, failure_code) DO UPDATE SET failed_at = EXCLUDED.failed_at, failure_summary = EXCLUDED.failure_summary`,
          [newId(), event.id, event.eventType, eventVersion, payloadSchemaVersion, failureCode, 'Projection failed; inspect correlation-safe logs.', event.occurredAt, failedAt],
        );
        await this.bumpHealth(tx, { failed: 1, failureCode });
      });
    } catch (recordError) {
      logger.error({ component: 'analytics', event_id: event.id, err: recordError }, 'Failed to record analytics projection failure');
    }
  }

  /**
   * Manual, derived-only rebuild. It never touches event_outbox or canonical product tables.
   * The persisted comparison is operational evidence; it does not auto-correct a detected drift.
   */
  async rebuildFromOutbox(): Promise<{ replayed: number; applied: number }> {
    const runId = newId();
    const startedAt = this.clock.now();
    const before = await this.aggregateSnapshot();
    try {
      await this.db.transaction(async (tx) => {
        await tx.query(`TRUNCATE analytics_processed_events, analytics_activity_events, analytics_completed_participations,
          analytics_participant_facts, analytics_application_facts, analytics_room_facts, analytics_user_profiles`);
      });
      const events = await this.db.query<{
        id: string; event_type: string; aggregate_type: string; aggregate_id: string; actor_user_id: string | null;
        correlation_id: string | null; causation_id: string | null; schema_version: number; event_version: number; payload_schema_version: number; payload_json: Record<string, unknown>; occurred_at: Date;
      }>(`SELECT id, event_type, aggregate_type, aggregate_id, actor_user_id, correlation_id, causation_id,
                schema_version, event_version, payload_schema_version, payload_json, occurred_at
         FROM event_outbox ORDER BY occurred_at ASC, id ASC`);
      let applied = 0;
      for (const row of events.rows) {
        if (await this.project({
          id: row.id, eventType: row.event_type, aggregateType: row.aggregate_type, aggregateId: row.aggregate_id,
          actorUserId: row.actor_user_id, correlationId: row.correlation_id, causationId: row.causation_id,
          schemaVersion: row.schema_version, eventVersion: row.event_version ?? 1, payloadSchemaVersion: row.payload_schema_version ?? 1,
          payload: row.payload_json, occurredAt: row.occurred_at,
        })) applied += 1;
      }
      const after = await this.aggregateSnapshot();
      const drift = Object.fromEntries(Object.keys(before).filter((key) => before[key] !== after[key]).map((key) => [key, { before: before[key], after: after[key] }]));
      const status = Object.keys(drift).length === 0 ? 'PASSED' : 'DRIFT';
      const completedAt = this.clock.now();
      await this.db.query(
        `INSERT INTO analytics_rebuild_runs (
           id, status, started_at, completed_at, replayed_event_count, applied_event_count, before_metrics_json, after_metrics_json, drift_json, error_code
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,NULL)`,
        [runId, status, startedAt, completedAt, events.rowCount ?? events.rows.length, applied, JSON.stringify(before), JSON.stringify(after), JSON.stringify(drift)],
      );
      metrics.increment('vaotran_analytics_rebuild_total', { outcome: status.toLowerCase() });
      metrics.setGauge('vaotran_analytics_rebuild_drift_metric_count', Object.keys(drift).length);
      return { replayed: events.rowCount ?? events.rows.length, applied };
    } catch (error) {
      const completedAt = this.clock.now();
      await this.db.query(
        `INSERT INTO analytics_rebuild_runs (
           id, status, started_at, completed_at, replayed_event_count, applied_event_count, before_metrics_json, after_metrics_json, drift_json, error_code
         ) VALUES ($1,'ERROR',$2,$3,0,0,$4::jsonb,'{}'::jsonb,'{}'::jsonb,'REBUILD_FAILED')`,
        [runId, startedAt, completedAt, JSON.stringify(before)],
      );
      metrics.increment('vaotran_analytics_rebuild_total', { outcome: 'failed' });
      logger.error({ component: 'analytics', rebuild_run_id: runId, err: error }, 'Analytics derived rebuild failed');
      throw error;
    }
  }

  private async aggregateSnapshot(): Promise<Record<string, number>> {
    const result = await this.db.query<{
      processed_events: string; rooms: string; applications: string; participants: string; completed_participations: string; activity_events: string; user_profiles: string;
    }>(`SELECT
        (SELECT COUNT(*)::text FROM analytics_processed_events) AS processed_events,
        (SELECT COUNT(*)::text FROM analytics_room_facts) AS rooms,
        (SELECT COUNT(*)::text FROM analytics_application_facts) AS applications,
        (SELECT COUNT(*)::text FROM analytics_participant_facts) AS participants,
        (SELECT COUNT(*)::text FROM analytics_completed_participations) AS completed_participations,
        (SELECT COUNT(*)::text FROM analytics_activity_events) AS activity_events,
        (SELECT COUNT(*)::text FROM analytics_user_profiles) AS user_profiles`);
    const row = result.rows[0];
    return {
      processed_events: Number(row?.processed_events ?? 0), rooms: Number(row?.rooms ?? 0), applications: Number(row?.applications ?? 0),
      participants: Number(row?.participants ?? 0), completed_participations: Number(row?.completed_participations ?? 0),
      activity_events: Number(row?.activity_events ?? 0), user_profiles: Number(row?.user_profiles ?? 0),
    };
  }

  async getConsumerHealth(): Promise<AnalyticsConsumerHealth> {
    const result = await this.db.query<{
      consumer_name: string; processed_event_count: string; failed_projection_count: string; unknown_event_count: string;
      last_processed_event_time: Date | null; last_failure_at: Date | null; last_failure_code: string | null; updated_at: Date;
    }>(
      `SELECT consumer_name, processed_event_count::text, failed_projection_count::text, unknown_event_count::text,
              last_processed_event_time, last_failure_at, last_failure_code, updated_at
       FROM analytics_consumer_health WHERE consumer_name = $1`,
      [ANALYTICS_CONSUMER_NAME],
    );
    const row = result.rows[0];
    const now = this.clock.now();
    return {
      consumerName: ANALYTICS_CONSUMER_NAME,
      processedEventCount: Number(row?.processed_event_count ?? 0),
      failedProjectionCount: Number(row?.failed_projection_count ?? 0),
      unknownEventCount: Number(row?.unknown_event_count ?? 0),
      lastProcessedEventTime: row?.last_processed_event_time?.toISOString() ?? null,
      lastFailureAt: row?.last_failure_at?.toISOString() ?? null,
      lastFailureCode: row?.last_failure_code ?? null,
      updatedAt: row?.updated_at?.toISOString() ?? now.toISOString(),
    };
  }

  /**
   * Performs read-side checks only. Results are immutable operational evidence and are
   * deliberately not a repair mechanism for projections or canonical product data.
   */
  async validateProjection(): Promise<AnalyticsValidationReport> {
    const startedAt = this.clock.now();
    const [duplicateProcessed, invalidHealth, completedWithoutSource, acceptedWithoutSource, invalidPseudonym, forbiddenColumns] = await Promise.all([
      this.db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM (
           SELECT event_id FROM analytics_processed_events GROUP BY event_id HAVING COUNT(*) > 1
         ) duplicates`,
      ),
      this.db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM analytics_consumer_health
         WHERE processed_event_count < 0 OR failed_projection_count < 0 OR unknown_event_count < 0`,
      ),
      this.db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM analytics_completed_participations cp
         LEFT JOIN event_outbox source ON source.id = cp.completion_source_event_id AND source.event_type = 'ROOM_COMPLETED'
         WHERE cp.completion_source_event_id IS NULL OR source.id IS NULL`,
      ),
      this.db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM analytics_application_facts ap
         LEFT JOIN event_outbox source ON source.id = ap.accepted_source_event_id AND source.event_type = 'JOIN_REQUEST_ACCEPTED'
         WHERE ap.accepted_at IS NOT NULL AND (ap.accepted_source_event_id IS NULL OR source.id IS NULL)`,
      ),
      this.db.query<{ count: string }>(
        `WITH keys AS (
           SELECT host_key AS value FROM analytics_room_facts UNION ALL
           SELECT room_key FROM analytics_room_facts UNION ALL
           SELECT repeated_from_room_key FROM analytics_room_facts UNION ALL
           SELECT application_key FROM analytics_application_facts UNION ALL
           SELECT room_key FROM analytics_application_facts UNION ALL
           SELECT requester_key FROM analytics_application_facts UNION ALL
           SELECT participant_key FROM analytics_participant_facts UNION ALL
           SELECT room_key FROM analytics_participant_facts UNION ALL
           SELECT user_key FROM analytics_participant_facts UNION ALL
           SELECT room_key FROM analytics_completed_participations UNION ALL
           SELECT user_key FROM analytics_completed_participations UNION ALL
           SELECT user_key FROM analytics_user_profiles UNION ALL
           SELECT actor_key FROM analytics_activity_events UNION ALL
           SELECT room_key FROM analytics_activity_events
         ) SELECT COUNT(*)::text AS count FROM keys
         WHERE value IS NOT NULL AND value <> 'UNATTRIBUTED' AND value !~ '^[0-9a-f]{64}$'`,
      ),
      this.db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name LIKE 'analytics\\_%' ESCAPE '\\'
           AND lower(column_name) ~ '(phone|email|address|message|latitude|longitude|(^|_)lat(_|$)|(^|_)lon(_|$)|raw_.*(id|identifier)|user_id|actor_user|host_user)'`,
      ),
    ]);

    const finding = (checkName: string, count: number, details: Record<string, unknown> = {}): AnalyticsValidationFinding => ({
      checkName, severity: count > 0 ? 'ERROR' : 'INFO', findingCount: count, details,
    });
    const findings = [
      finding('processed_event_duplicates', Number(duplicateProcessed.rows[0]?.count ?? 0)),
      finding('consumer_counter_nonnegative', Number(invalidHealth.rows[0]?.count ?? 0)),
      finding('completed_participation_source_event', Number(completedWithoutSource.rows[0]?.count ?? 0), { expected_event_type: 'ROOM_COMPLETED' }),
      finding('accepted_application_source_event', Number(acceptedWithoutSource.rows[0]?.count ?? 0), { expected_event_type: 'JOIN_REQUEST_ACCEPTED' }),
      finding('pseudonymous_identity_keys', Number(invalidPseudonym.rows[0]?.count ?? 0), { expected_key_shape: '64-char lowercase HMAC hex' }),
      finding('forbidden_privacy_schema_columns', Number(forbiddenColumns.rows[0]?.count ?? 0)),
    ];
    const status: AnalyticsValidationReport['status'] = findings.some((item) => item.severity === 'ERROR') ? 'FAILED' : 'PASSED';
    const completedAt = this.clock.now();
    const runId = newId();
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO analytics_validation_runs (id, validation_kind, status, started_at, completed_at, summary_json)
         VALUES ($1,'PROJECTION_INTEGRITY',$2,$3,$4,$5::jsonb)`,
        [runId, status, startedAt, completedAt, JSON.stringify({ finding_count: findings.length, error_finding_count: findings.filter((item) => item.severity === 'ERROR').length })],
      );
      for (const item of findings) {
        await tx.query(
          `INSERT INTO analytics_validation_findings (id, run_id, check_name, severity, finding_count, details_json, created_at)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
          [newId(), runId, item.checkName, item.severity, item.findingCount, JSON.stringify(item.details), completedAt],
        );
      }
    });
    metrics.increment('vaotran_analytics_validation_runs_total', { outcome: status.toLowerCase() });
    metrics.setGauge('vaotran_analytics_validation_error_findings', findings.filter((item) => item.severity === 'ERROR').length);
    return { runId, status, startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(), findings };
  }

  async getFunnel(input: Partial<AnalyticsWindow> = {}): Promise<Record<string, unknown>> {
    const window = this.window(input);
    const filters = this.dimensionFilters(window, 'a');
    const roomFilters = this.dimensionFilters(window, 'r');
    const [host, player, share] = await Promise.all([
      this.db.query<{ created: string; published: string; first_application: string; filled: string; completed: string }>(
        `SELECT COUNT(*) FILTER (WHERE created_at >= $1 AND created_at < $2)::text AS created,
                COUNT(*) FILTER (WHERE published_at >= $1 AND published_at < $2)::text AS published,
                COUNT(*) FILTER (WHERE first_application_at >= $1 AND first_application_at < $2)::text AS first_application,
                COUNT(*) FILTER (WHERE filled_at >= $1 AND filled_at < $2)::text AS filled,
                COUNT(*) FILTER (WHERE completed_at >= $1 AND completed_at < $2)::text AS completed
         FROM analytics_room_facts r WHERE 1 = 1 ${roomFilters.sql}`,
        [window.from, window.to, ...roomFilters.values],
      ),
      this.db.query<{ searched: string; detail_viewed: string; join_created: string; join_accepted: string; present: string; completed: string }>(
        `SELECT COUNT(*) FILTER (WHERE event_type = 'SEARCH_EXECUTED')::text AS searched,
                COUNT(*) FILTER (WHERE event_type = 'ROOM_DETAIL_VIEWED')::text AS detail_viewed,
                COUNT(*) FILTER (WHERE event_type = 'JOIN_REQUEST_CREATED')::text AS join_created,
                COUNT(*) FILTER (WHERE event_type = 'JOIN_REQUEST_ACCEPTED')::text AS join_accepted,
                COUNT(*) FILTER (WHERE event_type = 'PLAYER_MARKED_PRESENT')::text AS present,
                (SELECT COUNT(*)::text FROM analytics_completed_participations cp WHERE cp.completed_at >= $1 AND cp.completed_at < $2) AS completed
         FROM analytics_activity_events a
         WHERE a.occurred_at >= $1 AND a.occurred_at < $2 ${filters.sql}`,
        [window.from, window.to, ...filters.values],
      ),
      this.db.query<{ share_created: string; share_viewed: string; registered: string; share_enabled_room_join_requests: string }>(
        `SELECT
          (SELECT COUNT(*)::text FROM analytics_room_facts r WHERE r.share_created_at >= $1 AND r.share_created_at < $2 ${roomFilters.sql}) AS share_created,
          (SELECT COUNT(*)::text FROM analytics_activity_events a WHERE a.event_type = 'SHARE_VIEWED' AND a.occurred_at >= $1 AND a.occurred_at < $2) AS share_viewed,
          (SELECT COUNT(*)::text FROM analytics_activity_events a WHERE a.event_type = 'USER_REGISTERED' AND a.occurred_at >= $1 AND a.occurred_at < $2) AS registered,
          (SELECT COUNT(*)::text FROM analytics_application_facts ap JOIN analytics_room_facts r ON r.room_key = ap.room_key
            WHERE ap.created_at >= $1 AND ap.created_at < $2 AND r.share_created_at IS NOT NULL ${roomFilters.sql}) AS share_enabled_room_join_requests`,
        [window.from, window.to, ...roomFilters.values],
      ),
    ]);
    return {
      window: this.windowDto(window),
      host: this.numericRow(host.rows[0]),
      player: this.numericRow(player.rows[0]),
      share: {
        ...this.numericRow(share.rows[0]),
        attribution: 'Anonymous share views are intentionally not linked to later registration or join actions without a consented identity/session bridge.',
      },
    };
  }

  async getHostPerformance(input: Partial<AnalyticsWindow> = {}): Promise<Record<string, unknown>[]> {
    const window = this.window(input);
    const filters = this.dimensionFilters(window, 'r');
    const result = await this.db.query<{
      host_key: string | null; rooms_created: string; rooms_published: string; rooms_filled: string; rooms_completed: string; rooms_cancelled: string; repeated_rooms: string;
      avg_minutes_to_first_application: string | null; avg_minutes_to_fill: string | null;
    }>(
      `SELECT COALESCE(host_key, 'UNATTRIBUTED') AS host_key,
              COUNT(*)::text AS rooms_created,
              COUNT(*) FILTER (WHERE published_at IS NOT NULL)::text AS rooms_published,
              COUNT(*) FILTER (WHERE filled_at IS NOT NULL)::text AS rooms_filled,
              COUNT(*) FILTER (WHERE completed_at IS NOT NULL)::text AS rooms_completed,
              COUNT(*) FILTER (WHERE cancelled_at IS NOT NULL)::text AS rooms_cancelled,
              COUNT(*) FILTER (WHERE repeated_from_room_key IS NOT NULL)::text AS repeated_rooms,
              AVG(EXTRACT(EPOCH FROM (first_application_at - published_at)) / 60) FILTER (WHERE first_application_at IS NOT NULL AND published_at IS NOT NULL) AS avg_minutes_to_first_application,
              AVG(EXTRACT(EPOCH FROM (filled_at - published_at)) / 60) FILTER (WHERE filled_at IS NOT NULL AND published_at IS NOT NULL) AS avg_minutes_to_fill
       FROM analytics_room_facts r
       WHERE r.created_at >= $1 AND r.created_at < $2 ${filters.sql}
       GROUP BY host_key ORDER BY rooms_created DESC, host_key ASC`,
      [window.from, window.to, ...filters.values],
    );
    return result.rows.map((row) => ({
      host_key: row.host_key, rooms_created: Number(row.rooms_created), rooms_published: Number(row.rooms_published),
      publish_rate: this.rate(row.rooms_published, row.rooms_created), rooms_filled: Number(row.rooms_filled),
      fill_rate: this.rate(row.rooms_filled, row.rooms_published), rooms_completed: Number(row.rooms_completed),
      completion_rate: this.rate(row.rooms_completed, row.rooms_published), rooms_cancelled: Number(row.rooms_cancelled),
      cancellation_rate: this.rate(row.rooms_cancelled, row.rooms_published), repeated_rooms: Number(row.repeated_rooms),
      repeat_room_rate: this.rate(row.repeated_rooms, row.rooms_completed),
      avg_minutes_to_first_application: this.decimal(row.avg_minutes_to_first_application), avg_minutes_to_fill: this.decimal(row.avg_minutes_to_fill),
    }));
  }

  async getPlayerRetention(input: Partial<AnalyticsWindow> = {}): Promise<Record<string, unknown>> {
    const window = this.window(input);
    const filters = this.dimensionFilters(window, 'c');
    const result = await this.db.query<{
      cohort_day: Date; sport_code: string | null; area_bucket: string | null; active_players: string;
      eligible_d1: string; retained_d1: string; eligible_d7: string; retained_d7: string; eligible_d30: string; retained_d30: string; repeat_participants: string;
    }>(
      `WITH cohort AS (
         SELECT user_key, first_active_at, last_active_at, first_sport_code, first_area_bucket
         FROM analytics_user_profiles c
         WHERE first_active_at >= $1 AND first_active_at < $2 ${filters.sql}
       ), repeats AS (
         SELECT user_key FROM analytics_completed_participations GROUP BY user_key HAVING COUNT(*) >= 2
       )
       SELECT date_trunc('day', c.first_active_at) AS cohort_day, c.first_sport_code AS sport_code, c.first_area_bucket AS area_bucket,
              COUNT(*)::text AS active_players,
              COUNT(*) FILTER (WHERE c.first_active_at <= $2 - INTERVAL '1 day')::text AS eligible_d1,
              COUNT(*) FILTER (WHERE c.first_active_at <= $2 - INTERVAL '1 day' AND c.last_active_at >= c.first_active_at + INTERVAL '1 day')::text AS retained_d1,
              COUNT(*) FILTER (WHERE c.first_active_at <= $2 - INTERVAL '7 days')::text AS eligible_d7,
              COUNT(*) FILTER (WHERE c.first_active_at <= $2 - INTERVAL '7 days' AND c.last_active_at >= c.first_active_at + INTERVAL '7 days')::text AS retained_d7,
              COUNT(*) FILTER (WHERE c.first_active_at <= $2 - INTERVAL '30 days')::text AS eligible_d30,
              COUNT(*) FILTER (WHERE c.first_active_at <= $2 - INTERVAL '30 days' AND c.last_active_at >= c.first_active_at + INTERVAL '30 days')::text AS retained_d30,
              COUNT(*) FILTER (WHERE r.user_key IS NOT NULL)::text AS repeat_participants
       FROM cohort c LEFT JOIN repeats r ON r.user_key = c.user_key
       GROUP BY date_trunc('day', c.first_active_at), c.first_sport_code, c.first_area_bucket
       ORDER BY cohort_day ASC, sport_code ASC NULLS LAST, area_bucket ASC NULLS LAST`,
      [window.from, window.to, ...filters.values],
    );
    return {
      window: this.windowDto(window),
      retention_definition: 'A retained user has any later eligible M10 activity on or after the specified day threshold; incomplete cohorts are excluded from each denominator.',
      cohorts: result.rows.map((row) => ({
        cohort_day: row.cohort_day.toISOString().slice(0, 10), sport_code: row.sport_code, area_bucket: row.area_bucket,
        active_players: Number(row.active_players), eligible_d1: Number(row.eligible_d1), retained_d1: Number(row.retained_d1), d1_rate: this.rate(row.retained_d1, row.eligible_d1),
        eligible_d7: Number(row.eligible_d7), retained_d7: Number(row.retained_d7), d7_rate: this.rate(row.retained_d7, row.eligible_d7),
        eligible_d30: Number(row.eligible_d30), retained_d30: Number(row.retained_d30), d30_rate: this.rate(row.retained_d30, row.eligible_d30),
        repeat_participants: Number(row.repeat_participants), repeat_participation_rate: this.rate(row.repeat_participants, row.active_players),
      })),
    };
  }

  async getMarketplaceHealth(input: Partial<AnalyticsWindow> = {}): Promise<Record<string, unknown>> {
    const window = this.window(input);
    const result = await this.db.query<{
      sport_code: string | null; area_bucket: string | null; scheduled_hour_utc: number | null; published_rooms: string; searches: string; zero_result_searches: string; join_requests: string; searchers: string; searchers_who_applied: string;
    }>(
      `WITH slices AS (
         SELECT sport_code, area_bucket, scheduled_hour_utc,
                COUNT(*)::bigint AS published_rooms, 0::bigint AS searches, 0::bigint AS zero_result_searches,
                0::bigint AS join_requests, 0::bigint AS searchers, 0::bigint AS searchers_who_applied
         FROM analytics_room_facts
         WHERE published_at >= $1 AND published_at < $2
         GROUP BY sport_code, area_bucket, scheduled_hour_utc
         UNION ALL
         SELECT sport_code, area_bucket, scheduled_hour_utc,
                0::bigint, COUNT(*)::bigint, COUNT(*) FILTER (WHERE result_count = 0)::bigint,
                0::bigint, COUNT(DISTINCT actor_key) FILTER (WHERE actor_key IS NOT NULL)::bigint, 0::bigint
         FROM analytics_activity_events
         WHERE occurred_at >= $1 AND occurred_at < $2 AND event_type = 'SEARCH_EXECUTED'
         GROUP BY sport_code, area_bucket, scheduled_hour_utc
         UNION ALL
         SELECT r.sport_code, r.area_bucket, r.scheduled_hour_utc,
                0::bigint, 0::bigint, 0::bigint, COUNT(*)::bigint, 0::bigint,
                COUNT(DISTINCT ap.requester_key) FILTER (WHERE ap.requester_key IS NOT NULL AND EXISTS (
                  SELECT 1 FROM analytics_activity_events s WHERE s.event_type = 'SEARCH_EXECUTED' AND s.actor_key = ap.requester_key
                    AND s.occurred_at >= $1 AND s.occurred_at <= ap.created_at
                ))::bigint
         FROM analytics_application_facts ap
         LEFT JOIN analytics_room_facts r ON r.room_key = ap.room_key
         WHERE ap.created_at >= $1 AND ap.created_at < $2
         GROUP BY r.sport_code, r.area_bucket, r.scheduled_hour_utc
       )
       SELECT sport_code, area_bucket, scheduled_hour_utc,
              SUM(published_rooms)::text AS published_rooms, SUM(searches)::text AS searches,
              SUM(zero_result_searches)::text AS zero_result_searches, SUM(join_requests)::text AS join_requests,
              SUM(searchers)::text AS searchers, SUM(searchers_who_applied)::text AS searchers_who_applied
       FROM slices
       GROUP BY sport_code, area_bucket, scheduled_hour_utc
       ORDER BY sport_code ASC NULLS LAST, area_bucket ASC NULLS LAST, scheduled_hour_utc ASC NULLS LAST`,
      [window.from, window.to],
    );
    const slices = result.rows.map((row) => {
      const published = Number(row.published_rooms); const searches = Number(row.searches); const joins = Number(row.join_requests);
      const imbalance = searches + joins;
      const alert = imbalance > 0 && (published === 0 || imbalance / Math.max(published, 1) >= 3)
        ? 'LOW_SUPPLY_HIGH_DEMAND'
        : published >= 3 && imbalance === 0 ? 'EXCESS_SUPPLY_LOW_DEMAND' : null;
      return {
        sport_code: row.sport_code, area_bucket: row.area_bucket, scheduled_hour_utc: row.scheduled_hour_utc,
        published_rooms: published, searches, zero_result_searches: Number(row.zero_result_searches),
        empty_search_rate: this.rate(row.zero_result_searches, row.searches), join_requests: joins,
        searchers: Number(row.searchers), searchers_who_applied: Number(row.searchers_who_applied),
        search_to_join_user_rate: this.rate(row.searchers_who_applied, row.searchers), alert,
      };
    });
    const filteredSlices = slices.filter((slice) =>
      (!window.sportCode || slice.sport_code === window.sportCode) &&
      (!window.areaBucket || slice.area_bucket === window.areaBucket),
    );
    return { window: this.windowDto(window), detection_rule: 'LOW_SUPPLY_HIGH_DEMAND when demand exists and either supply is zero or demand/supply is at least 3; detection is reporting-only.', slices: filteredSlices };
  }

  async assignExperiment(input: ExperimentAssignmentInput): Promise<{ experimentKey: string; variantKey: string }> {
    const experimentKey = normalizedExperimentKey(input.experimentKey);
    const subjectKey = userKeyFor(input.userId);
    if (!subjectKey) throw new Error('user_id is required.');
    const variants = [...new Set(input.variants.map(normalizedVariant))].sort();
    if (!variants.length) throw new Error('At least one variant is required.');
    const existing = await this.db.query<{ variant_key: string }>(
      `SELECT variant_key FROM analytics_experiment_assignments WHERE experiment_key = $1 AND subject_key = $2`, [experimentKey, subjectKey],
    );
    if (existing.rows[0]) return { experimentKey, variantKey: existing.rows[0].variant_key };
    const digest = createHash('sha256').update(`${experimentKey}:${subjectKey}`).digest();
    const index = digest.readUInt32BE(0) % variants.length;
    const variantKey = variants[index]!;
    const result = await this.db.query<{ variant_key: string }>(
      `INSERT INTO analytics_experiment_assignments (experiment_key, subject_key, variant_key, assigned_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (experiment_key, subject_key) DO NOTHING
       RETURNING variant_key`,
      [experimentKey, subjectKey, variantKey, this.clock.now()],
    );
    return { experimentKey, variantKey: result.rows[0]?.variant_key ?? (await this.db.query<{ variant_key: string }>(
      `SELECT variant_key FROM analytics_experiment_assignments WHERE experiment_key = $1 AND subject_key = $2`, [experimentKey, subjectKey],
    )).rows[0]!.variant_key };
  }

  async recordExperimentExposure(input: ExperimentExposureInput): Promise<boolean> {
    const experimentKey = normalizedExperimentKey(input.experimentKey);
    const variantKey = normalizedVariant(input.variantKey);
    const subjectKey = userKeyFor(input.userId);
    if (!subjectKey) throw new Error('user_id is required.');
    const exposureKey = input.exposureKey.trim();
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(exposureKey)) throw new Error('exposure_key is invalid.');
    const result = await this.db.query<{ experiment_key: string }>(
      `INSERT INTO analytics_experiment_exposures (experiment_key, subject_key, variant_key, exposure_key, exposed_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING
       RETURNING experiment_key`, [experimentKey, subjectKey, variantKey, exposureKey, this.clock.now()],
    );
    return Boolean(result.rowCount);
  }

  private async projectClaimed(tx: Transaction, event: DomainEvent): Promise<void> {
    const roomKey = roomKeyFor(event);
    const actorKey = userKeyFor(asString(event.payload, 'user_id') ?? event.actorUserId);
    const sport = validDimension(asString(event.payload, 'sport_code'));
    const area = validDimension(asString(event.payload, 'area_bucket'));
    const scheduledHour = validHour(asInteger(event.payload, 'scheduled_hour_utc'));
    await this.insertActivity(tx, event, actorKey, roomKey, sport, area, scheduledHour);

    switch (event.eventType) {
      case 'ROOM_CREATED':
        await this.upsertRoomCreated(tx, event, roomKey, actorKey, sport, area, scheduledHour);
        break;
      case 'ROOM_PUBLISHED':
        await this.upsertRoomTimestamp(tx, roomKey, 'published_at', event.occurredAt);
        break;
      case 'ROOM_SHARE_CREATED':
        await this.upsertRoomTimestamp(tx, roomKey, 'share_created_at', event.occurredAt);
        break;
      case 'ROOM_BECAME_FULL':
        await this.upsertRoomTimestamp(tx, roomKey, 'filled_at', event.occurredAt);
        break;
      case 'ROOM_COMPLETED':
        await this.upsertRoomTimestamp(tx, roomKey, 'completed_at', event.occurredAt);
        if (roomKey) await tx.query(
          `UPDATE analytics_room_facts SET completed_source_event_id = COALESCE(completed_source_event_id, $2) WHERE room_key = $1`,
          [roomKey, event.id],
        );
        await this.completePresentParticipants(tx, roomKey, event.occurredAt, event.id);
        break;
      case 'ROOM_CANCELLED':
        await this.upsertRoomTimestamp(tx, roomKey, 'cancelled_at', event.occurredAt);
        break;
      case 'REPEAT_ROOM_CREATED':
        await this.upsertRoomRepeat(tx, roomKey, analyticsKey('room', asString(event.payload, 'source_room_id')));
        break;
      case 'JOIN_REQUEST_CREATED':
        await this.projectJoinCreated(tx, event, roomKey);
        break;
      case 'JOIN_REQUEST_ACCEPTED':
        await this.projectJoinAccepted(tx, event, roomKey);
        break;
      case 'PARTICIPANT_CREATED':
        await this.projectParticipantCreated(tx, event, roomKey);
        break;
      case 'PLAYER_MARKED_PRESENT':
      case 'PLAYER_NO_SHOW':
      case 'ATTENDANCE_CORRECTED':
        await this.projectAttendance(tx, event, roomKey);
        break;
      case 'USER_REGISTERED':
        await this.registerUser(tx, userKeyFor(asString(event.payload, 'user_id') ?? event.actorUserId), event.occurredAt);
        break;
      default:
        break;
    }
  }

  private async insertActivity(tx: Transaction, event: DomainEvent, actorKey: string | null, roomKey: string | null, sport: string | null, area: string | null, scheduledHour: number | null): Promise<void> {
    const activityType = this.activityTypeFor(event.eventType);
    if (!activityType) return;
    const resultCount = event.eventType === 'SEARCH_EXECUTED' ? asInteger(event.payload, 'result_count') : null;
    await tx.query(
      `INSERT INTO analytics_activity_events (event_id, event_type, occurred_at, actor_key, room_key, sport_code, area_bucket, result_count, scheduled_hour_utc)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [event.id, activityType, event.occurredAt, actorKey, roomKey, sport, area, resultCount, scheduledHour],
    );
    if (actorKey && ['SEARCH_EXECUTED', 'ROOM_CARD_VIEWED', 'ROOM_DETAIL_VIEWED', 'JOIN_REQUEST_CREATED', 'JOIN_REQUEST_ACCEPTED', 'PARTICIPANT_CREATED', 'PLAYER_MARKED_PRESENT'].includes(activityType)) {
      await this.touchActiveUser(tx, actorKey, event.occurredAt, sport, area);
    }
  }

  private activityTypeFor(eventType: string): string | null {
    const accepted = new Set([
      'ROOM_CREATED', 'ROOM_PUBLISHED', 'ROOM_SHARE_CREATED', 'ROOM_BECAME_FULL', 'ROOM_COMPLETED', 'ROOM_CANCELLED', 'REPEAT_ROOM_CREATED',
      'JOIN_REQUEST_CREATED', 'JOIN_REQUEST_ACCEPTED', 'PARTICIPANT_CREATED', 'PLAYER_MARKED_PRESENT', 'PLAYER_NO_SHOW', 'ATTENDANCE_CORRECTED',
      'SEARCH_EXECUTED', 'ROOM_CARD_VIEWED', 'ROOM_DETAIL_VIEWED', 'SHARE_VIEWED', 'USER_REGISTERED',
    ]);
    return accepted.has(eventType) ? eventType : null;
  }

  private async upsertRoomCreated(tx: Transaction, event: DomainEvent, roomKey: string | null, hostKey: string | null, sport: string | null, area: string | null, scheduledHour: number | null): Promise<void> {
    if (!roomKey) return;
    const capacity = asInteger(event.payload, 'capacity');
    await tx.query(
      `INSERT INTO analytics_room_facts (room_key, host_key, sport_code, area_bucket, scheduled_hour_utc, capacity, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
       ON CONFLICT (room_key) DO UPDATE SET
         host_key = COALESCE(analytics_room_facts.host_key, EXCLUDED.host_key), sport_code = COALESCE(analytics_room_facts.sport_code, EXCLUDED.sport_code),
         area_bucket = COALESCE(analytics_room_facts.area_bucket, EXCLUDED.area_bucket), scheduled_hour_utc = COALESCE(analytics_room_facts.scheduled_hour_utc, EXCLUDED.scheduled_hour_utc),
         capacity = COALESCE(analytics_room_facts.capacity, EXCLUDED.capacity), created_at = COALESCE(analytics_room_facts.created_at, EXCLUDED.created_at), updated_at = EXCLUDED.updated_at`,
      [roomKey, hostKey, sport, area, scheduledHour, capacity, event.occurredAt],
    );
  }

  private async upsertRoomTimestamp(tx: Transaction, roomKey: string | null, column: 'published_at' | 'share_created_at' | 'filled_at' | 'completed_at' | 'cancelled_at', at: Date): Promise<void> {
    if (!roomKey) return;
    await tx.query(
      `INSERT INTO analytics_room_facts (room_key, ${column}, updated_at) VALUES ($1, $2, $2)
       ON CONFLICT (room_key) DO UPDATE SET ${column} = COALESCE(analytics_room_facts.${column}, EXCLUDED.${column}), updated_at = EXCLUDED.updated_at`,
      [roomKey, at],
    );
  }

  private async upsertRoomRepeat(tx: Transaction, roomKey: string | null, sourceRoomKey: string | null): Promise<void> {
    if (!roomKey) return;
    await tx.query(
      `INSERT INTO analytics_room_facts (room_key, repeated_from_room_key, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (room_key) DO UPDATE SET repeated_from_room_key = COALESCE(analytics_room_facts.repeated_from_room_key, EXCLUDED.repeated_from_room_key), updated_at = EXCLUDED.updated_at`,
      [roomKey, sourceRoomKey, this.clock.now()],
    );
  }

  private async projectJoinCreated(tx: Transaction, event: DomainEvent, roomKey: string | null): Promise<void> {
    const applicationKey = appKeyFor(asString(event.payload, 'application_id') ?? event.aggregateId);
    if (!applicationKey || !roomKey) return;
    const requesterKey = userKeyFor(asString(event.payload, 'requested_by_user_id') ?? event.actorUserId);
    await tx.query(
      `INSERT INTO analytics_application_facts (application_key, room_key, requester_key, requested_slot_count, created_at)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (application_key) DO NOTHING`,
      [applicationKey, roomKey, requesterKey, asInteger(event.payload, 'requested_slot_count'), event.occurredAt],
    );
    if (requesterKey) await this.touchActiveUser(tx, requesterKey, event.occurredAt, null, null);
    await tx.query(
      `INSERT INTO analytics_room_facts (room_key, first_application_at, updated_at) VALUES ($1,$2,$2)
       ON CONFLICT (room_key) DO UPDATE SET first_application_at = COALESCE(analytics_room_facts.first_application_at, EXCLUDED.first_application_at), updated_at = EXCLUDED.updated_at`,
      [roomKey, event.occurredAt],
    );
  }

  private async projectJoinAccepted(tx: Transaction, event: DomainEvent, roomKey: string | null): Promise<void> {
    const applicationKey = appKeyFor(asString(event.payload, 'application_id') ?? event.aggregateId);
    if (applicationKey) await tx.query(
      `UPDATE analytics_application_facts
       SET accepted_at = COALESCE(accepted_at, $2), accepted_source_event_id = COALESCE(accepted_source_event_id, $3)
       WHERE application_key = $1`,
      [applicationKey, event.occurredAt, event.id],
    );
    const requesterKey = userKeyFor(asString(event.payload, 'requested_by_user_id'));
    if (requesterKey) await this.touchActiveUser(tx, requesterKey, event.occurredAt, null, null);
  }

  private async projectParticipantCreated(tx: Transaction, event: DomainEvent, roomKey: string | null): Promise<void> {
    const participantKey = participantKeyFor(asString(event.payload, 'participant_id') ?? event.aggregateId);
    if (!participantKey || !roomKey) return;
    const userKey = userKeyFor(asString(event.payload, 'user_id'));
    await tx.query(
      `INSERT INTO analytics_participant_facts (participant_key, room_key, user_key, attendance_status, accepted_at)
       VALUES ($1,$2,$3,'NOT_SET',$4)
       ON CONFLICT (participant_key) DO UPDATE SET user_key = COALESCE(analytics_participant_facts.user_key, EXCLUDED.user_key)`,
      [participantKey, roomKey, userKey, event.occurredAt],
    );
    if (userKey) await this.touchActiveUser(tx, userKey, event.occurredAt, null, null);
  }

  private async projectAttendance(tx: Transaction, event: DomainEvent, roomKey: string | null): Promise<void> {
    const participantKey = participantKeyFor(asString(event.payload, 'participant_id') ?? event.aggregateId);
    const attendance = asString(event.payload, 'attendance_status');
    if (!participantKey || !['PRESENT', 'NO_SHOW'].includes(attendance ?? '')) return;
    const payloadUserKey = userKeyFor(asString(event.payload, 'user_id'));
    await tx.query(
      `UPDATE analytics_participant_facts SET attendance_status = $2, attendance_updated_at = $3,
        user_key = COALESCE(user_key, $4) WHERE participant_key = $1`,
      [participantKey, attendance, event.occurredAt, payloadUserKey],
    );
    const participant = await tx.query<{ room_key: string; user_key: string | null }>(
      `SELECT room_key, user_key FROM analytics_participant_facts WHERE participant_key = $1`, [participantKey],
    );
    const userKey = participant.rows[0]?.user_key ?? payloadUserKey;
    const effectiveRoomKey = participant.rows[0]?.room_key ?? roomKey;
    if (attendance === 'PRESENT' && userKey) {
      await this.touchActiveUser(tx, userKey, event.occurredAt, null, null);
      const room = effectiveRoomKey ? await tx.query<{ completed_at: Date | null; completed_source_event_id: string | null }>(
        `SELECT completed_at, completed_source_event_id FROM analytics_room_facts WHERE room_key = $1`, [effectiveRoomKey],
      ) : null;
      if (effectiveRoomKey && room?.rows[0]?.completed_at) {
        await this.insertCompletedParticipation(tx, effectiveRoomKey, userKey, room.rows[0].completed_at, room.rows[0].completed_source_event_id);
      }
    }
  }

  private async completePresentParticipants(tx: Transaction, roomKey: string | null, completedAt: Date, completionSourceEventId: string): Promise<void> {
    if (!roomKey) return;
    const participants = await tx.query<{ user_key: string }>(
      `SELECT user_key FROM analytics_participant_facts WHERE room_key = $1 AND attendance_status = 'PRESENT' AND user_key IS NOT NULL`, [roomKey],
    );
    for (const participant of participants.rows) await this.insertCompletedParticipation(tx, roomKey, participant.user_key, completedAt, completionSourceEventId);
  }

  private async insertCompletedParticipation(
    tx: Transaction, roomKey: string, userKey: string, completedAt: Date, completionSourceEventId: string | null,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO analytics_completed_participations (room_key, user_key, completed_at, completion_source_event_id)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (room_key, user_key) DO UPDATE SET
         completion_source_event_id = COALESCE(analytics_completed_participations.completion_source_event_id, EXCLUDED.completion_source_event_id)`,
      [roomKey, userKey, completedAt, completionSourceEventId],
    );
  }

  private async registerUser(tx: Transaction, userKey: string | null, occurredAt: Date): Promise<void> {
    if (!userKey) return;
    await tx.query(
      `INSERT INTO analytics_user_profiles (user_key, registered_at, updated_at) VALUES ($1,$2,$2)
       ON CONFLICT (user_key) DO UPDATE SET registered_at = COALESCE(analytics_user_profiles.registered_at, EXCLUDED.registered_at), updated_at = EXCLUDED.updated_at`,
      [userKey, occurredAt],
    );
  }

  private async touchActiveUser(tx: Transaction, userKey: string, occurredAt: Date, sport: string | null, area: string | null): Promise<void> {
    await tx.query(
      `INSERT INTO analytics_user_profiles (user_key, first_active_at, last_active_at, first_sport_code, first_area_bucket, updated_at)
       VALUES ($1,$2,$2,$3,$4,$2)
       ON CONFLICT (user_key) DO UPDATE SET
         first_active_at = CASE WHEN analytics_user_profiles.first_active_at IS NULL THEN EXCLUDED.first_active_at ELSE LEAST(analytics_user_profiles.first_active_at, EXCLUDED.first_active_at) END,
         last_active_at = CASE WHEN analytics_user_profiles.last_active_at IS NULL THEN EXCLUDED.last_active_at ELSE GREATEST(analytics_user_profiles.last_active_at, EXCLUDED.last_active_at) END,
         first_sport_code = COALESCE(analytics_user_profiles.first_sport_code, EXCLUDED.first_sport_code),
         first_area_bucket = COALESCE(analytics_user_profiles.first_area_bucket, EXCLUDED.first_area_bucket),
         updated_at = EXCLUDED.updated_at`,
      [userKey, occurredAt, sport, area],
    );
  }

  private window(input: Partial<AnalyticsWindow>): AnalyticsWindow {
    const fallback = defaultWindow(this.clock);
    const from = input.from ?? fallback.from;
    const to = input.to ?? fallback.to;
    if (to <= from) throw new Error('Analytics window end must be after start.');
    return { from, to, sportCode: input.sportCode?.trim() || undefined, areaBucket: input.areaBucket?.trim() || undefined };
  }

  private dimensionFilters(window: AnalyticsWindow, alias: string): { sql: string; values: string[] } {
    const filters: string[] = []; const values: string[] = [];
    if (window.sportCode) { values.push(window.sportCode); filters.push(`AND ${alias}.sport_code = $${values.length + 2}`); }
    if (window.areaBucket) { values.push(window.areaBucket); filters.push(`AND ${alias}.area_bucket = $${values.length + 2}`); }
    return { sql: filters.length ? ` ${filters.join(' ')}` : '', values };
  }

  private numericRow(row: Record<string, string | null> | undefined): Record<string, number> {
    if (!row) return {};
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value ?? 0)]));
  }

  private rate(numerator: string | number, denominator: string | number): number | null {
    const denominatorNumber = Number(denominator); return denominatorNumber > 0 ? Number((Number(numerator) / denominatorNumber).toFixed(4)) : null;
  }

  private decimal(value: string | null): number | null { return value === null ? null : Number(Number(value).toFixed(2)); }
  private windowDto(window: AnalyticsWindow): Record<string, string | null> {
    return { from: window.from.toISOString(), to: window.to.toISOString(), sport_code: window.sportCode ?? null, area_bucket: window.areaBucket ?? null };
  }
}

/** Composite side-effect dispatch keeps the existing global outbox publish lifecycle intact. */
export class CompositeOutboxConsumer implements OutboxConsumer {
  constructor(readonly name: string, private readonly consumers: OutboxConsumer[]) {}

  async handle(event: DomainEvent): Promise<void> {
    for (const consumer of this.consumers) await consumer.handle(event);
  }
}
