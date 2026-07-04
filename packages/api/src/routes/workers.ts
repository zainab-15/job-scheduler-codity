import type { FastifyInstance } from 'fastify';
import { listWorkers } from '@scheduler/shared';
import { errorEnvelope } from '../plugins/error-handler.js';

/** Workers are a global fleet, not org-scoped (see metrics.ts's getOverview
 *  comment) — every authenticated caller sees the same worker list. */
export async function registerWorkerRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/v1/workers', { preHandler: fastify.authenticate }, async (_req, reply) => {
    const workers = await listWorkers(fastify.db);
    reply.send({ data: workers });
  });

  fastify.get<{ Params: { workerId: string } }>('/api/v1/workers/:workerId', { preHandler: fastify.authenticate }, async (req, reply) => {
    const workers = await listWorkers(fastify.db);
    const worker = workers.find((w) => w.id === req.params.workerId);
    if (!worker) {
      reply.code(404).send(errorEnvelope('NOT_FOUND', 'worker not found', req.id));
      return;
    }
    reply.send(worker);
  });
}
