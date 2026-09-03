import type { QueryResultRow } from 'pg';
import type { SqlExecutor, Transaction } from '../../platform/database/db.js';
import type {
  ApplicationMemberType,
  CancellationSourceType,
  ParticipantAttendanceStatus,
  ParticipationCancellationClassification,
  RoomApplication,
  RoomApplicationMember,
  RoomApplicationStatus,
  RoomParticipant,
  RoomParticipantStatus,
} from './domain.js';

const numberOrNull = (value: string | number | null): number | null => value === null ? null : Number(value);

interface ApplicationRow extends QueryResultRow {
  id: string;
  room_id: string;
  requested_by_user_id: string;
  party_id: string | null;
  application_owner_key: string;
  requested_slot_count: number;
  status: RoomApplicationStatus;
  requested_at: Date;
  accepted_at: Date | null;
  rejected_at: Date | null;
  withdrawn_at: Date | null;
  expired_at: Date | null;
  rejection_reason_code: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface ApplicationMemberRow extends QueryResultRow {
  id: string;
  application_id: string;
  source_party_member_id: string | null;
  member_type: ApplicationMemberType;
  user_id: string | null;
  guest_label: string | null;
  skill_state_snapshot: string | null;
  skill_score_snapshot: string | null;
  rank_tier_snapshot: number | null;
  reliability_score_snapshot: string | null;
  created_at: Date;
}

interface ParticipantRow extends QueryResultRow {
  id: string;
  room_id: string;
  application_id: string;
  application_member_id: string;
  user_id: string | null;
  member_type: ApplicationMemberType;
  status: RoomParticipantStatus;
  attendance_status: ParticipantAttendanceStatus;
  attendance_marked_at: Date | null;
  attendance_marked_by_user_id: string | null;
  attendance_reason_code: string | null;
  accepted_at: Date;
  cancelled_at: Date | null;
  removed_at: Date | null;
  removed_by_user_id: string | null;
  removal_reason_code: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface ApplicantSnapshot {
  userId: string;
  displayName: string;
  skillState: string | null;
  skillScore: number | null;
  rankTier: number | null;
  reliabilityScore: number | null;
}

export interface PendingApplicationView {
  application: RoomApplication;
  members: Array<RoomApplicationMember & { displayName: string | null }>;
}

export interface ParticipationCancellationFact {
  id: string;
  roomParticipantId: string;
  cancelledByType: CancellationSourceType;
  cancelledByUserId: string | null;
  classification: ParticipationCancellationClassification;
  reasonCode: string | null;
  reasonText: string | null;
  penaltyApplicable: boolean;
  sourceMaterialChangeId: string | null;
  createdAt: Date;
}

export interface MyRoomView {
  type: 'PLAYER';
  roomId: string;
  title: string | null;
  roomStatus: string;
  startAt: Date;
  endAt: Date;
  participationStatus: 'ACCEPTED' | null;
  applicationStatus: RoomApplicationStatus | null;
}

export interface HostedRoomView {
  type: 'HOST';
  roomId: string;
  title: string | null;
  sportCode: string;
  roomStatus: string;
  startAt: Date;
  endAt: Date;
  venueName: string;
  venueAddress: string | null;
  capacity: number;
  availablePublicSlots: number;
  acceptedParticipantCount: number;
  pendingApplicationCount: number;
  waitlistApplicationCount: number;
}

const mapApplication = (row: ApplicationRow): RoomApplication => ({
  id: row.id,
  roomId: row.room_id,
  requestedByUserId: row.requested_by_user_id,
  partyId: row.party_id,
  applicationOwnerKey: row.application_owner_key,
  requestedSlotCount: row.requested_slot_count,
  status: row.status,
  requestedAt: row.requested_at,
  acceptedAt: row.accepted_at,
  rejectedAt: row.rejected_at,
  withdrawnAt: row.withdrawn_at,
  expiredAt: row.expired_at,
  rejectionReasonCode: row.rejection_reason_code,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapMember = (row: ApplicationMemberRow): RoomApplicationMember => ({
  id: row.id,
  applicationId: row.application_id,
  sourcePartyMemberId: row.source_party_member_id,
  memberType: row.member_type,
  userId: row.user_id,
  guestLabel: row.guest_label,
  skillStateSnapshot: row.skill_state_snapshot,
  skillScoreSnapshot: numberOrNull(row.skill_score_snapshot),
  rankTierSnapshot: row.rank_tier_snapshot,
  reliabilityScoreSnapshot: numberOrNull(row.reliability_score_snapshot),
  createdAt: row.created_at,
});

const mapParticipant = (row: ParticipantRow): RoomParticipant => ({
  id: row.id,
  roomId: row.room_id,
  applicationId: row.application_id,
  applicationMemberId: row.application_member_id,
  userId: row.user_id,
  memberType: row.member_type,
  status: row.status,
  attendanceStatus: row.attendance_status,
  attendanceMarkedAt: row.attendance_marked_at,
  attendanceMarkedByUserId: row.attendance_marked_by_user_id,
  attendanceReasonCode: row.attendance_reason_code,
  acceptedAt: row.accepted_at,
  cancelledAt: row.cancelled_at,
  removedAt: row.removed_at,
  removedByUserId: row.removed_by_user_id,
  removalReasonCode: row.removal_reason_code,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class ParticipationRepository {
  async findApplicantSnapshot(executor: SqlExecutor, userId: string, sportId: string): Promise<ApplicantSnapshot | null> {
    const result = await executor.query<{
      user_id: string; display_name: string; skill_state: string | null; skill_score: string | null;
      rank_tier: number | null;
    }>(
      `SELECT u.id AS user_id, u.display_name, p.skill_state, p.skill_score, p.rank_tier
       FROM users u
       LEFT JOIN user_sport_profiles p ON p.user_id = u.id AND p.sport_id = $2
       WHERE u.id = $1 AND u.status = 'ACTIVE'`,
      [userId, sportId],
    );
    const row = result.rows[0];
    return row ? {
      userId: row.user_id, displayName: row.display_name, skillState: row.skill_state,
      skillScore: numberOrNull(row.skill_score), rankTier: row.rank_tier, reliabilityScore: null,
    } : null;
  }

  async hasActiveApplication(executor: SqlExecutor, roomId: string, ownerKey: string): Promise<boolean> {
    const result = await executor.query<{ present: boolean }>(
      `SELECT EXISTS(
        SELECT 1 FROM room_applications
        WHERE room_id = $1 AND application_owner_key = $2
          AND status IN ('REQUESTED', 'WAITLISTED', 'ACCEPTED')
      ) AS present`,
      [roomId, ownerKey],
    );
    return result.rows[0]?.present ?? false;
  }

  async insertApplication(tx: Transaction, application: RoomApplication, members: RoomApplicationMember[]): Promise<void> {
    await tx.query(
      `INSERT INTO room_applications (
        id, room_id, requested_by_user_id, party_id, application_owner_key, requested_slot_count, status,
        requested_at, accepted_at, rejected_at, withdrawn_at, expired_at, rejection_reason_code,
        version, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        application.id, application.roomId, application.requestedByUserId, application.partyId,
        application.applicationOwnerKey, application.requestedSlotCount, application.status,
        application.requestedAt, application.acceptedAt, application.rejectedAt, application.withdrawnAt,
        application.expiredAt, application.rejectionReasonCode, application.version, application.createdAt, application.updatedAt,
      ],
    );
    for (const member of members) {
      await tx.query(
        `INSERT INTO room_application_members (
          id, application_id, source_party_member_id, member_type, user_id, guest_label,
          skill_state_snapshot, skill_score_snapshot, rank_tier_snapshot, reliability_score_snapshot, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          member.id, member.applicationId, member.sourcePartyMemberId, member.memberType, member.userId, member.guestLabel,
          member.skillStateSnapshot, member.skillScoreSnapshot, member.rankTierSnapshot, member.reliabilityScoreSnapshot, member.createdAt,
        ],
      );
    }
  }

  async findApplication(executor: SqlExecutor, applicationId: string, forUpdate = false): Promise<RoomApplication | null> {
    const result = await executor.query<ApplicationRow>(
      `SELECT * FROM room_applications WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [applicationId],
    );
    return result.rows[0] ? mapApplication(result.rows[0]) : null;
  }

  async getApplicationMembers(executor: SqlExecutor, applicationId: string): Promise<RoomApplicationMember[]> {
    const result = await executor.query<ApplicationMemberRow>(
      'SELECT * FROM room_application_members WHERE application_id = $1 ORDER BY created_at, id',
      [applicationId],
    );
    return result.rows.map(mapMember);
  }

  async updateApplication(tx: Transaction, application: RoomApplication): Promise<void> {
    await tx.query(
      `UPDATE room_applications SET status=$2, accepted_at=$3, rejected_at=$4, withdrawn_at=$5,
        expired_at=$6, rejection_reason_code=$7, version=$8, updated_at=$9 WHERE id=$1`,
      [
        application.id, application.status, application.acceptedAt, application.rejectedAt, application.withdrawnAt,
        application.expiredAt, application.rejectionReasonCode, application.version, application.updatedAt,
      ],
    );
  }

  async createParticipants(tx: Transaction, participants: RoomParticipant[]): Promise<void> {
    for (const participant of participants) {
      await tx.query(
        `INSERT INTO room_participants (
          id, room_id, application_id, application_member_id, user_id, member_type, status, attendance_status,
          attendance_marked_at, attendance_marked_by_user_id, attendance_reason_code,
          accepted_at, cancelled_at, removed_at, removed_by_user_id, removal_reason_code,
          version, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [
          participant.id, participant.roomId, participant.applicationId, participant.applicationMemberId,
          participant.userId, participant.memberType, participant.status, participant.attendanceStatus,
          participant.attendanceMarkedAt, participant.attendanceMarkedByUserId, participant.attendanceReasonCode,
          participant.acceptedAt, participant.cancelledAt, participant.removedAt, participant.removedByUserId,
          participant.removalReasonCode, participant.version, participant.createdAt, participant.updatedAt,
        ],
      );
    }
  }

  async lockUserSchedule(tx: Transaction, userId: string): Promise<void> {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [userId]);
  }

  async hasActiveScheduleConflict(executor: SqlExecutor, userId: string, roomId: string): Promise<boolean> {
    const result = await executor.query<{ present: boolean }>(
      `SELECT EXISTS(
        SELECT 1
        FROM room_participants p
        JOIN rooms accepted_room ON accepted_room.id = p.room_id
        JOIN rooms requested_room ON requested_room.id = $2
        WHERE p.user_id = $1
          AND p.status = 'ACTIVE'
          AND accepted_room.status IN ('OPEN', 'FULL', 'IN_PROGRESS')
          AND accepted_room.id <> requested_room.id
          AND accepted_room.scheduled_start_at < requested_room.scheduled_end_at
          AND accepted_room.scheduled_end_at > requested_room.scheduled_start_at
      ) AS present`,
      [userId, roomId],
    );
    return result.rows[0]?.present ?? false;
  }

  async withdrawPendingOverlappingApplications(
    tx: Transaction,
    userId: string,
    acceptedRoomId: string,
    acceptedApplicationId: string,
    now: Date,
  ): Promise<RoomApplication[]> {
    const result = await tx.query<ApplicationRow>(
      `WITH candidates AS (
        SELECT DISTINCT application.id
        FROM room_applications application
        JOIN room_application_members application_member ON application_member.application_id = application.id
        JOIN rooms pending_room ON pending_room.id = application.room_id
        JOIN rooms accepted_room ON accepted_room.id = $2
        WHERE application_member.user_id = $1
          AND application.id <> $3
          AND application.status IN ('REQUESTED', 'WAITLISTED')
          AND pending_room.status IN ('OPEN', 'FULL')
          AND pending_room.id <> accepted_room.id
          AND pending_room.scheduled_start_at < accepted_room.scheduled_end_at
          AND pending_room.scheduled_end_at > accepted_room.scheduled_start_at
      )
      UPDATE room_applications application
      SET status = 'WITHDRAWN', withdrawn_at = $4, version = version + 1, updated_at = $4
      FROM candidates
      WHERE application.id = candidates.id
      RETURNING application.*`,
      [userId, acceptedRoomId, acceptedApplicationId, now],
    );
    return result.rows.map(mapApplication);
  }

  async countActiveParticipants(executor: SqlExecutor, roomId: string): Promise<number> {
    const result = await executor.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM room_participants
       WHERE room_id = $1 AND status = 'ACTIVE' AND attendance_status <> 'NO_SHOW'`,
      [roomId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async countEffectiveNoShows(executor: SqlExecutor, roomId: string): Promise<number> {
    const result = await executor.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM room_participants
       WHERE room_id = $1 AND status = 'ACTIVE' AND attendance_status = 'NO_SHOW'`,
      [roomId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async countUnsetActiveAttendance(executor: SqlExecutor, roomId: string): Promise<number> {
    const result = await executor.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM room_participants
       WHERE room_id = $1 AND status = 'ACTIVE' AND attendance_status = 'NOT_SET'`,
      [roomId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async findParticipant(executor: SqlExecutor, participantId: string, forUpdate = false): Promise<RoomParticipant | null> {
    const result = await executor.query<ParticipantRow>(
      `SELECT * FROM room_participants WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [participantId],
    );
    return result.rows[0] ? mapParticipant(result.rows[0]) : null;
  }

  /** Locks only unclaimed Guest seats in the same Party application when its Party owner cancels their own seat. */
  async listUnclaimedGuestParticipantsOwnedBy(tx: Transaction, applicationId: string, ownerUserId: string): Promise<RoomParticipant[]> {
    const result = await tx.query<ParticipantRow>(
      `SELECT participant.*
       FROM room_participants participant
       JOIN room_applications application ON application.id = participant.application_id
       JOIN parties party ON party.id = application.party_id
       WHERE participant.application_id = $1
         AND party.owner_user_id = $2
         AND participant.member_type = 'GUEST'
         AND participant.user_id IS NULL
         AND participant.status = 'ACTIVE'
       FOR UPDATE`,
      [applicationId, ownerUserId],
    );
    return result.rows.map(mapParticipant);
  }

  async updateParticipant(tx: Transaction, participant: RoomParticipant): Promise<void> {
    await tx.query(
      `UPDATE room_participants SET status=$2, attendance_status=$3, attendance_marked_at=$4,
       attendance_marked_by_user_id=$5, attendance_reason_code=$6, cancelled_at=$7, removed_at=$8,
       removed_by_user_id=$9, removal_reason_code=$10, version=$11, updated_at=$12 WHERE id=$1`,
      [
        participant.id, participant.status, participant.attendanceStatus, participant.attendanceMarkedAt,
        participant.attendanceMarkedByUserId, participant.attendanceReasonCode, participant.cancelledAt, participant.removedAt,
        participant.removedByUserId, participant.removalReasonCode, participant.version, participant.updatedAt,
      ],
    );
  }

  async expirePendingApplicationsOnRoomStart(tx: Transaction, roomId: string, now: Date): Promise<RoomApplication[]> {
    const result = await tx.query<ApplicationRow>(
      `UPDATE room_applications
       SET status = 'EXPIRED', expired_at = $2, version = version + 1, updated_at = $2
       WHERE room_id = $1 AND status IN ('REQUESTED', 'WAITLISTED')
       RETURNING *`,
      [roomId, now],
    );
    return result.rows.map(mapApplication);
  }

  async appendAttendanceLog(
    tx: Transaction,
    input: { id: string; roomId: string; participantId: string; previousStatus: ParticipantAttendanceStatus; nextStatus: ParticipantAttendanceStatus; actorUserId: string; reasonCode: string | null; isCorrection: boolean; at: Date },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO participant_attendance_logs (
        id, room_id, participant_id, previous_status, next_status, changed_by_user_id, reason_code, is_correction, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [input.id, input.roomId, input.participantId, input.previousStatus, input.nextStatus, input.actorUserId, input.reasonCode, input.isCorrection, input.at],
    );
  }

  async listAttendanceForHost(executor: SqlExecutor, roomId: string): Promise<Array<RoomParticipant & { displayName: string | null; noShowEligibleAt: Date }>> {
    const result = await executor.query<ParticipantRow & { display_name: string | null; scheduled_start_at: Date }>(
      `SELECT p.*, u.display_name, r.scheduled_start_at
       FROM room_participants p
       JOIN rooms r ON r.id = p.room_id
       LEFT JOIN users u ON u.id = p.user_id
       WHERE p.room_id = $1 AND p.status = 'ACTIVE'
       ORDER BY p.accepted_at, p.id`,
      [roomId],
    );
    return result.rows.map((row) => ({ ...mapParticipant(row), displayName: row.display_name, noShowEligibleAt: new Date(row.scheduled_start_at.getTime() + 15 * 60 * 1000) }));
  }

  /** Host-manager participant projection is valid before and during a Room; attendance actions remain lifecycle-gated. */
  async listActiveParticipantsForHost(executor: SqlExecutor, roomId: string): Promise<Array<RoomParticipant & { displayName: string | null }>> {
    const result = await executor.query<ParticipantRow & { display_name: string | null }>(
      `SELECT p.*, u.display_name
       FROM room_participants p LEFT JOIN users u ON u.id = p.user_id
       WHERE p.room_id = $1 AND p.status = 'ACTIVE'
       ORDER BY p.accepted_at, p.id`,
      [roomId],
    );
    return result.rows.map((row) => ({ ...mapParticipant(row), displayName: row.display_name }));
  }

  async listPendingForHost(executor: SqlExecutor, roomId: string): Promise<PendingApplicationView[]> {
    const applications = await executor.query<ApplicationRow>(
      `SELECT * FROM room_applications
       WHERE room_id = $1 AND status IN ('REQUESTED', 'WAITLISTED')
       ORDER BY requested_at, id`,
      [roomId],
    );
    const result: PendingApplicationView[] = [];
    for (const application of applications.rows.map(mapApplication)) {
      const members = await executor.query<ApplicationMemberRow & { display_name: string | null }>(
        `SELECT m.*, u.display_name
         FROM room_application_members m LEFT JOIN users u ON u.id = m.user_id
         WHERE m.application_id = $1 ORDER BY m.created_at, m.id`,
        [application.id],
      );
      result.push({ application, members: members.rows.map((row) => ({ ...mapMember(row), displayName: row.display_name })) });
    }
    return result;
  }

  async findLatestNoShowAttendanceLogId(executor: SqlExecutor, participantId: string): Promise<string | null> {
    const result = await executor.query<{ id: string }>(
      `SELECT id FROM participant_attendance_logs
       WHERE participant_id = $1 AND next_status = 'NO_SHOW'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [participantId],
    );
    return result.rows[0]?.id ?? null;
  }

  async insertCancellation(tx: Transaction, fact: ParticipationCancellationFact): Promise<void> {
    await tx.query(
      `INSERT INTO participation_cancellations (
        id, room_participant_id, cancelled_by_type, cancelled_by_user_id, classification,
        reason_code, reason_text, penalty_applicable, source_material_change_id, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        fact.id, fact.roomParticipantId, fact.cancelledByType, fact.cancelledByUserId, fact.classification,
        fact.reasonCode, fact.reasonText, fact.penaltyApplicable, fact.sourceMaterialChangeId, fact.createdAt,
      ],
    );
  }

  async cancelActiveParticipantsForRoom(tx: Transaction, roomId: string, now: Date): Promise<RoomParticipant[]> {
    const result = await tx.query<ParticipantRow>(
      `UPDATE room_participants
       SET status = 'CANCELLED', cancelled_at = $2, version = version + 1, updated_at = $2
       WHERE room_id = $1 AND status = 'ACTIVE'
       RETURNING *`,
      [roomId, now],
    );
    return result.rows.map(mapParticipant);
  }

  async expirePendingApplicationsOnRoomCancellation(tx: Transaction, roomId: string, now: Date): Promise<RoomApplication[]> {
    const result = await tx.query<ApplicationRow>(
      `UPDATE room_applications
       SET status = 'EXPIRED', expired_at = $2, version = version + 1, updated_at = $2
       WHERE room_id = $1 AND status IN ('REQUESTED', 'WAITLISTED')
       RETURNING *`,
      [roomId, now],
    );
    return result.rows.map(mapApplication);
  }

  async listPresentParticipantsForCompletion(executor: SqlExecutor, roomId: string): Promise<RoomParticipant[]> {
    const result = await executor.query<ParticipantRow>(
      `SELECT * FROM room_participants
       WHERE room_id = $1 AND status = 'ACTIVE' AND attendance_status = 'PRESENT'
       ORDER BY accepted_at, id`,
      [roomId],
    );
    return result.rows.map(mapParticipant);
  }

  async listMyRooms(executor: SqlExecutor, userId: string, filter: 'pending' | 'upcoming' | 'in_progress' | 'completed'): Promise<MyRoomView[]> {
    if (filter === 'pending') {
      const result = await executor.query<{
        room_id: string; title: string | null; room_status: string; scheduled_start_at: Date; scheduled_end_at: Date; application_status: RoomApplicationStatus;
      }>(
        `SELECT r.id AS room_id, r.title, r.status AS room_status, r.scheduled_start_at, r.scheduled_end_at, a.status AS application_status
         FROM room_applications a JOIN rooms r ON r.id = a.room_id
         WHERE a.requested_by_user_id = $1 AND a.status IN ('REQUESTED', 'WAITLISTED')
         ORDER BY r.scheduled_start_at, a.requested_at`,
        [userId],
      );
      return result.rows.map((row) => ({
        type: 'PLAYER', roomId: row.room_id, title: row.title, roomStatus: row.room_status,
        startAt: row.scheduled_start_at, endAt: row.scheduled_end_at,
        participationStatus: null, applicationStatus: row.application_status,
      }));
    }
    const result = await executor.query<{
      room_id: string; title: string | null; room_status: string; scheduled_start_at: Date; scheduled_end_at: Date;
    }>(
      `SELECT DISTINCT r.id AS room_id, r.title, r.status AS room_status, r.scheduled_start_at, r.scheduled_end_at
       FROM room_participants p JOIN rooms r ON r.id = p.room_id
       WHERE p.user_id = $1 AND p.status = 'ACTIVE'
         AND r.status = ANY($2::room_status[])
       ORDER BY r.scheduled_start_at`,
      [userId, filter === 'upcoming' ? ['OPEN', 'FULL'] : filter === 'in_progress' ? ['IN_PROGRESS'] : ['COMPLETED']],
    );
    return result.rows.map((row) => ({
      type: 'PLAYER', roomId: row.room_id, title: row.title, roomStatus: row.room_status,
      startAt: row.scheduled_start_at, endAt: row.scheduled_end_at,
      participationStatus: 'ACCEPTED', applicationStatus: null,
    }));
  }

  async listHostedRooms(executor: SqlExecutor, userId: string): Promise<HostedRoomView[]> {
    const result = await executor.query<{
      room_id: string; title: string | null; sport_code: string; room_status: string; scheduled_start_at: Date; scheduled_end_at: Date;
      venue_name: string; venue_address: string | null; capacity: number; available_public_slots: number;
      accepted_participant_count: string; pending_application_count: string; waitlist_application_count: string;
    }>(
      `SELECT r.id AS room_id, r.title, s.code AS sport_code, r.status AS room_status,
              r.scheduled_start_at, r.scheduled_end_at, r.venue_name, r.venue_address, r.capacity,
              availability.available_public_slots,
              COUNT(DISTINCT p.id) FILTER (WHERE p.status = 'ACTIVE') AS accepted_participant_count,
              COUNT(DISTINCT a.id) FILTER (WHERE a.status = 'REQUESTED') AS pending_application_count,
              COUNT(DISTINCT a.id) FILTER (WHERE a.status = 'WAITLISTED') AS waitlist_application_count
       FROM rooms r
       JOIN sports s ON s.id = r.sport_id
       JOIN room_availability_projections availability ON availability.room_id = r.id
       LEFT JOIN room_participants p ON p.room_id = r.id
       LEFT JOIN room_applications a ON a.room_id = r.id
       WHERE r.host_user_id = $1
       GROUP BY r.id, s.code, availability.available_public_slots
       ORDER BY r.scheduled_start_at DESC, r.id`,
      [userId],
    );
    return result.rows.map((row) => ({
      type: 'HOST', roomId: row.room_id, title: row.title, sportCode: row.sport_code, roomStatus: row.room_status,
      startAt: row.scheduled_start_at, endAt: row.scheduled_end_at, venueName: row.venue_name, venueAddress: row.venue_address,
      capacity: row.capacity, availablePublicSlots: row.available_public_slots,
      acceptedParticipantCount: Number(row.accepted_participant_count), pendingApplicationCount: Number(row.pending_application_count),
      waitlistApplicationCount: Number(row.waitlist_application_count),
    }));
  }

  async findViewerApplication(executor: SqlExecutor, roomId: string, userId: string): Promise<RoomApplication | null> {
    const result = await executor.query<ApplicationRow>(
      `SELECT a.* FROM room_applications a
       WHERE a.room_id = $1
         AND (a.requested_by_user_id = $2 OR EXISTS (
           SELECT 1 FROM room_application_members m WHERE m.application_id = a.id AND m.user_id = $2
         ))
       ORDER BY a.requested_at DESC, a.id DESC LIMIT 1`,
      [roomId, userId],
    );
    return result.rows[0] ? mapApplication(result.rows[0]) : null;
  }

  async findViewerParticipant(executor: SqlExecutor, roomId: string, userId: string): Promise<RoomParticipant | null> {
    const result = await executor.query<ParticipantRow>(
      `SELECT * FROM room_participants WHERE room_id = $1 AND user_id = $2
       ORDER BY accepted_at DESC, id DESC LIMIT 1`,
      [roomId, userId],
    );
    return result.rows[0] ? mapParticipant(result.rows[0]) : null;
  }
}
