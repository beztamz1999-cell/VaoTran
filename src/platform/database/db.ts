import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { config, logger } from '../core.js';
import { metrics } from '../observability/metrics.js';

export interface SqlExecutor {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

const queryOperation = (text: string): string => text.trim().split(/\s+/)[0]?.toUpperCase() || 'UNKNOWN';

const instrumentedQuery = async <T extends QueryResultRow>(
  executor: 'pool' | 'transaction',
  text: string,
  operation: () => Promise<{ rows: T[]; rowCount: number | null }>,
): Promise<{ rows: T[]; rowCount: number | null }> => {
  const startedAt = performance.now();
  const sqlOperation = queryOperation(text);
  try {
    const result = await operation();
    const durationMs = performance.now() - startedAt;
    metrics.observe('vaotran_db_query_duration_ms', durationMs, { executor, operation: sqlOperation, outcome: 'success' });
    if (durationMs >= config.slowQueryMs) {
      logger.warn({ component: 'database', executor, operation: sqlOperation, duration_ms: durationMs }, 'Slow database query');
    }
    return result;
  } catch (error) {
    const durationMs = performance.now() - startedAt;
    metrics.observe('vaotran_db_query_duration_ms', durationMs, { executor, operation: sqlOperation, outcome: 'error' });
    metrics.increment('vaotran_db_errors_total', { executor, operation: sqlOperation });
    throw error;
  }
};

export class PostgresDatabase implements SqlExecutor {
  private readonly pool: Pool;

  constructor(databaseUrl = config.databaseUrl) {
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is required for PostgreSQL operations.');
    }
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<{ rows: T[]; rowCount: number | null }> {
    return instrumentedQuery('pool', text, () => this.pool.query<T>(text, values));
  }

  async transaction<T>(operation: (tx: Transaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const startedAt = performance.now();
    try {
      await client.query('BEGIN');
      const result = await operation(new Transaction(client));
      await client.query('COMMIT');
      metrics.observe('vaotran_transaction_duration_ms', performance.now() - startedAt, { outcome: 'commit' });
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        logger.error({ component: 'database', err: rollbackError }, 'Database rollback failed');
      }
      metrics.observe('vaotran_transaction_duration_ms', performance.now() - startedAt, { outcome: 'rollback' });
      metrics.increment('vaotran_transaction_rollbacks_total');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export class Transaction implements SqlExecutor {
  constructor(private readonly client: PoolClient) {}

  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<{ rows: T[]; rowCount: number | null }> {
    return instrumentedQuery('transaction', text, () => this.client.query<T>(text, values));
  }
}
