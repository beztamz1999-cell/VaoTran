import { config, logger } from '../../platform/core.js';
import { metrics } from '../../platform/observability/metrics.js';
import { ReconciliationService } from './reconciliation-service.js';

export class ReconciliationScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly reconciliation: ReconciliationService,
    private readonly intervalMs = config.reconciliationIntervalMs,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runSafely();
    }, this.intervalMs);
    void this.runSafely();
    logger.info({ component: 'reconciliation', interval_ms: this.intervalMs }, 'Reconciliation scheduler started');
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    logger.info({ component: 'reconciliation' }, 'Reconciliation scheduler stopped');
  }

  private async runSafely(): Promise<void> {
    if (this.running) {
      metrics.increment('vaotran_reconciliation_runs_total', { outcome: 'skipped_concurrent' });
      logger.warn({ component: 'reconciliation' }, 'Skipped overlapping reconciliation run');
      return;
    }
    this.running = true;
    try {
      await this.reconciliation.runOnce();
    } catch (error) {
      logger.error({ component: 'reconciliation', err: error }, 'Scheduled reconciliation failed');
    } finally {
      this.running = false;
    }
  }
}
