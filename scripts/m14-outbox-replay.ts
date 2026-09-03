import { randomUUID } from 'node:crypto';
import { OperationsService } from '../src/modules/operations/operations-service.js';
import { PostgresDatabase } from '../src/platform/database/db.js';
import { validateProductionConfig } from '../src/platform/operations/production-config.js';

type Arguments = { eventId?: string; operatorId?: string; execute: boolean; confirmedProduction: boolean; correlationId: string };

const parseArguments = (values: string[]): Arguments => {
  const result: Arguments = { execute: false, confirmedProduction: false, correlationId: randomUUID() };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--event-id') result.eventId = values[++index];
    else if (value === '--operator-id') result.operatorId = values[++index];
    else if (value === '--correlation-id') result.correlationId = values[++index];
    else if (value === '--execute') result.execute = true;
    else if (value === '--confirm-production') result.confirmedProduction = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return result;
};

const main = async (): Promise<void> => {
  const args = parseArguments(process.argv.slice(2));
  if (!args.eventId || !args.operatorId) throw new Error('Usage: --event-id <uuid> --operator-id <approved-operator> [--execute] [--confirm-production] [--correlation-id <uuid>]');
  const production = process.env.NODE_ENV === 'production';
  if (production && !args.confirmedProduction) throw new Error('Production replay requires --confirm-production.');
  if (production) {
    const validation = validateProductionConfig();
    if (!validation.valid) throw new Error(`Production configuration rejected: ${validation.issues.join(' ')}`);
  }

  const db = new PostgresDatabase();
  try {
    const operations = new OperationsService(db);
    const before = await operations.inspectOutboxEvent(args.eventId);
    if (!before) throw new Error(`Outbox event ${args.eventId} was not found.`);
    if (!args.execute) {
      console.log(JSON.stringify({ mode: 'dry-run', event: before, executable: ['FAILED_RETRYABLE', 'DEAD_LETTER'].includes(before.publishStatus), correlation_id: args.correlationId }));
      return;
    }
    const after = await operations.retryOutboxEvent(args.eventId, args.correlationId, args.operatorId);
    console.log(JSON.stringify({ mode: 'executed', outcome: after ? 'QUEUED' : 'NOT_ACTIONABLE', event: after, correlation_id: args.correlationId, operator_id: args.operatorId }));
    if (!after) process.exitCode = 3;
  } finally {
    await db.close();
  }
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
