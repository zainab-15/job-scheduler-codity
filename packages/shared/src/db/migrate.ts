import { type Kysely, Migrator, NO_MIGRATIONS } from 'kysely';
import type { Database } from './types.js';
import { StaticMigrationProvider } from './migrations.js';

function migrator(db: Kysely<Database>): Migrator {
  return new Migrator({ db, provider: new StaticMigrationProvider() });
}

/** Run all pending migrations. Returns the applied migration names. */
export async function migrateToLatest(db: Kysely<Database>): Promise<string[]> {
  const { error, results } = await migrator(db).migrateToLatest();
  if (error) {
    const failed = (results ?? []).find((r) => r.status !== 'Success');
    const cause = error instanceof Error ? error : new Error(String(error));
    throw failed
      ? new Error(`migration "${failed.migrationName}" failed: ${cause.message}`, { cause })
      : cause;
  }
  return (results ?? [])
    .filter((r) => r.status === 'Success')
    .map((r) => r.migrationName);
}

/** Roll everything back (used by the test harness for a clean slate). */
export async function migrateDown(db: Kysely<Database>): Promise<void> {
  const { error } = await migrator(db).migrateTo(NO_MIGRATIONS);
  if (error) throw error;
}
