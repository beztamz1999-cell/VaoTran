import express, { type NextFunction, type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { z, ZodError } from 'zod';
import { config, DomainError, logger, newId } from '../core.js';
import { ContextCurrentUserProvider, DevelopmentHeaderActorResolver, type ActorResolver, type AuthContext, type CurrentUserProvider } from '../auth/context.js';
import { metrics } from '../observability/metrics.js';
import type { ReadinessProbe } from '../observability/readiness.js';
import { IdentityService } from '../../modules/identity/service.js';
import { RoomLifecycleService } from '../../modules/room/lifecycle-service.js';
import { RoomService, type CommandMeta, type CreateRoomInput, type UpdateRoomInput } from '../../modules/room/service.js';
import { resolveGoogleMapsLink } from '../../modules/room/google-maps.js';
import { ParticipationService } from '../../modules/participation/service.js';
import { SearchService } from '../../modules/search/service.js';
import { ReliabilityService } from '../../modules/reliability/service.js';
import { SkillService } from '../../modules/ranking/service.js';
import { PartyService } from '../../modules/party/service.js';
import { NotificationService } from '../../modules/notification/service.js';
import { OperationsService } from '../../modules/operations/operations-service.js';
import { AnalyticsService } from '../../modules/analytics/analytics-service.js';
import { AuthService } from '../../modules/auth/service.js';

interface RequestContext extends Request {
  authContext?: AuthContext;
  actorUserId?: string;
  correlationId?: string;
  requestStartedAt?: number;
}

const isoDate = z.string().datetime({ offset: true }).transform((value) => new Date(value));
const nullableNumber = z.number().finite().nullable();
const supplyModes = z.enum(['HOST_PROVIDES', 'PLAYER_BRINGS', 'MIXED', 'NOT_APPLICABLE']);
const equipmentSchema = z.object({
  supply_mode: supplyModes,
  quantity_per_participant: z.number().int().positive().nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  allowed_options: z.array(z.object({
    display_name: z.string().trim().min(1).max(255),
    equipment_type: z.string().trim().min(1).max(120).optional(),
    brand: z.string().trim().max(120).nullable().optional(),
    model: z.string().trim().max(120).nullable().optional(),
  })).max(50).optional(),
});

const createRoomSchema = z.object({
  sport_code: z.string().trim().min(1).max(50),
  title: z.string().trim().min(1).max(255).nullable().optional(),
  venue: z.object({
    name: z.string().trim().min(1).max(255),
    address: z.string().trim().max(1000).nullable().optional(),
    latitude: nullableNumber.optional(),
    longitude: nullableNumber.optional(),
  }),
  scheduled_start_at: isoDate,
  scheduled_end_at: isoDate,
  capacity: z.number().int().positive(),
  host_participates: z.boolean(),
  reserved_external_count: z.number().int().nonnegative(),
  price_amount: z.number().int().nonnegative().nullable().optional(),
  currency: z.literal('VND').optional(),
  preferred_skill: z.object({ min_score: nullableNumber.optional(), max_score: nullableNumber.optional() }).nullable().optional(),
  equipment: equipmentSchema,
  allow_emergency_replacement: z.boolean(),
});
const googleMapsLinkSchema = z.object({ google_maps_url: z.string().trim().url().max(4096) });

const updateRoomSchema = z.object({
  expected_version: z.number().int().positive().optional(),
  title: z.string().trim().min(1).max(255).nullable().optional(),
  venue: z.object({
    name: z.string().trim().min(1).max(255).optional(),
    address: z.string().trim().max(1000).nullable().optional(),
    latitude: nullableNumber.optional(),
    longitude: nullableNumber.optional(),
  }).optional(),
  scheduled_start_at: isoDate.optional(),
  scheduled_end_at: isoDate.optional(),
  capacity: z.number().int().positive().optional(),
  host_participates: z.boolean().optional(),
  reserved_external_count: z.number().int().nonnegative().optional(),
  price_amount: z.number().int().nonnegative().nullable().optional(),
  currency: z.literal('VND').optional(),
  preferred_skill: z.object({ min_score: nullableNumber.optional(), max_score: nullableNumber.optional() }).nullable().optional(),
  equipment: equipmentSchema.optional(),
  allow_emergency_replacement: z.boolean().optional(),
}).refine((value) => Object.keys(value).some((key) => key !== 'expected_version'), {
  message: 'At least one editable field is required.',
});

const publishSchema = z.object({ expected_version: z.number().int().positive().optional() });
const repeatRoomSchema = z.object({
  scheduled_start_at: isoDate,
  scheduled_end_at: isoDate,
  title: z.string().trim().min(1).max(255).nullable().optional(),
});
const registerPushDeviceSchema = z.object({
  platform: z.enum(['IOS', 'ANDROID', 'WEB']),
  push_token: z.string().trim().min(1).max(4096),
  device_id: z.string().trim().min(1).max(255).nullable().optional(),
  enabled: z.boolean().optional(),
});
const notificationPreferencesSchema = z.object({
  room_updates_enabled: z.boolean().optional(),
  join_requests_enabled: z.boolean().optional(),
  party_invites_enabled: z.boolean().optional(),
  emergency_opportunities_enabled: z.boolean().optional(),
  match_reminders_enabled: z.boolean().optional(),
  rank_updates_enabled: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, { message: 'At least one notification preference is required.' });
const notificationFeedSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  cursor: z.string().trim().min(1).max(512).optional(),
});
const internalListSchema = z.object({
  status: z.string().trim().min(1).max(64).optional(),
  state: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
});
const internalAnalyticsWindowSchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  sport_code: z.string().trim().min(1).max(64).optional(),
  area_bucket: z.string().trim().min(1).max(64).optional(),
}).refine((value) => !value.from || !value.to || value.to > value.from, {
  message: 'to must be after from.',
});
const reservedCountSchema = z.object({ count: z.number().int().nonnegative(), expected_version: z.number().int().positive().optional() });
const cancelRoomSchema = z.object({ expected_version: z.number().int().positive().optional(), reason_code: z.string().trim().min(1).max(120).optional() });
const createApplicationSchema = z.object({ party_id: z.string().uuid().optional(), allow_waitlist_if_full: z.boolean().optional() });
const friendshipRequestSchema = z.object({ user_id: z.string().uuid() });
const createPartySchema = z.object({ sport_code: z.string().trim().min(1).max(50) });
const addPartyMemberSchema = z.discriminatedUnion('member_type', [
  z.object({ member_type: z.literal('REGISTERED_USER'), user_id: z.string().uuid() }),
  z.object({ member_type: z.literal('GUEST'), guest_label: z.string().trim().min(1).max(120) }),
]);
const applicationActionSchema = z.object({});
const rejectApplicationSchema = z.object({ reason_code: z.string().trim().min(1).max(120).optional() });
const removeParticipantSchema = z.object({ reason_code: z.string().trim().min(1).max(120).optional() });
const cancelParticipantSchema = z.object({
  reason_code: z.string().trim().min(1).max(120).optional(),
  reason_text: z.string().trim().min(1).max(1000).optional(),
});
const startRoomSchema = z.object({});
const attendanceSchema = z.object({ reason_code: z.string().trim().min(1).max(120).optional() });
const completeRoomSchema = z.object({});
const skillRatingSchema = z.object({
  rating_value: z.number().finite().min(1).max(10).refine((value) => Number.isInteger(value * 2), {
    message: 'rating_value must use 0.5 increments.',
  }),
});
const batchSkillRatingSchema = z.object({
  ratings: z.array(z.object({
    participant_id: z.string().uuid(),
    rating_value: z.number().finite().min(1).max(10).refine((value) => Number.isInteger(value * 2), {
      message: 'rating_value must use 0.5 increments.',
    }),
  })).min(1).max(50),
});
const searchRoomsSchema = z.object({
  sport: z.string().trim().min(1).max(50),
  lat: z.coerce.number().finite().min(-90).max(90).optional(),
  lng: z.coerce.number().finite().min(-180).max(180).optional(),
  area: z.string().trim().min(1).max(255).optional(),
  radius_km: z.coerce.number().finite().positive().max(100).optional(),
  time_start: isoDate.optional(),
  time_end: isoDate.optional(),
  party_id: z.string().uuid().optional(),
}).refine((value) => (value.lat === undefined) === (value.lng === undefined), {
  message: 'lat and lng must be provided together.',
});
const searchTelemetrySchema = z.object({
  room_id: z.string().uuid(),
  event_type: z.enum(['ROOM_CARD_VIEWED', 'ROOM_DETAIL_OPENED']),
});
const patchMeSchema = z.object({
  display_name: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().min(6).max(32).optional(),
  avatar_url: z.string().url().max(2048).nullable().optional(),
  birth_year: z.number().int().min(1900).max(2100).nullable().optional(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER', 'UNSPECIFIED']).nullable().optional(),
  home_area: z.string().trim().min(1).max(255).nullable().optional(),
}).strict();
const registerSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(10).max(256),
  display_name: z.string().trim().min(1).max(120),
  // Existing user records require phone, so it remains a minimal registration field.
  phone: z.string().trim().min(6).max(32),
});
const loginSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(256),
});

const toEquipmentInput = (input: z.infer<typeof equipmentSchema>) => ({
  supplyMode: input.supply_mode,
  quantityPerParticipant: input.quantity_per_participant,
  notes: input.notes,
  allowedOptions: input.allowed_options?.map((item) => ({
    displayName: item.display_name,
    equipmentType: item.equipment_type,
    brand: item.brand,
    model: item.model,
  })),
});

const toCreateCommand = (input: z.infer<typeof createRoomSchema>): CreateRoomInput => ({
  sportCode: input.sport_code,
  title: input.title,
  venue: input.venue,
  scheduledStartAt: input.scheduled_start_at,
  scheduledEndAt: input.scheduled_end_at,
  capacity: input.capacity,
  hostParticipates: input.host_participates,
  reservedExternalCount: input.reserved_external_count,
  priceAmount: input.price_amount,
  currency: input.currency,
  preferredSkill: input.preferred_skill ? { minScore: input.preferred_skill.min_score, maxScore: input.preferred_skill.max_score } : input.preferred_skill,
  equipment: toEquipmentInput(input.equipment),
  allowEmergencyReplacement: input.allow_emergency_replacement,
});

const toUpdateCommand = (input: z.infer<typeof updateRoomSchema>): UpdateRoomInput => ({
  expectedVersion: input.expected_version,
  title: input.title,
  venue: input.venue,
  scheduledStartAt: input.scheduled_start_at,
  scheduledEndAt: input.scheduled_end_at,
  capacity: input.capacity,
  hostParticipates: input.host_participates,
  reservedExternalCount: input.reserved_external_count,
  priceAmount: input.price_amount,
  currency: input.currency,
  preferredSkill: input.preferred_skill ? { minScore: input.preferred_skill.min_score, maxScore: input.preferred_skill.max_score } : input.preferred_skill,
  equipment: input.equipment ? toEquipmentInput(input.equipment) : undefined,
  allowEmergencyReplacement: input.allow_emergency_replacement,
});

const commandMeta = (request: RequestContext, commandType: string, commandBody: unknown): CommandMeta => {
  const key = request.header('Idempotency-Key');
  if (!key || !key.trim()) throw new DomainError('VALIDATION_ERROR', 'Idempotency-Key header is required for this mutation.');
  const actorUserId = requireActor(request);
  return {
    actorUserId,
    idempotency: { key: key.trim(), actorUserId, commandType, request: commandBody },
  };
};

const requireActor = (request: RequestContext): string => {
  const actorUserId = request.authContext?.actorUserId ?? request.actorUserId;
  if (!actorUserId) throw new DomainError('UNAUTHENTICATED', 'Authentication is required.');
  return actorUserId;
};

const routeParam = (request: Request, name: string): string => {
  const value = request.params[name];
  if (typeof value !== 'string' || !value.trim()) throw new DomainError('VALIDATION_ERROR', `Missing route parameter: ${name}.`);
  return value;
};

const requireReliability = (dependencies: { reliability?: ReliabilityService }): ReliabilityService => {
  if (!dependencies.reliability) throw new Error('Reliability module is not configured.');
  return dependencies.reliability;
};

const requireSkill = (dependencies: { skill?: SkillService }): SkillService => {
  if (!dependencies.skill) throw new Error('Skill module is not configured.');
  return dependencies.skill;
};

const requireParty = (dependencies: { party?: PartyService }): PartyService => {
  if (!dependencies.party) throw new Error('Party module is not configured.');
  return dependencies.party;
};

const requireNotifications = (dependencies: { notifications?: NotificationService }): NotificationService => {
  if (!dependencies.notifications) throw new Error('Notification module is not configured.');
  return dependencies.notifications;
};

const requireOperations = (dependencies: { operations?: OperationsService }): OperationsService => {
  if (!dependencies.operations) throw new Error('Operations module is not configured.');
  return dependencies.operations;
};

const requireAnalytics = (dependencies: { analytics?: AnalyticsService }): AnalyticsService => {
  if (!dependencies.analytics) throw new Error('Analytics module is not configured.');
  return dependencies.analytics;
};

const requireAuth = (dependencies: { auth?: AuthService }): AuthService => {
  if (!dependencies.auth) throw new Error('Auth module is not configured.');
  return dependencies.auth;
};

const tokenMatches = (received: string | undefined, expected: string): boolean => {
  if (!received) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
};

const normalizedRequestIp = (request: Request): string => (request.ip || request.socket.remoteAddress || '').replace(/^::ffff:/, '');

const requireInternalAccess = (request: RequestContext): void => {
  const requestIp = normalizedRequestIp(request);
  if (!config.internalOpsToken || config.internalOpsAllowlist.size === 0 || !config.internalOpsAllowlist.has(requestIp) || !tokenMatches(request.header('X-Internal-Ops-Token')?.trim(), config.internalOpsToken)) {
    throw new DomainError('FORBIDDEN', 'Internal operation access is denied.');
  }
};

const refillDto = (result: Awaited<ReturnType<ReliabilityService['getRefill']>>) => ({
  active: result.active,
  lost_slots: result.lostSlots,
  available_public_slots: result.availablePublicSlots,
  search_boost_active: result.searchBoostActive,
  replacement_window_ends_at: result.replacementWindowEndsAt?.toISOString() ?? null,
  waitlist_candidates: result.waitlistCandidates.map((candidate) => ({
    application_id: candidate.applicationId,
    requested_slot_count: candidate.requestedSlotCount,
    requested_at: candidate.requestedAt.toISOString(),
    currently_fits_capacity: candidate.currentlyFitsCapacity,
    reliability_score: candidate.reliabilityScore,
    skill_fit: candidate.skillFit,
  })),
});

const roomDto = (result: Awaited<ReturnType<RoomService['getRoom']>>) => ({
  id: result.room.id,
  sport: result.room.sportCode,
  status: result.room.status,
  host_user_id: result.room.hostUserId,
  venue: {
    name: result.room.venueName,
    address: result.room.venueAddress,
    latitude: result.room.latitude,
    longitude: result.room.longitude,
  },
  schedule: { start_at: result.room.scheduledStartAt.toISOString(), end_at: result.room.scheduledEndAt.toISOString() },
  capacity: {
    total: result.room.capacity,
    occupied: result.availability.occupiedSlots,
    available_public_slots: result.availability.availablePublicSlots,
  },
  price: { amount: result.room.priceAmount, currency: result.room.currency },
  preferred_skill: { min_score: result.room.preferredSkillMin, max_score: result.room.preferredSkillMax },
  equipment: {
    supply_mode: result.room.equipment.supplyMode,
    quantity_per_participant: result.room.equipment.quantityPerParticipant,
    notes: result.room.equipment.notes,
    allowed_options: result.room.equipment.allowedOptions.map((option) => option.displayName),
  },
  allow_emergency_replacement: result.room.allowEmergencyReplacement,
  published_at: result.room.publishedAt?.toISOString() ?? null,
  cancelled_at: result.room.cancelledAt?.toISOString() ?? null,
  actual_started_at: result.room.actualStartedAt?.toISOString() ?? null,
  start_source: result.room.startSource,
  completed_at: result.room.completedAt?.toISOString() ?? null,
  version: result.room.version,
});

export const createApp = (dependencies: { rooms: RoomService; identity: IdentityService; participation: ParticipationService; lifecycle: RoomLifecycleService; search: SearchService; auth?: AuthService; reliability?: ReliabilityService; skill?: SkillService; party?: PartyService; notifications?: NotificationService; operations?: OperationsService; analytics?: AnalyticsService; actorResolver?: ActorResolver; currentUserProvider?: CurrentUserProvider; readiness?: ReadinessProbe }) => {
  const app = express();
  const actorResolver = dependencies.actorResolver ?? new DevelopmentHeaderActorResolver(config.allowDevActorHeader);
  const currentUserProvider = dependencies.currentUserProvider ?? new ContextCurrentUserProvider();
  app.use((request: Request, response: Response, next: NextFunction) => {
    const origin = request.header('Origin');
    const allowedOrigin = origin && config.corsAllowedOrigins.has(origin) ? origin : undefined;

    if (allowedOrigin) {
      response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', `Content-Type, Authorization, Idempotency-Key, X-Correlation-Id${config.allowDevActorHeader ? ', X-Actor-User-Id' : ''}`);
    }

    if (request.method === 'OPTIONS') {
      response.status(allowedOrigin ? 204 : 403).end();
      return;
    }

    next();
  });
  app.use(express.json({ limit: '256kb' }));
  app.use(async (request: RequestContext, response, next) => {
    request.requestStartedAt = performance.now();
    const suppliedCorrelationId = request.header('X-Correlation-Id')?.trim();
    request.correlationId = suppliedCorrelationId && /^[A-Za-z0-9._-]{1,128}$/.test(suppliedCorrelationId) ? suppliedCorrelationId : newId();
    try {
      request.authContext = await actorResolver.resolve(request, request.correlationId);
      request.actorUserId = currentUserProvider.getActorUserId(request.authContext) ?? undefined;
    } catch (error) {
      next(error);
      return;
    }
    response.setHeader('X-Correlation-Id', request.correlationId);
    response.once('finish', () => {
      const durationMs = performance.now() - (request.requestStartedAt ?? performance.now());
      const route = typeof request.route?.path === 'string' ? request.route.path : request.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id').replace(/\/r\/[^/]+/, '/r/:token');
      const labels = { method: request.method, route, status_code: response.statusCode };
      metrics.observe('vaotran_api_request_duration_ms', durationMs, labels);
      if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS') {
        metrics.observe('vaotran_domain_command_duration_ms', durationMs, { method: request.method, route, status_code: response.statusCode });
      }
      if (response.statusCode >= 400) metrics.increment('vaotran_api_errors_total', { method: request.method, route, status_code: response.statusCode });
      logger.info({ component: 'http', correlation_id: request.correlationId, method: request.method, route, status_code: response.statusCode, duration_ms: durationMs, auth_method: request.authContext?.method }, 'HTTP request completed');
    });
    next();
  });

  app.get('/health', (_request, response) => response.status(200).json({ data: { status: 'ok' } }));
  app.get('/health/live', (_request, response) => response.status(200).json({ data: { status: 'live' } }));
  app.get('/health/ready', async (_request, response) => {
    const readiness = dependencies.readiness ? await dependencies.readiness.check() : { ready: true, checkedAt: new Date(), database: 'ok' as const };
    response.status(readiness.ready ? 200 : 503).json({ data: { status: readiness.ready ? 'ready' : 'not_ready', database: readiness.database, checked_at: readiness.checkedAt.toISOString() } });
  });

  app.post('/api/v1/auth/register', async (request: RequestContext, response, next) => {
    try {
      const body = registerSchema.parse(request.body ?? {});
      const result = await requireAuth(dependencies).register({
        email: body.email, password: body.password, displayName: body.display_name, phone: body.phone,
      });
      response.status(201).json({ data: {
        access_token: result.token, token_type: 'Bearer', expires_at: result.expiresAt.toISOString(),
        user: { id: result.user.id, email: body.email.trim().toLowerCase(), display_name: result.user.displayName, phone: result.user.phone },
      } });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/auth/login', async (request: RequestContext, response, next) => {
    try {
      const body = loginSchema.parse(request.body ?? {});
      const result = await requireAuth(dependencies).login({ email: body.email, password: body.password });
      response.json({ data: {
        access_token: result.token, token_type: 'Bearer', expires_at: result.expiresAt.toISOString(),
        user: { id: result.user.id, email: body.email.trim().toLowerCase(), display_name: result.user.displayName, phone: result.user.phone },
      } });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/auth/logout', async (request: RequestContext, response, next) => {
    try {
      if (request.authContext?.method !== 'SESSION' || !request.authContext.sessionId) {
        throw new DomainError('UNAUTHENTICATED', 'Authentication is required.');
      }
      await requireAuth(dependencies).logout(request.authContext.sessionId);
      response.status(204).end();
    } catch (error) { next(error); }
  });

  app.get('/api/v1/me', async (request: RequestContext, response, next) => {
    try {
      const user = await dependencies.identity.getMe(requireActor(request));
      const [email, sports, reliability] = await Promise.all([
        dependencies.auth ? dependencies.auth.getEmailForUser(user.id) : Promise.resolve(null),
        dependencies.identity.listSportProfiles(user.id),
        dependencies.reliability ? dependencies.reliability.getReliabilityProfile(user.id, user.id) : Promise.resolve(null),
      ]);
      response.json({ data: { id: user.id, email, phone: user.phone, display_name: user.displayName, avatar_url: user.avatarUrl, birth_year: user.birthYear, gender: user.gender, home_area: user.homeArea, created_at: user.createdAt.toISOString(), reliability, sports: sports.map((sport) => ({ sport: sport.sportCode, skill_state: sport.skillState, skill_score: sport.skillScore, rank_tier: sport.rankTier, valid_rating_count: sport.validRatingCount, completed_match_count: sport.completedMatchCount, confidence_level: sport.confidenceLevel })) } });
    } catch (error) { next(error); }
  });

  app.patch('/api/v1/me', async (request: RequestContext, response, next) => {
    try {
      const body = patchMeSchema.parse(request.body);
      const user = await dependencies.identity.updateMe(requireActor(request), {
        displayName: body.display_name, phone: body.phone, avatarUrl: body.avatar_url, birthYear: body.birth_year, gender: body.gender, homeArea: body.home_area,
      });
      response.json({ data: { id: user.id, phone: user.phone, display_name: user.displayName, avatar_url: user.avatarUrl, birth_year: user.birthYear, gender: user.gender, home_area: user.homeArea, created_at: user.createdAt.toISOString() } });
    } catch (error) { next(error); }
  });

  app.get('/api/v1/notifications', async (request: RequestContext, response, next) => {
    try {
      const query = notificationFeedSchema.parse(request.query);
      const result = await requireNotifications(dependencies).listNotifications(requireActor(request), { limit: query.limit, cursor: query.cursor });
      response.json({ data: result.data.map((notification) => ({
        notification_id: notification.id, type: notification.type, category: notification.category,
        title: notification.title, body: notification.body, entity_type: notification.entityType,
        entity_id: notification.entityId, is_critical: notification.isCritical,
        read_at: notification.readAt?.toISOString() ?? null, expires_at: notification.expiresAt?.toISOString() ?? null,
        created_at: notification.createdAt.toISOString(),
      })), meta: { next_cursor: result.nextCursor } });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/notifications/:notificationId/read', async (request: RequestContext, response, next) => {
    try {
      const body = applicationActionSchema.parse(request.body ?? {});
      const result = await requireNotifications(dependencies).markRead(routeParam(request, 'notificationId'), commandMeta(request, 'MarkNotificationRead', body));
      response.status(result.status).json({ data: {
        notification_id: result.body.id, read_at: result.body.readAt?.toISOString() ?? null,
      } });
    } catch (error) { next(error); }
  });

  app.get('/api/v1/me/notification-preferences', async (request: RequestContext, response, next) => {
    try {
      const preferences = await requireNotifications(dependencies).getPreferences(requireActor(request));
      response.json({ data: {
        room_updates_enabled: preferences.roomUpdatesEnabled, join_requests_enabled: preferences.joinRequestsEnabled,
        party_invites_enabled: preferences.partyInvitesEnabled, emergency_opportunities_enabled: preferences.emergencyOpportunitiesEnabled,
        match_reminders_enabled: preferences.matchRemindersEnabled, rank_updates_enabled: preferences.rankUpdatesEnabled,
      } });
    } catch (error) { next(error); }
  });

  app.patch('/api/v1/me/notification-preferences', async (request: RequestContext, response, next) => {
    try {
      const body = notificationPreferencesSchema.parse(request.body);
      const result = await requireNotifications(dependencies).updatePreferences({
        roomUpdatesEnabled: body.room_updates_enabled, joinRequestsEnabled: body.join_requests_enabled,
        partyInvitesEnabled: body.party_invites_enabled, emergencyOpportunitiesEnabled: body.emergency_opportunities_enabled,
        matchRemindersEnabled: body.match_reminders_enabled, rankUpdatesEnabled: body.rank_updates_enabled,
      }, commandMeta(request, 'UpdateNotificationPreferences', body));
      response.status(result.status).json({ data: {
        room_updates_enabled: result.body.roomUpdatesEnabled, join_requests_enabled: result.body.joinRequestsEnabled,
        party_invites_enabled: result.body.partyInvitesEnabled, emergency_opportunities_enabled: result.body.emergencyOpportunitiesEnabled,
        match_reminders_enabled: result.body.matchRemindersEnabled, rank_updates_enabled: result.body.rankUpdatesEnabled,
      } });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/me/push-devices', async (request: RequestContext, response, next) => {
    try {
      const body = registerPushDeviceSchema.parse(request.body);
      const result = await requireNotifications(dependencies).registerPushDevice({
        platform: body.platform, pushToken: body.push_token, deviceId: body.device_id, enabled: body.enabled,
      }, commandMeta(request, 'RegisterPushDevice', body));
      response.status(result.status).json({ data: {
        device_id: result.body.id, platform: result.body.platform, enabled: result.body.enabled,
        last_seen_at: result.body.lastSeenAt.toISOString(),
      } });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/friends/requests', async (request: RequestContext, response, next) => {
    try {
      const body = friendshipRequestSchema.parse(request.body);
      const result = await requireParty(dependencies).requestFriendship(body.user_id, commandMeta(request, 'RequestFriendship', body));
      response.status(result.status).json({ data: {
        friendship_id: result.body.id, requester_user_id: result.body.requesterUserId,
        addressee_user_id: result.body.addresseeUserId, status: result.body.status,
      } });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/friends/requests/:friendshipId/accept', async (request: RequestContext, response, next) => {
    try {
      const body = applicationActionSchema.parse(request.body ?? {});
      const result = await requireParty(dependencies).acceptFriendship(routeParam(request, 'friendshipId'), commandMeta(request, 'AcceptFriendship', body));
      response.status(result.status).json({ data: { friendship_id: result.body.id, status: result.body.status, accepted_at: result.body.acceptedAt?.toISOString() ?? null } });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/friends/requests/:friendshipId/decline', async (request: RequestContext, response, next) => {
    try {
      const body = applicationActionSchema.parse(request.body ?? {});
      const result = await requireParty(dependencies).declineFriendship(routeParam(request, 'friendshipId'), commandMeta(request, 'DeclineFriendship', body));
      response.status(result.status).json({ data: { friendship_id: result.body.id, status: result.body.status } });
    } catch (error) { next(error); }
  });

  app.get('/api/v1/friends', async (request: RequestContext, response, next) => {
    try {
      const friends = await requireParty(dependencies).listFriends(requireActor(request));
      response.json({ data: friends.map((entry) => ({ friendship_id: entry.friendship.id, user_id: entry.friendUserId, display_name: entry.displayName })) });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/parties', async (request: RequestContext, response, next) => {
    try {
      const body = createPartySchema.parse(request.body);
      const result = await requireParty(dependencies).createParty({ sportCode: body.sport_code }, commandMeta(request, 'CreateParty', body));
      response.status(result.status).json({ data: {
        party_id: result.body.party.id, status: result.body.party.status, sport_id: result.body.party.sportId,
        owner_user_id: result.body.party.ownerUserId, members: result.body.members.map((member) => ({ party_member_id: member.id, member_type: member.memberType, user_id: member.userId, guest_label: member.guestLabel, invite_status: member.inviteStatus })),
      } });
    } catch (error) { next(error); }
  });

  app.get('/api/v1/parties/:partyId', async (request: RequestContext, response, next) => {
    try {
      const result = await requireParty(dependencies).getParty(routeParam(request, 'partyId'), requireActor(request));
      response.json({ data: {
        party_id: result.party.id, status: result.party.status, sport_id: result.party.sportId, owner_user_id: result.party.ownerUserId,
        members: result.members.map((member) => ({ party_member_id: member.id, member_type: member.memberType, user_id: member.userId, display_name: member.displayName, guest_label: member.guestLabel, invite_status: member.inviteStatus, claimed_at: member.claimedAt?.toISOString() ?? null })),
      } });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/parties/:partyId/members', async (request: RequestContext, response, next) => {
    try {
      const body = addPartyMemberSchema.parse(request.body);
      const result = await requireParty(dependencies).addMember(routeParam(request, 'partyId'), body.member_type === 'REGISTERED_USER'
        ? { memberType: body.member_type, userId: body.user_id }
        : { memberType: body.member_type, guestLabel: body.guest_label }, commandMeta(request, 'AddPartyMember', body));
      response.status(result.status).json({ data: {
        party_id: result.body.party.id, status: result.body.party.status, party_member_id: result.body.member.id,
        member_type: result.body.member.memberType, user_id: result.body.member.userId, guest_label: result.body.member.guestLabel,
        invite_status: result.body.member.inviteStatus, claim_token: result.body.claimToken,
      } });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/parties/:partyId/members/:partyMemberId/confirm', async (request: RequestContext, response, next) => {
    try {
      const body = applicationActionSchema.parse(request.body ?? {});
      const result = await requireParty(dependencies).confirmMember(routeParam(request, 'partyId'), routeParam(request, 'partyMemberId'), commandMeta(request, 'ConfirmPartyMember', body));
      response.status(result.status).json({ data: { party_id: result.body.party.id, status: result.body.party.status, party_member_id: result.body.member.id, invite_status: result.body.member.inviteStatus } });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/parties/:partyId/members/:partyMemberId/decline', async (request: RequestContext, response, next) => {
    try {
      const body = applicationActionSchema.parse(request.body ?? {});
      const result = await requireParty(dependencies).declineMember(routeParam(request, 'partyId'), routeParam(request, 'partyMemberId'), commandMeta(request, 'DeclinePartyMember', body));
      response.status(result.status).json({ data: { party_id: result.body.party.id, status: result.body.party.status, party_member_id: result.body.member.id, invite_status: result.body.member.inviteStatus } });
    } catch (error) { next(error); }
  });

  app.delete('/api/v1/parties/:partyId/members/:partyMemberId', async (request: RequestContext, response, next) => {
    try {
      const result = await requireParty(dependencies).removeMember(routeParam(request, 'partyId'), routeParam(request, 'partyMemberId'), commandMeta(request, 'RemovePartyMember', {}));
      response.status(result.status).json({ data: { party_id: result.body.party.id, status: result.body.party.status } });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/party-guest-claims/:claimToken', async (request: RequestContext, response, next) => {
    try {
      const body = applicationActionSchema.parse(request.body ?? {});
      const actorUserId = requireActor(request);
      const result = await requireParty(dependencies).claimGuest(routeParam(request, 'claimToken'), actorUserId, commandMeta(request, 'ClaimGuest', body));
      response.status(result.status).json({ data: { party_id: result.body.partyId, party_member_id: result.body.partyMemberId, user_id: result.body.claimedUserId } });
    } catch (error) { next(error); }
  });

  app.get('/api/v1/me/reliability', async (request: RequestContext, response, next) => {
    try {
      const reliability = requireReliability(dependencies);
      const profile = await reliability.getReliabilityProfile(requireActor(request), requireActor(request));
      response.json({ data: {
        score: profile.score, label: profile.label, accepted_matches: profile.acceptedMatches,
        completed_matches: profile.completedMatches, late_cancels: profile.lateCancels,
        no_shows: profile.noShows, history_confidence: profile.historyConfidence,
      } });
    } catch (error) { next(error); }
  });

  app.get('/api/v1/users/:userId/host-profile', async (request, response, next) => {
    try {
      const profile = await requireReliability(dependencies).getHostProfile(routeParam(request, 'userId'));
      response.json({ data: {
        rooms_completed: profile.roomsCompleted, completion_rate: profile.completionRate,
        late_room_cancellations: profile.lateRoomCancellations, repeat_players: profile.repeatPlayers,
        recovered_slot_rate: profile.recoveredSlotRate,
      } });
    } catch (error) { next(error); }
  });

  app.get('/api/v1/users/:userId/sports/:sportCode/profile', async (request, response, next) => {
    try {
      const profile = await dependencies.identity.getSportProfile(routeParam(request, 'userId'), routeParam(request, 'sportCode'));
      response.json({ data: {
        sport: profile.sportCode, skill_state: profile.skillState, skill_score: profile.skillScore, rank_tier: profile.rankTier,
        valid_rating_count: profile.validRatingCount, completed_match_count: profile.completedMatchCount,
        confidence_level: profile.confidenceLevel,
      } });
    } catch (error) { next(error); }
  });

  app.get('/api/v1/search/rooms', async (request: RequestContext, response, next) => {
    try {
      const query = searchRoomsSchema.parse(request.query);
      const result = await dependencies.search.search({
        actorUserId: requireActor(request), sportCode: query.sport, latitude: query.lat, longitude: query.lng,
        area: query.area, initialRadiusKm: query.radius_km, timeStart: query.time_start, timeEnd: query.time_end, partyId: query.party_id,
      });
      response.json({
        data: result.data.map((card) => ({
          room_id: card.roomId, sport: card.sportCode, title: card.title,
          venue: { name: card.venueName, address: card.venueAddress, distance_km: card.distanceKm },
          schedule: { start_at: card.startAt.toISOString(), end_at: card.endAt.toISOString() },
          capacity: { available_public_slots: card.availablePublicSlots, required_slots: card.requiredSlots },
          price: { amount: card.priceAmount, currency: card.currency },
          skill_fit: card.skillFit, badges: card.badges,
          host: { user_id: card.host.id, display_name: card.host.displayName },
        })),
        meta: {
          radius_km: result.meta.radiusKm, radius_expanded: result.meta.radiusExpanded,
          radius_steps_considered: result.meta.radiusStepsConsidered, result_count: result.meta.resultCount,
          location_mode: result.meta.locationMode, ranking_config_version: result.meta.rankingConfigVersion,
        },
      });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/search/telemetry', async (request: RequestContext, response, next) => {
    try {
      const body = searchTelemetrySchema.parse(request.body);
      const actorUserId = requireActor(request);
      if (body.event_type === 'ROOM_CARD_VIEWED') await dependencies.search.recordRoomCardViewed(actorUserId, body.room_id);
      else await dependencies.search.recordRoomDetailOpened(actorUserId, body.room_id);
      response.status(204).end();
    } catch (error) { next(error); }
  });

  app.post('/api/v1/venues/resolve-google-maps', async (request: RequestContext, response, next) => {
    try {
      requireActor(request);
      const body = googleMapsLinkSchema.parse(request.body);
      response.json({ data: await resolveGoogleMapsLink(body.google_maps_url) });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/rooms', async (request: RequestContext, response, next) => {
    try {
      const body = createRoomSchema.parse(request.body);
      const result = await dependencies.rooms.create(commandMeta(request, 'CreateRoom', body), toCreateCommand(body));
      response.status(result.status).json({ data: { room_id: result.body.roomId, status: result.body.status, version: result.body.version } });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/rooms/:roomId/publish', async (request: RequestContext, response, next) => {
    try {
      const body = publishSchema.parse(request.body ?? {});
      const result = await dependencies.rooms.publish(routeParam(request, 'roomId'), commandMeta(request, 'PublishRoom', body), body.expected_version);
      response.status(result.status).json({ data: {
        room_id: result.body.roomId, status: result.body.status, available_public_slots: result.body.availablePublicSlots,
        public_share_token: result.body.publicShareToken ?? null,
        public_share_path: result.body.publicShareToken ? `/r/${result.body.publicShareToken}` : null,
        published_at: result.body.publishedAt?.toISOString() ?? null, version: result.body.version,
      } });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/rooms/:roomId/repeat', async (request: RequestContext, response, next) => {
    try {
      const body = repeatRoomSchema.parse(request.body);
      const result = await dependencies.rooms.repeat(routeParam(request, 'roomId'), commandMeta(request, 'RepeatRoom', body), {
        scheduledStartAt: body.scheduled_start_at, scheduledEndAt: body.scheduled_end_at,
      });
      response.status(result.status).json({ data: {
        room_id: result.body.roomId, status: result.body.status, available_public_slots: result.body.availablePublicSlots,
        version: result.body.version,
      } });
    } catch (error) { next(error); }
  });

  app.get('/r/:shareToken', async (request, response, next) => {
    try {
      const result = await dependencies.rooms.getSharedRoom(routeParam(request, 'shareToken'));
      void dependencies.rooms.recordShareViewed(result.room.id);
      response.json({ data: {
        room_id: result.room.id, sport: result.room.sportCode, title: result.room.title, status: result.room.status,
        venue: { name: result.room.venueName, address: result.room.venueAddress },
        schedule: { start_at: result.room.scheduledStartAt.toISOString(), end_at: result.room.scheduledEndAt.toISOString() },
        capacity: { total: result.room.capacity, available_public_slots: result.availability.availablePublicSlots },
        price: { amount: result.room.priceAmount, currency: result.room.currency },
        equipment: { supply_mode: result.room.equipment.supplyMode, allowed_options: result.room.equipment.allowedOptions.map((option) => option.displayName) },
      } });
    } catch (error) { next(error); }
  });

  app.patch('/api/v1/rooms/:roomId', async (request: RequestContext, response, next) => {
    try {
      const body = updateRoomSchema.parse(request.body);
      const result = await dependencies.rooms.update(routeParam(request, 'roomId'), commandMeta(request, 'UpdateRoom', body), toUpdateCommand(body));
      response.status(result.status).json({ data: {
        room_id: result.body.roomId, status: result.body.status, available_public_slots: result.body.availablePublicSlots, version: result.body.version,
      } });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/rooms/:roomId/reserved-external-count', async (request: RequestContext, response, next) => {
    try {
      const body = reservedCountSchema.parse(request.body);
      const result = await dependencies.rooms.updateReservedExternalCount(routeParam(request, 'roomId'), commandMeta(request, 'UpdateReservedExternalCount', body), body.count, body.expected_version);
      response.status(result.status).json({ data: {
        room_id: result.body.roomId, status: result.body.status, available_public_slots: result.body.availablePublicSlots, version: result.body.version,
      } });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/rooms/:roomId/cancel', async (request: RequestContext, response, next) => {
    try {
      const body = cancelRoomSchema.parse(request.body ?? {});
      const result = await dependencies.rooms.cancel(routeParam(request, 'roomId'), commandMeta(request, 'CancelRoom', body), body.expected_version, body.reason_code);
      response.status(result.status).json({ data: {
        room_id: result.body.roomId, status: result.body.status, cancelled_at: result.body.cancelledAt?.toISOString() ?? null, version: result.body.version,
      } });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/rooms/:roomId/start', async (request: RequestContext, response, next) => {
    try {
      const body = startRoomSchema.parse(request.body ?? {});
      const result = await dependencies.lifecycle.manualStart(routeParam(request, 'roomId'), commandMeta(request, 'StartRoom', body));
      response.status(result.status).json({ data: {
        room_id: result.body.roomId, status: result.body.status,
        actual_started_at: result.body.actualStartedAt.toISOString(), start_source: result.body.startSource,
        available_public_slots: result.body.availablePublicSlots,
      } });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/rooms/:roomId/applications', async (request: RequestContext, response, next) => {
    try {
      const body = createApplicationSchema.parse(request.body ?? {});
      const result = await dependencies.participation.createApplication(
        routeParam(request, 'roomId'),
        commandMeta(request, 'CreateJoinApplication', body),
        { partyId: body.party_id, allowWaitlistIfFull: body.allow_waitlist_if_full },
      );
      response.status(result.status).json({ data: {
        application_id: result.body.applicationId, room_id: result.body.roomId, status: result.body.status,
        requested_slot_count: result.body.requestedSlotCount, created_at: result.body.createdAt.toISOString(),
      } });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/applications/:applicationId/withdraw', async (request: RequestContext, response, next) => {
    try {
      const body = applicationActionSchema.parse(request.body ?? {});
      const result = await dependencies.participation.withdrawApplication(
        routeParam(request, 'applicationId'), commandMeta(request, 'WithdrawJoinApplication', body),
      );
      response.status(result.status).json({ data: result.body });
    } catch (error) { next(error); }
  });

  app.get('/api/v1/host/rooms/:roomId/applications', async (request: RequestContext, response, next) => {
    try {
      const applications = await dependencies.participation.listHostPendingApplications(routeParam(request, 'roomId'), requireActor(request));
      response.json({ data: applications.map(({ application, members }) => ({
        application_id: application.id, room_id: application.roomId, requested_slot_count: application.requestedSlotCount,
        status: application.status, requested_at: application.requestedAt.toISOString(),
        members: members.map((member) => ({
          member_type: member.memberType, user_id: member.userId, display_name: member.displayName ?? member.guestLabel,
          skill: member.skillStateSnapshot === null ? null : {
            state: member.skillStateSnapshot, score: member.skillScoreSnapshot, rank_tier: member.rankTierSnapshot,
          },
          reliability: member.reliabilityScoreSnapshot,
        })),
      })) });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/applications/:applicationId/accept', async (request: RequestContext, response, next) => {
    try {
      const body = applicationActionSchema.parse(request.body ?? {});
      const result = await dependencies.participation.acceptApplication(
        routeParam(request, 'applicationId'), commandMeta(request, 'AcceptJoinApplication', body),
      );
      response.status(result.status).json({ data: {
        application_id: result.body.applicationId, status: result.body.status, participant_ids: result.body.participantIds,
        room_status: result.body.roomStatus, available_public_slots: result.body.availablePublicSlots,
      } });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/applications/:applicationId/reject', async (request: RequestContext, response, next) => {
    try {
      const body = rejectApplicationSchema.parse(request.body ?? {});
      const result = await dependencies.participation.rejectApplication(
        routeParam(request, 'applicationId'), commandMeta(request, 'RejectJoinApplication', body), body.reason_code,
      );
      response.status(result.status).json({ data: result.body });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/participants/:participantId/remove-by-host', async (request: RequestContext, response, next) => {
    try {
      const body = removeParticipantSchema.parse(request.body ?? {});
      const result = await dependencies.participation.removeParticipantByHost(
        routeParam(request, 'participantId'), commandMeta(request, 'RemoveParticipantByHost', body), body.reason_code,
      );
      response.status(result.status).json({ data: {
        participant_id: result.body.participantId, status: result.body.status, room_status: result.body.roomStatus,
        available_public_slots: result.body.availablePublicSlots,
      } });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/participants/:participantId/cancel', async (request: RequestContext, response, next) => {
    try {
      const body = cancelParticipantSchema.parse(request.body ?? {});
      const result = await requireReliability(dependencies).cancelParticipant(
        routeParam(request, 'participantId'), commandMeta(request, 'CancelParticipant', body),
        { reasonCode: body.reason_code, reasonText: body.reason_text },
      );
      response.status(result.status).json({ data: {
        participant_id: result.body.participantId, status: result.body.status,
        classification: result.body.classification, reliability_impact: result.body.reliabilityImpact,
        room_status: result.body.roomStatus, available_public_slots: result.body.availablePublicSlots,
      } });
    } catch (error) { next(error); }
  });

  app.get('/api/v1/host/rooms/:roomId/waitlist', async (request: RequestContext, response, next) => {
    try {
      const candidates = await requireReliability(dependencies).getWaitlist(routeParam(request, 'roomId'), requireActor(request));
      response.json({ data: candidates.map((candidate) => ({
        application_id: candidate.applicationId, requested_slot_count: candidate.requestedSlotCount,
        requested_at: candidate.requestedAt.toISOString(), currently_fits_capacity: candidate.currentlyFitsCapacity,
        reliability_score: candidate.reliabilityScore, skill_fit: candidate.skillFit,
        members: candidate.members.map((member) => ({
          member_type: member.memberType, user_id: member.userId, display_name: member.displayName ?? member.guestLabel,
          reliability: member.reliabilityScoreSnapshot,
        })),
      })) });
    } catch (error) { next(error); }
  });

  app.get('/api/v1/host/rooms/:roomId/refill', async (request: RequestContext, response, next) => {
    try {
      response.json({ data: refillDto(await requireReliability(dependencies).getRefill(routeParam(request, 'roomId'), requireActor(request))) });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/host/rooms/:roomId/refill/activate', async (request: RequestContext, response, next) => {
    try {
      const body = applicationActionSchema.parse(request.body ?? {});
      const result = await requireReliability(dependencies).activateRefill(routeParam(request, 'roomId'), commandMeta(request, 'ActivateEmergencyRefill', body));
      response.status(result.status).json({ data: refillDto(result.body) });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/host/rooms/:roomId/refill/disable', async (request: RequestContext, response, next) => {
    try {
      const body = applicationActionSchema.parse(request.body ?? {});
      const result = await requireReliability(dependencies).disableRefill(routeParam(request, 'roomId'), commandMeta(request, 'DisableEmergencyRefill', body));
      response.status(result.status).json({ data: refillDto(result.body) });
    } catch (error) { next(error); }
  });

  app.get('/api/v1/host/rooms/:roomId/attendance', async (request: RequestContext, response, next) => {
    try {
      const actorUserId = requireActor(request);
      const attendance = await dependencies.participation.listHostAttendance(routeParam(request, 'roomId'), actorUserId);
      const data = await Promise.all(attendance.map(async (participant) => {
        const eligibility = dependencies.skill
          ? await dependencies.skill.getEligibility(participant.id, actorUserId)
          : null;
        return {
          participant_id: participant.id, user_id: participant.userId, display_name: participant.displayName,
          status: participant.status, attendance_status: participant.attendanceStatus,
          attendance_marked_at: participant.attendanceMarkedAt?.toISOString() ?? null,
          attendance_marked_by_user_id: participant.attendanceMarkedByUserId,
          no_show_eligible_at: participant.noShowEligibleAt.toISOString(),
          rating: eligibility === null ? null : {
            required: eligibility.eligible && !eligibility.ratingSubmitted,
            can_host_rate: eligibility.eligible,
            rating_submitted: eligibility.ratingSubmitted,
            reason: eligibility.reason,
          },
        };
      }));
      response.json({ data });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/participants/:participantId/attendance/present', async (request: RequestContext, response, next) => {
    try {
      const body = attendanceSchema.parse(request.body ?? {});
      const result = await dependencies.participation.markPresent(routeParam(request, 'participantId'), commandMeta(request, 'MarkParticipantPresent', body), body.reason_code);
      response.status(result.status).json({ data: {
        participant_id: result.body.participantId, attendance_status: result.body.attendanceStatus,
        no_show_eligible_at: result.body.noShowEligibleAt.toISOString(), corrected: result.body.corrected,
      } });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/participants/:participantId/attendance/no-show', async (request: RequestContext, response, next) => {
    try {
      const body = attendanceSchema.parse(request.body ?? {});
      const result = await dependencies.participation.markNoShow(routeParam(request, 'participantId'), commandMeta(request, 'MarkParticipantNoShow', body), body.reason_code);
      response.status(result.status).json({ data: {
        participant_id: result.body.participantId, attendance_status: result.body.attendanceStatus,
        no_show_eligible_at: result.body.noShowEligibleAt.toISOString(), corrected: result.body.corrected,
      } });
    } catch (error) { next(error); }
  });

  app.get('/api/v1/participants/:participantId/rating-eligibility', async (request: RequestContext, response, next) => {
    try {
      const result = await requireSkill(dependencies).getEligibility(routeParam(request, 'participantId'), requireActor(request));
      response.json({ data: {
        participant_id: result.participantId, user_id: result.playerUserId,
        eligible: result.eligible, rating_submitted: result.ratingSubmitted, reason: result.reason,
      } });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/participants/:participantId/skill-rating', async (request: RequestContext, response, next) => {
    try {
      const body = skillRatingSchema.parse(request.body);
      const result = await requireSkill(dependencies).submitRating(
        routeParam(request, 'participantId'), commandMeta(request, 'SubmitSkillRating', body), { ratingValue: body.rating_value },
      );
      response.status(result.status).json({ data: {
        rating_id: result.body.ratingId, participant_id: result.body.participantId,
        rating_value: result.body.ratingValue, effective_rating_value: result.body.effectiveRatingValue,
        eligible: true, is_outlier: result.body.isOutlier,
        profile: {
          skill_state: result.body.profile.skillState, skill_score: result.body.profile.skillScore,
          rank_tier: result.body.profile.rankTier, valid_rating_count: result.body.profile.validRatingCount,
          unique_valid_rater_count: result.body.profile.uniqueValidRaterCount,
          confidence_level: result.body.profile.confidenceLevel,
        },
      } });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/rooms/:roomId/skill-ratings/batch', async (request: RequestContext, response, next) => {
    try {
      const body = batchSkillRatingSchema.parse(request.body);
      const result = await requireSkill(dependencies).submitBatch(
        routeParam(request, 'roomId'), commandMeta(request, 'SubmitSkillRatingsBatch', body),
        { ratings: body.ratings.map((rating) => ({ participantId: rating.participant_id, ratingValue: rating.rating_value })) },
      );
      response.status(result.status).json({ data: {
        room_id: result.body.roomId,
        ratings: result.body.ratings.map((rating) => ({
          rating_id: rating.ratingId, participant_id: rating.participantId,
          rating_value: rating.ratingValue, effective_rating_value: rating.effectiveRatingValue,
          eligible: true, is_outlier: rating.isOutlier,
        })),
      } });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/rooms/:roomId/complete', async (request: RequestContext, response, next) => {
    try {
      const body = completeRoomSchema.parse(request.body ?? {});
      const result = await dependencies.lifecycle.complete(routeParam(request, 'roomId'), commandMeta(request, 'CompleteRoom', body));
      response.status(result.status).json({ data: {
        room_id: result.body.roomId, status: result.body.status, completed_at: result.body.completedAt.toISOString(),
      } });
    } catch (error) { next(error); }
  });

  app.get('/api/v1/me/rooms', async (request: RequestContext, response, next) => {
    try {
      const matches = await dependencies.participation.listMyMatches(requireActor(request));
      const toDto = (item: (typeof matches.pending)[number]) => ({
        type: item.type, room_id: item.roomId, title: item.title, room_status: item.roomStatus,
        start_at: item.startAt.toISOString(), end_at: item.endAt.toISOString(),
        participation_status: item.participationStatus, application_status: item.applicationStatus,
      });
      response.json({ data: {
        pending: matches.pending.map(toDto), upcoming: matches.upcoming.map(toDto),
        in_progress: matches.inProgress.map(toDto), completed: matches.completed.map(toDto),
        hosting: matches.hosting.map((room) => ({
          type: room.type, room_id: room.roomId, title: room.title, sport: room.sportCode, room_status: room.roomStatus,
          start_at: room.startAt.toISOString(), end_at: room.endAt.toISOString(),
          venue: { name: room.venueName, address: room.venueAddress },
          capacity: { total: room.capacity, available_public_slots: room.availablePublicSlots },
          accepted_participant_count: room.acceptedParticipantCount,
          pending_application_count: room.pendingApplicationCount,
          waitlist_application_count: room.waitlistApplicationCount,
        })),
      } });
    } catch (error) { next(error); }
  });

  app.get('/api/v1/rooms/:roomId', async (request: RequestContext, response, next) => {
    try {
      const roomId = routeParam(request, 'roomId');
      const result = await dependencies.rooms.getRoom(roomId);
      const actorUserId = request.authContext?.actorUserId ?? request.actorUserId ?? null;
      const [host, hostSports, viewerContext, scheduleConflict] = await Promise.all([
        dependencies.identity.getBasicUser(result.room.hostUserId),
        dependencies.identity.listSportProfiles(result.room.hostUserId),
        actorUserId ? dependencies.participation.getViewerContext(roomId, actorUserId) : Promise.resolve(null),
        actorUserId && actorUserId !== result.room.hostUserId ? dependencies.participation.hasScheduleConflict(roomId, actorUserId) : Promise.resolve(false),
      ]);
      const hostSport = hostSports.find((profile) => profile.sportCode === result.room.sportCode) ?? null;
      const isHost = actorUserId === result.room.hostUserId;
      const application = viewerContext?.application ?? null;
      const participant = viewerContext?.participant ?? null;
      const canRequestJoin = Boolean(actorUserId && !isHost && !application && !participant && !scheduleConflict && ['OPEN', 'FULL'].includes(result.room.status));
      response.json({ data: {
        ...roomDto(result),
        host: {
          id: host.id, display_name: host.displayName, avatar_url: host.avatarUrl,
          sport_profile: hostSport && {
            skill_state: hostSport.skillState, skill_score: hostSport.skillScore, rank_tier: hostSport.rankTier,
            valid_rating_count: hostSport.validRatingCount, completed_match_count: hostSport.completedMatchCount,
            confidence_level: hostSport.confidenceLevel,
          },
        },
        viewer: actorUserId ? {
          is_host: isHost,
          schedule_conflict: scheduleConflict,
          can_request_join: canRequestJoin,
          application: application && { id: application.id, status: application.status, party_id: application.partyId, requested_slot_count: application.requestedSlotCount },
          participant: participant && { id: participant.id, status: participant.status, attendance_status: participant.attendanceStatus },
          available_actions: isHost ? ['OPEN_HOST_MANAGER'] : application && ['REQUESTED', 'WAITLISTED'].includes(application.status) ? ['WITHDRAW_APPLICATION'] : participant?.status === 'ACTIVE' ? ['CANCEL_PARTICIPATION'] : canRequestJoin ? ['REQUEST_JOIN'] : [],
        } : null,
      } });
    } catch (error) { next(error); }
  });

  app.get('/api/v1/host/rooms/:roomId', async (request: RequestContext, response, next) => {
    try {
      const roomId = routeParam(request, 'roomId');
      const actorUserId = requireActor(request);
      const [result, applications, attendance, refill] = await Promise.all([
        dependencies.rooms.getHostRoom(roomId, actorUserId),
        dependencies.participation.listHostPendingApplications(roomId, actorUserId),
        dependencies.participation.listHostParticipants(roomId, actorUserId),
        dependencies.reliability ? dependencies.reliability.getRefill(roomId, actorUserId) : Promise.resolve(null),
      ]);
      const applicationDto = ({ application, members }: Awaited<ReturnType<ParticipationService['listHostPendingApplications']>>[number]) => ({
        application_id: application.id,
        requested_by_user_id: application.requestedByUserId,
        requested_slot_count: application.requestedSlotCount,
        status: application.status,
        requested_at: application.requestedAt.toISOString(),
        members: members.map((member) => ({
          member_type: member.memberType,
          user_id: member.userId,
          display_name: member.displayName ?? member.guestLabel,
          skill: member.skillStateSnapshot === null ? null : {
            state: member.skillStateSnapshot,
            score: member.skillScoreSnapshot,
            rank_tier: member.rankTierSnapshot,
          },
          reliability: member.reliabilityScoreSnapshot,
        })),
        allowed_actions: ['ACCEPT', 'REJECT'],
      });
      const participantActions = result.room.status === 'IN_PROGRESS'
        ? ['REMOVE_BY_HOST', 'MARK_PRESENT', 'MARK_NO_SHOW']
        : ['REMOVE_BY_HOST'];
      const getSportProfile = (dependencies.identity as { getSportProfile?: IdentityService['getSportProfile'] }).getSportProfile;
      const acceptedParticipants = await Promise.all(attendance.map(async (participant) => {
        const profile = participant.userId && getSportProfile ? await getSportProfile(participant.userId, result.room.sportCode) : null;
        const rating = participant.userId && dependencies.skill ? await dependencies.skill.getEligibility(participant.id, actorUserId) : null;
        return {
          participant_id: participant.id, application_id: participant.applicationId, user_id: participant.userId,
          member_type: participant.memberType, display_name: participant.displayName, attendance_status: participant.attendanceStatus,
          attendance_marked_at: participant.attendanceMarkedAt?.toISOString() ?? null,
          skill: profile === null ? null : { state: profile.skillState, score: profile.skillScore, rank_tier: profile.rankTier, valid_rating_count: profile.validRatingCount, confidence_level: profile.confidenceLevel },
          rating: rating === null ? null : { eligible: rating.eligible, rating_submitted: rating.ratingSubmitted, reason: rating.reason },
          allowed_actions: participantActions,
        };
      }));
      response.json({ data: {
        ...roomDto(result),
        manager: {
          reserved_external_count: result.room.reservedExternalCount,
          available_public_slots: result.availability.availablePublicSlots,
          accepted_participants: acceptedParticipants,
          pending_applications: applications.filter(({ application }) => application.status === 'REQUESTED').map(applicationDto),
          waitlisted_applications: applications.filter(({ application }) => application.status === 'WAITLISTED').map(applicationDto),
          refill: refill === null ? null : refillDto(refill),
          allowed_actions: ['EDIT_ROOM', 'PUBLISH_ROOM', 'CANCEL_ROOM', 'START_ROOM', 'COMPLETE_ROOM'],
        },
      } });
    } catch (error) { next(error); }
  });

  app.get('/internal/metrics', (request: RequestContext, response, next) => {
    try {
      requireInternalAccess(request);
      response.type('text/plain; version=0.0.4').send(metrics.toPrometheus());
    } catch (error) { next(error); }
  });

  app.get('/internal/analytics/health', async (request: RequestContext, response, next) => {
    try {
      requireInternalAccess(request);
      response.json({ data: await requireAnalytics(dependencies).getConsumerHealth() });
    } catch (error) { next(error); }
  });

  app.post('/internal/analytics/quality-check', async (request: RequestContext, response, next) => {
    try {
      requireInternalAccess(request);
      response.json({ data: await requireAnalytics(dependencies).validateProjection() });
    } catch (error) { next(error); }
  });

  app.get('/internal/analytics/funnels', async (request: RequestContext, response, next) => {
    try {
      requireInternalAccess(request);
      const query = internalAnalyticsWindowSchema.parse(request.query);
      response.json({ data: await requireAnalytics(dependencies).getFunnel({ from: query.from, to: query.to, sportCode: query.sport_code, areaBucket: query.area_bucket }) });
    } catch (error) { next(error); }
  });

  app.get('/internal/analytics/host-performance', async (request: RequestContext, response, next) => {
    try {
      requireInternalAccess(request);
      const query = internalAnalyticsWindowSchema.parse(request.query);
      response.json({ data: await requireAnalytics(dependencies).getHostPerformance({ from: query.from, to: query.to, sportCode: query.sport_code, areaBucket: query.area_bucket }) });
    } catch (error) { next(error); }
  });

  app.get('/internal/analytics/player-retention', async (request: RequestContext, response, next) => {
    try {
      requireInternalAccess(request);
      const query = internalAnalyticsWindowSchema.parse(request.query);
      response.json({ data: await requireAnalytics(dependencies).getPlayerRetention({ from: query.from, to: query.to, sportCode: query.sport_code, areaBucket: query.area_bucket }) });
    } catch (error) { next(error); }
  });

  app.get('/internal/analytics/marketplace-health', async (request: RequestContext, response, next) => {
    try {
      requireInternalAccess(request);
      const query = internalAnalyticsWindowSchema.parse(request.query);
      response.json({ data: await requireAnalytics(dependencies).getMarketplaceHealth({ from: query.from, to: query.to, sportCode: query.sport_code, areaBucket: query.area_bucket }) });
    } catch (error) { next(error); }
  });

  app.get('/internal/reconciliation/findings', async (request: RequestContext, response, next) => {
    try {
      requireInternalAccess(request);
      const query = internalListSchema.parse(request.query);
      response.json({ data: await requireOperations(dependencies).listFindings(query.state, query.limit) });
    } catch (error) { next(error); }
  });

  app.get('/internal/users/:userId', async (request: RequestContext, response, next) => {
    try {
      requireInternalAccess(request);
      const user = await requireOperations(dependencies).inspectUser(routeParam(request, 'userId'));
      if (!user) throw new DomainError('ROOM_NOT_FOUND', 'User record was not found.');
      response.json({ data: user });
    } catch (error) { next(error); }
  });

  app.post('/internal/users/:userId/suspend', async (request: RequestContext, response, next) => {
    try {
      requireInternalAccess(request);
      const user = await requireOperations(dependencies).suspendUser(routeParam(request, 'userId'), request.correlationId ?? newId());
      if (!user) throw new DomainError('ROOM_NOT_FOUND', 'User record was not found.');
      response.json({ data: user });
    } catch (error) { next(error); }
  });

  app.get('/internal/rooms/:roomId', async (request: RequestContext, response, next) => {
    try {
      requireInternalAccess(request);
      const room = await requireOperations(dependencies).inspectRoom(routeParam(request, 'roomId'));
      if (!room) throw new DomainError('ROOM_NOT_FOUND', 'Room record was not found.');
      response.json({ data: room });
    } catch (error) { next(error); }
  });

  app.get('/internal/applications/:applicationId', async (request: RequestContext, response, next) => {
    try {
      requireInternalAccess(request);
      const application = await requireOperations(dependencies).inspectApplication(routeParam(request, 'applicationId'));
      if (!application) throw new DomainError('APPLICATION_NOT_FOUND', 'Application record was not found.');
      response.json({ data: application });
    } catch (error) { next(error); }
  });

  app.get('/internal/participants/:participantId', async (request: RequestContext, response, next) => {
    try {
      requireInternalAccess(request);
      const participant = await requireOperations(dependencies).inspectParticipant(routeParam(request, 'participantId'));
      if (!participant) throw new DomainError('NOT_PARTICIPANT', 'Participant record was not found.');
      response.json({ data: participant });
    } catch (error) { next(error); }
  });

  app.get('/internal/parties/:partyId', async (request: RequestContext, response, next) => {
    try {
      requireInternalAccess(request);
      const party = await requireOperations(dependencies).inspectParty(routeParam(request, 'partyId'));
      if (!party) throw new DomainError('PARTY_NOT_FOUND', 'Party record was not found.');
      response.json({ data: party });
    } catch (error) { next(error); }
  });

  app.get('/internal/reliability/:userId', async (request: RequestContext, response, next) => {
    try {
      requireInternalAccess(request);
      response.json({ data: await requireOperations(dependencies).inspectReliability(routeParam(request, 'userId')) });
    } catch (error) { next(error); }
  });

  app.get('/internal/skill-profiles/:userId/:sportId', async (request: RequestContext, response, next) => {
    try {
      requireInternalAccess(request);
      const profile = await requireOperations(dependencies).inspectSkillProfile(routeParam(request, 'userId'), routeParam(request, 'sportId'));
      if (!profile) throw new DomainError('SPORT_NOT_FOUND', 'Skill profile was not found.');
      response.json({ data: profile });
    } catch (error) { next(error); }
  });

  app.get('/internal/outbox', async (request: RequestContext, response, next) => {
    try {
      requireInternalAccess(request);
      const query = internalListSchema.parse(request.query);
      response.json({ data: await requireOperations(dependencies).listOutbox(query.status, query.limit) });
    } catch (error) { next(error); }
  });

  app.post('/internal/outbox/:eventId/retry', async (request: RequestContext, response, next) => {
    try {
      requireInternalAccess(request);
      const event = await requireOperations(dependencies).retryOutboxEvent(routeParam(request, 'eventId'), request.correlationId ?? newId());
      if (!event) throw new DomainError('VALIDATION_ERROR', 'Outbox event is not retryable.');
      response.json({ data: event });
    } catch (error) { next(error); }
  });

  app.get('/internal/push-deliveries', async (request: RequestContext, response, next) => {
    try {
      requireInternalAccess(request);
      const query = internalListSchema.parse(request.query);
      response.json({ data: await requireOperations(dependencies).listDeliveries(query.status, query.limit) });
    } catch (error) { next(error); }
  });

  app.post('/internal/push-deliveries/:deliveryId/retry', async (request: RequestContext, response, next) => {
    try {
      requireInternalAccess(request);
      const delivery = await requireOperations(dependencies).retryDelivery(routeParam(request, 'deliveryId'), request.correlationId ?? newId());
      if (!delivery) throw new DomainError('VALIDATION_ERROR', 'Push delivery is not retryable.');
      response.json({ data: delivery });
    } catch (error) { next(error); }
  });

  app.use((error: unknown, request: RequestContext, response: Response, _next: NextFunction) => {
    if (error instanceof ZodError) {
      response.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed.', details: error.flatten() } });
      return;
    }
    if (error instanceof DomainError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message, details: error.details } });
      return;
    }
    logger.error({ err: error, correlationId: request.correlationId }, 'Unhandled request error');
    response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', details: {} } });
  });

  return app;
};
