-- M11 rollback removes analytics-only operational metadata and additive version fields.
-- Canonical business tables and their facts remain untouched.

DROP TABLE IF EXISTS analytics_rebuild_runs;
DROP TABLE IF EXISTS analytics_validation_findings;
DROP TABLE IF EXISTS analytics_validation_runs;
DROP TABLE IF EXISTS analytics_projection_failures;
DROP TABLE IF EXISTS analytics_consumer_health;

DROP INDEX IF EXISTS idx_analytics_completed_source;
DROP INDEX IF EXISTS idx_analytics_application_accepted_source;
ALTER TABLE analytics_completed_participations
  DROP COLUMN IF EXISTS completion_source_event_id;
ALTER TABLE analytics_room_facts
  DROP COLUMN IF EXISTS completed_source_event_id;
ALTER TABLE analytics_application_facts
  DROP COLUMN IF EXISTS accepted_source_event_id;

ALTER TABLE analytics_processed_events
  DROP COLUMN IF EXISTS payload_schema_version,
  DROP COLUMN IF EXISTS event_version;

ALTER TABLE event_outbox
  DROP COLUMN IF EXISTS payload_schema_version,
  DROP COLUMN IF EXISTS event_version;
