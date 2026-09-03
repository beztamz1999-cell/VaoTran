import type { SqlExecutor, Transaction } from '../../platform/database/db.js';
import type { Friendship, FriendshipStatus, Party, PartyMember, PartyMemberInviteStatus, PartyMemberType, PartyStatus } from './domain.js';

type FriendshipRow = {
  id: string; requester_user_id: string; addressee_user_id: string; status: FriendshipStatus;
  created_at: Date; accepted_at: Date | null; updated_at: Date;
};
type PartyRow = {
  id: string; owner_user_id: string; sport_id: string; status: PartyStatus;
  created_at: Date; updated_at: Date; closed_at: Date | null;
};
type PartyMemberRow = {
  id: string; party_id: string; member_type: PartyMemberType; user_id: string | null; guest_label: string | null;
  invite_status: PartyMemberInviteStatus | null; claim_token_hash: string | null; claim_expires_at: Date | null;
  claimed_at: Date | null; created_at: Date; updated_at: Date;
};

const mapFriendship = (row: FriendshipRow): Friendship => ({
  id: row.id, requesterUserId: row.requester_user_id, addresseeUserId: row.addressee_user_id,
  status: row.status, createdAt: row.created_at, acceptedAt: row.accepted_at, updatedAt: row.updated_at,
});
const mapParty = (row: PartyRow): Party => ({
  id: row.id, ownerUserId: row.owner_user_id, sportId: row.sport_id, status: row.status,
  createdAt: row.created_at, updatedAt: row.updated_at, closedAt: row.closed_at,
});
const mapPartyMember = (row: PartyMemberRow): PartyMember => ({
  id: row.id, partyId: row.party_id, memberType: row.member_type, userId: row.user_id,
  guestLabel: row.guest_label, inviteStatus: row.invite_status, claimTokenHash: row.claim_token_hash,
  claimExpiresAt: row.claim_expires_at, claimedAt: row.claimed_at, createdAt: row.created_at, updatedAt: row.updated_at,
});

export interface PartyMemberWithName extends PartyMember { displayName: string | null; }

export class PartyRepository {
  async findSportByCode(executor: SqlExecutor, sportCode: string): Promise<{ id: string; code: string } | null> {
    const result = await executor.query<{ id: string; code: string }>(`SELECT id, code FROM sports WHERE code = $1`, [sportCode]);
    return result.rows[0] ?? null;
  }

  async findFriendshipByPair(executor: SqlExecutor, firstUserId: string, secondUserId: string, forUpdate = false): Promise<Friendship | null> {
    const result = await executor.query<FriendshipRow>(
      `SELECT * FROM friendships
       WHERE (requester_user_id = $1 AND addressee_user_id = $2)
          OR (requester_user_id = $2 AND addressee_user_id = $1)
       ${forUpdate ? 'FOR UPDATE' : ''}`,
      [firstUserId, secondUserId],
    );
    return result.rows[0] ? mapFriendship(result.rows[0]) : null;
  }

  async findFriendship(executor: SqlExecutor, friendshipId: string, forUpdate = false): Promise<Friendship | null> {
    const result = await executor.query<FriendshipRow>(`SELECT * FROM friendships WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [friendshipId]);
    return result.rows[0] ? mapFriendship(result.rows[0]) : null;
  }

  async insertFriendship(tx: Transaction, friendship: Friendship): Promise<void> {
    await tx.query(
      `INSERT INTO friendships (id, requester_user_id, addressee_user_id, status, created_at, accepted_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [friendship.id, friendship.requesterUserId, friendship.addresseeUserId, friendship.status, friendship.createdAt, friendship.acceptedAt, friendship.updatedAt],
    );
  }

  async updateFriendship(tx: Transaction, friendship: Friendship): Promise<void> {
    await tx.query(`UPDATE friendships SET status=$2, accepted_at=$3, updated_at=$4 WHERE id=$1`, [friendship.id, friendship.status, friendship.acceptedAt, friendship.updatedAt]);
  }

  async listAcceptedFriends(executor: SqlExecutor, userId: string): Promise<Array<{ friendship: Friendship; friendUserId: string; displayName: string | null }>> {
    const result = await executor.query<FriendshipRow & { friend_user_id: string; display_name: string | null }>(
      `SELECT f.*, CASE WHEN f.requester_user_id = $1 THEN f.addressee_user_id ELSE f.requester_user_id END AS friend_user_id,
              u.display_name
       FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.requester_user_id = $1 THEN f.addressee_user_id ELSE f.requester_user_id END
       WHERE (f.requester_user_id = $1 OR f.addressee_user_id = $1) AND f.status = 'ACCEPTED'
       ORDER BY f.accepted_at DESC, f.id`,
      [userId],
    );
    return result.rows.map((row) => ({ friendship: mapFriendship(row), friendUserId: row.friend_user_id, displayName: row.display_name }));
  }

  async insertParty(tx: Transaction, party: Party): Promise<void> {
    await tx.query(
      `INSERT INTO parties (id, owner_user_id, sport_id, status, created_at, updated_at, closed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [party.id, party.ownerUserId, party.sportId, party.status, party.createdAt, party.updatedAt, party.closedAt],
    );
  }

  async findParty(executor: SqlExecutor, partyId: string, forUpdate = false): Promise<Party | null> {
    const result = await executor.query<PartyRow>(`SELECT * FROM parties WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [partyId]);
    return result.rows[0] ? mapParty(result.rows[0]) : null;
  }

  async updateParty(tx: Transaction, party: Party): Promise<void> {
    await tx.query(`UPDATE parties SET status=$2, updated_at=$3, closed_at=$4 WHERE id=$1`, [party.id, party.status, party.updatedAt, party.closedAt]);
  }

  async insertPartyMember(tx: Transaction, member: PartyMember): Promise<void> {
    await tx.query(
      `INSERT INTO party_members (
        id, party_id, member_type, user_id, guest_label, invite_status, claim_token_hash, claim_expires_at, claimed_at, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [member.id, member.partyId, member.memberType, member.userId, member.guestLabel, member.inviteStatus,
        member.claimTokenHash, member.claimExpiresAt, member.claimedAt, member.createdAt, member.updatedAt],
    );
  }

  async findPartyMember(executor: SqlExecutor, partyMemberId: string, forUpdate = false): Promise<PartyMember | null> {
    const result = await executor.query<PartyMemberRow>(`SELECT * FROM party_members WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [partyMemberId]);
    return result.rows[0] ? mapPartyMember(result.rows[0]) : null;
  }

  async findPartyMemberByClaimHash(executor: SqlExecutor, claimTokenHash: string, forUpdate = false): Promise<PartyMember | null> {
    const result = await executor.query<PartyMemberRow>(
      `SELECT * FROM party_members WHERE claim_token_hash = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [claimTokenHash],
    );
    return result.rows[0] ? mapPartyMember(result.rows[0]) : null;
  }

  async listPartyMembers(executor: SqlExecutor, partyId: string, forUpdate = false): Promise<PartyMember[]> {
    const result = await executor.query<PartyMemberRow>(
      `SELECT * FROM party_members WHERE party_id = $1 ORDER BY created_at, id${forUpdate ? ' FOR UPDATE' : ''}`,
      [partyId],
    );
    return result.rows.map(mapPartyMember);
  }

  async listPartyMembersWithNames(executor: SqlExecutor, partyId: string): Promise<PartyMemberWithName[]> {
    const result = await executor.query<PartyMemberRow & { display_name: string | null }>(
      `SELECT m.*, u.display_name FROM party_members m LEFT JOIN users u ON u.id = m.user_id
       WHERE m.party_id = $1 ORDER BY m.created_at, m.id`,
      [partyId],
    );
    return result.rows.map((row) => ({ ...mapPartyMember(row), displayName: row.display_name }));
  }

  async updatePartyMember(tx: Transaction, member: PartyMember): Promise<void> {
    await tx.query(
      `UPDATE party_members SET member_type=$2, user_id=$3, guest_label=$4, invite_status=$5,
       claim_token_hash=$6, claim_expires_at=$7, claimed_at=$8, updated_at=$9 WHERE id=$1`,
      [member.id, member.memberType, member.userId, member.guestLabel, member.inviteStatus,
        member.claimTokenHash, member.claimExpiresAt, member.claimedAt, member.updatedAt],
    );
  }

  async deletePartyMember(tx: Transaction, partyMemberId: string): Promise<void> {
    await tx.query(`DELETE FROM party_members WHERE id = $1`, [partyMemberId]);
  }

  async hasActiveApplication(executor: SqlExecutor, partyId: string): Promise<boolean> {
    const result = await executor.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM room_applications WHERE party_id = $1
         AND status IN ('REQUESTED', 'WAITLISTED', 'ACCEPTED')
       ) AS exists`,
      [partyId],
    );
    return result.rows[0]?.exists ?? false;
  }

  async claimGuestIdentity(tx: Transaction, partyMemberId: string, userId: string, now: Date): Promise<void> {
    await tx.query(
      `UPDATE party_members
       SET member_type = 'REGISTERED_USER', user_id = $2, guest_label = NULL, invite_status = 'CONFIRMED',
           claim_token_hash = NULL, claim_expires_at = NULL, claimed_at = $3, updated_at = $3
       WHERE id = $1`,
      [partyMemberId, userId, now],
    );
    await tx.query(
      `UPDATE room_application_members
       SET member_type = 'USER', user_id = $2, guest_label = NULL
       WHERE source_party_member_id = $1 AND member_type = 'GUEST'`,
      [partyMemberId, userId],
    );
    await tx.query(
      `UPDATE room_participants p SET member_type = 'USER', user_id = $2, updated_at = $3, version = version + 1
       FROM room_application_members m
       WHERE p.application_member_id = m.id AND m.source_party_member_id = $1 AND p.member_type = 'GUEST'`,
      [partyMemberId, userId, now],
    );
  }
}
