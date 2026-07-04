import type { ColumnType, Generated, JSONColumnType } from 'kysely';

/**
 * Hand-authored Kysely Database interface (committed, per R25 — a clean clone
 * has no live DB for kysely-codegen, so we do not depend on it to build).
 * Keep in sync with db/migrations.ts.
 */

export type JobStatus =
  | 'queued'
  | 'scheduled'
  | 'running'
  | 'retrying'
  | 'completed'
  | 'dead'
  | 'cancelled'; // added in migration 002 — see db/migrations-002.ts

export type JobType =
  | 'immediate'
  | 'delayed'
  | 'scheduled'
  | 'recurring'
  | 'batch';

export type WorkerStatus = 'starting' | 'active' | 'draining' | 'stopped' | 'dead';
export type ExecutionStatus = 'running' | 'succeeded' | 'failed';
export type RetryStrategy = 'fixed' | 'linear' | 'exponential';

type Ts = ColumnType<Date, Date | string, Date | string>;
type TsDefault = ColumnType<Date, Date | string | undefined, Date | string>;

export interface OrganizationsTable {
  id: Generated<string>;
  name: string;
  slug: string;
  created_at: TsDefault;
  updated_at: TsDefault;
}

export interface UsersTable {
  id: Generated<string>;
  org_id: string;
  email: string;
  password_hash: string;
  created_at: TsDefault;
  updated_at: TsDefault;
}

export interface ProjectsTable {
  id: Generated<string>;
  org_id: string;
  name: string;
  slug: string;
  description: string | null;
  created_at: TsDefault;
  updated_at: TsDefault;
}

export interface RetryPoliciesTable {
  id: Generated<string>;
  project_id: string;
  name: string;
  strategy: RetryStrategy;
  base_delay_ms: number;
  // numeric (OID 1700) — pg returns it as a string on select; callers must Number() it
  backoff_factor: ColumnType<string, number | string, number | string>;
  max_delay_ms: number | null;
  max_attempts: number;
  created_at: TsDefault;
  updated_at: TsDefault;
}

export interface QueuesTable {
  id: Generated<string>;
  project_id: string;
  retry_policy_id: string | null;
  name: string;
  priority: Generated<number>; // DDL: NOT NULL DEFAULT 5
  concurrency_limit: Generated<number>; // DDL: NOT NULL DEFAULT 5
  is_paused: Generated<boolean>; // DDL: NOT NULL DEFAULT false
  stat_queued: Generated<number>; // DDL: NOT NULL DEFAULT 0
  stat_running: Generated<number>; // DDL: NOT NULL DEFAULT 0
  stat_completed: Generated<number>; // DDL: NOT NULL DEFAULT 0
  stat_dead: Generated<number>; // DDL: NOT NULL DEFAULT 0
  created_at: TsDefault;
  updated_at: TsDefault;
}

export interface ScheduledJobsTable {
  id: Generated<string>;
  queue_id: string;
  retry_policy_id: string | null;
  handler_name: string;
  cron_expression: string;
  timezone: string;
  payload: JSONColumnType<Record<string, unknown>>;
  next_run_at: Ts;
  is_enabled: boolean;
  last_enqueued_at: Ts | null;
  last_job_id: string | null;
  created_at: TsDefault;
  updated_at: TsDefault;
}

export interface WorkersTable {
  id: Generated<string>;
  hostname: string;
  pid: number;
  status: Generated<WorkerStatus>; // DDL: NOT NULL DEFAULT 'active'
  concurrency: number;
  last_heartbeat_at: TsDefault;
  started_at: TsDefault;
  stopped_at: Ts | null;
}

export interface JobsTable {
  id: Generated<string>;
  queue_id: string;
  recurring_job_id: string | null;
  type: JobType;
  handler_name: string;
  status: JobStatus;
  priority: number;
  payload: JSONColumnType<Record<string, unknown>>;
  dedupe_key: string | null;
  run_at: TsDefault;
  attempts: number;
  max_attempts: number;
  retry_strategy: RetryStrategy;
  retry_base_delay_ms: number;
  // numeric (OID 1700) — pg returns it as a string on select; callers must Number() it
  retry_backoff_factor: ColumnType<string, number | string, number | string>;
  retry_max_delay_ms: number | null;
  locked_by: string | null;
  locked_until: Ts | null;
  last_error: string | null;
  death_reason: string | null;
  duration_ms: number | null;
  claimed_at: Ts | null;
  started_at: Ts | null;
  finished_at: Ts | null;
  created_at: TsDefault;
  updated_at: TsDefault;
}

export interface JobExecutionsTable {
  id: Generated<string>;
  job_id: string;
  worker_id: string | null;
  attempt: number;
  status: ExecutionStatus;
  started_at: TsDefault;
  finished_at: Ts | null;
  duration_ms: number | null;
  error: string | null;
}

export interface JobLogsTable {
  // bigserial (OID 20) — parsed to a JS number by the pool type parser
  id: Generated<number>;
  job_id: string;
  execution_id: string | null;
  level: string;
  message: string;
  logged_at: TsDefault;
}

export interface WorkerHeartbeatsTable {
  // bigserial (OID 20) — parsed to a JS number by the pool type parser
  id: Generated<number>;
  worker_id: string;
  running_jobs: number;
  reported_at: TsDefault;
}

export interface DeadLetterJobsTable {
  id: Generated<string>;
  // nullable: SET NULL when the origin job is purged (the DLQ row survives as an archive)
  job_id: string | null;
  queue_id: string;
  payload: JSONColumnType<Record<string, unknown>>;
  attempts: number;
  death_reason: string;
  final_error: string | null;
  died_at: TsDefault;
}

export interface Database {
  organizations: OrganizationsTable;
  users: UsersTable;
  projects: ProjectsTable;
  retry_policies: RetryPoliciesTable;
  queues: QueuesTable;
  scheduled_jobs: ScheduledJobsTable;
  workers: WorkersTable;
  jobs: JobsTable;
  job_executions: JobExecutionsTable;
  job_logs: JobLogsTable;
  worker_heartbeats: WorkerHeartbeatsTable;
  dead_letter_jobs: DeadLetterJobsTable;
}
