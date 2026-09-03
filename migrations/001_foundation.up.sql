CREATE TYPE user_status AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');
CREATE TYPE gender AS ENUM ('MALE', 'FEMALE', 'OTHER', 'UNSPECIFIED');
CREATE TYPE sport_status AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE skill_state AS ENUM ('UNRANKED', 'CALIBRATING', 'RANKED', 'TOP_TIER_LOCKED');
CREATE TYPE confidence_level AS ENUM ('LOW', 'MEDIUM', 'HIGH');
CREATE TYPE outbox_publish_status AS ENUM ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED_RETRYABLE', 'DEAD_LETTER');

CREATE TABLE users (
  id UUID PRIMARY KEY,
  phone VARCHAR(32) NOT NULL UNIQUE,
  display_name VARCHAR(120) NOT NULL,
  avatar_url VARCHAR(2048),
  birth_year SMALLINT,
  gender gender,
  home_area VARCHAR(255),
  status user_status NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT users_birth_year_valid CHECK (birth_year IS NULL OR birth_year BETWEEN 1900 AND 2100)
);

CREATE TABLE sports (
  id UUID PRIMARY KEY,
  code VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  status sport_status NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE user_sport_profiles (
  user_id UUID NOT NULL REFERENCES users(id),
  sport_id UUID NOT NULL REFERENCES sports(id),
  skill_state skill_state NOT NULL DEFAULT 'UNRANKED',
  skill_score NUMERIC(4,2),
  rank_tier SMALLINT,
  valid_rating_count INTEGER NOT NULL DEFAULT 0,
  completed_match_count INTEGER NOT NULL DEFAULT 0,
  unique_valid_rater_count INTEGER NOT NULL DEFAULT 0,
  confidence_level confidence_level,
  last_valid_rating_at TIMESTAMPTZ,
  last_rank_change_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, sport_id),
  CONSTRAINT user_sport_profiles_rating_count_nonnegative CHECK (valid_rating_count >= 0),
  CONSTRAINT user_sport_profiles_match_count_nonnegative CHECK (completed_match_count >= 0),
  CONSTRAINT user_sport_profiles_rank_valid CHECK (rank_tier IS NULL OR rank_tier BETWEEN 1 AND 10),
  CONSTRAINT user_sport_profiles_score_valid CHECK (skill_score IS NULL OR skill_score BETWEEN 1 AND 10)
);

CREATE TABLE event_outbox (
  id UUID PRIMARY KEY,
  event_type VARCHAR(120) NOT NULL,
  aggregate_type VARCHAR(80) NOT NULL,
  aggregate_id UUID NOT NULL,
  actor_user_id UUID REFERENCES users(id),
  correlation_id UUID,
  causation_id UUID,
  schema_version INTEGER NOT NULL DEFAULT 1,
  payload_json JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  publish_status outbox_publish_status NOT NULL DEFAULT 'PENDING',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  last_error VARCHAR(2048),
  CONSTRAINT event_outbox_attempt_count_nonnegative CHECK (attempt_count >= 0)
);
CREATE INDEX event_outbox_dispatch_idx ON event_outbox (publish_status, next_attempt_at, occurred_at);
CREATE INDEX event_outbox_aggregate_idx ON event_outbox (aggregate_type, aggregate_id, occurred_at);

CREATE TABLE event_consumptions (
  consumer_name VARCHAR(120) NOT NULL,
  event_id UUID NOT NULL REFERENCES event_outbox(id),
  processed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (consumer_name, event_id)
);

CREATE TABLE idempotency_keys (
  key VARCHAR(255) PRIMARY KEY,
  actor_user_id UUID REFERENCES users(id),
  command_type VARCHAR(160) NOT NULL,
  request_hash VARCHAR(128) NOT NULL,
  response_status SMALLINT,
  response_json JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT idempotency_response_pair CHECK (
    (response_status IS NULL AND response_json IS NULL)
    OR (response_status IS NOT NULL AND response_json IS NOT NULL)
  )
);
CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

INSERT INTO sports (id, code, name, status, created_at) VALUES
  ('10000000-0000-4000-8000-000000000001', 'BADMINTON', 'Cầu lông', 'ACTIVE', NOW()),
  ('10000000-0000-4000-8000-000000000002', 'PICKLEBALL', 'Pickleball', 'ACTIVE', NOW()),
  ('10000000-0000-4000-8000-000000000003', 'FOOTBALL', 'Bóng đá', 'ACTIVE', NOW());
