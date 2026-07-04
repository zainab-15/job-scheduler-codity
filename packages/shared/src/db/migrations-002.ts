import { type Kysely, type Migration, sql } from 'kysely';

/**
 * Adds 'cancelled' to job_status (R7): cancel must NOT collapse into 'dead'
 * — that would pollute the DLQ with user-cancelled jobs that never actually
 * failed. This is the first 002_* file per the "001 is frozen" rule in
 * migrations.ts — DDL changes after 001 has run anywhere always go in a new
 * numbered file, never edited into 001 itself.
 *
 * Postgres note: `ALTER TYPE ... ADD VALUE` cannot be used in the SAME
 * transaction that then references the new label — but it CAN be committed
 * here and used freely by any LATER transaction (which is exactly how every
 * caller of 'cancelled' works: a separate query, in a separate transaction).
 */
export const m002_cancelled_status: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'cancelled'`.execute(db);
  },

  async down(): Promise<void> {
    // Postgres has no ALTER TYPE ... DROP VALUE. Reversing this would mean
    // renaming the type, creating a new one without 'cancelled', migrating
    // every column, then dropping the old type — out of scope for a value
    // that, once used, would need those rows re-classified anyway. Forward-only,
    // as is common practice for enum additions. No-op.
  },
};
