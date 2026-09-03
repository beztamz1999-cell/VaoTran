import { DomainError, logger, newId, systemClock, type Clock } from '../../platform/core.js';
import type { PostgresDatabase } from '../../platform/database/db.js';
import { appendOutboxEvent, makeDomainEvent } from '../../platform/outbox/outbox.js';
import { coarseAreaBucket, coarseGeoBucket, safeAnalyticsHour } from '../../platform/analytics/privacy.js';
import { metrics } from '../../platform/observability/metrics.js';
import type { IdentityService } from '../identity/service.js';
import { assertPartyOwner, assertPartyReady } from '../party/domain.js';
import { PartyRepository } from '../party/repository.js';
import { searchRankingConfig, type SearchRankingConfig } from './config.js';
import { cardFrom, scoreCandidate, stableSort, type SearchInput, type SearchLocationMode, type SearchResultCard } from './domain.js';
import { SearchRepository, resolveLocationMode, type SearchTelemetryEventType } from './repository.js';

export interface SearchResponse {
  data: SearchResultCard[];
  meta: {
    radiusKm: number;
    radiusExpanded: boolean;
    radiusStepsConsidered: number[];
    resultCount: number;
    locationMode: SearchLocationMode;
    rankingConfigVersion: string;
  };
}

const endOfUtcDay = (date: Date): Date => {
  const end = new Date(date);
  end.setUTCHours(23, 59, 59, 999);
  return end;
};

const uniqueOrdered = (values: number[]): number[] => [...new Set(values)].sort((a, b) => a - b);

export class SearchService {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly repository: SearchRepository,
    private readonly identity: IdentityService,
    private readonly clock: Clock = systemClock,
    private readonly config: SearchRankingConfig = searchRankingConfig,
    private readonly partyRepository: PartyRepository | null = null,
  ) {}

  async search(input: SearchInput): Promise<SearchResponse> {
    const startedAt = performance.now();
    if (!input.sportCode.trim()) throw new DomainError('VALIDATION_ERROR', 'sport is required.');
    if ((input.latitude === undefined) !== (input.longitude === undefined)) {
      throw new DomainError('VALIDATION_ERROR', 'lat and lng must be provided together.');
    }
    if (input.latitude !== undefined && (input.latitude < -90 || input.latitude > 90 || input.longitude! < -180 || input.longitude! > 180)) {
      throw new DomainError('VALIDATION_ERROR', 'Search coordinates are invalid.');
    }

    const partyContext = await this.resolvePartyContext(input);
    const now = this.clock.now();
    const timeStart = input.timeStart && input.timeStart > now ? input.timeStart : now;
    const timeEnd = input.timeEnd ?? endOfUtcDay(now);
    if (timeEnd <= timeStart) throw new DomainError('INVALID_TIME_WINDOW', 'time_end must be after time_start.');

    const me = await this.identity.getMe(input.actorUserId);
    const area = input.area?.trim() || me.homeArea?.trim() || undefined;
    const locationMode = resolveLocationMode(input.latitude, input.longitude, area);
    const initialRadiusKm = Math.max(input.initialRadiusKm ?? this.config.defaultRadiusKm, this.config.defaultRadiusKm);
    const radiusSteps = uniqueOrdered([initialRadiusKm, ...this.config.expandedRadiusKm.filter((radius) => radius > initialRadiusKm)]);

    await this.telemetry(input.actorUserId, 'SEARCH_STARTED', {
      sport: input.sportCode,
      required_slots: partyContext.requiredSlots,
      party_id: input.partyId ?? null,
      initial_radius_km: initialRadiusKm,
      location_mode: locationMode,
    }, now);

    let selected = [] as Awaited<ReturnType<SearchRepository['listNormalCandidates']>>;
    const considered: number[] = [];
    for (const radiusKm of radiusSteps) {
      considered.push(radiusKm);
      selected = await this.repository.listNormalCandidates(this.db, {
        actorUserId: input.actorUserId,
        sportCode: input.sportCode,
        now,
        timeStart,
        timeEnd,
        latitude: input.latitude,
        longitude: input.longitude,
        area,
        radiusKm,
        limit: this.config.maxResults,
        requiredSlots: partyContext.requiredSlots,
        registeredPartyMemberUserIds: partyContext.registeredUserIds,
        isPartySearch: Boolean(input.partyId),
        partyHasGuest: partyContext.partyHasGuest,
      });
      if (selected.length >= this.config.minResultsBeforeExpand || radiusKm === radiusSteps[radiusSteps.length - 1]) break;
      await this.telemetry(input.actorUserId, 'SEARCH_RADIUS_EXPANDED', {
        sport: input.sportCode,
        required_slots: partyContext.requiredSlots,
        party_id: input.partyId ?? null,
        from_radius_km: radiusKm,
        to_radius_km: radiusSteps[considered.length],
        results_count: selected.length,
      }, now);
    }

    const sorted = stableSort(selected.map((candidate) => scoreCandidate(candidate, now, this.config, partyContext.requiredSlots)));
    const data = sorted.map((candidate) => cardFrom(candidate, partyContext.requiredSlots));
    const finalRadiusKm = considered[considered.length - 1] ?? initialRadiusKm;
    const resultEvent: SearchTelemetryEventType = data.length ? 'SEARCH_RESULTS_RETURNED' : 'SEARCH_EMPTY';
    await this.telemetry(input.actorUserId, resultEvent, {
      sport: input.sportCode,
      required_slots: partyContext.requiredSlots,
      party_id: input.partyId ?? null,
      radius_km: finalRadiusKm,
      results_count: data.length,
      top_result_distance_km: data[0]?.distanceKm ?? null,
      top_result_skill_fit: data[0]?.skillFit ?? null,
      location_mode: locationMode,
    }, now);
    void this.appendAnalyticsEvent('SEARCH_EXECUTED', input.actorUserId, null, {
      sport_code: input.sportCode,
      area_bucket: input.latitude === undefined ? coarseAreaBucket(area) : coarseGeoBucket(input.latitude, input.longitude),
      scheduled_hour_utc: safeAnalyticsHour(timeStart), result_count: data.length,
    }, now);
    metrics.observe('vaotran_search_latency_ms', performance.now() - startedAt, { location_mode: locationMode, party_search: Boolean(input.partyId) });
    metrics.increment('vaotran_search_requests_total', { result: data.length ? 'nonzero' : 'zero', location_mode: locationMode, party_search: Boolean(input.partyId) });

    return {
      data,
      meta: {
        radiusKm: finalRadiusKm,
        radiusExpanded: considered.length > 1,
        radiusStepsConsidered: considered,
        resultCount: data.length,
        locationMode,
        rankingConfigVersion: this.config.version,
      },
    };
  }

  async recordRoomCardViewed(actorUserId: string, roomId: string): Promise<void> {
    const now = this.clock.now();
    await this.telemetry(actorUserId, 'ROOM_CARD_VIEWED', {}, now, roomId);
    void this.appendAnalyticsEvent('ROOM_CARD_VIEWED', actorUserId, roomId, {}, now);
  }

  async recordRoomDetailOpened(actorUserId: string, roomId: string): Promise<void> {
    const now = this.clock.now();
    await this.telemetry(actorUserId, 'ROOM_DETAIL_OPENED', {}, now, roomId);
    void this.appendAnalyticsEvent('ROOM_DETAIL_VIEWED', actorUserId, roomId, {}, now);
  }

  private async resolvePartyContext(input: SearchInput): Promise<{ requiredSlots: number; registeredUserIds: string[]; partyHasGuest: boolean }> {
    if (!input.partyId) return { requiredSlots: 1, registeredUserIds: [input.actorUserId], partyHasGuest: false };
    if (!this.partyRepository) throw new Error('Party module is not configured.');
    const party = await this.partyRepository.findParty(this.db, input.partyId);
    if (!party) throw new DomainError('PARTY_NOT_FOUND', 'Party was not found.');
    assertPartyOwner(party, input.actorUserId);
    assertPartyReady(party);
    const sport = await this.partyRepository.findSportByCode(this.db, input.sportCode);
    if (!sport || sport.id !== party.sportId) {
      throw new DomainError('PARTY_SPORT_MISMATCH', 'Party sport must match the search sport.', { party_id: party.id, sport: input.sportCode });
    }
    const members = await this.partyRepository.listPartyMembers(this.db, party.id);
    return {
      requiredSlots: members.length,
      registeredUserIds: members.flatMap((member) => member.userId ? [member.userId] : []),
      partyHasGuest: members.some((member) => member.memberType === 'GUEST'),
    };
  }

  private async appendAnalyticsEvent(
    eventType: 'SEARCH_EXECUTED' | 'ROOM_CARD_VIEWED' | 'ROOM_DETAIL_VIEWED',
    actorUserId: string,
    roomId: string | null,
    payload: Record<string, unknown>,
    occurredAt: Date,
  ): Promise<void> {
    try {
      await this.db.transaction(async (tx) => appendOutboxEvent(tx, makeDomainEvent({
        eventType, aggregateType: roomId ? 'ROOM' : 'SEARCH', aggregateId: roomId ?? newId(), actorUserId: null,
        correlationId: null, causationId: null, schemaVersion: 1, payload: roomId ? { ...payload, room_id: roomId, user_id: actorUserId } : { ...payload, user_id: actorUserId },
        occurredAt,
      })));
    } catch (error) {
      logger.warn({ component: 'analytics', event_type: eventType, err: error }, 'Best-effort search analytics capture failed');
    }
  }

  private async telemetry(
    actorUserId: string,
    eventType: SearchTelemetryEventType,
    metadata: Record<string, unknown>,
    occurredAt: Date,
    roomId?: string,
  ): Promise<void> {
    await this.repository.appendTelemetry(this.db, { actorUserId, roomId, eventType, occurredAt, metadata });
  }
}
