ALTER TABLE rooms
  ADD COLUMN participation_fee_per_person INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT rooms_participation_fee_per_person_valid
    CHECK (participation_fee_per_person >= 0 AND participation_fee_per_person <= 10000000);
