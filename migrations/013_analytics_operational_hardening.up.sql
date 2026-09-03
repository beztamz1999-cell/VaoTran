-- M11 analytics operational hardening. All new tables are read-side operational metadata.
-- They must never be used to mutate or decide canonical Room, Application, Participant,
-- Attendance, Reliability, Ranking, Search, User, capacity, authorization or pricing state.

-- Keep the original schema_version contract intact. These columns are additive so historical
-- outbox rows decode as v1/v1 and future event/payload contracts can evolve independently.
ALTER TABLE event_outbox
  ADD COLUMN event_version INTEGER NOT NULL DEFAULT 1 CHECK (event_version > 0),
  ADD COLUMN payload_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (payload_schema_version > 0);

ALTER TABLE analytics_processed_events
  ADD COLUMN event_version INTEGER NOT NULL DEFAULT 1 CHECK (event_version > 0),
  ADD COLUMN payload_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (payload_schema_version > 0);

-- A completed application fact can be traced to its immutable outbox source without storing
-- any raw user identifier in analytics projections.
ALTER TABLE analytics_application_facts
  ADD COLUMN accepted_source_event_id UUID NULL;

ALTER TABLE analytics_room_facts
  ADD COLUMN completed_source_event_id UUID NULL;

ALTER TABLE analytics_completed_participations
  ADD COLUMN completion_source_event_id UUID NULL;

CREATE INDEX idx_analytics_application_accepted_source
  ON analytics_application_facts (accepted_source_event_id)
  WHERE accepted_source_event_id IS NOT NULL;

CREATE INDEX idx_analytics_completed_source
  ON analytics_completed_participations (completion_source_event_id)
  WHERE completion_source_event_id IS NOT NULL;

CREATE TABLE analytics_consumer_health (
  consumer_name VARCHAR(128) PRIMARY KEY,
  processed_event_count BIGINT NOT NULL DEFAULT 0 CHECK (processed_event_count >= 0),
  failed_projection_count BIGINT NOT NULL DEFAULT 0 CHECK (failed_projection_count >= 0),
  unknown_event_count BIGINT NOT NULL DEFAULT 0 CHECK (unknown_event_count >= 0),
  last_processed_event_time TIMESTAMPTZ NULL,
  last_failure_at TIMESTAMPTZ NULL,
  last_failure_code VARCHAR(96) NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE analytics_projection_failures (
  id UUID PRIMARY KEY,
  event_id UUID NOT NULL,
  event_type VARCHAR(96) NOT NULL,
  event_version INTEGER NOT NULL CHECK (event_version > 0),
  payload_schema_version INTEGER NOT NULL CHECK (payload_schema_version > 0),
  failure_code VARCHAR(96) NOT NULL,
  failure_summary VARCHAR(160) NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  failed_at TIMESTAMPTZ NOT NULL,
  UNIQUE (event_id, failure_code)
);

CREATE INDEX idx_analytics_projection_failures_time
  ON analytics_projection_failures (failed_at DESC);

CREATE TABLE analytics_validation_runs (
  id UUID PRIMARY KEY,
  validation_kind VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL CHECK (status IN ('PASSED', 'FAILED', 'ERROR')),
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  summary_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_analytics_validation_runs_time
  ON analytics_validation_runs (completed_at DESC);

CREATE TABLE analytics_validation_findings (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES analytics_validation_runs(id) ON DELETE CASCADE,
  check_name VARCHAR(128) NOT NULL,
  severity VARCHAR(16) NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'ERROR')),
  finding_count BIGINT NOT NULL DEFAULT 0 CHECK (finding_count >= 0),
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_analytics_validation_findings_run
  ON analytics_validation_findings (run_id, severity, check_name);

CREATE TABLE analytics_rebuild_runs (
  id UUID PRIMARY KEY,
  status VARCHAR(16) NOT NULL CHECK (status IN ('PASSED', 'DRIFT', 'ERROR')),
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  replayed_event_count BIGINT NOT NULL DEFAULT 0 CHECK (replayed_event_count >= 0),
  applied_event_count BIGINT NOT NULL DEFAULT 0 CHECK (applied_event_count >= 0),
  before_metrics_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_metrics_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  drift_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code VARCHAR(96) NULL
);

CREATE INDEX idx_analytics_rebuild_runs_time
  ON analytics_rebuild_runs (completed_at DESC);

COMMENT ON TABLE analytics_consumer_health IS
  'M11 internal-only analytics consumer health counters. It is operational metadata, not a product decision source.';
COMMENT ON TABLE analytics_projection_failures IS
  'M11 internal-only projection failure evidence. It contains no raw user identifier, raw error text, or business-state repair instruction.';
COMMENT ON TABLE analytics_validation_runs IS
  'M11 immutable data-quality validation run summaries for analytics read-side only.';
COMMENT ON TABLE analytics_rebuild_runs IS
  'M11 before/after aggregate comparison reports for read-side rebuild validation only.';
