DROP TABLE IF EXISTS push_deliveries;
DROP TABLE IF EXISTS push_devices;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS notification_preferences;
DROP TYPE IF EXISTS push_delivery_status;
DROP TYPE IF EXISTS push_platform;
DROP INDEX IF EXISTS rooms_public_share_token_unique_idx;
ALTER TABLE rooms DROP COLUMN IF EXISTS public_share_token;
