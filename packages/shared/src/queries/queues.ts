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

/**
 * C1 (IDOR fix): a client-supplied retry_policy_id must belong to the SAME
 * project as the queue it's being attached to. Without this check, an org
 * member could attach ANY org's retry_policies row to their own queue (the
 * FK only enforces existence, not ownership), and getQueueDetail would then
 * echo that other org's policy config back to them — a cross-tenant leak that
 * violates the org-scoping invariant every other path upholds. Same-project
 * (not merely same-org) is the tightest correct scope: retry policies are
 * defined per project and consumed by queues within that project.
 */
async function retryPolicyBelongsToProject(db: Kysely<Database>, retryPolicyId: string, projectId: string): Promise<boolean> {
  const row = await db
    .selectFrom('retry_policies')
    .select('id')
    .where('id', '=', retryPolicyId)
    .where('project_id', '=', projectId)
    .executeTakeFirst();
  return !!row;
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
): Promise<QueueRow | 'project_not_found' | 'policy_not_found'> {
  const project = await db
    .selectFrom('projects')
    .select('id')
    .where('id', '=', args.projectId)
    .where('org_id', '=', args.orgId)
    .executeTakeFirst();
  if (!project) return 'project_not_found';

  let retryPolicyId = args.retryPolicyId ?? null;
  if (retryPolicyId) {
    // C1: reject a policy that isn't in this queue's own project (cross-org IDOR)
    if (!(await retryPolicyBelongsToProject(db, retryPolicyId, args.projectId))) return 'policy_not_found';
  } else if (args.retryPolicy) {
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

export type UpdateQueueResult = QueueRow | 'not_found' | 'policy_not_found';

/** Update config. `retryPolicyId` reassigns to an EXISTING policy (no inline
 *  creation here — that's create-time only, keeping this endpoint simple). */
export async function updateQueue(
  db: Kysely<Database>,
  args: { orgId: string; queueId: string; priority?: number; concurrencyLimit?: number; retryPolicyId?: string | null },
): Promise<UpdateQueueResult> {
  // Fetch the org-scoped queue first so we know its project_id (needed to
  // validate a reassigned policy against C1) and so a cross-org queue id is a
  // clean 'not_found' rather than a silently-skipped update.
  const existing = await sql<QueueRow>`
    SELECT q.* FROM queues q JOIN projects p ON p.id = q.project_id
    WHERE q.id = ${args.queueId} AND p.org_id = ${args.orgId}
  `.execute(db);
  const queue = existing.rows[0];
  if (!queue) return 'not_found';

  const patch: Record<string, unknown> = {};
  if (args.priority !== undefined) patch.priority = args.priority;
  if (args.concurrencyLimit !== undefined) patch.concurrency_limit = args.concurrencyLimit;
  if (args.retryPolicyId !== undefined) {
    // C1: a non-null reassigned policy must belong to this queue's own project.
    if (args.retryPolicyId !== null && !(await retryPolicyBelongsToProject(db, args.retryPolicyId, queue.project_id))) {
      return 'policy_not_found';
    }
    patch.retry_policy_id = args.retryPolicyId;
  }

  if (Object.keys(patch).length === 0) return queue; // empty patch -> echo current row

  const updated = await db.updateTable('queues').set(patch).where('id', '=', args.queueId).returningAll().executeTakeFirst();
  return updated ?? 'not_found';
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

/** Guarded, atomic delete — same DELETE...WHERE NOT EXISTS pattern as
 *  deleteProject (R11): no check-then-delete race. C2: blocks on any
 *  non-terminal job OR enabled schedule, not just running jobs, so deleting a
 *  queue can't silently cascade away pending work + active cron templates. */
export async function deleteQueue(db: Kysely<Database>, args: { orgId: string; queueId: string }): Promise<DeleteResult> {
  const del = await sql<{ id: string }>`
    DELETE FROM queues q
    USING projects p
    WHERE q.id = ${args.queueId} AND q.project_id = p.id AND p.org_id = ${args.orgId}
      AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.queue_id = q.id AND j.status IN ('running','queued','scheduled','retrying'))
      AND NOT EXISTS (SELECT 1 FROM scheduled_jobs s WHERE s.queue_id = q.id AND s.is_enabled = true)
    RETURNING q.id
  `.execute(db);
  if (del.rows.length > 0) return 'deleted';

  const exists = await sql<{ id: string }>`
    SELECT q.id FROM queues q JOIN projects p ON p.id = q.project_id
    WHERE q.id = ${args.queueId} AND p.org_id = ${args.orgId}
  `.execute(db);
  return exists.rows.length > 0 ? 'has_pending_work' : 'not_found';
}

export interface QueueStatsResult {
  queue_id: string;
  is_paused: boolean;
  counts: { queued: number; scheduled: number; running: number; retrying: number; completed: number; dead: number; cancelled: number };
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
  // 'scheduled'/'retrying'/'cancelled' are read live since they're not separately
  // counted there ('cancelled' added in migration 002 — R7)
  const live = await sql<{ scheduled: string; retrying: string; cancelled: string }>`
    SELECT
      count(*) FILTER (WHERE status = 'scheduled')::int AS scheduled,
      count(*) FILTER (WHERE status = 'retrying')::int AS retrying,
      count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
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
      cancelled: Number(l.cancelled),
    },
    window_hours: args.windowHours,
    completed_in_window: Number(w.completed),
    failed_in_window: Number(w.failed),
    avg_duration_ms: w.avg_ms != null ? Math.round(Number(w.avg_ms)) : null,
    dlq_size: Number(dlq.rows[0]?.n ?? 0),
  };
}
