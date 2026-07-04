import {
  type DB,
  createDb,
  createImmediateJob,
  createProject,
  createQueue,
  findUserByEmail,
  loadEnv,
  registerUserOrg,
  sql,
} from '@scheduler/shared';
import { hashPassword } from './plugins/auth.js';

/**
 * D2-DX-2: the concrete seed spec. Account/project/queues are UPSERTED
 * (idempotent — re-running never errors); the demo jobs are ADDITIVE per run
 * via a per-run dedupe_key prefix, so re-seeding always produces a
 * freshly-visible queued/running job instead of silently no-oping against
 * the previous run's dedupe_key.
 *
 * Credentials print on THIS process's own stdout (console, not pino) so a
 * grader running `npm run seed` in its own terminal sees them regardless of
 * what the API/worker are logging elsewhere.
 */
const ADMIN_EMAIL = 'admin@demo.test';
const ADMIN_PASSWORD = 'demo12345678'; // satisfies the register route's minLength:10
const ORG_NAME = 'Demo Org';
const PROJECT_NAME = 'Demo Project';

async function upsertProject(db: DB, orgId: string, name: string): Promise<string> {
  const existing = await sql<{ id: string }>`SELECT id FROM projects WHERE org_id = ${orgId} AND name = ${name}`.execute(db);
  if (existing.rows[0]) return existing.rows[0].id;
  const created = await createProject(db, { orgId, name, description: 'Seed data for local development and grading' });
  return created.id;
}

async function upsertQueue(
  db: DB,
  orgId: string,
  projectId: string,
  name: string,
  concurrencyLimit: number,
  priority: number,
): Promise<string> {
  const existing = await sql<{ id: string }>`SELECT id FROM queues WHERE project_id = ${projectId} AND name = ${name}`.execute(db);
  if (existing.rows[0]) return existing.rows[0].id;
  const created = await createQueue(db, { orgId, projectId, name, concurrencyLimit, priority });
  if (created === 'project_not_found' || created === 'policy_not_found') {
    throw new Error(`seed: createQueue failed (${created}) for project ${projectId}`);
  }
  return created.id;
}

async function main(): Promise<void> {
  const env = loadEnv();

  // Refuse to run against a production DB: this script provisions a
  // fixed, publicly-known admin credential (admin@demo.test / demo12345678).
  // If `npm run seed` is ever wired into a deploy hook or pointed at a prod
  // DATABASE_URL by mistake, that would be a full-access backdoor.
  if (env.NODE_ENV === 'production') {
    // eslint-disable-next-line no-console
    console.error('Refusing to seed demo data in NODE_ENV=production (this creates a known-password admin account).');
    process.exit(1);
  }

  const db = createDb(env.DATABASE_URL, env.PG_POOL_MAX);

  try {
    const existingUser = await findUserByEmail(db, ADMIN_EMAIL);
    let orgId: string;
    if (existingUser) {
      orgId = existingUser.org_id;
    } else {
      const passwordHash = await hashPassword(ADMIN_PASSWORD);
      const account = await registerUserOrg(db, { email: ADMIN_EMAIL, passwordHash, orgName: ORG_NAME });
      orgId = account.orgId;
    }

    const projectId = await upsertProject(db, orgId, PROJECT_NAME);

    // Differing concurrency_limit per queue (D2-DX / R23): fast-queue caps at
    // 2 concurrent, so the demo makes the per-queue limit visibly bite even
    // with a handful of jobs; slow-queue's higher limit + the long sleep job
    // is the kill/reclaim demo target.
    const fastQueueId = await upsertQueue(db, orgId, projectId, 'fast-queue', 2, 7);
    const slowQueueId = await upsertQueue(db, orgId, projectId, 'slow-queue', 5, 5);
    const flakyQueueId = await upsertQueue(db, orgId, projectId, 'flaky-queue', 3, 5);

    const runStamp = new Date().toISOString();
    const dedupePrefix = `seed:${runStamp}`;

    // The kill/reclaim demo target: long enough that killing either worker
    // terminal in the 2-terminal manual demo reclaims it (R26).
    await createImmediateJob(db, {
      orgId,
      queueId: slowQueueId,
      handlerName: 'sleep',
      payload: { ms: 60_000 },
      dedupeKey: `${dedupePrefix}:sleep-long`,
    });

    // A handful of quick jobs on fast-queue so its concurrency_limit=2 visibly
    // throttles them (more than 2 queued at once).
    for (let i = 0; i < 5; i++) {
      await createImmediateJob(db, {
        orgId,
        queueId: fastQueueId,
        handlerName: 'sleep',
        payload: { ms: 1500 },
        dedupeKey: `${dedupePrefix}:fast-${i}`,
      });
    }

    // A real (safe, public) network call so http_fetch has something to show.
    await createImmediateJob(db, {
      orgId,
      queueId: fastQueueId,
      handlerName: 'http_fetch',
      payload: { url: 'https://example.com' },
      dedupeKey: `${dedupePrefix}:http-fetch`,
    });

    // Retry -> backoff -> DLQ demo (default retry policy: 3 attempts, exponential).
    await createImmediateJob(db, {
      orgId,
      queueId: flakyQueueId,
      handlerName: 'always_fail',
      payload: {},
      dedupeKey: `${dedupePrefix}:always-fail`,
    });

    // eslint-disable-next-line no-console
    console.log(
      [
        '',
        '=== Demo seed complete ===',
        `Login:    ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`,
        `Org:      ${ORG_NAME} (${orgId})`,
        `Project:  ${PROJECT_NAME} (${projectId})`,
        'Queues:   fast-queue (limit=2)  slow-queue (limit=5)  flaky-queue (limit=3)',
        `Jobs this run (prefix ${dedupePrefix}):`,
        '  - 1x sleep(60s)      on slow-queue   <- kill/reclaim demo target',
        '  - 5x sleep(1.5s)     on fast-queue    <- shows concurrency_limit=2 throttling',
        '  - 1x http_fetch      on fast-queue    <- example.com',
        '  - 1x always_fail     on flaky-queue   <- retry -> backoff -> DLQ',
        'Run `npm run dev:worker` (in 1+ terminals) and `npm run dev:api` to watch them execute.',
        '===========================',
        '',
      ].join('\n'),
    );
  } finally {
    await db.destroy();
  }
}

void main();
