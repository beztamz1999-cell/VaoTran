export type NotificationCategory =
  | 'ROOM_UPDATES'
  | 'JOIN_REQUESTS'
  | 'PARTY_INVITES'
  | 'EMERGENCY_OPPORTUNITIES'
  | 'MATCH_REMINDERS'
  | 'RANK_UPDATES';

export interface NotificationPreferences {
  userId: string;
  roomUpdatesEnabled: boolean;
  joinRequestsEnabled: boolean;
  partyInvitesEnabled: boolean;
  emergencyOpportunitiesEnabled: boolean;
  matchRemindersEnabled: boolean;
  rankUpdatesEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface NotificationRecord {
  id: string;
  userId: string;
  type: string;
  category: NotificationCategory;
  entityType: string | null;
  entityId: string | null;
  title: string;
  body: string;
  templateKey: string;
  params: Record<string, unknown>;
  dedupeKey: string;
  isCritical: boolean;
  readAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export type PushPlatform = 'IOS' | 'ANDROID' | 'WEB';
export type PushDeliveryStatus = 'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED_RETRYABLE' | 'DEAD_LETTER' | 'SKIPPED';

export interface PushDevice {
  id: string;
  userId: string;
  platform: PushPlatform;
  pushToken: string;
  deviceId: string | null;
  enabled: boolean;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface PushDelivery {
  id: string;
  notificationId: string;
  deviceId: string;
  status: PushDeliveryStatus;
  attemptCount: number;
  nextAttemptAt: Date | null;
  lastError: string | null;
  sentAt: Date | null;
  deliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NotificationFeedPage {
  data: NotificationRecord[];
  nextCursor: string | null;
}

type PreferenceToggle = keyof Pick<NotificationPreferences,
  | 'roomUpdatesEnabled'
  | 'joinRequestsEnabled'
  | 'partyInvitesEnabled'
  | 'emergencyOpportunitiesEnabled'
  | 'matchRemindersEnabled'
  | 'rankUpdatesEnabled'>;

const categoryPreferenceField: Record<NotificationCategory, PreferenceToggle> = {
  ROOM_UPDATES: 'roomUpdatesEnabled',
  JOIN_REQUESTS: 'joinRequestsEnabled',
  PARTY_INVITES: 'partyInvitesEnabled',
  EMERGENCY_OPPORTUNITIES: 'emergencyOpportunitiesEnabled',
  MATCH_REMINDERS: 'matchRemindersEnabled',
  RANK_UPDATES: 'rankUpdatesEnabled',
};

export const preferenceFieldFor = (category: NotificationCategory): PreferenceToggle => categoryPreferenceField[category];

export const retryDelayMs = (attemptCount: number): number => {
  const schedule = [0, 10_000, 60_000, 300_000, 1_800_000];
  return schedule[Math.min(attemptCount, schedule.length - 1)] ?? 1_800_000;
};
