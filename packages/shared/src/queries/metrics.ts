import { type Kysely, sql } from 'kysely';
import type { Database } from '../db/types.js';

export interface OverviewResult {
  projects: number;
  queues: number;
  workers: { alive: number; dead: number; draining: number };
  jobs: { queued: number; running: number; completed_24h: number; failed_24h: number; dead_letter: number };
  success_rate_24h: number;
}

/**
 * Workers are NOT org-scoped in the schema (no org_id/project_id on
 * `workers` — one fleet serves the whole deployment, matching this build's
 * single-tenant-per-deployment assumption). Reported globally, not per-org.
 */
export async function getOverview(db: Kysely<Database>, orgId: string): Promise<OverviewResult> {
  const counts = await sql<{ projects: string; queues: string }>`
    SELECT
      (SELECT count(*) FROM projects WHERE org_id = ${orgId})::int AS projects,
      (SELECT count(*) FROM queues q JOIN projects p ON p.id = q.project_id WHERE p.org_id = ${orgId})::int AS queues
  `.execute(db);

  const workers = await sql<{ alive: string; dead: string; draining: string }>`
    SELECT
      count(*) FILTER (WHERE status IN ('starting','active') AND last_heartbeat_at > now() - interval '30 seconds')::int AS alive,
      count(*) FILTER (WHERE status = 'dead' OR last_heartbeat_at <= now() - interval '30 seconds')::int AS dead,
      count(*) FILTER (WHERE status = 'draining')::int AS draining
    FROM workers
  `.execute(db);

  const jobs = await sql<{ queued: string; running: string; completed_24h: string; failed_24h: string; dead_letter: string }>`
    SELECT
      (SELECT count(*) FROM jobs j JOIN queues q ON q.id=j.queue_id JOIN projects p ON p.id=q.project_id WHERE p.org_id=${orgId} AND j.status='queued')::int AS queued,
      (SELECT count(*) FROM jobs j JOIN queues q ON q.id=j.queue_id JOIN projects p ON p.id=q.project_id WHERE p.org_id=${orgId} AND j.status='running')::int AS running,
      (SELECT count(*) FROM jobs j JOIN queues q ON q.id=j.queue_id JOIN projects p ON p.id=q.project_id WHERE p.org_id=${orgId} AND j.status='completed' AND j.finished_at >= now() - interval '24 hours')::int AS completed_24h,
      (SELECT count(*) FROM job_executions e JOIN jobs j ON j.id=e.job_id JOIN queues q ON q.id=j.queue_id JOIN projects p ON p.id=q.project_id WHERE p.org_id=${orgId} AND e.status='failed' AND e.finished_at >= now() - interval '24 hours')::int AS failed_24h,
      (SELECT count(*) FROM dead_letter_jobs d JOIN queues q ON q.id=d.queue_id JOIN projects p ON p.id=q.project_id WHERE p.org_id=${orgId})::int AS dead_letter
  `.execute(db);

  const c = counts.rows[0]!;
  const w = workers.rows[0]!;
  const j = jobs.rows[0]!;
  const completed = Number(j.completed_24h);
  const failed = Number(j.failed_24h);
  const successRate = completed + failed > 0 ? completed / (completed + failed) : 1;

  return {
    projects: Number(c.projects),
    queues: Number(c.queues),
    workers: { alive: Number(w.alive), dead: Number(w.dead), draining: Number(w.draining) },
    jobs: {
      queued: Number(j.queued),
      running: Number(j.running),
      completed_24h: completed,
      failed_24h: failed,
      dead_letter: Number(j.dead_letter),
    },
    success_rate_24h: Math.round(successRate * 10000) / 10000,
  };
}

export interface HealthResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: {
    workers_alive: { ok: boolean; value: number };
    oldest_pending_age_ms: { ok: boolean; value: number; threshold: number };
    dlq_growth_24h: { ok: boolean; value: number };
    db: { ok: boolean };
  };
}

const PENDING_AGE_THRESHOLD_MS = 60_000;

export async function getHealth(db: Kysely<Database>, orgId: string): Promise<HealthResult> {
  let dbOk = true;
  try {
    await sql`SELECT 1`.execute(db);
  } catch {
    dbOk = false;
  }

  const workersAlive = await sql<{ n: string }>`
    SELECT count(*)::int AS n FROM workers
    WHERE status IN ('starting','active') AND last_heartbeat_at > now() - interval '30 seconds'
  `.execute(db);
  const alive = Number(workersAlive.rows[0]?.n ?? 0);

  const oldestPending = await sql<{ ms: string | null }>`
    SELECT EXTRACT(EPOCH FROM (now() - min(j.run_at))) * 1000 AS ms
    FROM jobs j JOIN queues q ON q.id = j.queue_id JOIN projects p ON p.id = q.project_id
    WHERE p.org_id = ${orgId} AND j.status IN ('queued', 'retrying') AND j.run_at <= now()
  `.execute(db);
  const oldestMs = oldestPending.rows[0]?.ms != null ? Math.round(Number(oldestPending.rows[0].ms)) : 0;
  const hasPendingJobs = oldestMs > 0;

  const dlqGrowth = await sql<{ n: string }>`
    SELECT count(*)::int AS n FROM dead_letter_jobs d JOIN queues q ON q.id = d.queue_id JOIN projects p ON p.id = q.project_id
    WHERE p.org_id = ${orgId} AND d.died_at >= now() - interval '24 hours'
  `.execute(db);

  const checks: HealthResult['checks'] = {
    workers_alive: { ok: alive > 0 || !hasPendingJobs, value: alive },
    oldest_pending_age_ms: { ok: oldestMs < PENDING_AGE_THRESHOLD_MS, value: oldestMs, threshold: PENDING_AGE_THRESHOLD_MS },
    dlq_growth_24h: { ok: true, value: Number(dlqGrowth.rows[0]?.n ?? 0) }, // informational; no fixed threshold in this build's scope
    db: { ok: dbOk },
  };

  const status: HealthResult['status'] =
    !dbOk || (alive === 0 && hasPendingJobs) ? 'unhealthy' : !checks.oldest_pending_age_ms.ok ? 'degraded' : 'healthy';

  return { status, checks };
}

export interface ThroughputPoint {
  ts: string;
  completed: number;
  failed: number;
  avg_duration_ms: number | null;
}

export interface ThroughputResult {
  window: string;
  bucket: 'minute' | 'hour';
  series: ThroughputPoint[];
}

/**
 * Simplified per the spec's own pre-approved fallback: buckets with zero
 * activity are omitted rather than filled with generate_series (the
 * "fiddly" empty-bucket-filling version) — a documented cut, not a bug; a
 * frontend chart renders gaps as zero just fine.
 */
export async function getThroughput(
  db: Kysely<Database>,
  args: { orgId: string; windowHours: number; bucket: 'minute' | 'hour'; projectId?: string; queueId?: string },
): Promise<ThroughputResult> {
  const rows = await sql<{ ts: Date; completed: string; failed: string; avg_ms: string | null }>`
    SELECT date_trunc(${args.bucket}, e.finished_at) AS ts,
           count(*) FILTER (WHERE e.status = 'succeeded')::int AS completed,
           count(*) FILTER (WHERE e.status = 'failed')::int AS failed,
           avg(e.duration_ms) FILTER (WHERE e.status = 'succeeded') AS avg_ms
    FROM job_executions e
    JOIN jobs j ON j.id = e.job_id
    JOIN queues q ON q.id = j.queue_id
    JOIN projects p ON p.id = q.project_id
    WHERE p.org_id = ${args.orgId}
      AND e.finished_at >= now() - make_interval(hours => ${args.windowHours})
      AND (${args.projectId ?? null}::uuid IS NULL OR p.id = ${args.projectId ?? null})
      AND (${args.queueId ?? null}::uuid IS NULL OR q.id = ${args.queueId ?? null})
    GROUP BY 1
    ORDER BY 1
  `.execute(db);

  return {
    window: `${args.windowHours}h`,
    bucket: args.bucket,
    series: rows.rows.map((r) => ({
      ts: r.ts.toISOString(),
      completed: Number(r.completed),
      failed: Number(r.failed),
      avg_duration_ms: r.avg_ms != null ? Math.round(Number(r.avg_ms)) : null,
    })),
  };
}
