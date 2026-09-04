ALTER TABLE rooms
  DROP CONSTRAINT IF EXISTS rooms_participation_fee_per_person_valid,
  DROP COLUMN IF EXISTS participation_fee_per_person;
