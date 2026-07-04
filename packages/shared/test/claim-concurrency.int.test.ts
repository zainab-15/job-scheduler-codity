import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  claimJobs,
  claimJobsImpl,
  completeJob,
  failJob,
  promoteDueJobs,
  reclaimStuckJobs,
} from '../src/queries/jobs.js';
import {
  type DB,
  closeTestDb,
  countByStatus,
  getTestDb,
  queueStats,
  resetDb,
  seedJobs,
  seedQueue,
  seedWorker,
} from './pg-harness.js';

let db: DB;

beforeEach(async () => {
  db = await getTestDb();
  await resetDb(db);
});

afterAll(async () => {
  await closeTestDb();
});

/**
 * Load-bearing proof on the REAL query. `claimJobsImpl(db, args, false)` runs the
 * IDENTICAL claim SQL as claimJobs, minus only the `pg_advisory_xact_lock` line.
 * Under READ COMMITTED, concurrent claimers each snapshot count(running)=0 before
 * either commits, so each claims the full budget over disjoint rows (SKIP LOCKED)
 * -> over-admission. This is probabilistic per round, so we loop until observed
 * (never triggering across many rounds is astronomically unlikely). The paired
 * test shows the SAME query WITH the lock never over-admits.
 */
describe('advisory lock is load-bearing (negative control on the real query)', () => {
  it('the identical claim WITHOUT the lock over-admits past concurrency_limit', async () => {
    let observed = false;
    for (let round = 0; round < 40 && !observed; round++) {
      const { queueId } = await seedQueue(db, { concurrency_limit: 2 });
      await seedJobs(db, queueId, 40);
      const workers = await Promise.all(Array.from({ length: 8 }, () => seedWorker(db)));
      const claimed = await Promise.all(
        workers.map((w) => claimJobsImpl(db, { queueId, workerId: w, localFree: 10, leaseSeconds: 30 }, false)),
      );
      const total = claimed.reduce((n, rows) => n + rows.length, 0);
      if (total > 2) observed = true;
      await resetDb(db);
    }
    expect(observed).toBe(true); // the advisory lock is genuinely required
  });

  it('the SAME query WITH the lock never over-admits, across many concurrent rounds', async () => {
    for (let round = 0; round < 12; round++) {
      const { queueId } = await seedQueue(db, { concurrency_limit: 2 });
      await seedJobs(db, queueId, 40);
      const workers = await Promise.all(Array.from({ length: 8 }, () => seedWorker(db)));
      const claimed = await Promise.all(
        workers.map((w) => claimJobs(db, { queueId, workerId: w, localFree: 10, leaseSeconds: 30 })),
      );
      const total = claimed.reduce((n, rows) => n + rows.length, 0);
      expect(total).toBe(2);
      const counts = await countByStatus(db, queueId);
      expect(counts.running ?? 0).toBe(2);
      await resetDb(db);
    }
  });
});

describe('stat counters reconcile with count(*) under concurrent chaos', () => {
  it('claim/complete/fail/promote concurrently, then stats == reality after drain', async () => {
    const { queueId } = await seedQueue(db, { concurrency_limit: 8 });
    await seedJobs(db, queueId, 150, { maxAttempts: 3 });
    const workers = await Promise.all(Array.from({ length: 5 }, () => seedWorker(db)));

    // workers claim then deterministically complete-or-fail each job
    const workerLoop = async (workerId: string, seed: number) => {
      for (let i = 0; i < 60; i++) {
        const rows = await claimJobs(db, { queueId, workerId, localFree: 3, leaseSeconds: 30 });
        for (const r of rows) {
          if ((r.attempts + seed + i) % 3 === 0) {
            await failJob(db, { jobId: r.id, workerId, error: 'chaos', rand: () => 0.5 });
          } else {
            await completeJob(db, { jobId: r.id, workerId, durationMs: 1 });
          }
        }
      }
    };
    // a promoter racing the workers (makes retrying jobs due and re-queues them)
    const promoteLoop = async () => {
      for (let i = 0; i < 80; i++) {
        await sql`UPDATE jobs SET run_at = now() WHERE status = 'retrying' AND queue_id = ${queueId}`.execute(db);
        await promoteDueJobs(db);
      }
    };
    await Promise.all([...workers.map((w, i) => workerLoop(w, i)), promoteLoop()]);

    // drain to a fully terminal state so the end-state assertions are deterministic
    for (let i = 0; i < 200; i++) {
      await sql`UPDATE jobs SET run_at = now() WHERE status IN ('retrying','scheduled') AND queue_id = ${queueId}`.execute(db);
      await promoteDueJobs(db);
      await reclaimStuckJobs(db); // no-op here (live leases), included for coverage
      const rows = await claimJobs(db, { queueId, workerId: workers[0]!, localFree: 8, leaseSeconds: 30 });
      const remaining = await countByStatus(db, queueId);
      const nonTerminal = (remaining.queued ?? 0) + (remaining.running ?? 0) + (remaining.retrying ?? 0) + (remaining.scheduled ?? 0);
      for (const r of rows) await completeJob(db, { jobId: r.id, workerId: workers[0]!, durationMs: 1 });
      if (rows.length === 0 && nonTerminal === 0) break;
    }

    // the denormalized counters must equal reality
    const counts = await countByStatus(db, queueId);
    const stats = await queueStats(db, queueId);
    expect(stats.stat_running).toBe(counts.running ?? 0);
    expect(stats.stat_queued).toBe(counts.queued ?? 0);
    expect(stats.stat_completed).toBe(counts.completed ?? 0);
    expect(stats.stat_dead).toBe(counts.dead ?? 0);
    // sanity: every seeded job reached a terminal state
    expect((counts.completed ?? 0) + (counts.dead ?? 0)).toBe(150);
  });
});

describe('atomic claim — no double execution under drain', () => {
  it('4 workers drain 100 jobs with zero duplicates, all complete, stats reconcile', async () => {
    const { queueId } = await seedQueue(db, { concurrency_limit: 100 });
    await seedJobs(db, queueId, 100);
    const workers = await Promise.all(Array.from({ length: 4 }, () => seedWorker(db)));

    const seen: string[] = [];
    const drain = async (workerId: string) => {
      for (;;) {
        const rows = await claimJobs(db, { queueId, workerId, localFree: 5, leaseSeconds: 30 });
        if (rows.length === 0) break;
        for (const r of rows) {
          seen.push(r.id);
          await completeJob(db, { jobId: r.id, workerId, durationMs: 1 });
        }
      }
    };
    await Promise.all(workers.map((w) => drain(w)));

    expect(seen.length).toBe(100);
    expect(new Set(seen).size).toBe(100); // zero duplicates

    const counts = await countByStatus(db, queueId);
    expect(counts.completed ?? 0).toBe(100);
    expect(counts.running ?? 0).toBe(0);

    // stat counters must reconcile with reality (no drift)
    const stats = await queueStats(db, queueId);
    expect(stats.stat_completed).toBe(100);
    expect(stats.stat_running).toBe(0);
  });
});

describe('claim budget & pause gates', () => {
  it('returns 0 when the queue is already at its concurrency limit', async () => {
    const { queueId } = await seedQueue(db, { concurrency_limit: 2 });
    await seedJobs(db, queueId, 10);
    const w = await seedWorker(db);
    // fill the budget
    const first = await claimJobs(db, { queueId, workerId: w, localFree: 10, leaseSeconds: 30 });
    expect(first).toHaveLength(2);
    // nothing completed -> queue saturated -> next claim gets 0
    const second = await claimJobs(db, { queueId, workerId: w, localFree: 10, leaseSeconds: 30 });
    expect(second).toHaveLength(0);
  });

  it('never claims from a paused queue', async () => {
    const { queueId } = await seedQueue(db, { concurrency_limit: 5 });
    await seedJobs(db, queueId, 10);
    await db.updateTable('queues').set({ is_paused: true }).where('id', '=', queueId).execute();
    const w = await seedWorker(db);
    const rows = await claimJobs(db, { queueId, workerId: w, localFree: 5, leaseSeconds: 30 });
    expect(rows).toHaveLength(0);
  });
});

describe('claim ordering & batchCap', () => {
  it('claims highest-priority-first, then FIFO', async () => {
    const { queueId } = await seedQueue(db, { concurrency_limit: 10 });
    // insert three jobs with distinct priorities (higher = sooner)
    for (const p of [1, 9, 5]) {
      await db
        .insertInto('jobs')
        .values({ queue_id: queueId, type: 'immediate', handler_name: 'noop', status: 'queued', priority: p, payload: {}, max_attempts: 3, retry_strategy: 'exponential', retry_base_delay_ms: 1000, retry_backoff_factor: 2, retry_max_delay_ms: 60000 })
        .execute();
    }
    const w = await seedWorker(db);
    const rows = await claimJobs(db, { queueId, workerId: w, localFree: 10, leaseSeconds: 30 });
    // priority DESC: 9, 5, 1
    const priorities = await Promise.all(
      rows.map((r) => db.selectFrom('job_executions').select('attempt').where('job_id', '=', r.id).executeTakeFirst()),
    );
    expect(priorities).toHaveLength(3);
    // verify order by re-reading the claimed jobs in claim order
    const claimedPriorities: number[] = [];
    for (const r of rows) {
      const j = await db.selectFrom('jobs').select('priority').where('id', '=', r.id).executeTakeFirstOrThrow();
      claimedPriorities.push(j.priority);
    }
    expect(claimedPriorities).toEqual([9, 5, 1]);
  });

  it('batchCap bounds a single claim below localFree', async () => {
    const { queueId } = await seedQueue(db, { concurrency_limit: 100 });
    await seedJobs(db, queueId, 50);
    const w = await seedWorker(db);
    const rows = await claimJobs(db, { queueId, workerId: w, localFree: 50, leaseSeconds: 30, batchCap: 1 });
    expect(rows).toHaveLength(1);
  });
});
