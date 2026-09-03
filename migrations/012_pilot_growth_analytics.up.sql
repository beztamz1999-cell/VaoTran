-- M10 Pilot Growth Loop & Marketplace Learning.
-- These tables are read-side projections only. They must never drive Room, Application,
-- Participant, Reliability, Ranking, Search, capacity, or authorization decisions.

CREATE TABLE analytics_processed_events (
  event_id UUID PRIMARY KEY,
  event_type VARCHAR(96) NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE analytics_activity_events (
  event_id UUID PRIMARY KEY,
  event_type VARCHAR(96) NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  actor_key VARCHAR(64) NULL,
  room_key VARCHAR(64) NULL,
  sport_code VARCHAR(64) NULL,
  area_bucket VARCHAR(64) NULL,
  result_count INTEGER NULL CHECK (result_count IS NULL OR result_count >= 0),
  scheduled_hour_utc SMALLINT NULL CHECK (scheduled_hour_utc IS NULL OR scheduled_hour_utc BETWEEN 0 AND 23),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_analytics_activity_event_type_time
  ON analytics_activity_events (event_type, occurred_at);
CREATE INDEX idx_analytics_activity_actor_time
  ON analytics_activity_events (actor_key, occurred_at)
  WHERE actor_key IS NOT NULL;
CREATE INDEX idx_analytics_activity_marketplace
  ON analytics_activity_events (sport_code, area_bucket, occurred_at);

CREATE TABLE analytics_room_facts (
  room_key VARCHAR(64) PRIMARY KEY,
  host_key VARCHAR(64) NULL,
  sport_code VARCHAR(64) NULL,
  area_bucket VARCHAR(64) NULL,
  scheduled_hour_utc SMALLINT NULL CHECK (scheduled_hour_utc IS NULL OR scheduled_hour_utc BETWEEN 0 AND 23),
  capacity INTEGER NULL CHECK (capacity IS NULL OR capacity > 0),
  created_at TIMESTAMPTZ NULL,
  published_at TIMESTAMPTZ NULL,
  share_created_at TIMESTAMPTZ NULL,
  first_application_at TIMESTAMPTZ NULL,
  filled_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  cancelled_at TIMESTAMPTZ NULL,
  repeated_from_room_key VARCHAR(64) NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_analytics_room_host ON analytics_room_facts (host_key, created_at);
CREATE INDEX idx_analytics_room_marketplace ON analytics_room_facts (sport_code, area_bucket, published_at);

CREATE TABLE analytics_application_facts (
  application_key VARCHAR(64) PRIMARY KEY,
  room_key VARCHAR(64) NOT NULL,
  requester_key VARCHAR(64) NULL,
  requested_slot_count INTEGER NULL CHECK (requested_slot_count IS NULL OR requested_slot_count > 0),
  created_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ NULL
);

CREATE INDEX idx_analytics_application_room ON analytics_application_facts (room_key, created_at);
CREATE INDEX idx_analytics_application_requester ON analytics_application_facts (requester_key, created_at)
  WHERE requester_key IS NOT NULL;

CREATE TABLE analytics_participant_facts (
  participant_key VARCHAR(64) PRIMARY KEY,
  room_key VARCHAR(64) NOT NULL,
  user_key VARCHAR(64) NULL,
  attendance_status VARCHAR(16) NOT NULL DEFAULT 'NOT_SET'
    CHECK (attendance_status IN ('NOT_SET', 'PRESENT', 'NO_SHOW')),
  accepted_at TIMESTAMPTZ NOT NULL,
  attendance_updated_at TIMESTAMPTZ NULL
);

CREATE INDEX idx_analytics_participant_room ON analytics_participant_facts (room_key);
CREATE INDEX idx_analytics_participant_user ON analytics_participant_facts (user_key)
  WHERE user_key IS NOT NULL;

CREATE TABLE analytics_completed_participations (
  room_key VARCHAR(64) NOT NULL,
  user_key VARCHAR(64) NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (room_key, user_key)
);

CREATE INDEX idx_analytics_completed_user_time ON analytics_completed_participations (user_key, completed_at);

CREATE TABLE analytics_user_profiles (
  user_key VARCHAR(64) PRIMARY KEY,
  registered_at TIMESTAMPTZ NULL,
  first_active_at TIMESTAMPTZ NULL,
  last_active_at TIMESTAMPTZ NULL,
  first_sport_code VARCHAR(64) NULL,
  first_area_bucket VARCHAR(64) NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_analytics_user_cohort ON analytics_user_profiles (first_active_at, first_sport_code, first_area_bucket);

CREATE TABLE analytics_experiment_assignments (
  experiment_key VARCHAR(96) NOT NULL,
  subject_key VARCHAR(64) NOT NULL,
  variant_key VARCHAR(96) NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (experiment_key, subject_key)
);

CREATE TABLE analytics_experiment_exposures (
  experiment_key VARCHAR(96) NOT NULL,
  subject_key VARCHAR(64) NOT NULL,
  variant_key VARCHAR(96) NOT NULL,
  exposure_key VARCHAR(128) NOT NULL,
  exposed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (experiment_key, subject_key, exposure_key)
);

COMMENT ON TABLE analytics_activity_events IS
  'M10 read-only event facts. Keys are HMAC-derived pseudonyms; raw phone, email, address, token and message content are prohibited.';
COMMENT ON TABLE analytics_room_facts IS
  'M10 derived Room funnel projection. Never used by lifecycle, capacity, ranking, reliability or authorization.';
COMMENT ON TABLE analytics_completed_participations IS
  'M10 derived, idempotent PRESENT+COMPLETED participation facts for retention and repeat-participation metrics.';
COMMENT ON TABLE analytics_experiment_assignments IS
  'M10 stable experiment foundation only. Assignment does not alter product behavior.';
