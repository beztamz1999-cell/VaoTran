import { domainError } from '../../platform/core.js';

export type FriendshipStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'BLOCKED';
export type PartyStatus = 'FORMING' | 'READY' | 'CLOSED';
export type PartyMemberType = 'REGISTERED_USER' | 'GUEST';
export type PartyMemberInviteStatus = 'INVITED' | 'CONFIRMED' | 'DECLINED';

export interface Friendship {
  id: string;
  requesterUserId: string;
  addresseeUserId: string;
  status: FriendshipStatus;
  createdAt: Date;
  acceptedAt: Date | null;
  updatedAt: Date;
}

export interface Party {
  id: string;
  ownerUserId: string;
  sportId: string;
  status: PartyStatus;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
}

export interface PartyMember {
  id: string;
  partyId: string;
  memberType: PartyMemberType;
  userId: string | null;
  guestLabel: string | null;
  inviteStatus: PartyMemberInviteStatus | null;
  claimTokenHash: string | null;
  claimExpiresAt: Date | null;
  claimedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PartyMemberSnapshot {
  sourcePartyMemberId: string;
  memberType: 'USER' | 'GUEST';
  userId: string | null;
  guestLabel: string | null;
}

export const assertPartyOwner = (party: Party, actorUserId: string): void => {
  if (party.ownerUserId !== actorUserId) domainError('PARTY_NOT_OWNER', 'Only the Party owner can perform this action.');
};

export const assertPartyEditable = (party: Party): void => {
  if (party.status === 'CLOSED') domainError('PARTY_MEMBER_NOT_ACTIONABLE', 'Closed Party cannot be modified.');
};

export const assertPartyReady = (party: Party): void => {
  if (party.status !== 'READY') domainError('PARTY_NOT_READY', 'Party must be READY before it can be submitted.');
};

export const assertRegisteredInvitee = (member: PartyMember, actorUserId: string): void => {
  if (member.memberType !== 'REGISTERED_USER' || member.userId !== actorUserId || member.inviteStatus !== 'INVITED') {
    domainError('PARTY_MEMBER_NOT_ACTIONABLE', 'Only the invited registered member can respond to this invite.');
  }
};

export const canPartyBeReady = (members: PartyMember[]): boolean => members.length > 0
  && members.every((member) => member.memberType === 'GUEST' || member.inviteStatus === 'CONFIRMED');

export const memberToSnapshot = (member: PartyMember): PartyMemberSnapshot => {
  if (member.memberType === 'REGISTERED_USER') {
    if (!member.userId || member.inviteStatus !== 'CONFIRMED') {
      domainError('PARTY_NOT_READY', 'Every registered Party member must be confirmed.');
    }
    return { sourcePartyMemberId: member.id, memberType: 'USER', userId: member.userId, guestLabel: null };
  }
  return { sourcePartyMemberId: member.id, memberType: 'GUEST', userId: null, guestLabel: member.guestLabel };
};

export const assertDistinctPartyMemberUser = (members: PartyMember[], userId: string): void => {
  if (members.some((member) => member.userId === userId)) {
    domainError('VALIDATION_ERROR', 'User is already a Party member.');
  }
};

export const assertGuestClaimable = (member: PartyMember, now: Date): void => {
  if (member.memberType !== 'GUEST' || !member.claimTokenHash || !member.claimExpiresAt || member.claimExpiresAt <= now) {
    domainError('GUEST_CLAIM_INVALID', 'Guest claim token is invalid or expired.');
  }
};

export const assertFriendshipCanBeRequested = (actorUserId: string, targetUserId: string): void => {
  if (actorUserId === targetUserId) domainError('VALIDATION_ERROR', 'Cannot send a friendship request to yourself.');
};
