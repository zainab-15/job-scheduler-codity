import type { FastifyInstance } from 'fastify';
import {
  createQueue,
  deleteQueue,
  getQueueDetail,
  getQueueStats,
  listQueues,
  pauseQueue,
  resumeQueue,
  updateQueue,
} from '@scheduler/shared';
import { orgIdOf } from '../plugins/auth.js';
import { errorEnvelope } from '../plugins/error-handler.js';
import { paginationEnvelope, paginationQuerySchema } from './pagination.js';

const retryPolicyBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['strategy', 'base_delay_ms', 'backoff_factor', 'max_attempts'],
  properties: {
    strategy: { type: 'string', enum: ['fixed', 'linear', 'exponential'] },
    base_delay_ms: { type: 'integer', minimum: 0 },
    backoff_factor: { type: 'number', minimum: 1 },
    max_delay_ms: { type: ['integer', 'null'], minimum: 0 },
    max_attempts: { type: 'integer', minimum: 1 },
  },
} as const;

interface RetryPolicyBody {
  strategy: 'fixed' | 'linear' | 'exponential';
  base_delay_ms: number;
  backoff_factor: number;
  max_delay_ms: number | null;
  max_attempts: number;
}

export async function registerQueueRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { projectId: string }; Querystring: { limit?: number; offset?: number } }>(
    '/api/v1/projects/:projectId/queues',
    { preHandler: fastify.authenticate, schema: { querystring: paginationQuerySchema } },
    async (req, reply) => {
      const result = await listQueues(fastify.db, {
        orgId: orgIdOf(req),
        projectId: req.params.projectId,
        limit: req.query.limit ?? 20,
        offset: req.query.offset ?? 0,
      });
      reply.send(paginationEnvelope(result));
    },
  );

  fastify.post<{
    Params: { projectId: string };
    Body: {
      name: string;
      priority?: number;
      concurrency_limit?: number;
      retry_policy_id?: string;
      retry_policy?: RetryPolicyBody;
    };
  }>(
    '/api/v1/projects/:projectId/queues',
    {
      preHandler: fastify.authenticate,
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            priority: { type: 'integer', minimum: 0, maximum: 9, default: 5 },
            concurrency_limit: { type: 'integer', minimum: 1, default: 5 },
            retry_policy_id: { type: 'string', format: 'uuid' },
            retry_policy: retryPolicyBodySchema,
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body;
      const result = await createQueue(fastify.db, {
        orgId: orgIdOf(req),
        projectId: req.params.projectId,
        name: b.name,
        priority: b.priority,
        concurrencyLimit: b.concurrency_limit,
        retryPolicyId: b.retry_policy_id,
        retryPolicy: b.retry_policy
          ? {
              strategy: b.retry_policy.strategy,
              baseDelayMs: b.retry_policy.base_delay_ms,
              backoffFactor: b.retry_policy.backoff_factor,
              maxDelayMs: b.retry_policy.max_delay_ms,
              maxAttempts: b.retry_policy.max_attempts,
            }
          : undefined,
      });
      if (result === 'project_not_found') {
        reply.code(404).send(errorEnvelope('NOT_FOUND', 'project not found', req.id));
        return;
      }
      if (result === 'policy_not_found') {
        reply.code(404).send(errorEnvelope('NOT_FOUND', 'retry policy not found in this project', req.id));
        return;
      }
      reply.code(201).send(result);
    },
  );

  fastify.get<{ Params: { queueId: string } }>('/api/v1/queues/:queueId', { preHandler: fastify.authenticate }, async (req, reply) => {
    const queue = await getQueueDetail(fastify.db, { orgId: orgIdOf(req), queueId: req.params.queueId });
    if (!queue) {
      reply.code(404).send(errorEnvelope('NOT_FOUND', 'queue not found', req.id));
      return;
    }
    reply.send(queue);
  });

  fastify.patch<{
    Params: { queueId: string };
    Body: { priority?: number; concurrency_limit?: number; retry_policy_id?: string | null };
  }>(
    '/api/v1/queues/:queueId',
    {
      preHandler: fastify.authenticate,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            priority: { type: 'integer', minimum: 0, maximum: 9 },
            concurrency_limit: { type: 'integer', minimum: 1 },
            retry_policy_id: { type: ['string', 'null'], format: 'uuid' },
          },
        },
      },
    },
    async (req, reply) => {
      const queue = await updateQueue(fastify.db, {
        orgId: orgIdOf(req),
        queueId: req.params.queueId,
        priority: req.body.priority,
        concurrencyLimit: req.body.concurrency_limit,
        retryPolicyId: req.body.retry_policy_id,
      });
      if (queue === 'not_found') {
        reply.code(404).send(errorEnvelope('NOT_FOUND', 'queue not found', req.id));
        return;
      }
      if (queue === 'policy_not_found') {
        reply.code(404).send(errorEnvelope('NOT_FOUND', 'retry policy not found in this project', req.id));
        return;
      }
      reply.send(queue);
    },
  );

  fastify.delete<{ Params: { queueId: string } }>('/api/v1/queues/:queueId', { preHandler: fastify.authenticate }, async (req, reply) => {
    const result = await deleteQueue(fastify.db, { orgId: orgIdOf(req), queueId: req.params.queueId });
    if (result === 'not_found') {
      reply.code(404).send(errorEnvelope('NOT_FOUND', 'queue not found', req.id));
      return;
    }
    if (result === 'has_pending_work') {
      reply
        .code(409)
        .send(
          errorEnvelope(
            'HAS_PENDING_WORK',
            'cannot delete a queue with pending jobs (running/queued/scheduled/retrying) or an active recurring schedule',
            req.id,
          ),
        );
      return;
    }
    reply.code(204).send();
  });

  fastify.post<{ Params: { queueId: string } }>('/api/v1/queues/:queueId/pause', { preHandler: fastify.authenticate }, async (req, reply) => {
    const queue = await pauseQueue(fastify.db, { orgId: orgIdOf(req), queueId: req.params.queueId });
    if (!queue) {
      reply.code(404).send(errorEnvelope('NOT_FOUND', 'queue not found', req.id));
      return;
    }
    reply.send({ id: queue.id, is_paused: queue.is_paused });
  });

  fastify.post<{ Params: { queueId: string } }>('/api/v1/queues/:queueId/resume', { preHandler: fastify.authenticate }, async (req, reply) => {
    const queue = await resumeQueue(fastify.db, { orgId: orgIdOf(req), queueId: req.params.queueId });
    if (!queue) {
      reply.code(404).send(errorEnvelope('NOT_FOUND', 'queue not found', req.id));
      return;
    }
    reply.send({ id: queue.id, is_paused: queue.is_paused });
  });

  fastify.get<{ Params: { queueId: string }; Querystring: { window_hours?: number } }>(
    '/api/v1/queues/:queueId/stats',
    {
      preHandler: fastify.authenticate,
      schema: { querystring: { type: 'object', properties: { window_hours: { type: 'integer', minimum: 1, maximum: 168, default: 24 } } } },
    },
    async (req, reply) => {
      const stats = await getQueueStats(fastify.db, {
        orgId: orgIdOf(req),
        queueId: req.params.queueId,
        windowHours: req.query.window_hours ?? 24,
      });
      if (!stats) {
        reply.code(404).send(errorEnvelope('NOT_FOUND', 'queue not found', req.id));
        return;
      }
      reply.send(stats);
    },
  );
}
