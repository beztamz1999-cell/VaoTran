-- M4 Search telemetry is analytics-only. It never replaces canonical Room/Application/Participant business state.
CREATE TABLE search_telemetry_events (
  id UUID PRIMARY KEY,
  actor_user_id UUID NOT NULL REFERENCES users(id),
  room_id UUID NULL REFERENCES rooms(id),
  event_type VARCHAR(80) NOT NULL CHECK (event_type IN (
    'SEARCH_STARTED',
    'SEARCH_RESULTS_RETURNED',
    'SEARCH_EMPTY',
    'SEARCH_RADIUS_EXPANDED',
    'ROOM_CARD_VIEWED',
    'ROOM_DETAIL_OPENED'
  )),
  occurred_at TIMESTAMPTZ NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX search_telemetry_events_actor_time_idx
  ON search_telemetry_events (actor_user_id, occurred_at DESC);
CREATE INDEX search_telemetry_events_type_time_idx
  ON search_telemetry_events (event_type, occurred_at DESC);
CREATE INDEX search_telemetry_events_room_time_idx
  ON search_telemetry_events (room_id, occurred_at DESC)
  WHERE room_id IS NOT NULL;

COMMENT ON TABLE search_telemetry_events IS
  'Minimal, append-only M4 analytics telemetry. Not a DomainEvent and not a capacity or lifecycle source of truth.';
