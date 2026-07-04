import { type Kysely, sql } from 'kysely';
import type { Database, RetryStrategy } from '../db/types.js';
import type { DeleteResult, PaginatedResult } from './projects.js';

/**
 * Queues with at least one claimable job right now: not paused, has a
 * status='queued' row whose run_at is due. The worker's poll loop iterates
 * this list each tick instead of scanning every queue in the system.
 */
export async function listClaimableQueueIds(db: Kysely<Database>): Promise<string[]> {
  const res = await sql<{ id: string }>`
    SELECT DISTINCT q.id
    FROM queues q
    JOIN jobs j ON j.queue_id = q.id
    WHERE q.is_paused = false
      AND j.status = 'queued'
      AND j.run_at <= now()
  `.execute(db);
  return res.rows.map((r) => r.id);
}

export interface QueueRow {
  id: string;
  project_id: string;
  retry_policy_id: string | null;
  name: string;
  priority: number;
  concurrency_limit: number;
  is_paused: boolean;
  stat_queued: number;
  stat_running: number;
  stat_completed: number;
  stat_dead: number;
  created_at: Date;
  updated_at: Date;
}

export interface RetryPolicyInput {
  strategy: RetryStrategy;
  baseDelayMs: number;
  backoffFactor: number;
  maxDelayMs: number | null;
  maxAttempts: number;
}

export interface RetryPolicyDetail {
  id: string;
  strategy: string;
  base_delay_ms: number;
  backoff_factor: number;
  max_delay_ms: number | null;
  max_attempts: number;
}

export interface QueueDetail extends QueueRow {
  retry_policy: RetryPolicyDetail | null;
}

async function createRetryPolicyForProject(
  db: Kysely<Database>,
  projectId: string,
  name: string,
  input: RetryPolicyInput,
): Promise<string> {
  const row = await db
    .insertInto('retry_policies')
    .values({
      project_id: projectId,
      name,
      strategy: input.strategy,
      base_delay_ms: input.baseDelayMs,
      backoff_factor: input.backoffFactor,
      max_delay_ms: input.maxDelayMs,
      max_attempts: input.maxAttempts,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function createQueue(
  db: Kysely<Database>,
  args: {
    orgId: string;
    projectId: string;
    name: string;
    priority?: number;
    concurrencyLimit?: number;
    retryPolicyId?: string;
    retryPolicy?: RetryPolicyInput;
  },
): Promise<QueueRow | 'project_not_found'> {
  const project = await db
    .selectFrom('projects')
    .select('id')
    .where('id', '=', args.projectId)
    .where('org_id', '=', args.orgId)
    .executeTakeFirst();
  if (!project) return 'project_not_found';

  let retryPolicyId = args.retryPolicyId ?? null;
  if (!retryPolicyId && args.retryPolicy) {
    retryPolicyId = await createRetryPolicyForProject(db, args.projectId, `${args.name}-policy`, args.retryPolicy);
  }

  return db
    .insertInto('queues')
    .values({
      project_id: args.projectId,
      retry_policy_id: retryPolicyId,
      name: args.name,
      priority: args.priority ?? 5,
      concurrency_limit: args.concurrencyLimit ?? 5,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function listQueues(
  db: Kysely<Database>,
  args: { orgId: string; projectId: string; limit: number; offset: number },
): Promise<PaginatedResult<QueueRow>> {
  const res = await sql<QueueRow & { total: string }>`
    SELECT q.*, count(*) OVER()::int AS total
    FROM queues q
    JOIN projects p ON p.id = q.project_id
    WHERE q.project_id = ${args.projectId} AND p.org_id = ${args.orgId}
    ORDER BY q.created_at DESC
    LIMIT ${args.limit} OFFSET ${args.offset}
  `.execute(db);
  const total = res.rows.length > 0 ? Number(res.rows[0]!.total) : 0;
  return { data: res.rows, total, limit: args.limit, offset: args.offset };
}

export async function getQueueDetail(db: Kysely<Database>, args: { orgId: string; queueId: string }): Promise<QueueDetail | undefined> {
  const queue = await sql<QueueRow>`
    SELECT q.* FROM queues q JOIN projects p ON p.id = q.project_id
    WHERE q.id = ${args.queueId} AND p.org_id = ${args.orgId}
  `.execute(db);
  const row = queue.rows[0];
  if (!row) return undefined;

  let retryPolicy: RetryPolicyDetail | null = null;
  if (row.retry_policy_id) {
    const rp = await db.selectFrom('retry_policies').selectAll().where('id', '=', row.retry_policy_id).executeTakeFirst();
    if (rp) {
      retryPolicy = {
        id: rp.id,
        strategy: rp.strategy,
        base_delay_ms: rp.base_delay_ms,
        backoff_factor: Number(rp.backoff_factor),
        max_delay_ms: rp.max_delay_ms,
        max_attempts: rp.max_attempts,
      };
    }
  }
  return { ...row, retry_policy: retryPolicy };
}

/** Update config. `retryPolicyId` reassigns to an EXISTING policy (no inline
 *  creation here — that's create-time only, keeping this endpoint simple). */
export async function updateQueue(
  db: Kysely<Database>,
  args: { orgId: string; queueId: string; priority?: number; concurrencyLimit?: number; retryPolicyId?: string | null },
): Promise<QueueRow | undefined> {
  const patch: Record<string, unknown> = {};
  if (args.priority !== undefined) patch.priority = args.priority;
  if (args.concurrencyLimit !== undefined) patch.concurrency_limit = args.concurrencyLimit;
  if (args.retryPolicyId !== undefined) patch.retry_policy_id = args.retryPolicyId;

  if (Object.keys(patch).length === 0) {
    const res = await sql<QueueRow>`
      SELECT q.* FROM queues q JOIN projects p ON p.id = q.project_id
      WHERE q.id = ${args.queueId} AND p.org_id = ${args.orgId}
    `.execute(db);
    return res.rows[0];
  }

  return db
    .updateTable('queues')
    .set(patch)
    .where('id', '=', args.queueId)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('projects')
          .select('id')
          .whereRef('projects.id', '=', 'queues.project_id')
          .where('projects.org_id', '=', args.orgId),
      ),
    )
    .returningAll()
    .executeTakeFirst();
}

async function setQueuePaused(db: Kysely<Database>, args: { orgId: string; queueId: string }, paused: boolean): Promise<QueueRow | undefined> {
  return db
    .updateTable('queues')
    .set({ is_paused: paused })
    .where('id', '=', args.queueId)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('projects')
          .select('id')
          .whereRef('projects.id', '=', 'queues.project_id')
          .where('projects.org_id', '=', args.orgId),
      ),
    )
    .returningAll()
    .executeTakeFirst();
}

export async function pauseQueue(db: Kysely<Database>, args: { orgId: string; queueId: string }): Promise<QueueRow | undefined> {
  return setQueuePaused(db, args, true);
}

export async function resumeQueue(db: Kysely<Database>, args: { orgId: string; queueId: string }): Promise<QueueRow | undefined> {
  return setQueuePaused(db, args, false);
}

/** Guarded, atomic delete — same DELETE...WHERE NOT EXISTS(running) pattern
 *  as deleteProject (R11): no check-then-delete race. */
export async function deleteQueue(db: Kysely<Database>, args: { orgId: string; queueId: string }): Promise<DeleteResult> {
  const del = await sql<{ id: string }>`
    DELETE FROM queues q
    USING projects p
    WHERE q.id = ${args.queueId} AND q.project_id = p.id AND p.org_id = ${args.orgId}
      AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.queue_id = q.id AND j.status = 'running')
    RETURNING q.id
  `.execute(db);
  if (del.rows.length > 0) return 'deleted';

  const exists = await sql<{ id: string }>`
    SELECT q.id FROM queues q JOIN projects p ON p.id = q.project_id
    WHERE q.id = ${args.queueId} AND p.org_id = ${args.orgId}
  `.execute(db);
  return exists.rows.length > 0 ? 'has_running_jobs' : 'not_found';
}

export interface QueueStatsResult {
  queue_id: string;
  is_paused: boolean;
  counts: { queued: number; scheduled: number; running: number; retrying: number; completed: number; dead: number };
  window_hours: number;
  completed_in_window: number;
  failed_in_window: number;
  avg_duration_ms: number | null;
  dlq_size: number;
}

export async function getQueueStats(
  db: Kysely<Database>,
  args: { orgId: string; queueId: string; windowHours: number },
): Promise<QueueStatsResult | undefined> {
  const queue = await sql<{ is_paused: boolean; stat_queued: number; stat_running: number; stat_completed: number; stat_dead: number }>`
    SELECT q.is_paused, q.stat_queued, q.stat_running, q.stat_completed, q.stat_dead
    FROM queues q JOIN projects p ON p.id = q.project_id
    WHERE q.id = ${args.queueId} AND p.org_id = ${args.orgId}
  `.execute(db);
  const q = queue.rows[0];
  if (!q) return undefined;

  // stat_* already tracks queued/running/completed/dead transactionally (§3);
  // 'scheduled'/'retrying' are read live since they're not separately counted there
  const live = await sql<{ scheduled: string; retrying: string }>`
    SELECT
      count(*) FILTER (WHERE status = 'scheduled')::int AS scheduled,
      count(*) FILTER (WHERE status = 'retrying')::int AS retrying
    FROM jobs WHERE queue_id = ${args.queueId}
  `.execute(db);

  const windowAgg = await sql<{ completed: string; failed: string; avg_ms: string | null }>`
    SELECT
      count(*) FILTER (WHERE e.status = 'succeeded')::int AS completed,
      count(*) FILTER (WHERE e.status = 'failed')::int AS failed,
      avg(e.duration_ms) FILTER (WHERE e.status = 'succeeded') AS avg_ms
    FROM job_executions e
    JOIN jobs j ON j.id = e.job_id
    WHERE j.queue_id = ${args.queueId} AND e.finished_at >= now() - make_interval(hours => ${args.windowHours})
  `.execute(db);

  const dlq = await sql<{ n: string }>`SELECT count(*)::int AS n FROM dead_letter_jobs WHERE queue_id = ${args.queueId}`.execute(db);

  const w = windowAgg.rows[0]!;
  const l = live.rows[0]!;
  return {
    queue_id: args.queueId,
    is_paused: q.is_paused,
    counts: {
      queued: q.stat_queued,
      scheduled: Number(l.scheduled),
      running: q.stat_running,
      retrying: Number(l.retrying),
      completed: q.stat_completed,
      dead: q.stat_dead,
    },
    window_hours: args.windowHours,
    completed_in_window: Number(w.completed),
    failed_in_window: Number(w.failed),
    avg_duration_ms: w.avg_ms != null ? Math.round(Number(w.avg_ms)) : null,
    dlq_size: Number(dlq.rows[0]?.n ?? 0),
  };
}
