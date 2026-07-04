import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DB, createLogger, promoteDueJobs } from '@scheduler/shared';
import { closeTestDb, getTestDb, resetDb, seedQueue } from '../../shared/test/pg-harness.js';
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

describe('graceful shutdown (§7)', () => {
  it('a job that finishes within the grace window completes normally, no requeue', async () => {
    const { queueId } = await seedQueue(db, { concurrency_limit: 5 });
    await insertJobs(db, queueId, 1, { handler: 'sleep', payload: { ms: 150 } });

    const registry = buildDefaultRegistry();
    const worker = new Worker(db, testWorkerConfig({ shutdownGraceMs: 3000 }), registry, createLogger('worker', 'error'));
    await worker.start();

    const jobId = (await db.selectFrom('jobs').select('id').where('queue_id', '=', queueId).executeTakeFirstOrThrow()).id;
    await waitUntil(async () => {
      const j = await db.selectFrom('jobs').select('status').where('id', '=', jobId).executeTakeFirst();
      return j?.status === 'running';
    }, 5000);

    await worker.shutdown(false); // awaits the full drain — the 150ms job finishes well inside the 3s grace window

    const job = await db.selectFrom('jobs').selectAll().where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(job.status).toBe('completed');
    const execs = await db.selectFrom('job_executions').selectAll().where('job_id', '=', jobId).execute();
    expect(execs).toHaveLength(1);
    expect(execs[0]!.status).toBe('succeeded');
  });

  it('a job that outlives the grace window is aborted+requeued, then completes EXACTLY ONCE elsewhere', async () => {
    const { queueId } = await seedQueue(db, { concurrency_limit: 5 });
    await insertJobs(db, queueId, 1, { handler: 'sleep', payload: { ms: 5000 } }); // long; won't finish in the short grace window

    const registry = buildDefaultRegistry();
    const workerA = new Worker(db, testWorkerConfig({ shutdownGraceMs: 200 }), registry, createLogger('worker', 'error'));
    await workerA.start();

    const jobId = (await db.selectFrom('jobs').select('id').where('queue_id', '=', queueId).executeTakeFirstOrThrow()).id;
    await waitUntil(async () => {
      const j = await db.selectFrom('jobs').select('status').where('id', '=', jobId).executeTakeFirst();
      return j?.status === 'running';
    }, 5000);

    await workerA.shutdown(false); // the 200ms grace expires long before the 5s sleep finishes

    // Abort (-> failJob, retry-with-backoff) and shutdown's own requeueInflight
    // race to resolve the same job — BOTH paths are fenced and safe (see
    // worker.ts's shutdown() comment), so either 'queued' or 'retrying' is a
    // correct outcome; asserting one exact status here would be flaky by
    // design, not a real bug. The invariant that actually matters is proven
    // below: exactly one success, ever, and the lock isn't stuck on workerA.
    let job = await db.selectFrom('jobs').selectAll().where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(job.locked_by).toBeNull();
    expect(['queued', 'retrying']).toContain(job.status);

    // a second, fresh worker drains whichever state it's in (promoting a
    // 'retrying' row itself, via its own maintenance loop) and completes it
    const workerB = new Worker(db, testWorkerConfig(), registry, createLogger('worker', 'error'));
    workers.push(workerB);
    await workerB.start();
    await promoteDueJobs(db); // nudge a 'retrying' row across if its backoff already elapsed

    await waitUntil(async () => {
      const j = await db.selectFrom('jobs').select('status').where('id', '=', jobId).executeTakeFirst();
      return j?.status === 'completed';
    }, 10000);

    job = await db.selectFrom('jobs').selectAll().where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(job.status).toBe('completed');
    const execs = await db.selectFrom('job_executions').selectAll().where('job_id', '=', jobId).execute();
    const succeeded = execs.filter((e) => e.status === 'succeeded');
    expect(succeeded).toHaveLength(1); // EXACTLY ONE success across every attempt
  }, 15000);
});
