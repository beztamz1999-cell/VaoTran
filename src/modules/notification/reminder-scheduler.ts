import { logger, systemClock, type Clock } from '../../platform/core.js';
import type { PostgresDatabase } from '../../platform/database/db.js';
import { appendOutboxEvent, makeDomainEvent } from '../../platform/outbox/outbox.js';
import { NotificationRepository } from './repository.js';

export class NotificationReminderScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: PostgresDatabase,
    private readonly notifications: NotificationRepository,
    private readonly clock: Clock = systemClock,
    private readonly intervalMs = 60_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runOnce(); }, this.intervalMs);
    void this.runOnce();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(limit = 100): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      return await this.db.transaction(async (tx) => {
        const now = this.clock.now();
        const startRoomIds = await this.notifications.claimReminderRoomIds(tx, now, limit);
        const remaining = Math.max(0, limit - startRoomIds.length);
        const completionRoomIds = remaining > 0
          ? await this.notifications.claimCompletionReminderRoomIds(tx, now, remaining)
          : [];
        for (const roomId of startRoomIds) {
          await appendOutboxEvent(tx, makeDomainEvent({
            eventType: 'ROOM_START_REMINDER', aggregateType: 'ROOM', aggregateId: roomId, actorUserId: null,
            correlationId: null, causationId: null, schemaVersion: 1, payload: { room_id: roomId }, occurredAt: now,
          }, this.clock));
        }
        for (const roomId of completionRoomIds) {
          await appendOutboxEvent(tx, makeDomainEvent({
            eventType: 'ROOM_COMPLETION_REMINDER', aggregateType: 'ROOM', aggregateId: roomId, actorUserId: null,
            correlationId: null, causationId: null, schemaVersion: 1, payload: { room_id: roomId }, occurredAt: now,
          }, this.clock));
        }
        return startRoomIds.length + completionRoomIds.length;
      });
    } catch (error) {
      logger.error({ err: error }, 'Notification reminder scheduler failed');
      return 0;
    } finally {
      this.running = false;
    }
  }
}
