import type { FastifyError, FastifyInstance } from 'fastify';

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: unknown;
    correlation_id: string;
  };
}

export function errorEnvelope(code: string, message: string, correlationId: string, details?: unknown): ErrorEnvelope {
  return {
    error: {
      code,
      message,
      correlation_id: correlationId,
      ...(details !== undefined ? { details } : {}),
    },
  };
}

/** Maps a Postgres unique-violation's constraint NAME (never the raw table)
 *  to a specific API error code — enumerated explicitly so different
 *  constraints never collapse to the same wrong code (review finding #13). */
const UNIQUE_VIOLATION_CODES: Record<string, string> = {
  users_email_key: 'EMAIL_TAKEN',
  organizations_slug_key: 'NAME_TAKEN',
  projects_org_id_slug_key: 'NAME_TAKEN',
  queues_project_id_name_key: 'NAME_TAKEN',
  retry_policies_project_id_name_key: 'NAME_TAKEN',
};

interface PgLikeError {
  code?: string;
  constraint?: string;
}

/**
 * D2-DX-3 (closes R28): a wrong `type` on the discriminated create-job
 * endpoint — the single most common client mistake against the most-exercised
 * POST in the API — gets a clean `INVALID_JOB_TYPE` code with the allowed
 * list, never a raw Ajv error array. Every other validation failure still
 * gets the structured envelope, just with the generic VALIDATION_ERROR code.
 */
export function registerErrorHandler(fastify: FastifyInstance): void {
  fastify.setErrorHandler((err: FastifyError, req, reply) => {
    const correlationId = req.id;

    if (err.validation) {
      const discriminatorFailure = err.validation.find((v) => v.keyword === 'discriminator');
      if (discriminatorFailure) {
        reply
          .code(400)
          .send(
            errorEnvelope('INVALID_JOB_TYPE', 'body.type must be one of the supported job types', correlationId, {
              allowed: ['immediate', 'delayed', 'scheduled', 'batch'],
            }),
          );
        return;
      }
      reply.code(400).send(errorEnvelope('VALIDATION_ERROR', err.message, correlationId, err.validation));
      return;
    }

    const pg = err as unknown as PgLikeError;
    if (pg.code === '23505') {
      const mapped = pg.constraint ? UNIQUE_VIOLATION_CODES[pg.constraint] : undefined;
      reply.code(409).send(errorEnvelope(mapped ?? 'CONFLICT', 'a unique constraint was violated', correlationId));
      return;
    }
    if (pg.code === '23503') {
      reply.code(404).send(errorEnvelope('NOT_FOUND', 'a referenced resource does not exist', correlationId));
      return;
    }

    if (err.statusCode && err.statusCode < 500) {
      reply.code(err.statusCode).send(errorEnvelope(err.code ?? 'BAD_REQUEST', err.message, correlationId));
      return;
    }

    req.log.error({ err }, 'unhandled error');
    reply.code(500).send(errorEnvelope('INTERNAL', 'internal server error', correlationId));
  });

  fastify.setNotFoundHandler((req, reply) => {
    reply.code(404).send(errorEnvelope('NOT_FOUND', `route ${req.method} ${req.url} not found`, req.id));
  });
}
