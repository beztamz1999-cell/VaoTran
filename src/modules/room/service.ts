import { randomBytes } from 'node:crypto';
import { DomainError, logger, newId, systemClock, type Clock } from '../../platform/core.js';
import type { PostgresDatabase, SqlExecutor, Transaction } from '../../platform/database/db.js';
import { PostgresIdempotencyGate, type IdempotencyContext, type IdempotencyResult } from '../../platform/idempotency.js';
import { appendOutboxEvent, makeDomainEvent } from '../../platform/outbox/outbox.js';
import { coarseGeoBucket, safeAnalyticsHour } from '../../platform/analytics/privacy.js';
import {
  assertCanCancel,
  assertExpectedVersion,
  assertRoomEditable,
  calculateAvailability,
  statusOnPublish,
  validateCapacityInvariant,
  validateRoomTimeWindow,
  type EquipmentSupplyMode,
  type Room,
  type RoomEquipmentPolicy,
} from './domain.js';
import { RoomRepository } from './repository.js';
import type { ReliabilityService } from '../reliability/service.js';

export interface ActiveParticipantCounter {
  countActiveParticipants(executor: SqlExecutor, roomId: string): Promise<number>;
}

export interface EquipmentInput {
  supplyMode: EquipmentSupplyMode;
  quantityPerParticipant?: number | null;
  notes?: string | null;
  allowedOptions?: Array<{
    displayName: string;
    equipmentType?: string;
    brand?: string | null;
    model?: string | null;
  }>;
}

export interface CreateRoomInput {
  sportCode: string;
  title?: string | null;
  venue: { name: string; address?: string | null; latitude?: number | null; longitude?: number | null };
  scheduledStartAt: Date;
  scheduledEndAt: Date;
  capacity: number;
  hostParticipates: boolean;
  reservedExternalCount: number;
  priceAmount?: number | null;
  participationFeePerPerson?: number;
  currency?: 'VND';
  preferredSkill?: { minScore?: number | null; maxScore?: number | null } | null;
  equipment: EquipmentInput;
  allowEmergencyReplacement: boolean;
}

export interface UpdateRoomInput {
  expectedVersion?: number;
  title?: string | null;
  venue?: { name?: string; address?: string | null; latitude?: number | null; longitude?: number | null };
  scheduledStartAt?: Date;
  scheduledEndAt?: Date;
  capacity?: number;
  hostParticipates?: boolean;
  reservedExternalCount?: number;
  priceAmount?: number | null;
  participationFeePerPerson?: number;
  currency?: 'VND';
  preferredSkill?: { minScore?: number | null; maxScore?: number | null } | null;
  equipment?: EquipmentInput;
  allowEmergencyReplacement?: boolean;
}

export interface CommandMeta {
  actorUserId: string;
  idempotency: IdempotencyContext;
}

export interface RoomSummary {
  roomId: string;
  status: Room['status'];
  version: number;
  availablePublicSlots: number;
  publicShareToken?: string | null;
  publishedAt?: Date | null;
  cancelledAt?: Date | null;
}

export interface RepeatRoomInput {
  scheduledStartAt: Date;
  scheduledEndAt: Date;
}

const equivalent = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const newPublicShareToken = (): string => randomBytes(32).toString('base64url');

const validateEquipment = (equipment: EquipmentInput): RoomEquipmentPolicy => {
  if (equipment.quantityPerParticipant !== undefined && equipment.quantityPerParticipant !== null && (!Number.isInteger(equipment.quantityPerParticipant) || equipment.quantityPerParticipant <= 0)) {
    throw new DomainError('VALIDATION_ERROR', 'Equipment quantity per participant must be a positive integer.');
  }
  const options = (equipment.allowedOptions ?? []).map((option, index) => {
    if (!option.displayName.trim()) throw new DomainError('VALIDATION_ERROR', 'Equipment option display name is required.');
    return {
      id: newId(),
      equipmentType: option.equipmentType ?? 'SHUTTLECOCK',
      brand: option.brand ?? null,
      model: option.model ?? null,
      displayName: option.displayName.trim(),
      sortOrder: index,
    };
  });
  return {
    supplyMode: equipment.supplyMode,
    quantityPerParticipant: equipment.quantityPerParticipant ?? null,
    notes: equipment.notes ?? null,
    allowedOptions: options,
  };
};

const validateSkill = (min: number | null, max: number | null): void => {
  if ((min === null) !== (max === null)) throw new DomainError('VALIDATION_ERROR', 'Preferred skill must include both min and max or neither.');
  if (min !== null && max !== null && (!Number.isFinite(min) || !Number.isFinite(max) || min < 1 || max > 10 || min > max)) {
    throw new DomainError('VALIDATION_ERROR', 'Preferred skill range must be between 1.0 and 10.0.');
  }
};

const validateParticipationFee = (fee: number): void => {
  if (!Number.isInteger(fee) || fee < 0 || fee > 10_000_000) {
    throw new DomainError('VALIDATION_ERROR', 'Participation fee per person must be an integer from 0 to 10,000,000 VND.');
  }
};

export class RoomService {
  private readonly idempotency: PostgresIdempotencyGate;

  constructor(
    private readonly db: PostgresDatabase,
    private readonly rooms: RoomRepository,
    private readonly clock: Clock = systemClock,
    private readonly activeParticipantCounter?: ActiveParticipantCounter,
    private readonly reliabilityService: ReliabilityService | null = null,
  ) {
    this.idempotency = new PostgresIdempotencyGate(db, clock);
  }

  async create(meta: CommandMeta, input: CreateRoomInput): Promise<IdempotencyResult<RoomSummary>> {
    return this.idempotency.execute(meta.idempotency, 201, async (tx) => {
      validateRoomTimeWindow(input.scheduledStartAt, input.scheduledEndAt);
      validateParticipationFee(input.participationFeePerPerson ?? 0);
      const sportId = await this.rooms.findSportIdByCode(tx, input.sportCode);
      if (!sportId) throw new DomainError('SPORT_NOT_FOUND', 'Active sport was not found.');
      const preferredMin = input.preferredSkill?.minScore ?? null;
      const preferredMax = input.preferredSkill?.maxScore ?? null;
      validateSkill(preferredMin, preferredMax);
      const now = this.clock.now();
      const room: Room = {
        id: newId(), sportId, sportCode: input.sportCode, hostUserId: meta.actorUserId,
        title: input.title ?? null, venueName: input.venue.name, venueAddress: input.venue.address ?? null,
        latitude: input.venue.latitude ?? null, longitude: input.venue.longitude ?? null,
        scheduledStartAt: input.scheduledStartAt, scheduledEndAt: input.scheduledEndAt,
        capacity: input.capacity, hostParticipates: input.hostParticipates,
        reservedExternalCount: input.reservedExternalCount, priceAmount: input.priceAmount ?? null, participationFeePerPerson: input.participationFeePerPerson ?? 0,
        currency: input.currency ?? 'VND', preferredSkillMin: preferredMin, preferredSkillMax: preferredMax,
        allowEmergencyReplacement: input.allowEmergencyReplacement, status: 'DRAFT', publicShareToken: null, publishedAt: null,
        cancelledAt: null, actualStartedAt: null, startSource: null, completedAt: null,
        version: 1, createdAt: now, updatedAt: now, equipment: validateEquipment(input.equipment),
      };
      const availability = validateCapacityInvariant(room, 0);
      await this.rooms.insert(tx, room);
      await this.rooms.upsertAvailability(tx, room.id, availability, now);
      await appendOutboxEvent(tx, makeDomainEvent({
        eventType: 'ROOM_CREATED', aggregateType: 'ROOM', aggregateId: room.id, actorUserId: meta.actorUserId,
        correlationId: null, causationId: null, schemaVersion: 1,
        // M10 analytics dimensions are coarse only; never emit title, address, price or exact coordinates.
        payload: { room_id: room.id, status: room.status, capacity: room.capacity, available_public_slots: availability.availablePublicSlots,
          sport_code: room.sportCode, area_bucket: coarseGeoBucket(room.latitude, room.longitude), scheduled_hour_utc: safeAnalyticsHour(room.scheduledStartAt) },
      }, this.clock));
      return { roomId: room.id, status: room.status, version: room.version, availablePublicSlots: availability.availablePublicSlots };
    });
  }

  async publish(roomId: string, meta: CommandMeta, expectedVersion?: number): Promise<IdempotencyResult<RoomSummary>> {
    return this.idempotency.execute(meta.idempotency, 200, async (tx) => {
      const room = await this.requireHostLocked(tx, roomId, meta.actorUserId);
      assertExpectedVersion(room, expectedVersion);
      if (room.status !== 'DRAFT') throw new DomainError('ROOM_NOT_EDITABLE', 'Only draft Rooms may be published.');
      const activeAcceptedAppParticipants = await this.countActiveParticipants(tx, room.id);
      const availability = validateCapacityInvariant(room, activeAcceptedAppParticipants);
      const now = this.clock.now();
      room.status = statusOnPublish(availability.availablePublicSlots);
      const shareTokenCreated = room.publicShareToken === null;
      room.publicShareToken ??= newPublicShareToken();
      room.publishedAt = now;
      room.version += 1;
      room.updatedAt = now;
      await this.rooms.update(tx, room, false);
      await this.rooms.upsertAvailability(tx, room.id, availability, now);
      await appendOutboxEvent(tx, makeDomainEvent({
        eventType: 'ROOM_PUBLISHED', aggregateType: 'ROOM', aggregateId: room.id, actorUserId: meta.actorUserId,
        correlationId: null, causationId: null, schemaVersion: 1,
        payload: { room_id: room.id, status: room.status, available_public_slots: availability.availablePublicSlots },
      }, this.clock));
      if (shareTokenCreated) {
        await appendOutboxEvent(tx, makeDomainEvent({
          eventType: 'ROOM_SHARE_CREATED', aggregateType: 'ROOM', aggregateId: room.id, actorUserId: meta.actorUserId,
          correlationId: null, causationId: null, schemaVersion: 1,
          payload: { room_id: room.id },
        }, this.clock));
      }
      if (room.status === 'FULL') {
        await appendOutboxEvent(tx, makeDomainEvent({
          eventType: 'ROOM_BECAME_FULL', aggregateType: 'ROOM', aggregateId: room.id, actorUserId: meta.actorUserId,
          correlationId: null, causationId: null, schemaVersion: 1,
          payload: { room_id: room.id, available_public_slots: 0 },
        }, this.clock));
      }
      return { roomId: room.id, status: room.status, version: room.version, availablePublicSlots: availability.availablePublicSlots, publicShareToken: room.publicShareToken, publishedAt: room.publishedAt };
    });
  }

  async update(roomId: string, meta: CommandMeta, input: UpdateRoomInput): Promise<IdempotencyResult<RoomSummary>> {
    return this.idempotency.execute(meta.idempotency, 200, async (tx) => {
      const previous = await this.requireHostLocked(tx, roomId, meta.actorUserId);
      assertExpectedVersion(previous, input.expectedVersion);
      assertRoomEditable(previous);
      const next = this.applyUpdate(previous, input);
      validateRoomTimeWindow(next.scheduledStartAt, next.scheduledEndAt);
      validateSkill(next.preferredSkillMin, next.preferredSkillMax);
      validateParticipationFee(next.participationFeePerPerson);
      const activeAcceptedAppParticipants = await this.countActiveParticipants(tx, previous.id);
      const availability = validateCapacityInvariant(next, activeAcceptedAppParticipants);
      if (next.status === 'OPEN' || next.status === 'FULL') next.status = availability.availablePublicSlots > 0 ? 'OPEN' : 'FULL';
      const now = this.clock.now();
      next.version = previous.version + 1;
      next.updatedAt = now;
      const equipmentChanged = !equivalent(previous.equipment, next.equipment);
      const changes = this.rooms.makeChangeLogs(next.id, meta.actorUserId, previous, next, this.clock);
      await this.rooms.update(tx, next, equipmentChanged);
      await this.rooms.upsertAvailability(tx, next.id, availability, now);
      await this.rooms.addChangeLogs(tx, changes);
      await appendOutboxEvent(tx, makeDomainEvent({
        eventType: 'ROOM_UPDATED', aggregateType: 'ROOM', aggregateId: next.id, actorUserId: meta.actorUserId,
        correlationId: null, causationId: null, schemaVersion: 1,
        payload: { room_id: next.id, version: next.version, changed_fields: changes.map((change) => change.fieldName) },
      }, this.clock));
      if (changes.some((change) => change.isMaterialChange)) {
        await appendOutboxEvent(tx, makeDomainEvent({
          eventType: 'ROOM_MATERIAL_CHANGED', aggregateType: 'ROOM', aggregateId: next.id, actorUserId: meta.actorUserId,
          correlationId: null, causationId: null, schemaVersion: 1,
          payload: { room_id: next.id, version: next.version, material_fields: changes.filter((change) => change.isMaterialChange).map((change) => change.fieldName) },
        }, this.clock));
      }
      if (previous.status === 'OPEN' && next.status === 'FULL') {
        await appendOutboxEvent(tx, makeDomainEvent({
          eventType: 'ROOM_BECAME_FULL', aggregateType: 'ROOM', aggregateId: next.id, actorUserId: meta.actorUserId,
          correlationId: null, causationId: null, schemaVersion: 1,
          payload: { room_id: next.id, available_public_slots: 0 },
        }, this.clock));
      }
      if (previous.status === 'FULL' && next.status === 'OPEN') {
        await appendOutboxEvent(tx, makeDomainEvent({
          eventType: 'ROOM_REOPENED', aggregateType: 'ROOM', aggregateId: next.id, actorUserId: meta.actorUserId,
          correlationId: null, causationId: null, schemaVersion: 1,
          payload: { room_id: next.id, available_public_slots: availability.availablePublicSlots },
        }, this.clock));
      }
      return { roomId: next.id, status: next.status, version: next.version, availablePublicSlots: availability.availablePublicSlots, publishedAt: next.publishedAt };
    });
  }

  async updateReservedExternalCount(roomId: string, meta: CommandMeta, count: number, expectedVersion?: number): Promise<IdempotencyResult<RoomSummary>> {
    return this.update(roomId, meta, { expectedVersion, reservedExternalCount: count });
  }

  async cancel(roomId: string, meta: CommandMeta, expectedVersion?: number, reasonCode?: string): Promise<IdempotencyResult<RoomSummary>> {
    return this.idempotency.execute(meta.idempotency, 200, async (tx) => {
      const room = await this.requireHostLocked(tx, roomId, meta.actorUserId);
      assertExpectedVersion(room, expectedVersion);
      assertCanCancel(room);
      const now = this.clock.now();
      room.status = 'CANCELLED';
      room.cancelledAt = now;
      room.version += 1;
      room.updatedAt = now;
      await this.reliabilityService?.cancelRoomParticipation(tx, { room, actorUserId: meta.actorUserId, reasonCode, now });
      const activeAcceptedAppParticipants = await this.countActiveParticipants(tx, room.id);
      const availability = validateCapacityInvariant(room, activeAcceptedAppParticipants);
      await this.rooms.update(tx, room, false);
      await this.rooms.upsertAvailability(tx, room.id, availability, now);
      await appendOutboxEvent(tx, makeDomainEvent({
        eventType: 'ROOM_CANCELLED', aggregateType: 'ROOM', aggregateId: room.id, actorUserId: meta.actorUserId,
        correlationId: null, causationId: null, schemaVersion: 1,
        payload: { room_id: room.id, reason_code: reasonCode ?? null, status: room.status },
      }, this.clock));
      return { roomId: room.id, status: room.status, version: room.version, availablePublicSlots: availability.availablePublicSlots, cancelledAt: room.cancelledAt };
    });
  }

  async repeat(roomId: string, meta: CommandMeta, input: RepeatRoomInput): Promise<IdempotencyResult<RoomSummary>> {
    return this.idempotency.execute(meta.idempotency, 201, async (tx) => {
      const source = await this.requireHostLocked(tx, roomId, meta.actorUserId);
      if (source.status !== 'COMPLETED') throw new DomainError('ROOM_NOT_REPEATABLE', 'Only completed Rooms may be repeated.');
      validateRoomTimeWindow(input.scheduledStartAt, input.scheduledEndAt);
      const now = this.clock.now();
      const room: Room = {
        id: newId(), sportId: source.sportId, sportCode: source.sportCode, hostUserId: source.hostUserId,
        title: source.title, venueName: source.venueName, venueAddress: source.venueAddress,
        latitude: source.latitude, longitude: source.longitude, scheduledStartAt: input.scheduledStartAt,
        scheduledEndAt: input.scheduledEndAt, capacity: source.capacity, hostParticipates: source.hostParticipates,
        reservedExternalCount: source.reservedExternalCount, priceAmount: source.priceAmount, participationFeePerPerson: source.participationFeePerPerson, currency: source.currency,
        preferredSkillMin: source.preferredSkillMin, preferredSkillMax: source.preferredSkillMax,
        allowEmergencyReplacement: source.allowEmergencyReplacement, status: 'DRAFT', publicShareToken: null,
        publishedAt: null, cancelledAt: null, actualStartedAt: null, startSource: null, completedAt: null,
        version: 1, createdAt: now, updatedAt: now,
        equipment: {
          supplyMode: source.equipment.supplyMode,
          quantityPerParticipant: source.equipment.quantityPerParticipant,
          notes: source.equipment.notes,
          allowedOptions: source.equipment.allowedOptions.map((option) => ({
            id: newId(), equipmentType: option.equipmentType, brand: option.brand, model: option.model,
            displayName: option.displayName, sortOrder: option.sortOrder,
          })),
        },
      };
      const availability = validateCapacityInvariant(room, 0);
      await this.rooms.insert(tx, room);
      await this.rooms.upsertAvailability(tx, room.id, availability, now);
      await appendOutboxEvent(tx, makeDomainEvent({
        eventType: 'ROOM_CREATED', aggregateType: 'ROOM', aggregateId: room.id, actorUserId: meta.actorUserId,
        correlationId: null, causationId: null, schemaVersion: 1,
        // M10 analytics dimensions are coarse only; never emit title, address, price or exact coordinates.
        payload: { room_id: room.id, status: room.status, capacity: room.capacity, available_public_slots: availability.availablePublicSlots, source_room_id: source.id,
          sport_code: room.sportCode, area_bucket: coarseGeoBucket(room.latitude, room.longitude), scheduled_hour_utc: safeAnalyticsHour(room.scheduledStartAt) },
      }, this.clock));
      await appendOutboxEvent(tx, makeDomainEvent({
        eventType: 'REPEAT_ROOM_CREATED', aggregateType: 'ROOM', aggregateId: room.id, actorUserId: meta.actorUserId,
        correlationId: null, causationId: null, schemaVersion: 1,
        payload: { room_id: room.id, source_room_id: source.id, status: room.status },
      }, this.clock));
      return { roomId: room.id, status: room.status, version: room.version, availablePublicSlots: availability.availablePublicSlots };
    });
  }

  async getRoom(roomId: string): Promise<{ room: Room; availability: ReturnType<typeof calculateAvailability> }> {
    const room = await this.rooms.findById(this.db, roomId);
    if (!room) throw new DomainError('ROOM_NOT_FOUND', 'Room was not found.');
    return { room, availability: calculateAvailability(room, await this.countActiveParticipants(this.db, room.id)) };
  }

  async getSharedRoom(shareToken: string): Promise<{ room: Room; availability: ReturnType<typeof calculateAvailability> }> {
    const room = await this.rooms.findByPublicShareToken(this.db, shareToken);
    if (!room) throw new DomainError('ROOM_NOT_FOUND', 'Shared Room was not found.');
    return { room, availability: calculateAvailability(room, await this.countActiveParticipants(this.db, room.id)) };
  }

  /** Best-effort read-side capture; a telemetry failure must not affect the public share response. */
  async recordShareViewed(roomId: string): Promise<void> {
    try {
      await this.db.transaction(async (tx) => appendOutboxEvent(tx, makeDomainEvent({
        eventType: 'SHARE_VIEWED', aggregateType: 'ROOM', aggregateId: roomId, actorUserId: null,
        correlationId: null, causationId: null, schemaVersion: 1, payload: { room_id: roomId },
      }, this.clock)));
    } catch (error) {
      logger.warn({ component: 'analytics', event_type: 'SHARE_VIEWED', room_id: roomId, err: error }, 'Best-effort share analytics capture failed');
    }
  }

  async getHostRoom(roomId: string, actorUserId: string): Promise<{ room: Room; availability: ReturnType<typeof calculateAvailability> }> {
    const result = await this.getRoom(roomId);
    if (result.room.hostUserId !== actorUserId) throw new DomainError('NOT_ROOM_HOST', 'Only the Room HOST may access Room management.');
    return result;
  }

  private async countActiveParticipants(executor: SqlExecutor, roomId: string): Promise<number> {
    return this.activeParticipantCounter ? this.activeParticipantCounter.countActiveParticipants(executor, roomId) : 0;
  }

  private async requireHostLocked(tx: Transaction, roomId: string, actorUserId: string): Promise<Room> {
    const room = await this.rooms.findById(tx, roomId, true);
    if (!room) throw new DomainError('ROOM_NOT_FOUND', 'Room was not found.');
    if (room.hostUserId !== actorUserId) throw new DomainError('NOT_ROOM_HOST', 'Only the Room HOST may perform this command.');
    return room;
  }

  private applyUpdate(previous: Room, input: UpdateRoomInput): Room {
    const skill = input.preferredSkill === undefined
      ? { min: previous.preferredSkillMin, max: previous.preferredSkillMax }
      : { min: input.preferredSkill?.minScore ?? null, max: input.preferredSkill?.maxScore ?? null };
    return {
      ...previous,
      title: input.title === undefined ? previous.title : input.title,
      venueName: input.venue?.name ?? previous.venueName,
      venueAddress: input.venue?.address === undefined ? previous.venueAddress : input.venue.address,
      latitude: input.venue?.latitude === undefined ? previous.latitude : input.venue.latitude,
      longitude: input.venue?.longitude === undefined ? previous.longitude : input.venue.longitude,
      scheduledStartAt: input.scheduledStartAt ?? previous.scheduledStartAt,
      scheduledEndAt: input.scheduledEndAt ?? previous.scheduledEndAt,
      capacity: input.capacity ?? previous.capacity,
      hostParticipates: input.hostParticipates ?? previous.hostParticipates,
      reservedExternalCount: input.reservedExternalCount ?? previous.reservedExternalCount,
      priceAmount: input.priceAmount === undefined ? previous.priceAmount : input.priceAmount,
      participationFeePerPerson: input.participationFeePerPerson === undefined ? previous.participationFeePerPerson : input.participationFeePerPerson,
      currency: input.currency ?? previous.currency,
      preferredSkillMin: skill.min,
      preferredSkillMax: skill.max,
      allowEmergencyReplacement: input.allowEmergencyReplacement ?? previous.allowEmergencyReplacement,
      equipment: input.equipment === undefined ? previous.equipment : validateEquipment(input.equipment),
    };
  }
}
