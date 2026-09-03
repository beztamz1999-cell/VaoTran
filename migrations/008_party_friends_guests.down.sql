DROP INDEX IF EXISTS room_application_members_source_party_member_idx;
DROP INDEX IF EXISTS room_applications_party_status_idx;
ALTER TABLE room_applications DROP CONSTRAINT IF EXISTS room_applications_party_id_fkey;

DROP INDEX IF EXISTS party_members_claim_expiry_idx;
DROP INDEX IF EXISTS party_members_party_idx;
DROP INDEX IF EXISTS party_members_unique_registered_user_idx;
DROP TABLE IF EXISTS party_members;

DROP INDEX IF EXISTS parties_sport_status_idx;
DROP INDEX IF EXISTS parties_owner_status_idx;
DROP TABLE IF EXISTS parties;

DROP INDEX IF EXISTS friendships_requester_status_idx;
DROP INDEX IF EXISTS friendships_addressee_status_idx;
DROP INDEX IF EXISTS friendships_unique_unordered_pair_idx;
DROP TABLE IF EXISTS friendships;

DROP TYPE IF EXISTS party_member_invite_status;
DROP TYPE IF EXISTS party_member_type;
DROP TYPE IF EXISTS party_status;
DROP TYPE IF EXISTS friendship_status;
