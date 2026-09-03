DROP TABLE IF EXISTS participant_attendance_logs;
DROP INDEX IF EXISTS room_participants_room_attendance_idx;
DROP INDEX IF EXISTS rooms_auto_start_due_idx;

ALTER TABLE room_participants
  DROP COLUMN IF EXISTS attendance_reason_code,
  DROP COLUMN IF EXISTS attendance_marked_by_user_id,
  DROP COLUMN IF EXISTS attendance_marked_at;

ALTER TABLE rooms
  DROP CONSTRAINT IF EXISTS rooms_completed_state_shape,
  DROP CONSTRAINT IF EXISTS rooms_started_state_shape;
