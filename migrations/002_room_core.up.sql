CREATE TYPE room_status AS ENUM ('DRAFT', 'OPEN', 'FULL', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');
CREATE TYPE equipment_supply_mode AS ENUM ('HOST_PROVIDES', 'PLAYER_BRINGS', 'MIXED', 'NOT_APPLICABLE');

CREATE TABLE rooms (
  id UUID PRIMARY KEY,
  sport_id UUID NOT NULL REFERENCES sports(id),
  host_user_id UUID NOT NULL REFERENCES users(id),
  title VARCHAR(255),
  venue_name VARCHAR(255) NOT NULL,
  venue_address VARCHAR(1000),
  latitude NUMERIC(9,6),
  longitude NUMERIC(9,6),
  scheduled_start_at TIMESTAMPTZ NOT NULL,
  scheduled_end_at TIMESTAMPTZ NOT NULL,
  actual_started_at TIMESTAMPTZ,
  start_source VARCHAR(32),
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  capacity INTEGER NOT NULL,
  host_participates BOOLEAN NOT NULL,
  reserved_external_count INTEGER NOT NULL DEFAULT 0,
  price_amount INTEGER,
  currency CHAR(3) NOT NULL DEFAULT 'VND',
  preferred_skill_min NUMERIC(4,2),
  preferred_skill_max NUMERIC(4,2),
  allow_emergency_replacement BOOLEAN NOT NULL DEFAULT TRUE,
  status room_status NOT NULL DEFAULT 'DRAFT',
  published_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT rooms_capacity_valid CHECK (capacity >= 1),
  CONSTRAINT rooms_reserved_external_nonnegative CHECK (reserved_external_count >= 0),
  CONSTRAINT rooms_baseline_occupancy_valid CHECK (
    capacity >= reserved_external_count + CASE WHEN host_participates THEN 1 ELSE 0 END
  ),
  CONSTRAINT rooms_time_window_valid CHECK (scheduled_end_at > scheduled_start_at),
  CONSTRAINT rooms_price_nonnegative CHECK (price_amount IS NULL OR price_amount >= 0),
  CONSTRAINT rooms_currency_vnd CHECK (currency = 'VND'),
  CONSTRAINT rooms_latitude_valid CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  CONSTRAINT rooms_longitude_valid CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  CONSTRAINT rooms_skill_range_valid CHECK (
    (preferred_skill_min IS NULL AND preferred_skill_max IS NULL)
    OR (
      preferred_skill_min BETWEEN 1 AND 10
      AND preferred_skill_max BETWEEN 1 AND 10
      AND preferred_skill_min <= preferred_skill_max
    )
  )
);
CREATE INDEX rooms_host_idx ON rooms (host_user_id, scheduled_start_at DESC);
CREATE INDEX rooms_sport_status_time_idx ON rooms (sport_id, status, scheduled_start_at);

CREATE TABLE room_equipment_policies (
  room_id UUID PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  supply_mode equipment_supply_mode NOT NULL,
  quantity_per_participant INTEGER,
  notes VARCHAR(1000),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT room_equipment_quantity_valid CHECK (quantity_per_participant IS NULL OR quantity_per_participant > 0)
);

CREATE TABLE room_equipment_options (
  id UUID PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  equipment_type VARCHAR(120) NOT NULL DEFAULT 'SHUTTLECOCK',
  brand VARCHAR(120),
  model VARCHAR(120),
  display_name VARCHAR(255) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT room_equipment_options_sort_nonnegative CHECK (sort_order >= 0)
);
CREATE INDEX room_equipment_options_room_idx ON room_equipment_options (room_id, sort_order, created_at);

CREATE TABLE room_change_logs (
  id UUID PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES rooms(id),
  changed_by_user_id UUID NOT NULL REFERENCES users(id),
  field_name VARCHAR(120) NOT NULL,
  old_value_json JSONB,
  new_value_json JSONB,
  is_material_change BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX room_change_logs_room_idx ON room_change_logs (room_id, created_at);

CREATE TABLE room_availability_projections (
  room_id UUID PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  host_slot INTEGER NOT NULL,
  reserved_external_count INTEGER NOT NULL,
  active_app_count INTEGER NOT NULL DEFAULT 0,
  effective_no_show_count INTEGER NOT NULL DEFAULT 0,
  occupied_slots INTEGER NOT NULL,
  available_public_slots INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT room_availability_host_slot_valid CHECK (host_slot IN (0, 1)),
  CONSTRAINT room_availability_external_nonnegative CHECK (reserved_external_count >= 0),
  CONSTRAINT room_availability_active_nonnegative CHECK (active_app_count >= 0),
  CONSTRAINT room_availability_no_show_nonnegative CHECK (effective_no_show_count >= 0),
  CONSTRAINT room_availability_occupied_nonnegative CHECK (occupied_slots >= 0),
  CONSTRAINT room_availability_public_nonnegative CHECK (available_public_slots >= 0)
);
