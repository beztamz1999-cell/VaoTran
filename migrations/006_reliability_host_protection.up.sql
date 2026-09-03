-- M5: immutable cancellation/reliability facts and HOST-protection refill projections.

CREATE TYPE cancellation_source_type AS ENUM ('PLAYER', 'HOST', 'SYSTEM', 'ROOM');
CREATE TYPE participation_cancellation_classification AS ENUM (
  'EARLY',
  'LATE',
  'HOST_REMOVED',
  'ROOM_CANCELLED',
  'MATERIAL_CHANGE_WAIVER'
);
CREATE TYPE reliability_subject_type AS ENUM ('PLAYER', 'HOST');
CREATE TYPE slot_loss_type AS ENUM ('EARLY_CANCEL', 'LATE_CANCEL', 'NO_SHOW', 'EXTERNAL_RESERVED_DROP', 'HOST_REMOVAL');

CREATE TABLE participation_cancellations (
  id UUID PRIMARY KEY,
  room_participant_id UUID NOT NULL UNIQUE REFERENCES room_participants(id),
  cancelled_by_type cancellation_source_type NOT NULL,
  cancelled_by_user_id UUID NULL REFERENCES users(id),
  classification participation_cancellation_classification NOT NULL,
  reason_code VARCHAR(120) NULL,
  reason_text VARCHAR(1000) NULL,
  penalty_applicable BOOLEAN NOT NULL,
  source_material_change_id UUID NULL REFERENCES room_change_logs(id),
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT participation_cancellations_penalty_shape CHECK (
    (classification = 'LATE' AND penalty_applicable = TRUE)
    OR (classification <> 'LATE' AND penalty_applicable = FALSE)
  )
);
CREATE INDEX participation_cancellations_participant_created_idx
  ON participation_cancellations (room_participant_id, created_at DESC);

CREATE TABLE player_reliability_stats (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  accepted_matches INTEGER NOT NULL DEFAULT 0 CHECK (accepted_matches >= 0),
  completed_matches INTEGER NOT NULL DEFAULT 0 CHECK (completed_matches >= 0),
  early_cancels INTEGER NOT NULL DEFAULT 0 CHECK (early_cancels >= 0),
  late_cancels INTEGER NOT NULL DEFAULT 0 CHECK (late_cancels >= 0),
  no_shows INTEGER NOT NULL DEFAULT 0 CHECK (no_shows >= 0),
  guest_no_shows_attributed INTEGER NOT NULL DEFAULT 0 CHECK (guest_no_shows_attributed >= 0),
  host_removed_count INTEGER NOT NULL DEFAULT 0 CHECK (host_removed_count >= 0),
  room_cancelled_count INTEGER NOT NULL DEFAULT 0 CHECK (room_cancelled_count >= 0),
  material_change_waivers INTEGER NOT NULL DEFAULT 0 CHECK (material_change_waivers >= 0),
  reliability_score NUMERIC(5,2) NOT NULL DEFAULT 100 CHECK (reliability_score BETWEEN 0 AND 100),
  present_matches_since_last_penalty INTEGER NOT NULL DEFAULT 0 CHECK (present_matches_since_last_penalty >= 0),
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE host_stats (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  rooms_created INTEGER NOT NULL DEFAULT 0 CHECK (rooms_created >= 0),
  rooms_completed INTEGER NOT NULL DEFAULT 0 CHECK (rooms_completed >= 0),
  rooms_cancelled INTEGER NOT NULL DEFAULT 0 CHECK (rooms_cancelled >= 0),
  late_room_cancellations INTEGER NOT NULL DEFAULT 0 CHECK (late_room_cancellations >= 0),
  accepted_players_total INTEGER NOT NULL DEFAULT 0 CHECK (accepted_players_total >= 0),
  players_removed_after_accept INTEGER NOT NULL DEFAULT 0 CHECK (players_removed_after_accept >= 0),
  material_changes_after_accept INTEGER NOT NULL DEFAULT 0 CHECK (material_changes_after_accept >= 0),
  repeat_players INTEGER NOT NULL DEFAULT 0 CHECK (repeat_players >= 0),
  lost_slots INTEGER NOT NULL DEFAULT 0 CHECK (lost_slots >= 0),
  recovered_slots INTEGER NOT NULL DEFAULT 0 CHECK (recovered_slots >= 0),
  host_trust_score NUMERIC(5,2) NULL CHECK (host_trust_score IS NULL OR host_trust_score BETWEEN 0 AND 100),
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE reliability_adjustments (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  subject_type reliability_subject_type NOT NULL,
  source_event_id UUID NOT NULL,
  adjustment NUMERIC(5,2) NOT NULL,
  reason VARCHAR(80) NOT NULL,
  score_before NUMERIC(5,2) NOT NULL CHECK (score_before BETWEEN 0 AND 100),
  score_after NUMERIC(5,2) NOT NULL CHECK (score_after BETWEEN 0 AND 100),
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT reliability_adjustments_source_once UNIQUE (source_event_id, subject_type, user_id, reason)
);
CREATE INDEX reliability_adjustments_user_created_idx
  ON reliability_adjustments (user_id, created_at DESC);

CREATE TABLE slot_recovery_records (
  id UUID PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES rooms(id),
  loss_event_id UUID NOT NULL UNIQUE,
  loss_type slot_loss_type NOT NULL,
  lost_at TIMESTAMPTZ NOT NULL,
  recovered BOOLEAN NOT NULL DEFAULT FALSE,
  replacement_participant_id UUID NULL REFERENCES room_participants(id),
  recovered_at TIMESTAMPTZ NULL,
  recovery_seconds INTEGER NULL,
  expired_at TIMESTAMPTZ NULL,
  voided_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT slot_recovery_records_recovered_shape CHECK (
    (recovered = FALSE AND replacement_participant_id IS NULL AND recovered_at IS NULL AND recovery_seconds IS NULL)
    OR (recovered = TRUE AND replacement_participant_id IS NOT NULL AND recovered_at IS NOT NULL AND recovery_seconds IS NOT NULL AND recovery_seconds >= 0)
  )
);
CREATE INDEX slot_recovery_records_room_pending_idx
  ON slot_recovery_records (room_id, lost_at)
  WHERE recovered = FALSE AND expired_at IS NULL;

CREATE TABLE room_refill_states (
  room_id UUID PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  active BOOLEAN NOT NULL DEFAULT FALSE,
  search_boost_active BOOLEAN NOT NULL DEFAULT FALSE,
  reason VARCHAR(80) NULL,
  started_at TIMESTAMPTZ NULL,
  replacement_window_ends_at TIMESTAMPTZ NULL,
  disabled_at TIMESTAMPTZ NULL,
  last_loss_event_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT room_refill_states_active_shape CHECK (
    (active = FALSE AND search_boost_active = FALSE)
    OR (active = TRUE AND search_boost_active = TRUE AND started_at IS NOT NULL)
  )
);
CREATE INDEX room_refill_states_active_idx
  ON room_refill_states (active, replacement_window_ends_at)
  WHERE active = TRUE;

COMMENT ON TABLE participation_cancellations IS 'M5 immutable accepted-participant cancellation fact; application ACCEPTED remains terminal history.';
COMMENT ON TABLE reliability_adjustments IS 'M5 immutable player/HOST reliability adjustment ledger; unique source prevents replay penalties.';
COMMENT ON TABLE slot_recovery_records IS 'M5 HOST-protection loss/recovery facts; recovery requires accepted replacement, never merely a request.';
COMMENT ON TABLE room_refill_states IS 'M5 urgent refill is a mode/projection, not a Room lifecycle state.';
