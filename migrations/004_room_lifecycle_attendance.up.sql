-- actual_started_at, start_source and completed_at are baseline Room columns from 002_room_core.
-- M3 adds lifecycle integrity constraints, attendance metadata and the append-only audit trail.
ALTER TABLE rooms
  ADD CONSTRAINT rooms_started_state_shape CHECK (
    (status IN ('IN_PROGRESS', 'COMPLETED')
      AND actual_started_at IS NOT NULL
      AND start_source IN ('MANUAL', 'AUTO'))
    OR (status NOT IN ('IN_PROGRESS', 'COMPLETED')
      AND actual_started_at IS NULL
      AND start_source IS NULL)
  ),
  ADD CONSTRAINT rooms_completed_state_shape CHECK (
    (status = 'COMPLETED' AND completed_at IS NOT NULL)
    OR (status <> 'COMPLETED' AND completed_at IS NULL)
  );

ALTER TABLE room_participants
  ADD COLUMN attendance_marked_at TIMESTAMPTZ NULL,
  ADD COLUMN attendance_marked_by_user_id UUID NULL REFERENCES users(id),
  ADD COLUMN attendance_reason_code VARCHAR(120) NULL;

CREATE TABLE participant_attendance_logs (
  id UUID PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES rooms(id),
  participant_id UUID NOT NULL REFERENCES room_participants(id),
  previous_status participant_attendance_status NOT NULL,
  next_status participant_attendance_status NOT NULL,
  changed_by_user_id UUID NOT NULL REFERENCES users(id),
  reason_code VARCHAR(120) NULL,
  is_correction BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT participant_attendance_logs_change_valid CHECK (previous_status <> next_status)
);

CREATE INDEX rooms_auto_start_due_idx
  ON rooms (scheduled_start_at)
  WHERE status IN ('OPEN', 'FULL');
CREATE INDEX room_participants_room_attendance_idx
  ON room_participants (room_id, status, attendance_status);
CREATE INDEX participant_attendance_logs_participant_idx
  ON participant_attendance_logs (participant_id, created_at DESC);

COMMENT ON TABLE participant_attendance_logs IS 'Append-only attendance history; corrections remain auditable before M6 reliability/rating integrations.';
COMMENT ON COLUMN rooms.actual_started_at IS 'Authoritative server-clock timestamp for manual or scheduled start.';
COMMENT ON COLUMN rooms.start_source IS 'MANUAL or AUTO; set atomically with IN_PROGRESS transition.';
