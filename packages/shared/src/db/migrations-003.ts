import { type Kysely, type Migration, sql } from 'kysely';

/**
 * Part 2C prep. Two independent, unrelated changes bundled into one migration
 * because both are small, additive, and needed before the cron promoter ships:
 *
 * 1. `idx_jobs_recurring`: an FK-lookup index for `jobs.recurring_job_id` —
 *    without it, looking up a schedule's occurrences (or a future
 *    ON DELETE SET NULL cascade from scheduled_jobs) seq-scans `jobs`.
 * 2. A CHECK on `dead_letter_jobs.death_reason` constraining it to the exact
 *    closed set the code actually produces (grepped from every
 *    moveToDeadTx call site, not copied from the original plan draft, which
 *    predates the `shutdown_final` reason added during Part 2A's graceful
 *    shutdown work — using the plan's stale 4-value list here would have
 *    broken graceful shutdown of a final-attempt job). Validates immediately
 *    (no NOT VALID) since moveToDeadTx is the sole writer into this table.
 */
export const m003_recurring_index_and_death_reason_check: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`CREATE INDEX idx_jobs_recurring ON jobs (recurring_job_id) WHERE recurring_job_id IS NOT NULL`.execute(db);
    await sql`
      ALTER TABLE dead_letter_jobs
      ADD CONSTRAINT dead_letter_jobs_death_reason_check
      CHECK (death_reason IN ('max_attempts_exhausted', 'reclaimed_final', 'invalid_payload', 'unknown_handler', 'shutdown_final'))
    `.execute(db);
  },

  async down(db: Kysely<unknown>): Promise<void> {
    await sql`ALTER TABLE dead_letter_jobs DROP CONSTRAINT IF EXISTS dead_letter_jobs_death_reason_check`.execute(db);
    await sql`DROP INDEX IF EXISTS idx_jobs_recurring`.execute(db);
  },
};
