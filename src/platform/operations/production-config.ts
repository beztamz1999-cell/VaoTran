export type Environment = Record<string, string | undefined>;

export interface ProductionConfigValidation {
  valid: boolean;
  environment: 'development' | 'production';
  issues: string[];
}

const hasValue = (value: string | undefined): boolean => Boolean(value?.trim());

/**
 * Audits deployment configuration only. It never mutates runtime config and deliberately
 * permits local/test fallbacks outside NODE_ENV=production.
 */
export const validateProductionConfig = (environment: Environment = process.env): ProductionConfigValidation => {
  const isProduction = environment.NODE_ENV === 'production';
  if (!isProduction) return { valid: true, environment: 'development', issues: [] };

  const issues: string[] = [];
  if (!hasValue(environment.DATABASE_URL)) issues.push('DATABASE_URL is required in production.');
  if (!hasValue(environment.INTERNAL_OPS_TOKEN)) issues.push('INTERNAL_OPS_TOKEN is required in production.');
  if (!hasValue(environment.INTERNAL_OPS_ALLOWLIST)) issues.push('INTERNAL_OPS_ALLOWLIST is required in production.');
  if (!hasValue(environment.ANALYTICS_HASH_SALT) || environment.ANALYTICS_HASH_SALT === 'vaotran-development-analytics-salt') {
    issues.push('ANALYTICS_HASH_SALT must be a non-development secret in production.');
  }
  if (environment.ALLOW_DEV_ACTOR_HEADER === 'true') {
    issues.push('ALLOW_DEV_ACTOR_HEADER must not be true in production.');
  }
  return { valid: issues.length === 0, environment: 'production', issues };
};
