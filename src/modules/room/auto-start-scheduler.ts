import { config, logger } from '../../platform/core.js';
import { RoomLifecycleService } from './lifecycle-service.js';

export class AutoStartScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly lifecycle: RoomLifecycleService,
    private readonly intervalMs = config.autoStartIntervalMs,
  ) {}

  start(): void {
    if (this.timer) return;
    const tick = async (): Promise<void> => {
      if (this.running) return;
      this.running = true;
      try {
        const count = await this.lifecycle.autoStartDueRooms();
        if (count > 0) logger.info({ count }, 'Auto-started due Rooms');
      } catch (error) {
        logger.error({ err: error }, 'Auto-start scheduler tick failed');
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
