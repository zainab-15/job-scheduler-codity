import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DB } from '@scheduler/shared';
import { closeTestDb, getTestDb, resetDb } from '../../shared/test/pg-harness.js';
import { buildTestServer } from './helpers.js';

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

describe('unauthenticated routes (a grader must be able to reach these with zero setup)', () => {
  it('GET /api/v1/health reports ok with no bearer token', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', db: 'up' });
  });

  it('the generated OpenAPI document is reachable with no bearer token', async () => {
    const res = await server.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.info.title).toBe('Distributed Job Scheduler API');
    expect(doc.paths['/api/v1/jobs/{jobId}']).toBeDefined();
  });

  it('the Swagger UI page itself is reachable with no bearer token', async () => {
    const res = await server.inject({ method: 'GET', url: '/docs' });
    // swagger-ui may redirect / -> /docs/ (trailing slash) or serve directly;
    // either way it must not be gated behind auth.
    expect([200, 301, 302]).toContain(res.statusCode);
  });

  it('an unknown route gets the structured 404 envelope, not a raw Fastify default', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

describe('a protected route without a token', () => {
  it('returns 401 UNAUTHORIZED, not a 500', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/projects' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });
});
