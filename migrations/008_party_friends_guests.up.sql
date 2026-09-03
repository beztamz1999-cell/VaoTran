CREATE TYPE friendship_status AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'BLOCKED');
CREATE TYPE party_status AS ENUM ('FORMING', 'READY', 'CLOSED');
CREATE TYPE party_member_type AS ENUM ('REGISTERED_USER', 'GUEST');
CREATE TYPE party_member_invite_status AS ENUM ('INVITED', 'CONFIRMED', 'DECLINED');

CREATE TABLE friendships (
  id UUID PRIMARY KEY,
  requester_user_id UUID NOT NULL REFERENCES users(id),
  addressee_user_id UUID NOT NULL REFERENCES users(id),
  status friendship_status NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT friendships_distinct_users CHECK (requester_user_id <> addressee_user_id),
  CONSTRAINT friendships_accepted_shape CHECK (
    (status = 'ACCEPTED' AND accepted_at IS NOT NULL)
    OR (status <> 'ACCEPTED')
  )
);
CREATE UNIQUE INDEX friendships_unique_unordered_pair_idx
  ON friendships (LEAST(requester_user_id, addressee_user_id), GREATEST(requester_user_id, addressee_user_id));
CREATE INDEX friendships_addressee_status_idx ON friendships (addressee_user_id, status, created_at DESC);
CREATE INDEX friendships_requester_status_idx ON friendships (requester_user_id, status, created_at DESC);

CREATE TABLE parties (
  id UUID PRIMARY KEY,
  owner_user_id UUID NOT NULL REFERENCES users(id),
  sport_id UUID NOT NULL REFERENCES sports(id),
  status party_status NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ NULL,
  CONSTRAINT parties_closed_shape CHECK (
    (status = 'CLOSED' AND closed_at IS NOT NULL)
    OR (status <> 'CLOSED')
  )
);
CREATE INDEX parties_owner_status_idx ON parties (owner_user_id, status, created_at DESC);
CREATE INDEX parties_sport_status_idx ON parties (sport_id, status, created_at DESC);

CREATE TABLE party_members (
  id UUID PRIMARY KEY,
  party_id UUID NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  member_type party_member_type NOT NULL,
  user_id UUID NULL REFERENCES users(id),
  guest_label VARCHAR(120) NULL,
  invite_status party_member_invite_status NULL,
  claim_token_hash CHAR(64) UNIQUE NULL,
  claim_expires_at TIMESTAMPTZ NULL,
  claimed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT party_members_identity_shape CHECK (
    (member_type = 'REGISTERED_USER' AND user_id IS NOT NULL AND guest_label IS NULL AND invite_status IS NOT NULL
      AND claim_token_hash IS NULL AND claim_expires_at IS NULL)
    OR (member_type = 'GUEST' AND user_id IS NULL AND guest_label IS NOT NULL AND invite_status IS NULL
      AND ((claim_token_hash IS NULL AND claim_expires_at IS NULL) OR (claim_token_hash IS NOT NULL AND claim_expires_at IS NOT NULL)))
  ),
  CONSTRAINT party_members_claimed_shape CHECK (
    (claimed_at IS NULL) OR (member_type = 'REGISTERED_USER' AND invite_status = 'CONFIRMED')
  )
);
CREATE UNIQUE INDEX party_members_unique_registered_user_idx
  ON party_members (party_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX party_members_party_idx ON party_members (party_id, created_at, id);
CREATE INDEX party_members_claim_expiry_idx ON party_members (claim_expires_at) WHERE claim_token_hash IS NOT NULL;

ALTER TABLE room_applications
  ADD CONSTRAINT room_applications_party_id_fkey
  FOREIGN KEY (party_id) REFERENCES parties(id);

CREATE INDEX room_applications_party_status_idx
  ON room_applications (party_id, status, requested_at DESC) WHERE party_id IS NOT NULL;
CREATE INDEX room_application_members_source_party_member_idx
  ON room_application_members (source_party_member_id) WHERE source_party_member_id IS NOT NULL;

COMMENT ON TABLE friendships IS 'M7 relationship consent. Unordered pair uniqueness prevents duplicate reciprocal requests.';
COMMENT ON TABLE parties IS 'M7 one-time Party aggregate. Only READY parties can be used to create Room applications.';
COMMENT ON TABLE party_members IS 'M7 Party composition. claim_token_hash stores only a SHA-256 hash of a high-entropy guest claim token.';
COMMENT ON COLUMN room_applications.party_id IS 'M7 immutable Party snapshot provenance. Existing member records remain the reviewable application source of truth.';
