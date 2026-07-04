/**
 * Standalone migration entrypoint (R24): `npm run migrate`. Runnable
 * independently of the API container so worker-first / no-Docker startup never
 * hits "relation does not exist". This is an ENTRYPOINT, so it owns the
 * process.exit (loadEnv only throws).
 */
import { EnvValidationError, loadEnv } from '../config/env.js';
import { createLogger } from '../logger.js';
import { createDb } from './kysely.js';
import { migrateToLatest } from './migrate.js';

async function main(): Promise<void> {
  let env;
  try {
    env = loadEnv();
  } catch (err) {
    if (err instanceof EnvValidationError) {
      createLogger('migrate').error({ fieldErrors: err.fieldErrors }, err.message);
      process.exit(1);
    }
    throw err;
  }

  const log = createLogger('migrate', env.LOG_LEVEL);
  const db = createDb(env.DATABASE_URL, env.PG_POOL_MAX, env.PGSSL);
  let ok = true;
  try {
    const applied = await migrateToLatest(db);
    if (applied.length === 0) log.info('migrations: already up to date');
    else log.info({ applied }, 'migrations applied');
  } catch (err) {
    // named-migration + remediation line (R27)
    log.error({ err }, 'migration failed — fix the migration or DATABASE_URL, then re-run `npm run migrate`');
    ok = false;
  } finally {
    await db.destroy();
  }
  process.exit(ok ? 0 : 1);
}

void main();
