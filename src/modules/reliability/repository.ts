import type { QueryResultRow } from 'pg';
import type { SqlExecutor, Transaction } from '../../platform/database/db.js';
import type { ParticipationCancellationClassification, SlotLossType } from '../participation/domain.js';

const numeric = (value: string | number): number => Number(value);

export interface PlayerReliabilityStats {
  userId: string;
  acceptedMatches: number;
  completedMatches: number;
  earlyCancels: number;
  lateCancels: number;
  noShows: number;
  guestNoShowsAttributed: number;
  hostRemovedCount: number;
  roomCancelledCount: number;
  materialChangeWaivers: number;
  reliabilityScore: number;
  presentMatchesSinceLastPenalty: number;
  updatedAt: Date;
}

export interface HostStats {
  userId: string;
  roomsCreated: number;
  roomsCompleted: number;
  roomsCancelled: number;
  lateRoomCancellations: number;
  acceptedPlayersTotal: number;
  playersRemovedAfterAccept: number;
  materialChangesAfterAccept: number;
  repeatPlayers: number;
  lostSlots: number;
  recoveredSlots: number;
  hostTrustScore: number | null;
  updatedAt: Date;
}

export interface RefillState {
  roomId: string;
  active: boolean;
  searchBoostActive: boolean;
  reason: string | null;
  startedAt: Date | null;
  replacementWindowEndsAt: Date | null;
  disabledAt: Date | null;
  lastLossEventId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SlotRecoveryRecord {
  id: string;
  roomId: string;
  lossEventId: string;
  lossType: SlotLossType;
  lostAt: Date;
  recovered: boolean;
  replacementParticipantId: string | null;
  recoveredAt: Date | null;
  recoverySeconds: number | null;
  expiredAt: Date | null;
  voidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface PlayerReliabilityRow extends QueryResultRow {
  user_id: string;
  accepted_matches: number;
  completed_matches: number;
  early_cancels: number;
  late_cancels: number;
  no_shows: number;
  guest_no_shows_attributed: number;
  host_removed_count: number;
  room_cancelled_count: number;
  material_change_waivers: number;
  reliability_score: string;
  present_matches_since_last_penalty: number;
  updated_at: Date;
}

interface HostStatsRow extends QueryResultRow {
  user_id: string;
  rooms_created: number;
  rooms_completed: number;
  rooms_cancelled: number;
  late_room_cancellations: number;
  accepted_players_total: number;
  players_removed_after_accept: number;
  material_changes_after_accept: number;
  repeat_players: number;
  lost_slots: number;
  recovered_slots: number;
  host_trust_score: string | null;
  updated_at: Date;
}

interface RefillStateRow extends QueryResultRow {
  room_id: string;
  active: boolean;
  search_boost_active: boolean;
  reason: string | null;
  started_at: Date | null;
  replacement_window_ends_at: Date | null;
  disabled_at: Date | null;
  last_loss_event_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface SlotRecoveryRow extends QueryResultRow {
  id: string;
  room_id: string;
  loss_event_id: string;
  loss_type: SlotLossType;
  lost_at: Date;
  recovered: boolean;
  replacement_participant_id: string | null;
  recovered_at: Date | null;
  recovery_seconds: number | null;
  expired_at: Date | null;
  voided_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const playerStatsFrom = (row: PlayerReliabilityRow): PlayerReliabilityStats => ({
  userId: row.user_id,
  acceptedMatches: row.accepted_matches,
  completedMatches: row.completed_matches,
  earlyCancels: row.early_cancels,
  lateCancels: row.late_cancels,
  noShows: row.no_shows,
  guestNoShowsAttributed: row.guest_no_shows_attributed,
  hostRemovedCount: row.host_removed_count,
  roomCancelledCount: row.room_cancelled_count,
  materialChangeWaivers: row.material_change_waivers,
  reliabilityScore: numeric(row.reliability_score),
  presentMatchesSinceLastPenalty: row.present_matches_since_last_penalty,
  updatedAt: row.updated_at,
});

const hostStatsFrom = (row: HostStatsRow): HostStats => ({
  userId: row.user_id,
  roomsCreated: row.rooms_created,
  roomsCompleted: row.rooms_completed,
  roomsCancelled: row.rooms_cancelled,
  lateRoomCancellations: row.late_room_cancellations,
  acceptedPlayersTotal: row.accepted_players_total,
  playersRemovedAfterAccept: row.players_removed_after_accept,
  materialChangesAfterAccept: row.material_changes_after_accept,
  repeatPlayers: row.repeat_players,
  lostSlots: row.lost_slots,
  recoveredSlots: row.recovered_slots,
  hostTrustScore: row.host_trust_score === null ? null : numeric(row.host_trust_score),
  updatedAt: row.updated_at,
});

const refillStateFrom = (row: RefillStateRow): RefillState => ({
  roomId: row.room_id,
  active: row.active,
  searchBoostActive: row.search_boost_active,
  reason: row.reason,
  startedAt: row.started_at,
  replacementWindowEndsAt: row.replacement_window_ends_at,
  disabledAt: row.disabled_at,
  lastLossEventId: row.last_loss_event_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const slotRecoveryFrom = (row: SlotRecoveryRow): SlotRecoveryRecord => ({
  id: row.id,
  roomId: row.room_id,
  lossEventId: row.loss_event_id,
  lossType: row.loss_type,
  lostAt: row.lost_at,
  recovered: row.recovered,
  replacementParticipantId: row.replacement_participant_id,
  recoveredAt: row.recovered_at,
  recoverySeconds: row.recovery_seconds,
  expiredAt: row.expired_at,
  voidedAt: row.voided_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class ReliabilityRepository {
  async getPlayerStats(executor: SqlExecutor, userId: string): Promise<PlayerReliabilityStats | null> {
    const result = await executor.query<PlayerReliabilityRow>('SELECT * FROM player_reliability_stats WHERE user_id = $1', [userId]);
    return result.rows[0] ? playerStatsFrom(result.rows[0]) : null;
  }

  async getHostStats(executor: SqlExecutor, userId: string): Promise<HostStats | null> {
    const result = await executor.query<HostStatsRow>('SELECT * FROM host_stats WHERE user_id = $1', [userId]);
    return result.rows[0] ? hostStatsFrom(result.rows[0]) : null;
  }

  async ensurePlayerStats(tx: Transaction, userId: string, now: Date): Promise<PlayerReliabilityStats> {
    await tx.query(
      `INSERT INTO player_reliability_stats (user_id, updated_at) VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, now],
    );
    const result = await tx.query<PlayerReliabilityRow>('SELECT * FROM player_reliability_stats WHERE user_id = $1 FOR UPDATE', [userId]);
    return playerStatsFrom(result.rows[0]!);
  }

  async ensureHostStats(tx: Transaction, userId: string, now: Date): Promise<HostStats> {
    await tx.query(
      `INSERT INTO host_stats (user_id, updated_at) VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, now],
    );
    const result = await tx.query<HostStatsRow>('SELECT * FROM host_stats WHERE user_id = $1 FOR UPDATE', [userId]);
    return hostStatsFrom(result.rows[0]!);
  }

  async incrementAcceptedParticipant(tx: Transaction, userId: string, hostUserId: string, now: Date): Promise<void> {
    await this.ensurePlayerStats(tx, userId, now);
    await this.ensureHostStats(tx, hostUserId, now);
    await tx.query(
      `UPDATE player_reliability_stats
       SET accepted_matches = accepted_matches + 1, updated_at = $2 WHERE user_id = $1`,
      [userId, now],
    );
    await tx.query(
      `UPDATE host_stats
       SET accepted_players_total = accepted_players_total + 1, updated_at = $2 WHERE user_id = $1`,
      [hostUserId, now],
    );
  }

  async recordCancellationClassification(
    tx: Transaction,
    input: { userId: string | null; classification: ParticipationCancellationClassification; now: Date },
  ): Promise<void> {
    if (!input.userId) return;
    await this.ensurePlayerStats(tx, input.userId, input.now);
    const columnByClassification: Partial<Record<ParticipationCancellationClassification, string>> = {
      EARLY: 'early_cancels',
      MATERIAL_CHANGE_WAIVER: 'material_change_waivers',
      HOST_REMOVED: 'host_removed_count',
      ROOM_CANCELLED: 'room_cancelled_count',
    };
    const column = columnByClassification[input.classification];
    if (!column) return;
    await tx.query(`UPDATE player_reliability_stats SET ${column} = ${column} + 1, updated_at = $2 WHERE user_id = $1`, [input.userId, input.now]);
  }

  async applyPlayerAdjustment(
    tx: Transaction,
    input: {
      id: string;
      userId: string;
      sourceEventId: string;
      adjustment: number;
      reason: 'LATE_CANCEL' | 'NO_SHOW' | 'NO_SHOW_REVERSED' | 'PRESENT_RECOVERY';
      now: Date;
    },
  ): Promise<{ applied: boolean; scoreBefore: number; scoreAfter: number }> {
    const stats = await this.ensurePlayerStats(tx, input.userId, input.now);
    const existing = await tx.query<{ id: string }>(
      `SELECT id FROM reliability_adjustments
       WHERE source_event_id = $1 AND subject_type = 'PLAYER' AND user_id = $2 AND reason = $3`,
      [input.sourceEventId, input.userId, input.reason],
    );
    if (existing.rowCount) return { applied: false, scoreBefore: stats.reliabilityScore, scoreAfter: stats.reliabilityScore };
    const scoreBefore = stats.reliabilityScore;
    const scoreAfter = Math.max(0, Math.min(100, scoreBefore + input.adjustment));
    await tx.query(
      `INSERT INTO reliability_adjustments (
         id, user_id, subject_type, source_event_id, adjustment, reason, score_before, score_after, created_at
       ) VALUES ($1,$2,'PLAYER',$3,$4,$5,$6,$7,$8)`,
      [input.id, input.userId, input.sourceEventId, input.adjustment, input.reason, scoreBefore, scoreAfter, input.now],
    );
    const counterSql = input.reason === 'LATE_CANCEL'
      ? 'late_cancels = late_cancels + 1, present_matches_since_last_penalty = 0'
      : input.reason === 'NO_SHOW'
        ? 'no_shows = no_shows + 1, present_matches_since_last_penalty = 0'
        : input.reason === 'NO_SHOW_REVERSED'
          ? 'no_shows = GREATEST(0, no_shows - 1)'
          : 'present_matches_since_last_penalty = GREATEST(0, present_matches_since_last_penalty - 5)';
    await tx.query(
      `UPDATE player_reliability_stats
       SET reliability_score = $2, ${counterSql}, updated_at = $3
       WHERE user_id = $1`,
      [input.userId, scoreAfter, input.now],
    );
    return { applied: true, scoreBefore, scoreAfter };
  }

  async recordPresentCompletion(
    tx: Transaction,
    input: { userId: string; sourceEventId: string; adjustmentId: string; now: Date },
  ): Promise<{ recovered: boolean; scoreBefore: number; scoreAfter: number }> {
    const stats = await this.ensurePlayerStats(tx, input.userId, input.now);
    const nextCompleted = stats.completedMatches + 1;
    const nextStreak = stats.presentMatchesSinceLastPenalty + 1;
    await tx.query(
      `UPDATE player_reliability_stats
       SET completed_matches = $2, present_matches_since_last_penalty = $3, updated_at = $4
       WHERE user_id = $1`,
      [input.userId, nextCompleted, nextStreak, input.now],
    );
    if (nextStreak < 5 || stats.reliabilityScore >= 100) return { recovered: false, scoreBefore: stats.reliabilityScore, scoreAfter: stats.reliabilityScore };
    const result = await this.applyPlayerAdjustment(tx, {
      id: input.adjustmentId,
      userId: input.userId,
      sourceEventId: input.sourceEventId,
      adjustment: 1,
      reason: 'PRESENT_RECOVERY',
      now: input.now,
    });
    return { recovered: result.applied, scoreBefore: result.scoreBefore, scoreAfter: result.scoreAfter };
  }

  async incrementHostRemoval(tx: Transaction, hostUserId: string, now: Date): Promise<void> {
    await this.ensureHostStats(tx, hostUserId, now);
    await tx.query(
      `UPDATE host_stats SET players_removed_after_accept = players_removed_after_accept + 1, updated_at = $2 WHERE user_id = $1`,
      [hostUserId, now],
    );
  }

  async incrementHostRoomCancelled(tx: Transaction, hostUserId: string, now: Date): Promise<void> {
    await this.ensureHostStats(tx, hostUserId, now);
    await tx.query(`UPDATE host_stats SET rooms_cancelled = rooms_cancelled + 1, updated_at = $2 WHERE user_id = $1`, [hostUserId, now]);
  }

  async incrementHostRoomCompleted(tx: Transaction, hostUserId: string, now: Date): Promise<void> {
    await this.ensureHostStats(tx, hostUserId, now);
    await tx.query(`UPDATE host_stats SET rooms_completed = rooms_completed + 1, updated_at = $2 WHERE user_id = $1`, [hostUserId, now]);
  }

  async recordSlotLoss(tx: Transaction, input: Omit<SlotRecoveryRecord, 'recovered' | 'replacementParticipantId' | 'recoveredAt' | 'recoverySeconds' | 'expiredAt' | 'voidedAt' | 'createdAt' | 'updatedAt'> & { now: Date; hostUserId: string }): Promise<void> {
    const inserted = await tx.query(
      `INSERT INTO slot_recovery_records (
        id, room_id, loss_event_id, loss_type, lost_at, recovered, replacement_participant_id,
        recovered_at, recovery_seconds, expired_at, voided_at, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,FALSE,NULL,NULL,NULL,NULL,NULL,$6,$6)
      ON CONFLICT (loss_event_id) DO NOTHING`,
      [input.id, input.roomId, input.lossEventId, input.lossType, input.lostAt, input.now],
    );
    if (inserted.rowCount) {
      await this.ensureHostStats(tx, input.hostUserId, input.now);
      await tx.query(`UPDATE host_stats SET lost_slots = lost_slots + 1, updated_at = $2 WHERE user_id = $1`, [input.hostUserId, input.now]);
    }
  }

  async recoverOldestSlotLoss(
    tx: Transaction,
    input: { roomId: string; replacementParticipantId: string; hostUserId: string; now: Date },
  ): Promise<SlotRecoveryRecord | null> {
    const selected = await tx.query<SlotRecoveryRow>(
      `SELECT * FROM slot_recovery_records
       WHERE room_id = $1 AND recovered = FALSE AND expired_at IS NULL AND voided_at IS NULL
       ORDER BY lost_at, id
       LIMIT 1 FOR UPDATE`,
      [input.roomId],
    );
    const record = selected.rows[0];
    if (!record) return null;
    const seconds = Math.max(0, Math.floor((input.now.getTime() - record.lost_at.getTime()) / 1000));
    const updated = await tx.query<SlotRecoveryRow>(
      `UPDATE slot_recovery_records
       SET recovered = TRUE, replacement_participant_id = $2, recovered_at = $3, recovery_seconds = $4, updated_at = $3
       WHERE id = $1 RETURNING *`,
      [record.id, input.replacementParticipantId, input.now, seconds],
    );
    await this.ensureHostStats(tx, input.hostUserId, input.now);
    await tx.query(`UPDATE host_stats SET recovered_slots = recovered_slots + 1, updated_at = $2 WHERE user_id = $1`, [input.hostUserId, input.now]);
    return slotRecoveryFrom(updated.rows[0]!);
  }

  async voidSlotLossForEvent(tx: Transaction, input: { lossEventId: string; hostUserId: string; now: Date }): Promise<boolean> {
    const result = await tx.query(
      `UPDATE slot_recovery_records SET voided_at = $2, updated_at = $2
       WHERE loss_event_id = $1 AND recovered = FALSE AND expired_at IS NULL AND voided_at IS NULL`,
      [input.lossEventId, input.now],
    );
    if (result.rowCount) {
      await this.ensureHostStats(tx, input.hostUserId, input.now);
      await tx.query(
        `UPDATE host_stats SET lost_slots = GREATEST(0, lost_slots - 1), updated_at = $2 WHERE user_id = $1`,
        [input.hostUserId, input.now],
      );
      return true;
    }
    return false;
  }

  async getRefillState(executor: SqlExecutor, roomId: string): Promise<RefillState | null> {
    const result = await executor.query<RefillStateRow>('SELECT * FROM room_refill_states WHERE room_id = $1', [roomId]);
    return result.rows[0] ? refillStateFrom(result.rows[0]) : null;
  }

  async setRefillState(
    tx: Transaction,
    input: { roomId: string; active: boolean; reason: string | null; now: Date; replacementWindowEndsAt: Date | null; lastLossEventId: string | null; disabledAt?: Date | null },
  ): Promise<RefillState> {
    const result = await tx.query<RefillStateRow>(
      `INSERT INTO room_refill_states (
        room_id, active, search_boost_active, reason, started_at, replacement_window_ends_at,
        disabled_at, last_loss_event_id, created_at, updated_at
      ) VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$4,$4)
      ON CONFLICT (room_id) DO UPDATE SET
        active = EXCLUDED.active,
        search_boost_active = EXCLUDED.search_boost_active,
        reason = EXCLUDED.reason,
        started_at = CASE WHEN EXCLUDED.active THEN EXCLUDED.started_at ELSE room_refill_states.started_at END,
        replacement_window_ends_at = EXCLUDED.replacement_window_ends_at,
        disabled_at = EXCLUDED.disabled_at,
        last_loss_event_id = EXCLUDED.last_loss_event_id,
        updated_at = EXCLUDED.updated_at
      RETURNING *`,
      [
        input.roomId, input.active, input.reason, input.now, input.replacementWindowEndsAt,
        input.disabledAt ?? null, input.lastLossEventId,
      ],
    );
    return refillStateFrom(result.rows[0]!);
  }

  async listDueRefillExpiryRoomIds(executor: SqlExecutor, now: Date, limit: number): Promise<string[]> {
    const result = await executor.query<{ room_id: string }>(
      `SELECT room_id FROM room_refill_states
       WHERE active = TRUE AND replacement_window_ends_at IS NOT NULL AND replacement_window_ends_at < $1
       ORDER BY replacement_window_ends_at, room_id LIMIT $2`,
      [now, limit],
    );
    return result.rows.map((row) => row.room_id);
  }

  async expirePendingSlotLosses(tx: Transaction, roomId: string, now: Date): Promise<number> {
    const result = await tx.query(
      `UPDATE slot_recovery_records SET expired_at = $2, updated_at = $2
       WHERE room_id = $1 AND recovered = FALSE AND expired_at IS NULL AND voided_at IS NULL`,
      [roomId, now],
    );
    return result.rowCount ?? 0;
  }

  async findMaterialChangeSinceAcceptance(executor: SqlExecutor, input: { roomId: string; acceptedAt: Date }): Promise<string | null> {
    const result = await executor.query<{ id: string }>(
      `SELECT id FROM room_change_logs
       WHERE room_id = $1 AND is_material_change = TRUE AND created_at >= $2
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [input.roomId, input.acceptedAt],
    );
    return result.rows[0]?.id ?? null;
  }

  async listOutstandingRecovery(executor: SqlExecutor, roomId: string): Promise<SlotRecoveryRecord[]> {
    const result = await executor.query<SlotRecoveryRow>(
      `SELECT * FROM slot_recovery_records WHERE room_id = $1 AND recovered = FALSE AND expired_at IS NULL ORDER BY lost_at, id`,
      [roomId],
    );
    return result.rows.map(slotRecoveryFrom);
  }
}
