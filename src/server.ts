import { IdentityService } from './modules/identity/service.js';
import { ParticipationRepository } from './modules/participation/repository.js';
import { ParticipationService } from './modules/participation/service.js';
import { AutoStartScheduler } from './modules/room/auto-start-scheduler.js';
import { RoomLifecycleService } from './modules/room/lifecycle-service.js';
import { RoomRepository } from './modules/room/repository.js';
import { RoomService } from './modules/room/service.js';
import { ReliabilityRepository } from './modules/reliability/repository.js';
import { ReliabilityService } from './modules/reliability/service.js';
import { RefillExpiryScheduler } from './modules/reliability/refill-expiry-scheduler.js';
import { SearchRepository } from './modules/search/repository.js';
import { RankingRepository } from './modules/ranking/repository.js';
import { SkillCompletionRequirements, SkillService } from './modules/ranking/service.js';
import { SearchService } from './modules/search/service.js';
import { PartyRepository } from './modules/party/repository.js';
import { PartyService } from './modules/party/service.js';
import { NotificationReminderScheduler } from './modules/notification/reminder-scheduler.js';
import { NotificationRepository } from './modules/notification/repository.js';
import { NotificationConsumer, NotificationService, PushDeliveryWorker } from './modules/notification/service.js';
import { OperationsService } from './modules/operations/operations-service.js';
import { ReconciliationService } from './modules/operations/reconciliation-service.js';
import { ReconciliationScheduler } from './modules/operations/reconciliation-scheduler.js';
import { AnalyticsConsumer, AnalyticsService, CompositeOutboxConsumer } from './modules/analytics/analytics-service.js';
import { AnalyticsValidationScheduler } from './modules/analytics/analytics-validation-scheduler.js';
import { config, logger } from './platform/core.js';
import { PostgresDatabase } from './platform/database/db.js';
import { PostgresOutboxWorker } from './platform/outbox/outbox.js';
import { PostgresReadinessProbe } from './platform/observability/readiness.js';
import { createApp } from './platform/http/app.js';
import { AuthService } from './modules/auth/service.js';
import { SessionTokenActorResolver } from './platform/auth/context.js';

const db = new PostgresDatabase();
const identity = new IdentityService(db);
const auth = new AuthService(db, config.authSessionTtlDays);
const roomRepository = new RoomRepository();
const participationRepository = new ParticipationRepository();
const reliabilityRepository = new ReliabilityRepository();
const partyRepository = new PartyRepository();
const party = new PartyService(db, partyRepository);
const notificationRepository = new NotificationRepository();
const notifications = new NotificationService(db, notificationRepository);
const notificationConsumer = new NotificationConsumer(db, notificationRepository);
const analytics = new AnalyticsService(db);
const analyticsValidationScheduler = new AnalyticsValidationScheduler(analytics);
const outboxConsumer = new CompositeOutboxConsumer('notification-and-analytics-consumer-v1', [notificationConsumer, new AnalyticsConsumer(analytics)]);
const notificationOutboxWorker = new PostgresOutboxWorker(db);
const pushDeliveryWorker = new PushDeliveryWorker(db, notificationRepository);
const notificationReminderScheduler = new NotificationReminderScheduler(db, notificationRepository);
const reliability = new ReliabilityService(db, roomRepository, participationRepository, reliabilityRepository);
const rankingRepository = new RankingRepository();
const skill = new SkillService(db, roomRepository, rankingRepository);
const rooms = new RoomService(db, roomRepository, undefined, participationRepository, reliability);
const participation = new ParticipationService(db, roomRepository, participationRepository, undefined, reliability, partyRepository);
const lifecycle = new RoomLifecycleService(
  db,
  roomRepository,
  participationRepository,
  new SkillCompletionRequirements(skill),
  undefined,
  reliability,
  skill,
);
const search = new SearchService(db, new SearchRepository(), identity, undefined, undefined, partyRepository);
const autoStartScheduler = new AutoStartScheduler(lifecycle);
const refillExpiryScheduler = new RefillExpiryScheduler(reliability);
const readiness = new PostgresReadinessProbe(db);
const operations = new OperationsService(db);
const reconciliation = new ReconciliationService(db);
const reconciliationScheduler = new ReconciliationScheduler(reconciliation);
const app = createApp({ rooms, identity, participation, lifecycle, search, auth, reliability, skill, party, notifications, operations, analytics, readiness,
  actorResolver: new SessionTokenActorResolver(db, config.allowDevActorHeader) });

const notificationWorkerTimer = setInterval(() => {
  void notificationOutboxWorker.runOnce(outboxConsumer).catch((error) => logger.error({ err: error }, 'Outbox projection worker failed'));
  void pushDeliveryWorker.runOnce().catch((error) => logger.error({ err: error }, 'Push delivery worker failed'));
}, 2_000);

autoStartScheduler.start();
refillExpiryScheduler.start();
notificationReminderScheduler.start();
reconciliationScheduler.start();
analyticsValidationScheduler.start();
void notificationOutboxWorker.runOnce(outboxConsumer).catch((error) => logger.error({ err: error }, 'Outbox projection worker failed'));
void pushDeliveryWorker.runOnce().catch((error) => logger.error({ err: error }, 'Push delivery worker failed'));
const server = app.listen(config.port, () => {
  logger.info({ component: 'server', port: config.port, release: 'M11' }, 'VàoTrận M11 API listening');
});

const shutdown = async (): Promise<void> => {
  autoStartScheduler.stop();
  refillExpiryScheduler.stop();
  notificationReminderScheduler.stop();
  reconciliationScheduler.stop();
  analyticsValidationScheduler.stop();
  clearInterval(notificationWorkerTimer);
  server.close(async () => {
    await db.close();
    process.exit(0);
  });
};
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
