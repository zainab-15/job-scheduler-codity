import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DB } from '@scheduler/shared';
import { closeTestDb, getTestDb, resetDb } from '../../shared/test/pg-harness.js';
import { authHeader, buildTestServer, registerAccount } from './helpers.js';

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

describe('auth', () => {
  it('registers a new account and returns a bearer token', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'alice@test.local', password: 'password1234', org_name: 'Alice Org' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.token).toBeTypeOf('string');
    expect(body.organization.name).toBe('Alice Org');
    expect(body.user.email).toBe('alice@test.local');
  });

  it('rejects a duplicate email with 409 EMAIL_TAKEN', async () => {
    await server.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'dup@test.local', password: 'password1234', org_name: 'First Org' },
    });
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'dup@test.local', password: 'password1234', org_name: 'Second Org' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('EMAIL_TAKEN');
  });

  it('rejects a too-short password at the schema level', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'short@test.local', password: 'short', org_name: 'Org' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('logs in with correct credentials and rejects wrong ones', async () => {
    await server.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'bob@test.local', password: 'password1234', org_name: 'Bob Org' },
    });

    const ok = await server.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'bob@test.local', password: 'password1234' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().token).toBeTypeOf('string');

    const bad = await server.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'bob@test.local', password: 'wrong-password' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('/me requires a valid bearer token', async () => {
    const anon = await server.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(anon.statusCode).toBe(401);

    const account = await registerAccount(server, 'Me Org');
    const authed = await server.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeader(account.token) });
    expect(authed.statusCode).toBe(200);
    expect(authed.json().organization.name).toBe('Me Org');
  });
});

describe('organization', () => {
  it('renames the caller org', async () => {
    const account = await registerAccount(server);
    const res = await server.inject({
      method: 'PATCH',
      url: '/api/v1/organization',
      headers: authHeader(account.token),
      payload: { name: 'Renamed Org' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Renamed Org');
  });
});

describe('projects CRUD', () => {
  it('creates, lists, updates, and deletes a project', async () => {
    const account = await registerAccount(server);
    const headers = authHeader(account.token);

    const created = await server.inject({ method: 'POST', url: '/api/v1/projects', headers, payload: { name: 'Proj A' } });
    expect(created.statusCode).toBe(201);
    const projectId = created.json().id as string;

    const listed = await server.inject({ method: 'GET', url: '/api/v1/projects', headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data).toHaveLength(1);
    expect(listed.json().pagination.total).toBe(1);

    const updated = await server.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${projectId}`,
      headers,
      payload: { description: 'updated' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().description).toBe('updated');

    const deleted = await server.inject({ method: 'DELETE', url: `/api/v1/projects/${projectId}`, headers });
    expect(deleted.statusCode).toBe(204);

    const gone = await server.inject({ method: 'GET', url: `/api/v1/projects/${projectId}`, headers });
    expect(gone.statusCode).toBe(404);
  });
});

describe('queues CRUD', () => {
  it('creates a queue with custom concurrency_limit and reads it back', async () => {
    const account = await registerAccount(server);
    const headers = authHeader(account.token);
    const project = await server.inject({ method: 'POST', url: '/api/v1/projects', headers, payload: { name: 'Proj B' } });
    const projectId = project.json().id as string;

    const created = await server.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/queues`,
      headers,
      payload: { name: 'emails', concurrency_limit: 2, priority: 7 },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().concurrency_limit).toBe(2);
    expect(created.json().priority).toBe(7);

    const queueId = created.json().id as string;
    const detail = await server.inject({ method: 'GET', url: `/api/v1/queues/${queueId}`, headers });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().is_paused).toBe(false);

    const paused = await server.inject({ method: 'POST', url: `/api/v1/queues/${queueId}/pause`, headers });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().is_paused).toBe(true);

    const resumed = await server.inject({ method: 'POST', url: `/api/v1/queues/${queueId}/resume`, headers });
    expect(resumed.json().is_paused).toBe(false);
  });
});
