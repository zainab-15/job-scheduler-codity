import type { FastifyInstance } from 'fastify';
import { discardDlq, listDlqByProject, listDlqByQueue, requeueDlq } from '@scheduler/shared';
import { orgIdOf } from '../plugins/auth.js';
import { errorEnvelope } from '../plugins/error-handler.js';
import { paginationEnvelope, paginationQuerySchema } from './pagination.js';

export async function registerDeadLetterRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { queueId: string }; Querystring: { limit?: number; offset?: number } }>(
    '/api/v1/queues/:queueId/dead-letter',
    { preHandler: fastify.authenticate, schema: { querystring: paginationQuerySchema } },
    async (req, reply) => {
      const result = await listDlqByQueue(fastify.db, {
        orgId: orgIdOf(req),
        queueId: req.params.queueId,
        limit: req.query.limit ?? 20,
        offset: req.query.offset ?? 0,
      });
      if (result === 'queue_not_found') {
        reply.code(404).send(errorEnvelope('NOT_FOUND', 'queue not found', req.id));
        return;
      }
      reply.send(paginationEnvelope(result));
    },
  );

  fastify.get<{ Params: { projectId: string }; Querystring: { limit?: number; offset?: number } }>(
    '/api/v1/projects/:projectId/dead-letter',
    { preHandler: fastify.authenticate, schema: { querystring: paginationQuerySchema } },
    async (req, reply) => {
      const result = await listDlqByProject(fastify.db, {
        orgId: orgIdOf(req),
        projectId: req.params.projectId,
        limit: req.query.limit ?? 20,
        offset: req.query.offset ?? 0,
      });
      if (result === 'project_not_found') {
        reply.code(404).send(errorEnvelope('NOT_FOUND', 'project not found', req.id));
        return;
      }
      reply.send(paginationEnvelope(result));
    },
  );

  fastify.post<{ Params: { dlqId: string } }>('/api/v1/dead-letter/:dlqId/requeue', { preHandler: fastify.authenticate }, async (req, reply) => {
    const result = await requeueDlq(fastify.db, { orgId: orgIdOf(req), dlqId: req.params.dlqId });
    if (result === 'not_found') {
      reply.code(404).send(errorEnvelope('NOT_FOUND', 'dead-letter entry not found', req.id));
      return;
    }
    if (result === 'origin_deleted') {
      reply
        .code(409)
        .send(errorEnvelope('ORIGIN_DELETED', 'the origin job was purged and cannot be reconstructed; discard this entry instead', req.id));
      return;
    }
    reply.send({ dlq_id: req.params.dlqId, status: 'requeued' });
  });

  fastify.delete<{ Params: { dlqId: string } }>('/api/v1/dead-letter/:dlqId', { preHandler: fastify.authenticate }, async (req, reply) => {
    const result = await discardDlq(fastify.db, { orgId: orgIdOf(req), dlqId: req.params.dlqId });
    if (result === 'not_found') {
      reply.code(404).send(errorEnvelope('NOT_FOUND', 'dead-letter entry not found', req.id));
      return;
    }
    reply.code(204).send();
  });
}
