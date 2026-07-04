import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { type DB, claimJobs, createLogger } from '@scheduler/shared';
import { closeTestDb, getTestDb, resetDb, seedQueue, seedWorker } from '../../shared/test/pg-harness.js';
import { buildDefaultRegistry } from '../src/handlers/index.js';
import { Worker } from '../src/worker.js';
import { insertJobs, testWorkerConfig, waitUntil } from './helpers.js';

let db: DB;
let workers: Worker[] = [];

beforeEach(async () => {
  db = await getTestDb();
  await resetDb(db);
  workers = [];
});

afterEach(async () => {
  await Promise.all(workers.map((w) => w.shutdown(false)));
});

afterAll(async () => {
  await closeTestDb();
});

describe('kill-recovery — a live Worker reclaims and completes an orphaned job exactly once', () => {
  it('a job orphaned by a simulated crash is reclaimed by the maintenance loop and completed by the poll loop', async () => {
    const { queueId } = await seedQueue(db, { concurrency_limit: 5 });
    await insertJobs(db, queueId, 1, { handler: 'sleep', payload: { ms: 50 } });

    // Simulate a crashed worker: claim the job directly, then force-expire its
    // lease (no more heartbeats will ever follow that claim — that IS what a
    // crash means) rather than waiting out a real lease duration.
    const crashedWorkerId = await seedWorker(db);
    const claimed = await claimJobs(db, { queueId, workerId: crashedWorkerId, localFree: 5, leaseSeconds: 30 });
    expect(claimed).toHaveLength(1);
    const jobId = claimed[0]!.id;
    await sql`UPDATE jobs SET locked_until = now() - interval '1 second' WHERE id = ${jobId}`.execute(db);

    // A REAL, live Worker — its own maintenance loop reclaims the stuck job on
    // its next tick, and its own poll loop then claims + completes it. This
    // exercises the actual orchestration Day-1's lower-level tests couldn't
    // (they only called the raw shared functions directly, never a live Worker).
    const registry = buildDefaultRegistry();
    const worker = new Worker(db, testWorkerConfig(), registry, createLogger('worker', 'error'));
    workers.push(worker);
    await worker.start();

    await waitUntil(async () => {
      const j = await db.selectFrom('jobs').select('status').where('id', '=', jobId).executeTakeFirst();
      return j?.status === 'completed';
    }, 10000);

    const execs = await db
      .selectFrom('job_executions')
      .selectAll()
      .where('job_id', '=', jobId)
      .orderBy('attempt', 'asc')
      .execute();
    expect(execs).toHaveLength(2);
    expect(execs[0]!.status).toBe('failed'); // the orphaned attempt, closed by the reaper
    expect(execs[1]!.status).toBe('succeeded'); // reclaimed + completed by the live worker
  });
});
