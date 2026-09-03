import { createHash, randomBytes } from 'node:crypto';
import { Clock, DomainError, newId, systemClock } from '../../platform/core.js';
import type { PostgresDatabase, Transaction } from '../../platform/database/db.js';
import { PostgresIdempotencyGate, type IdempotencyResult } from '../../platform/idempotency.js';
import { appendOutboxEvent, makeDomainEvent } from '../../platform/outbox/outbox.js';
import type { CommandMeta } from '../room/service.js';
import {
  assertDistinctPartyMemberUser,
  assertFriendshipCanBeRequested,
  assertGuestClaimable,
  assertPartyEditable,
  assertPartyOwner,
  assertRegisteredInvitee,
  canPartyBeReady,
  type Friendship,
  type Party,
  type PartyMember,
} from './domain.js';
import { PartyRepository, type PartyMemberWithName } from './repository.js';

export interface CreatePartyInput { sportCode: string; }
export interface AddPartyMemberInput {
  memberType: 'REGISTERED_USER' | 'GUEST';
  userId?: string;
  guestLabel?: string;
}
export interface GuestClaimResult { partyId: string; partyMemberId: string; claimedUserId: string; }
export interface PartyView { party: Party; members: PartyMemberWithName[]; }

const claimHash = (token: string): string => createHash('sha256').update(token).digest('hex');

export class PartyService {
  private readonly idempotency: PostgresIdempotencyGate;

  constructor(
    private readonly db: PostgresDatabase,
    private readonly parties: PartyRepository,
    private readonly clock: Clock = systemClock,
  ) {
    this.idempotency = new PostgresIdempotencyGate(db, clock);
  }

  async requestFriendship(targetUserId: string, meta: CommandMeta): Promise<IdempotencyResult<Friendship>> {
    assertFriendshipCanBeRequested(meta.actorUserId, targetUserId);
    return this.idempotency.execute(meta.idempotency, 201, async (tx) => {
      const existing = await this.parties.findFriendshipByPair(tx, meta.actorUserId, targetUserId, true);
      if (existing) {
        throw new DomainError('FRIENDSHIP_NOT_ACTIONABLE', 'A friendship record already exists for these users.', { friendship_id: existing.id, status: existing.status });
      }
      const now = this.clock.now();
      const friendship: Friendship = {
        id: newId(), requesterUserId: meta.actorUserId, addresseeUserId: targetUserId, status: 'PENDING',
        createdAt: now, acceptedAt: null, updatedAt: now,
      };
      await this.parties.insertFriendship(tx, friendship);
      return friendship;
    });
  }

  async acceptFriendship(friendshipId: string, meta: CommandMeta): Promise<IdempotencyResult<Friendship>> {
    return this.respondFriendship(friendshipId, meta, 'ACCEPTED');
  }

  async declineFriendship(friendshipId: string, meta: CommandMeta): Promise<IdempotencyResult<Friendship>> {
    return this.respondFriendship(friendshipId, meta, 'DECLINED');
  }

  async listFriends(actorUserId: string) {
    return this.parties.listAcceptedFriends(this.db, actorUserId);
  }

  async createParty(input: CreatePartyInput, meta: CommandMeta): Promise<IdempotencyResult<PartyView>> {
    return this.idempotency.execute(meta.idempotency, 201, async (tx) => {
      const sport = await this.parties.findSportByCode(tx, input.sportCode);
      if (!sport) throw new DomainError('SPORT_NOT_FOUND', 'Sport was not found.');
      const now = this.clock.now();
      const party: Party = {
        id: newId(), ownerUserId: meta.actorUserId, sportId: sport.id, status: 'READY', createdAt: now, updatedAt: now, closedAt: null,
      };
      const owner: PartyMember = {
        id: newId(), partyId: party.id, memberType: 'REGISTERED_USER', userId: meta.actorUserId,
        guestLabel: null, inviteStatus: 'CONFIRMED', claimTokenHash: null, claimExpiresAt: null, claimedAt: null,
        createdAt: now, updatedAt: now,
      };
      await this.parties.insertParty(tx, party);
      await this.parties.insertPartyMember(tx, owner);
      await this.event(tx, 'PARTY_CREATED', meta.actorUserId, party.id, { party_id: party.id, sport_id: party.sportId, owner_user_id: party.ownerUserId });
      await this.event(tx, 'PARTY_BECAME_READY', meta.actorUserId, party.id, { party_id: party.id, reason: 'OWNER_ONLY' });
      return { party, members: [{ ...owner, displayName: null }] };
    });
  }

  async getParty(partyId: string, actorUserId: string): Promise<PartyView> {
    const party = await this.parties.findParty(this.db, partyId);
    if (!party) throw new DomainError('PARTY_NOT_FOUND', 'Party was not found.');
    const members = await this.parties.listPartyMembersWithNames(this.db, partyId);
    const actorIsMember = members.some((member) => member.userId === actorUserId);
    if (!actorIsMember) throw new DomainError('FORBIDDEN', 'Only Party members can view this Party.');
    return { party, members };
  }

  async addMember(partyId: string, input: AddPartyMemberInput, meta: CommandMeta): Promise<IdempotencyResult<{ party: Party; member: PartyMember; claimToken: string | null }>> {
    if (input.memberType === 'REGISTERED_USER' && !input.userId) throw new DomainError('VALIDATION_ERROR', 'user_id is required for a registered member.');
    if (input.memberType === 'GUEST' && !input.guestLabel?.trim()) throw new DomainError('VALIDATION_ERROR', 'guest_label is required for a Guest member.');
    return this.idempotency.execute(meta.idempotency, 201, async (tx) => {
      const party = await this.requireOwnedEditableParty(tx, partyId, meta.actorUserId);
      await this.assertPartyHasNoActiveApplication(tx, party.id);
      const members = await this.parties.listPartyMembers(tx, party.id, true);
      const now = this.clock.now();
      let member: PartyMember;
      let rawClaimToken: string | null = null;
      if (input.memberType === 'REGISTERED_USER') {
        assertDistinctPartyMemberUser(members, input.userId!);
        const friendship = await this.parties.findFriendshipByPair(tx, meta.actorUserId, input.userId!, true);
        if (!friendship || friendship.status !== 'ACCEPTED') {
          throw new DomainError('FRIENDSHIP_REQUIRED', 'Only an accepted friend can be added as a registered Party member.');
        }
        member = {
          id: newId(), partyId: party.id, memberType: 'REGISTERED_USER', userId: input.userId!, guestLabel: null,
          inviteStatus: 'INVITED', claimTokenHash: null, claimExpiresAt: null, claimedAt: null, createdAt: now, updatedAt: now,
        };
      } else {
        rawClaimToken = randomBytes(32).toString('base64url');
        member = {
          id: newId(), partyId: party.id, memberType: 'GUEST', userId: null, guestLabel: input.guestLabel!.trim(), inviteStatus: null,
          claimTokenHash: claimHash(rawClaimToken), claimExpiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000), claimedAt: null,
          createdAt: now, updatedAt: now,
        };
      }
      await this.parties.insertPartyMember(tx, member);
      const updatedParty = await this.recomputePartyStatus(tx, party, [...members, member], now);
      await this.event(tx, input.memberType === 'GUEST' ? 'GUEST_ADDED' : 'PARTY_MEMBER_INVITED', meta.actorUserId, party.id, {
        party_id: party.id, party_member_id: member.id, member_type: member.memberType,
      });
      return { party: updatedParty, member, claimToken: rawClaimToken };
    });
  }

  async confirmMember(partyId: string, partyMemberId: string, meta: CommandMeta): Promise<IdempotencyResult<{ party: Party; member: PartyMember }>> {
    return this.respondMember(partyId, partyMemberId, meta, 'CONFIRMED');
  }

  async declineMember(partyId: string, partyMemberId: string, meta: CommandMeta): Promise<IdempotencyResult<{ party: Party; member: PartyMember }>> {
    return this.respondMember(partyId, partyMemberId, meta, 'DECLINED');
  }

  async removeMember(partyId: string, partyMemberId: string, meta: CommandMeta): Promise<IdempotencyResult<{ party: Party }>> {
    return this.idempotency.execute(meta.idempotency, 200, async (tx) => {
      const party = await this.requireOwnedEditableParty(tx, partyId, meta.actorUserId);
      await this.assertPartyHasNoActiveApplication(tx, party.id);
      const member = await this.parties.findPartyMember(tx, partyMemberId, true);
      if (!member || member.partyId !== party.id) throw new DomainError('PARTY_MEMBER_NOT_FOUND', 'Party member was not found.');
      if (member.userId === party.ownerUserId) throw new DomainError('PARTY_MEMBER_NOT_ACTIONABLE', 'Party owner cannot be removed.');
      await this.parties.deletePartyMember(tx, member.id);
      const remaining = (await this.parties.listPartyMembers(tx, party.id, true)).filter((item) => item.id !== member.id);
      const updatedParty = await this.recomputePartyStatus(tx, party, remaining, this.clock.now());
      return { party: updatedParty };
    });
  }

  async claimGuest(claimToken: string, actorUserId: string, meta: CommandMeta): Promise<IdempotencyResult<GuestClaimResult>> {
    if (!claimToken) throw new DomainError('GUEST_CLAIM_INVALID', 'Guest claim token is invalid.');
    return this.idempotency.execute(meta.idempotency, 200, async (tx) => {
      const member = await this.parties.findPartyMemberByClaimHash(tx, claimHash(claimToken), true);
      if (!member) throw new DomainError('GUEST_CLAIM_INVALID', 'Guest claim token is invalid.');
      const now = this.clock.now();
      assertGuestClaimable(member, now);
      const party = await this.parties.findParty(tx, member.partyId, true);
      if (!party) throw new DomainError('PARTY_NOT_FOUND', 'Party was not found.');
      const members = await this.parties.listPartyMembers(tx, party.id, true);
      assertDistinctPartyMemberUser(members.filter((item) => item.id !== member.id), actorUserId);
      await this.parties.claimGuestIdentity(tx, member.id, actorUserId, now);
      await this.event(tx, 'GUEST_CLAIMED', actorUserId, party.id, { party_id: party.id, party_member_id: member.id, claimed_user_id: actorUserId });
      return { partyId: party.id, partyMemberId: member.id, claimedUserId: actorUserId };
    });
  }

  private async respondFriendship(friendshipId: string, meta: CommandMeta, nextStatus: 'ACCEPTED' | 'DECLINED'): Promise<IdempotencyResult<Friendship>> {
    return this.idempotency.execute(meta.idempotency, 200, async (tx) => {
      const friendship = await this.parties.findFriendship(tx, friendshipId, true);
      if (!friendship) throw new DomainError('FRIENDSHIP_NOT_FOUND', 'Friendship was not found.');
      if (friendship.addresseeUserId !== meta.actorUserId) throw new DomainError('FORBIDDEN', 'Only the friendship recipient can respond.');
      if (friendship.status !== 'PENDING') throw new DomainError('FRIENDSHIP_NOT_ACTIONABLE', 'Friendship request is already resolved.');
      const now = this.clock.now();
      friendship.status = nextStatus;
      friendship.acceptedAt = nextStatus === 'ACCEPTED' ? now : null;
      friendship.updatedAt = now;
      await this.parties.updateFriendship(tx, friendship);
      return friendship;
    });
  }

  private async respondMember(partyId: string, partyMemberId: string, meta: CommandMeta, nextStatus: 'CONFIRMED' | 'DECLINED'): Promise<IdempotencyResult<{ party: Party; member: PartyMember }>> {
    return this.idempotency.execute(meta.idempotency, 200, async (tx) => {
      const party = await this.parties.findParty(tx, partyId, true);
      if (!party) throw new DomainError('PARTY_NOT_FOUND', 'Party was not found.');
      assertPartyEditable(party);
      await this.assertPartyHasNoActiveApplication(tx, party.id);
      const member = await this.parties.findPartyMember(tx, partyMemberId, true);
      if (!member || member.partyId !== party.id) throw new DomainError('PARTY_MEMBER_NOT_FOUND', 'Party member was not found.');
      assertRegisteredInvitee(member, meta.actorUserId);
      const now = this.clock.now();
      member.inviteStatus = nextStatus;
      member.updatedAt = now;
      await this.parties.updatePartyMember(tx, member);
      const members = await this.parties.listPartyMembers(tx, party.id, true);
      const updatedParty = await this.recomputePartyStatus(tx, party, members, now);
      await this.event(tx, nextStatus === 'CONFIRMED' ? 'PARTY_MEMBER_CONFIRMED' : 'PARTY_MEMBER_DECLINED', meta.actorUserId, party.id, {
        party_id: party.id, party_member_id: member.id,
      });
      return { party: updatedParty, member };
    });
  }

  private async requireOwnedEditableParty(tx: Transaction, partyId: string, actorUserId: string): Promise<Party> {
    const party = await this.parties.findParty(tx, partyId, true);
    if (!party) throw new DomainError('PARTY_NOT_FOUND', 'Party was not found.');
    assertPartyOwner(party, actorUserId);
    assertPartyEditable(party);
    return party;
  }

  private async assertPartyHasNoActiveApplication(tx: Transaction, partyId: string): Promise<void> {
    if (await this.parties.hasActiveApplication(tx, partyId)) {
      throw new DomainError('PARTY_APPLICATION_ACTIVE', 'Party composition cannot be changed while a submitted application is active.');
    }
  }

  private async recomputePartyStatus(tx: Transaction, party: Party, members: PartyMember[], now: Date): Promise<Party> {
    const nextStatus = canPartyBeReady(members) ? 'READY' : 'FORMING';
    const changed = party.status !== nextStatus;
    party.status = nextStatus;
    party.updatedAt = now;
    await this.parties.updateParty(tx, party);
    if (changed && nextStatus === 'READY') {
      await this.event(tx, 'PARTY_BECAME_READY', party.ownerUserId, party.id, { party_id: party.id });
    }
    return party;
  }

  private async event(tx: Transaction, eventType: string, actorUserId: string, aggregateId: string, payload: Record<string, unknown>): Promise<void> {
    await appendOutboxEvent(tx, makeDomainEvent({
      eventType, aggregateType: 'PARTY', aggregateId, actorUserId,
      correlationId: null, causationId: null, schemaVersion: 1, payload,
    }, this.clock));
  }
}
