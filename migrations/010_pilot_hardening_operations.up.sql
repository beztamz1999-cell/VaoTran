CREATE TYPE reconciliation_run_status AS ENUM ('COMPLETED', 'FAILED');
CREATE TYPE reconciliation_finding_severity AS ENUM ('INFO', 'WARNING', 'CRITICAL');
CREATE TYPE reconciliation_finding_state AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

CREATE TABLE reconciliation_runs (
  id UUID PRIMARY KEY,
  job_name VARCHAR(120) NOT NULL,
  status reconciliation_run_status NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  findings_count INTEGER NOT NULL DEFAULT 0 CHECK (findings_count >= 0),
  summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message VARCHAR(2048),
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX reconciliation_runs_job_completed_idx ON reconciliation_runs (job_name, completed_at DESC);

CREATE TABLE reconciliation_findings (
  id UUID PRIMARY KEY,
  reconciliation_run_id UUID NOT NULL REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
  check_name VARCHAR(160) NOT NULL,
  entity_type VARCHAR(80) NOT NULL,
  entity_id UUID,
  severity reconciliation_finding_severity NOT NULL,
  state reconciliation_finding_state NOT NULL DEFAULT 'OPEN',
  fingerprint VARCHAR(128) NOT NULL,
  expected_json JSONB NOT NULL,
  actual_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  acknowledged_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  CONSTRAINT reconciliation_findings_run_fingerprint_unique UNIQUE (reconciliation_run_id, fingerprint)
);
CREATE INDEX reconciliation_findings_open_idx ON reconciliation_findings (state, severity, created_at DESC);
CREATE INDEX reconciliation_findings_entity_idx ON reconciliation_findings (entity_type, entity_id, created_at DESC);

CREATE TABLE internal_operation_audits (
  id UUID PRIMARY KEY,
  action VARCHAR(120) NOT NULL,
  target_type VARCHAR(80) NOT NULL,
  target_id UUID,
  outcome VARCHAR(32) NOT NULL,
  correlation_id VARCHAR(128),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX internal_operation_audits_target_idx ON internal_operation_audits (target_type, target_id, created_at DESC);
CREATE INDEX internal_operation_audits_action_idx ON internal_operation_audits (action, created_at DESC);

COMMENT ON TABLE reconciliation_runs IS 'M9 verification-only runs. They never repair projections or mutate business facts.';
COMMENT ON TABLE reconciliation_findings IS 'M9 operator-visible detected drift. Expected and actual values exclude PII and secrets.';
COMMENT ON TABLE internal_operation_audits IS 'M9 audit records for protected internal operational actions such as safe retry.';
