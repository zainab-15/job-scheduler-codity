import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  type CreateJobResult,
  cancelJob,
  createBatch,
  createDelayedJob,
  createImmediateJob,
  createRecurringJob,
  createScheduledJob,
  getJobDetail,
  listJobsByProject,
  listJobsByQueue,
  retryJob,
} from '@scheduler/shared';
import { orgIdOf } from '../plugins/auth.js';
import { errorEnvelope } from '../plugins/error-handler.js';
import { paginationEnvelope, paginationQuerySchema } from './pagination.js';

const jobPayloadSchema = { type: 'object' } as const; // opaque; the worker's handler zod-validates the real shape
const priorityProp = { type: 'integer', minimum: 0, maximum: 9, default: 5 } as const;
const batchItemSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['payload'],
  properties: { payload: jobPayloadSchema, priority: priorityProp, dedupe_key: { type: 'string' } },
} as const;

/** Discriminated on `type`. `recurring` is deliberately NOT one of these
 *  branches — it lives on POST /queues/:id/schedules (R28, Part 2C): it
 *  creates a scheduled_jobs TEMPLATE, not a job, so least-astonishment keeps
 *  it off this endpoint. */
const createJobBodySchema = {
  type: 'object',
  required: ['type'],
  discriminator: { propertyName: 'type' },
  oneOf: [
    {
      additionalProperties: false,
      required: ['type', 'handler_name', 'payload'],
      properties: {
        type: { const: 'immediate' },
        handler_name: { type: 'string', minLength: 1 },
        payload: jobPayloadSchema,
        priority: priorityProp,
        dedupe_key: { type: 'string' },
      },
    },
    {
      additionalProperties: false,
      required: ['type', 'handler_name', 'payload', 'delay_seconds'],
      properties: {
        type: { const: 'delayed' },
        handler_name: { type: 'string', minLength: 1 },
        payload: jobPayloadSchema,
        priority: priorityProp,
        dedupe_key: { type: 'string' },
        delay_seconds: { type: 'integer', minimum: 1, maximum: 31_536_000 },
      },
    },
    {
      additionalProperties: false,
      required: ['type', 'handler_name', 'payload', 'scheduled_at'],
      properties: {
        type: { const: 'scheduled' },
        handler_name: { type: 'string', minLength: 1 },
        payload: jobPayloadSchema,
        priority: priorityProp,
        dedupe_key: { type: 'string' },
        scheduled_at: { type: 'string', format: 'date-time' },
      },
    },
    {
      additionalProperties: false,
      required: ['type', 'handler_name', 'items'],
      properties: {
        type: { const: 'batch' },
        handler_name: { type: 'string', minLength: 1 },
        items: { type: 'array', minItems: 1, maxItems: 500, items: batchItemSchema },
      },
    },
  ],
} as const;

type CreateJobBody =
  | { type: 'immediate'; handler_name: string; payload: Record<string, unknown>; priority?: number; dedupe_key?: string }
  | {
      type: 'delayed';
      handler_name: string;
      payload: Record<string, unknown>;
      priority?: number;
      dedupe_key?: string;
      delay_seconds: number;
    }
  | {
      type: 'scheduled';
      handler_name: string;
      payload: Record<string, unknown>;
      priority?: number;
      dedupe_key?: string;
      scheduled_at: string;
    }
  | {
      type: 'batch';
      handler_name: string;
      items: Array<{ payload: Record<string, unknown>; priority?: number; dedupe_key?: string }>;
    };

function sendCreateResult(reply: FastifyReply, req: FastifyRequest, result: CreateJobResult): void {
  if (result.kind === 'queue_not_found') {
    reply.code(404).send(errorEnvelope('NOT_FOUND', 'queue not found', req.id));
    return;
  }
  if (result.kind === 'duplicate') {
    reply.code(200).send(result.job); // idempotent enqueue (R13) — not a 500
    return;
  }
  reply.code(201).send(result.job);
}

const jobListQuerySchema = {
  type: 'object',
  properties: {
    status: {
      anyOf: [
        { type: 'string', enum: ['queued', 'scheduled', 'running', 'retrying', 'completed', 'dead', 'cancelled'] },
        { type: 'array', items: { type: 'string', enum: ['queued', 'scheduled', 'running', 'retrying', 'completed', 'dead', 'cancelled'] } },
      ],
    },
    type: { type: 'string', enum: ['immediate', 'delayed', 'scheduled', 'recurring', 'batch'] },
    created_after: { type: 'string', format: 'date-time' },
    created_before: { type: 'string', format: 'date-time' },
    // R15: sort is validated only as A string here; the query layer maps it
    // through SORT_ALLOWLIST server-side — an unrecognized value silently
    // falls back to the default, it is NEVER interpolated into SQL.
    sort: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    offset: { type: 'integer', minimum: 0, default: 0 },
  },
} as const;

interface JobListQuery {
  status?: string | string[];
  type?: 'immediate' | 'delayed' | 'scheduled' | 'recurring' | 'batch';
  created_after?: string;
  created_before?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

function normalizeStatus(status: string | string[] | undefined) {
  if (!status) return undefined;
  return (Array.isArray(status) ? status : [status]) as Array<
    'queued' | 'scheduled' | 'running' | 'retrying' | 'completed' | 'dead' | 'cancelled'
  >;
}

export async function registerJobRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Params: { queueId: string }; Body: CreateJobBody }>(
    '/api/v1/queues/:queueId/jobs',
    { preHandler: fastify.authenticate, schema: { body: createJobBodySchema } },
    async (req, reply) => {
      const orgId = orgIdOf(req);
      const queueId = req.params.queueId;
      const body = req.body;

      if (body.type === 'immediate') {
        const result = await createImmediateJob(fastify.db, {
          orgId,
          queueId,
          handlerName: body.handler_name,
          payload: body.payload,
          priority: body.priority,
          dedupeKey: body.dedupe_key,
        });
        sendCreateResult(reply, req, result);
        return;
      }
      if (body.type === 'delayed') {
        const result = await createDelayedJob(fastify.db, {
          orgId,
          queueId,
          handlerName: body.handler_name,
          payload: body.payload,
          priority: body.priority,
          dedupeKey: body.dedupe_key,
          delaySeconds: body.delay_seconds,
        });
        sendCreateResult(reply, req, result);
        return;
      }
      if (body.type === 'scheduled') {
        const scheduledAt = new Date(body.scheduled_at);
        if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now()) {
          reply.code(400).send(errorEnvelope('VALIDATION_ERROR', 'scheduled_at must be a valid future timestamp', req.id));
          return;
        }
        const result = await createScheduledJob(fastify.db, {
          orgId,
          queueId,
          handlerName: body.handler_name,
          payload: body.payload,
          priority: body.priority,
          dedupeKey: body.dedupe_key,
          scheduledAt,
        });
        sendCreateResult(reply, req, result);
        return;
      }

      // body.type === 'batch' (single-endpoint sugar; prefer /jobs/batch for large N)
      const result = await createBatch(fastify.db, {
        orgId,
        queueId,
        handlerName: body.handler_name,
        items: body.items.map((it) => ({ payload: it.payload, priority: it.priority, dedupeKey: it.dedupe_key })),
      });
      if (result === 'queue_not_found') {
        reply.code(404).send(errorEnvelope('NOT_FOUND', 'queue not found', req.id));
        return;
      }
      reply
        .code(201)
        .send({ created: result.created, skipped: result.skipped, count: { created: result.created.length, skipped: result.skipped.length } });
    },
  );

  fastify.post<{
    Params: { queueId: string };
    Body: { handler_name: string; items: Array<{ payload: Record<string, unknown>; priority?: number; dedupe_key?: string }> };
  }>(
    '/api/v1/queues/:queueId/jobs/batch',
    {
      preHandler: fastify.authenticate,
      schema: {
        body: {
          type: 'object',
          required: ['handler_name', 'items'],
          additionalProperties: false,
          properties: {
            handler_name: { type: 'string', minLength: 1 },
            items: { type: 'array', minItems: 1, maxItems: 500, items: batchItemSchema },
          },
        },
      },
    },
    async (req, reply) => {
      const result = await createBatch(fastify.db, {
        orgId: orgIdOf(req),
        queueId: req.params.queueId,
        handlerName: req.body.handler_name,
        items: req.body.items.map((it) => ({ payload: it.payload, priority: it.priority, dedupeKey: it.dedupe_key })),
      });
      if (result === 'queue_not_found') {
        reply.code(404).send(errorEnvelope('NOT_FOUND', 'queue not found', req.id));
        return;
      }
      reply
        .code(201)
        .send({ created: result.created, skipped: result.skipped, count: { created: result.created.length, skipped: result.skipped.length } });
    },
  );

  fastify.get<{ Params: { queueId: string }; Querystring: JobListQuery }>(
    '/api/v1/queues/:queueId/jobs',
    { preHandler: fastify.authenticate, schema: { querystring: jobListQuerySchema } },
    async (req, reply) => {
      const q = req.query;
      const result = await listJobsByQueue(fastify.db, {
        orgId: orgIdOf(req),
        queueId: req.params.queueId,
        status: normalizeStatus(q.status),
        type: q.type,
        createdAfter: q.created_after ? new Date(q.created_after) : undefined,
        createdBefore: q.created_before ? new Date(q.created_before) : undefined,
        sort: q.sort,
        limit: q.limit ?? 20,
        offset: q.offset ?? 0,
      });
      if (result === 'queue_not_found') {
        reply.code(404).send(errorEnvelope('NOT_FOUND', 'queue not found', req.id));
        return;
      }
      reply.send(paginationEnvelope(result));
    },
  );

  fastify.get<{ Params: { projectId: string }; Querystring: JobListQuery }>(
    '/api/v1/projects/:projectId/jobs',
    { preHandler: fastify.authenticate, schema: { querystring: jobListQuerySchema } },
    async (req, reply) => {
      const q = req.query;
      const result = await listJobsByProject(fastify.db, {
        orgId: orgIdOf(req),
        projectId: req.params.projectId,
        status: normalizeStatus(q.status),
        type: q.type,
        createdAfter: q.created_after ? new Date(q.created_after) : undefined,
        createdBefore: q.created_before ? new Date(q.created_before) : undefined,
        sort: q.sort,
        limit: q.limit ?? 20,
        offset: q.offset ?? 0,
      });
      if (result === 'project_not_found') {
        reply.code(404).send(errorEnvelope('NOT_FOUND', 'project not found', req.id));
        return;
      }
      reply.send(paginationEnvelope(result));
    },
  );

  fastify.get<{ Params: { jobId: string }; Querystring: { logs_limit?: number } }>(
    '/api/v1/jobs/:jobId',
    {
      preHandler: fastify.authenticate,
      schema: { querystring: { type: 'object', properties: { logs_limit: { type: 'integer', minimum: 1, maximum: 1000, default: 200 } } } },
    },
    async (req, reply) => {
      const detail = await getJobDetail(fastify.db, { orgId: orgIdOf(req), jobId: req.params.jobId, logsLimit: req.query.logs_limit });
      if (!detail) {
        reply.code(404).send(errorEnvelope('NOT_FOUND', 'job not found', req.id));
        return;
      }
      reply.send(detail);
    },
  );

  fastify.post<{ Params: { jobId: string } }>('/api/v1/jobs/:jobId/retry', { preHandler: fastify.authenticate }, async (req, reply) => {
    const result = await retryJob(fastify.db, { orgId: orgIdOf(req), jobId: req.params.jobId });
    if (result === 'not_found') {
      reply.code(404).send(errorEnvelope('NOT_FOUND', 'job not found', req.id));
      return;
    }
    if (result === 'not_retryable') {
      // 409 (state conflict), matching ALREADY_RUNNING / HAS_PENDING_WORK /
      // ORIGIN_DELETED — the resource's current state conflicts with the
      // operation; it is not a malformed request (which would be 400).
      reply.code(409).send(errorEnvelope('NOT_RETRYABLE', 'job is not in a retryable state (must be dead or retrying)', req.id));
      return;
    }
    const detail = await getJobDetail(fastify.db, { orgId: orgIdOf(req), jobId: req.params.jobId });
    reply.send(detail?.job);
  });

  fastify.post<{ Params: { jobId: string } }>('/api/v1/jobs/:jobId/cancel', { preHandler: fastify.authenticate }, async (req, reply) => {
    const result = await cancelJob(fastify.db, { orgId: orgIdOf(req), jobId: req.params.jobId });
    if (result === 'not_found') {
      reply.code(404).send(errorEnvelope('NOT_FOUND', 'job not found', req.id));
      return;
    }
    if (result === 'already_running') {
      reply.code(409).send(errorEnvelope('ALREADY_RUNNING', 'cannot cancel a job that is already running', req.id));
      return;
    }
    reply.send({ id: req.params.jobId, status: 'cancelled' });
  });

  // R28: recurring jobs create a scheduled_jobs TEMPLATE, not a job — a
  // distinct enough operation to warrant its own resource/verb rather than
  // hiding behind the jobs discriminator (least-astonishment).
  fastify.post<{
    Params: { queueId: string };
    Body: { handler_name: string; payload?: Record<string, unknown>; cron: string; timezone?: string };
  }>(
    '/api/v1/queues/:queueId/schedules',
    {
      preHandler: fastify.authenticate,
      schema: {
        body: {
          type: 'object',
          required: ['handler_name', 'cron'],
          additionalProperties: false,
          properties: {
            handler_name: { type: 'string', minLength: 1 },
            payload: jobPayloadSchema,
            cron: { type: 'string', minLength: 1 },
            timezone: { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const result = await createRecurringJob(fastify.db, {
        orgId: orgIdOf(req),
        queueId: req.params.queueId,
        handlerName: req.body.handler_name,
        payload: req.body.payload ?? {},
        cronExpression: req.body.cron,
        timezone: req.body.timezone,
      });
      if (result.kind === 'queue_not_found') {
        reply.code(404).send(errorEnvelope('NOT_FOUND', 'queue not found', req.id));
        return;
      }
      if (result.kind === 'invalid_cron') {
        reply.code(400).send(
          errorEnvelope('INVALID_CRON', result.message, req.id, {
            example: '*/15 * * * * (every 15 minutes)',
          }),
        );
        return;
      }
      if (result.kind === 'invalid_timezone') {
        reply.code(400).send(
          errorEnvelope('INVALID_TIMEZONE', result.message, req.id, {
            example: 'America/New_York (an IANA timezone name)',
          }),
        );
        return;
      }
      // D2-DX-4: pinned response shape.
      reply.code(201).send({
        scheduled_job_id: result.schedule.id,
        next_run_at: result.schedule.next_run_at,
        cron: result.schedule.cron_expression,
        timezone: result.schedule.timezone,
      });
    },
  );
}
