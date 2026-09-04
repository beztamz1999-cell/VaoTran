import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { DomainError, type Clock } from '../platform/core.js';
import type { PostgresDatabase, Transaction } from '../platform/database/db.js';
import { IdentityService } from '../modules/identity/service.js';
import { PostgresIdempotencyGate } from '../platform/idempotency.js';
import { PostgresOutboxWorker, appendOutboxEvent, makeDomainEvent, type DomainEvent } from '../platform/outbox/outbox.js';
import { calculateAvailability, validateCapacityInvariant, type Room } from '../modules/room/domain.js';
import { RoomRepository } from '../modules/room/repository.js';
import { RoomLifecycleService } from '../modules/room/lifecycle-service.js';
import { SearchService } from '../modules/search/service.js';
import { RoomService, type CommandMeta } from '../modules/room/service.js';
import { ParticipationService } from '../modules/participation/service.js';
import { createApp } from '../platform/http/app.js';

type StoredKey = {
  key: string;
  actorUserId: string;
  commandType: string;
  requestHash: string;
  responseStatus: number | null;
  responseJson: unknown | null;
};

class MemoryTx {
  readonly idempotency = new Map<string, StoredKey>();
  readonly events: DomainEvent[] = [];

  async query<T>(text: string, values: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
    if (text.includes('SELECT key, actor_user_id')) {
      const item = this.idempotency.get(values[0] as string);
      const row = item ? {
        key: item.key, actor_user_id: item.actorUserId, command_type: item.commandType,
        request_hash: item.requestHash, response_status: item.responseStatus, response_json: item.responseJson,
      } : undefined;
      return { rows: row ? [row as T] : [], rowCount: row ? 1 : 0 };
    }
    if (text.includes('INSERT INTO idempotency_keys')) {
      this.idempotency.set(values[0] as string, {
        key: values[0] as string, actorUserId: values[1] as string, commandType: values[2] as string,
        requestHash: values[3] as string, responseStatus: null, responseJson: null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('UPDATE idempotency_keys SET response_status')) {
      const item = this.idempotency.get(values[0] as string)!;
      item.responseStatus = values[1] as number;
      item.responseJson = JSON.parse(values[2] as string);
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('INSERT INTO event_outbox')) {
      this.events.push({
        id: values[0] as string, eventType: values[1] as string, aggregateType: values[2] as string,
        aggregateId: values[3] as string, actorUserId: values[4] as string | null,
        correlationId: values[5] as string | null, causationId: values[6] as string | null,
        schemaVersion: values[7] as number, payload: JSON.parse(values[8] as string), occurredAt: values[9] as Date,
      });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

class MemoryDb {
  readonly tx = new MemoryTx();
  async transaction<T>(operation: (tx: Transaction) => Promise<T>): Promise<T> {
    return operation(this.tx as unknown as Transaction);
  }
}

const clock: Clock = { now: () => new Date('2026-08-20T09:00:00.000Z') };
const actor = '20000000-0000-4000-8000-000000000001';
const commandMeta = (commandType: string, key: string, request: unknown): CommandMeta => ({
  actorUserId: actor,
  idempotency: { actorUserId: actor, commandType, key, request },
});

const cloneRoom = (room: Room): Room => structuredClone(room);

class MemoryRoomRepository {
  room: Room | null = null;
  projection = { availablePublicSlots: 0, occupiedSlots: 0 };
  readonly logs: Array<{ fieldName: string; isMaterialChange: boolean }> = [];

  async findSportIdByCode(_tx: Transaction, code: string): Promise<string | null> {
    return code === 'BADMINTON' ? '10000000-0000-4000-8000-000000000001' : null;
  }
  async insert(_tx: Transaction, room: Room): Promise<void> { this.room = cloneRoom(room); }
  async update(_tx: Transaction, room: Room): Promise<void> { this.room = cloneRoom(room); }
  async upsertAvailability(_tx: Transaction, _roomId: string, availability: { availablePublicSlots: number; occupiedSlots: number }): Promise<void> {
    this.projection = { availablePublicSlots: availability.availablePublicSlots, occupiedSlots: availability.occupiedSlots };
  }
  async addChangeLogs(_tx: Transaction, changes: Array<{ fieldName: string; isMaterialChange: boolean }>): Promise<void> { this.logs.push(...changes); }
  async findById(_tx: unknown, roomId: string, _forUpdate = false): Promise<Room | null> {
    return this.room?.id === roomId ? cloneRoom(this.room) : null;
  }
  makeChangeLogs(_roomId: string, _actorId: string, previous: Room, next: Room) {
    const values: Array<keyof Room> = ['venueName', 'reservedExternalCount', 'capacity'];
    return values.flatMap((fieldName) => JSON.stringify(previous[fieldName]) === JSON.stringify(next[fieldName]) ? [] : [{
      id: `log-${fieldName}`, roomId: next.id, changedByUserId: actor, fieldName,
      oldValue: previous[fieldName], newValue: next[fieldName],
      isMaterialChange: fieldName === 'venueName', createdAt: clock.now(),
    }]);
  }
}

describe('M1 Room capacity invariant', () => {
  it('computes the source-of-truth availability exactly as specified', () => {
    const availability = calculateAvailability({ capacity: 8, hostParticipates: true, reservedExternalCount: 5 }, 0);
    expect(availability).toEqual({
      hostSlot: 1, reservedExternalCount: 5, activeAcceptedAppParticipants: 0,
      effectiveNoShowCount: 0, occupiedSlots: 6, availablePublicSlots: 2,
    });
  });

  it('rejects reserved external occupancy that would exceed capacity', () => {
    expect(() => validateCapacityInvariant({ capacity: 8, hostParticipates: true, reservedExternalCount: 8 }, 0))
      .toThrowError(expect.objectContaining({ code: 'INVALID_RESERVED_COUNT' }));
  });

  it('persists create → publish → full → cancel with outbox facts in the same command transaction', async () => {
    const db = new MemoryDb();
    const repository = new MemoryRoomRepository();
    const service = new RoomService(db as unknown as PostgresDatabase, repository as unknown as RoomRepository, clock);
    const created = await service.create(commandMeta('CreateRoom', 'create-1', { name: 'room' }), {
      sportCode: 'BADMINTON', venue: { name: 'Sân A' },
      scheduledStartAt: new Date('2026-08-22T12:30:00Z'), scheduledEndAt: new Date('2026-08-22T14:30:00Z'),
      capacity: 8, hostParticipates: true, reservedExternalCount: 5,
      equipment: { supplyMode: 'PLAYER_BRINGS', quantityPerParticipant: 2, allowedOptions: [{ displayName: 'S70' }] },
      allowEmergencyReplacement: true,
    });
    expect(created.body).toMatchObject({ status: 'DRAFT', availablePublicSlots: 2, version: 1 });
    const roomId = created.body.roomId;

    const published = await service.publish(roomId, commandMeta('PublishRoom', 'publish-1', {}), 1);
    expect(published.body).toMatchObject({ status: 'OPEN', availablePublicSlots: 2, version: 2 });

    const full = await service.updateReservedExternalCount(roomId, commandMeta('UpdateReservedExternalCount', 'reserved-1', { count: 7, version: 2 }), 7, 2);
    expect(full.body).toMatchObject({ status: 'FULL', availablePublicSlots: 0, version: 3 });

    const cancelled = await service.cancel(roomId, commandMeta('CancelRoom', 'cancel-1', { version: 3 }), 3, 'HOST_UNAVAILABLE');
    expect(cancelled.body).toMatchObject({ status: 'CANCELLED', version: 4 });
    expect(db.tx.events.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      'ROOM_CREATED', 'ROOM_PUBLISHED', 'ROOM_UPDATED', 'ROOM_BECAME_FULL', 'ROOM_CANCELLED',
    ]));
  });
});

describe('M0 idempotency', () => {
  it('replays the stored command response and rejects semantic key reuse', async () => {
    const db = new MemoryDb();
    const gate = new PostgresIdempotencyGate(db as unknown as PostgresDatabase, clock);
    let operationCount = 0;
    const context = { key: 'same-key', actorUserId: actor, commandType: 'PublishRoom', request: { room_id: 'r1' } };
    const first = await gate.execute(context, 200, async () => ({ value: ++operationCount }));
    const replay = await gate.execute(context, 200, async () => ({ value: ++operationCount }));
    expect(first).toMatchObject({ replayed: false, body: { value: 1 } });
    expect(replay).toMatchObject({ replayed: true, body: { value: 1 } });
    expect(operationCount).toBe(1);
    await expect(gate.execute({ ...context, request: { room_id: 'other' } }, 200, async () => ({ value: 3 })))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
});

describe('M0 outbox smoke', () => {
  it('inserts a domain fact transactionally', async () => {
    const tx = new MemoryTx();
    const event = makeDomainEvent({
      eventType: 'ROOM_PUBLISHED', aggregateType: 'ROOM', aggregateId: 'r1', actorUserId: actor,
      correlationId: null, causationId: null, schemaVersion: 1, payload: { room_id: 'r1' },
    }, clock);
    await appendOutboxEvent(tx as unknown as Transaction, event);
    expect(tx.events).toHaveLength(1);
    expect(tx.events[0]).toMatchObject({ eventType: 'ROOM_PUBLISHED', aggregateId: 'r1' });
  });
});

class MemoryWorkerTx {
  constructor(private readonly state: MemoryWorkerDb) {}

  async query<T>(text: string, values: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
    if (text.includes('WITH claimed AS')) {
      const row = this.state.row;
      if (!row || !['PENDING', 'FAILED_RETRYABLE'].includes(row.publish_status)) return { rows: [], rowCount: 0 };
      row.publish_status = 'PROCESSING';
      row.attempt_count += 1;
      return { rows: [structuredClone(row) as T], rowCount: 1 };
    }
    if (text.includes('SELECT event_id FROM event_consumptions')) {
      const key = `${values[0] as string}:${values[1] as string}`;
      return this.state.consumptions.has(key) ? { rows: [{ event_id: values[1] } as T], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (text.includes('INSERT INTO event_consumptions')) {
      this.state.consumptions.add(`${values[0] as string}:${values[1] as string}`);
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("SET publish_status = 'PUBLISHED'")) {
      if (this.state.row) this.state.row.publish_status = 'PUBLISHED';
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('SET publish_status = $2')) {
      if (this.state.row) this.state.row.publish_status = values[1] as string;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

interface MemoryOutboxRow {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  actor_user_id: string | null;
  correlation_id: string | null;
  causation_id: string | null;
  schema_version: number;
  payload_json: Record<string, unknown>;
  occurred_at: Date;
  attempt_count: number;
  publish_status: string;
}

class MemoryWorkerDb {
  row: MemoryOutboxRow | null;
  readonly consumptions = new Set<string>();
  constructor(event: DomainEvent) {
    this.row = {
      id: event.id, event_type: event.eventType, aggregate_type: event.aggregateType, aggregate_id: event.aggregateId,
      actor_user_id: event.actorUserId, correlation_id: event.correlationId, causation_id: event.causationId,
      schema_version: event.schemaVersion, payload_json: event.payload, occurred_at: event.occurredAt,
      attempt_count: 0, publish_status: 'PENDING',
    };
  }
  async transaction<T>(operation: (tx: Transaction) => Promise<T>): Promise<T> {
    return operation(new MemoryWorkerTx(this) as unknown as Transaction);
  }
}

describe('M0 outbox worker smoke', () => {
  it('claims, delivers, records consumption, and marks an event published exactly once per consumer', async () => {
    const event = makeDomainEvent({
      eventType: 'ROOM_CANCELLED', aggregateType: 'ROOM', aggregateId: 'r-worker', actorUserId: actor,
      correlationId: null, causationId: null, schemaVersion: 1, payload: { room_id: 'r-worker' },
    }, clock);
    const db = new MemoryWorkerDb(event);
    const worker = new PostgresOutboxWorker(db as never, clock);
    const handled: string[] = [];
    const consumer = { name: 'test-consumer', handle: async (received: DomainEvent) => { handled.push(received.id); } };
    expect(await worker.runOnce(consumer)).toBe(1);
    expect(handled).toEqual([event.id]);
    expect(db.row?.publish_status).toBe('PUBLISHED');
    expect(await worker.runOnce(consumer)).toBe(0);
    expect(handled).toEqual([event.id]);
  });
});

describe('M0 API error envelope', () => {
  it('returns the canonical UNAUTHENTICATED envelope before executing a Room command', async () => {
    const app = createApp({ rooms: {} as RoomService, identity: {} as IdentityService, participation: {} as ParticipationService, lifecycle: {} as RoomLifecycleService, search: {} as SearchService });
    const response = await request(app).get('/api/v1/me');
    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.', details: {} },
    });
  });
});

describe('M1 Room HTTP command', () => {
  it('accepts a valid CreateRoom contract and forwards a server-owned command', async () => {
    const commands: unknown[] = [];
    const rooms = {
      create: async (meta: unknown, command: unknown) => {
        commands.push({ meta, command });
        return { status: 201, body: { roomId: 'room-http', status: 'DRAFT' as const, version: 1, availablePublicSlots: 2 }, replayed: false };
      },
    } as unknown as RoomService;
    const app = createApp({ rooms, identity: {} as IdentityService, participation: {} as ParticipationService, lifecycle: {} as RoomLifecycleService, search: {} as SearchService });
    const response = await request(app)
      .post('/api/v1/rooms')
      .set('X-Actor-User-Id', actor)
      .set('Idempotency-Key', 'create-http-1')
      .send({
        sport_code: 'BADMINTON', venue: { name: 'Sân A', address: 'Hà Nội' },
        scheduled_start_at: '2026-08-22T12:30:00.000Z', scheduled_end_at: '2026-08-22T14:30:00.000Z',
        capacity: 8, host_participates: true, reserved_external_count: 5,
        price_amount: 80000, currency: 'VND', preferred_skill: { min_score: 5, max_score: 7.5 },
        equipment: { supply_mode: 'PLAYER_BRINGS', quantity_per_participant: 2, allowed_options: [{ display_name: 'S70' }] },
        allow_emergency_replacement: true,
      });
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ data: { room_id: 'room-http', status: 'DRAFT', version: 1 } });
    expect(commands).toHaveLength(1);
  });
});

describe('Host Room Manager projection', () => {
  it('returns authoritative participant and application data instead of placeholder lists', async () => {
    const room: Room = {
      id: 'room-manager', sportId: 'sport-1', sportCode: 'BADMINTON', hostUserId: actor, title: 'Evening doubles',
      venueName: 'Court A', venueAddress: null, latitude: null, longitude: null,
      scheduledStartAt: new Date('2026-08-22T12:30:00.000Z'), scheduledEndAt: new Date('2026-08-22T14:30:00.000Z'),
      capacity: 8, hostParticipates: true, reservedExternalCount: 5, priceAmount: null, participationFeePerPerson: 0, currency: 'VND',
      preferredSkillMin: null, preferredSkillMax: null, allowEmergencyReplacement: true, status: 'OPEN',
      publicShareToken: null, publishedAt: null, cancelledAt: null, actualStartedAt: null, startSource: null,
      completedAt: null, version: 1, createdAt: clock.now(), updatedAt: clock.now(),
      equipment: { supplyMode: 'PLAYER_BRINGS', quantityPerParticipant: null, notes: null, allowedOptions: [] },
    };
    const rooms = {
      getHostRoom: async () => ({ room, availability: calculateAvailability(room, 1) }),
    } as unknown as RoomService;
    const participation = {
      listHostPendingApplications: async () => [{
        application: {
          id: 'application-1', roomId: room.id, requestedByUserId: 'player-1', partyId: null,
          applicationOwnerKey: 'USER:player-1', requestedSlotCount: 1, status: 'REQUESTED' as const,
          requestedAt: clock.now(), acceptedAt: null, rejectedAt: null, withdrawnAt: null, expiredAt: null,
          rejectionReasonCode: null, version: 1, createdAt: clock.now(), updatedAt: clock.now(),
        },
        members: [{
          id: 'member-1', applicationId: 'application-1', sourcePartyMemberId: null, memberType: 'USER' as const,
          userId: 'player-1', guestLabel: null, displayName: 'Player One', skillStateSnapshot: 'UNRANKED',
          skillScoreSnapshot: null, rankTierSnapshot: null, reliabilityScoreSnapshot: 100, createdAt: clock.now(),
        }],
      }],
      listHostParticipants: async () => [{
        id: 'participant-1', roomId: room.id, applicationId: 'accepted-application', applicationMemberId: 'accepted-member',
        userId: 'player-2', memberType: 'USER' as const, status: 'ACTIVE' as const, attendanceStatus: 'NOT_SET' as const,
        attendanceMarkedAt: null, attendanceMarkedByUserId: null, attendanceReasonCode: null, acceptedAt: clock.now(),
        cancelledAt: null, removedAt: null, removedByUserId: null, removalReasonCode: null, version: 1,
        createdAt: clock.now(), updatedAt: clock.now(), displayName: 'Player Two',
      }],
    } as unknown as ParticipationService;
    const app = createApp({ rooms, identity: {} as IdentityService, participation, lifecycle: {} as RoomLifecycleService, search: {} as SearchService });

    const response = await request(app).get(`/api/v1/host/rooms/${room.id}`).set('X-Actor-User-Id', actor);

    expect(response.status).toBe(200);
    expect(response.body.data.manager).toMatchObject({
      available_public_slots: 1,
      accepted_participants: [{ participant_id: 'participant-1', display_name: 'Player Two' }],
      pending_applications: [{ application_id: 'application-1', requested_by_user_id: 'player-1' }],
      waitlisted_applications: [],
    });
  });
});
