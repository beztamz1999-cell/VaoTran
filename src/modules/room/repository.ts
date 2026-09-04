import type { QueryResultRow } from 'pg';
import type { SqlExecutor, Transaction } from '../../platform/database/db.js';
import { newId, type Clock } from '../../platform/core.js';
import type { Room, RoomAvailability, RoomEquipmentOption, RoomEquipmentPolicy } from './domain.js';

interface RoomRow extends QueryResultRow {
  id: string;
  sport_id: string;
  sport_code: string;
  host_user_id: string;
  title: string | null;
  venue_name: string;
  venue_address: string | null;
  latitude: string | null;
  longitude: string | null;
  scheduled_start_at: Date;
  scheduled_end_at: Date;
  capacity: number;
  host_participates: boolean;
  reserved_external_count: number;
  price_amount: number | null;
  participation_fee_per_person: number;
  currency: 'VND';
  preferred_skill_min: string | null;
  preferred_skill_max: string | null;
  allow_emergency_replacement: boolean;
  status: Room['status'];
  public_share_token: string | null;
  published_at: Date | null;
  cancelled_at: Date | null;
  actual_started_at: Date | null;
  start_source: 'MANUAL' | 'AUTO' | null;
  completed_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  supply_mode: RoomEquipmentPolicy['supplyMode'];
  quantity_per_participant: number | null;
  equipment_notes: string | null;
}

interface EquipmentOptionRow extends QueryResultRow {
  id: string;
  equipment_type: string;
  brand: string | null;
  model: string | null;
  display_name: string;
  sort_order: number;
}

export interface RoomChangeLog {
  id: string;
  roomId: string;
  changedByUserId: string;
  fieldName: string;
  oldValue: unknown;
  newValue: unknown;
  isMaterialChange: boolean;
  createdAt: Date;
}

const num = (value: string | number | null): number | null => value === null ? null : Number(value);

const mapEquipmentOption = (row: EquipmentOptionRow): RoomEquipmentOption => ({
  id: row.id,
  equipmentType: row.equipment_type,
  brand: row.brand,
  model: row.model,
  displayName: row.display_name,
  sortOrder: row.sort_order,
});

export class RoomRepository {
  async findSportIdByCode(executor: SqlExecutor, sportCode: string): Promise<string | null> {
    const result = await executor.query<{ id: string }>(
      "SELECT id FROM sports WHERE code = $1 AND status = 'ACTIVE'",
      [sportCode],
    );
    return result.rows[0]?.id ?? null;
  }

  async findById(executor: SqlExecutor, roomId: string, forUpdate = false): Promise<Room | null> {
    const result = await executor.query<RoomRow>(
      `SELECT r.*, s.code AS sport_code,
              p.supply_mode, p.quantity_per_participant, p.notes AS equipment_notes
       FROM rooms r
       JOIN sports s ON s.id = r.sport_id
       JOIN room_equipment_policies p ON p.room_id = r.id
       WHERE r.id = $1${forUpdate ? ' FOR UPDATE OF r' : ''}`,
      [roomId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const optionResult = await executor.query<EquipmentOptionRow>(
      `SELECT id, equipment_type, brand, model, display_name, sort_order
       FROM room_equipment_options
       WHERE room_id = $1
       ORDER BY sort_order, created_at`,
      [roomId],
    );
    return {
      id: row.id,
      sportId: row.sport_id,
      sportCode: row.sport_code,
      hostUserId: row.host_user_id,
      title: row.title,
      venueName: row.venue_name,
      venueAddress: row.venue_address,
      latitude: num(row.latitude),
      longitude: num(row.longitude),
      scheduledStartAt: row.scheduled_start_at,
      scheduledEndAt: row.scheduled_end_at,
      capacity: row.capacity,
      hostParticipates: row.host_participates,
      reservedExternalCount: row.reserved_external_count,
      priceAmount: row.price_amount,
      participationFeePerPerson: row.participation_fee_per_person,
      currency: row.currency,
      preferredSkillMin: num(row.preferred_skill_min),
      preferredSkillMax: num(row.preferred_skill_max),
      allowEmergencyReplacement: row.allow_emergency_replacement,
      status: row.status,
      publicShareToken: row.public_share_token,
      publishedAt: row.published_at,
      cancelledAt: row.cancelled_at,
      actualStartedAt: row.actual_started_at,
      startSource: row.start_source,
      completedAt: row.completed_at,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      equipment: {
        supplyMode: row.supply_mode,
        quantityPerParticipant: row.quantity_per_participant,
        notes: row.equipment_notes,
        allowedOptions: optionResult.rows.map(mapEquipmentOption),
      },
    };
  }

  async findByPublicShareToken(executor: SqlExecutor, shareToken: string): Promise<Room | null> {
    const result = await executor.query<{ id: string }>(
      `SELECT id FROM rooms
       WHERE public_share_token = $1 AND published_at IS NOT NULL`,
      [shareToken],
    );
    const roomId = result.rows[0]?.id;
    return roomId ? this.findById(executor, roomId) : null;
  }

  async listDueAutoStartRoomIds(executor: SqlExecutor, now: Date, limit: number): Promise<string[]> {
    const result = await executor.query<{ id: string }>(
      `SELECT id FROM rooms
       WHERE status IN ('OPEN', 'FULL') AND scheduled_start_at <= $1
       ORDER BY scheduled_start_at, id
       LIMIT $2`,
      [now, limit],
    );
    return result.rows.map((row) => row.id);
  }

  async insert(tx: Transaction, room: Room): Promise<void> {
    await tx.query(
      `INSERT INTO rooms (
        id, sport_id, host_user_id, title, venue_name, venue_address, latitude, longitude,
        scheduled_start_at, scheduled_end_at, capacity, host_participates, reserved_external_count,
        price_amount, participation_fee_per_person, currency, preferred_skill_min, preferred_skill_max, allow_emergency_replacement,
        status, public_share_token, published_at, cancelled_at, actual_started_at, start_source, completed_at, version, created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29
      )`,
      [
        room.id, room.sportId, room.hostUserId, room.title, room.venueName, room.venueAddress,
        room.latitude, room.longitude, room.scheduledStartAt, room.scheduledEndAt, room.capacity,
        room.hostParticipates, room.reservedExternalCount, room.priceAmount, room.participationFeePerPerson, room.currency,
        room.preferredSkillMin, room.preferredSkillMax, room.allowEmergencyReplacement, room.status,
        room.publicShareToken, room.publishedAt, room.cancelledAt, room.actualStartedAt, room.startSource, room.completedAt,
        room.version, room.createdAt, room.updatedAt,
      ],
    );
    await this.replaceEquipment(tx, room.id, room.equipment, room.createdAt);
  }

  async update(tx: Transaction, room: Room, equipmentChanged: boolean): Promise<void> {
    await tx.query(
      `UPDATE rooms SET
        title=$2, venue_name=$3, venue_address=$4, latitude=$5, longitude=$6,
        scheduled_start_at=$7, scheduled_end_at=$8, capacity=$9, host_participates=$10,
        reserved_external_count=$11, price_amount=$12, participation_fee_per_person=$13, currency=$14, preferred_skill_min=$15,
        preferred_skill_max=$16, allow_emergency_replacement=$17, status=$18, public_share_token=$19, published_at=$20,
        cancelled_at=$21, actual_started_at=$22, start_source=$23, completed_at=$24, version=$25, updated_at=$26
       WHERE id=$1`,
      [
        room.id, room.title, room.venueName, room.venueAddress, room.latitude, room.longitude,
        room.scheduledStartAt, room.scheduledEndAt, room.capacity, room.hostParticipates,
        room.reservedExternalCount, room.priceAmount, room.participationFeePerPerson, room.currency, room.preferredSkillMin,
        room.preferredSkillMax, room.allowEmergencyReplacement, room.status, room.publicShareToken, room.publishedAt,
        room.cancelledAt, room.actualStartedAt, room.startSource, room.completedAt, room.version, room.updatedAt,
      ],
    );
    if (equipmentChanged) await this.replaceEquipment(tx, room.id, room.equipment, room.updatedAt);
  }

  async replaceEquipment(tx: Transaction, roomId: string, equipment: RoomEquipmentPolicy, at: Date): Promise<void> {
    await tx.query(
      `INSERT INTO room_equipment_policies (room_id, supply_mode, quantity_per_participant, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (room_id) DO UPDATE SET
         supply_mode = EXCLUDED.supply_mode,
         quantity_per_participant = EXCLUDED.quantity_per_participant,
         notes = EXCLUDED.notes,
         updated_at = EXCLUDED.updated_at`,
      [roomId, equipment.supplyMode, equipment.quantityPerParticipant, equipment.notes, at],
    );
    await tx.query('DELETE FROM room_equipment_options WHERE room_id = $1', [roomId]);
    for (const option of equipment.allowedOptions) {
      await tx.query(
        `INSERT INTO room_equipment_options (
          id, room_id, equipment_type, brand, model, display_name, sort_order, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [option.id || newId(), roomId, option.equipmentType, option.brand, option.model, option.displayName, option.sortOrder, at],
      );
    }
  }

  async upsertAvailability(tx: Transaction, roomId: string, availability: RoomAvailability, at: Date): Promise<void> {
    await tx.query(
      `INSERT INTO room_availability_projections (
        room_id, host_slot, reserved_external_count, active_app_count, effective_no_show_count,
        occupied_slots, available_public_slots, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (room_id) DO UPDATE SET
        host_slot=EXCLUDED.host_slot,
        reserved_external_count=EXCLUDED.reserved_external_count,
        active_app_count=EXCLUDED.active_app_count,
        effective_no_show_count=EXCLUDED.effective_no_show_count,
        occupied_slots=EXCLUDED.occupied_slots,
        available_public_slots=EXCLUDED.available_public_slots,
        updated_at=EXCLUDED.updated_at`,
      [
        roomId, availability.hostSlot, availability.reservedExternalCount,
        availability.activeAcceptedAppParticipants, availability.effectiveNoShowCount,
        availability.occupiedSlots, availability.availablePublicSlots, at,
      ],
    );
  }

  async addChangeLogs(tx: Transaction, changes: RoomChangeLog[]): Promise<void> {
    for (const change of changes) {
      await tx.query(
        `INSERT INTO room_change_logs (
          id, room_id, changed_by_user_id, field_name, old_value_json, new_value_json, is_material_change, created_at
        ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8)`,
        [
          change.id, change.roomId, change.changedByUserId, change.fieldName,
          JSON.stringify(change.oldValue), JSON.stringify(change.newValue), change.isMaterialChange, change.createdAt,
        ],
      );
    }
  }

  makeChangeLogs(roomId: string, actorId: string, previous: Room, next: Room, clock: Clock): RoomChangeLog[] {
    const fields: Array<keyof Room> = [
      'title', 'venueName', 'venueAddress', 'latitude', 'longitude', 'scheduledStartAt', 'scheduledEndAt',
      'capacity', 'hostParticipates', 'reservedExternalCount', 'priceAmount', 'participationFeePerPerson', 'currency', 'preferredSkillMin',
      'preferredSkillMax', 'allowEmergencyReplacement', 'equipment',
    ];
    return fields.flatMap((fieldName) => {
      const oldValue = previous[fieldName];
      const newValue = next[fieldName];
      const same = JSON.stringify(oldValue) === JSON.stringify(newValue);
      if (same) return [];
      const material = ['scheduledStartAt', 'scheduledEndAt', 'venueName', 'venueAddress', 'latitude', 'longitude', 'priceAmount', 'participationFeePerPerson', 'currency', 'equipment'].includes(fieldName);
      return [{
        id: newId(), roomId, changedByUserId: actorId, fieldName, oldValue, newValue,
        isMaterialChange: material, createdAt: clock.now(),
      }];
    });
  }
}
