import type { QueryResultRow } from 'pg';
import { newId } from '../../platform/core.js';
import type { SqlExecutor } from '../../platform/database/db.js';
import type { SearchCandidate, SearchLocationMode } from './domain.js';

interface CandidateRow extends QueryResultRow {
  room_id: string;
  sport_code: string;
  host_user_id: string;
  host_display_name: string;
  title: string | null;
  venue_name: string;
  venue_address: string | null;
  latitude: string | null;
  longitude: string | null;
  scheduled_start_at: Date;
  scheduled_end_at: Date;
  price_amount: number | null;
  participation_fee_per_person: number;
  currency: 'VND';
  preferred_skill_min: string | null;
  preferred_skill_max: string | null;
  available_public_slots: number;
  published_at: Date | null;
  distance_km: string | null;
  viewer_skill_state: SearchCandidate['viewerSkillState'];
  viewer_skill_score: string | null;
  is_urgent_refill: boolean;
  is_party_search: boolean;
  has_party_member_skill_mismatch: boolean;
  has_party_unranked_or_guest: boolean;
}

export type SearchTelemetryEventType =
  | 'SEARCH_STARTED'
  | 'SEARCH_RESULTS_RETURNED'
  | 'SEARCH_EMPTY'
  | 'SEARCH_RADIUS_EXPANDED'
  | 'ROOM_CARD_VIEWED'
  | 'ROOM_DETAIL_OPENED';

export interface CandidateQuery {
  actorUserId: string;
  sportCode: string;
  now: Date;
  timeStart: Date;
  timeEnd: Date;
  latitude?: number;
  longitude?: number;
  area?: string;
  radiusKm: number;
  limit: number;
  requiredSlots: number;
  registeredPartyMemberUserIds: string[];
  isPartySearch: boolean;
  partyHasGuest: boolean;
}

const numeric = (value: string | number | null): number | null => value === null ? null : Number(value);

const mapCandidate = (row: CandidateRow): SearchCandidate => ({
  roomId: row.room_id,
  sportCode: row.sport_code,
  hostUserId: row.host_user_id,
  hostDisplayName: row.host_display_name,
  title: row.title,
  venueName: row.venue_name,
  venueAddress: row.venue_address,
  latitude: numeric(row.latitude),
  longitude: numeric(row.longitude),
  scheduledStartAt: row.scheduled_start_at,
  scheduledEndAt: row.scheduled_end_at,
  priceAmount: row.price_amount,
  participationFeePerPerson: row.participation_fee_per_person,
  currency: row.currency,
  preferredSkillMin: numeric(row.preferred_skill_min),
  preferredSkillMax: numeric(row.preferred_skill_max),
  availablePublicSlots: row.available_public_slots,
  publishedAt: row.published_at,
  distanceKm: numeric(row.distance_km),
  viewerSkillState: row.viewer_skill_state,
  viewerSkillScore: numeric(row.viewer_skill_score),
  isUrgentRefill: row.is_urgent_refill,
  isPartySearch: row.is_party_search,
  hasPartyMemberSkillMismatch: row.has_party_member_skill_mismatch,
  hasPartyUnrankedOrGuest: row.has_party_unranked_or_guest,
});

/** Read-only candidate retrieval. Availability remains a derivative projection and joins are revalidated by M2 on request. */
export class SearchRepository {
  async listNormalCandidates(executor: SqlExecutor, input: CandidateQuery): Promise<SearchCandidate[]> {
    const values: unknown[] = [
      input.actorUserId,
      input.sportCode,
      input.now,
      input.timeStart,
      input.timeEnd,
      input.requiredSlots,
      input.registeredPartyMemberUserIds,
      input.partyHasGuest,
      input.isPartySearch,
    ];
    const add = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };

    let distanceSelect = 'NULL::double precision';
    let locationFilter = '';
    if (input.latitude !== undefined && input.longitude !== undefined) {
      const latitude = add(input.latitude);
      const longitude = add(input.longitude);
      const radius = add(input.radiusKm);
      const distanceExpression = `(
        6371.0088 * 2 * ASIN(SQRT(
          POWER(SIN(RADIANS((r.latitude::double precision - ${latitude}) / 2)), 2)
          + COS(RADIANS(${latitude})) * COS(RADIANS(r.latitude::double precision))
          * POWER(SIN(RADIANS((r.longitude::double precision - ${longitude}) / 2)), 2)
        ))
      )`;
      distanceSelect = distanceExpression;
      locationFilter = `
        AND r.latitude IS NOT NULL AND r.longitude IS NOT NULL
        AND ${distanceExpression} <= ${radius}`;
    } else if (input.area) {
      const area = add(`%${input.area.trim().toLowerCase()}%`);
      locationFilter = `
        AND LOWER(CONCAT_WS(' ', r.venue_name, r.venue_address)) LIKE ${area}`;
    }
    const limit = add(input.limit);

    const result = await executor.query<CandidateRow>(
      `SELECT
        r.id AS room_id,
        s.code AS sport_code,
        r.host_user_id,
        host.display_name AS host_display_name,
        r.title,
        r.venue_name,
        r.venue_address,
        r.latitude,
        r.longitude,
        r.scheduled_start_at,
        r.scheduled_end_at,
        r.price_amount,
        r.participation_fee_per_person,
        r.currency,
        r.preferred_skill_min,
        r.preferred_skill_max,
        availability.available_public_slots,
        r.published_at,
        ${distanceSelect} AS distance_km,
        viewer_profile.skill_state AS viewer_skill_state,
        viewer_profile.skill_score AS viewer_skill_score,
        COALESCE(refill.active AND (refill.replacement_window_ends_at IS NULL OR refill.replacement_window_ends_at > $3), false) AS is_urgent_refill,
        $9::boolean AS is_party_search,
        CASE WHEN NOT $9::boolean THEN false ELSE EXISTS (
          SELECT 1
          FROM unnest($7::uuid[]) AS party_member_user_id
          LEFT JOIN user_sport_profiles party_profile
            ON party_profile.user_id = party_member_user_id AND party_profile.sport_id = r.sport_id
          WHERE party_profile.skill_state = 'RANKED'
            AND ((r.preferred_skill_min IS NOT NULL AND party_profile.skill_score < r.preferred_skill_min)
              OR (r.preferred_skill_max IS NOT NULL AND party_profile.skill_score > r.preferred_skill_max))
        ) END AS has_party_member_skill_mismatch,
        CASE WHEN NOT $9::boolean THEN false ELSE ($8::boolean OR EXISTS (
          SELECT 1
          FROM unnest($7::uuid[]) AS party_member_user_id
          LEFT JOIN user_sport_profiles party_profile
            ON party_profile.user_id = party_member_user_id AND party_profile.sport_id = r.sport_id
          WHERE party_profile.skill_state IS DISTINCT FROM 'RANKED'
        )) END AS has_party_unranked_or_guest
      FROM rooms r
      JOIN sports s ON s.id = r.sport_id AND s.status = 'ACTIVE'
      JOIN users host ON host.id = r.host_user_id AND host.status = 'ACTIVE'
      JOIN room_availability_projections availability ON availability.room_id = r.id
      LEFT JOIN room_refill_states refill ON refill.room_id = r.id
      LEFT JOIN user_sport_profiles viewer_profile
        ON viewer_profile.user_id = $1 AND viewer_profile.sport_id = r.sport_id
      WHERE s.code = $2
        AND r.status = 'OPEN'
        AND r.scheduled_end_at > $3
        AND r.scheduled_start_at < $5
        AND r.scheduled_end_at > $4
        AND availability.available_public_slots >= $6
        AND NOT EXISTS (
          SELECT 1
          FROM room_participants participant
          JOIN rooms accepted_room ON accepted_room.id = participant.room_id
          WHERE participant.user_id = ANY($7::uuid[])
            AND participant.status = 'ACTIVE'
            AND accepted_room.status IN ('OPEN', 'FULL', 'IN_PROGRESS')
            AND accepted_room.id <> r.id
            AND accepted_room.scheduled_start_at < r.scheduled_end_at
            AND accepted_room.scheduled_end_at > r.scheduled_start_at
        )
        ${locationFilter}
      ORDER BY r.scheduled_start_at, r.published_at, r.id
      LIMIT ${limit}`,
      values,
    );
    return result.rows.map(mapCandidate);
  }

  async appendTelemetry(
    executor: SqlExecutor,
    input: { actorUserId: string; roomId?: string; eventType: SearchTelemetryEventType; occurredAt: Date; metadata: Record<string, unknown> },
  ): Promise<void> {
    await executor.query(
      `INSERT INTO search_telemetry_events (
        id, actor_user_id, room_id, event_type, occurred_at, metadata_json
      ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [newId(), input.actorUserId, input.roomId ?? null, input.eventType, input.occurredAt, JSON.stringify(input.metadata)],
    );
  }

  async countTelemetry(executor: SqlExecutor, eventType: SearchTelemetryEventType): Promise<number> {
    const result = await executor.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM search_telemetry_events WHERE event_type = $1', [eventType],
    );
    return Number(result.rows[0]?.count ?? 0);
  }
}

export const resolveLocationMode = (latitude: number | undefined, longitude: number | undefined, area: string | undefined): SearchLocationMode => {
  if (latitude !== undefined && longitude !== undefined) return 'COORDINATES';
  if (area) return 'AREA';
  return 'UNSPECIFIED';
};
