import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DB, createLogger } from '@scheduler/shared';
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

describe('drain — multiple live workers, zero double execution', () => {
  it('3 workers drain a mixed success/failure queue with exactly one success per job, none run twice', async () => {
    const { queueId } = await seedQueue(db, { concurrency_limit: 20 });
    await insertJobs(db, queueId, 15, { handler: 'sleep', payload: { ms: 20 } });
    await insertJobs(db, queueId, 5, { handler: 'always_fail', maxAttempts: 1 });

    const registry = buildDefaultRegistry();
    const log = createLogger('worker', 'error');
    workers = Array.from({ length: 3 }, () => new Worker(db, testWorkerConfig(), registry, log));
    await Promise.all(workers.map((w) => w.start()));

    await waitUntil(async () => {
      const rows = await db.selectFrom('jobs').select('status').where('queue_id', '=', queueId).execute();
      return rows.length === 20 && rows.every((r) => r.status === 'completed' || r.status === 'dead');
    }, 15000);

    const jobIds = (await db.selectFrom('jobs').select('id').where('queue_id', '=', queueId).execute()).map((r) => r.id);
    const executions = await db.selectFrom('job_executions').selectAll().where('job_id', 'in', jobIds).execute();

    // zero double-runs: at most one 'succeeded' execution row per job, ever
    const succeededByJob = new Map<string, number>();
    for (const e of executions) {
      if (e.status === 'succeeded') succeededByJob.set(e.job_id, (succeededByJob.get(e.job_id) ?? 0) + 1);
    }
    for (const count of succeededByJob.values()) expect(count).toBe(1);

    const statuses = await db.selectFrom('jobs').select('status').where('queue_id', '=', queueId).execute();
    expect(statuses.filter((r) => r.status === 'completed')).toHaveLength(15);
    expect(statuses.filter((r) => r.status === 'dead')).toHaveLength(5);
  });
});
