import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { type DB, claimJobs, completeJob, insertJobLog } from '@scheduler/shared';
import { closeTestDb, getTestDb, resetDb } from '../../shared/test/pg-harness.js';
import { authHeader, buildTestServer, createProjectAndQueue, registerAccount } from './helpers.js';

let db: DB;
let server: FastifyInstance;

beforeAll(async () => {
  db = await getTestDb();
  server = await buildTestServer(db);
});

beforeEach(async () => {
  await resetDb(db);
});

afterAll(async () => {
  await closeTestDb();
});

/**
 * Simulates "one worker tick" using the exact same production primitives
 * (claimJobs/completeJob) the real @scheduler/worker process runs — but NOT
 * a full Worker (poll/heartbeat/maintenance loops). Worker-process
 * correctness is already proven by packages/worker's 7 integration tests;
 * this file's job is to prove the API's write-then-read paths (create,
 * detail, list) are correct against real DB state transitions, without
 * paying for or re-testing the whole process lifecycle.
 */
async function simulateSuccessfulTick(queueId: string, workerId: string): Promise<string> {
  const claimed = await claimJobs(db, { queueId, workerId, localFree: 10, leaseSeconds: 30 });
  if (claimed.length !== 1) throw new Error(`expected exactly 1 claimable job, got ${claimed.length}`);
  const job = claimed[0]!;
  await insertJobLog(db, { jobId: job.id, level: 'info', message: 'simulated handler ran' });
  const result = await completeJob(db, { jobId: job.id, workerId, durationMs: 42 });
  if (!result.fenced) throw new Error('completeJob was not fenced — claim must have failed silently');
  return job.id;
}

async function seedWorkerRow(orgId: string): Promise<string> {
  const row = await db
    .insertInto('workers')
    .values({ hostname: `test-${orgId.slice(0, 8)}`, pid: process.pid, status: 'active', concurrency: 10 })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

describe('job lifecycle E2E (register -> project -> queue -> job -> tick -> detail)', () => {
  it('an immediate job flows from queued to completed with an execution row and a log line', async () => {
    const account = await registerAccount(server);
    const headers = authHeader(account.token);
    const { queueId } = await createProjectAndQueue(server, account.token);

    const created = await server.inject({
      method: 'POST',
      url: `/api/v1/queues/${queueId}/jobs`,
      headers,
      payload: { type: 'immediate', handler_name: 'sleep', payload: { ms: 1 } },
    });
    expect(created.statusCode).toBe(201);
    const jobId = created.json().id as string;
    expect(created.json().status).toBe('queued');

    const beforeTick = await server.inject({ method: 'GET', url: `/api/v1/jobs/${jobId}`, headers });
    expect(beforeTick.json().job.status).toBe('queued');
    expect(beforeTick.json().executions).toHaveLength(0);

    const workerId = await seedWorkerRow(account.orgId);
    await simulateSuccessfulTick(queueId, workerId);

    const afterTick = await server.inject({ method: 'GET', url: `/api/v1/jobs/${jobId}`, headers });
    expect(afterTick.statusCode).toBe(200);
    const detail = afterTick.json();
    expect(detail.job.status).toBe('completed');
    expect(detail.executions).toHaveLength(1);
    expect(detail.executions[0].status).toBe('succeeded');
    expect(detail.logs.some((l: { message: string }) => l.message === 'simulated handler ran')).toBe(true);
  });

  it('a delayed job is created as scheduled with a future run_at; a scheduled job requires a future timestamp', async () => {
    const account = await registerAccount(server);
    const headers = authHeader(account.token);
    const { queueId } = await createProjectAndQueue(server, account.token);

    const delayed = await server.inject({
      method: 'POST',
      url: `/api/v1/queues/${queueId}/jobs`,
      headers,
      payload: { type: 'delayed', handler_name: 'sleep', payload: {}, delay_seconds: 3600 },
    });
    expect(delayed.statusCode).toBe(201);
    expect(delayed.json().status).toBe('scheduled');
    expect(new Date(delayed.json().run_at).getTime()).toBeGreaterThan(Date.now());

    const pastScheduled = await server.inject({
      method: 'POST',
      url: `/api/v1/queues/${queueId}/jobs`,
      headers,
      payload: { type: 'scheduled', handler_name: 'sleep', payload: {}, scheduled_at: new Date(Date.now() - 60_000).toISOString() },
    });
    expect(pastScheduled.statusCode).toBe(400);

    const futureScheduled = await server.inject({
      method: 'POST',
      url: `/api/v1/queues/${queueId}/jobs`,
      headers,
      payload: { type: 'scheduled', handler_name: 'sleep', payload: {}, scheduled_at: new Date(Date.now() + 3_600_000).toISOString() },
    });
    expect(futureScheduled.statusCode).toBe(201);
    expect(futureScheduled.json().status).toBe('scheduled');
    expect(futureScheduled.json().type).toBe('scheduled');
  });

  it('rejects an unknown job type via the discriminator with a clean INVALID_JOB_TYPE envelope (D2-DX-3)', async () => {
    const account = await registerAccount(server);
    const headers = authHeader(account.token);
    const { queueId } = await createProjectAndQueue(server, account.token);

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/queues/${queueId}/jobs`,
      headers,
      payload: { type: 'recurring', handler_name: 'sleep', cron: '* * * * *' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_JOB_TYPE');
    expect(res.json().error.details.allowed).toEqual(['immediate', 'delayed', 'scheduled', 'batch']);
  });

  it('idempotent enqueue: re-posting the same dedupe_key returns the existing job with 200, not a 500 (R13)', async () => {
    const account = await registerAccount(server);
    const headers = authHeader(account.token);
    const { queueId } = await createProjectAndQueue(server, account.token);
    const payload = { type: 'immediate', handler_name: 'sleep', payload: { ms: 1 }, dedupe_key: 'daily-report' };

    const first = await server.inject({ method: 'POST', url: `/api/v1/queues/${queueId}/jobs`, headers, payload });
    expect(first.statusCode).toBe(201);

    const second = await server.inject({ method: 'POST', url: `/api/v1/queues/${queueId}/jobs`, headers, payload });
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
  });

  it('lists jobs by queue with the pagination envelope', async () => {
    const account = await registerAccount(server);
    const headers = authHeader(account.token);
    const { queueId } = await createProjectAndQueue(server, account.token);

    for (let i = 0; i < 3; i++) {
      await server.inject({
        method: 'POST',
        url: `/api/v1/queues/${queueId}/jobs`,
        headers,
        payload: { type: 'immediate', handler_name: 'sleep', payload: { ms: 1 } },
      });
    }

    const res = await server.inject({ method: 'GET', url: `/api/v1/queues/${queueId}/jobs?limit=2&offset=0`, headers });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(2);
    expect(body.pagination).toEqual({ total: 3, limit: 2, offset: 0, has_more: true });
  });
});

describe('batch job creation (D2-DX-5 partial-failure semantics)', () => {
  it('the dedicated /jobs/batch endpoint reports created + skipped separately', async () => {
    const account = await registerAccount(server);
    const headers = authHeader(account.token);
    const { queueId } = await createProjectAndQueue(server, account.token);

    // Pre-existing job holding a dedupe_key that one of the batch items will collide with.
    await server.inject({
      method: 'POST',
      url: `/api/v1/queues/${queueId}/jobs`,
      headers,
      payload: { type: 'immediate', handler_name: 'sleep', payload: { ms: 1 }, dedupe_key: 'batch-item-1' },
    });

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/queues/${queueId}/jobs/batch`,
      headers,
      payload: {
        handler_name: 'sleep',
        items: [
          { payload: { ms: 1 }, dedupe_key: 'batch-item-1' }, // collides -> skipped
          { payload: { ms: 1 }, dedupe_key: 'batch-item-2' }, // fresh -> created
          { payload: { ms: 1 } }, // no dedupe_key -> always created
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.count).toEqual({ created: 2, skipped: 1 });
    expect(body.created).toHaveLength(2);
    expect(body.skipped).toEqual([{ index: 0, dedupe_key: 'batch-item-1', reason: 'duplicate' }]);
  });
});
