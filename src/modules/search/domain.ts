import type { SearchRankingConfig } from './config.js';

export type SearchSkillFit = 'WITHIN_RANGE' | 'BELOW_RANGE' | 'ABOVE_RANGE' | 'UNRANKED';
export type SearchBadge =
  | 'NEARBY'
  | 'SKILL_WITHIN_RANGE'
  | 'SKILL_BELOW_RANGE'
  | 'SKILL_ABOVE_RANGE'
  | 'UNRANKED_PLAYER'
  | 'URGENT_REFILL'
  | 'PARTY_EXACT_CAPACITY'
  | 'PARTY_ENOUGH_SLOTS'
  | 'PARTY_MEMBER_SKILL_MISMATCH'
  | 'PARTY_HAS_UNRANKED_OR_GUEST';
export type SearchLocationMode = 'COORDINATES' | 'AREA' | 'UNSPECIFIED';

export interface SearchInput {
  actorUserId: string;
  sportCode: string;
  latitude?: number;
  longitude?: number;
  area?: string;
  timeStart?: Date;
  timeEnd?: Date;
  initialRadiusKm?: number;
  partyId?: string;
}

export interface SearchCandidate {
  roomId: string;
  sportCode: string;
  hostUserId: string;
  hostDisplayName: string;
  title: string | null;
  venueName: string;
  venueAddress: string | null;
  latitude: number | null;
  longitude: number | null;
  scheduledStartAt: Date;
  scheduledEndAt: Date;
  priceAmount: number | null;
  currency: 'VND';
  preferredSkillMin: number | null;
  preferredSkillMax: number | null;
  availablePublicSlots: number;
  publishedAt: Date | null;
  distanceKm: number | null;
  viewerSkillState: 'UNRANKED' | 'CALIBRATING' | 'RANKED' | 'TOP_TIER_LOCKED' | null;
  viewerSkillScore: number | null;
  isUrgentRefill: boolean;
  isPartySearch: boolean;
  hasPartyMemberSkillMismatch: boolean;
  hasPartyUnrankedOrGuest: boolean;
}

export interface SearchResultCard {
  roomId: string;
  sportCode: string;
  title: string | null;
  venueName: string;
  venueAddress: string | null;
  distanceKm: number | null;
  availablePublicSlots: number;
  requiredSlots: number;
  skillFit: SearchSkillFit;
  badges: SearchBadge[];
  host: { id: string; displayName: string };
  startAt: Date;
  endAt: Date;
  priceAmount: number | null;
  currency: 'VND';
}

export interface ScoredSearchCandidate {
  readonly candidate: SearchCandidate;
  readonly score: number;
  readonly skillFit: SearchSkillFit;
  readonly badges: SearchBadge[];
}

const scale = (weight: number, fraction: number): number => weight * fraction;

export const classifySkillFit = (candidate: SearchCandidate): SearchSkillFit => {
  const { viewerSkillState, viewerSkillScore, preferredSkillMin, preferredSkillMax } = candidate;
  if (viewerSkillState !== 'RANKED' || viewerSkillScore === null) return 'UNRANKED';
  if (preferredSkillMin === null || preferredSkillMax === null) return 'WITHIN_RANGE';
  if (viewerSkillScore < preferredSkillMin) return 'BELOW_RANGE';
  if (viewerSkillScore > preferredSkillMax) return 'ABOVE_RANGE';
  return 'WITHIN_RANGE';
};

const proximityScore = (distanceKm: number | null, weight: number): number => {
  if (distanceKm === null) return 0;
  if (distanceKm <= 1) return weight;
  if (distanceKm <= 3) return scale(weight, 0.88);
  if (distanceKm <= 5) return scale(weight, 0.72);
  if (distanceKm <= 10) return scale(weight, 0.48);
  if (distanceKm <= 20) return scale(weight, 0.2);
  return 0;
};

const timeScore = (startAt: Date, now: Date, weight: number): number => {
  const hours = Math.max(0, (startAt.getTime() - now.getTime()) / 3_600_000);
  if (hours <= 2) return weight;
  if (hours <= 6) return scale(weight, 0.9);
  if (hours <= 12) return scale(weight, 0.7);
  if (hours <= 24) return scale(weight, 0.5);
  if (hours <= 72) return scale(weight, 0.25);
  return scale(weight, 0.1);
};

const capacityScore = (availableSlots: number, weight: number): number => {
  if (availableSlots === 1) return weight;
  if (availableSlots <= 3) return scale(weight, 13 / 15);
  if (availableSlots <= 5) return scale(weight, 12 / 15);
  return scale(weight, 10 / 15);
};

const skillScore = (candidate: SearchCandidate, skillFit: SearchSkillFit, weight: number): number => {
  if (skillFit === 'WITHIN_RANGE') return weight;
  if (skillFit === 'UNRANKED') return scale(weight, 9 / 15);
  const boundary = skillFit === 'BELOW_RANGE' ? candidate.preferredSkillMin : candidate.preferredSkillMax;
  const delta = boundary === null || candidate.viewerSkillScore === null ? Number.POSITIVE_INFINITY : Math.abs(boundary - candidate.viewerSkillScore);
  return delta <= 1.5 ? scale(weight, 11 / 15) : scale(weight, 6 / 15);
};

export const badgesFor = (candidate: SearchCandidate, skillFit: SearchSkillFit, requiredSlots: number): SearchBadge[] => {
  const badges: SearchBadge[] = [];
  if (candidate.distanceKm !== null && candidate.distanceKm <= 3) badges.push('NEARBY');
  if (skillFit === 'WITHIN_RANGE') badges.push('SKILL_WITHIN_RANGE');
  if (skillFit === 'BELOW_RANGE') badges.push('SKILL_BELOW_RANGE');
  if (skillFit === 'ABOVE_RANGE') badges.push('SKILL_ABOVE_RANGE');
  if (skillFit === 'UNRANKED') badges.push('UNRANKED_PLAYER');
  if (candidate.isUrgentRefill) badges.push('URGENT_REFILL');
  if (candidate.isPartySearch) {
    if (candidate.availablePublicSlots === requiredSlots) badges.push('PARTY_EXACT_CAPACITY');
    else if (candidate.availablePublicSlots > requiredSlots) badges.push('PARTY_ENOUGH_SLOTS');
    if (candidate.hasPartyMemberSkillMismatch) badges.push('PARTY_MEMBER_SKILL_MISMATCH');
    if (candidate.hasPartyUnrankedOrGuest) badges.push('PARTY_HAS_UNRANKED_OR_GUEST');
  }
  return badges;
};

export const scoreCandidate = (candidate: SearchCandidate, now: Date, config: SearchRankingConfig, requiredSlots = 1): ScoredSearchCandidate => {
  const skillFit = classifySkillFit(candidate);
  const score =
    proximityScore(candidate.distanceKm, config.weights.proximity) +
    timeScore(candidate.scheduledStartAt, now, config.weights.time) +
    capacityScore(candidate.availablePublicSlots, config.weights.capacity) +
    skillScore(candidate, skillFit, config.weights.skill) +
    (candidate.isUrgentRefill ? config.weights.urgency : 0);
  // Relationship and reliability remain neutral until their later matching policies own canonical inputs.
  return { candidate, score, skillFit, badges: badgesFor(candidate, skillFit, requiredSlots) };
};

export const stableSort = (candidates: ScoredSearchCandidate[]): ScoredSearchCandidate[] => [...candidates].sort((a, b) => {
  if (b.score !== a.score) return b.score - a.score;
  const startDifference = a.candidate.scheduledStartAt.getTime() - b.candidate.scheduledStartAt.getTime();
  if (startDifference !== 0) return startDifference;
  const aDistance = a.candidate.distanceKm ?? Number.POSITIVE_INFINITY;
  const bDistance = b.candidate.distanceKm ?? Number.POSITIVE_INFINITY;
  if (aDistance !== bDistance) return aDistance - bDistance;
  const aPublished = a.candidate.publishedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const bPublished = b.candidate.publishedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (aPublished !== bPublished) return aPublished - bPublished;
  return a.candidate.roomId.localeCompare(b.candidate.roomId);
});

export const cardFrom = (scored: ScoredSearchCandidate, requiredSlots = 1): SearchResultCard => ({
  roomId: scored.candidate.roomId,
  sportCode: scored.candidate.sportCode,
  title: scored.candidate.title,
  venueName: scored.candidate.venueName,
  venueAddress: scored.candidate.venueAddress,
  distanceKm: scored.candidate.distanceKm === null ? null : Number(scored.candidate.distanceKm.toFixed(2)),
  availablePublicSlots: scored.candidate.availablePublicSlots,
  requiredSlots,
  skillFit: scored.skillFit,
  badges: scored.badges,
  host: { id: scored.candidate.hostUserId, displayName: scored.candidate.hostDisplayName },
  startAt: scored.candidate.scheduledStartAt,
  endAt: scored.candidate.scheduledEndAt,
  priceAmount: scored.candidate.priceAmount,
  currency: scored.candidate.currency,
});
