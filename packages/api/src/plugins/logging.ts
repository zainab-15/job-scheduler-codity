import { ulid } from 'ulid';
import type { FastifyServerOptions } from 'fastify';
import type { LogLevel } from '@scheduler/shared';

/**
 * Fastify boot-time logger config: ULID correlation ids (lexicographically
 * sortable by time — nicer to grep in logs than UUIDv4), honoring an
 * incoming x-request-id so a correlation id can span SPA -> API, redaction
 * of secrets (§6).
 */
export function loggerOptions(level: LogLevel): FastifyServerOptions {
  return {
    logger: {
      level,
      redact: ['req.headers.authorization', 'req.body.password', '*.password_hash'],
    },
    genReqId: () => ulid(),
    requestIdHeader: 'x-request-id',
  };
}
