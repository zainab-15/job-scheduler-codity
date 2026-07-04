import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { type DB, promoteRecurring } from '@scheduler/shared';
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

describe('POST /queues/:queueId/schedules (R28: recurring is a template, not a job)', () => {
  it('creates a schedule with the pinned response shape (D2-DX-4)', async () => {
    const account = await registerAccount(server);
    const headers = authHeader(account.token);
    const { queueId } = await createProjectAndQueue(server, account.token);

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/queues/${queueId}/schedules`,
      headers,
      payload: { handler_name: 'sleep', payload: { ms: 100 }, cron: '*/15 * * * *', timezone: 'UTC' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['cron', 'next_run_at', 'scheduled_job_id', 'timezone']);
    expect(body.cron).toBe('*/15 * * * *');
    expect(body.timezone).toBe('UTC');
    expect(new Date(body.next_run_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects an invalid cron expression with the parser message + a valid example (R27)', async () => {
    const account = await registerAccount(server);
    const headers = authHeader(account.token);
    const { queueId } = await createProjectAndQueue(server, account.token);

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/queues/${queueId}/schedules`,
      headers,
      payload: { handler_name: 'sleep', cron: 'not a cron' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_CRON');
    expect(res.json().error.message.length).toBeGreaterThan(0);
    expect(res.json().error.details.example).toBeDefined();
  });

  it('404s on a cross-org queue', async () => {
    const orgA = await registerAccount(server, 'Org A');
    const orgB = await registerAccount(server, 'Org B');
    const { queueId } = await createProjectAndQueue(server, orgA.token);

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/queues/${queueId}/schedules`,
      headers: authHeader(orgB.token),
      payload: { handler_name: 'sleep', cron: '*/15 * * * *' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('an occurrence spawned by the cron promoter is visible through the normal job detail route', async () => {
    const account = await registerAccount(server);
    const headers = authHeader(account.token);
    const { queueId } = await createProjectAndQueue(server, account.token);

    const created = await server.inject({
      method: 'POST',
      url: `/api/v1/queues/${queueId}/schedules`,
      headers,
      payload: { handler_name: 'sleep', payload: { ms: 1 }, cron: '* * * * *' },
    });
    const scheduledJobId = created.json().scheduled_job_id as string;

    await sql`UPDATE scheduled_jobs SET next_run_at = now() - interval '1 second' WHERE id = ${scheduledJobId}`.execute(db);
    const promoted = await promoteRecurring(db);
    expect(promoted).toBe(1);

    const jobs = await server.inject({ method: 'GET', url: `/api/v1/queues/${queueId}/jobs?type=recurring`, headers });
    expect(jobs.statusCode).toBe(200);
    expect(jobs.json().data).toHaveLength(1);
    expect(jobs.json().data[0].recurring_job_id).toBe(scheduledJobId);
  });
});
