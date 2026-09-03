import { IdentityService } from '../../modules/identity/service.js';
import { PostgresDatabase } from './db.js';

const db = new PostgresDatabase();
try {
  const identity = new IdentityService(db);
  const user = await identity.createDevelopmentUser({ phone: '+84900000001', displayName: 'Demo HOST' });
  console.log(`Development user ready: ${user.id}`);
} finally {
  await db.close();
}
