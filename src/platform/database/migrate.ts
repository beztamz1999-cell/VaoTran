import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PostgresDatabase } from './db.js';

const migrationDirectory = join(process.cwd(), 'migrations');

type Migration = { version: string; upFile: string; downFile: string };

const migrations = async (): Promise<Migration[]> => {
  const files = await readdir(migrationDirectory);
  return files
    .filter((file) => file.endsWith('.up.sql'))
    .map((upFile) => ({
      version: upFile.replace('.up.sql', ''),
      upFile,
      downFile: `${upFile.replace('.up.sql', '')}.down.sql`,
    }))
    .sort((a, b) => a.version.localeCompare(b.version));
};

const ensureLedger = async (db: PostgresDatabase): Promise<void> => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL
    )
  `);
};

const appliedVersions = async (db: PostgresDatabase): Promise<Set<string>> => {
  const result = await db.query<{ version: string }>('SELECT version FROM schema_migrations');
  return new Set(result.rows.map((row) => row.version));
};

const up = async (db: PostgresDatabase): Promise<void> => {
  await ensureLedger(db);
  const applied = await appliedVersions(db);
  for (const migration of await migrations()) {
    if (applied.has(migration.version)) continue;
    const sql = await readFile(join(migrationDirectory, migration.upFile), 'utf8');
    await db.transaction(async (tx) => {
      await tx.query(sql);
      await tx.query('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, NOW())', [migration.version]);
    });
    console.log(`Applied ${migration.version}`);
  }
};

const down = async (db: PostgresDatabase): Promise<void> => {
  await ensureLedger(db);
  const result = await db.query<{ version: string }>(
    'SELECT version FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1',
  );
  const version = result.rows[0]?.version;
  if (!version) {
    console.log('No migration to roll back.');
    return;
  }
  const migration = (await migrations()).find((item) => item.version === version);
  if (!migration) throw new Error(`No migration file found for applied version ${version}.`);
  const sql = await readFile(join(migrationDirectory, migration.downFile), 'utf8');
  await db.transaction(async (tx) => {
    await tx.query(sql);
    await tx.query('DELETE FROM schema_migrations WHERE version = $1', [version]);
  });
  console.log(`Rolled back ${version}`);
};

const status = async (db: PostgresDatabase): Promise<void> => {
  await ensureLedger(db);
  const applied = await appliedVersions(db);
  for (const migration of await migrations()) {
    console.log(`${applied.has(migration.version) ? 'APPLIED' : 'PENDING'} ${migration.version}`);
  }
};

const command = process.argv[2];
if (!['up', 'down', 'status'].includes(command ?? '')) {
  throw new Error('Usage: migrate.ts <up|down|status>');
}

const db = new PostgresDatabase();
try {
  if (command === 'up') await up(db);
  if (command === 'down') await down(db);
  if (command === 'status') await status(db);
} finally {
  await db.close();
}
