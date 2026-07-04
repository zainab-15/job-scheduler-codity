import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';

/** Append a job_logs row. Used by the worker's ctx.log() (§5). */
export async function insertJobLog(
  db: Kysely<Database>,
  args: { jobId: string; executionId?: string | null; level: string; message: string },
): Promise<void> {
  await db
    .insertInto('job_logs')
    .values({
      job_id: args.jobId,
      execution_id: args.executionId ?? null,
      level: args.level,
      message: args.message,
    })
    .execute();
}
