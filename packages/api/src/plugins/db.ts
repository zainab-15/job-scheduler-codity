import type { FastifyInstance } from 'fastify';
import type { DB } from '@scheduler/shared';

declare module 'fastify' {
  interface FastifyInstance {
    db: DB;
  }
}

/**
 * Plain decorator, not a `.register()`'d plugin — called directly at the
 * root instance in server.ts so the decoration is visible to every route
 * without needing the `fastify-plugin` wrapper (Fastify's encapsulation only
 * kicks in across `.register()` boundaries, and this never crosses one).
 */
export function registerDb(fastify: FastifyInstance, db: DB): void {
  fastify.decorate('db', db);
  fastify.addHook('onClose', async () => {
    await db.destroy();
  });
}
