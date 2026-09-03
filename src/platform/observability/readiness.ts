import type { PostgresDatabase } from '../database/db.js';
import { metrics } from './metrics.js';

export interface ReadinessResult {
  ready: boolean;
  checkedAt: Date;
  database: 'ok' | 'unavailable';
}

export interface ReadinessProbe {
  check(): Promise<ReadinessResult>;
}

export class PostgresReadinessProbe implements ReadinessProbe {
  constructor(private readonly db: PostgresDatabase) {}

  async check(): Promise<ReadinessResult> {
    try {
      await this.db.query('SELECT 1 AS ready');
      metrics.setGauge('vaotran_database_ready', 1);
      return { ready: true, checkedAt: new Date(), database: 'ok' };
    } catch {
      metrics.setGauge('vaotran_database_ready', 0);
      return { ready: false, checkedAt: new Date(), database: 'unavailable' };
    }
  }
}
