import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { claimJobs, completeJob, failJob, moveToDeadTx, reclaimStuckJobs } from '../src/queries/jobs.js';
import {
  type DB,
  closeTestDb,
  getTestDb,
  queueStats,
  resetDb,
  seedJobs,
  seedQueue,
  seedWorker,
} from './pg-harness.js';

let db: DB;

beforeEach(async () => {
  db = await getTestDb();
  await resetDb(db);
});

afterAll(async () => {
  await closeTestDb();
});

describe('fencing token on terminal writes (finding #3 / R3)', () => {
  it("a reclaimed slow worker's completeJob is a no-op, not a clobber", async () => {
    const { queueId } = await seedQueue(db, { concurrency_limit: 5 });
    await seedJobs(db, queueId, 1);
    const slow = await seedWorker(db);

    const claimed = await claimJobs(db, { queueId, workerId: slow, localFree: 5, leaseSeconds: 30 });
    const jobId = claimed[0]!.id;

    // simulate: this worker stalled, its lease expired, the reaper reclaimed it
    await sql`UPDATE jobs SET locked_until = now() - interval '1 second' WHERE id = ${jobId}`.execute(db);
    expect(await reclaimStuckJobs(db)).toBe(1);

    // the slow worker finally finishes and tries to commit success
    const result = await completeJob(db, { jobId, workerId: slow, durationMs: 5 });
    expect(result.fenced).toBe(false); // lease was lost -> abandoned

    const job = await db.selectFrom('jobs').selectAll().where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(job.status).toBe('queued'); // reclaimed back to queued, NOT completed
    expect(job.locked_by).toBeNull();
  });
});

describe('lease reaper (§4)', () => {
  it('does not touch a job with a live lease', async () => {
    const { queueId } = await seedQueue(db, { concurrency_limit: 5 });
    await seedJobs(db, queueId, 1);
    const w = await seedWorker(db);
    await claimJobs(db, { queueId, workerId: w, localFree: 5, leaseSeconds: 30 });

    expect(await reclaimStuckJobs(db)).toBe(0);
    const job = await db.selectFrom('jobs').selectAll().where('queue_id', '=', queueId).executeTakeFirstOrThrow();
    expect(job.status).toBe('running');
  });

  it('reclaims an expired job back to queued when attempts remain', async () => {
    const { queueId } = await seedQueue(db, { concurrency_limit: 5 });
    await seedJobs(db, queueId, 1, { maxAttempts: 3 });
    const w = await seedWorker(db);
    const claimed = await claimJobs(db, { queueId, workerId: w, localFree: 5, leaseSeconds: 30 });
    const jobId = claimed[0]!.id;

    await sql`UPDATE jobs SET locked_until = now() - interval '1 second' WHERE id = ${jobId}`.execute(db);
    expect(await reclaimStuckJobs(db)).toBe(1);

    const job = await db.selectFrom('jobs').selectAll().where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(job.status).toBe('queued');
    expect(job.locked_by).toBeNull();
    const exec = await db.selectFrom('job_executions').selectAll().where('job_id', '=', jobId).executeTakeFirstOrThrow();
    expect(exec.status).toBe('failed');
  });

  it('dead-letters (reclaimed_final) when a stuck job is on its final attempt', async () => {
    const { queueId } = await seedQueue(db, { concurrency_limit: 5 });
    await seedJobs(db, queueId, 1, { maxAttempts: 1 });
    const w = await seedWorker(db);
    const claimed = await claimJobs(db, { queueId, workerId: w, localFree: 5, leaseSeconds: 30 });
    const jobId = claimed[0]!.id; // attempts is now 1 == max_attempts

    await sql`UPDATE jobs SET locked_until = now() - interval '1 second' WHERE id = ${jobId}`.execute(db);
    expect(await reclaimStuckJobs(db)).toBe(1);

    const job = await db.selectFrom('jobs').selectAll().where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(job.status).toBe('dead');
    expect(job.death_reason).toBe('reclaimed_final');

    const dlq = await db.selectFrom('dead_letter_jobs').selectAll().where('job_id', '=', jobId).executeTakeFirstOrThrow();
    expect(dlq.death_reason).toBe('reclaimed_final');

    const stats = await queueStats(db, queueId);
    expect(stats.stat_dead).toBe(1);
  });

  it('reclaims a job orphaned by a deleted worker (locked_by IS NULL, lease not yet expired)', async () => {
    const { queueId } = await seedQueue(db, { concurrency_limit: 5 });
    await seedJobs(db, queueId, 1, { maxAttempts: 3 });
    const w = await seedWorker(db);
    const claimed = await claimJobs(db, { queueId, workerId: w, localFree: 5, leaseSeconds: 30 });
    const jobId = claimed[0]!.id;

    // deleting the worker SET NULLs jobs.locked_by while status stays 'running'
    await db.deleteFrom('workers').where('id', '=', w).execute();
    const orphan = await db.selectFrom('jobs').selectAll().where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(orphan.locked_by).toBeNull();
    expect(orphan.status).toBe('running');

    // reaper must catch it even though the lease clock hasn't expired
    expect(await reclaimStuckJobs(db)).toBe(1);
    const job = await db.selectFrom('jobs').selectAll().where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(job.status).toBe('queued');
  });
});

describe('moveToDeadTx idempotency (review P2)', () => {
  it('a second dead transition does not double-count stat_dead or the DLQ row', async () => {
    const { queueId } = await seedQueue(db, { concurrency_limit: 5 });
    await seedJobs(db, queueId, 1, { maxAttempts: 1 });
    const w = await seedWorker(db);
    const claimed = await claimJobs(db, { queueId, workerId: w, localFree: 5, leaseSeconds: 30 });
    const jobId = claimed[0]!.id;

    // first death via the normal failure path
    await failJob(db, { jobId, workerId: w, error: 'boom' });
    let stats = await queueStats(db, queueId);
    expect(stats.stat_dead).toBe(1);

    // simulate a redundant second death for the same job
    await db.transaction().execute((trx) =>
      moveToDeadTx(trx, { jobId, queueId, payload: {}, attempts: 1, deathReason: 'max_attempts_exhausted', finalError: 'boom' }),
    );

    stats = await queueStats(db, queueId);
    expect(stats.stat_dead).toBe(1); // NOT 2

    const dlqCount = await db.selectFrom('dead_letter_jobs').select((eb) => eb.fn.countAll<string>().as('n')).where('job_id', '=', jobId).executeTakeFirstOrThrow();
    expect(Number(dlqCount.n)).toBe(1);
  });
});
