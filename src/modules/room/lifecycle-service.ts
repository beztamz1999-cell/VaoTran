import { DomainError, newId, systemClock, type Clock } from '../../platform/core.js';
import type { PostgresDatabase, Transaction } from '../../platform/database/db.js';
import { PostgresIdempotencyGate, type IdempotencyResult } from '../../platform/idempotency.js';
import { appendOutboxEvent, makeDomainEvent } from '../../platform/outbox/outbox.js';
import { ParticipationRepository } from '../participation/repository.js';
import {
  assertCanComplete,
  assertCanStart,
  calculateAvailability,
  type Room,
  type RoomStartSource,
} from './domain.js';
import { RoomRepository } from './repository.js';
import type { CommandMeta } from './service.js';
import type { ReliabilityService } from '../reliability/service.js';
import type { SkillService } from '../ranking/service.js';

export interface StartRoomSummary {
  roomId: string;
  status: 'IN_PROGRESS';
  actualStartedAt: Date;
  startSource: RoomStartSource;
  availablePublicSlots: number;
}

export interface CompleteRoomSummary {
  roomId: string;
  status: 'COMPLETED';
  completedAt: Date;
}

export interface CompletionRequirements {
  assertSatisfied(tx: Transaction, room: Room): Promise<void>;
}

/** M3 intentionally has no rating engine; M6 replaces this policy without changing completion transaction flow. */
export class RatingsNotRequiredCompletionPolicy implements CompletionRequirements {
  async assertSatisfied(_tx: Transaction, _room: Room): Promise<void> {}
}

export class RoomLifecycleService {
  private readonly idempotency: PostgresIdempotencyGate;

  constructor(
    private readonly db: PostgresDatabase,
    private readonly rooms: RoomRepository,
    private readonly participation: ParticipationRepository,
    private readonly completionRequirements: CompletionRequirements = new RatingsNotRequiredCompletionPolicy(),
    private readonly clock: Clock = systemClock,
    private readonly reliabilityService: ReliabilityService | null = null,
    private readonly skillService: SkillService | null = null,
  ) {
    this.idempotency = new PostgresIdempotencyGate(db, clock);
  }

  async manualStart(roomId: string, meta: CommandMeta): Promise<IdempotencyResult<StartRoomSummary>> {
    const result = await this.idempotency.execute(meta.idempotency, 200, (tx) => this.startLocked(tx, roomId, 'MANUAL', meta.actorUserId));
    return this.hydrateStartResult(result);
  }

  async autoStart(roomId: string): Promise<IdempotencyResult<StartRoomSummary>> {
    const room = await this.rooms.findById(this.db, roomId);
    if (!room) throw new DomainError('ROOM_NOT_FOUND', 'Room was not found.');
    const result = await this.idempotency.execute({
      key: `auto-start:${room.id}:${room.scheduledStartAt.toISOString()}`,
      // idempotency_keys.actor_user_id is a UUID; the Room HOST scopes the deterministic system command.
      actorUserId: room.hostUserId,
      commandType: 'AUTO_START_ROOM',
      request: { room_id: room.id, scheduled_start_at: room.scheduledStartAt.toISOString() },
    }, 200, (tx) => this.startLocked(tx, roomId, 'AUTO', null));
    return this.hydrateStartResult(result);
  }

  async complete(roomId: string, meta: CommandMeta): Promise<IdempotencyResult<CompleteRoomSummary>> {
    const result = await this.idempotency.execute<CompleteRoomSummary>(meta.idempotency, 200, async (tx) => {
      const room = await this.requireHostRoomLocked(tx, roomId, meta.actorUserId);
      if (room.status === 'COMPLETED') {
        return { roomId: room.id, status: 'COMPLETED', completedAt: room.completedAt! };
      }
      assertCanComplete(room);
      const unresolved = await this.participation.countUnsetActiveAttendance(tx, room.id);
      if (unresolved > 0) {
        throw new DomainError('ATTENDANCE_INCOMPLETE', 'Every active accepted participant must have attendance finalized before completion.', {
          room_id: room.id,
          unresolved_active_participants: unresolved,
        });
      }
      await this.completionRequirements.assertSatisfied(tx, room);
      const now = this.clock.now();
      room.status = 'COMPLETED';
      room.completedAt = now;
      room.version += 1;
      room.updatedAt = now;
      const availability = calculateAvailability(room, await this.participation.countActiveParticipants(tx, room.id));
      await this.rooms.update(tx, room, false);
      await this.rooms.upsertAvailability(tx, room.id, availability, now);
      const completionEvent = makeDomainEvent({
        eventType: 'ROOM_COMPLETED', aggregateType: 'ROOM', aggregateId: room.id,
        actorUserId: meta.actorUserId, correlationId: null, causationId: null, schemaVersion: 1,
        payload: { room_id: room.id, status: room.status, completed_at: now.toISOString(), ratings_required: this.skillService !== null },
      }, this.clock);
      await appendOutboxEvent(tx, completionEvent);
      await this.skillService?.onRoomCompleted(tx, room, now);
      await this.reliabilityService?.onRoomCompleted(tx, { room, actorUserId: meta.actorUserId, completionEventId: completionEvent.id, now });
      return { roomId: room.id, status: 'COMPLETED', completedAt: now };
    });
    return this.hydrateCompleteResult(result);
  }

  async autoStartDueRooms(limit = 100): Promise<number> {
    const dueIds = await this.rooms.listDueAutoStartRoomIds(this.db, this.clock.now(), limit);
    let started = 0;
    for (const roomId of dueIds) {
      const result = await this.autoStart(roomId);
      if (!result.replayed && result.body.startSource === 'AUTO') started += 1;
    }
    return started;
  }

  private hydrateStartResult(result: IdempotencyResult<StartRoomSummary>): IdempotencyResult<StartRoomSummary> {
    const actualStartedAt = result.body.actualStartedAt instanceof Date
      ? result.body.actualStartedAt
      : new Date(result.body.actualStartedAt as unknown as string);
    return { ...result, body: { ...result.body, actualStartedAt } };
  }

  private hydrateCompleteResult(result: IdempotencyResult<CompleteRoomSummary>): IdempotencyResult<CompleteRoomSummary> {
    const completedAt = result.body.completedAt instanceof Date
      ? result.body.completedAt
      : new Date(result.body.completedAt as unknown as string);
    return { ...result, body: { ...result.body, completedAt } };
  }

  private async startLocked(tx: Transaction, roomId: string, source: RoomStartSource, actorUserId: string | null): Promise<StartRoomSummary> {
    const room = await this.rooms.findById(tx, roomId, true);
    if (!room) throw new DomainError('ROOM_NOT_FOUND', 'Room was not found.');
    if (source === 'MANUAL' && room.hostUserId !== actorUserId) {
      throw new DomainError('NOT_ROOM_HOST', 'Only the Room HOST may start this Room.');
    }
    if (room.status === 'IN_PROGRESS') {
      return {
        roomId: room.id,
        status: 'IN_PROGRESS',
        actualStartedAt: room.actualStartedAt!,
        startSource: room.startSource!,
        availablePublicSlots: calculateAvailability(room, await this.participation.countActiveParticipants(tx, room.id)).availablePublicSlots,
      };
    }
    const now = this.clock.now();
    assertCanStart(room, now, source);
    room.status = 'IN_PROGRESS';
    room.actualStartedAt = source === 'AUTO' ? (room.scheduledStartAt > now ? room.scheduledStartAt : now) : now;
    room.startSource = source;
    room.version += 1;
    room.updatedAt = now;
    const availability = calculateAvailability(room, await this.participation.countActiveParticipants(tx, room.id));
    const expired = await this.participation.expirePendingApplicationsOnRoomStart(tx, room.id, now);
    await this.rooms.update(tx, room, false);
    await this.rooms.upsertAvailability(tx, room.id, availability, now);
    await appendOutboxEvent(tx, makeDomainEvent({
      eventType: source === 'MANUAL' ? 'ROOM_MANUALLY_STARTED' : 'ROOM_AUTO_STARTED',
      aggregateType: 'ROOM', aggregateId: room.id, actorUserId, correlationId: null, causationId: null, schemaVersion: 1,
      payload: {
        room_id: room.id, status: room.status, actual_started_at: room.actualStartedAt.toISOString(), start_source: source,
        expired_pending_application_count: expired.length,
      },
    }, this.clock));
    for (const application of expired) {
      await appendOutboxEvent(tx, makeDomainEvent({
        eventType: 'JOIN_REQUEST_EXPIRED', aggregateType: 'ROOM_APPLICATION', aggregateId: application.id,
        actorUserId, correlationId: null, causationId: room.id, schemaVersion: 1,
        payload: { application_id: application.id, room_id: room.id, reason_code: 'ROOM_STARTED' },
      }, this.clock));
    }
    return { roomId: room.id, status: 'IN_PROGRESS', actualStartedAt: room.actualStartedAt, startSource: source, availablePublicSlots: availability.availablePublicSlots };
  }

  private async requireHostRoomLocked(tx: Transaction, roomId: string, actorUserId: string): Promise<Room> {
    const room = await this.rooms.findById(tx, roomId, true);
    if (!room) throw new DomainError('ROOM_NOT_FOUND', 'Room was not found.');
    if (room.hostUserId !== actorUserId) throw new DomainError('NOT_ROOM_HOST', 'Only the Room HOST may perform this command.');
    return room;
  }
}
