import { domainError } from '../../platform/core.js';

export type RoomApplicationStatus = 'REQUESTED' | 'WAITLISTED' | 'ACCEPTED' | 'REJECTED' | 'WITHDRAWN' | 'EXPIRED';
export type ApplicationMemberType = 'USER' | 'GUEST';
export type RoomParticipantStatus = 'ACTIVE' | 'CANCELLED' | 'REMOVED_BY_HOST';
export type ParticipantAttendanceStatus = 'NOT_SET' | 'PRESENT' | 'NO_SHOW';
export type ParticipationCancellationClassification = 'EARLY' | 'LATE' | 'HOST_REMOVED' | 'ROOM_CANCELLED' | 'MATERIAL_CHANGE_WAIVER';
export type CancellationSourceType = 'PLAYER' | 'HOST' | 'SYSTEM' | 'ROOM';
export type SlotLossType = 'EARLY_CANCEL' | 'LATE_CANCEL' | 'NO_SHOW' | 'EXTERNAL_RESERVED_DROP' | 'HOST_REMOVAL';

export interface RoomApplication {
  id: string;
  roomId: string;
  requestedByUserId: string;
  partyId: string | null;
  applicationOwnerKey: string;
  requestedSlotCount: number;
  status: RoomApplicationStatus;
  requestedAt: Date;
  acceptedAt: Date | null;
  rejectedAt: Date | null;
  withdrawnAt: Date | null;
  expiredAt: Date | null;
  rejectionReasonCode: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface RoomApplicationMember {
  id: string;
  applicationId: string;
  sourcePartyMemberId: string | null;
  memberType: ApplicationMemberType;
  userId: string | null;
  guestLabel: string | null;
  skillStateSnapshot: string | null;
  skillScoreSnapshot: number | null;
  rankTierSnapshot: number | null;
  reliabilityScoreSnapshot: number | null;
  createdAt: Date;
}

export interface RoomParticipant {
  id: string;
  roomId: string;
  applicationId: string;
  applicationMemberId: string;
  userId: string | null;
  memberType: ApplicationMemberType;
  status: RoomParticipantStatus;
  attendanceStatus: ParticipantAttendanceStatus;
  attendanceMarkedAt: Date | null;
  attendanceMarkedByUserId: string | null;
  attendanceReasonCode: string | null;
  acceptedAt: Date;
  cancelledAt: Date | null;
  removedAt: Date | null;
  removedByUserId: string | null;
  removalReasonCode: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const activeApplicationStatuses: RoomApplicationStatus[] = ['REQUESTED', 'WAITLISTED', 'ACCEPTED'];
export const pendingApplicationStatuses: RoomApplicationStatus[] = ['REQUESTED', 'WAITLISTED'];

export const assertApplicationActionable = (application: RoomApplication): void => {
  if (application.status === 'ACCEPTED' || application.status === 'REJECTED' || application.status === 'WITHDRAWN' || application.status === 'EXPIRED') {
    domainError('APPLICATION_ALREADY_RESOLVED', 'Application has already been resolved.', { application_id: application.id, status: application.status });
  }
};

export const assertCanWithdraw = (application: RoomApplication, actorUserId: string): void => {
  if (application.requestedByUserId !== actorUserId) domainError('FORBIDDEN', 'Only the applicant may withdraw this join request.');
  if (!pendingApplicationStatuses.includes(application.status)) {
    domainError('APPLICATION_NOT_ACTIONABLE', 'Only requested or waitlisted applications may be withdrawn.', { application_id: application.id, status: application.status });
  }
};

export const assertCanAccept = (application: RoomApplication): void => {
  if (!pendingApplicationStatuses.includes(application.status)) {
    domainError('APPLICATION_ALREADY_RESOLVED', 'Only requested or waitlisted applications may be accepted.', { application_id: application.id, status: application.status });
  }
};

export const assertCanReject = (application: RoomApplication): void => {
  if (!pendingApplicationStatuses.includes(application.status)) {
    domainError('APPLICATION_ALREADY_RESOLVED', 'Only requested or waitlisted applications may be rejected.', { application_id: application.id, status: application.status });
  }
};

export const assertCanManageAttendance = (participant: RoomParticipant): void => {
  if (participant.status !== 'ACTIVE') {
    domainError('ATTENDANCE_NOT_ALLOWED', 'Attendance may only be recorded for active accepted participants.', {
      participant_id: participant.id,
      participant_status: participant.status,
    });
  }
};

export const assertCanRemove = (participant: RoomParticipant): void => {
  if (participant.status !== 'ACTIVE') {
    domainError('APPLICATION_NOT_ACTIONABLE', 'Only active accepted participants may be removed by HOST.', { participant_id: participant.id, status: participant.status });
  }
};

export const assertCanCancelParticipant = (participant: RoomParticipant, actorUserId: string): void => {
  if (participant.userId !== actorUserId || participant.memberType !== 'USER') {
    domainError('FORBIDDEN', 'Only the accepted registered participant may cancel this slot.', { participant_id: participant.id });
  }
  if (participant.status !== 'ACTIVE') {
    domainError('APPLICATION_NOT_ACTIONABLE', 'Only an active accepted participant may be cancelled.', {
      participant_id: participant.id,
      status: participant.status,
    });
  }
};
