import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { type DB, claimJobs, heartbeatWorker, reclaimStuckJobs } from '@scheduler/shared';
import { closeTestDb, getTestDb, resetDb, seedQueue, seedWorker } from '../../shared/test/pg-harness.js';
import { insertJobs } from './helpers.js';

let db: DB;

beforeEach(async () => {
  db = await getTestDb();
  await resetDb(db);
});

afterAll(async () => {
  await closeTestDb();
});

describe('heartbeat lease-extend fence (D2-Eng-3 / R12)', () => {
  it('extends a lease that is still live', async () => {
    const { queueId } = await seedQueue(db, { concurrency_limit: 5 });
    await insertJobs(db, queueId, 1, { handler: 'sleep' });
    const workerId = await seedWorker(db);
    const claimed = await claimJobs(db, { queueId, workerId, localFree: 5, leaseSeconds: 30 });
    const jobId = claimed[0]!.id;

    const before = await db.selectFrom('jobs').select('locked_until').where('id', '=', jobId).executeTakeFirstOrThrow();
    await heartbeatWorker(db, { workerId, jobIds: [jobId], leaseSeconds: 30 });
    const after = await db.selectFrom('jobs').select('locked_until').where('id', '=', jobId).executeTakeFirstOrThrow();

    expect(after.locked_until!.getTime()).toBeGreaterThan(before.locked_until!.getTime());
  });

  it('does NOT resurrect an already-expired lease — negative control: this assertion would FAIL if the `locked_until > now()` clause were removed from heartbeatWorker', async () => {
    const { queueId } = await seedQueue(db, { concurrency_limit: 5 });
    await insertJobs(db, queueId, 1, { handler: 'sleep' });
    const workerId = await seedWorker(db);
    const claimed = await claimJobs(db, { queueId, workerId, localFree: 5, leaseSeconds: 30 });
    const jobId = claimed[0]!.id;

    // force-expire the lease: simulates a worker that stalled (GC pause, event
    // loop block) long enough for its lease to lapse, but is still alive and
    // about to send a heartbeat anyway
    await sql`UPDATE jobs SET locked_until = now() - interval '1 second' WHERE id = ${jobId}`.execute(db);
    const expiredAt = (
      await db.selectFrom('jobs').select('locked_until').where('id', '=', jobId).executeTakeFirstOrThrow()
    ).locked_until!;

    await heartbeatWorker(db, { workerId, jobIds: [jobId], leaseSeconds: 30 });

    const after = await db.selectFrom('jobs').select('locked_until').where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(after.locked_until!.getTime()).toBe(expiredAt.getTime()); // untouched — NOT pushed into the future
    expect(after.locked_until!.getTime()).toBeLessThan(Date.now());
  });

  it('end-to-end: a stalled worker cannot steal a job back from the reaper via a late heartbeat', async () => {
    const { queueId } = await seedQueue(db, { concurrency_limit: 5 });
    await insertJobs(db, queueId, 1, { handler: 'sleep', maxAttempts: 3 });
    const workerId = await seedWorker(db);
    const claimed = await claimJobs(db, { queueId, workerId, localFree: 5, leaseSeconds: 30 });
    const jobId = claimed[0]!.id;

    await sql`UPDATE jobs SET locked_until = now() - interval '1 second' WHERE id = ${jobId}`.execute(db);
    expect(await reclaimStuckJobs(db)).toBe(1);

    let job = await db.selectFrom('jobs').selectAll().where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(job.status).toBe('queued');
    expect(job.locked_by).toBeNull();

    // the stalled worker, unaware it already lost the job, sends a heartbeat anyway
    await heartbeatWorker(db, { workerId, jobIds: [jobId], leaseSeconds: 30 });

    job = await db.selectFrom('jobs').selectAll().where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(job.status).toBe('queued'); // NOT re-locked back to the stalled worker
    expect(job.locked_by).toBeNull();
  });
});
