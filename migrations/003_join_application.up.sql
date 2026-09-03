CREATE TYPE room_application_status AS ENUM (
  'REQUESTED',
  'WAITLISTED',
  'ACCEPTED',
  'REJECTED',
  'WITHDRAWN',
  'EXPIRED'
);

CREATE TYPE application_member_type AS ENUM ('USER', 'GUEST');
CREATE TYPE room_participant_status AS ENUM ('ACTIVE', 'CANCELLED', 'REMOVED_BY_HOST');
CREATE TYPE participant_attendance_status AS ENUM ('NOT_SET', 'PRESENT', 'NO_SHOW');

CREATE TABLE room_applications (
  id UUID PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES rooms(id),
  requested_by_user_id UUID NOT NULL REFERENCES users(id),
  party_id UUID NULL,
  application_owner_key VARCHAR(200) NOT NULL,
  requested_slot_count INTEGER NOT NULL,
  status room_application_status NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ NULL,
  rejected_at TIMESTAMPTZ NULL,
  withdrawn_at TIMESTAMPTZ NULL,
  expired_at TIMESTAMPTZ NULL,
  rejection_reason_code VARCHAR(120) NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT room_applications_slot_count_valid CHECK (requested_slot_count >= 1),
  CONSTRAINT room_applications_owner_key_not_blank CHECK (length(trim(application_owner_key)) > 0),
  CONSTRAINT room_applications_party_owner_shape CHECK (
    (party_id IS NULL AND application_owner_key LIKE 'USER:%')
    OR (party_id IS NOT NULL AND application_owner_key LIKE 'PARTY:%')
  )
);

CREATE INDEX room_applications_room_status_idx ON room_applications (room_id, status, requested_at);
CREATE INDEX room_applications_requester_status_idx ON room_applications (requested_by_user_id, status, requested_at DESC);
CREATE UNIQUE INDEX room_applications_unique_active_owner_idx
  ON room_applications (room_id, application_owner_key)
  WHERE status IN ('REQUESTED', 'WAITLISTED', 'ACCEPTED');

CREATE TABLE room_application_members (
  id UUID PRIMARY KEY,
  application_id UUID NOT NULL REFERENCES room_applications(id) ON DELETE CASCADE,
  source_party_member_id UUID NULL,
  member_type application_member_type NOT NULL,
  user_id UUID NULL REFERENCES users(id),
  guest_label VARCHAR(120) NULL,
  skill_state_snapshot VARCHAR(32) NULL,
  skill_score_snapshot NUMERIC(5,2) NULL,
  rank_tier_snapshot SMALLINT NULL,
  reliability_score_snapshot NUMERIC(5,2) NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT room_application_members_identity_shape CHECK (
    (member_type = 'USER' AND user_id IS NOT NULL AND guest_label IS NULL)
    OR (member_type = 'GUEST' AND user_id IS NULL AND guest_label IS NOT NULL)
  )
);
CREATE INDEX room_application_members_application_idx ON room_application_members (application_id, created_at);

CREATE TABLE room_participants (
  id UUID PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES rooms(id),
  application_id UUID NOT NULL REFERENCES room_applications(id),
  application_member_id UUID NOT NULL REFERENCES room_application_members(id),
  user_id UUID NULL REFERENCES users(id),
  member_type application_member_type NOT NULL,
  status room_participant_status NOT NULL,
  attendance_status participant_attendance_status NOT NULL DEFAULT 'NOT_SET',
  accepted_at TIMESTAMPTZ NOT NULL,
  cancelled_at TIMESTAMPTZ NULL,
  removed_at TIMESTAMPTZ NULL,
  removed_by_user_id UUID NULL REFERENCES users(id),
  removal_reason_code VARCHAR(120) NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT room_participants_identity_shape CHECK (
    (member_type = 'USER' AND user_id IS NOT NULL)
    OR member_type = 'GUEST'
  ),
  CONSTRAINT room_participants_removed_shape CHECK (
    (status = 'REMOVED_BY_HOST' AND removed_at IS NOT NULL AND removed_by_user_id IS NOT NULL)
    OR (status <> 'REMOVED_BY_HOST')
  ),
  CONSTRAINT room_participants_unique_application_member UNIQUE (application_member_id)
);
CREATE INDEX room_participants_room_occupancy_idx ON room_participants (room_id, status, attendance_status);
CREATE INDEX room_participants_user_status_idx ON room_participants (user_id, status);
CREATE INDEX room_participants_application_idx ON room_participants (application_id, status);

COMMENT ON COLUMN room_applications.party_id IS 'Reserved for M7 Party; M2 solo applications always store NULL.';
COMMENT ON COLUMN room_applications.application_owner_key IS 'M2: USER:{requested_by_user_id}; future Party uses PARTY:{party_id}.';
COMMENT ON TABLE room_application_members IS 'Immutable snapshot of the members submitted for HOST review.';
COMMENT ON TABLE room_participants IS 'Accepted capacity records only; ACTIVE rows are canonical app occupancy.';
