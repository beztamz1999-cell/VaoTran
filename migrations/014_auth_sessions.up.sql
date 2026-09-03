-- Private-alpha credential and opaque-session foundation. Existing users remain valid and
-- are not assigned credentials or default passwords by this migration.
CREATE TABLE auth_credentials (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  email_normalized VARCHAR(320) NOT NULL UNIQUE,
  password_hash VARCHAR(512) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT auth_credentials_email_normalized_valid CHECK (email_normalized = lower(trim(email_normalized)))
);

CREATE TABLE auth_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  token_hash CHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NULL,
  CONSTRAINT auth_sessions_expiry_valid CHECK (expires_at > created_at)
);

CREATE INDEX auth_sessions_active_token_lookup_idx
  ON auth_sessions (token_hash, expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX auth_sessions_user_active_idx
  ON auth_sessions (user_id, expires_at DESC)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE auth_credentials IS 'Private-alpha credential records. Passwords are Argon2 hashes only.';
COMMENT ON TABLE auth_sessions IS 'Opaque bearer sessions. token_hash stores SHA-256 of a random token; raw tokens are never persisted.';
