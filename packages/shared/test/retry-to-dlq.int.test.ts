import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { claimJobs, failJob, promoteDueJobs } from '../src/queries/jobs.js';
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

describe('retry -> DLQ lifecycle', () => {
  it('fails with the exact backoff delay, pushes run_at into the future, then dead-letters', async () => {
    const { queueId } = await seedQueue(db, { concurrency_limit: 5 });
    await seedJobs(db, queueId, 1, { maxAttempts: 2 });
    const worker = await seedWorker(db);

    // attempt 1: claim -> fail -> retrying with a DETERMINISTIC backoff
    const c1 = await claimJobs(db, { queueId, workerId: worker, localFree: 5, leaseSeconds: 30 });
    expect(c1).toHaveLength(1);
    const jobId = c1[0]!.id;
    // exponential base 1000, attempt 1, rand 0.5 -> clamped 1000 -> round(500 + 0.5*500) = 750
    const f1 = await failJob(db, { jobId, workerId: worker, error: 'boom', rand: () => 0.5 });
    expect(f1).toEqual({ fenced: true, outcome: 'retrying', delayMs: 750 });

    let job = await db.selectFrom('jobs').selectAll().where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(job.status).toBe('retrying');
    expect(job.attempts).toBe(1);
    // run_at was actually pushed ~750ms into the future (the scheduling, not just the return value)
    expect(job.run_at.getTime()).toBeGreaterThan(Date.now());

    const exec1 = await db
      .selectFrom('job_executions')
      .selectAll()
      .where('job_id', '=', jobId)
      .where('attempt', '=', 1)
      .executeTakeFirstOrThrow();
    expect(exec1.status).toBe('failed');
    expect(exec1.error).toBe('boom');

    // make the retry due, promote it back to queued
    await sql`UPDATE jobs SET run_at = now() WHERE id = ${jobId}`.execute(db);
    expect(await promoteDueJobs(db)).toBe(1);

    // attempt 2: claim -> fail -> dead (attempts == max_attempts)
    const c2 = await claimJobs(db, { queueId, workerId: worker, localFree: 5, leaseSeconds: 30 });
    expect(c2).toHaveLength(1);
    const f2 = await failJob(db, { jobId, workerId: worker, error: 'boom again' });
    expect(f2.outcome).toBe('dead');

    job = await db.selectFrom('jobs').selectAll().where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(job.status).toBe('dead');
    expect(job.attempts).toBe(2);
    expect(job.death_reason).toBe('max_attempts_exhausted');

    const dlq = await db
      .selectFrom('dead_letter_jobs')
      .selectAll()
      .where('job_id', '=', jobId)
      .executeTakeFirstOrThrow();
    expect(dlq.death_reason).toBe('max_attempts_exhausted');
    expect(dlq.final_error).toBe('boom again');
    expect(dlq.attempts).toBe(2);

    // stat counters reconcile: one dead, none running
    const stats = await queueStats(db, queueId);
    expect(stats.stat_dead).toBe(1);
    expect(stats.stat_running).toBe(0);

    // a dead job is not claimable again
    const c3 = await claimJobs(db, { queueId, workerId: worker, localFree: 5, leaseSeconds: 30 });
    expect(c3).toHaveLength(0);

    // both attempts recorded as distinct execution rows (UNIQUE(job_id,attempt))
    const execs = await db.selectFrom('job_executions').selectAll().where('job_id', '=', jobId).execute();
    expect(execs.map((e) => e.attempt).sort()).toEqual([1, 2]);
  });
});

describe('promoteDueJobs', () => {
  it('promotes only DUE scheduled/retrying rows and maintains stat_queued', async () => {
    const { queueId } = await seedQueue(db, { concurrency_limit: 5 });
    // one scheduled DUE (past), one scheduled NOT due (future), one retrying DUE
    await db.insertInto('jobs').values([
      { queue_id: queueId, type: 'scheduled', handler_name: 'noop', status: 'scheduled', priority: 5, payload: {}, run_at: sql`now() - interval '1 minute'`, max_attempts: 3, retry_strategy: 'exponential', retry_base_delay_ms: 1000, retry_backoff_factor: 2, retry_max_delay_ms: 60000 },
      { queue_id: queueId, type: 'scheduled', handler_name: 'noop', status: 'scheduled', priority: 5, payload: {}, run_at: sql`now() + interval '1 hour'`, max_attempts: 3, retry_strategy: 'exponential', retry_base_delay_ms: 1000, retry_backoff_factor: 2, retry_max_delay_ms: 60000 },
      { queue_id: queueId, type: 'immediate', handler_name: 'noop', status: 'retrying', priority: 5, payload: {}, run_at: sql`now() - interval '1 second'`, attempts: 1, max_attempts: 3, retry_strategy: 'exponential', retry_base_delay_ms: 1000, retry_backoff_factor: 2, retry_max_delay_ms: 60000 },
    ]).execute();

    const promoted = await promoteDueJobs(db);
    expect(promoted).toBe(2); // the two due rows, not the future one

    const counts = await db
      .selectFrom('jobs')
      .select(['status', (eb) => eb.fn.countAll<string>().as('n')])
      .where('queue_id', '=', queueId)
      .groupBy('status')
      .execute();
    const byStatus = Object.fromEntries(counts.map((c) => [c.status, Number(c.n)]));
    expect(byStatus.queued).toBe(2);
    expect(byStatus.scheduled).toBe(1); // the future one untouched

    // stat_queued reflects the promotion (no drift)
    const stats = await queueStats(db, queueId);
    expect(stats.stat_queued).toBe(2);
  });
});
