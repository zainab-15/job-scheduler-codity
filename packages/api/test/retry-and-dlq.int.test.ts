import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { type DB, claimJobs, failJob } from '@scheduler/shared';
import { sql } from 'kysely';
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

async function seedWorkerRow(): Promise<string> {
  const row = await db
    .insertInto('workers')
    .values({ hostname: `test-${Math.random().toString(36).slice(2)}`, pid: process.pid, status: 'active', concurrency: 10 })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Drives a job straight to `dead` in one failed attempt (maxAttempts must be 1 on its queue). */
async function killJobImmediately(queueId: string, workerId: string): Promise<string> {
  const claimed = await claimJobs(db, { queueId, workerId, localFree: 10, leaseSeconds: 30 });
  if (claimed.length !== 1) throw new Error(`expected exactly 1 claimable job, got ${claimed.length}`);
  const job = claimed[0]!;
  const result = await failJob(db, { jobId: job.id, workerId, error: 'boom' });
  if (result.outcome !== 'dead') throw new Error(`expected job to die on first failure, got outcome=${result.outcome}`);
  return job.id;
}

const SINGLE_ATTEMPT_POLICY = {
  strategy: 'fixed' as const,
  base_delay_ms: 100,
  backoff_factor: 1,
  max_delay_ms: 1000,
  max_attempts: 1,
};

describe('retry (D2-Eng-4 regression): retry must not collide with UNIQUE(job_id, attempt)', () => {
  it('retrying a dead job grants a fresh budget by bumping max_attempts, never resetting attempts — so re-claiming it does not throw', async () => {
    const account = await registerAccount(server);
    const headers = authHeader(account.token);
    const { queueId } = await createProjectAndQueue(server, account.token, { retryPolicy: SINGLE_ATTEMPT_POLICY });

    const created = await server.inject({
      method: 'POST',
      url: `/api/v1/queues/${queueId}/jobs`,
      headers,
      payload: { type: 'immediate', handler_name: 'always_fail', payload: {} },
    });
    const jobId = created.json().id as string;

    const workerId = await seedWorkerRow();
    await killJobImmediately(queueId, workerId);

    const deadDetail = await server.inject({ method: 'GET', url: `/api/v1/jobs/${jobId}`, headers });
    expect(deadDetail.json().job.status).toBe('dead');
    expect(deadDetail.json().executions).toHaveLength(1);
    expect(deadDetail.json().executions[0].attempt).toBe(1);

    const retried = await server.inject({ method: 'POST', url: `/api/v1/jobs/${jobId}/retry`, headers });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().status).toBe('queued');

    // THE regression proof: claiming it again must succeed (no unique-violation
    // thrown from job_executions(job_id, attempt)) and must land on attempt=2,
    // never re-using attempt=1 from the original run.
    const reclaimed = await claimJobs(db, { queueId, workerId, localFree: 10, leaseSeconds: 30 });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]!.attempts).toBe(2);

    const afterReclaim = await server.inject({ method: 'GET', url: `/api/v1/jobs/${jobId}`, headers });
    expect(afterReclaim.json().executions.map((e: { attempt: number }) => e.attempt).sort()).toEqual([1, 2]);
  });

  it('retry is rejected on a non-terminal-eligible job (already queued)', async () => {
    const account = await registerAccount(server);
    const headers = authHeader(account.token);
    const { queueId } = await createProjectAndQueue(server, account.token);
    const created = await server.inject({
      method: 'POST',
      url: `/api/v1/queues/${queueId}/jobs`,
      headers,
      payload: { type: 'immediate', handler_name: 'sleep', payload: {} },
    });
    const res = await server.inject({ method: 'POST', url: `/api/v1/jobs/${created.json().id}/retry`, headers });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('NOT_RETRYABLE');
  });
});

describe('dead-letter queue', () => {
  it('lists a dead job, requeues it via the DLQ endpoint, and the job returns to queued', async () => {
    const account = await registerAccount(server);
    const headers = authHeader(account.token);
    const { queueId } = await createProjectAndQueue(server, account.token, { retryPolicy: SINGLE_ATTEMPT_POLICY });
    const created = await server.inject({
      method: 'POST',
      url: `/api/v1/queues/${queueId}/jobs`,
      headers,
      payload: { type: 'immediate', handler_name: 'always_fail', payload: {} },
    });
    const jobId = created.json().id as string;
    const workerId = await seedWorkerRow();
    await killJobImmediately(queueId, workerId);

    const listed = await server.inject({ method: 'GET', url: `/api/v1/queues/${queueId}/dead-letter`, headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data).toHaveLength(1);
    const dlqId = listed.json().data[0].id as string;
    expect(listed.json().data[0].job_id).toBe(jobId);

    const requeued = await server.inject({ method: 'POST', url: `/api/v1/dead-letter/${dlqId}/requeue`, headers });
    expect(requeued.statusCode).toBe(200);

    const detail = await server.inject({ method: 'GET', url: `/api/v1/jobs/${jobId}`, headers });
    expect(detail.json().job.status).toBe('queued');

    const listedAfter = await server.inject({ method: 'GET', url: `/api/v1/queues/${queueId}/dead-letter`, headers });
    expect(listedAfter.json().data).toHaveLength(0); // requeue deletes the DLQ row (retryJob)
  });

  it('discards a dead-letter entry without touching the underlying job', async () => {
    const account = await registerAccount(server);
    const headers = authHeader(account.token);
    const { queueId } = await createProjectAndQueue(server, account.token, { retryPolicy: SINGLE_ATTEMPT_POLICY });
    const created = await server.inject({
      method: 'POST',
      url: `/api/v1/queues/${queueId}/jobs`,
      headers,
      payload: { type: 'immediate', handler_name: 'always_fail', payload: {} },
    });
    const jobId = created.json().id as string;
    const workerId = await seedWorkerRow();
    await killJobImmediately(queueId, workerId);

    const listed = await server.inject({ method: 'GET', url: `/api/v1/queues/${queueId}/dead-letter`, headers });
    const dlqId = listed.json().data[0].id as string;

    const discarded = await server.inject({ method: 'DELETE', url: `/api/v1/dead-letter/${dlqId}`, headers });
    expect(discarded.statusCode).toBe(204);

    const listedAfter = await server.inject({ method: 'GET', url: `/api/v1/queues/${queueId}/dead-letter`, headers });
    expect(listedAfter.json().data).toHaveLength(0);

    // discard is worklist-only — the job itself stays 'dead', not resurrected.
    const detail = await server.inject({ method: 'GET', url: `/api/v1/jobs/${jobId}`, headers });
    expect(detail.json().job.status).toBe('dead');
  });

  it('a DLQ row whose origin job was purged (job_id IS NULL) is discard-only: requeue returns 409 ORIGIN_DELETED, never a crash', async () => {
    const account = await registerAccount(server);
    const headers = authHeader(account.token);
    const { queueId } = await createProjectAndQueue(server, account.token, { retryPolicy: SINGLE_ATTEMPT_POLICY });
    const created = await server.inject({
      method: 'POST',
      url: `/api/v1/queues/${queueId}/jobs`,
      headers,
      payload: { type: 'immediate', handler_name: 'always_fail', payload: {} },
    });
    const workerId = await seedWorkerRow();
    await killJobImmediately(queueId, workerId);

    const listed = await server.inject({ method: 'GET', url: `/api/v1/queues/${queueId}/dead-letter`, headers });
    const dlqId = listed.json().data[0].id as string;

    // No Day-2 route ever nulls job_id (see requeueDlq's doc comment) — this
    // simulates the schema-level safety net a future retention/TTL cleanup
    // job would exercise, by poking the FK's post-state directly.
    await sql`UPDATE dead_letter_jobs SET job_id = NULL WHERE id = ${dlqId}`.execute(db);

    const requeued = await server.inject({ method: 'POST', url: `/api/v1/dead-letter/${dlqId}/requeue`, headers });
    expect(requeued.statusCode).toBe(409);
    expect(requeued.json().error.code).toBe('ORIGIN_DELETED');
  });
});

describe('cancel (R7)', () => {
  it('cancels a queued job (never touches the DLQ)', async () => {
    const account = await registerAccount(server);
    const headers = authHeader(account.token);
    const { queueId } = await createProjectAndQueue(server, account.token);
    const created = await server.inject({
      method: 'POST',
      url: `/api/v1/queues/${queueId}/jobs`,
      headers,
      payload: { type: 'immediate', handler_name: 'sleep', payload: {} },
    });
    const jobId = created.json().id as string;

    const cancelled = await server.inject({ method: 'POST', url: `/api/v1/jobs/${jobId}/cancel`, headers });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe('cancelled');

    const detail = await server.inject({ method: 'GET', url: `/api/v1/jobs/${jobId}`, headers });
    expect(detail.json().job.status).toBe('cancelled');

    // A cancelled job is a real terminal state, not retryable back to life.
    const retry = await server.inject({ method: 'POST', url: `/api/v1/jobs/${jobId}/retry`, headers });
    expect(retry.statusCode).toBe(400);

    const dlq = await server.inject({ method: 'GET', url: `/api/v1/queues/${queueId}/dead-letter`, headers });
    expect(dlq.json().data).toHaveLength(0); // cancel never pollutes the DLQ
  });

  it('refuses to cancel a running job with 409 ALREADY_RUNNING', async () => {
    const account = await registerAccount(server);
    const headers = authHeader(account.token);
    const { queueId } = await createProjectAndQueue(server, account.token);
    const created = await server.inject({
      method: 'POST',
      url: `/api/v1/queues/${queueId}/jobs`,
      headers,
      payload: { type: 'immediate', handler_name: 'sleep', payload: {} },
    });
    const jobId = created.json().id as string;
    const workerId = await seedWorkerRow();
    await claimJobs(db, { queueId, workerId, localFree: 10, leaseSeconds: 30 });

    const res = await server.inject({ method: 'POST', url: `/api/v1/jobs/${jobId}/cancel`, headers });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ALREADY_RUNNING');
  });
});
