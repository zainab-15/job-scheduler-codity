import { EnvValidationError, createDb, loadEnv } from '@scheduler/shared';
import { buildServer } from './server.js';

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

  // R30: JWT_SECRET is optional in the shared schema (the worker doesn't need
  // it) but mandatory for the API — fail fast here rather than 500ing on the
  // first login attempt.
  if (!env.JWT_SECRET) {
    // eslint-disable-next-line no-console
    console.error('JWT_SECRET is required to run the API. Set it in your .env (min 32 chars) — see .env.example.');
    process.exit(1);
  }

  const db = createDb(env.DATABASE_URL, env.PG_POOL_MAX, env.PGSSL);
  const server = await buildServer({
    db,
    jwtSecret: env.JWT_SECRET,
    logLevel: env.LOG_LEVEL,
    corsOrigin: env.CORS_ORIGIN,
  });

  const onSignal = (sig: string): void => {
    server.log.info({ sig }, 'shutting down');
    void server
      .close()
      .then(() => db.destroy())
      .then(() => process.exit(0));
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));

  try {
    await server.listen({ port: env.PORT, host: '0.0.0.0' });
  } catch (err) {
    server.log.error({ err }, 'api failed to start');
    process.exit(1);
  }
}

void main();
