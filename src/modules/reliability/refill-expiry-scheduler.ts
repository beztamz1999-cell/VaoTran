import { config, logger } from '../../platform/core.js';
import { ReliabilityService } from './service.js';

/**
 * Closes only overdue refill modes. Admission remains HOST-mediated and no Player is ever auto-accepted.
 * The service records the stop/expiry event transactionally for every affected Room.
 */
export class RefillExpiryScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly reliability: ReliabilityService,
    private readonly intervalMs = config.autoStartIntervalMs,
  ) {}

  start(): void {
    if (this.timer) return;
    const tick = async (): Promise<void> => {
      if (this.running) return;
      this.running = true;
      try {
        const count = await this.reliability.expireDueRefills();
        if (count > 0) logger.info({ count }, 'Expired due emergency refill modes');
      } catch (error) {
        logger.error({ err: error }, 'Emergency refill expiry scheduler tick failed');
      } finally {
        this.running = false;
      }
    };
    void tick();
    this.timer = setInterval(() => { void tick(); }, Math.max(1_000, this.intervalMs));
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
