import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DB } from '@scheduler/shared';
import { buildServer } from '../src/server.js';

export const TEST_JWT_SECRET = 'test-only-secret-at-least-32-characters-long-ok';

/**
 * Builds a real server via buildServer() against the shared harness db.
 *
 * IMPORTANT: never call server.close() on the result. registerDb()'s onClose
 * hook calls db.destroy() — and `db` here is pg-harness's PROCESS-WIDE cached
 * pool, shared across every test file in this run (same hazard as the
 * worker's Worker.shutdown(exitProcess) fix). These servers are only ever
 * driven via .inject() (no .listen()), so there's no socket to leak by
 * skipping .close() — each file's own afterAll(closeTestDb) is the one place
 * that tears the pool down.
 */
export async function buildTestServer(db: DB): Promise<FastifyInstance> {
  const server = await buildServer({ db, jwtSecret: TEST_JWT_SECRET, logLevel: 'error' });
  await server.ready();
  return server;
}

export interface AuthedContext {
  token: string;
  orgId: string;
  userId: string;
  email: string;
}

/** Registers a fresh account (unique email per call) and returns a bearer token + ids. */
export async function registerAccount(server: FastifyInstance, orgName = 'Test Org'): Promise<AuthedContext> {
  const email = `user-${randomUUID()}@test.local`;
  const res = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: 'password1234', org_name: orgName },
  });
  if (res.statusCode !== 201) {
    throw new Error(`registerAccount failed: ${res.statusCode} ${res.body}`);
  }
  const body = res.json();
  return { token: body.token as string, orgId: body.organization.id as string, userId: body.user.id as string, email };
}

export function authHeader(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

export interface RetryPolicyBody {
  strategy: 'fixed' | 'linear' | 'exponential';
  base_delay_ms: number;
  backoff_factor: number;
  max_delay_ms: number | null;
  max_attempts: number;
}

/** Convenience: create a project + one queue under it via the real HTTP routes. */
export async function createProjectAndQueue(
  server: FastifyInstance,
  token: string,
  opts: { concurrencyLimit?: number; priority?: number; retryPolicy?: RetryPolicyBody } = {},
): Promise<{ projectId: string; queueId: string }> {
  const headers = authHeader(token);
  const project = await server.inject({ method: 'POST', url: '/api/v1/projects', headers, payload: { name: `proj-${randomUUID()}` } });
  if (project.statusCode !== 201) throw new Error(`create project failed: ${project.statusCode} ${project.body}`);
  const projectId = project.json().id as string;

  const queue = await server.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/queues`,
    headers,
    payload: {
      name: `queue-${randomUUID()}`,
      concurrency_limit: opts.concurrencyLimit ?? 5,
      priority: opts.priority ?? 5,
      ...(opts.retryPolicy ? { retry_policy: opts.retryPolicy } : {}),
    },
  });
  if (queue.statusCode !== 201) throw new Error(`create queue failed: ${queue.statusCode} ${queue.body}`);
  return { projectId, queueId: queue.json().id as string };
}
