-- Rollback M6: drop dependent raw evidence first, then rule configs and profile evidence baseline.

ALTER TABLE user_sport_profiles
  DROP CONSTRAINT IF EXISTS user_sport_profiles_rank_change_rating_count_nonnegative,
  DROP COLUMN IF EXISTS last_rank_change_rating_count;

DROP TABLE IF EXISTS skill_ratings;
DROP TABLE IF EXISTS ranking_rule_configs;
