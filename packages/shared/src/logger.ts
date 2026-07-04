import { pino } from 'pino';

export type ServiceName = 'api' | 'worker' | 'migrate' | 'test';
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

/** One pino factory; each service makes a child logger tagged with `service`.
 *  The level comes from the caller (the zod-validated Env.LOG_LEVEL) — logger.ts
 *  never reads process.env, so there is one source of truth for the level. */
export function createLogger(service: ServiceName, level: LogLevel = 'info') {
  return pino({
    level,
    base: { service, pid: process.pid },
    redact: ['req.headers.authorization', 'req.body.password', '*.password_hash'],
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
