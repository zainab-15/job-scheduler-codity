import pg from 'pg';
import { sql } from 'kysely';
import { createDb, type DB } from '../src/db/kysely.js';
import { migrateToLatest } from '../src/db/migrate.js';
import { TABLES_CHILD_FIRST } from '../src/db/tables.js';
import { DEFAULT_RETRY_CONFIG } from '../src/domain/backoff.js';

/**
 * Compose-DB test path (R-flip): connect to the throwaway TEST_DATABASE_URL on
 * the already-running compose Postgres (boots instantly, exercises the REAL
 * SKIP LOCKED + advisory-lock code). Create the DB if the volume predates it,
 * migrate once, then TRUNCATE between tests.
 */
const TEST_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://scheduler:scheduler@localhost:5432/scheduler_test';

const ADMIN_URL =
  process.env.DATABASE_URL ??
  'postgres://scheduler:scheduler@localhost:5432/scheduler';

async function ensureTestDbExists(): Promise<void> {
  const dbName = new URL(TEST_URL).pathname.replace(/^\//, '');
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (rows.length === 0) {
      // CREATE DATABASE can't take a bound param; validate the name is a plain
      // identifier (no quotes/specials) then double-quote it safely.
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(dbName)) {
        throw new Error(`refusing to CREATE DATABASE with unsafe name: ${dbName}`);
      }
      await admin.query(`CREATE DATABASE "${dbName}"`);
    }
  } finally {
    await admin.end();
  }
}

let db: DB | null = null;

export async function getTestDb(): Promise<DB> {
  if (db) return db;
  await ensureTestDbExists();
  db = createDb(TEST_URL, 30);
  await migrateToLatest(db);
  return db;
}

export async function closeTestDb(): Promise<void> {
  if (db) {
    await db.destroy();
    db = null;
  }
}

export async function resetDb(d: DB): Promise<void> {
  await sql`TRUNCATE ${sql.raw(TABLES_CHILD_FIRST.join(', '))} RESTART IDENTITY CASCADE`.execute(d);
}

export interface Seeded {
  orgId: string;
  projectId: string;
  queueId: string;
}

/** Seed org -> project -> retry_policy -> queue. `over` tweaks the queue. */
export async function seedQueue(
  d: DB,
  over: { concurrency_limit?: number; priority?: number } = {},
): Promise<Seeded> {
  const org = await d
    .insertInto('organizations')
    .values({ name: 'Acme', slug: `acme-${Date.now()}-${Math.floor(1e6 * seededRand())}` })
    .returning('id')
    .executeTakeFirstOrThrow();
  const project = await d
    .insertInto('projects')
    .values({ org_id: org.id, name: 'Default', slug: 'default', description: null })
    .returning('id')
    .executeTakeFirstOrThrow();
  const policy = await d
    .insertInto('retry_policies')
    .values({
      project_id: project.id,
      name: 'default',
      strategy: DEFAULT_RETRY_CONFIG.strategy,
      base_delay_ms: DEFAULT_RETRY_CONFIG.baseDelayMs,
      backoff_factor: DEFAULT_RETRY_CONFIG.backoffFactor,
      max_delay_ms: DEFAULT_RETRY_CONFIG.maxDelayMs,
      max_attempts: DEFAULT_RETRY_CONFIG.maxAttempts,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const queue = await d
    .insertInto('queues')
    .values({
      project_id: project.id,
      retry_policy_id: policy.id,
      name: 'jobs',
      priority: over.priority ?? 5,
      concurrency_limit: over.concurrency_limit ?? 5,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { orgId: org.id, projectId: project.id, queueId: queue.id };
}

export async function seedWorker(d: DB, concurrency = 10): Promise<string> {
  const w = await d
    .insertInto('workers')
    .values({
      hostname: `test-${Math.floor(1e9 * seededRand())}`,
      pid: process.pid,
      status: 'active',
      concurrency,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return w.id;
}

/** Bulk-seed N queued jobs on a queue with given retry config. */
export async function seedJobs(
  d: DB,
  queueId: string,
  n: number,
  over: { handler?: string; maxAttempts?: number } = {},
): Promise<void> {
  const rows = Array.from({ length: n }, () => ({
    queue_id: queueId,
    type: 'immediate' as const,
    handler_name: over.handler ?? 'noop',
    status: 'queued' as const,
    priority: 5,
    payload: {},
    max_attempts: over.maxAttempts ?? DEFAULT_RETRY_CONFIG.maxAttempts,
    retry_strategy: DEFAULT_RETRY_CONFIG.strategy,
    retry_base_delay_ms: DEFAULT_RETRY_CONFIG.baseDelayMs,
    retry_backoff_factor: DEFAULT_RETRY_CONFIG.backoffFactor,
    retry_max_delay_ms: DEFAULT_RETRY_CONFIG.maxDelayMs,
  }));
  // chunk to keep parameter count sane
  for (let i = 0; i < rows.length; i += 200) {
    await d.insertInto('jobs').values(rows.slice(i, i + 200)).execute();
  }
}

export interface QueueStats {
  stat_queued: number;
  stat_running: number;
  stat_completed: number;
  stat_dead: number;
}

export async function queueStats(d: DB, queueId: string): Promise<QueueStats> {
  const q = await d
    .selectFrom('queues')
    .select(['stat_queued', 'stat_running', 'stat_completed', 'stat_dead'])
    .where('id', '=', queueId)
    .executeTakeFirstOrThrow();
  return q;
}

export async function countByStatus(d: DB, queueId: string): Promise<Record<string, number>> {
  const rows = await d
    .selectFrom('jobs')
    .select(['status', (eb) => eb.fn.countAll<string>().as('n')])
    .where('queue_id', '=', queueId)
    .groupBy('status')
    .execute();
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

// Deterministic-ish PRNG for unique seed strings without Date.now collisions in
// tight loops (Math.random is fine for test uniqueness).
function seededRand(): number {
  return Math.random();
}
