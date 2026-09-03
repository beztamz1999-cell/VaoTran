import { createHash } from 'node:crypto';
import { newId, systemClock, type Clock, logger } from '../../platform/core.js';
import type { PostgresDatabase, Transaction } from '../../platform/database/db.js';
import { metrics } from '../../platform/observability/metrics.js';

type Severity = 'INFO' | 'WARNING' | 'CRITICAL';
type JsonRecord = Record<string, unknown>;

export interface ReconciliationFinding {
  checkName: string;
  entityType: string;
  entityId: string | null;
  severity: Severity;
  expected: JsonRecord;
  actual: JsonRecord;
}

export interface ReconciliationRunSummary {
  runId: string;
  status: 'COMPLETED' | 'FAILED';
  startedAt: Date;
  completedAt: Date;
  findingsCount: number;
  byCheck: Record<string, number>;
}

const number = (value: unknown): number => Number(value ?? 0);

const fingerprint = (finding: ReconciliationFinding): string => createHash('sha256')
  .update(`${finding.checkName}|${finding.entityType}|${finding.entityId ?? ''}|${JSON.stringify(finding.expected)}|${JSON.stringify(finding.actual)}`)
  .digest('hex');

const countByCheck = (findings: ReconciliationFinding[]): Record<string, number> => findings.reduce<Record<string, number>>((result, finding) => {
  result[finding.checkName] = (result[finding.checkName] ?? 0) + 1;
  return result;
}, {});

export class ReconciliationService {
  constructor(private readonly db: PostgresDatabase, private readonly clock: Clock = systemClock) {}

  async runOnce(): Promise<ReconciliationRunSummary> {
    const runId = newId();
    const startedAt = this.clock.now();
    try {
      const findings = await this.db.transaction(async (tx) => {
        await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        const collected = [
          ...(await this.collectRoomFindings(tx)),
          ...(await this.collectSkillFindings(tx)),
          ...(await this.collectReliabilityFindings(tx)),
          ...(await this.collectNotificationFindings(tx)),
        ];
        const completedAt = this.clock.now();
        const summary = countByCheck(collected);
        await tx.query(
          `INSERT INTO reconciliation_runs (
             id, job_name, status, started_at, completed_at, findings_count, summary_json, created_at
           ) VALUES ($1, 'PILOT_RECONCILIATION', 'COMPLETED', $2, $3, $4, $5::jsonb, $3)`,
          [runId, startedAt, completedAt, collected.length, JSON.stringify(summary)],
        );
        for (const finding of collected) {
          await tx.query(
            `INSERT INTO reconciliation_findings (
               id, reconciliation_run_id, check_name, entity_type, entity_id, severity, state,
               fingerprint, expected_json, actual_json, created_at
             ) VALUES ($1, $2, $3, $4, $5, $6, 'OPEN', $7, $8::jsonb, $9::jsonb, $10)`,
            [
              newId(), runId, finding.checkName, finding.entityType, finding.entityId, finding.severity,
              fingerprint(finding), JSON.stringify(finding.expected), JSON.stringify(finding.actual), completedAt,
            ],
          );
        }
        return collected;
      });
      const completedAt = this.clock.now();
      await this.refreshOperationalGauges();
      metrics.increment('vaotran_reconciliation_runs_total', { outcome: 'completed' });
      metrics.setGauge('vaotran_reconciliation_findings', findings.length);
      for (const [checkName, findingCount] of Object.entries(countByCheck(findings))) {
        metrics.setGauge('vaotran_reconciliation_findings', findingCount, { check: checkName });
      }
      logger.info({ component: 'reconciliation', run_id: runId, findings_count: findings.length }, 'Reconciliation run completed');
      return {
        runId,
        status: 'COMPLETED',
        startedAt,
        completedAt,
        findingsCount: findings.length,
        byCheck: countByCheck(findings),
      };
    } catch (error) {
      const completedAt = this.clock.now();
      const errorMessage = error instanceof Error ? error.message.slice(0, 2048) : 'Unknown reconciliation failure';
      await this.db.query(
        `INSERT INTO reconciliation_runs (
           id, job_name, status, started_at, completed_at, findings_count, summary_json, error_message, created_at
         ) VALUES ($1, 'PILOT_RECONCILIATION', 'FAILED', $2, $3, 0, '{}'::jsonb, $4, $3)`,
        [runId, startedAt, completedAt, errorMessage],
      ).catch((persistError) => logger.error({ component: 'reconciliation', err: persistError, run_id: runId }, 'Failed to persist reconciliation failure'));
      metrics.increment('vaotran_reconciliation_runs_total', { outcome: 'failed' });
      logger.error({ component: 'reconciliation', err: error, run_id: runId }, 'Reconciliation run failed');
      throw error;
    }
  }

  private async collectRoomFindings(tx: Transaction): Promise<ReconciliationFinding[]> {
    const result = await tx.query<{
      room_id: string;
      capacity: number;
      host_participates: boolean;
      reserved_external_count: number;
      room_status: string;
      projection_present: boolean;
      projected_host_slot: number | null;
      projected_reserved_external_count: number | null;
      projected_active_app_count: number | null;
      projected_effective_no_show_count: number | null;
      projected_occupied_slots: number | null;
      projected_available_public_slots: number | null;
      actual_active_app_count: number;
      actual_effective_no_show_count: number;
    }>(`
      SELECT
        r.id AS room_id,
        r.capacity,
        r.host_participates,
        r.reserved_external_count,
        r.status::text AS room_status,
        (rap.room_id IS NOT NULL) AS projection_present,
        rap.host_slot AS projected_host_slot,
        rap.reserved_external_count AS projected_reserved_external_count,
        rap.active_app_count AS projected_active_app_count,
        rap.effective_no_show_count AS projected_effective_no_show_count,
        rap.occupied_slots AS projected_occupied_slots,
        rap.available_public_slots AS projected_available_public_slots,
        COALESCE(active_participants.count, 0)::int AS actual_active_app_count,
        COALESCE(active_participants.effective_no_show_count, 0)::int AS actual_effective_no_show_count
      FROM rooms r
      LEFT JOIN room_availability_projections rap ON rap.room_id = r.id
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::int AS count,
          COUNT(*) FILTER (WHERE attendance_status = 'NO_SHOW')::int AS effective_no_show_count
        FROM room_participants rp
        WHERE rp.room_id = r.id AND rp.status = 'ACTIVE'
      ) active_participants ON TRUE
    `);
    const findings: ReconciliationFinding[] = [];
    for (const row of result.rows) {
      const hostSlot = row.host_participates ? 1 : 0;
      const occupiedSlots = hostSlot + number(row.reserved_external_count) + number(row.actual_active_app_count);
      const availablePublicSlots = number(row.capacity) - occupiedSlots;
      const expected = {
        host_slot: hostSlot,
        reserved_external_count: number(row.reserved_external_count),
        active_app_count: number(row.actual_active_app_count),
        effective_no_show_count: number(row.actual_effective_no_show_count),
        occupied_slots: occupiedSlots,
        available_public_slots: availablePublicSlots,
      };
      const actual = {
        projection_present: row.projection_present,
        host_slot: row.projected_host_slot === null ? null : number(row.projected_host_slot),
        reserved_external_count: row.projected_reserved_external_count === null ? null : number(row.projected_reserved_external_count),
        active_app_count: row.projected_active_app_count === null ? null : number(row.projected_active_app_count),
        effective_no_show_count: row.projected_effective_no_show_count === null ? null : number(row.projected_effective_no_show_count),
        occupied_slots: row.projected_occupied_slots === null ? null : number(row.projected_occupied_slots),
        available_public_slots: row.projected_available_public_slots === null ? null : number(row.projected_available_public_slots),
      };
      if (!row.projection_present || expected.host_slot !== actual.host_slot || expected.reserved_external_count !== actual.reserved_external_count || expected.active_app_count !== actual.active_app_count || expected.effective_no_show_count !== actual.effective_no_show_count || expected.occupied_slots !== actual.occupied_slots || expected.available_public_slots !== actual.available_public_slots) {
        findings.push({ checkName: 'ROOM_AVAILABILITY', entityType: 'ROOM', entityId: row.room_id, severity: 'CRITICAL', expected, actual });
      }
      if (['OPEN', 'FULL'].includes(row.room_status)) {
        const expectedStatus = availablePublicSlots > 0 ? 'OPEN' : 'FULL';
        if (row.room_status !== expectedStatus) {
          findings.push({
            checkName: 'ROOM_PRESTART_STATUS',
            entityType: 'ROOM',
            entityId: row.room_id,
            severity: 'CRITICAL',
            expected: { status: expectedStatus, available_public_slots: availablePublicSlots },
            actual: { status: row.room_status },
          });
        }
      }
    }
    return findings;
  }

  private async collectSkillFindings(tx: Transaction): Promise<ReconciliationFinding[]> {
    const result = await tx.query<{
      user_id: string;
      sport_id: string;
      skill_state: string;
      skill_score: number | null;
      rank_tier: number | null;
      valid_rating_count: number;
      unique_valid_rater_count: number;
      raw_valid_rating_count: number;
      raw_unique_rater_count: number;
    }>(`
      WITH raw AS (
        SELECT
          rated_user_id AS user_id,
          sport_id,
          COUNT(*) FILTER (WHERE eligibility_result = TRUE AND effective_rating_value IS NOT NULL)::int AS valid_rating_count,
          COUNT(DISTINCT rater_host_user_id) FILTER (WHERE eligibility_result = TRUE AND effective_rating_value IS NOT NULL)::int AS unique_rater_count
        FROM skill_ratings
        GROUP BY rated_user_id, sport_id
      )
      SELECT
        usp.user_id,
        usp.sport_id,
        usp.skill_state::text,
        usp.skill_score,
        usp.rank_tier,
        usp.valid_rating_count,
        usp.unique_valid_rater_count,
        COALESCE(raw.valid_rating_count, 0)::int AS raw_valid_rating_count,
        COALESCE(raw.unique_rater_count, 0)::int AS raw_unique_rater_count
      FROM user_sport_profiles usp
      LEFT JOIN raw ON raw.user_id = usp.user_id AND raw.sport_id = usp.sport_id
    `);
    const findings: ReconciliationFinding[] = [];
    for (const row of result.rows) {
      const countsMatch = number(row.valid_rating_count) === number(row.raw_valid_rating_count)
        && number(row.unique_valid_rater_count) === number(row.raw_unique_rater_count);
      const noEvidenceShape = number(row.raw_valid_rating_count) === 0
        ? row.skill_state === 'UNRANKED' && row.skill_score === null && row.rank_tier === null
        : true;
      const rankedShape = number(row.raw_valid_rating_count) > 0 && ['RANKED', 'TOP_TIER_LOCKED'].includes(row.skill_state)
        ? row.skill_score !== null && row.rank_tier !== null
        : true;
      if (!countsMatch || !noEvidenceShape || !rankedShape) {
        findings.push({
          checkName: 'SKILL_PROFILE_EVIDENCE',
          entityType: 'USER_SPORT_PROFILE',
          entityId: row.user_id,
          severity: 'WARNING',
          expected: {
            valid_rating_count: number(row.raw_valid_rating_count),
            unique_valid_rater_count: number(row.raw_unique_rater_count),
            score_shape: number(row.raw_valid_rating_count) === 0 ? 'UNRANKED_WITHOUT_SCORE' : 'RANKED_SCORE_WHEN_RANKED',
          },
          actual: {
            sport_id: row.sport_id,
            skill_state: row.skill_state,
            skill_score_present: row.skill_score !== null,
            rank_tier_present: row.rank_tier !== null,
            valid_rating_count: number(row.valid_rating_count),
            unique_valid_rater_count: number(row.unique_valid_rater_count),
          },
        });
      }
    }
    return findings;
  }

  private async collectReliabilityFindings(tx: Transaction): Promise<ReconciliationFinding[]> {
    const result = await tx.query<{
      user_id: string;
      reliability_score: number;
      ledger_score_after: number | null;
    }>(`
      SELECT
        prs.user_id,
        prs.reliability_score,
        latest.score_after AS ledger_score_after
      FROM player_reliability_stats prs
      LEFT JOIN LATERAL (
        SELECT score_after
        FROM reliability_adjustments ra
        WHERE ra.user_id = prs.user_id AND ra.subject_type = 'PLAYER'
        ORDER BY ra.created_at DESC, ra.id DESC
        LIMIT 1
      ) latest ON TRUE
    `);
    const findings: ReconciliationFinding[] = [];
    for (const row of result.rows) {
      const expectedScore = row.ledger_score_after === null ? 100 : number(row.ledger_score_after);
      if (Math.abs(number(row.reliability_score) - expectedScore) > 0.001) {
        findings.push({
          checkName: 'RELIABILITY_LEDGER_SCORE',
          entityType: 'USER',
          entityId: row.user_id,
          severity: 'CRITICAL',
          expected: { reliability_score: expectedScore },
          actual: { reliability_score: number(row.reliability_score) },
        });
      }
    }
    return findings;
  }

  private async collectNotificationFindings(tx: Transaction): Promise<ReconciliationFinding[]> {
    const findings: ReconciliationFinding[] = [];
    const missingPreference = await tx.query<{ user_id: string; notification_id: string }>(`
      SELECT n.user_id, n.id AS notification_id
      FROM notifications n
      LEFT JOIN notification_preferences np ON np.user_id = n.user_id
      WHERE np.user_id IS NULL
    `);
    for (const row of missingPreference.rows) {
      findings.push({
        checkName: 'NOTIFICATION_PREFERENCE_PROJECTION',
        entityType: 'NOTIFICATION',
        entityId: row.notification_id,
        severity: 'WARNING',
        expected: { preference_row: true },
        actual: { preference_row: false },
      });
    }
    const stuckDeliveries = await tx.query<{ delivery_id: string; status: string; attempt_count: number }>(`
      SELECT id AS delivery_id, status::text, attempt_count
      FROM push_deliveries
      WHERE status = 'PROCESSING' AND updated_at < NOW() - INTERVAL '15 minutes'
    `);
    for (const row of stuckDeliveries.rows) {
      findings.push({
        checkName: 'NOTIFICATION_DELIVERY_STUCK',
        entityType: 'PUSH_DELIVERY',
        entityId: row.delivery_id,
        severity: 'WARNING',
        expected: { status: 'PENDING_OR_TERMINAL' },
        actual: { status: row.status, attempt_count: number(row.attempt_count) },
      });
    }
    const duplicateDedupe = await tx.query<{ user_id: string; dedupe_key: string; notification_count: number }>(`
      SELECT user_id, dedupe_key, COUNT(*)::int AS notification_count
      FROM notifications
      GROUP BY user_id, dedupe_key
      HAVING COUNT(*) > 1
    `);
    for (const row of duplicateDedupe.rows) {
      findings.push({
        checkName: 'NOTIFICATION_DEDUPE',
        entityType: 'NOTIFICATION',
        entityId: null,
        severity: 'CRITICAL',
        expected: { count: 1 },
        actual: { count: number(row.notification_count) },
      });
    }
    return findings;
  }

  async refreshOperationalGauges(): Promise<void> {
    const [outbox, deliveries] = await Promise.all([
      this.db.query<{ pending: number; dead_letter: number; lag_seconds: number | null }>(`
        SELECT
          COUNT(*) FILTER (WHERE publish_status IN ('PENDING', 'FAILED_RETRYABLE'))::int AS pending,
          COUNT(*) FILTER (WHERE publish_status = 'DEAD_LETTER')::int AS dead_letter,
          EXTRACT(EPOCH FROM NOW() - MIN(occurred_at) FILTER (WHERE publish_status IN ('PENDING', 'FAILED_RETRYABLE'))) AS lag_seconds
        FROM event_outbox
      `),
      this.db.query<{ retryable: number; dead_letter: number; lag_seconds: number | null }>(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'FAILED_RETRYABLE')::int AS retryable,
          COUNT(*) FILTER (WHERE status = 'DEAD_LETTER')::int AS dead_letter,
          EXTRACT(EPOCH FROM NOW() - MIN(created_at) FILTER (WHERE status IN ('PENDING', 'PROCESSING', 'FAILED_RETRYABLE'))) AS lag_seconds
        FROM push_deliveries
      `),
    ]);
    const outboxRow = outbox.rows[0];
    const deliveryRow = deliveries.rows[0];
    metrics.setGauge('vaotran_outbox_pending', number(outboxRow?.pending));
    metrics.setGauge('vaotran_outbox_dead_letter', number(outboxRow?.dead_letter));
    metrics.setGauge('vaotran_outbox_lag_seconds', number(outboxRow?.lag_seconds));
    metrics.setGauge('vaotran_notification_retry', number(deliveryRow?.retryable));
    metrics.setGauge('vaotran_notification_dead_letter', number(deliveryRow?.dead_letter));
    metrics.setGauge('vaotran_notification_lag_seconds', number(deliveryRow?.lag_seconds));
  }
}
