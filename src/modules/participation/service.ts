import { DomainError, newId, systemClock, type Clock } from '../../platform/core.js';
import type { PostgresDatabase, Transaction } from '../../platform/database/db.js';
import { PostgresIdempotencyGate, type IdempotencyContext, type IdempotencyResult } from '../../platform/idempotency.js';
import { appendOutboxEvent, makeDomainEvent } from '../../platform/outbox/outbox.js';
import { calculateAvailability, derivePreStartStatus, noShowGraceMs, type Room } from '../room/domain.js';
import { RoomRepository } from '../room/repository.js';
import type { CommandMeta } from '../room/service.js';
import {
  assertApplicationActionable,
  assertCanAccept,
  assertCanManageAttendance,
  assertCanReject,
  assertCanRemove,
  assertCanWithdraw,
  type RoomApplication,
  type ParticipantAttendanceStatus,
  type RoomApplicationMember,
  type RoomParticipant,
} from './domain.js';
import { ParticipationRepository, type HostedRoomView, type MyRoomView, type PendingApplicationView } from './repository.js';
import type { ReliabilityService } from '../reliability/service.js';
import { assertPartyOwner, assertPartyReady, memberToSnapshot } from '../party/domain.js';
import { PartyRepository } from '../party/repository.js';

export interface CreateJoinApplicationInput {
  partyId?: string;
  allowWaitlistIfFull?: boolean;
}

export interface ApplicationSummary {
  applicationId: string;
  roomId: string;
  status: RoomApplication['status'];
  requestedSlotCount: number;
  createdAt: Date;
}

export interface AcceptApplicationSummary {
  applicationId: string;
  status: 'ACCEPTED';
  participantIds: string[];
  roomStatus: Room['status'];
  availablePublicSlots: number;
}

export interface RemoveParticipantSummary {
  participantId: string;
  status: 'REMOVED_BY_HOST';
  roomStatus: Room['status'];
  availablePublicSlots: number;
}

export interface AttendanceSummary {
  participantId: string;
  attendanceStatus: ParticipantAttendanceStatus;
  noShowEligibleAt: Date;
  corrected: boolean;
}

const command = (meta: CommandMeta): IdempotencyContext => meta.idempotency;

export class ParticipationService {
  private readonly idempotency: PostgresIdempotencyGate;

  constructor(
    private readonly db: PostgresDatabase,
    private readonly rooms: RoomRepository,
    private readonly participation: ParticipationRepository,
    private readonly clock: Clock = systemClock,
    private readonly reliabilityService: ReliabilityService | null = null,
    private readonly partyRepository: PartyRepository | null = null,
  ) {
    this.idempotency = new PostgresIdempotencyGate(db, clock);
  }

  async createApplication(roomId: string, meta: CommandMeta, input: CreateJoinApplicationInput): Promise<IdempotencyResult<ApplicationSummary>> {
    return this.idempotency.execute(command(meta), 201, async (tx) => {
      const room = await this.requireJoinableRoomLocked(tx, roomId);
      const now = this.clock.now();
      let partyId: string | null = null;
      let ownerKey = `USER:${meta.actorUserId}`;
      let snapshots: Array<{ sourcePartyMemberId: string | null; memberType: 'USER' | 'GUEST'; userId: string | null; guestLabel: string | null }>;

      if (input.partyId) {
        if (!this.partyRepository) throw new Error('Party module is not configured.');
        const party = await this.partyRepository.findParty(tx, input.partyId, true);
        if (!party) throw new DomainError('PARTY_NOT_FOUND', 'Party was not found.');
        assertPartyOwner(party, meta.actorUserId);
        assertPartyReady(party);
        if (party.sportId !== room.sportId) {
          throw new DomainError('PARTY_SPORT_MISMATCH', 'Party sport must match the Room sport.', { party_id: party.id, room_id: room.id });
        }
        const partyMembers = await this.partyRepository.listPartyMembers(tx, party.id, true);
        snapshots = partyMembers.map(memberToSnapshot);
        partyId = party.id;
        ownerKey = `PARTY:${party.id}`;
      } else {
        const applicant = await this.participation.findApplicantSnapshot(tx, meta.actorUserId, room.sportId);
        if (!applicant) throw new DomainError('FORBIDDEN', 'Active player profile is required to submit a join application.');
        snapshots = [{ sourcePartyMemberId: null, memberType: 'USER', userId: applicant.userId, guestLabel: null }];
      }

      if (await this.participation.hasActiveApplication(tx, roomId, ownerKey)) {
        throw new DomainError('APPLICATION_ALREADY_EXISTS', 'Application owner already has an active application for this Room.', { room_id: roomId });
      }
      const activeCount = await this.participation.countActiveParticipants(tx, room.id);
      const availability = calculateAvailability(room, activeCount);
      const status: RoomApplication['status'] = availability.availablePublicSlots >= snapshots.length
        ? 'REQUESTED'
        : input.allowWaitlistIfFull ? 'WAITLISTED' : this.insufficientCapacity(snapshots.length, availability.availablePublicSlots);
      const application: RoomApplication = {
        id: newId(), roomId: room.id, requestedByUserId: meta.actorUserId, partyId,
        applicationOwnerKey: ownerKey, requestedSlotCount: snapshots.length, status, requestedAt: now,
        acceptedAt: null, rejectedAt: null, withdrawnAt: null, expiredAt: null, rejectionReasonCode: null,
        version: 1, createdAt: now, updatedAt: now,
      };
      const members: RoomApplicationMember[] = [];
      for (const snapshot of snapshots) {
        const applicant = snapshot.userId ? await this.participation.findApplicantSnapshot(tx, snapshot.userId, room.sportId) : null;
        if (snapshot.userId && !applicant) {
          throw new DomainError('FORBIDDEN', 'Every registered Party member must have an active player profile.');
        }
        members.push({
          id: newId(), applicationId: application.id, sourcePartyMemberId: snapshot.sourcePartyMemberId, memberType: snapshot.memberType,
          userId: snapshot.userId, guestLabel: snapshot.guestLabel,
          skillStateSnapshot: applicant?.skillState ?? null, skillScoreSnapshot: applicant?.skillScore ?? null,
          rankTierSnapshot: applicant?.rankTier ?? null, reliabilityScoreSnapshot: applicant?.reliabilityScore ?? null, createdAt: now,
        });
      }
      try {
        await this.participation.insertApplication(tx, application, members);
      } catch (error) {
        if (this.isUniqueViolation(error)) {
          throw new DomainError('APPLICATION_ALREADY_EXISTS', 'Application owner already has an active application for this Room.', { room_id: roomId });
        }
        throw error;
      }
      await appendOutboxEvent(tx, makeDomainEvent({
        eventType: 'JOIN_REQUEST_CREATED', aggregateType: 'ROOM_APPLICATION', aggregateId: application.id,
        actorUserId: meta.actorUserId, correlationId: null, causationId: null, schemaVersion: 1,
        payload: {
          application_id: application.id, room_id: room.id, requested_by_user_id: meta.actorUserId,
          party_id: application.partyId, requested_slot_count: application.requestedSlotCount, status: application.status,
        },
      }, this.clock));
      return {
        applicationId: application.id, roomId: room.id, status: application.status,
        requestedSlotCount: application.requestedSlotCount, createdAt: application.createdAt,
      };
    });
  }

  async withdrawApplication(applicationId: string, meta: CommandMeta): Promise<IdempotencyResult<{ status: 'WITHDRAWN' }>> {
    return this.idempotency.execute(command(meta), 200, async (tx) => {
      const application = await this.requireApplicationLocked(tx, applicationId);
      assertCanWithdraw(application, meta.actorUserId);
      const now = this.clock.now();
      application.status = 'WITHDRAWN';
      application.withdrawnAt = now;
      application.version += 1;
      application.updatedAt = now;
      await this.participation.updateApplication(tx, application);
      await appendOutboxEvent(tx, makeDomainEvent({
        eventType: 'JOIN_REQUEST_WITHDRAWN', aggregateType: 'ROOM_APPLICATION', aggregateId: application.id,
        actorUserId: meta.actorUserId, correlationId: null, causationId: null, schemaVersion: 1,
        payload: { application_id: application.id, room_id: application.roomId, requested_by_user_id: application.requestedByUserId },
      }, this.clock));
      return { status: 'WITHDRAWN' };
    });
  }

  async acceptApplication(applicationId: string, meta: CommandMeta): Promise<IdempotencyResult<AcceptApplicationSummary>> {
    return this.idempotency.execute(command(meta), 200, async (tx) => {
      const application = await this.requireApplicationLocked(tx, applicationId);
      const room = await this.requireHostAcceptableRoomLocked(tx, application.roomId, meta.actorUserId);
      await this.reliabilityService?.assertInProgressRefillAdmission(tx, room, this.clock.now());
      assertCanAccept(application);
      const members = await this.participation.getApplicationMembers(tx, application.id);
      if (members.length !== application.requestedSlotCount || members.length === 0) {
        throw new DomainError('VALIDATION_ERROR', 'Application member snapshot does not match requested slot count.', { application_id: application.id });
      }
      for (const userId of [...new Set(members.flatMap((member) => member.userId ? [member.userId] : []))].sort()) {
        await this.participation.lockUserSchedule(tx, userId);
        if (await this.participation.hasActiveScheduleConflict(tx, userId, room.id)) {
          throw new DomainError('SCHEDULE_CONFLICT', 'Player already has an accepted overlapping Room.', { user_id: userId, room_id: room.id });
        }
      }
      const beforeActiveCount = await this.participation.countActiveParticipants(tx, room.id);
      const before = calculateAvailability(room, beforeActiveCount);
      if (before.availablePublicSlots < members.length) this.insufficientCapacity(members.length, before.availablePublicSlots);
      const now = this.clock.now();
      const participants: RoomParticipant[] = members.map((member) => ({
        id: newId(), roomId: room.id, applicationId: application.id, applicationMemberId: member.id,
        userId: member.userId, memberType: member.memberType, status: 'ACTIVE', attendanceStatus: 'NOT_SET',
        attendanceMarkedAt: null, attendanceMarkedByUserId: null, attendanceReasonCode: null,
        acceptedAt: now, cancelledAt: null, removedAt: null, removedByUserId: null, removalReasonCode: null,
        version: 1, createdAt: now, updatedAt: now,
      }));
      await this.participation.createParticipants(tx, participants);
      application.status = 'ACCEPTED';
      application.acceptedAt = now;
      application.version += 1;
      application.updatedAt = now;
      await this.participation.updateApplication(tx, application);
      const autoWithdrawnApplications = [] as RoomApplication[];
      for (const userId of [...new Set(participants.flatMap((participant) => participant.userId ? [participant.userId] : []))].sort()) {
        autoWithdrawnApplications.push(...await this.participation.withdrawPendingOverlappingApplications(tx, userId, room.id, application.id, now));
      }
      const after = calculateAvailability(room, beforeActiveCount + participants.length);
      const previousStatus = room.status;
      room.status = derivePreStartStatus(room, after.availablePublicSlots);
      room.version += 1;
      room.updatedAt = now;
      await this.rooms.update(tx, room, false);
      await this.rooms.upsertAvailability(tx, room.id, after, now);
      await appendOutboxEvent(tx, makeDomainEvent({
        eventType: 'JOIN_REQUEST_ACCEPTED', aggregateType: 'ROOM_APPLICATION', aggregateId: application.id,
        actorUserId: meta.actorUserId, correlationId: null, causationId: null, schemaVersion: 1,
        payload: { application_id: application.id, room_id: room.id, requested_by_user_id: application.requestedByUserId, participant_ids: participants.map((item) => item.id) },
      }, this.clock));
      for (const participant of participants) {
        await appendOutboxEvent(tx, makeDomainEvent({
          eventType: 'PARTICIPANT_CREATED', aggregateType: 'ROOM_PARTICIPANT', aggregateId: participant.id,
          actorUserId: meta.actorUserId, correlationId: null, causationId: application.id, schemaVersion: 1,
          payload: { participant_id: participant.id, application_id: application.id, room_id: room.id, user_id: participant.userId, status: participant.status },
        }, this.clock));
      }
      for (const withdrawn of autoWithdrawnApplications) {
        await appendOutboxEvent(tx, makeDomainEvent({
          eventType: 'JOIN_REQUEST_WITHDRAWN', aggregateType: 'ROOM_APPLICATION', aggregateId: withdrawn.id,
          actorUserId: meta.actorUserId, correlationId: null, causationId: application.id, schemaVersion: 1,
          payload: { application_id: withdrawn.id, room_id: withdrawn.roomId, requested_by_user_id: withdrawn.requestedByUserId, reason_code: 'OVERLAPPING_ACCEPTED_ROOM' },
        }, this.clock));
      }
      if (previousStatus === 'OPEN' && room.status === 'FULL') {
        await appendOutboxEvent(tx, makeDomainEvent({
          eventType: 'ROOM_BECAME_FULL', aggregateType: 'ROOM', aggregateId: room.id,
          actorUserId: meta.actorUserId, correlationId: null, causationId: application.id, schemaVersion: 1,
          payload: { room_id: room.id, available_public_slots: 0 },
        }, this.clock));
      }
      await this.reliabilityService?.onParticipantAccepted(tx, {
        room, participants, availability: after, actorUserId: meta.actorUserId, causationId: application.id, now,
      });
      return {
        applicationId: application.id, status: 'ACCEPTED', participantIds: participants.map((participant) => participant.id),
        roomStatus: room.status, availablePublicSlots: after.availablePublicSlots,
      };
    });
  }

  async rejectApplication(applicationId: string, meta: CommandMeta, reasonCode?: string): Promise<IdempotencyResult<{ status: 'REJECTED' }>> {
    return this.idempotency.execute(command(meta), 200, async (tx) => {
      const application = await this.requireApplicationLocked(tx, applicationId);
      await this.requireHostForApplication(tx, application, meta.actorUserId);
      assertCanReject(application);
      const now = this.clock.now();
      application.status = 'REJECTED';
      application.rejectedAt = now;
      application.rejectionReasonCode = reasonCode ?? null;
      application.version += 1;
      application.updatedAt = now;
      await this.participation.updateApplication(tx, application);
      await appendOutboxEvent(tx, makeDomainEvent({
        eventType: 'JOIN_REQUEST_REJECTED', aggregateType: 'ROOM_APPLICATION', aggregateId: application.id,
        actorUserId: meta.actorUserId, correlationId: null, causationId: null, schemaVersion: 1,
        payload: { application_id: application.id, room_id: application.roomId, reason_code: application.rejectionReasonCode },
      }, this.clock));
      return { status: 'REJECTED' };
    });
  }

  async removeParticipantByHost(participantId: string, meta: CommandMeta, reasonCode?: string): Promise<IdempotencyResult<RemoveParticipantSummary>> {
    return this.idempotency.execute(command(meta), 200, async (tx) => {
      const participant = await this.requireParticipantLocked(tx, participantId);
      const room = await this.requireHostJoinableRoomLocked(tx, participant.roomId, meta.actorUserId);
      assertCanRemove(participant);
      const now = this.clock.now();
      const beforeActiveCount = await this.participation.countActiveParticipants(tx, room.id);
      participant.status = 'REMOVED_BY_HOST';
      participant.removedAt = now;
      participant.removedByUserId = meta.actorUserId;
      participant.removalReasonCode = reasonCode ?? null;
      participant.version += 1;
      participant.updatedAt = now;
      await this.participation.updateParticipant(tx, participant);
      await this.participation.insertCancellation(tx, {
        id: newId(), roomParticipantId: participant.id, cancelledByType: 'HOST', cancelledByUserId: meta.actorUserId,
        classification: 'HOST_REMOVED', reasonCode: reasonCode ?? null, reasonText: null,
        penaltyApplicable: false, sourceMaterialChangeId: null, createdAt: now,
      });
      const after = calculateAvailability(room, beforeActiveCount - 1);
      const previousStatus = room.status;
      room.status = derivePreStartStatus(room, after.availablePublicSlots);
      room.version += 1;
      room.updatedAt = now;
      await this.rooms.update(tx, room, false);
      await this.rooms.upsertAvailability(tx, room.id, after, now);
      await appendOutboxEvent(tx, makeDomainEvent({
        eventType: 'PLAYER_REMOVED_BY_HOST', aggregateType: 'ROOM_PARTICIPANT', aggregateId: participant.id,
        actorUserId: meta.actorUserId, correlationId: null, causationId: null, schemaVersion: 1,
        payload: { participant_id: participant.id, room_id: room.id, user_id: participant.userId, reason_code: participant.removalReasonCode },
      }, this.clock));
      if (previousStatus === 'FULL' && room.status === 'OPEN') {
        await appendOutboxEvent(tx, makeDomainEvent({
          eventType: 'ROOM_REOPENED', aggregateType: 'ROOM', aggregateId: room.id,
          actorUserId: meta.actorUserId, correlationId: null, causationId: participant.id, schemaVersion: 1,
          payload: { room_id: room.id, available_public_slots: after.availablePublicSlots },
        }, this.clock));
      }
      await this.reliabilityService?.onParticipantRemovedByHost(tx, { room, participant, availability: after, actorUserId: meta.actorUserId, now });
      return { participantId: participant.id, status: 'REMOVED_BY_HOST', roomStatus: room.status, availablePublicSlots: after.availablePublicSlots };
    });
  }

  async markPresent(participantId: string, meta: CommandMeta, reasonCode?: string): Promise<IdempotencyResult<AttendanceSummary>> {
    return this.markAttendance(participantId, meta, 'PRESENT', reasonCode);
  }

  async markNoShow(participantId: string, meta: CommandMeta, reasonCode?: string): Promise<IdempotencyResult<AttendanceSummary>> {
    return this.markAttendance(participantId, meta, 'NO_SHOW', reasonCode);
  }

  async listHostAttendance(roomId: string, actorUserId: string) {
    const room = await this.rooms.findById(this.db, roomId);
    if (!room) throw new DomainError('ROOM_NOT_FOUND', 'Room was not found.');
    if (room.hostUserId !== actorUserId) throw new DomainError('NOT_ROOM_HOST', 'Only the Room HOST may inspect attendance.');
    if (room.status !== 'IN_PROGRESS') throw new DomainError('ATTENDANCE_NOT_ALLOWED', 'Attendance is available only while the Room is in progress.', { room_id: room.id, status: room.status });
    return this.participation.listAttendanceForHost(this.db, roomId);
  }

  async listHostParticipants(roomId: string, actorUserId: string) {
    const room = await this.rooms.findById(this.db, roomId);
    if (!room) throw new DomainError('ROOM_NOT_FOUND', 'Room was not found.');
    if (room.hostUserId !== actorUserId) throw new DomainError('NOT_ROOM_HOST', 'Only the Room HOST may inspect participants.');
    return this.participation.listActiveParticipantsForHost(this.db, roomId);
  }

  async listHostPendingApplications(roomId: string, actorUserId: string): Promise<PendingApplicationView[]> {
    const room = await this.rooms.findById(this.db, roomId);
    if (!room) throw new DomainError('ROOM_NOT_FOUND', 'Room was not found.');
    if (room.hostUserId !== actorUserId) throw new DomainError('NOT_ROOM_HOST', 'Only the Room HOST may inspect applications.');
    return this.participation.listPendingForHost(this.db, roomId);
  }

  async listMyMatches(actorUserId: string): Promise<{ pending: MyRoomView[]; upcoming: MyRoomView[]; inProgress: MyRoomView[]; completed: MyRoomView[]; hosting: HostedRoomView[] }> {
    const [pending, upcoming, inProgress, completed, hosting] = await Promise.all([
      this.participation.listMyRooms(this.db, actorUserId, 'pending'),
      this.participation.listMyRooms(this.db, actorUserId, 'upcoming'),
      this.participation.listMyRooms(this.db, actorUserId, 'in_progress'),
      this.participation.listMyRooms(this.db, actorUserId, 'completed'),
      this.participation.listHostedRooms(this.db, actorUserId),
    ]);
    return { pending, upcoming, inProgress, completed, hosting };
  }

  async getViewerContext(roomId: string, actorUserId: string): Promise<{ application: RoomApplication | null; participant: RoomParticipant | null }> {
    const [application, participant] = await Promise.all([
      this.participation.findViewerApplication(this.db, roomId, actorUserId),
      this.participation.findViewerParticipant(this.db, roomId, actorUserId),
    ]);
    return { application, participant };
  }

  async hasScheduleConflict(roomId: string, actorUserId: string): Promise<boolean> {
    return this.participation.hasActiveScheduleConflict(this.db, actorUserId, roomId);
  }

  private async markAttendance(
    participantId: string,
    meta: CommandMeta,
    nextStatus: Extract<ParticipantAttendanceStatus, 'PRESENT' | 'NO_SHOW'>,
    reasonCode?: string,
  ): Promise<IdempotencyResult<AttendanceSummary>> {
    return this.idempotency.execute(command(meta), 200, async (tx) => {
      const participant = await this.requireParticipantLocked(tx, participantId);
      const room = await this.rooms.findById(tx, participant.roomId, true);
      if (!room) throw new DomainError('ROOM_NOT_FOUND', 'Room was not found.');
      if (room.hostUserId !== meta.actorUserId) throw new DomainError('NOT_ROOM_HOST', 'Only the Room HOST may record attendance.');
      if (room.status === 'COMPLETED') throw new DomainError('ROOM_TERMINAL', 'Attendance is immutable after Room completion.');
      if (room.status !== 'IN_PROGRESS') throw new DomainError('ATTENDANCE_NOT_ALLOWED', 'Attendance may only be recorded while the Room is in progress.');
      assertCanManageAttendance(participant);
      const now = this.clock.now();
      const noShowEligibleAt = new Date(room.scheduledStartAt.getTime() + noShowGraceMs);
      if (nextStatus === 'NO_SHOW' && now < noShowEligibleAt) {
        throw new DomainError('NO_SHOW_TOO_EARLY', 'No-show may only be marked after the configured grace period.', {
          participant_id: participant.id,
          eligible_at: noShowEligibleAt.toISOString(),
        });
      }
      const previousStatus = participant.attendanceStatus;
      if (previousStatus === nextStatus) {
        return { participantId: participant.id, attendanceStatus: nextStatus, noShowEligibleAt, corrected: false };
      }
      participant.attendanceStatus = nextStatus;
      participant.attendanceMarkedAt = now;
      participant.attendanceMarkedByUserId = meta.actorUserId;
      participant.attendanceReasonCode = reasonCode ?? null;
      participant.version += 1;
      participant.updatedAt = now;
      const corrected = previousStatus !== 'NOT_SET';
      await this.participation.updateParticipant(tx, participant);
      const priorNoShowLogId = previousStatus === 'NO_SHOW'
        ? await this.participation.findLatestNoShowAttendanceLogId(tx, participant.id)
        : null;
      const attendanceLogId = newId();
      await this.participation.appendAttendanceLog(tx, {
        id: attendanceLogId, roomId: room.id, participantId: participant.id, previousStatus, nextStatus,
        actorUserId: meta.actorUserId, reasonCode: participant.attendanceReasonCode, isCorrection: corrected, at: now,
      });
      await appendOutboxEvent(tx, makeDomainEvent({
        eventType: nextStatus === 'PRESENT' ? 'PLAYER_MARKED_PRESENT' : 'PLAYER_NO_SHOW',
        aggregateType: 'ROOM_PARTICIPANT', aggregateId: participant.id, actorUserId: meta.actorUserId,
        correlationId: null, causationId: null, schemaVersion: 1,
        payload: { participant_id: participant.id, room_id: room.id, user_id: participant.userId, previous_attendance_status: previousStatus, attendance_status: nextStatus, eligible_at: noShowEligibleAt.toISOString() },
      }, this.clock));
      if (corrected) {
        await appendOutboxEvent(tx, makeDomainEvent({
          eventType: 'ATTENDANCE_CORRECTED', aggregateType: 'ROOM_PARTICIPANT', aggregateId: participant.id,
          actorUserId: meta.actorUserId, correlationId: null, causationId: null, schemaVersion: 1,
          payload: { participant_id: participant.id, room_id: room.id, user_id: participant.userId, previous_attendance_status: previousStatus, attendance_status: nextStatus },
        }, this.clock));
      }
      await this.reliabilityService?.onAttendanceChanged(tx, {
        room, participant, previous: previousStatus, next: nextStatus, attendanceLogId, priorNoShowLogId,
        actorUserId: meta.actorUserId, now,
      });
      return { participantId: participant.id, attendanceStatus: nextStatus, noShowEligibleAt, corrected };
    });
  }

  private async requireApplicationLocked(tx: Transaction, applicationId: string): Promise<RoomApplication> {
    const application = await this.participation.findApplication(tx, applicationId, true);
    if (!application) throw new DomainError('APPLICATION_NOT_FOUND', 'Join application was not found.');
    return application;
  }

  private async requireParticipantLocked(tx: Transaction, participantId: string): Promise<RoomParticipant> {
    const participant = await this.participation.findParticipant(tx, participantId, true);
    if (!participant) throw new DomainError('NOT_PARTICIPANT', 'Participant was not found.');
    return participant;
  }

  private async requireJoinableRoomLocked(tx: Transaction, roomId: string): Promise<Room> {
    const room = await this.rooms.findById(tx, roomId, true);
    if (!room) throw new DomainError('ROOM_NOT_FOUND', 'Room was not found.');
    if (!['OPEN', 'FULL'].includes(room.status)) {
      throw new DomainError('ROOM_NOT_JOINABLE', 'Only open or full Rooms may receive join applications.', { room_id: room.id, status: room.status });
    }
    return room;
  }

  private async requireHostJoinableRoomLocked(tx: Transaction, roomId: string, actorUserId: string): Promise<Room> {
    const room = await this.requireJoinableRoomLocked(tx, roomId);
    if (room.hostUserId !== actorUserId) throw new DomainError('NOT_ROOM_HOST', 'Only the Room HOST may perform this command.');
    return room;
  }

  private async requireHostAcceptableRoomLocked(tx: Transaction, roomId: string, actorUserId: string): Promise<Room> {
    const room = await this.rooms.findById(tx, roomId, true);
    if (!room) throw new DomainError('ROOM_NOT_FOUND', 'Room was not found.');
    if (!['OPEN', 'FULL', 'IN_PROGRESS'].includes(room.status)) {
      throw new DomainError('ROOM_NOT_JOINABLE', 'Only open, full, or permitted emergency-refill Rooms may accept applications.', { room_id: room.id, status: room.status });
    }
    if (room.hostUserId !== actorUserId) throw new DomainError('NOT_ROOM_HOST', 'Only the Room HOST may perform this command.');
    return room;
  }

  private async requireHostForApplication(tx: Transaction, application: RoomApplication, actorUserId: string): Promise<void> {
    const room = await this.rooms.findById(tx, application.roomId, true);
    if (!room) throw new DomainError('ROOM_NOT_FOUND', 'Room was not found.');
    if (room.hostUserId !== actorUserId) throw new DomainError('NOT_ROOM_HOST', 'Only the Room HOST may perform this command.');
  }

  private insufficientCapacity(requiredSlots: number, availableSlots: number): never {
    throw new DomainError('INSUFFICIENT_CAPACITY', 'Room no longer has enough public slots.', {
      required_slots: requiredSlots,
      available_slots: availableSlots,
    });
  }

  private isUniqueViolation(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === '23505';
  }
}
