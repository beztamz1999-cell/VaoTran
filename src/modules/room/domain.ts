import { domainError, type ErrorCode } from '../../platform/core.js';

export type RoomStatus = 'DRAFT' | 'OPEN' | 'FULL' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
export type RoomStartSource = 'MANUAL' | 'AUTO';
export type EquipmentSupplyMode = 'HOST_PROVIDES' | 'PLAYER_BRINGS' | 'MIXED' | 'NOT_APPLICABLE';

export interface RoomEquipmentOption {
  id: string;
  equipmentType: string;
  brand: string | null;
  model: string | null;
  displayName: string;
  sortOrder: number;
}

export interface RoomEquipmentPolicy {
  supplyMode: EquipmentSupplyMode;
  quantityPerParticipant: number | null;
  notes: string | null;
  allowedOptions: RoomEquipmentOption[];
}

export interface Room {
  id: string;
  sportId: string;
  sportCode: string;
  hostUserId: string;
  title: string | null;
  venueName: string;
  venueAddress: string | null;
  latitude: number | null;
  longitude: number | null;
  scheduledStartAt: Date;
  scheduledEndAt: Date;
  capacity: number;
  hostParticipates: boolean;
  reservedExternalCount: number;
  priceAmount: number | null;
  currency: 'VND';
  preferredSkillMin: number | null;
  preferredSkillMax: number | null;
  allowEmergencyReplacement: boolean;
  status: RoomStatus;
  publicShareToken: string | null;
  publishedAt: Date | null;
  cancelledAt: Date | null;
  actualStartedAt: Date | null;
  startSource: RoomStartSource | null;
  completedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  equipment: RoomEquipmentPolicy;
}

export interface RoomAvailability {
  hostSlot: number;
  reservedExternalCount: number;
  activeAcceptedAppParticipants: number;
  effectiveNoShowCount: number;
  occupiedSlots: number;
  availablePublicSlots: number;
}

export const calculateAvailability = (
  room: Pick<Room, 'capacity' | 'hostParticipates' | 'reservedExternalCount'>,
  activeAcceptedAppParticipants: number,
  effectiveNoShowCount = 0,
): RoomAvailability => {
  const hostSlot = room.hostParticipates ? 1 : 0;
  const occupiedSlots = hostSlot + room.reservedExternalCount + activeAcceptedAppParticipants;
  return {
    hostSlot,
    reservedExternalCount: room.reservedExternalCount,
    activeAcceptedAppParticipants,
    effectiveNoShowCount,
    occupiedSlots,
    availablePublicSlots: room.capacity - occupiedSlots,
  };
};

export const validateCapacityInvariant = (
  room: Pick<Room, 'capacity' | 'hostParticipates' | 'reservedExternalCount'>,
  activeAcceptedAppParticipants: number,
): RoomAvailability => {
  if (!Number.isInteger(room.capacity) || room.capacity < 1) {
    domainError('INVALID_CAPACITY', 'Room capacity must be a positive integer.');
  }
  if (!Number.isInteger(room.reservedExternalCount) || room.reservedExternalCount < 0) {
    domainError('INVALID_RESERVED_COUNT', 'Reserved external count must be a non-negative integer.');
  }
  if (!Number.isInteger(activeAcceptedAppParticipants) || activeAcceptedAppParticipants < 0) {
    domainError('INVALID_CAPACITY', 'Active accepted app participant count is invalid.');
  }
  const availability = calculateAvailability(room, activeAcceptedAppParticipants);
  if (availability.availablePublicSlots < 0) {
    const code: ErrorCode = activeAcceptedAppParticipants > 0 ? 'INVALID_CAPACITY' : 'INVALID_RESERVED_COUNT';
    domainError(code, 'Room capacity cannot be lower than occupied slots.', {
      capacity: room.capacity,
      host_slot: availability.hostSlot,
      reserved_external_count: room.reservedExternalCount,
      active_accepted_app_participants: activeAcceptedAppParticipants,
    });
  }
  return availability;
};

export const validateRoomTimeWindow = (startAt: Date, endAt: Date): void => {
  if (!(startAt instanceof Date) || Number.isNaN(startAt.getTime()) || !(endAt instanceof Date) || Number.isNaN(endAt.getTime()) || endAt <= startAt) {
    domainError('INVALID_TIME_WINDOW', 'Scheduled end time must be later than scheduled start time.');
  }
};

export const derivePreStartStatus = (room: Pick<Room, 'status'>, availablePublicSlots: number): RoomStatus => {
  if (room.status === 'DRAFT' || room.status === 'IN_PROGRESS' || room.status === 'COMPLETED' || room.status === 'CANCELLED') {
    return room.status;
  }
  return availablePublicSlots > 0 ? 'OPEN' : 'FULL';
};

export const statusOnPublish = (availablePublicSlots: number): RoomStatus => (
  availablePublicSlots > 0 ? 'OPEN' : 'FULL'
);

export const assertRoomEditable = (room: Room): void => {
  if (room.status === 'COMPLETED' || room.status === 'CANCELLED') {
    domainError('ROOM_TERMINAL', 'Terminal Rooms cannot be edited.');
  }
  if (room.status === 'IN_PROGRESS') {
    domainError('ROOM_NOT_EDITABLE', 'In-progress Rooms cannot be edited by this command.');
  }
};

export const maxManualEarlyStartMs = 30 * 60 * 1000;
export const noShowGraceMs = 15 * 60 * 1000;

export const assertCanStart = (room: Room, now: Date, source: RoomStartSource): void => {
  if (room.status === 'COMPLETED' || room.status === 'CANCELLED') {
    domainError('ROOM_TERMINAL', 'Terminal Rooms cannot be started.');
  }
  if (room.status !== 'OPEN' && room.status !== 'FULL') {
    domainError('ROOM_NOT_EDITABLE', 'Room cannot be started in its current state.');
  }
  const earliestManualStart = new Date(room.scheduledStartAt.getTime() - maxManualEarlyStartMs);
  if (source === 'MANUAL' && now < earliestManualStart) {
    domainError('START_TOO_EARLY', 'Room may only be manually started within 30 minutes of the scheduled start.', {
      scheduled_start_at: room.scheduledStartAt.toISOString(),
      earliest_manual_start_at: earliestManualStart.toISOString(),
    });
  }
  if (source === 'AUTO' && now < room.scheduledStartAt) {
    domainError('START_TOO_EARLY', 'Room is not due for auto-start.', {
      scheduled_start_at: room.scheduledStartAt.toISOString(),
    });
  }
};

export const assertCanComplete = (room: Room): void => {
  if (room.status === 'COMPLETED') domainError('ROOM_TERMINAL', 'Completed Rooms are terminal.');
  if (room.status !== 'IN_PROGRESS') domainError('ROOM_NOT_IN_PROGRESS', 'Room must be in progress before it can be completed.');
};

export const assertCanCancel = (room: Room): void => {
  if (!['DRAFT', 'OPEN', 'FULL'].includes(room.status)) {
    domainError(room.status === 'COMPLETED' || room.status === 'CANCELLED' ? 'ROOM_TERMINAL' : 'ROOM_NOT_EDITABLE', 'Room cannot be cancelled in its current state.');
  }
};

export const assertExpectedVersion = (room: Room, expectedVersion: number | undefined): void => {
  if (expectedVersion !== undefined && expectedVersion !== room.version) {
    domainError('VERSION_CONFLICT', 'Room version does not match the current server state.', {
      expected_version: expectedVersion,
      current_version: room.version,
    });
  }
};

export const materialRoomFields = new Set([
  'scheduledStartAt',
  'scheduledEndAt',
  'venueName',
  'venueAddress',
  'latitude',
  'longitude',
  'priceAmount',
  'currency',
  'equipment',
]);

export const isMaterialChange = (fieldName: string): boolean => materialRoomFields.has(fieldName);
