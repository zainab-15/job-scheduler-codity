import { EnvValidationError, createDb, createLogger, loadEnv } from '@scheduler/shared';
import { loadWorkerConfig } from './config.js';
import { buildDefaultRegistry } from './handlers/index.js';
import { Worker } from './worker.js';

async function main(): Promise<void> {
  let env;
  try {
    env = loadEnv();
  } catch (err) {
    if (err instanceof EnvValidationError) {
      // eslint-disable-next-line no-console
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const log = createLogger('worker', env.LOG_LEVEL);
  const db = createDb(env.DATABASE_URL, env.PG_POOL_MAX);
  const cfg = loadWorkerConfig();
  const registry = buildDefaultRegistry();

  const worker = new Worker(db, cfg, registry, log);
  try {
    await worker.start();
  } catch (err) {
    log.error({ err }, 'worker failed to start');
    process.exit(1);
  }
}

void main();
