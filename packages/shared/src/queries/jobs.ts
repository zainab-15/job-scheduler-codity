import { type Kysely, type Transaction, sql } from 'kysely';
import {
  type RetryConfig,
  DEFAULT_RETRY_CONFIG,
  computeBackoffMs,
  shouldRetry,
} from '../domain/backoff.js';
import type { Database, JobStatus, JobType, RetryStrategy } from '../db/types.js';
import type { PaginatedResult } from './projects.js';

export interface ClaimedRow {
  id: string;
  queue_id: string;
  type: JobType;
  handler_name: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  retry_strategy: RetryStrategy;
  retry_base_delay_ms: number;
  retry_backoff_factor: number;
  retry_max_delay_ms: number | null;
}

export interface ClaimArgs {
  queueId: string;
  workerId: string;
  localFree: number;
  leaseSeconds: number;
  batchCap?: number;
}

/**
 * The atomic claim (§4). One transaction:
 *  1. pg_advisory_xact_lock(1, hashtext(queue)) — serialize the budget decision
 *     per queue so `count(running)` reflects committed state and the per-queue
 *     concurrency limit actually holds (finding #2). Two-arg form namespaces it
 *     away from the maintenance-leader lock (R3).
 *  2. One statement: compute budget, pick queued rows FOR UPDATE SKIP LOCKED,
 *     flip them to running (attempts++ once, at real execution start — findings
 *     #4/#8), insert one job_executions row per claim (so UNIQUE(job_id,attempt)
 *     can't collide), and bump the queue's running/queued counters.
 * Handler execution happens OUTSIDE this tx; the lease protects the row.
 */
export async function claimJobs(
  db: Kysely<Database>,
  args: ClaimArgs,
): Promise<ClaimedRow[]> {
  return claimJobsImpl(db, args, true);
}

/**
 * The claim, with the per-queue advisory lock made optional. `claimJobs` always
 * passes `useQueueLock=true`. This is exported ONLY so the concurrency test can
 * run the IDENTICAL query with `useQueueLock=false` and prove the lock is what
 * holds `running <= concurrency_limit` (see claim-concurrency.int.test.ts).
 * Never call with `false` in production — it over-admits under contention.
 */
export async function claimJobsImpl(
  db: Kysely<Database>,
  args: ClaimArgs,
  useQueueLock: boolean,
): Promise<ClaimedRow[]> {
  const batchCap = args.batchCap ?? 20;
  return db.transaction().execute(async (trx) => {
    if (useQueueLock) {
      await sql`SELECT pg_advisory_xact_lock(1, hashtext(${args.queueId}::text))`.execute(trx);
    }

    const res = await sql<ClaimedRow>`
      WITH q AS (
        SELECT concurrency_limit, is_paused FROM queues WHERE id = ${args.queueId}
      ),
      in_use AS (
        SELECT count(*)::int AS n FROM jobs
        WHERE queue_id = ${args.queueId} AND status = 'running'
      ),
      budget AS (
        SELECT LEAST(
                 ${args.localFree}::int,
                 (SELECT concurrency_limit FROM q) - (SELECT n FROM in_use),
                 ${batchCap}::int
               ) AS take,
               (SELECT is_paused FROM q) AS paused
      ),
      picked AS (
        SELECT j.id
        FROM jobs j, budget b
        WHERE j.queue_id = ${args.queueId}
          AND j.status = 'queued'
          AND j.run_at <= now()
          AND b.paused = false
          AND b.take > 0
        ORDER BY j.priority DESC, j.run_at ASC, j.created_at ASC
        LIMIT (SELECT GREATEST(take, 0) FROM budget)
        FOR UPDATE OF j SKIP LOCKED
      ),
      claimed AS (
        UPDATE jobs j
           SET status = 'running',
               locked_by = ${args.workerId},
               locked_until = now() + make_interval(secs => ${args.leaseSeconds}),
               attempts = j.attempts + 1,
               claimed_at = now(),
               started_at = now(),
               updated_at = now()
          FROM picked p
         WHERE j.id = p.id
        RETURNING j.id, j.queue_id, j.type, j.handler_name, j.payload,
                  j.attempts, j.max_attempts, j.retry_strategy,
                  j.retry_base_delay_ms, j.retry_backoff_factor, j.retry_max_delay_ms
      ),
      ins AS (
        INSERT INTO job_executions (job_id, worker_id, attempt, status, started_at)
        SELECT c.id, ${args.workerId}, c.attempts, 'running', now() FROM claimed c
      ),
      bump AS (
        UPDATE queues
           SET stat_running = stat_running + (SELECT count(*) FROM claimed),
               stat_queued  = GREATEST(stat_queued - (SELECT count(*) FROM claimed), 0),
               updated_at = now()
         WHERE id = ${args.queueId}
      )
      SELECT id, queue_id, type, handler_name, payload, attempts, max_attempts,
             retry_strategy, retry_base_delay_ms, retry_backoff_factor, retry_max_delay_ms
      FROM claimed
    `.execute(trx);

    return res.rows.map((r) => ({
      ...r,
      retry_backoff_factor: Number(r.retry_backoff_factor),
    }));
  });
}

export interface FenceResult {
  fenced: boolean;
  outcome?: 'completed' | 'retrying' | 'dead';
  delayMs?: number;
}

/** onSuccess: fenced flip to completed + close the execution + stat. */
export async function completeJob(
  db: Kysely<Database>,
  args: { jobId: string; workerId: string; durationMs: number },
): Promise<FenceResult> {
  return db.transaction().execute(async (trx) => {
    const upd = await sql<{ attempts: number; queue_id: string }>`
      UPDATE jobs
         SET status = 'completed', finished_at = now(), duration_ms = ${args.durationMs},
             locked_by = NULL, locked_until = NULL, last_error = NULL, updated_at = now()
       WHERE id = ${args.jobId} AND locked_by = ${args.workerId} AND locked_until > now()
      RETURNING attempts, queue_id
    `.execute(trx);
    if (upd.rows.length === 0) return { fenced: false }; // lease lost (R3)
    const { attempts, queue_id } = upd.rows[0]!;
    await sql`
      UPDATE job_executions SET status = 'succeeded', finished_at = now(), duration_ms = ${args.durationMs}
      WHERE job_id = ${args.jobId} AND attempt = ${attempts} AND status = 'running'
    `.execute(trx);
    await sql`
      UPDATE queues SET stat_running = GREATEST(stat_running - 1, 0),
                        stat_completed = stat_completed + 1, updated_at = now()
      WHERE id = ${queue_id}
    `.execute(trx);
    return { fenced: true, outcome: 'completed' };
  });
}

/** onFailure: fenced. Uses the FROZEN retry columns (R12/finding #12), never
 *  re-reads the live queue policy. Retries with backoff or DLQs. */
export async function failJob(
  db: Kysely<Database>,
  args: { jobId: string; workerId: string; error: string; rand?: () => number },
): Promise<FenceResult> {
  return db.transaction().execute(async (trx) => {
    const sel = await sql<{
      attempts: number;
      max_attempts: number;
      retry_strategy: RetryStrategy;
      retry_base_delay_ms: number;
      retry_backoff_factor: string;
      retry_max_delay_ms: number | null;
      queue_id: string;
      payload: Record<string, unknown>;
    }>`
      SELECT attempts, max_attempts, retry_strategy, retry_base_delay_ms,
             retry_backoff_factor, retry_max_delay_ms, queue_id, payload
      FROM jobs
      WHERE id = ${args.jobId} AND locked_by = ${args.workerId} AND locked_until > now()
      FOR UPDATE
    `.execute(trx);
    if (sel.rows.length === 0) return { fenced: false }; // lease lost
    const j = sel.rows[0]!;

    await sql`
      UPDATE job_executions SET status = 'failed', finished_at = now(), error = ${args.error}
      WHERE job_id = ${args.jobId} AND attempt = ${j.attempts} AND status = 'running'
    `.execute(trx);

    if (shouldRetry(j.attempts, j.max_attempts)) {
      const cfg: RetryConfig = {
        strategy: j.retry_strategy,
        baseDelayMs: j.retry_base_delay_ms,
        backoffFactor: Number(j.retry_backoff_factor),
        maxDelayMs: j.retry_max_delay_ms,
        maxAttempts: j.max_attempts,
      };
      const delayMs = computeBackoffMs(cfg, j.attempts, args.rand);
      await sql`
        UPDATE jobs
           SET status = 'retrying',
               run_at = now() + make_interval(secs => ${delayMs / 1000}),
               locked_by = NULL, locked_until = NULL, last_error = ${args.error}, updated_at = now()
         WHERE id = ${args.jobId}
      `.execute(trx);
      await sql`UPDATE queues SET stat_running = GREATEST(stat_running - 1, 0), updated_at = now() WHERE id = ${j.queue_id}`.execute(trx);
      return { fenced: true, outcome: 'retrying', delayMs };
    }

    await moveToDeadTx(trx, {
      jobId: args.jobId,
      queueId: j.queue_id,
      payload: j.payload,
      attempts: j.attempts,
      deathReason: 'max_attempts_exhausted',
      finalError: args.error,
    });
    return { fenced: true, outcome: 'dead' };
  });
}

/**
 * Fenced immediate dead-letter for failures that skip the retry decision
 * entirely — unknown handler name, payload validation failure. Unlike
 * `failJob`, there is no "does it have attempts left" branch: retrying an
 * unregistered handler or a payload that will never parse can't ever
 * succeed, so it dead-letters on the FIRST failure regardless of attempts.
 * Still goes through the ONE `moveToDeadTx` path (finding #7) and is fenced
 * identically to completeJob/failJob.
 */
export async function deadLetterFenced(
  db: Kysely<Database>,
  args: { jobId: string; workerId: string; deathReason: string; finalError: string },
): Promise<FenceResult> {
  return db.transaction().execute(async (trx) => {
    const sel = await sql<{ queue_id: string; payload: Record<string, unknown>; attempts: number }>`
      SELECT queue_id, payload, attempts FROM jobs
      WHERE id = ${args.jobId} AND locked_by = ${args.workerId} AND locked_until > now()
      FOR UPDATE
    `.execute(trx);
    if (sel.rows.length === 0) return { fenced: false };
    const j = sel.rows[0]!;
    await sql`
      UPDATE job_executions SET status = 'failed', finished_at = now(), error = ${args.finalError}
      WHERE job_id = ${args.jobId} AND attempt = ${j.attempts} AND status = 'running'
    `.execute(trx);
    await moveToDeadTx(trx, {
      jobId: args.jobId,
      queueId: j.queue_id,
      payload: j.payload,
      attempts: j.attempts,
      deathReason: args.deathReason,
      finalError: args.finalError,
    });
    return { fenced: true, outcome: 'dead' };
  });
}

/** The ONE terminal-failure path (finding #7). Used by failJob and the reaper. */
export async function moveToDeadTx(
  trx: Transaction<Database>,
  args: {
    jobId: string;
    queueId: string;
    payload: Record<string, unknown>;
    attempts: number;
    deathReason: string;
    finalError: string | null;
  },
): Promise<void> {
  await sql`
    INSERT INTO dead_letter_jobs (job_id, queue_id, payload, attempts, death_reason, final_error)
    VALUES (${args.jobId}, ${args.queueId}, ${JSON.stringify(args.payload)}::jsonb,
            ${args.attempts}, ${args.deathReason}, ${args.finalError})
    ON CONFLICT (job_id) DO NOTHING
  `.execute(trx);
  // Transition to dead from ANY non-dead status, capturing the PRIOR status so we
  // decrement the right counter. Gating on `status <> 'dead'` keeps it idempotent
  // (a re-death is a no-op); keying the counter off the prior status keeps stats
  // correct even for a future caller that dead-letters a queued/retrying job
  // (e.g. cancel/force-kill, plan R7) — not just the running-only callers today.
  const res = await sql<{ prev_status: string }>`
    WITH prev AS (SELECT status FROM jobs WHERE id = ${args.jobId})
    UPDATE jobs SET status = 'dead', locked_by = NULL, locked_until = NULL,
                    death_reason = ${args.deathReason}, last_error = ${args.finalError}, updated_at = now()
    WHERE id = ${args.jobId} AND status <> 'dead'
    RETURNING (SELECT status FROM prev) AS prev_status
  `.execute(trx);
  if (res.rows.length === 0) return; // already dead -> idempotent no-op
  const prev = res.rows[0]!.prev_status;
  await sql`
    UPDATE queues
       SET stat_running = GREATEST(stat_running - ${prev === 'running' ? 1 : 0}, 0),
           stat_queued  = GREATEST(stat_queued  - ${prev === 'queued' ? 1 : 0}, 0),
           stat_dead    = stat_dead + 1,
           updated_at   = now()
     WHERE id = ${args.queueId}
  `.execute(trx);
}

/**
 * Promoter internals (§5): scheduled/retrying rows whose time has come become
 * claimable. Maintains queues.stat_queued in the same statement so the
 * dashboard counter can't drift. Takes an already-open transaction so the
 * maintenance loop can compose it under its own short, lock-gated tx
 * (see `promoteDueJobs` below) rather than one fused leader transaction
 * (D2-Eng-1: a single long leader tx holds write locks on `queues` rows the
 * claim path also touches, head-of-line-blocking claims for the whole tick).
 */
export async function promoteDueJobsTx(trx: Transaction<Database>): Promise<number> {
  const res = await sql<{ n: number }>`
    WITH promoted AS (
      UPDATE jobs SET status = 'queued', updated_at = now()
      WHERE status IN ('scheduled','retrying') AND run_at <= now()
      RETURNING id, queue_id
    ),
    bump AS (
      UPDATE queues q SET stat_queued = stat_queued + c.n, updated_at = now()
      FROM (SELECT queue_id, count(*)::int AS n FROM promoted GROUP BY queue_id) c
      WHERE q.id = c.queue_id
    )
    SELECT count(*)::int AS n FROM promoted
  `.execute(trx);
  return Number(res.rows[0]?.n ?? 0);
}

/**
 * Public, leader-gated entrypoint: its own short transaction, guarded by a
 * non-blocking `pg_try_advisory_xact_lock(2, 0)` (namespace 2 = maintenance
 * leader, distinct from namespace 1 = per-queue claim budget — R3). If
 * another worker already holds the leader lock this instant, this is a
 * no-op (returns 0) rather than blocking — the next maintenance tick tries
 * again. The lock is xact-scoped so it releases automatically on commit,
 * even on throw (R15).
 */
export async function promoteDueJobs(db: Kysely<Database>): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const got = await sql<{ ok: boolean }>`SELECT pg_try_advisory_xact_lock(2, 0) AS ok`.execute(trx);
    if (!got.rows[0]?.ok) return 0;
    return promoteDueJobsTx(trx);
  });
}

/**
 * Lease reaper internals (§4): expired 'running' jobs -> queued (retries
 * left) or dead. Takes an already-open transaction (see `reclaimStuckJobs`
 * below for the leader-gating wrapper — same short-transaction rationale as
 * `promoteDueJobsTx`).
 */
export async function reclaimStuckJobsTx(trx: Transaction<Database>): Promise<number> {
  const stuck = await sql<{
    id: string;
    queue_id: string;
    payload: Record<string, unknown>;
    attempts: number;
    max_attempts: number;
  }>`
    SELECT id, queue_id, payload, attempts, max_attempts
    FROM jobs
    WHERE status = 'running'
      AND (locked_until < now() OR locked_by IS NULL)  -- expired lease, or orphaned by a deleted worker
    FOR UPDATE SKIP LOCKED
  `.execute(trx);

  for (const j of stuck.rows) {
    // close the dangling execution row so attempt-numbers stay consistent (R5)
    await sql`
      UPDATE job_executions SET status = 'failed', finished_at = now(),
             error = 'reclaimed: worker lease expired'
      WHERE job_id = ${j.id} AND attempt = ${j.attempts} AND status = 'running'
    `.execute(trx);

    if (j.attempts < j.max_attempts) {
      await sql`
        UPDATE jobs SET status = 'queued', locked_by = NULL, locked_until = NULL,
                        run_at = now(), last_error = 'reclaimed: worker lease expired', updated_at = now()
        WHERE id = ${j.id}
      `.execute(trx);
      await sql`UPDATE queues SET stat_running = GREATEST(stat_running - 1, 0), stat_queued = stat_queued + 1, updated_at = now() WHERE id = ${j.queue_id}`.execute(trx);
    } else {
      await moveToDeadTx(trx, {
        jobId: j.id,
        queueId: j.queue_id,
        payload: j.payload,
        attempts: j.attempts,
        deathReason: 'reclaimed_final',
        finalError: 'reclaimed on final attempt: worker lease expired',
      });
    }
  }
  return stuck.rows.length;
}

/** Public, leader-gated entrypoint — see `promoteDueJobs` for the pattern. */
export async function reclaimStuckJobs(db: Kysely<Database>): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const got = await sql<{ ok: boolean }>`SELECT pg_try_advisory_xact_lock(2, 0) AS ok`.execute(trx);
    if (!got.rows[0]?.ok) return 0;
    return reclaimStuckJobsTx(trx);
  });
}

// ============================================================================
// API-facing job creation, listing, detail, retry, cancel (Part 2B)
// ============================================================================

export interface JobRow {
  id: string;
  queue_id: string;
  recurring_job_id: string | null;
  type: JobType;
  handler_name: string;
  status: JobStatus;
  priority: number;
  payload: Record<string, unknown>;
  dedupe_key: string | null;
  run_at: Date;
  attempts: number;
  max_attempts: number;
  retry_strategy: RetryStrategy;
  retry_base_delay_ms: number;
  retry_backoff_factor: string;
  retry_max_delay_ms: number | null;
  locked_by: string | null;
  locked_until: Date | null;
  last_error: string | null;
  death_reason: string | null;
  duration_ms: number | null;
  claimed_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Existence + org-scope check reused by every job-creation/listing entrypoint. */
export async function getQueueForJob(db: Kysely<Database>, orgId: string, queueId: string): Promise<{ id: string } | undefined> {
  const res = await sql<{ id: string }>`
    SELECT q.id FROM queues q JOIN projects p ON p.id = q.project_id
    WHERE q.id = ${queueId} AND p.org_id = ${orgId}
  `.execute(db);
  return res.rows[0];
}

/** Freeze the retry contract onto the job at insert time (§3): the queue's
 *  policy if it has one, else DEFAULT_RETRY_CONFIG. Same COALESCE pattern
 *  the cron promoter uses (Part 2C) so both paths agree. */
export async function resolveRetryContract(db: Kysely<Database>, queueId: string) {
  const row = await sql<{
    strategy: RetryStrategy | null;
    base_delay_ms: number | null;
    backoff_factor: string | null;
    max_delay_ms: number | null;
    max_attempts: number | null;
  }>`
    SELECT rp.strategy, rp.base_delay_ms, rp.backoff_factor, rp.max_delay_ms, rp.max_attempts
    FROM queues q LEFT JOIN retry_policies rp ON rp.id = q.retry_policy_id
    WHERE q.id = ${queueId}
  `.execute(db);
  const r = row.rows[0];
  if (!r || r.strategy == null) {
    return {
      strategy: DEFAULT_RETRY_CONFIG.strategy,
      base_delay_ms: DEFAULT_RETRY_CONFIG.baseDelayMs,
      backoff_factor: DEFAULT_RETRY_CONFIG.backoffFactor,
      max_delay_ms: DEFAULT_RETRY_CONFIG.maxDelayMs,
      max_attempts: DEFAULT_RETRY_CONFIG.maxAttempts,
    };
  }
  return {
    strategy: r.strategy,
    base_delay_ms: r.base_delay_ms!,
    backoff_factor: Number(r.backoff_factor),
    max_delay_ms: r.max_delay_ms,
    max_attempts: r.max_attempts!,
  };
}

export type CreateJobResult =
  | { kind: 'created'; job: JobRow }
  | { kind: 'duplicate'; job: JobRow } // idempotent enqueue (R13/finding #13): existing live job with the same dedupe_key
  | { kind: 'queue_not_found' };

interface InsertJobArgs {
  queueId: string;
  type: JobType;
  handlerName: string;
  payload: Record<string, unknown>;
  status: 'queued' | 'scheduled';
  runAt: Date;
  priority?: number;
  dedupeKey?: string;
}

async function insertJob(db: Kysely<Database>, args: InsertJobArgs): Promise<CreateJobResult> {
  return db.transaction().execute(async (trx) => {
    const retry = await resolveRetryContract(trx, args.queueId);
    const res = await sql<JobRow>`
      INSERT INTO jobs (queue_id, type, handler_name, status, priority, payload, dedupe_key, run_at,
                         max_attempts, retry_strategy, retry_base_delay_ms, retry_backoff_factor, retry_max_delay_ms)
      VALUES (${args.queueId}, ${args.type}, ${args.handlerName}, ${args.status}, ${args.priority ?? 5},
              ${JSON.stringify(args.payload)}::jsonb, ${args.dedupeKey ?? null}, ${args.runAt},
              ${retry.max_attempts}, ${retry.strategy}, ${retry.base_delay_ms}, ${retry.backoff_factor}, ${retry.max_delay_ms})
      ON CONFLICT (queue_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND status NOT IN ('completed','dead') DO NOTHING
      RETURNING *
    `.execute(trx);

    if (res.rows.length > 0) {
      const job = { ...res.rows[0]!, retry_backoff_factor: String(res.rows[0]!.retry_backoff_factor) };
      if (args.status === 'queued') {
        await sql`UPDATE queues SET stat_queued = stat_queued + 1, updated_at = now() WHERE id = ${args.queueId}`.execute(trx);
      }
      return { kind: 'created', job };
    }

    // ON CONFLICT DO NOTHING -> 0 rows: a live job already holds this dedupe_key.
    // Return it as an idempotent 200, not a 500 (R13).
    const existing = await trx
      .selectFrom('jobs')
      .selectAll()
      .where('queue_id', '=', args.queueId)
      .where('dedupe_key', '=', args.dedupeKey ?? '')
      .where('status', 'not in', ['completed', 'dead'])
      .executeTakeFirst();
    if (existing) return { kind: 'duplicate', job: existing as unknown as JobRow };
    throw new Error('insertJob: 0 rows returned with no matching dedupe_key — this should be unreachable');
  });
}

export interface CreateSingleJobArgs {
  orgId: string;
  queueId: string;
  handlerName: string;
  payload: Record<string, unknown>;
  priority?: number;
  dedupeKey?: string;
}

/** immediate -> status=queued, run_at=now() */
export async function createImmediateJob(db: Kysely<Database>, args: CreateSingleJobArgs): Promise<CreateJobResult> {
  const queue = await getQueueForJob(db, args.orgId, args.queueId);
  if (!queue) return { kind: 'queue_not_found' };
  return insertJob(db, { ...args, type: 'immediate', status: 'queued', runAt: new Date() });
}

/** delayed -> status=scheduled, run_at=now()+delaySeconds */
export async function createDelayedJob(
  db: Kysely<Database>,
  args: CreateSingleJobArgs & { delaySeconds: number },
): Promise<CreateJobResult> {
  const queue = await getQueueForJob(db, args.orgId, args.queueId);
  if (!queue) return { kind: 'queue_not_found' };
  const runAt = new Date(Date.now() + args.delaySeconds * 1000);
  return insertJob(db, { ...args, type: 'delayed', status: 'scheduled', runAt });
}

/** scheduled -> status=scheduled, run_at=scheduledAt (future-check is the route layer's job) */
export async function createScheduledJob(
  db: Kysely<Database>,
  args: CreateSingleJobArgs & { scheduledAt: Date },
): Promise<CreateJobResult> {
  const queue = await getQueueForJob(db, args.orgId, args.queueId);
  if (!queue) return { kind: 'queue_not_found' };
  return insertJob(db, { ...args, type: 'scheduled', status: 'scheduled', runAt: args.scheduledAt });
}

export interface BatchItem {
  payload: Record<string, unknown>;
  priority?: number;
  dedupeKey?: string;
}

export interface BatchResult {
  created: string[];
  skipped: Array<{ index: number; dedupe_key: string; reason: 'duplicate' }>;
}

/**
 * D2-DX-5: explicit partial-failure semantics — a client can always tell
 * which items landed vs. deduped, never a silent drop. One tx, small loop
 * (bounded by the route's item-count cap — not a hot path).
 */
export async function createBatch(
  db: Kysely<Database>,
  args: { orgId: string; queueId: string; handlerName: string; items: BatchItem[] },
): Promise<BatchResult | 'queue_not_found'> {
  const queue = await getQueueForJob(db, args.orgId, args.queueId);
  if (!queue) return 'queue_not_found';

  const created: string[] = [];
  const skipped: BatchResult['skipped'] = [];
  for (let i = 0; i < args.items.length; i++) {
    const item = args.items[i]!;
    const result = await insertJob(db, {
      queueId: args.queueId,
      type: 'batch',
      handlerName: args.handlerName,
      payload: item.payload,
      status: 'queued',
      runAt: new Date(),
      priority: item.priority,
      dedupeKey: item.dedupeKey,
    });
    if (result.kind === 'created') created.push(result.job.id);
    else if (result.kind === 'duplicate') skipped.push({ index: i, dedupe_key: item.dedupeKey!, reason: 'duplicate' });
  }
  return { created, skipped };
}

/** R15: sort is NEVER interpolated from the request — only ever one of these
 *  hardcoded (column, direction) pairs, selected by a whitelisted key. */
const SORT_ALLOWLIST: Record<string, { column: 'created_at' | 'priority' | 'run_at'; direction: 'asc' | 'desc' }> = {
  'created_at:desc': { column: 'created_at', direction: 'desc' },
  'created_at:asc': { column: 'created_at', direction: 'asc' },
  'priority:desc': { column: 'priority', direction: 'desc' },
  'priority:asc': { column: 'priority', direction: 'asc' },
  'run_at:asc': { column: 'run_at', direction: 'asc' },
  'run_at:desc': { column: 'run_at', direction: 'desc' },
};
const DEFAULT_SORT = 'created_at:desc';

export interface ListJobsArgs {
  orgId: string;
  status?: JobStatus[];
  type?: JobType;
  createdAfter?: Date;
  createdBefore?: Date;
  sort?: string;
  limit: number;
  offset: number;
}

function resolveSort(sort: string | undefined): { column: 'created_at' | 'priority' | 'run_at'; direction: 'asc' | 'desc' } {
  const key = sort && SORT_ALLOWLIST[sort] ? sort : DEFAULT_SORT;
  return SORT_ALLOWLIST[key]!;
}

export async function listJobsByQueue(
  db: Kysely<Database>,
  args: ListJobsArgs & { queueId: string },
): Promise<PaginatedResult<JobRow> | 'queue_not_found'> {
  const queue = await getQueueForJob(db, args.orgId, args.queueId);
  if (!queue) return 'queue_not_found';

  // Conditional query building inline (Kysely's recommended pattern) — each
  // reassignment is inferred locally within this function, never passed
  // across a function boundary as a shared generic type (that path fights
  // Kysely's overloaded selectFrom() typing; see git history for the attempt).
  let query = db.selectFrom('jobs').where('queue_id', '=', args.queueId);
  if (args.status && args.status.length > 0) query = query.where('status', 'in', args.status);
  if (args.type) query = query.where('type', '=', args.type);
  if (args.createdAfter) query = query.where('created_at', '>=', args.createdAfter);
  if (args.createdBefore) query = query.where('created_at', '<=', args.createdBefore);

  const totalRow = await query.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst();
  const total = Number(totalRow?.n ?? 0);

  const sortSpec = resolveSort(args.sort);
  const rows = await query.selectAll().orderBy(sortSpec.column, sortSpec.direction).limit(args.limit).offset(args.offset).execute();

  return { data: rows as unknown as JobRow[], total, limit: args.limit, offset: args.offset };
}

export async function listJobsByProject(
  db: Kysely<Database>,
  args: ListJobsArgs & { projectId: string },
): Promise<PaginatedResult<JobRow> | 'project_not_found'> {
  const project = await db
    .selectFrom('projects')
    .select('id')
    .where('id', '=', args.projectId)
    .where('org_id', '=', args.orgId)
    .executeTakeFirst();
  if (!project) return 'project_not_found';

  let query = db
    .selectFrom('jobs')
    .where('queue_id', 'in', db.selectFrom('queues').select('id').where('project_id', '=', args.projectId));
  if (args.status && args.status.length > 0) query = query.where('status', 'in', args.status);
  if (args.type) query = query.where('type', '=', args.type);
  if (args.createdAfter) query = query.where('created_at', '>=', args.createdAfter);
  if (args.createdBefore) query = query.where('created_at', '<=', args.createdBefore);

  const totalRow = await query.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst();
  const total = Number(totalRow?.n ?? 0);

  const sortSpec = resolveSort(args.sort);
  const rows = await query.selectAll().orderBy(sortSpec.column, sortSpec.direction).limit(args.limit).offset(args.offset).execute();

  return { data: rows as unknown as JobRow[], total, limit: args.limit, offset: args.offset };
}

export interface JobExecutionRow {
  id: string;
  job_id: string;
  worker_id: string | null;
  attempt: number;
  status: string;
  started_at: Date;
  finished_at: Date | null;
  duration_ms: number | null;
  error: string | null;
}

export interface JobLogRow {
  id: number;
  job_id: string;
  execution_id: string | null;
  level: string;
  message: string;
  logged_at: Date;
}

export interface JobDetail {
  job: JobRow;
  /** Doubles as the retry history — each row already carries attempt number,
   *  worker, timing, and error. A separate retry_history table would just
   *  duplicate this data (DRY). */
  executions: JobExecutionRow[];
  logs: JobLogRow[];
}

export async function getJobDetail(
  db: Kysely<Database>,
  args: { orgId: string; jobId: string; logsLimit?: number },
): Promise<JobDetail | undefined> {
  const jobRes = await sql<JobRow>`
    SELECT j.* FROM jobs j
    JOIN queues q ON q.id = j.queue_id
    JOIN projects p ON p.id = q.project_id
    WHERE j.id = ${args.jobId} AND p.org_id = ${args.orgId}
  `.execute(db);
  const job = jobRes.rows[0];
  if (!job) return undefined;

  const executions = await db
    .selectFrom('job_executions')
    .selectAll()
    .where('job_id', '=', args.jobId)
    .orderBy('attempt', 'asc')
    .execute();
  const logs = await db
    .selectFrom('job_logs')
    .selectAll()
    .where('job_id', '=', args.jobId)
    .orderBy('logged_at', 'desc')
    .limit(args.logsLimit ?? 200)
    .execute();

  return { job, executions, logs };
}

export type RetryResult = 'retried' | 'not_found' | 'not_retryable';

/**
 * D2-Eng-4 fix: bumps `max_attempts` (grants a fresh retry budget) rather
 * than resetting `attempts=0`. Zeroing would make the next claim re-increment
 * to attempts=1 — but a job_executions row for (job_id, attempt=1) already
 * exists from the original run, so UNIQUE(job_id,attempt) throws on the very
 * next re-run. Bumping the ceiling needs no schema change and preserves
 * monotonic attempt numbering.
 */
export async function retryJob(db: Kysely<Database>, args: { orgId: string; jobId: string }): Promise<RetryResult> {
  return db.transaction().execute(async (trx) => {
    const sel = await sql<{ id: string; status: JobStatus; queue_id: string; attempts: number }>`
      SELECT j.id, j.status, j.queue_id, j.attempts
      FROM jobs j JOIN queues q ON q.id = j.queue_id JOIN projects p ON p.id = q.project_id
      WHERE j.id = ${args.jobId} AND p.org_id = ${args.orgId}
      FOR UPDATE OF j
    `.execute(trx);
    const row = sel.rows[0];
    if (!row) return 'not_found';
    if (row.status !== 'dead' && row.status !== 'retrying') return 'not_retryable';

    const grantedAttempts = DEFAULT_RETRY_CONFIG.maxAttempts; // grant one more full retry cycle
    await sql`
      UPDATE jobs
         SET status = 'queued', run_at = now(), locked_by = NULL, locked_until = NULL,
             max_attempts = ${row.attempts + grantedAttempts}, death_reason = NULL, last_error = NULL, updated_at = now()
       WHERE id = ${args.jobId}
    `.execute(trx);

    if (row.status === 'dead') {
      await sql`DELETE FROM dead_letter_jobs WHERE job_id = ${args.jobId}`.execute(trx);
      await sql`
        UPDATE queues SET stat_dead = GREATEST(stat_dead - 1, 0), stat_queued = stat_queued + 1, updated_at = now()
        WHERE id = ${row.queue_id}
      `.execute(trx);
    } else {
      // was 'retrying' -> forced to 'queued' immediately, ahead of its backoff
      await sql`UPDATE queues SET stat_queued = stat_queued + 1, updated_at = now() WHERE id = ${row.queue_id}`.execute(trx);
    }
    return 'retried';
  });
}

export type CancelResult = 'cancelled' | 'not_found' | 'already_running';

/**
 * R7: cancel is legal only on queued/scheduled/retrying; running returns
 * 'already_running' (409 at the route layer). Cancel transitions to its own
 * `cancelled` terminal state — never `dead` — so the DLQ stays free of jobs
 * that never actually failed.
 */
export async function cancelJob(db: Kysely<Database>, args: { orgId: string; jobId: string }): Promise<CancelResult> {
  const res = await sql<{ id: string; queue_id: string; was_queued: boolean }>`
    WITH target AS (
      SELECT j.id, j.queue_id, (j.status = 'queued') AS was_queued
      FROM jobs j JOIN queues q ON q.id = j.queue_id JOIN projects p ON p.id = q.project_id
      WHERE j.id = ${args.jobId} AND p.org_id = ${args.orgId}
        AND j.status IN ('queued', 'scheduled', 'retrying')
      FOR UPDATE OF j
    )
    UPDATE jobs j SET status = 'cancelled', locked_by = NULL, locked_until = NULL, updated_at = now()
    FROM target t
    WHERE j.id = t.id
    RETURNING j.id, t.queue_id, t.was_queued
  `.execute(db);

  if (res.rows.length > 0) {
    const row = res.rows[0]!;
    if (row.was_queued) {
      await sql`UPDATE queues SET stat_queued = GREATEST(stat_queued - 1, 0), updated_at = now() WHERE id = ${row.queue_id}`.execute(db);
    }
    return 'cancelled';
  }

  // 0 rows: either not found (wrong org too), or found but not in a cancellable
  // state (running/completed/dead/cancelled). Read-only disambiguation — the
  // atomic decision already happened above, this only picks the error code.
  const scoped = await sql<{ id: string }>`
    SELECT j.id FROM jobs j JOIN queues q ON q.id = j.queue_id JOIN projects p ON p.id = q.project_id
    WHERE j.id = ${args.jobId} AND p.org_id = ${args.orgId}
  `.execute(db);
  return scoped.rows.length > 0 ? 'already_running' : 'not_found';
}
