import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { type DB, markDeadWorkers } from '@scheduler/shared';
import { closeTestDb, getTestDb, resetDb } from './pg-harness.js';

let db: DB;

beforeEach(async () => {
  db = await getTestDb();
  await resetDb(db);
});

afterAll(async () => {
  await closeTestDb();
});

/**
 * C7: markDeadWorkers runs on every maintenance tick (flips stale-heartbeat
 * workers to 'dead' so the reaper and dashboard both see them) but had zero
 * coverage.
 */
describe('markDeadWorkers', () => {
  async function insertWorker(hostname: string, heartbeatAgeSeconds: number): Promise<string> {
    const row = await sql<{ id: string }>`
      INSERT INTO workers (hostname, pid, status, concurrency, last_heartbeat_at)
      VALUES (${hostname}, ${process.pid}, 'active', 5, now() - make_interval(secs => ${heartbeatAgeSeconds}))
      RETURNING id
    `.execute(db);
    return row.rows[0]!.id;
  }

  it('flips a stale-heartbeat worker to dead and sets stopped_at, leaving a fresh worker untouched', async () => {
    const staleId = await insertWorker('stale', 120); // 2 min since last heartbeat
    const freshId = await insertWorker('fresh', 1); // 1s ago

    const flipped = await markDeadWorkers(db, 30); // stale threshold: 30s
    expect(flipped).toBe(1);

    const stale = await db.selectFrom('workers').selectAll().where('id', '=', staleId).executeTakeFirstOrThrow();
    expect(stale.status).toBe('dead');
    expect(stale.stopped_at).not.toBeNull();

    const fresh = await db.selectFrom('workers').selectAll().where('id', '=', freshId).executeTakeFirstOrThrow();
    expect(fresh.status).toBe('active');
    expect(fresh.stopped_at).toBeNull();
  });

  it('is idempotent — a second call flips nothing new', async () => {
    await insertWorker('stale', 120);
    expect(await markDeadWorkers(db, 30)).toBe(1);
    expect(await markDeadWorkers(db, 30)).toBe(0); // already dead, not re-counted
  });
});
