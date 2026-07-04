import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { type DB, createRecurringJob, promoteRecurring } from '@scheduler/shared';
import { closeTestDb, getTestDb, resetDb, seedQueue } from './pg-harness.js';

let db: DB;

beforeEach(async () => {
  db = await getTestDb();
  await resetDb(db);
});

afterAll(async () => {
  await closeTestDb();
});

describe('createRecurringJob', () => {
  it('creates a scheduled_jobs template with a computed next_run_at', async () => {
    const { orgId, queueId } = await seedQueue(db);
    const result = await createRecurringJob(db, {
      orgId,
      queueId,
      handlerName: 'sleep',
      payload: { ms: 100 },
      cronExpression: '*/5 * * * *',
    });
    expect(result.kind).toBe('created');
    if (result.kind !== 'created') return;
    expect(result.schedule.handler_name).toBe('sleep');
    expect(result.schedule.timezone).toBe('UTC');
    expect(result.schedule.next_run_at.getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects a cross-org queue with queue_not_found', async () => {
    const { queueId } = await seedQueue(db);
    const result = await createRecurringJob(db, {
      orgId: '00000000-0000-0000-0000-000000000000',
      queueId,
      handlerName: 'sleep',
      payload: {},
      cronExpression: '*/5 * * * *',
    });
    expect(result.kind).toBe('queue_not_found');
  });

  it('surfaces the actual cron-parser message on an invalid expression (R27)', async () => {
    const { orgId, queueId } = await seedQueue(db);
    const result = await createRecurringJob(db, { orgId, queueId, handlerName: 'sleep', payload: {}, cronExpression: 'not a cron' });
    expect(result.kind).toBe('invalid_cron');
    if (result.kind !== 'invalid_cron') return;
    expect(result.message.length).toBeGreaterThan(0);
  });
});

describe('promoteRecurringTx / promoteRecurring (Part 2C)', () => {
  it('spawns exactly one occurrence for a due schedule, then does not double-enqueue on an immediate re-run', async () => {
    const { orgId, queueId } = await seedQueue(db);
    const created = await createRecurringJob(db, {
      orgId,
      queueId,
      handlerName: 'sleep',
      payload: { ms: 1 },
      cronExpression: '* * * * *', // every minute
    });
    if (created.kind !== 'created') throw new Error('setup failed');

    // force it due right now instead of waiting up to a minute for a real tick
    await sql`UPDATE scheduled_jobs SET next_run_at = now() - interval '1 second' WHERE id = ${created.schedule.id}`.execute(db);

    const promotedFirst = await promoteRecurring(db);
    expect(promotedFirst).toBe(1);

    const jobs = await db.selectFrom('jobs').selectAll().where('recurring_job_id', '=', created.schedule.id).execute();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.type).toBe('recurring');
    expect(jobs[0]!.status).toBe('queued');
    expect(jobs[0]!.dedupe_key).toMatch(new RegExp(`^cron:${created.schedule.id}:`));

    const queueAfter = await db.selectFrom('queues').select('stat_queued').where('id', '=', queueId).executeTakeFirstOrThrow();
    expect(queueAfter.stat_queued).toBe(1);

    const scheduleAfter = await db.selectFrom('scheduled_jobs').selectAll().where('id', '=', created.schedule.id).executeTakeFirstOrThrow();
    expect(scheduleAfter.next_run_at.getTime()).toBeGreaterThan(Date.now()); // watermark advanced into the future
    expect(scheduleAfter.last_job_id).toBe(jobs[0]!.id);
    expect(scheduleAfter.last_enqueued_at).not.toBeNull();

    // The schedule is no longer due (next_run_at just moved into the future) —
    // a second leader tick right away must promote nothing new.
    const promotedSecond = await promoteRecurring(db);
    expect(promotedSecond).toBe(0);
    const jobsAfterSecondTick = await db.selectFrom('jobs').selectAll().where('recurring_job_id', '=', created.schedule.id).execute();
    expect(jobsAfterSecondTick).toHaveLength(1); // still exactly one — no double-enqueue
  });

  it('freezes the retry contract from DEFAULT_RETRY_CONFIG when the queue has no retry_policy_id (D2-Eng-2/D2-CEO-3)', async () => {
    const { orgId, queueId } = await seedQueue(db);
    // seedQueue always attaches a retry_policies row; explicitly null it out to
    // exercise the exact gap two independent reviewers caught: scheduled_jobs
    // has no frozen retry columns of its own, only a nullable FK to the
    // queue's policy — inserting the occurrence must not throw a NOT NULL
    // violation, it must COALESCE to DEFAULT_RETRY_CONFIG.
    await sql`UPDATE queues SET retry_policy_id = NULL WHERE id = ${queueId}`.execute(db);

    const created = await createRecurringJob(db, { orgId, queueId, handlerName: 'sleep', payload: {}, cronExpression: '* * * * *' });
    if (created.kind !== 'created') throw new Error('setup failed');
    await sql`UPDATE scheduled_jobs SET next_run_at = now() - interval '1 second' WHERE id = ${created.schedule.id}`.execute(db);

    await expect(promoteRecurring(db)).resolves.toBe(1); // must not throw

    const job = await db.selectFrom('jobs').selectAll().where('recurring_job_id', '=', created.schedule.id).executeTakeFirstOrThrow();
    expect(job.retry_strategy).toBe('exponential');
    expect(job.max_attempts).toBe(3);
  });

  it('collapses an arbitrarily large backlog to exactly one occurrence per tick (R9)', async () => {
    const { orgId, queueId } = await seedQueue(db);
    const created = await createRecurringJob(db, {
      orgId,
      queueId,
      handlerName: 'sleep',
      payload: {},
      cronExpression: '*/5 * * * *', // every 5 minutes
    });
    if (created.kind !== 'created') throw new Error('setup failed');

    // simulate a leader that was down for 3 days — massively overdue
    await sql`UPDATE scheduled_jobs SET next_run_at = now() - interval '3 days' WHERE id = ${created.schedule.id}`.execute(db);

    const promoted = await promoteRecurring(db);
    expect(promoted).toBe(1); // one tick, one occurrence — not hundreds of missed slots

    const jobs = await db.selectFrom('jobs').selectAll().where('recurring_job_id', '=', created.schedule.id).execute();
    expect(jobs).toHaveLength(1);

    const scheduleAfter = await db.selectFrom('scheduled_jobs').selectAll().where('id', '=', created.schedule.id).executeTakeFirstOrThrow();
    // the new watermark lands within one interval of now, not still buried in the backlog
    expect(scheduleAfter.next_run_at.getTime() - Date.now()).toBeLessThan(6 * 60 * 1000);
  });

  it('honors a non-UTC timezone rather than silently firing in UTC', async () => {
    const { orgId, queueId } = await seedQueue(db);
    // 9am New York daily. On 2026-07-04 (EDT, UTC-4), 9am local = 13:00 UTC.
    const created = await createRecurringJob(db, {
      orgId,
      queueId,
      handlerName: 'sleep',
      payload: {},
      cronExpression: '0 9 * * *',
      timezone: 'America/New_York',
    });
    if (created.kind !== 'created') throw new Error('setup failed');

    await sql`UPDATE scheduled_jobs SET next_run_at = '2026-07-04T12:00:00Z' WHERE id = ${created.schedule.id}`.execute(db);
    // ^ arrange so it's already due; the interesting assertion is what the NEXT watermark becomes.

    await promoteRecurring(db);

    const scheduleAfter = await db.selectFrom('scheduled_jobs').selectAll().where('id', '=', created.schedule.id).executeTakeFirstOrThrow();
    // Whatever "now" the test runs at, the next 9am-New-York occurrence must be
    // 13:00 or 12:00 UTC (EDT/EST) — never a UTC-literal 09:00, which is what a
    // timezone-dropping bug would produce.
    const hourUtc = scheduleAfter.next_run_at.getUTCHours();
    expect([12, 13]).toContain(hourUtc);
  });
});
