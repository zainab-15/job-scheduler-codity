import { type Kysely, type Migration, type MigrationProvider, sql } from 'kysely';
import { ENUM_TYPES, TABLES_CHILD_FIRST } from './tables.js';
import { m002_cancelled_status } from './migrations-002.js';
import { m003_recurring_index_and_death_reason_check } from './migrations-003.js';

/**
 * Static, in-memory migration provider (no filesystem dynamic import, so it
 * runs identically under tsx, vitest, and compiled dist).
 *
 * ⚠️ 001_init IS FROZEN once applied anywhere. Kysely's Migrator keys on the
 * migration NAME (it does not hash the body), so editing 001 after it has run
 * on any persistent DB is a SILENT NO-OP — the change never applies and you get
 * a runtime "column does not exist". ALL schema changes go in a NEW file
 * (002_*, 003_*). When you add a table/enum, also add it to TABLES_CHILD_FIRST /
 * ENUM_TYPES in db/tables.ts (down() and the test TRUNCATE read those lists).
 */
const m001_init: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db);

    await sql`CREATE TYPE job_status AS ENUM ('queued','scheduled','running','retrying','completed','dead')`.execute(db);
    await sql`CREATE TYPE job_type AS ENUM ('immediate','delayed','scheduled','recurring','batch')`.execute(db);
    await sql`CREATE TYPE worker_status AS ENUM ('starting','active','draining','stopped','dead')`.execute(db);
    await sql`CREATE TYPE execution_status AS ENUM ('running','succeeded','failed')`.execute(db);

    await sql`
      CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
      BEGIN NEW.updated_at = now(); RETURN NEW; END;
      $$ LANGUAGE plpgsql
    `.execute(db);

    await sql`
      CREATE TABLE organizations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        slug text NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `.execute(db);

    await sql`
      CREATE TABLE users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        email text NOT NULL UNIQUE,
        password_hash text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `.execute(db);

    await sql`
      CREATE TABLE projects (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name text NOT NULL,
        slug text NOT NULL,
        description text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (org_id, slug)
      )
    `.execute(db);

    await sql`
      CREATE TABLE retry_policies (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name text NOT NULL,
        strategy text NOT NULL CHECK (strategy IN ('fixed','linear','exponential')),
        base_delay_ms integer NOT NULL DEFAULT 1000,
        backoff_factor numeric NOT NULL DEFAULT 2,
        max_delay_ms integer,
        max_attempts integer NOT NULL DEFAULT 3,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (project_id, name)
      )
    `.execute(db);

    await sql`
      CREATE TABLE queues (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        retry_policy_id uuid REFERENCES retry_policies(id) ON DELETE SET NULL,
        name text NOT NULL,
        priority integer NOT NULL DEFAULT 5 CHECK (priority >= 0 AND priority <= 9),
        concurrency_limit integer NOT NULL DEFAULT 5 CHECK (concurrency_limit >= 1),
        is_paused boolean NOT NULL DEFAULT false,
        stat_queued integer NOT NULL DEFAULT 0,
        stat_running integer NOT NULL DEFAULT 0,
        stat_completed integer NOT NULL DEFAULT 0,
        stat_dead integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (project_id, name)
      )
    `.execute(db);

    await sql`
      CREATE TABLE scheduled_jobs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        queue_id uuid NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
        retry_policy_id uuid REFERENCES retry_policies(id) ON DELETE SET NULL,
        handler_name text NOT NULL,
        cron_expression text NOT NULL,
        timezone text NOT NULL DEFAULT 'UTC',
        payload jsonb NOT NULL DEFAULT '{}',
        next_run_at timestamptz NOT NULL,
        is_enabled boolean NOT NULL DEFAULT true,
        last_enqueued_at timestamptz,
        last_job_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `.execute(db);
    await sql`CREATE INDEX idx_scheduled_due ON scheduled_jobs (next_run_at) WHERE is_enabled`.execute(db);

    await sql`
      CREATE TABLE workers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        hostname text NOT NULL,
        pid integer NOT NULL,
        status worker_status NOT NULL DEFAULT 'active',
        concurrency integer NOT NULL,
        last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
        started_at timestamptz NOT NULL DEFAULT now(),
        stopped_at timestamptz
      )
    `.execute(db);
    await sql`CREATE INDEX idx_workers_heartbeat ON workers (last_heartbeat_at) WHERE status IN ('active','draining')`.execute(db);

    await sql`
      CREATE TABLE jobs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        queue_id uuid NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
        recurring_job_id uuid REFERENCES scheduled_jobs(id) ON DELETE SET NULL,
        type job_type NOT NULL,
        handler_name text NOT NULL,
        status job_status NOT NULL DEFAULT 'queued',
        priority integer NOT NULL DEFAULT 5 CHECK (priority >= 0 AND priority <= 9),
        payload jsonb NOT NULL DEFAULT '{}',
        dedupe_key text,
        run_at timestamptz NOT NULL DEFAULT now(),
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
        -- mirror the CHECK on retry_policies.strategy so computeBackoffMs never sees an unknown value
        retry_strategy text NOT NULL DEFAULT 'exponential' CHECK (retry_strategy IN ('fixed','linear','exponential')),
        retry_base_delay_ms integer NOT NULL DEFAULT 1000 CHECK (retry_base_delay_ms >= 0),
        retry_backoff_factor numeric NOT NULL DEFAULT 2 CHECK (retry_backoff_factor >= 1),
        retry_max_delay_ms integer,
        locked_by uuid REFERENCES workers(id) ON DELETE SET NULL,
        locked_until timestamptz,
        last_error text,
        death_reason text,
        duration_ms integer,
        claimed_at timestamptz,
        started_at timestamptz,
        finished_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `.execute(db);

    // The centerpiece: partial index whose column order matches the claim's
    // WHERE + ORDER BY exactly, so the planner walks it (no Sort node). (§4/R8)
    await sql`CREATE INDEX idx_jobs_claim ON jobs (queue_id, priority DESC, run_at, created_at) WHERE status = 'queued'`.execute(db);
    await sql`CREATE INDEX idx_jobs_promote ON jobs (run_at) WHERE status IN ('scheduled','retrying')`.execute(db);
    await sql`CREATE INDEX idx_jobs_reclaim ON jobs (locked_until) WHERE status = 'running'`.execute(db);
    await sql`CREATE UNIQUE INDEX idx_jobs_dedupe ON jobs (queue_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND status NOT IN ('completed','dead')`.execute(db);
    await sql`CREATE INDEX idx_jobs_list ON jobs (queue_id, status, created_at DESC)`.execute(db);
    // FK-lookup index: deleting a worker (ON DELETE SET NULL) otherwise seq-scans jobs
    await sql`CREATE INDEX idx_jobs_locked_by ON jobs (locked_by) WHERE locked_by IS NOT NULL`.execute(db);

    // scheduled_jobs.last_job_id points at jobs; add the FK now that jobs exists
    await sql`ALTER TABLE scheduled_jobs
      ADD CONSTRAINT fk_scheduled_last_job FOREIGN KEY (last_job_id)
      REFERENCES jobs(id) ON DELETE SET NULL`.execute(db);

    await sql`
      CREATE TABLE job_executions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        worker_id uuid REFERENCES workers(id) ON DELETE SET NULL,
        attempt integer NOT NULL,
        status execution_status NOT NULL DEFAULT 'running',
        started_at timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz,
        duration_ms integer,
        error text,
        UNIQUE (job_id, attempt)
      )
    `.execute(db);
    // FK-lookup index: deleting a worker (ON DELETE SET NULL) otherwise seq-scans job_executions
    await sql`CREATE INDEX idx_job_executions_worker ON job_executions (worker_id) WHERE worker_id IS NOT NULL`.execute(db);

    await sql`
      CREATE TABLE job_logs (
        id bigserial PRIMARY KEY,
        job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        execution_id uuid REFERENCES job_executions(id) ON DELETE CASCADE,
        level text NOT NULL DEFAULT 'info',
        message text NOT NULL,
        logged_at timestamptz NOT NULL DEFAULT now()
      )
    `.execute(db);
    await sql`CREATE INDEX idx_job_logs_job ON job_logs (job_id, logged_at)`.execute(db);

    await sql`
      CREATE TABLE worker_heartbeats (
        id bigserial PRIMARY KEY,
        worker_id uuid NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
        running_jobs integer NOT NULL DEFAULT 0,
        reported_at timestamptz NOT NULL DEFAULT now()
      )
    `.execute(db);
    await sql`CREATE INDEX idx_worker_heartbeats ON worker_heartbeats (worker_id, reported_at DESC)`.execute(db);

    await sql`
      CREATE TABLE dead_letter_jobs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        -- job_id is SET NULL (not CASCADE): the DLQ denormalizes payload/attempts/
        -- final_error so it's a self-contained archive that must SURVIVE a Day-2
        -- job-retention/TTL cleanup. queue_id stays CASCADE so deleting a whole
        -- queue still destroys its history (approved spec decision R11).
        job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
        queue_id uuid NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
        payload jsonb NOT NULL,
        attempts integer NOT NULL,
        death_reason text NOT NULL,
        final_error text,
        died_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (job_id)
      )
    `.execute(db);
    await sql`CREATE INDEX idx_dlq_queue ON dead_letter_jobs (queue_id, died_at DESC)`.execute(db);

    // updated_at triggers for the tables the app mutates
    for (const t of [
      'organizations',
      'users',
      'projects',
      'retry_policies',
      'queues',
      'scheduled_jobs',
      'jobs',
    ]) {
      await sql`CREATE TRIGGER ${sql.raw(`trg_${t}_updated`)} BEFORE UPDATE ON ${sql.raw(t)}
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()`.execute(db);
    }
  },

  async down(db: Kysely<unknown>): Promise<void> {
    for (const t of TABLES_CHILD_FIRST) {
      await sql`DROP TABLE IF EXISTS ${sql.raw(t)} CASCADE`.execute(db);
    }
    await sql`DROP FUNCTION IF EXISTS set_updated_at()`.execute(db);
    for (const e of ENUM_TYPES) {
      await sql`DROP TYPE IF EXISTS ${sql.raw(e)}`.execute(db);
    }
  },
};

export const migrations: Record<string, Migration> = {
  '001_init': m001_init,
  '002_cancelled_status': m002_cancelled_status,
  '003_recurring_index_and_death_reason_check': m003_recurring_index_and_death_reason_check,
};

export class StaticMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return migrations;
  }
}
