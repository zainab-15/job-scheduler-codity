import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadEnv } from '@scheduler/shared';

export interface WorkerConfig {
  concurrency: number;
  pollIntervalMs: number;
  leaseSeconds: number;
  heartbeatMs: number;
  reclaimIntervalMs: number;
  shutdownGraceMs: number;
  batchCap?: number;
}

/** Unique per PROCESS start (R25) — two local workers on the same machine
 *  share a hostname, so hostname alone is not enough to tell them apart. */
export function workerHostname(): string {
  return `${os.hostname()}:${randomUUID().slice(0, 8)}`;
}

export function loadWorkerConfig(): WorkerConfig {
  const env = loadEnv();
  return {
    concurrency: env.WORKER_CONCURRENCY,
    pollIntervalMs: env.POLL_INTERVAL_MS,
    leaseSeconds: Math.round(env.LEASE_MS / 1000),
    heartbeatMs: env.HEARTBEAT_INTERVAL_MS,
    reclaimIntervalMs: env.RECLAIM_INTERVAL_MS,
    shutdownGraceMs: env.SHUTDOWN_GRACE_MS,
  };
}
