import type { PostgresDatabase, Transaction } from '../../platform/database/db.js';
import { PostgresIdempotencyGate, type IdempotencyResult } from '../../platform/idempotency.js';
import { appendOutboxEvent, makeDomainEvent } from '../../platform/outbox/outbox.js';
import { config, DomainError, newId, systemClock, type Clock } from '../../platform/core.js';
import { calculateAvailability, derivePreStartStatus, type Room, type RoomAvailability } from '../room/domain.js';
import { RoomRepository } from '../room/repository.js';
import type { CommandMeta } from '../room/service.js';
import {
  assertCanCancelParticipant,
  type ParticipantAttendanceStatus,
  type ParticipationCancellationClassification,
  type RoomParticipant,
  type SlotLossType,
} from '../participation/domain.js';
import { ParticipationRepository, type PendingApplicationView } from '../participation/repository.js';
import { ReliabilityRepository, type HostStats, type PlayerReliabilityStats, type RefillState, type SlotRecoveryRecord } from './repository.js';

const lateCancelCutoffMs = 4 * 60 * 60 * 1000;

export interface CancelParticipantInput {
  reasonCode?: string;
  reasonText?: string;
}

export interface CancelParticipantSummary {
  participantId: string;
  status: 'CANCELLED';
  classification: ParticipationCancellationClassification;
  reliabilityImpact: boolean;
  roomStatus: Room['status'];
  availablePublicSlots: number;
}

export interface WaitlistCandidate {
  applicationId: string;
  requestedSlotCount: number;
  requestedAt: Date;
  currentlyFitsCapacity: boolean;
  reliabilityScore: number | null;
  skillFit: 'WITHIN_RANGE' | 'BELOW_RANGE' | 'ABOVE_RANGE' | 'UNRANKED';
  members: PendingApplicationView['members'];
}

export interface RefillSummary {
  active: boolean;
  lostSlots: number;
  availablePublicSlots: number;
  waitlistCandidates: WaitlistCandidate[];
  searchBoostActive: boolean;
  replacementWindowEndsAt: Date | null;
}

const classifySkill = (score: number | null, min: number | null, max: number | null): WaitlistCandidate['skillFit'] => {
  if (score === null || min === null || max === null) return 'UNRANKED';
  if (score < min) return 'BELOW_RANGE';
  if (score > max) return 'ABOVE_RANGE';
  return 'WITHIN_RANGE';
};

const reliabilityLabel = (score: number): 'VERY_RELIABLE' | 'RELIABLE' | 'CAUTION' | 'AT_RISK' => {
  if (score >= 90) return 'VERY_RELIABLE';
  if (score >= 75) return 'RELIABLE';
  if (score >= 50) return 'CAUTION';
  return 'AT_RISK';
};

const confidence = (acceptedMatches: number): 'LOW' | 'MEDIUM' | 'HIGH' => {
  if (acceptedMatches >= 20) return 'HIGH';
  if (acceptedMatches >= 5) return 'MEDIUM';
  return 'LOW';
};

export class ReliabilityService {
  private readonly idempotency: PostgresIdempotencyGate;

  constructor(
    private readonly db: PostgresDatabase,
    private readonly rooms: RoomRepository,
    private readonly participation: ParticipationRepository,
    private readonly reliability: ReliabilityRepository,
    private readonly clock: Clock = systemClock,
  ) {
    this.idempotency = new PostgresIdempotencyGate(db, clock);
  }

  async cancelParticipant(participantId: string, meta: CommandMeta, input: CancelParticipantInput): Promise<IdempotencyResult<CancelParticipantSummary>> {
    return this.idempotency.execute(meta.idempotency, 200, async (tx) => {
      const participant = await this.requireParticipantLocked(tx, participantId);
      assertCanCancelParticipant(participant, meta.actorUserId);
      const room = await this.requireRoomLocked(tx, participant.roomId);
      if (!['OPEN', 'FULL'].includes(room.status)) {
        throw new DomainError('APPLICATION_NOT_ACTIONABLE', 'Participant cancellation is available only before the Room starts.', { room_id: room.id, status: room.status });
      }
      if (participant.attendanceStatus === 'NO_SHOW') {
        throw new DomainError('APPLICATION_NOT_ACTIONABLE', 'A finalized no-show cannot be converted into a cancellation.', { participant_id: participant.id });
      }
      const now = this.clock.now();
      const materialChangeId = now < room.scheduledStartAt
        ? await this.reliability.findMaterialChangeSinceAcceptance(tx, { roomId: room.id, acceptedAt: participant.acceptedAt })
        : null;
      const classification: ParticipationCancellationClassification = materialChangeId
        ? 'MATERIAL_CHANGE_WAIVER'
        : now <= new Date(room.scheduledStartAt.getTime() - lateCancelCutoffMs)
          ? 'EARLY'
          : 'LATE';
      const penaltyApplicable = classification === 'LATE';
      const guestsReleasedWithOwner = participant.userId === meta.actorUserId
        ? await this.participation.listUnclaimedGuestParticipantsOwnedBy(tx, participant.applicationId, meta.actorUserId)
        : [];
      const beforeActive = await this.participation.countActiveParticipants(tx, room.id);
      participant.status = 'CANCELLED';
      participant.cancelledAt = now;
      participant.version += 1;
      participant.updatedAt = now;
      await this.participation.updateParticipant(tx, participant);
      for (const guest of guestsReleasedWithOwner) {
        guest.status = 'CANCELLED';
        guest.cancelledAt = now;
        guest.version += 1;
        guest.updatedAt = now;
        await this.participation.updateParticipant(tx, guest);
      }
      const cancellationId = newId();
      await this.participation.insertCancellation(tx, {
        id: cancellationId,
        roomParticipantId: participant.id,
        cancelledByType: 'PLAYER',
        cancelledByUserId: meta.actorUserId,
        classification,
        reasonCode: input.reasonCode ?? null,
        reasonText: input.reasonText ?? null,
        penaltyApplicable,
        sourceMaterialChangeId: materialChangeId,
        createdAt: now,
      });
      await this.reliability.recordCancellationClassification(tx, { userId: participant.userId, classification, now });
      const afterActive = Math.max(0, beforeActive - 1 - guestsReleasedWithOwner.length);
      const noShows = await this.participation.countEffectiveNoShows(tx, room.id);
      const availability = calculateAvailability(room, afterActive, noShows);
      const previousStatus = room.status;
      room.status = derivePreStartStatus(room, availability.availablePublicSlots);
      room.version += 1;
      room.updatedAt = now;
      await this.rooms.update(tx, room, false);
      await this.rooms.upsertAvailability(tx, room.id, availability, now);

      const cancelledEvent = makeDomainEvent({
        eventType: classification === 'LATE' ? 'PLAYER_LATE_CANCELLED' : 'PLAYER_EARLY_CANCELLED',
        aggregateType: 'ROOM_PARTICIPANT', aggregateId: participant.id, actorUserId: meta.actorUserId,
        correlationId: null, causationId: cancellationId, schemaVersion: 1,
        payload: { participant_id: participant.id, room_id: room.id, classification, reason_code: input.reasonCode ?? null },
      }, this.clock);
      await appendOutboxEvent(tx, cancelledEvent);
      const guestReleaseEvents = guestsReleasedWithOwner.map((guest) => makeDomainEvent({
        eventType: 'GUEST_SEAT_RELEASED_BY_OWNER_CANCEL', aggregateType: 'ROOM_PARTICIPANT', aggregateId: guest.id,
        actorUserId: meta.actorUserId, correlationId: null, causationId: cancellationId, schemaVersion: 1,
        payload: { participant_id: guest.id, room_id: room.id, owner_participant_id: participant.id },
      }, this.clock));
      for (const guestReleaseEvent of guestReleaseEvents) await appendOutboxEvent(tx, guestReleaseEvent);

      if (penaltyApplicable && participant.userId) {
        const adjustment = await this.reliability.applyPlayerAdjustment(tx, {
          id: newId(), userId: participant.userId, sourceEventId: cancellationId,
          adjustment: -5, reason: 'LATE_CANCEL', now,
        });
        if (adjustment.applied) {
          await appendOutboxEvent(tx, makeDomainEvent({
            eventType: 'PLAYER_RELIABILITY_ADJUSTED', aggregateType: 'USER', aggregateId: participant.userId,
            actorUserId: null, correlationId: null, causationId: cancelledEvent.id, schemaVersion: 1,
            payload: { user_id: participant.userId, adjustment: -5, reason: 'LATE_CANCEL', score_before: adjustment.scoreBefore, score_after: adjustment.scoreAfter },
          }, this.clock));
        }
      }

      const lossType = classification === 'LATE' ? 'LATE_CANCEL' : 'EARLY_CANCEL';
      await this.recordLossAndMaybeActivateRefill(tx, {
        room, availability, lossEventId: cancellationId, lossType,
        reason: classification, actorUserId: meta.actorUserId, now,
      });
      for (const guestReleaseEvent of guestReleaseEvents) {
        await this.recordLossAndMaybeActivateRefill(tx, {
          room, availability, lossEventId: guestReleaseEvent.id, lossType,
          reason: 'OWNER_CANCELLED_UNCLAIMED_GUEST', actorUserId: meta.actorUserId, now,
        });
      }
      if (previousStatus === 'FULL' && room.status === 'OPEN') {
        await appendOutboxEvent(tx, makeDomainEvent({
          eventType: 'ROOM_REOPENED', aggregateType: 'ROOM', aggregateId: room.id, actorUserId: meta.actorUserId,
          correlationId: null, causationId: cancellationId, schemaVersion: 1,
          payload: { room_id: room.id, available_public_slots: availability.availablePublicSlots },
        }, this.clock));
      }
      return {
        participantId: participant.id, status: 'CANCELLED', classification, reliabilityImpact: penaltyApplicable,
        roomStatus: room.status, availablePublicSlots: availability.availablePublicSlots,
      };
    });
  }

  async onRoomCompleted(tx: Transaction, input: { room: Room; actorUserId: string; completionEventId: string; now: Date }): Promise<void> {
    await this.reliability.incrementHostRoomCompleted(tx, input.room.hostUserId, input.now);
    const presentParticipants = await this.participation.listPresentParticipantsForCompletion(tx, input.room.id);
    for (const participant of presentParticipants) {
      if (!participant.userId) continue;
      const result = await this.reliability.recordPresentCompletion(tx, {
        userId: participant.userId,
        sourceEventId: `${input.completionEventId}:${participant.id}`,
        adjustmentId: newId(),
        now: input.now,
      });
      if (result.recovered) {
        await appendOutboxEvent(tx, makeDomainEvent({
          eventType: 'PLAYER_RELIABILITY_ADJUSTED', aggregateType: 'USER', aggregateId: participant.userId,
          actorUserId: null, correlationId: null, causationId: input.completionEventId, schemaVersion: 1,
          payload: { user_id: participant.userId, adjustment: 1, reason: 'PRESENT_RECOVERY', score_before: result.scoreBefore, score_after: result.scoreAfter },
        }, this.clock));
      }
    }
  }

  async onParticipantAccepted(tx: Transaction, input: { room: Room; participants: RoomParticipant[]; availability: RoomAvailability; actorUserId: string | null; causationId: string | null; now: Date }): Promise<void> {
    for (const participant of input.participants) {
      if (participant.userId) await this.reliability.incrementAcceptedParticipant(tx, participant.userId, input.room.hostUserId, input.now);
      const recovered = await this.reliability.recoverOldestSlotLoss(tx, {
        roomId: input.room.id, replacementParticipantId: participant.id, hostUserId: input.room.hostUserId, now: input.now,
      });
      if (recovered) {
        await appendOutboxEvent(tx, makeDomainEvent({
          eventType: 'REPLACEMENT_ACCEPTED', aggregateType: 'ROOM_PARTICIPANT', aggregateId: participant.id,
          actorUserId: input.actorUserId, correlationId: null, causationId: input.causationId, schemaVersion: 1,
          payload: { participant_id: participant.id, room_id: input.room.id, slot_recovery_record_id: recovered.id },
        }, this.clock));
        await appendOutboxEvent(tx, makeDomainEvent({
          eventType: 'PUBLIC_SLOT_RECOVERED', aggregateType: 'ROOM', aggregateId: input.room.id,
          actorUserId: input.actorUserId, correlationId: null, causationId: recovered.id, schemaVersion: 1,
          payload: { room_id: input.room.id, replacement_participant_id: participant.id, recovery_seconds: recovered.recoverySeconds },
        }, this.clock));
      }
    }
    if (input.availability.availablePublicSlots <= 0) await this.stopRefillLocked(tx, input.room, 'CAPACITY_RECOVERED', input.actorUserId, input.now);
  }

  async onParticipantRemovedByHost(tx: Transaction, input: { room: Room; participant: RoomParticipant; availability: RoomAvailability; actorUserId: string; now: Date }): Promise<void> {
    await this.reliability.recordCancellationClassification(tx, { userId: input.participant.userId, classification: 'HOST_REMOVED', now: input.now });
    await this.reliability.incrementHostRemoval(tx, input.room.hostUserId, input.now);
    const lossId = newId();
    await this.recordLossAndMaybeActivateRefill(tx, {
      room: input.room, availability: input.availability, lossEventId: lossId, lossType: 'HOST_REMOVAL', reason: 'HOST_REMOVAL', actorUserId: input.actorUserId, now: input.now,
    });
  }

  async onAttendanceChanged(
    tx: Transaction,
    input: {
      room: Room; participant: RoomParticipant; previous: ParticipantAttendanceStatus; next: ParticipantAttendanceStatus;
      attendanceLogId: string; priorNoShowLogId: string | null; actorUserId: string; now: Date;
    },
  ): Promise<void> {
    const active = await this.participation.countActiveParticipants(tx, input.room.id);
    const noShows = await this.participation.countEffectiveNoShows(tx, input.room.id);
    const availability = calculateAvailability(input.room, active, noShows);
    await this.rooms.upsertAvailability(tx, input.room.id, availability, input.now);
    if (input.next === 'NO_SHOW' && input.previous !== 'NO_SHOW') {
      const lossEventId = input.attendanceLogId;
      if (input.participant.userId) {
        const adjustment = await this.reliability.applyPlayerAdjustment(tx, {
          id: newId(), userId: input.participant.userId, sourceEventId: lossEventId, adjustment: -15, reason: 'NO_SHOW', now: input.now,
        });
        if (adjustment.applied) {
          await appendOutboxEvent(tx, makeDomainEvent({
            eventType: 'PLAYER_RELIABILITY_ADJUSTED', aggregateType: 'USER', aggregateId: input.participant.userId,
            actorUserId: null, correlationId: null, causationId: lossEventId, schemaVersion: 1,
            payload: { user_id: input.participant.userId, adjustment: -15, reason: 'NO_SHOW', score_before: adjustment.scoreBefore, score_after: adjustment.scoreAfter },
          }, this.clock));
        }
      }
      await this.recordLossAndMaybeActivateRefill(tx, {
        room: input.room, availability, lossEventId, lossType: 'NO_SHOW', reason: 'NO_SHOW', actorUserId: input.actorUserId, now: input.now,
      });
      return;
    }
    if (input.previous === 'NO_SHOW' && input.next === 'PRESENT' && input.priorNoShowLogId) {
      if (input.participant.userId) {
        const adjustment = await this.reliability.applyPlayerAdjustment(tx, {
          id: newId(), userId: input.participant.userId, sourceEventId: input.attendanceLogId, adjustment: 15, reason: 'NO_SHOW_REVERSED', now: input.now,
        });
        if (adjustment.applied) {
          await appendOutboxEvent(tx, makeDomainEvent({
            eventType: 'PLAYER_RELIABILITY_ADJUSTED', aggregateType: 'USER', aggregateId: input.participant.userId,
            actorUserId: null, correlationId: null, causationId: input.attendanceLogId, schemaVersion: 1,
            payload: { user_id: input.participant.userId, adjustment: 15, reason: 'NO_SHOW_REVERSED', score_before: adjustment.scoreBefore, score_after: adjustment.scoreAfter },
          }, this.clock));
        }
      }
      await this.reliability.voidSlotLossForEvent(tx, { lossEventId: input.priorNoShowLogId, hostUserId: input.room.hostUserId, now: input.now });
      if (availability.availablePublicSlots <= 0) await this.stopRefillLocked(tx, input.room, 'NO_SHOW_CORRECTED', input.actorUserId, input.now);
    }
  }

  async cancelRoomParticipation(tx: Transaction, input: { room: Room; actorUserId: string; reasonCode?: string; now: Date }): Promise<void> {
    const participants = await this.participation.cancelActiveParticipantsForRoom(tx, input.room.id, input.now);
    const expired = await this.participation.expirePendingApplicationsOnRoomCancellation(tx, input.room.id, input.now);
    for (const participant of participants) {
      const cancellationId = newId();
      await this.participation.insertCancellation(tx, {
        id: cancellationId, roomParticipantId: participant.id, cancelledByType: 'ROOM', cancelledByUserId: input.actorUserId,
        classification: 'ROOM_CANCELLED', reasonCode: input.reasonCode ?? null, reasonText: null,
        penaltyApplicable: false, sourceMaterialChangeId: null, createdAt: input.now,
      });
      await this.reliability.recordCancellationClassification(tx, { userId: participant.userId, classification: 'ROOM_CANCELLED', now: input.now });
    }
    await this.reliability.incrementHostRoomCancelled(tx, input.room.hostUserId, input.now);
    await this.stopRefillLocked(tx, input.room, 'ROOM_CANCELLED', input.actorUserId, input.now);
    for (const application of expired) {
      await appendOutboxEvent(tx, makeDomainEvent({
        eventType: 'JOIN_REQUEST_EXPIRED', aggregateType: 'ROOM_APPLICATION', aggregateId: application.id,
        actorUserId: input.actorUserId, correlationId: null, causationId: input.room.id, schemaVersion: 1,
        payload: { application_id: application.id, room_id: input.room.id, reason_code: 'ROOM_CANCELLED' },
      }, this.clock));
    }
  }

  async activateRefill(roomId: string, meta: CommandMeta): Promise<IdempotencyResult<RefillSummary>> {
    return this.idempotency.execute(meta.idempotency, 200, async (tx) => {
      const room = await this.requireRoomLocked(tx, roomId);
      this.assertHost(room, meta.actorUserId);
      const availability = await this.currentAvailability(tx, room);
      await this.ensureManualRefillAllowed(tx, room, availability, this.clock.now());
      await this.activateRefillLocked(tx, room, 'MANUAL', meta.actorUserId, this.clock.now());
      return this.refillSummary(tx, room, availability);
    });
  }

  async disableRefill(roomId: string, meta: CommandMeta): Promise<IdempotencyResult<RefillSummary>> {
    return this.idempotency.execute(meta.idempotency, 200, async (tx) => {
      const room = await this.requireRoomLocked(tx, roomId);
      this.assertHost(room, meta.actorUserId);
      const availability = await this.currentAvailability(tx, room);
      await this.stopRefillLocked(tx, room, 'HOST_DISABLED', meta.actorUserId, this.clock.now(), this.clock.now());
      return this.refillSummary(tx, room, availability);
    });
  }

  async assertInProgressRefillAdmission(tx: Transaction, room: Room, now: Date): Promise<void> {
    if (room.status !== 'IN_PROGRESS') return;
    if (!room.allowEmergencyReplacement) {
      throw new DomainError('REFILL_NOT_ALLOWED', 'This Room does not allow emergency replacement after start.');
    }
    if (!this.isReplacementWindowOpen(room, now)) {
      throw new DomainError('REFILL_WINDOW_CLOSED', 'The emergency replacement window has closed.');
    }
    const state = await this.reliability.getRefillState(tx, room.id);
    if (!state?.active) {
      throw new DomainError('REFILL_NOT_ALLOWED', 'An active emergency refill is required for post-start replacement admission.');
    }
  }

  async getWaitlist(roomId: string, actorUserId: string): Promise<WaitlistCandidate[]> {
    const room = await this.rooms.findById(this.db, roomId);
    if (!room) throw new DomainError('ROOM_NOT_FOUND', 'Room was not found.');
    this.assertHost(room, actorUserId);
    const availability = await this.currentAvailability(this.db, room);
    return this.rankWaitlist(await this.participation.listPendingForHost(this.db, room.id), room, availability.availablePublicSlots);
  }

  async getRefill(roomId: string, actorUserId: string): Promise<RefillSummary> {
    const room = await this.rooms.findById(this.db, roomId);
    if (!room) throw new DomainError('ROOM_NOT_FOUND', 'Room was not found.');
    this.assertHost(room, actorUserId);
    return this.refillSummary(this.db, room, await this.currentAvailability(this.db, room));
  }

  async getReliabilityProfile(userId: string, actorUserId: string) {
    if (userId !== actorUserId) throw new DomainError('FORBIDDEN', 'Only the user may read the full reliability profile in this MVP.');
    const stats = await this.reliability.getPlayerStats(this.db, userId);
    const safe = stats ?? this.defaultPlayerStats(userId);
    return {
      score: safe.reliabilityScore,
      label: reliabilityLabel(safe.reliabilityScore),
      acceptedMatches: safe.acceptedMatches,
      completedMatches: safe.completedMatches,
      lateCancels: safe.lateCancels,
      noShows: safe.noShows,
      historyConfidence: confidence(safe.acceptedMatches),
    };
  }

  async getHostProfile(userId: string): Promise<{ roomsCompleted: number; completionRate: number; lateRoomCancellations: number; repeatPlayers: number; recoveredSlotRate: number }> {
    const stats = await this.reliability.getHostStats(this.db, userId);
    const safe = stats ?? this.defaultHostStats(userId);
    return {
      roomsCompleted: safe.roomsCompleted,
      completionRate: safe.roomsCompleted + safe.roomsCancelled === 0 ? 0 : safe.roomsCompleted / (safe.roomsCompleted + safe.roomsCancelled),
      lateRoomCancellations: safe.lateRoomCancellations,
      repeatPlayers: safe.repeatPlayers,
      recoveredSlotRate: safe.lostSlots === 0 ? 0 : safe.recoveredSlots / safe.lostSlots,
    };
  }

  async expireDueRefills(limit = 100): Promise<number> {
    const roomIds = await this.reliability.listDueRefillExpiryRoomIds(this.db, this.clock.now(), limit);
    let stopped = 0;
    for (const roomId of roomIds) {
      await this.db.transaction(async (tx) => {
        const room = await this.rooms.findById(tx, roomId, true);
        if (!room) return;
        const state = await this.reliability.getRefillState(tx, room.id);
        if (!state?.active || !state.replacementWindowEndsAt || state.replacementWindowEndsAt >= this.clock.now()) return;
        await this.stopRefillLocked(tx, room, 'WINDOW_CLOSED', null, this.clock.now());
        stopped += 1;
      });
    }
    return stopped;
  }

  private async recordLossAndMaybeActivateRefill(
    tx: Transaction,
    input: { room: Room; availability: RoomAvailability; lossEventId: string; lossType: SlotLossType; reason: string; actorUserId: string; now: Date },
  ): Promise<void> {
    if (input.availability.availablePublicSlots <= 0 || ['COMPLETED', 'CANCELLED'].includes(input.room.status)) return;
    await this.reliability.recordSlotLoss(tx, {
      id: newId(), roomId: input.room.id, lossEventId: input.lossEventId, lossType: input.lossType,
      lostAt: input.now, hostUserId: input.room.hostUserId, now: input.now,
    });
    await appendOutboxEvent(tx, makeDomainEvent({
      eventType: 'PUBLIC_SLOT_OPENED', aggregateType: 'ROOM', aggregateId: input.room.id, actorUserId: input.actorUserId,
      correlationId: null, causationId: input.lossEventId, schemaVersion: 1,
      payload: { room_id: input.room.id, loss_type: input.lossType, available_public_slots: input.availability.availablePublicSlots },
    }, this.clock));
    const shouldBeUrgent = input.lossType === 'LATE_CANCEL' || input.lossType === 'NO_SHOW';
    if (shouldBeUrgent && this.isReplacementWindowOpen(input.room, input.now)) {
      await this.activateRefillLocked(tx, input.room, input.reason, input.actorUserId, input.now);
      const waitlist = await this.rankWaitlist(await this.participation.listPendingForHost(tx, input.room.id), input.room, input.availability.availablePublicSlots);
      if (waitlist.length) {
        await appendOutboxEvent(tx, makeDomainEvent({
          eventType: 'REPLACEMENT_CANDIDATE_AVAILABLE', aggregateType: 'ROOM', aggregateId: input.room.id,
          actorUserId: null, correlationId: null, causationId: input.lossEventId, schemaVersion: 1,
          payload: { room_id: input.room.id, waitlist_candidate_count: waitlist.length },
        }, this.clock));
      }
    }
  }

  private async activateRefillLocked(tx: Transaction, room: Room, reason: string, actorUserId: string | null, now: Date): Promise<void> {
    const current = await this.reliability.getRefillState(tx, room.id);
    const replacementWindowEndsAt = room.status === 'IN_PROGRESS'
      ? new Date(room.scheduledStartAt.getTime() + config.emergencyReplacementWindowMinutes * 60_000)
      : null;
    const state = await this.reliability.setRefillState(tx, {
      roomId: room.id, active: true, reason, now, replacementWindowEndsAt,
      lastLossEventId: current?.lastLossEventId ?? null,
    });
    if (!current?.active && state.active) {
      await appendOutboxEvent(tx, makeDomainEvent({
        eventType: 'EMERGENCY_REFILL_STARTED', aggregateType: 'ROOM', aggregateId: room.id,
        actorUserId, correlationId: null, causationId: null, schemaVersion: 1,
        payload: { room_id: room.id, reason, replacement_window_ends_at: replacementWindowEndsAt?.toISOString() ?? null },
      }, this.clock));
    }
  }

  private async stopRefillLocked(tx: Transaction, room: Room, reason: string, actorUserId: string | null, now: Date, disabledAt: Date | null = null): Promise<void> {
    const current = await this.reliability.getRefillState(tx, room.id);
    if (!current?.active) return;
    await this.reliability.setRefillState(tx, {
      roomId: room.id, active: false, reason, now, replacementWindowEndsAt: current.replacementWindowEndsAt,
      lastLossEventId: current.lastLossEventId, disabledAt,
    });
    if (reason === 'WINDOW_CLOSED') await this.reliability.expirePendingSlotLosses(tx, room.id, now);
    await appendOutboxEvent(tx, makeDomainEvent({
      eventType: reason === 'WINDOW_CLOSED' ? 'SLOT_RECOVERY_EXPIRED' : 'EMERGENCY_REFILL_STOPPED',
      aggregateType: 'ROOM', aggregateId: room.id, actorUserId, correlationId: null, causationId: null, schemaVersion: 1,
      payload: { room_id: room.id, reason },
    }, this.clock));
  }

  private async ensureManualRefillAllowed(tx: Transaction, room: Room, availability: RoomAvailability, now: Date): Promise<void> {
    if (availability.availablePublicSlots <= 0) throw new DomainError('REFILL_NOT_ALLOWED', 'Refill requires at least one available public slot.');
    if (!['OPEN', 'FULL', 'IN_PROGRESS'].includes(room.status)) throw new DomainError('REFILL_NOT_ALLOWED', 'Refill is unavailable for terminal or draft Rooms.');
    if (room.status === 'IN_PROGRESS' && !room.allowEmergencyReplacement) {
      throw new DomainError('REFILL_NOT_ALLOWED', 'This Room does not allow emergency replacement after start.');
    }
    if (room.status === 'IN_PROGRESS' && !this.isReplacementWindowOpen(room, now)) {
      throw new DomainError('REFILL_WINDOW_CLOSED', 'The emergency replacement window has closed.', {
        replacement_window_ends_at: new Date(room.scheduledStartAt.getTime() + config.emergencyReplacementWindowMinutes * 60_000).toISOString(),
      });
    }
    void tx;
  }

  private isReplacementWindowOpen(room: Room, now: Date): boolean {
    if (room.status === 'IN_PROGRESS') {
      return room.allowEmergencyReplacement && now <= new Date(room.scheduledStartAt.getTime() + config.emergencyReplacementWindowMinutes * 60_000);
    }
    return room.status === 'OPEN' || room.status === 'FULL';
  }

  private async currentAvailability(executor: Transaction | PostgresDatabase, room: Room): Promise<RoomAvailability> {
    const [active, noShows] = await Promise.all([
      this.participation.countActiveParticipants(executor, room.id),
      this.participation.countEffectiveNoShows(executor, room.id),
    ]);
    return calculateAvailability(room, active, noShows);
  }

  private async refillSummary(executor: Transaction | PostgresDatabase, room: Room, availability: RoomAvailability): Promise<RefillSummary> {
    const state = await this.reliability.getRefillState(executor, room.id);
    const candidates = await this.rankWaitlist(await this.participation.listPendingForHost(executor, room.id), room, availability.availablePublicSlots);
    const losses = await this.reliability.listOutstandingRecovery(executor, room.id);
    const validActive = Boolean(state?.active && (!state.replacementWindowEndsAt || state.replacementWindowEndsAt >= this.clock.now()));
    return {
      active: validActive,
      lostSlots: losses.length,
      availablePublicSlots: availability.availablePublicSlots,
      waitlistCandidates: candidates,
      searchBoostActive: validActive && Boolean(state?.searchBoostActive),
      replacementWindowEndsAt: state?.replacementWindowEndsAt ?? null,
    };
  }

  private async rankWaitlist(applications: PendingApplicationView[], room: Room, availableSlots: number): Promise<WaitlistCandidate[]> {
    const candidates = await Promise.all(applications
      .filter((item) => item.application.status === 'WAITLISTED')
      .map(async (item) => {
        const primary = item.members[0];
        const stats = primary?.userId ? await this.reliability.getPlayerStats(this.db, primary.userId) : null;
        const score = stats?.reliabilityScore ?? primary?.reliabilityScoreSnapshot ?? null;
        return {
          applicationId: item.application.id,
          requestedSlotCount: item.application.requestedSlotCount,
          requestedAt: item.application.requestedAt,
          currentlyFitsCapacity: item.application.requestedSlotCount <= availableSlots,
          reliabilityScore: score,
          skillFit: classifySkill(primary?.skillScoreSnapshot ?? null, room.preferredSkillMin, room.preferredSkillMax),
          members: item.members,
        };
      }));
    const skillRank: Record<WaitlistCandidate['skillFit'], number> = { WITHIN_RANGE: 0, UNRANKED: 1, BELOW_RANGE: 2, ABOVE_RANGE: 2 };
    return candidates.sort((left, right) =>
      Number(right.currentlyFitsCapacity) - Number(left.currentlyFitsCapacity)
      || skillRank[left.skillFit] - skillRank[right.skillFit]
      || (right.reliabilityScore ?? -1) - (left.reliabilityScore ?? -1)
      || left.requestedAt.getTime() - right.requestedAt.getTime()
      || left.applicationId.localeCompare(right.applicationId));
  }

  private async requireParticipantLocked(tx: Transaction, participantId: string): Promise<RoomParticipant> {
    const participant = await this.participation.findParticipant(tx, participantId, true);
    if (!participant) throw new DomainError('NOT_PARTICIPANT', 'Participant was not found.');
    return participant;
  }

  private async requireRoomLocked(tx: Transaction, roomId: string): Promise<Room> {
    const room = await this.rooms.findById(tx, roomId, true);
    if (!room) throw new DomainError('ROOM_NOT_FOUND', 'Room was not found.');
    return room;
  }

  private assertHost(room: Room, actorUserId: string): void {
    if (room.hostUserId !== actorUserId) throw new DomainError('NOT_ROOM_HOST', 'Only the Room HOST may manage refill.');
  }

  private defaultPlayerStats(userId: string): PlayerReliabilityStats {
    return { userId, acceptedMatches: 0, completedMatches: 0, earlyCancels: 0, lateCancels: 0, noShows: 0, guestNoShowsAttributed: 0, hostRemovedCount: 0, roomCancelledCount: 0, materialChangeWaivers: 0, reliabilityScore: 100, presentMatchesSinceLastPenalty: 0, updatedAt: this.clock.now() };
  }

  private defaultHostStats(userId: string): HostStats {
    return { userId, roomsCreated: 0, roomsCompleted: 0, roomsCancelled: 0, lateRoomCancellations: 0, acceptedPlayersTotal: 0, playersRemovedAfterAccept: 0, materialChangesAfterAccept: 0, repeatPlayers: 0, lostSlots: 0, recoveredSlots: 0, hostTrustScore: null, updatedAt: this.clock.now() };
  }
}
