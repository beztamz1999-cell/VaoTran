CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE rooms
  ADD COLUMN public_share_token VARCHAR(96);

UPDATE rooms
SET public_share_token = encode(gen_random_bytes(32), 'hex')
WHERE published_at IS NOT NULL
  AND public_share_token IS NULL;

CREATE UNIQUE INDEX rooms_public_share_token_unique_idx
  ON rooms (public_share_token)
  WHERE public_share_token IS NOT NULL;

CREATE TYPE push_platform AS ENUM ('IOS', 'ANDROID', 'WEB');
CREATE TYPE push_delivery_status AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED_RETRYABLE', 'DEAD_LETTER', 'SKIPPED');

CREATE TABLE notification_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  room_updates_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  join_requests_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  party_invites_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  emergency_opportunities_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  match_reminders_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  rank_updates_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE notifications (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(120) NOT NULL,
  category VARCHAR(80) NOT NULL,
  entity_type VARCHAR(80),
  entity_id UUID,
  title VARCHAR(255) NOT NULL,
  body VARCHAR(1000) NOT NULL,
  template_key VARCHAR(160) NOT NULL,
  params_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key VARCHAR(255) NOT NULL,
  is_critical BOOLEAN NOT NULL DEFAULT FALSE,
  read_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT notifications_dedupe_per_user UNIQUE (user_id, dedupe_key)
);
CREATE INDEX notifications_user_feed_idx ON notifications (user_id, created_at DESC, id DESC);
CREATE INDEX notifications_user_unread_idx ON notifications (user_id, read_at, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX notifications_expiry_idx ON notifications (expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE push_devices (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform push_platform NOT NULL,
  push_token VARCHAR(2048) NOT NULL UNIQUE,
  device_id VARCHAR(255),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX push_devices_user_enabled_idx ON push_devices (user_id, enabled, updated_at DESC);

CREATE TABLE push_deliveries (
  id UUID PRIMARY KEY,
  notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES push_devices(id) ON DELETE CASCADE,
  status push_delivery_status NOT NULL DEFAULT 'PENDING',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  last_error VARCHAR(2048),
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT push_deliveries_attempt_count_nonnegative CHECK (attempt_count >= 0),
  CONSTRAINT push_deliveries_notification_device_unique UNIQUE (notification_id, device_id)
);
CREATE INDEX push_deliveries_dispatch_idx ON push_deliveries (status, next_attempt_at, created_at);

COMMENT ON COLUMN rooms.public_share_token IS 'M8 high-entropy public capability token. It resolves current Room state only and never contains a Room snapshot.';
COMMENT ON TABLE notifications IS 'M8 in-app notification projection. It is derived from outbox events and is not business source of truth.';
COMMENT ON TABLE notification_preferences IS 'M8 user preference baseline. Critical operational updates still create an in-app notification.';
COMMENT ON TABLE push_deliveries IS 'M8 asynchronous delivery attempts. Failure never rolls back source Room/Application/Rating state.';
