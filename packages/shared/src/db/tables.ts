/**
 * Child-first table order (respects FK dependencies). Single source of truth for
 * migration down() and the test-harness TRUNCATE, so adding a table can't leave
 * the two lists silently out of sync.
 */
export const TABLES_CHILD_FIRST = [
  'dead_letter_jobs',
  'worker_heartbeats',
  'job_logs',
  'job_executions',
  'jobs',
  'workers',
  'scheduled_jobs',
  'queues',
  'retry_policies',
  'projects',
  'users',
  'organizations',
] as const;

/** Enum types created by 001_init, dropped last in down() (after all tables). */
export const ENUM_TYPES = ['job_status', 'job_type', 'worker_status', 'execution_status'] as const;
