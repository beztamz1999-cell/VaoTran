import { domainError } from '../../platform/core.js';

export type SkillState = 'UNRANKED' | 'CALIBRATING' | 'RANKED' | 'TOP_TIER_LOCKED';
export type ConfidenceLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export type EligibilityReason =
  | 'ELIGIBLE_RANK_ADVANTAGE'
  | 'ELIGIBLE_CALIBRATION_HOST_SCORE'
  | 'INELIGIBLE_HOST_UNRANKED'
  | 'INELIGIBLE_HOST_NOT_HIGHER_TIER'
  | 'INELIGIBLE_HOST_SCORE_TOO_LOW'
  | 'INELIGIBLE_PLAYER_NOT_PRESENT'
  | 'INELIGIBLE_SELF_RATING'
  | 'INELIGIBLE_WRONG_SPORT'
  | 'INELIGIBLE_DUPLICATE_ROOM_RATING'
  | 'INELIGIBLE_TOP_TIER_LOCKED';

export interface SkillProfile {
  userId: string;
  sportId: string;
  skillState: SkillState;
  skillScore: number | null;
  rankTier: number | null;
  validRatingCount: number;
  completedMatchCount: number;
  uniqueValidRaterCount: number;
  confidenceLevel: ConfidenceLevel | null;
  lastValidRatingAt: Date | null;
  lastRankChangeAt: Date | null;
  lastRankChangeRatingCount: number;
}

export interface TierBoundary {
  tier: number;
  minScore: number;
}

export interface RecencyWeights {
  newest1To5: number;
  next6To10: number;
  oldest11To20: number;
}

export interface ConfidenceThresholds {
  medium: { minValidRatings: number; minUniqueRaters: number };
  high: { minValidRatings: number; minUniqueRaters: number };
}

export interface RankingRuleConfig {
  id: string;
  sportId: string;
  version: string;
  calibrationRequiredRatings: number;
  calibrationHostMinScore: number;
  rollingWindowSize: number;
  tierBoundaries: TierBoundary[];
  recencyWeights: RecencyWeights;
  confidenceThresholds: ConfidenceThresholds;
  promotionBuffer: number;
  demotionBuffer: number;
  outlierCap: number;
  minRatingsSinceTierChange: number;
}

export interface EligibilityInput {
  hostProfile: SkillProfile | null;
  playerProfile: SkillProfile | null;
  hostUserId: string;
  playerUserId: string;
  sportId: string;
  playerPresent: boolean;
  alreadyRated: boolean;
  config: RankingRuleConfig;
}

export interface EligibilityResult {
  eligible: boolean;
  reason: EligibilityReason;
}

export interface StoredRating {
  id: string;
  ratingValue: number;
  effectiveRatingValue: number | null;
  raterHostUserId: string;
  createdAt: Date;
}

export const evaluateRatingEligibility = (input: EligibilityInput): EligibilityResult => {
  if (input.hostUserId === input.playerUserId) {
    return { eligible: false, reason: 'INELIGIBLE_SELF_RATING' };
  }
  if (!input.playerPresent) {
    return { eligible: false, reason: 'INELIGIBLE_PLAYER_NOT_PRESENT' };
  }
  if (input.alreadyRated) {
    return { eligible: false, reason: 'INELIGIBLE_DUPLICATE_ROOM_RATING' };
  }
  if (!input.hostProfile || !input.playerProfile || input.hostProfile.sportId !== input.sportId || input.playerProfile.sportId !== input.sportId) {
    return { eligible: false, reason: 'INELIGIBLE_WRONG_SPORT' };
  }
  if (input.playerProfile.skillState === 'TOP_TIER_LOCKED') {
    return { eligible: false, reason: 'INELIGIBLE_TOP_TIER_LOCKED' };
  }
  if (input.hostProfile.skillState !== 'RANKED' && input.hostProfile.skillState !== 'TOP_TIER_LOCKED') {
    return { eligible: false, reason: 'INELIGIBLE_HOST_UNRANKED' };
  }
  if (input.playerProfile.skillState === 'UNRANKED' || input.playerProfile.skillState === 'CALIBRATING') {
    if ((input.hostProfile.skillScore ?? 0) > input.config.calibrationHostMinScore) {
      return { eligible: true, reason: 'ELIGIBLE_CALIBRATION_HOST_SCORE' };
    }
    return { eligible: false, reason: 'INELIGIBLE_HOST_SCORE_TOO_LOW' };
  }
  if ((input.hostProfile.rankTier ?? 0) >= (input.playerProfile.rankTier ?? 11) + 1) {
    return { eligible: true, reason: 'ELIGIBLE_RANK_ADVANTAGE' };
  }
  return { eligible: false, reason: 'INELIGIBLE_HOST_NOT_HIGHER_TIER' };
};

export const assertRatingValue = (value: number): void => {
  if (!Number.isFinite(value) || value < 1 || value > 10 || Math.abs(value * 2 - Math.round(value * 2)) > Number.EPSILON) {
    domainError('RATING_INVALID_VALUE', 'Rating value must be between 1.0 and 10.0 in 0.5 increments.');
  }
};

export const roundScore = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

export const calculateTrimmedMean = (ratings: number[]): number => {
  if (ratings.length < 3) {
    return roundScore(ratings.reduce((sum, value) => sum + value, 0) / Math.max(1, ratings.length));
  }
  const ordered = [...ratings].sort((a, b) => a - b);
  const trimmed = ordered.slice(1, -1);
  return roundScore(trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length);
};

export const effectiveRatingForScore = (
  rawRating: number,
  priorScore: number | null,
  cap: number,
): { effectiveRating: number; isOutlier: boolean } => {
  if (priorScore === null) {
    return { effectiveRating: rawRating, isOutlier: false };
  }
  const lower = priorScore - cap;
  const upper = priorScore + cap;
  const effectiveRating = Math.max(lower, Math.min(upper, rawRating));
  return { effectiveRating: roundScore(effectiveRating), isOutlier: effectiveRating !== rawRating };
};

export const isCalibrationOutlier = (rawRating: number, priorRawRatings: number[]): boolean => {
  if (priorRawRatings.length === 0) return false;
  const ordered = [...priorRawRatings].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  const median = ordered.length % 2 === 0 ? ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2 : (ordered[middle] ?? 0);
  return Math.abs(rawRating - median) > 3;
};

const recencyWeight = (position: number, weights: RecencyWeights): number => {
  if (position <= 5) return weights.newest1To5;
  if (position <= 10) return weights.next6To10;
  return weights.oldest11To20;
};

export const calculateRollingWeightedScore = (ratingsNewestFirst: StoredRating[], config: RankingRuleConfig): number => {
  const selected = ratingsNewestFirst.slice(0, config.rollingWindowSize);
  const weighted = selected.reduce(
    (acc, rating, index) => {
      const weight = recencyWeight(index + 1, config.recencyWeights);
      const value = rating.effectiveRatingValue ?? rating.ratingValue;
      return { total: acc.total + value * weight, weights: acc.weights + weight };
    },
    { total: 0, weights: 0 },
  );
  return roundScore(weighted.total / weighted.weights);
};

export const mapScoreToTier = (score: number, boundaries: TierBoundary[]): number => {
  const ordered = [...boundaries].sort((a, b) => a.minScore - b.minScore || a.tier - b.tier);
  let current = ordered[0]?.tier ?? 1;
  for (const boundary of ordered) {
    if (score >= boundary.minScore) current = boundary.tier;
  }
  return current;
};

const minScoreForTier = (tier: number, boundaries: TierBoundary[]): number => (
  boundaries.find((boundary) => boundary.tier === tier)?.minScore ?? 10
);

export const evaluateTierTransition = (
  profile: SkillProfile,
  score: number,
  config: RankingRuleConfig,
): { nextTier: number; transition: 'PROMOTED' | 'DEMOTED' | null } => {
  const currentTier = profile.rankTier;
  if (currentTier === null) {
    return { nextTier: mapScoreToTier(score, config.tierBoundaries), transition: null };
  }
  if (profile.validRatingCount - profile.lastRankChangeRatingCount < config.minRatingsSinceTierChange) {
    return { nextTier: currentTier, transition: null };
  }
  const candidate = mapScoreToTier(score, config.tierBoundaries);
  if (candidate > currentTier && score >= minScoreForTier(candidate, config.tierBoundaries) + config.promotionBuffer) {
    return { nextTier: candidate, transition: 'PROMOTED' };
  }
  if (candidate < currentTier && score < minScoreForTier(currentTier, config.tierBoundaries) - config.demotionBuffer) {
    return { nextTier: candidate, transition: 'DEMOTED' };
  }
  return { nextTier: currentTier, transition: null };
};

export const calculateConfidence = (
  validRatingCount: number,
  uniqueValidRaterCount: number,
  thresholds: ConfidenceThresholds,
): ConfidenceLevel => {
  if (validRatingCount >= thresholds.high.minValidRatings && uniqueValidRaterCount >= thresholds.high.minUniqueRaters) return 'HIGH';
  if (validRatingCount >= thresholds.medium.minValidRatings && uniqueValidRaterCount >= thresholds.medium.minUniqueRaters) return 'MEDIUM';
  return 'LOW';
};
