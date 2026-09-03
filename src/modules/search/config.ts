const positiveNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * M4 search settings are intentionally read-side configuration. They do not alter
 * Room, Application, Participant, capacity, or lifecycle source-of-truth facts.
 */
export interface SearchRankingConfig {
  readonly version: string;
  readonly defaultRadiusKm: number;
  readonly expandedRadiusKm: readonly number[];
  readonly minResultsBeforeExpand: number;
  readonly maxResults: number;
  readonly weights: {
    readonly proximity: number;
    readonly time: number;
    readonly capacity: number;
    readonly skill: number;
    readonly relationship: number;
    readonly reliability: number;
    readonly urgency: number;
  };
}

export const searchRankingConfig: SearchRankingConfig = {
  version: process.env.SEARCH_RANKING_CONFIG_VERSION ?? 'm5-v0.1',
  defaultRadiusKm: positiveNumber(process.env.SEARCH_DEFAULT_RADIUS_KM, 5),
  expandedRadiusKm: [
    positiveNumber(process.env.SEARCH_EXPANDED_RADIUS_1_KM, 10),
    positiveNumber(process.env.SEARCH_EXPANDED_RADIUS_2_KM, 20),
  ],
  minResultsBeforeExpand: positiveNumber(process.env.SEARCH_MIN_RESULTS_BEFORE_EXPAND, 3),
  maxResults: positiveNumber(process.env.SEARCH_MAX_RESULTS, 50),
  weights: {
    proximity: positiveNumber(process.env.SEARCH_WEIGHT_PROXIMITY, 25),
    time: positiveNumber(process.env.SEARCH_WEIGHT_TIME, 20),
    capacity: positiveNumber(process.env.SEARCH_WEIGHT_CAPACITY, 15),
    skill: positiveNumber(process.env.SEARCH_WEIGHT_SKILL, 15),
    relationship: positiveNumber(process.env.SEARCH_WEIGHT_RELATIONSHIP, 10),
    reliability: positiveNumber(process.env.SEARCH_WEIGHT_RELIABILITY, 5),
    urgency: positiveNumber(process.env.SEARCH_WEIGHT_URGENCY, 10),
  },
};
