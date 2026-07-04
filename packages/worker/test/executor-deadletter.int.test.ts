import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { type DB, claimJobs, createLogger } from '@scheduler/shared';
import { closeTestDb, getTestDb, resetDb, seedQueue, seedWorker } from '../../shared/test/pg-harness.js';
import { buildDefaultRegistry } from '../src/handlers/index.js';
import { runJob } from '../src/executor.js';
import { insertJobs } from './helpers.js';

let db: DB;

beforeEach(async () => {
  db = await getTestDb();
  await resetDb(db);
});

afterAll(async () => {
  await closeTestDb();
});

/**
 * C7: the executor's two "can never succeed, dead-letter on the first attempt"
 * branches. Both death_reason values (unknown_handler, invalid_payload) are in
 * the migration-003 CHECK constraint but were previously never exercised — if
 * either dead-letter path regressed, no test would have caught it.
 */
describe('executor immediate dead-letter paths (unknown_handler / invalid_payload)', () => {
  async function claimAndRun(queueId: string, workerId: string): Promise<void> {
    const claimed = await claimJobs(db, { queueId, workerId, localFree: 5, leaseSeconds: 30 });
    expect(claimed).toHaveLength(1);
    const deps = { db, workerId, registry: buildDefaultRegistry(), baseLog: createLogger('worker', 'error'), leaseSeconds: 30 };
    await runJob(deps, claimed[0]!, new AbortController().signal);
  }

  it('an unregistered handler_name dead-letters with death_reason=unknown_handler on the first attempt', async () => {
    const { queueId } = await seedQueue(db, { concurrency_limit: 5 });
    await insertJobs(db, queueId, 1, { handler: 'no_such_handler', maxAttempts: 3 });
    const workerId = await seedWorker(db);

    await claimAndRun(queueId, workerId);

    const job = await db.selectFrom('jobs').selectAll().where('queue_id', '=', queueId).executeTakeFirstOrThrow();
    expect(job.status).toBe('dead');
    expect(job.death_reason).toBe('unknown_handler');
    // dead-lettered on attempt 1 despite max_attempts=3 — retrying an unknown
    // handler can never help, so no retry cycle is spent.
    expect(job.attempts).toBe(1);

    const dlq = await db.selectFrom('dead_letter_jobs').selectAll().where('job_id', '=', job.id).executeTakeFirstOrThrow();
    expect(dlq.death_reason).toBe('unknown_handler');
  });

  it('a payload that fails the handler zod schema dead-letters with death_reason=invalid_payload', async () => {
    const { queueId } = await seedQueue(db, { concurrency_limit: 5 });
    // sleep's schema is z.object({ ms: z.number().int().positive().default(1000) });
    // a string ms can never coerce -> parse failure -> invalid_payload.
    await insertJobs(db, queueId, 1, { handler: 'sleep', payload: { ms: 'not-a-number' }, maxAttempts: 3 });
    const workerId = await seedWorker(db);

    await claimAndRun(queueId, workerId);

    const job = await db.selectFrom('jobs').selectAll().where('queue_id', '=', queueId).executeTakeFirstOrThrow();
    expect(job.status).toBe('dead');
    expect(job.death_reason).toBe('invalid_payload');
    expect(job.attempts).toBe(1);

    const dlq = await db.selectFrom('dead_letter_jobs').selectAll().where('job_id', '=', job.id).executeTakeFirstOrThrow();
    expect(dlq.death_reason).toBe('invalid_payload');
  });
});
