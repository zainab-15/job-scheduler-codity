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
  | { kind: 'invalid_cron'; message: string }
  | { kind: 'invalid_timezone'; message: string };

/** Minimal logger surface for the promoter's per-row skip/disable warnings.
 *  Optional everywhere so tests and the shared package stay pino-free. */
export interface PromoteLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

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
  // C4: an invalid IANA timezone makes cron-parser throw. Catch it here and
  // return a clean 400 (invalid_timezone) instead of letting it fall through
  // to the API's generic 500 handler — and, critically, refuse to PERSIST an
  // unschedulable timezone that would later poison the promoter (C3's root
  // cause at the front door).
  let firstRun: Date;
  try {
    firstRun = nextRunAt(args.cronExpression, new Date(), timezone);
  } catch (err) {
    return { kind: 'invalid_timezone', message: `invalid timezone "${timezone}": ${err instanceof Error ? err.message : String(err)}` };
  }

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
export async function promoteRecurringTx(trx: Transaction<Database>, log?: PromoteLogger): Promise<number> {
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
    // C3: compute the NEXT fire time FIRST — this is the only per-row step that
    // can throw a pure-JS error (a bad IANA tz that became invalid after a
    // tzdata update, a cron-parser edge case). This is the actual poison
    // vector the fix targets: it happens in JS, before any SQL for this row, so
    // catching it here does NOT poison the surrounding Postgres transaction.
    // On a throw, DISABLE the schedule so it stops being re-selected every tick
    // and freezing the whole batch. Without this, one unparseable schedule
    // rolls back the entire tick and re-throws forever, halting ALL cron
    // promotion system-wide with only a generic error log.
    // (We compute `next` before the INSERT rather than after — a harmless
    // reorder; the dedupe_key still keys off the CURRENT next_run_at below.)
    let next: Date;
    try {
      next = nextRunAt(s.cron_expression, new Date(), s.timezone);
    } catch (err) {
      await sql`UPDATE scheduled_jobs SET is_enabled = false, updated_at = now() WHERE id = ${s.id}`.execute(trx);
      log?.warn(
        { scheduleId: s.id, cron: s.cron_expression, timezone: s.timezone, err: err instanceof Error ? err.message : String(err) },
        'disabled unschedulable recurring job (unparseable cron/timezone)',
      );
      continue;
    }

    // DB writes run directly in the outer trx (Kysely 0.27 has no
    // savepoint/nested-transaction support). These statements can't throw a
    // row-SPECIFIC error in practice: the INSERT is ON CONFLICT DO NOTHING
    // (dedupe handled), retry_* come from resolveRetryContract (always valid),
    // and every jobs CHECK constraint is satisfied by construction. A throw
    // here would therefore be systemic (connection loss, PG down), which
    // SHOULD abort the tick and retry next tick — not a per-row poison loop.
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
export async function promoteRecurring(db: Kysely<Database>, log?: PromoteLogger): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const got = await sql<{ ok: boolean }>`SELECT pg_try_advisory_xact_lock(2, 0) AS ok`.execute(trx);
    if (!got.rows[0]?.ok) return 0;
    return promoteRecurringTx(trx, log);
  });
}
