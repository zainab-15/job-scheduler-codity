import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DB } from '@scheduler/shared';
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

describe('cross-org isolation (R14): a resource in org A is invisible to org B, reported as 404 not 403', () => {
  it('a job created by org A returns 404 for org B', async () => {
    const orgA = await registerAccount(server, 'Org A');
    const orgB = await registerAccount(server, 'Org B');
    const { queueId } = await createProjectAndQueue(server, orgA.token);

    const created = await server.inject({
      method: 'POST',
      url: `/api/v1/queues/${queueId}/jobs`,
      headers: authHeader(orgA.token),
      payload: { type: 'immediate', handler_name: 'sleep', payload: {} },
    });
    const jobId = created.json().id as string;

    const asOwner = await server.inject({ method: 'GET', url: `/api/v1/jobs/${jobId}`, headers: authHeader(orgA.token) });
    expect(asOwner.statusCode).toBe(200);

    const asOther = await server.inject({ method: 'GET', url: `/api/v1/jobs/${jobId}`, headers: authHeader(orgB.token) });
    expect(asOther.statusCode).toBe(404);
  });

  it("org B cannot list org A's queue, and cannot create a job on it", async () => {
    const orgA = await registerAccount(server, 'Org A2');
    const orgB = await registerAccount(server, 'Org B2');
    const { queueId } = await createProjectAndQueue(server, orgA.token);

    const list = await server.inject({ method: 'GET', url: `/api/v1/queues/${queueId}/jobs`, headers: authHeader(orgB.token) });
    expect(list.statusCode).toBe(404);

    const create = await server.inject({
      method: 'POST',
      url: `/api/v1/queues/${queueId}/jobs`,
      headers: authHeader(orgB.token),
      payload: { type: 'immediate', handler_name: 'sleep', payload: {} },
    });
    expect(create.statusCode).toBe(404);
  });

  it("org B cannot read org A's project or queue detail", async () => {
    const orgA = await registerAccount(server, 'Org A3');
    const orgB = await registerAccount(server, 'Org B3');
    const { projectId, queueId } = await createProjectAndQueue(server, orgA.token);

    const project = await server.inject({ method: 'GET', url: `/api/v1/projects/${projectId}`, headers: authHeader(orgB.token) });
    expect(project.statusCode).toBe(404);

    const queue = await server.inject({ method: 'GET', url: `/api/v1/queues/${queueId}`, headers: authHeader(orgB.token) });
    expect(queue.statusCode).toBe(404);
  });
});

describe('sort allowlist (R15): an unrecognized/injected sort value never reaches SQL', () => {
  it('an injection-shaped sort value is accepted at the schema level but silently falls back to the default order, and does no damage', async () => {
    const account = await registerAccount(server);
    const headers = authHeader(account.token);
    const { queueId } = await createProjectAndQueue(server, account.token);

    for (let i = 0; i < 2; i++) {
      await server.inject({
        method: 'POST',
        url: `/api/v1/queues/${queueId}/jobs`,
        headers,
        payload: { type: 'immediate', handler_name: 'sleep', payload: {} },
      });
    }

    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/queues/${queueId}/jobs?${new URLSearchParams({ sort: 'id;DROP TABLE jobs;--' }).toString()}`,
      headers,
    });
    // Never a 500 / SQL error: the malicious string is validated only as `string`
    // by Ajv, then mapped through the query layer's hardcoded allowlist — an
    // unrecognized key falls back to the default sort rather than being
    // interpolated (see SORT_ALLOWLIST in packages/shared/src/queries/jobs.ts).
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(2);

    // Paranoid but cheap: prove the table really is untouched.
    const stillThere = await sql<{ n: string }>`SELECT count(*)::int AS n FROM jobs`.execute(db);
    expect(Number(stillThere.rows[0]!.n)).toBe(2);
  });
});

describe('query-string type coercion (R16): numeric params coerce, garbage still 400s', () => {
  it('a valid ?limit=2 is accepted (regression: coerceTypes must be on, or every paginated GET 400s)', async () => {
    const account = await registerAccount(server);
    const headers = authHeader(account.token);
    const { queueId } = await createProjectAndQueue(server, account.token);

    const res = await server.inject({ method: 'GET', url: `/api/v1/queues/${queueId}/jobs?limit=2&offset=0`, headers });
    expect(res.statusCode).toBe(200);
  });

  it('a non-numeric ?limit=abc still 400s rather than being silently coerced to garbage', async () => {
    const account = await registerAccount(server);
    const headers = authHeader(account.token);
    const { queueId } = await createProjectAndQueue(server, account.token);

    const res = await server.inject({ method: 'GET', url: `/api/v1/queues/${queueId}/jobs?limit=abc`, headers });
    expect(res.statusCode).toBe(400);
  });
});
