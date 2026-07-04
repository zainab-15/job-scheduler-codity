import type { FastifyInstance } from 'fastify';
import { createProject, deleteProject, getProject, listProjects, updateProject } from '@scheduler/shared';
import { orgIdOf } from '../plugins/auth.js';
import { errorEnvelope } from '../plugins/error-handler.js';
import { paginationEnvelope, paginationQuerySchema } from './pagination.js';

export async function registerProjectRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: { limit?: number; offset?: number } }>(
    '/api/v1/projects',
    { preHandler: fastify.authenticate, schema: { querystring: paginationQuerySchema } },
    async (req, reply) => {
      const result = await listProjects(fastify.db, {
        orgId: orgIdOf(req),
        limit: req.query.limit ?? 20,
        offset: req.query.offset ?? 0,
      });
      reply.send(paginationEnvelope(result));
    },
  );

  fastify.post<{ Body: { name: string; description?: string } }>(
    '/api/v1/projects',
    {
      preHandler: fastify.authenticate,
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            description: { type: 'string', maxLength: 2000 },
          },
        },
      },
    },
    async (req, reply) => {
      const project = await createProject(fastify.db, {
        orgId: orgIdOf(req),
        name: req.body.name,
        description: req.body.description ?? null,
      });
      reply.code(201).send(project);
    },
  );

  fastify.get<{ Params: { projectId: string } }>(
    '/api/v1/projects/:projectId',
    {
      preHandler: fastify.authenticate,
      schema: { params: { type: 'object', required: ['projectId'], properties: { projectId: { type: 'string', format: 'uuid' } } } },
    },
    async (req, reply) => {
      const project = await getProject(fastify.db, { orgId: orgIdOf(req), projectId: req.params.projectId });
      if (!project) {
        reply.code(404).send(errorEnvelope('NOT_FOUND', 'project not found', req.id));
        return;
      }
      reply.send(project);
    },
  );

  fastify.patch<{ Params: { projectId: string }; Body: { name?: string; description?: string | null } }>(
    '/api/v1/projects/:projectId',
    {
      preHandler: fastify.authenticate,
      schema: {
        params: { type: 'object', required: ['projectId'], properties: { projectId: { type: 'string', format: 'uuid' } } },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            description: { type: ['string', 'null'], maxLength: 2000 },
          },
        },
      },
    },
    async (req, reply) => {
      const project = await updateProject(fastify.db, {
        orgId: orgIdOf(req),
        projectId: req.params.projectId,
        name: req.body.name,
        description: req.body.description,
      });
      if (!project) {
        reply.code(404).send(errorEnvelope('NOT_FOUND', 'project not found', req.id));
        return;
      }
      reply.send(project);
    },
  );

  fastify.delete<{ Params: { projectId: string } }>(
    '/api/v1/projects/:projectId',
    {
      preHandler: fastify.authenticate,
      schema: { params: { type: 'object', required: ['projectId'], properties: { projectId: { type: 'string', format: 'uuid' } } } },
    },
    async (req, reply) => {
      const result = await deleteProject(fastify.db, { orgId: orgIdOf(req), projectId: req.params.projectId });
      if (result === 'not_found') {
        reply.code(404).send(errorEnvelope('NOT_FOUND', 'project not found', req.id));
        return;
      }
      if (result === 'has_running_jobs') {
        reply.code(409).send(errorEnvelope('HAS_RUNNING_JOBS', 'cannot delete a project with running jobs', req.id));
        return;
      }
      reply.code(204).send();
    },
  );
}
