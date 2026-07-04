// Hand-authored TS mirroring the exact REST contract (packages/api/src/routes).
// Dates arrive as ISO strings over the wire. NOTE: retry_backoff_factor and
// retry_policy.backoff_factor come back as numeric STRINGS from Postgres numeric
// columns — Number() them before arithmetic/display.

export type JobStatus = 'queued' | 'scheduled' | 'running' | 'retrying' | 'completed' | 'dead' | 'cancelled';
export type JobType = 'immediate' | 'delayed' | 'scheduled' | 'recurring' | 'batch';
export type WorkerStatus = 'starting' | 'active' | 'draining' | 'stopped' | 'dead';
export type Liveness = 'alive' | 'draining' | 'dead';
export type RetryStrategy = 'fixed' | 'linear' | 'exponential';
export type ExecutionStatus = 'running' | 'succeeded' | 'failed';

export interface ErrorEnvelope {
  error: { code: string; message: string; correlation_id: string; details?: unknown };
}

export interface Pagination {
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}
export interface PaginatedResult<T> {
  data: T[];
  pagination: Pagination;
}

export interface AuthUser {
  id: string;
  email: string;
  org_id?: string;
}
export interface Organization {
  id: string;
  name: string;
  slug: string;
  created_at: string;
}
export interface RegisterResponse {
  token: string;
  user: { id: string; email: string };
  organization: { id: string; name: string };
}
export interface LoginResponse {
  token: string;
  user: { id: string; email: string; org_id: string };
}
export interface MeResponse {
  user: { id: string; email: string };
  organization: Organization;
}

export interface ProjectRow {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  queue_count?: number;
}

export interface QueueRow {
  id: string;
  project_id: string;
  retry_policy_id: string | null;
  name: string;
  priority: number;
  concurrency_limit: number;
  is_paused: boolean;
  stat_queued: number;
  stat_running: number;
  stat_completed: number;
  stat_dead: number;
  created_at: string;
  updated_at: string;
}
export interface RetryPolicyDetail {
  id: string;
  strategy: string;
  base_delay_ms: number;
  backoff_factor: number;
  max_delay_ms: number | null;
  max_attempts: number;
}
export interface QueueDetail extends QueueRow {
  retry_policy: RetryPolicyDetail | null;
}

export interface JobRow {
  id: string;
  queue_id: string;
  recurring_job_id: string | null;
  type: JobType;
  handler_name: string;
  status: JobStatus;
  priority: number;
  payload: Record<string, unknown>;
  dedupe_key: string | null;
  run_at: string;
  attempts: number;
  max_attempts: number;
  retry_strategy: RetryStrategy;
  retry_base_delay_ms: number;
  retry_backoff_factor: string; // numeric string
  retry_max_delay_ms: number | null;
  locked_by: string | null;
  locked_until: string | null;
  last_error: string | null;
  death_reason: string | null;
  duration_ms: number | null;
  claimed_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobExecutionRow {
  id: string;
  job_id: string;
  worker_id: string | null;
  attempt: number;
  status: ExecutionStatus | string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  error: string | null;
}
export interface JobLogRow {
  id: number;
  job_id: string;
  execution_id: string | null;
  level: string;
  message: string;
  logged_at: string;
}
export interface JobDetail {
  job: JobRow;
  executions: JobExecutionRow[];
  logs: JobLogRow[];
}

export interface BatchCreateResult {
  created: string[];
  skipped: Array<{ index: number; dedupe_key: string; reason: 'duplicate' }>;
  count: { created: number; skipped: number };
}

export interface ScheduleCreateResult {
  scheduled_job_id: string;
  next_run_at: string;
  cron: string;
  timezone: string;
}

export interface DlqRow {
  id: string;
  job_id: string | null;
  queue_id: string;
  payload: Record<string, unknown>;
  attempts: number;
  death_reason: string;
  final_error: string | null;
  died_at: string;
}

export interface WorkerRow {
  id: string;
  hostname: string;
  pid: number;
  status: WorkerStatus;
  concurrency: number;
  last_heartbeat_at: string;
  started_at: string;
  stopped_at: string | null;
  liveness: Liveness;
}

export interface QueueStatsResult {
  queue_id: string;
  is_paused: boolean;
  counts: {
    queued: number;
    scheduled: number;
    running: number;
    retrying: number;
    completed: number;
    dead: number;
    cancelled: number;
  };
  window_hours: number;
  completed_in_window: number;
  failed_in_window: number;
  avg_duration_ms: number | null;
  dlq_size: number;
}

export interface OverviewResult {
  projects: number;
  queues: number;
  workers: { alive: number; dead: number; draining: number };
  jobs: { queued: number; running: number; completed_24h: number; failed_24h: number; dead_letter: number };
  success_rate_24h: number;
}

export interface HealthCheck {
  ok: boolean;
  value?: number;
  threshold?: number;
}
export interface HealthResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: {
    workers_alive: HealthCheck;
    oldest_pending_age_ms: HealthCheck;
    dlq_growth_24h: HealthCheck;
    db: { ok: boolean };
  };
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
