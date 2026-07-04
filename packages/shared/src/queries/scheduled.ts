import { type Kysely, type Transaction, sql } from 'kysely';
import type { Database } from '../db/types.js';
import { nextRunAt, validateCron } from '../domain/cron.js';
import { getQueueForJob, resolveRetryContract } from './jobs.js';

export interface ScheduledJobRow {
  id: string;
  queue_id: string;
  retry_policy_id: string | null;
  handler_name: string;
  cron_expression: string;
  timezone: string;
  payload: Record<string, unknown>;
  next_run_at: Date;
  is_enabled: boolean;
  last_enqueued_at: Date | null;
  last_job_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export type CreateRecurringResult =
  | { kind: 'created'; schedule: ScheduledJobRow }
  | { kind: 'queue_not_found' }
  | { kind: 'invalid_cron'; message: string };

export interface CreateRecurringArgs {
  orgId: string;
  queueId: string;
  handlerName: string;
  payload: Record<string, unknown>;
  cronExpression: string;
  timezone?: string;
}

/** Creates a recurring-job TEMPLATE (a scheduled_jobs row), not a job itself
 *  (R28's least-astonishment move — see routes/jobs.ts's POST /schedules). */
export async function createRecurringJob(db: Kysely<Database>, args: CreateRecurringArgs): Promise<CreateRecurringResult> {
  const cronCheck = validateCron(args.cronExpression);
  if (!cronCheck.valid) return { kind: 'invalid_cron', message: cronCheck.message };
  const queue = await getQueueForJob(db, args.orgId, args.queueId);
  if (!queue) return { kind: 'queue_not_found' };

  const timezone = args.timezone ?? 'UTC';
  const firstRun = nextRunAt(args.cronExpression, new Date(), timezone);

  const row = await sql<ScheduledJobRow>`
    INSERT INTO scheduled_jobs (queue_id, handler_name, cron_expression, timezone, payload, next_run_at)
    VALUES (${args.queueId}, ${args.handlerName}, ${args.cronExpression}, ${timezone},
            ${JSON.stringify(args.payload)}::jsonb, ${firstRun})
    RETURNING *
  `.execute(db);
  return { kind: 'created', schedule: row.rows[0]! };
}

/**
 * Cron promoter internals (Part 2C, §5/R9). Takes an already-open transaction
 * (same short-transaction pattern as reclaimStuckJobsTx/promoteDueJobsTx —
 * D2-Eng-1) so the maintenance loop composes it as its own independently
 * lock-gated step. For each due schedule:
 *   1. FOR UPDATE SKIP LOCKED on scheduled_jobs — guard #1 against a
 *      concurrent promoter (belt, alongside the single-leader lock).
 *   2. Freeze the retry contract from the schedule's OWN queue, COALESCEd to
 *      DEFAULT_RETRY_CONFIG if the queue has no retry_policy_id
 *      (D2-Eng-2/D2-CEO-3: scheduled_jobs/queues.retry_policy_id is a
 *      nullable SET NULL FK with no frozen retry columns of its own — without
 *      this fallback a queue with no explicit policy would insert a NULL
 *      into jobs.retry_strategy NOT NULL and throw mid-tick).
 *   3. INSERT the occurrence with dedupe_key='cron:{id}:{next_run_at ISO}'
 *      (the schedule's CURRENT next_run_at, read before advancing it) —
 *      guard #2, defense-in-depth alongside the SKIP LOCKED above.
 *   4. Advance next_run_at via nextRunAt(cron_expression, now(), timezone) —
 *      passing the schedule's OWN timezone through (a cheap miss would
 *      silently fire every recurring job in UTC). Using now() (not the old
 *      next_run_at) as the pivot IS the backlog-collapse: since this row was
 *      only selected because next_run_at <= now(), now() >= next_run_at
 *      always holds here, so advancing from now() always lands on the next
 *      tick strictly after the current moment — collapsing an arbitrarily
 *      large backlog (e.g. a leader down for days) to exactly one spawned
 *      occurrence per tick, never a thundering herd of missed slots.
 *   5. last_enqueued_at/last_job_id only update when a job was actually
 *      created (not when the dedupe guard skipped a conflicting re-fire) —
 *      but next_run_at ALWAYS advances, so a conflicting slot can't spin the
 *      same tick forever.
 */
export async function promoteRecurringTx(trx: Transaction<Database>): Promise<number> {
  const due = await sql<{
    id: string;
    queue_id: string;
    handler_name: string;
    payload: Record<string, unknown>;
    cron_expression: string;
    timezone: string;
    next_run_at: Date;
  }>`
    SELECT id, queue_id, handler_name, payload, cron_expression, timezone, next_run_at
    FROM scheduled_jobs
    WHERE is_enabled AND next_run_at <= now()
    FOR UPDATE SKIP LOCKED
  `.execute(trx);

  let promoted = 0;
  for (const s of due.rows) {
    const retry = await resolveRetryContract(trx, s.queue_id);
    const dedupeKey = `cron:${s.id}:${s.next_run_at.toISOString()}`;

    const inserted = await sql<{ id: string }>`
      INSERT INTO jobs (queue_id, recurring_job_id, type, handler_name, status, payload, dedupe_key, run_at,
                         max_attempts, retry_strategy, retry_base_delay_ms, retry_backoff_factor, retry_max_delay_ms)
      VALUES (${s.queue_id}, ${s.id}, 'recurring', ${s.handler_name}, 'queued',
              ${JSON.stringify(s.payload)}::jsonb, ${dedupeKey}, now(),
              ${retry.max_attempts}, ${retry.strategy}, ${retry.base_delay_ms}, ${retry.backoff_factor}, ${retry.max_delay_ms})
      ON CONFLICT (queue_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND status NOT IN ('completed','dead') DO NOTHING
      RETURNING id
    `.execute(trx);

    if (inserted.rows.length > 0) {
      await sql`UPDATE queues SET stat_queued = stat_queued + 1, updated_at = now() WHERE id = ${s.queue_id}`.execute(trx);
    }

    const next = nextRunAt(s.cron_expression, new Date(), s.timezone);
    const newJobId = inserted.rows[0]?.id ?? null;
    await sql`
      UPDATE scheduled_jobs
         SET next_run_at = ${next}, updated_at = now(),
             last_enqueued_at = CASE WHEN ${newJobId}::uuid IS NOT NULL THEN now() ELSE last_enqueued_at END,
             last_job_id = COALESCE(${newJobId}::uuid, last_job_id)
       WHERE id = ${s.id}
    `.execute(trx);

    promoted++;
  }
  return promoted;
}

/** Public, leader-gated entrypoint — same pattern as promoteDueJobs/reclaimStuckJobs. */
export async function promoteRecurring(db: Kysely<Database>): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const got = await sql<{ ok: boolean }>`SELECT pg_try_advisory_xact_lock(2, 0) AS ok`.execute(trx);
    if (!got.rows[0]?.ok) return 0;
    return promoteRecurringTx(trx);
  });
}
