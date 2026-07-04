import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { type DB, type Env, sql } from '@scheduler/shared';
import { registerAuth } from './plugins/auth.js';
import { registerDb } from './plugins/db.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { loggerOptions } from './plugins/logging.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerDeadLetterRoutes } from './routes/dead-letter.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerMetricsRoutes } from './routes/metrics.js';
import { registerOrganizationRoutes } from './routes/organization.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerQueueRoutes } from './routes/queues.js';
import { registerWorkerRoutes } from './routes/workers.js';

export interface BuildServerArgs {
  db: DB;
  jwtSecret: string;
  logLevel: Env['LOG_LEVEL'];
  /** Comma-separated allowed origins. Unset = no CORS plugin registered at
   *  all, matching today's local-dev behavior (Vite dev proxy sidesteps
   *  CORS — see docs/design-decisions.md). Set this once web and api are
   *  deployed on separate origins. */
  corsOrigin?: string;
}

/** Exported (not just used by index.ts) so tests can build a real server
 *  against a Testcontainers/compose-DB Kysely instance without a network
 *  listener. */
export async function buildServer(args: BuildServerArgs): Promise<FastifyInstance> {
  const fastify = Fastify({
    ...loggerOptions(args.logLevel),
    // R28: discriminator:true is what makes the Ajv `discriminator` keyword
    // (and the error-handler's discriminator-failure branch) work at all.
    // coerceTypes:true is REQUIRED for querystring schemas, not just
    // permissive: every HTTP query param arrives as a raw string, so a route
    // schema declaring `{type:'integer'}` (limit/offset/window_hours/...)
    // would 400 on every value, including valid ones, without it. This still
    // satisfies R16's actual intent (?limit=abc -> 400, never silently
    // coerced to garbage): Ajv only coerces strings that cleanly parse to the
    // target type ("20" -> 20), so a non-numeric string still fails
    // validation and 400s — coercion and rejection are not in tension here.
    // removeAdditional:false so an unexpected body field still 400s (schemas
    // use additionalProperties:false explicitly where that's wanted) instead
    // of being silently stripped.
    ajv: { customOptions: { discriminator: true, removeAdditional: false, coerceTypes: true } },
  });

  registerDb(fastify, args.db);
  registerErrorHandler(fastify);
  await registerAuth(fastify, args.jwtSecret);

  if (args.corsOrigin) {
    const origins = args.corsOrigin.split(',').map((o) => o.trim());
    await fastify.register(cors, { origin: origins });
  }

  await fastify.register(swagger, {
    openapi: { info: { title: 'Distributed Job Scheduler API', version: '0.1.0' } },
  });
  await fastify.register(swaggerUi, { routePrefix: '/docs' });

  // Unauthenticated: health (docs is exempt by construction — it's registered
  // above, before any authenticate preHandler exists on any route).
  fastify.get('/api/v1/health', async () => {
    let dbOk = true;
    try {
      await sql`SELECT 1`.execute(fastify.db);
    } catch {
      dbOk = false;
    }
    return { status: dbOk ? 'ok' : 'db_unreachable', db: dbOk ? 'up' : 'down' };
  });

  // Each register*Routes call operates directly on the ROOT `fastify`
  // instance (never wrapped in another `.register()`), so `fastify.db` /
  // `fastify.authenticate` (both root-decorated above) are visible inside
  // every route file without needing the `fastify-plugin` wrapper.
  await registerAuthRoutes(fastify); // register/login public; /me protected internally
  await registerOrganizationRoutes(fastify);
  await registerProjectRoutes(fastify);
  await registerQueueRoutes(fastify);
  await registerJobRoutes(fastify);
  await registerDeadLetterRoutes(fastify);
  await registerWorkerRoutes(fastify);
  await registerMetricsRoutes(fastify);

  return fastify;
}
