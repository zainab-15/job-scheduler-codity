import { type Kysely, sql } from 'kysely';
import type { Database, WorkerStatus } from '../db/types.js';
import { moveToDeadTx } from './jobs.js';
import type { PaginatedResult } from './projects.js';

export interface RegisterWorkerArgs {
  hostname: string;
  pid: number;
  concurrency: number;
}

/** Insert a worker row (status defaults to 'active' per the schema). Returns its id. */
export async function registerWorker(db: Kysely<Database>, args: RegisterWorkerArgs): Promise<string> {
  const row = await db
    .insertInto('workers')
    .values({ hostname: args.hostname, pid: args.pid, concurrency: args.concurrency })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function setWorkerStatus(
  db: Kysely<Database>,
  args: { workerId: string; status: WorkerStatus },
): Promise<void> {
  const stopped = args.status === 'stopped' || args.status === 'dead';
  await sql`
    UPDATE workers SET status = ${args.status}, stopped_at = ${stopped ? sql`now()` : sql`stopped_at`}
    WHERE id = ${args.workerId}
  `.execute(db);
}

/**
 * One tx: bump worker liveness, fenced-extend the lease on this worker's
 * currently-running jobs, and record a heartbeat row. The `locked_until > now()`
 * clause on the extend is REQUIRED (D2-Eng-3): without it a stalled-but-alive
 * worker could push an already-EXPIRED lease back into the future and re-steal
 * a job the reaper just reclaimed from it — reopening the double-run window
 * the fence exists to close. If the extend affects 0 rows for a jobId, the
 * lease was already lost; the caller (executor) must treat that job as done.
 */
export async function heartbeatWorker(
  db: Kysely<Database>,
  args: { workerId: string; jobIds: string[]; leaseSeconds: number },
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`UPDATE workers SET last_heartbeat_at = now() WHERE id = ${args.workerId}`.execute(trx);

    if (args.jobIds.length > 0) {
      await sql`
        UPDATE jobs
           SET locked_until = now() + make_interval(secs => ${args.leaseSeconds})
         WHERE locked_by = ${args.workerId}
           AND id = ANY(${args.jobIds}::uuid[])
           AND status = 'running'
           AND locked_until > now()
      `.execute(trx);
    }

    await sql`
      INSERT INTO worker_heartbeats (worker_id, running_jobs, reported_at)
      VALUES (${args.workerId}, ${args.jobIds.length}, now())
    `.execute(trx);
  });
}

/**
 * Leader-only, lock-gated (D2-Eng-1: this is its OWN short transaction, not
 * fused with reclaim/promote — see reclaimStuckJobs/promoteDueJobs for the
 * same pattern). Flips workers whose heartbeat has gone stale to 'dead' so
 * the reaper's `locked_by IS NULL` branch (after a future cascade) and the
 * dashboard both see them. `staleSeconds` is caller-supplied (derived from
 * HEARTBEAT_INTERVAL_MS by the worker's maintenance loop) — this module
 * never reads env directly, keeping the DB layer decoupled from config.
 */
export async function markDeadWorkers(db: Kysely<Database>, staleSeconds: number): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const got = await sql<{ ok: boolean }>`SELECT pg_try_advisory_xact_lock(2, 0) AS ok`.execute(trx);
    if (!got.rows[0]?.ok) return 0;

    const res = await sql<{ id: string }>`
      UPDATE workers
         SET status = 'dead', stopped_at = COALESCE(stopped_at, now())
       WHERE status IN ('starting','active','draining')
         AND last_heartbeat_at < now() - make_interval(secs => ${staleSeconds})
      RETURNING id
    `.execute(trx);
    return res.rows.length;
  });
}

/**
 * Graceful-shutdown requeue (§7): for each of this worker's still-'running'
 * jobIds (fenced on locked_by=self — a job the reaper already reclaimed in
 * the interim naturally drops out here since locked_by no longer matches),
 * route jobs with attempts remaining back to 'queued' and final-attempt jobs
 * to the DLQ via the same moveToDeadTx path the reaper/failJob use (one
 * terminal-failure path, no special-casing). Attempts are NEVER decremented
 * — a graceful requeue reuses the consumed attempt, same choice as a crash
 * reclaim. Small, bounded list (<= WORKER_CONCURRENCY) so a per-row loop is
 * fine here — unlike the reaper's hot 5s-tick path, this runs once at shutdown.
 */
export async function requeueInflight(
  db: Kysely<Database>,
  args: { workerId: string; jobIds: string[] },
): Promise<{ requeued: number; dead: number }> {
  if (args.jobIds.length === 0) return { requeued: 0, dead: 0 };
  return db.transaction().execute(async (trx) => {
    const owned = await sql<{
      id: string;
      queue_id: string;
      payload: Record<string, unknown>;
      attempts: number;
      max_attempts: number;
    }>`
      SELECT id, queue_id, payload, attempts, max_attempts
      FROM jobs
      WHERE locked_by = ${args.workerId}
        AND status = 'running'
        AND id = ANY(${args.jobIds}::uuid[])
      FOR UPDATE
    `.execute(trx);

    let requeued = 0;
    let dead = 0;
    for (const j of owned.rows) {
      await sql`
        UPDATE job_executions SET status = 'failed', finished_at = now(),
               error = 'requeued on worker shutdown'
        WHERE job_id = ${j.id} AND attempt = ${j.attempts} AND status = 'running'
      `.execute(trx);

      if (j.attempts < j.max_attempts) {
        await sql`
          UPDATE jobs SET status = 'queued', locked_by = NULL, locked_until = NULL,
                          run_at = now(), last_error = 'requeued on worker shutdown', updated_at = now()
          WHERE id = ${j.id}
        `.execute(trx);
        await sql`UPDATE queues SET stat_running = GREATEST(stat_running - 1, 0), stat_queued = stat_queued + 1, updated_at = now() WHERE id = ${j.queue_id}`.execute(trx);
        requeued++;
      } else {
        await moveToDeadTx(trx, {
          jobId: j.id,
          queueId: j.queue_id,
          payload: j.payload,
          attempts: j.attempts,
          deathReason: 'shutdown_final',
          finalError: 'worker shutdown on final attempt: requeued to DLQ',
        });
        dead++;
      }
    }
    return { requeued, dead };
  });
}

export interface WorkerRow {
  id: string;
  hostname: string;
  pid: number;
  status: WorkerStatus;
  concurrency: number;
  last_heartbeat_at: Date;
  started_at: Date;
  stopped_at: Date | null;
}

export type WorkerWithLiveness = WorkerRow & { liveness: 'alive' | 'draining' | 'dead' };

function withLiveness(w: WorkerRow): WorkerWithLiveness {
  return {
    ...w,
    liveness: w.status === 'dead' || w.status === 'stopped' ? 'dead' : w.status === 'draining' ? 'draining' : 'alive',
  };
}

/** List workers (paginated) with DERIVED liveness (never trust a stale
 *  `status` alone — a crashed worker's row may still say 'active' until
 *  markDeadWorkers runs). C6: workers are never deleted, so this MUST be
 *  bounded or it grows unbounded with fleet restart history. */
export async function listWorkers(
  db: Kysely<Database>,
  args: { limit: number; offset: number },
): Promise<PaginatedResult<WorkerWithLiveness>> {
  const res = await sql<WorkerRow & { total: string }>`
    SELECT id, hostname, pid, status, concurrency, last_heartbeat_at, started_at, stopped_at,
           count(*) OVER()::int AS total
    FROM workers ORDER BY started_at DESC
    LIMIT ${args.limit} OFFSET ${args.offset}
  `.execute(db);
  const total = res.rows.length > 0 ? Number(res.rows[0]!.total) : 0;
  return { data: res.rows.map(withLiveness), total, limit: args.limit, offset: args.offset };
}

/** Single-row point lookup by id (C6): a primary-key SELECT, not a full-table
 *  fetch + in-memory Array.find(). */
export async function getWorkerById(db: Kysely<Database>, workerId: string): Promise<WorkerWithLiveness | undefined> {
  const res = await sql<WorkerRow>`
    SELECT id, hostname, pid, status, concurrency, last_heartbeat_at, started_at, stopped_at
    FROM workers WHERE id = ${workerId}
  `.execute(db);
  const row = res.rows[0];
  return row ? withLiveness(row) : undefined;
}
