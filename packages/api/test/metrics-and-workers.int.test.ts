import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DB } from '@scheduler/shared';
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

describe('metrics', () => {
  it('overview/health/throughput are all authenticated and shaped as expected', async () => {
    const account = await registerAccount(server);
    const headers = authHeader(account.token);
    const { queueId } = await createProjectAndQueue(server, account.token);
    await server.inject({
      method: 'POST',
      url: `/api/v1/queues/${queueId}/jobs`,
      headers,
      payload: { type: 'immediate', handler_name: 'sleep', payload: {} },
    });

    const overview = await server.inject({ method: 'GET', url: '/api/v1/metrics/overview', headers });
    expect(overview.statusCode).toBe(200);
    const ov = overview.json();
    expect(ov.projects).toBe(1);
    expect(ov.queues).toBe(1);
    expect(ov.jobs.queued).toBe(1);

    const health = await server.inject({ method: 'GET', url: '/api/v1/metrics/health', headers });
    expect(health.statusCode).toBe(200);
    expect(['healthy', 'degraded', 'unhealthy']).toContain(health.json().status);
    expect(health.json().checks.db.ok).toBe(true);

    const throughput = await server.inject({ method: 'GET', url: '/api/v1/metrics/throughput?window_hours=1&bucket=hour', headers });
    expect(throughput.statusCode).toBe(200);
    expect(throughput.json()).toMatchObject({ window: '1h', bucket: 'hour' });
    expect(Array.isArray(throughput.json().series)).toBe(true);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/metrics/overview' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an out-of-range window_hours at the schema level', async () => {
    const account = await registerAccount(server);
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/metrics/throughput?window_hours=99999',
      headers: authHeader(account.token),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('workers', () => {
  it('lists registered workers with derived liveness', async () => {
    const account = await registerAccount(server);
    const headers = authHeader(account.token);

    await db.insertInto('workers').values({ hostname: 'w1', pid: 111, concurrency: 5 }).execute();

    const res = await server.inject({ method: 'GET', url: '/api/v1/workers', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
    expect(res.json().data[0]).toMatchObject({ hostname: 'w1', liveness: 'alive' });
  });

  it('404s on an unknown worker id', async () => {
    const account = await registerAccount(server);
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/workers/00000000-0000-0000-0000-000000000000',
      headers: authHeader(account.token),
    });
    expect(res.statusCode).toBe(404);
  });
});
