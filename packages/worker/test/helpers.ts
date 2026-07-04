import type { DB } from '@scheduler/shared';
import type { WorkerConfig } from '../src/config.js';

/**
 * Insert jobs with a real handler_name + custom payload — the shared harness's
 * seedJobs() (packages/shared/test/pg-harness.ts) always uses handler_name
 * 'noop' with payload {}, which isn't registered in the worker's default
 * registry and doesn't let us control e.g. sleep duration. Worker tests need
 * both, so this bypasses seedJobs for the handler/payload it doesn't cover.
 */
export async function insertJobs(
  db: DB,
  queueId: string,
  n: number,
  opts: { handler: string; payload?: Record<string, unknown>; maxAttempts?: number },
): Promise<void> {
  const rows = Array.from({ length: n }, () => ({
    queue_id: queueId,
    type: 'immediate' as const,
    handler_name: opts.handler,
    status: 'queued' as const,
    priority: 5,
    payload: opts.payload ?? {},
    max_attempts: opts.maxAttempts ?? 3,
    retry_strategy: 'exponential' as const,
    retry_base_delay_ms: 100,
    retry_backoff_factor: 2,
    retry_max_delay_ms: 5000,
  }));
  await db.insertInto('jobs').values(rows).execute();
}

/** Fast intervals so integration tests don't wait on production-sized (30s) timers. */
export function testWorkerConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    concurrency: 5,
    pollIntervalMs: 100,
    leaseSeconds: 2,
    heartbeatMs: 300,
    reclaimIntervalMs: 300,
    shutdownGraceMs: 1500,
    ...overrides,
  };
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll a condition until it's true or the timeout elapses (avoids sleeping a
 *  fixed worst-case duration in every test). */
export async function waitUntil(check: () => Promise<boolean>, timeoutMs: number, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleepMs(intervalMs);
  }
  throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
}
