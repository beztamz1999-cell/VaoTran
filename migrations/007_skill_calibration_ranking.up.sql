-- M6: Skill, Calibration & Ranking
-- Raw SkillRating rows are immutable evidence. Derived profile state remains in user_sport_profiles.

CREATE TABLE ranking_rule_configs (
  id UUID PRIMARY KEY,
  sport_id UUID NOT NULL REFERENCES sports(id),
  version VARCHAR(80) NOT NULL,
  calibration_required_ratings INTEGER NOT NULL,
  calibration_host_min_score NUMERIC(4,2) NOT NULL,
  rolling_window_size INTEGER NOT NULL,
  tier_boundaries_json JSONB NOT NULL,
  recency_weights_json JSONB NOT NULL,
  confidence_thresholds_json JSONB NOT NULL,
  promotion_buffer NUMERIC(4,2) NOT NULL,
  demotion_buffer NUMERIC(4,2) NOT NULL,
  outlier_cap NUMERIC(4,2) NOT NULL,
  min_ratings_since_tier_change INTEGER NOT NULL,
  active_from TIMESTAMPTZ NOT NULL,
  active_to TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT ranking_rule_configs_version_per_sport UNIQUE (sport_id, version),
  CONSTRAINT ranking_rule_configs_calibration_positive CHECK (calibration_required_ratings >= 1),
  CONSTRAINT ranking_rule_configs_calibration_score_valid CHECK (calibration_host_min_score BETWEEN 1 AND 10),
  CONSTRAINT ranking_rule_configs_rolling_window_positive CHECK (rolling_window_size >= 1),
  CONSTRAINT ranking_rule_configs_buffers_nonnegative CHECK (promotion_buffer >= 0 AND demotion_buffer >= 0),
  CONSTRAINT ranking_rule_configs_outlier_cap_positive CHECK (outlier_cap > 0),
  CONSTRAINT ranking_rule_configs_min_evidence_nonnegative CHECK (min_ratings_since_tier_change >= 0),
  CONSTRAINT ranking_rule_configs_active_range CHECK (active_to IS NULL OR active_to > active_from)
);
CREATE UNIQUE INDEX ranking_rule_configs_one_current_per_sport_idx
  ON ranking_rule_configs (sport_id) WHERE active_to IS NULL;

CREATE TABLE skill_ratings (
  id UUID PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES rooms(id),
  sport_id UUID NOT NULL REFERENCES sports(id),
  rated_user_id UUID NOT NULL REFERENCES users(id),
  rater_host_user_id UUID NOT NULL REFERENCES users(id),
  rating_value NUMERIC(4,2) NOT NULL,
  effective_rating_value NUMERIC(4,2),
  player_skill_state_snapshot skill_state NOT NULL,
  player_skill_score_snapshot NUMERIC(4,2),
  player_rank_tier_snapshot SMALLINT,
  host_skill_state_snapshot skill_state NOT NULL,
  host_skill_score_snapshot NUMERIC(4,2),
  host_rank_tier_snapshot SMALLINT,
  eligibility_result BOOLEAN NOT NULL,
  eligibility_reason VARCHAR(80) NOT NULL,
  is_outlier BOOLEAN NOT NULL DEFAULT FALSE,
  rule_version VARCHAR(80) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT skill_ratings_one_per_room_player_sport UNIQUE (room_id, rated_user_id, sport_id),
  CONSTRAINT skill_ratings_value_half_step CHECK (
    rating_value BETWEEN 1 AND 10 AND rating_value = round(rating_value * 2) / 2
  ),
  CONSTRAINT skill_ratings_effective_value_valid CHECK (
    effective_rating_value IS NULL OR effective_rating_value BETWEEN 1 AND 10
  ),
  CONSTRAINT skill_ratings_player_score_snapshot_valid CHECK (
    player_skill_score_snapshot IS NULL OR player_skill_score_snapshot BETWEEN 1 AND 10
  ),
  CONSTRAINT skill_ratings_host_score_snapshot_valid CHECK (
    host_skill_score_snapshot IS NULL OR host_skill_score_snapshot BETWEEN 1 AND 10
  ),
  CONSTRAINT skill_ratings_player_tier_snapshot_valid CHECK (
    player_rank_tier_snapshot IS NULL OR player_rank_tier_snapshot BETWEEN 1 AND 10
  ),
  CONSTRAINT skill_ratings_host_tier_snapshot_valid CHECK (
    host_rank_tier_snapshot IS NULL OR host_rank_tier_snapshot BETWEEN 1 AND 10
  ),
  CONSTRAINT skill_ratings_not_self_rating CHECK (rated_user_id <> rater_host_user_id)
);
CREATE INDEX skill_ratings_rated_sport_created_idx
  ON skill_ratings (rated_user_id, sport_id, created_at DESC, id DESC);
CREATE INDEX skill_ratings_rater_sport_created_idx
  ON skill_ratings (rater_host_user_id, sport_id, created_at DESC, id DESC);
CREATE INDEX skill_ratings_room_idx ON skill_ratings (room_id, created_at, id);

ALTER TABLE user_sport_profiles
  ADD COLUMN last_rank_change_rating_count INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT user_sport_profiles_rank_change_rating_count_nonnegative
    CHECK (last_rank_change_rating_count >= 0);

-- Version 1 is data, not distributed business constants. Future algorithm changes create a new active version.
INSERT INTO ranking_rule_configs (
  id, sport_id, version, calibration_required_ratings, calibration_host_min_score,
  rolling_window_size, tier_boundaries_json, recency_weights_json, confidence_thresholds_json,
  promotion_buffer, demotion_buffer, outlier_cap, min_ratings_since_tier_change,
  active_from, active_to, created_at
)
SELECT
  CASE s.code
    WHEN 'BADMINTON' THEN '90000000-0000-4000-8000-000000000001'::uuid
    WHEN 'PICKLEBALL' THEN '90000000-0000-4000-8000-000000000002'::uuid
    WHEN 'FOOTBALL' THEN '90000000-0000-4000-8000-000000000003'::uuid
  END,
  s.id,
  'v1',
  10,
  5.00,
  20,
  '[
    {"tier": 1, "min_score": 1.00}, {"tier": 2, "min_score": 2.00},
    {"tier": 3, "min_score": 3.00}, {"tier": 4, "min_score": 4.00},
    {"tier": 5, "min_score": 5.00}, {"tier": 6, "min_score": 6.00},
    {"tier": 7, "min_score": 7.00}, {"tier": 8, "min_score": 8.00},
    {"tier": 9, "min_score": 9.00}, {"tier": 10, "min_score": 10.00}
  ]'::jsonb,
  '{"newest_1_5": 1.00, "next_6_10": 0.85, "oldest_11_20": 0.70}'::jsonb,
  '{
    "medium": {"min_valid_ratings": 15, "min_unique_raters": 3},
    "high": {"min_valid_ratings": 30, "min_unique_raters": 5}
  }'::jsonb,
  0.10,
  0.10,
  2.00,
  3,
  NOW(),
  NULL,
  NOW()
FROM sports s
WHERE s.code IN ('BADMINTON', 'PICKLEBALL', 'FOOTBALL');
