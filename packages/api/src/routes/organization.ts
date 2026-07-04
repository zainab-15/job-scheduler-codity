import type { FastifyInstance } from 'fastify';
import { getOrg, renameOrg } from '@scheduler/shared';
import { orgIdOf } from '../plugins/auth.js';
import { errorEnvelope } from '../plugins/error-handler.js';

export async function registerOrganizationRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/v1/organization', { preHandler: fastify.authenticate }, async (req, reply) => {
    const org = await getOrg(fastify.db, orgIdOf(req));
    if (!org) {
      reply.code(404).send(errorEnvelope('NOT_FOUND', 'organization not found', req.id));
      return;
    }
    reply.send(org);
  });

  fastify.patch<{ Body: { name: string } }>(
    '/api/v1/organization',
    {
      preHandler: fastify.authenticate,
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: { name: { type: 'string', minLength: 1, maxLength: 200 } },
        },
      },
    },
    async (req, reply) => {
      const org = await renameOrg(fastify.db, orgIdOf(req), req.body.name);
      reply.send(org);
    },
  );
}
