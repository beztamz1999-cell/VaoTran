import { config, logger } from '../../platform/core.js';
import { metrics } from '../../platform/observability/metrics.js';
import { AnalyticsService } from './analytics-service.js';

/**
 * Runtime A: an in-process, detection-only analytics quality check.
 * It never replays, repairs, or mutates canonical product data.
 */
export class AnalyticsValidationScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly analytics: AnalyticsService,
    private readonly intervalMs = config.analyticsValidationIntervalMs,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runSafely(); }, this.intervalMs);
    void this.runSafely();
    logger.info({ component: 'analytics-validation', interval_ms: this.intervalMs }, 'Analytics quality validation scheduler started');
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    logger.info({ component: 'analytics-validation' }, 'Analytics quality validation scheduler stopped');
  }

  private async runSafely(): Promise<void> {
    if (this.running) {
      metrics.increment('vaotran_analytics_validation_runs_total', { outcome: 'skipped_concurrent' });
      logger.warn({ component: 'analytics-validation' }, 'Skipped overlapping analytics quality validation');
      return;
    }
    this.running = true;
    try {
      const report = await this.analytics.validateProjection();
      metrics.increment('vaotran_analytics_validation_runs_total', { outcome: report.status.toLowerCase() });
      metrics.setGauge('vaotran_analytics_validation_failed_checks', report.findings.filter((finding) => finding.findingCount > 0).length);
    } catch (error) {
      metrics.increment('vaotran_analytics_validation_runs_total', { outcome: 'failed' });
      logger.error({ component: 'analytics-validation', err: error }, 'Scheduled analytics quality validation failed');
    } finally {
      this.running = false;
    }
  }
}
