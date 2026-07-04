import type { FastifyInstance } from 'fastify';
import { getHealth, getOverview, getThroughput } from '@scheduler/shared';
import { orgIdOf } from '../plugins/auth.js';

export async function registerMetricsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/v1/metrics/overview', { preHandler: fastify.authenticate }, async (req, reply) => {
    reply.send(await getOverview(fastify.db, orgIdOf(req)));
  });

  fastify.get('/api/v1/metrics/health', { preHandler: fastify.authenticate }, async (req, reply) => {
    reply.send(await getHealth(fastify.db, orgIdOf(req)));
  });

  fastify.get<{ Querystring: { window_hours?: number; bucket?: 'minute' | 'hour'; project_id?: string; queue_id?: string } }>(
    '/api/v1/metrics/throughput',
    {
      preHandler: fastify.authenticate,
      schema: {
        querystring: {
          type: 'object',
          properties: {
            window_hours: { type: 'integer', minimum: 1, maximum: 168, default: 24 },
            bucket: { type: 'string', enum: ['minute', 'hour'], default: 'hour' },
            project_id: { type: 'string', format: 'uuid' },
            queue_id: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (req, reply) => {
      const q = req.query;
      reply.send(
        await getThroughput(fastify.db, {
          orgId: orgIdOf(req),
          windowHours: q.window_hours ?? 24,
          bucket: q.bucket ?? 'hour',
          projectId: q.project_id,
          queueId: q.queue_id,
        }),
      );
    },
  );
}
