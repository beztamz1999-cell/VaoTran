CREATE TABLE room_images (
  id UUID PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  storage_key VARCHAR(255) NOT NULL UNIQUE,
  mime_type VARCHAR(64) NOT NULL,
  sort_order INTEGER NOT NULL,
  is_cover BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT room_images_sort_nonnegative CHECK (sort_order >= 0),
  CONSTRAINT room_images_mime_allowed CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp'))
);
CREATE INDEX room_images_room_sort_idx ON room_images(room_id, sort_order, created_at);
CREATE UNIQUE INDEX room_images_one_cover_per_room_idx ON room_images(room_id) WHERE is_cover;
