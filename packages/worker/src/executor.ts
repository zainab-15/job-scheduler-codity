import type { Logger } from 'pino';
import {
  type ClaimedRow,
  type DB,
  completeJob,
  deadLetterFenced,
  failJob,
  heartbeatWorker,
  insertJobLog,
} from '@scheduler/shared';
import type { HandlerRegistry } from './handlers/registry.js';
import { once } from './handlers/ledger.js';

export interface ExecutorDeps {
  db: DB;
  workerId: string;
  registry: HandlerRegistry;
  baseLog: Logger;
  leaseSeconds: number;
}

/**
 * Runs one claimed job to a terminal (or requeued) outcome. Every log line
 * carries job_id + worker_id (D2-DX-8) — with no dashboard yet, structured
 * logs are the only observability surface for the kill/recover demo.
 */
export async function runJob(deps: ExecutorDeps, row: ClaimedRow, signal: AbortSignal): Promise<void> {
  const log = deps.baseLog.child({ job_id: row.id, worker_id: deps.workerId });
  const started = Date.now();
  log.info({ handler: row.handler_name, attempt: row.attempts }, 'job claimed');

  const handler = deps.registry.get(row.handler_name);
  if (!handler) {
    log.error({ handler: row.handler_name }, 'unknown handler — dead-lettering');
    const res = await deadLetterFenced(deps.db, {
      jobId: row.id,
      workerId: deps.workerId,
      deathReason: 'unknown_handler',
      finalError: `no handler registered for "${row.handler_name}"`,
    });
    if (!res.fenced) log.warn('lease lost, result discarded (expected under reclaim)');
    return;
  }

  let payload: unknown = row.payload;
  if (handler.payloadSchema) {
    const parsed = handler.payloadSchema.safeParse(row.payload);
    if (!parsed.success) {
      log.error({ issues: parsed.error.issues }, 'invalid payload — dead-lettering');
      const res = await deadLetterFenced(deps.db, {
        jobId: row.id,
        workerId: deps.workerId,
        deathReason: 'invalid_payload',
        finalError: parsed.error.message,
      });
      if (!res.fenced) log.warn('lease lost, result discarded (expected under reclaim)');
      return;
    }
    payload = parsed.data;
  }

  const rawPayload = row.payload as { idempotencyKey?: string };
  const idempotencyKey = rawPayload.idempotencyKey ?? row.id;

  try {
    await handler.handle({
      jobId: row.id,
      attempt: row.attempts,
      maxAttempts: row.max_attempts,
      payload,
      idempotencyKey,
      signal,
      log: async (level, message) => {
        log[level](message);
        await insertJobLog(deps.db, { jobId: row.id, level, message });
      },
      heartbeat: async () => {
        await heartbeatWorker(deps.db, { workerId: deps.workerId, jobIds: [row.id], leaseSeconds: deps.leaseSeconds });
      },
      once,
    });

    const durationMs = Date.now() - started;
    const res = await completeJob(deps.db, { jobId: row.id, workerId: deps.workerId, durationMs });
    if (!res.fenced) log.warn('lease lost, result discarded (expected under reclaim)');
    else log.info({ durationMs }, 'job completed');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const res = await failJob(deps.db, { jobId: row.id, workerId: deps.workerId, error: message });
    if (!res.fenced) log.warn('lease lost, result discarded (expected under reclaim)');
    else if (res.outcome === 'retrying') log.warn({ delayMs: res.delayMs }, 'job failed, scheduled for retry');
    else log.error({ error: message }, 'job failed, moved to dead-letter queue');
  }
}
