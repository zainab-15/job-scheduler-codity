import pg from 'pg';

const { Pool } = pg;

// node-postgres returns BIGINT (int8) as a string by default; parse the
// bigserial PK columns (job_logs.id, worker_heartbeats.id) to JS numbers.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new Pool({ connectionString, max });
}

export type { Pool } from 'pg';
