-- M9: targeted indexes for the verified schedule-conflict hot paths.
-- Search discovery, outbox dispatch and notification feed already have purpose-built indexes
-- in migrations 002, 001 and 009 respectively; avoid redundant indexes here.

CREATE INDEX room_participants_active_user_room_idx
  ON room_participants (user_id, room_id)
  WHERE user_id IS NOT NULL AND status = 'ACTIVE';

CREATE INDEX room_application_members_user_application_idx
  ON room_application_members (user_id, application_id)
  WHERE user_id IS NOT NULL;

COMMENT ON INDEX room_participants_active_user_room_idx IS
  'M9 schedule-conflict lookup: active accepted participant rows by registered user.';
COMMENT ON INDEX room_application_members_user_application_idx IS
  'M9 Party/solo pending-overlap withdrawal lookup: registered snapshot member to application.';
