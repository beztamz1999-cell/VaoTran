import { PostgresDatabase } from '../src/platform/database/db.js';
import { AnalyticsService } from '../src/modules/analytics/analytics-service.js';

const confirmation = process.env.ANALYTICS_REBUILD_CONFIRM;
if (confirmation !== 'derived-only') {
  throw new Error('Set ANALYTICS_REBUILD_CONFIRM=derived-only to run the manual analytics rebuild.');
}
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required for analytics rebuild.');
}

const db = new PostgresDatabase();
const analytics = new AnalyticsService(db);

try {
  const result = await analytics.rebuildFromOutbox();
  const validation = await analytics.validateProjection();
  console.log(JSON.stringify({ rebuild: result, validation }, null, 2));
  if (validation.status !== 'PASSED') process.exitCode = 2;
} finally {
  await db.close();
}
