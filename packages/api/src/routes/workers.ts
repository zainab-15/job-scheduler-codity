import type { FastifyInstance } from 'fastify';
import { getWorkerById, listWorkers } from '@scheduler/shared';
import { errorEnvelope } from '../plugins/error-handler.js';
import { paginationEnvelope, paginationQuerySchema } from './pagination.js';

/** Workers are a global fleet, not org-scoped (see metrics.ts's getOverview
 *  comment) — every authenticated caller sees the same worker list. */
export async function registerWorkerRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: { limit?: number; offset?: number } }>(
    '/api/v1/workers',
    { preHandler: fastify.authenticate, schema: { querystring: paginationQuerySchema } },
    async (req, reply) => {
      // C6: paginated like every other list endpoint — workers are never
      // deleted, so an unbounded SELECT would grow with fleet restart history.
      const result = await listWorkers(fastify.db, { limit: req.query.limit ?? 20, offset: req.query.offset ?? 0 });
      reply.send(paginationEnvelope(result));
    },
  );

  fastify.get<{ Params: { workerId: string } }>('/api/v1/workers/:workerId', { preHandler: fastify.authenticate }, async (req, reply) => {
    // C6: single-row point lookup, not a full-table fetch + Array.find().
    const worker = await getWorkerById(fastify.db, req.params.workerId);
    if (!worker) {
      reply.code(404).send(errorEnvelope('NOT_FOUND', 'worker not found', req.id));
      return;
    }
    reply.send(worker);
  });
}
