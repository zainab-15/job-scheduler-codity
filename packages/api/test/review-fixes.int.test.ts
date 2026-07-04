import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { type DB, claimJobs } from '@scheduler/shared';
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
    .values({ hostname: `t-${Math.random().toString(36).slice(2)}`, pid: process.pid, status: 'active', concurrency: 10 })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Create a retry policy directly under a project and return its id. */
async function createPolicyForProject(projectId: string, name: string): Promise<string> {
  const row = await sql<{ id: string }>`
    INSERT INTO retry_policies (project_id, name, strategy, base_delay_ms, backoff_factor, max_delay_ms, max_attempts)
    VALUES (${projectId}, ${name}, 'fixed', 100, 1, 1000, 2)
    RETURNING id
  `.execute(db);
  return row.rows[0]!.id;
}

describe('C1: retry_policy_id is org/project-scoped (IDOR fix)', () => {
  it('createQueue rejects a retry_policy_id from another org with 404', async () => {
    const orgA = await registerAccount(server, 'Org A');
    const orgB = await registerAccount(server, 'Org B');
    // orgA gets a project + a policy under it.
    const projA = await server.inject({ method: 'POST', url: '/api/v1/projects', headers: authHeader(orgA.token), payload: { name: 'A' } });
    const projAId = projA.json().id as string;
    const foreignPolicyId = await createPolicyForProject(projAId, 'a-policy');

    // orgB tries to attach org A's policy to a queue in org B's project.
    const projB = await server.inject({ method: 'POST', url: '/api/v1/projects', headers: authHeader(orgB.token), payload: { name: 'B' } });
    const projBId = projB.json().id as string;
    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/projects/${projBId}/queues`,
      headers: authHeader(orgB.token),
      payload: { name: 'q', retry_policy_id: foreignPolicyId },
    });
    expect(res.statusCode).toBe(404);
  });

  it('createQueue accepts a retry_policy_id that belongs to the same project', async () => {
    const org = await registerAccount(server);
    const proj = await server.inject({ method: 'POST', url: '/api/v1/projects', headers: authHeader(org.token), payload: { name: 'P' } });
    const projId = proj.json().id as string;
    const policyId = await createPolicyForProject(projId, 'own-policy');

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/projects/${projId}/queues`,
      headers: authHeader(org.token),
      payload: { name: 'q', retry_policy_id: policyId },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().retry_policy_id).toBe(policyId);
  });

  it('updateQueue rejects reassigning to a foreign-org policy with 404', async () => {
    const orgA = await registerAccount(server, 'Org A2');
    const orgB = await registerAccount(server, 'Org B2');
    const projA = await server.inject({ method: 'POST', url: '/api/v1/projects', headers: authHeader(orgA.token), payload: { name: 'A' } });
    const foreignPolicyId = await createPolicyForProject(projA.json().id as string, 'a-policy2');

    const { queueId } = await createProjectAndQueue(server, orgB.token);
    const res = await server.inject({
      method: 'PATCH',
      url: `/api/v1/queues/${queueId}`,
      headers: authHeader(orgB.token),
      payload: { retry_policy_id: foreignPolicyId },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('C2: delete guards block on pending work, not just running jobs', () => {
  it('deleting a queue with a QUEUED (not running) job returns 409 HAS_PENDING_WORK', async () => {
    const org = await registerAccount(server);
    const headers = authHeader(org.token);
    const { queueId } = await createProjectAndQueue(server, org.token);
    await server.inject({
      method: 'POST',
      url: `/api/v1/queues/${queueId}/jobs`,
      headers,
      payload: { type: 'immediate', handler_name: 'sleep', payload: {} },
    });

    const res = await server.inject({ method: 'DELETE', url: `/api/v1/queues/${queueId}`, headers });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('HAS_PENDING_WORK');
  });

  it('deleting a queue with an active recurring schedule returns 409 HAS_PENDING_WORK', async () => {
    const org = await registerAccount(server);
    const headers = authHeader(org.token);
    const { queueId } = await createProjectAndQueue(server, org.token);
    await server.inject({
      method: 'POST',
      url: `/api/v1/queues/${queueId}/schedules`,
      headers,
      payload: { handler_name: 'sleep', cron: '*/15 * * * *' },
    });

    const res = await server.inject({ method: 'DELETE', url: `/api/v1/queues/${queueId}`, headers });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('HAS_PENDING_WORK');
  });

  it('deleting a project with a pending job in one of its queues returns 409', async () => {
    const org = await registerAccount(server);
    const headers = authHeader(org.token);
    const { projectId, queueId } = await createProjectAndQueue(server, org.token);
    await server.inject({
      method: 'POST',
      url: `/api/v1/queues/${queueId}/jobs`,
      headers,
      payload: { type: 'immediate', handler_name: 'sleep', payload: {} },
    });

    const res = await server.inject({ method: 'DELETE', url: `/api/v1/projects/${projectId}`, headers });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('HAS_PENDING_WORK');
  });

  it('a queue whose jobs are all terminal (completed) CAN still be deleted', async () => {
    const org = await registerAccount(server);
    const headers = authHeader(org.token);
    const { queueId } = await createProjectAndQueue(server, org.token);
    const created = await server.inject({
      method: 'POST',
      url: `/api/v1/queues/${queueId}/jobs`,
      headers,
      payload: { type: 'immediate', handler_name: 'sleep', payload: { ms: 1 } },
    });
    const jobId = created.json().id as string;

    // drive the job to 'completed' via the real primitives
    const workerId = await seedWorkerRow();
    const claimed = await claimJobs(db, { queueId, workerId, localFree: 5, leaseSeconds: 30 });
    expect(claimed).toHaveLength(1);
    await sql`UPDATE jobs SET status='completed', finished_at=now(), locked_by=NULL, locked_until=NULL WHERE id=${jobId}`.execute(db);

    const res = await server.inject({ method: 'DELETE', url: `/api/v1/queues/${queueId}`, headers });
    expect(res.statusCode).toBe(204);
  });
});

describe('C4: schedule creation validates the timezone', () => {
  it('an invalid IANA timezone returns 400 INVALID_TIMEZONE, not a 500', async () => {
    const org = await registerAccount(server);
    const headers = authHeader(org.token);
    const { queueId } = await createProjectAndQueue(server, org.token);

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/queues/${queueId}/schedules`,
      headers,
      payload: { handler_name: 'sleep', cron: '*/15 * * * *', timezone: 'Not/AZone' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_TIMEZONE');
    expect(res.json().error.details.example).toBeDefined();
  });

  it('a valid IANA timezone is accepted', async () => {
    const org = await registerAccount(server);
    const headers = authHeader(org.token);
    const { queueId } = await createProjectAndQueue(server, org.token);

    const res = await server.inject({
      method: 'POST',
      url: `/api/v1/queues/${queueId}/schedules`,
      headers,
      payload: { handler_name: 'sleep', cron: '0 9 * * *', timezone: 'America/New_York' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().timezone).toBe('America/New_York');
  });
});

describe('C5: login behavior preserved after constant-time mitigation', () => {
  it('correct password still logs in; wrong password and unknown email both 401', async () => {
    await server.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'ct@test.local', password: 'password1234', org_name: 'CT' },
    });

    const ok = await server.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'ct@test.local', password: 'password1234' } });
    expect(ok.statusCode).toBe(200);

    const wrongPw = await server.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'ct@test.local', password: 'wrong-password' } });
    expect(wrongPw.statusCode).toBe(401);

    const noUser = await server.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'ghost@test.local', password: 'password1234' } });
    expect(noUser.statusCode).toBe(401);
    expect(noUser.json().error.code).toBe('INVALID_CREDENTIALS');
  });
});
