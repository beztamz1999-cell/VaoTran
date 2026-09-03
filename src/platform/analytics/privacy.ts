import { createHmac } from 'node:crypto';
import { config } from '../core.js';

const hmac = (namespace: string, raw: string): string => createHmac('sha256', config.analyticsHashSalt)
  .update(`${namespace}:${raw}`)
  .digest('hex');

/**
 * Returns a one-way, scoped key suitable only for analytics joins. Raw business IDs
 * must not be persisted in M10 analytics tables or returned by inspection routes.
 */
export const analyticsKey = (namespace: string, raw: string | null | undefined): string | null => {
  if (!raw) return null;
  return hmac(namespace, raw);
};

/**
 * Coarsens coordinates to a 0.1-degree cell (roughly 11 km latitude). It deliberately
 * never returns the original latitude/longitude or an address-like text value.
 */
export const coarseGeoBucket = (latitude: number | null | undefined, longitude: number | null | undefined): string => {
  if (latitude === null || latitude === undefined || longitude === null || longitude === undefined) return 'UNSPECIFIED';
  return `GEO_${Math.floor(latitude * 10) / 10}_${Math.floor(longitude * 10) / 10}`;
};

/**
 * Free-text search areas cannot be assumed to be a coarse administrative label.
 * Keep the grouping capability while storing an opaque pseudonym rather than raw text.
 */
export const coarseAreaBucket = (area: string | null | undefined): string => {
  const normalized = area?.trim().toLocaleLowerCase();
  return normalized ? `AREA_${hmac('area', normalized).slice(0, 16)}` : 'UNSPECIFIED';
};

export const safeAnalyticsHour = (value: Date): number => value.getUTCHours();
