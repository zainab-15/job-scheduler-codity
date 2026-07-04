import pg from 'pg';

const { Pool } = pg;

// node-postgres returns BIGINT (int8) as a string by default; parse the
// bigserial PK columns (job_logs.id, worker_heartbeats.id) to JS numbers.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export function createPool(connectionString: string, max = 10, ssl = false): pg.Pool {
  const pool = new Pool({
    connectionString,
    max,
    // A single stuck query must not pin a pooled connection forever and
    // starve every other request sharing this pool (default max 10).
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
    // rejectUnauthorized:false because managed providers (Supabase included)
    // commonly present a cert chain Node's default trust store won't
    // validate; PGSSL=true is an explicit opt-in (see env.ts), not sniffed
    // from the connection string.
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
  });
  // node-postgres emits 'error' on an IDLE client whose backend connection
  // dies (network blip, PG restart). With no listener this is an unhandled
  // exception that crashes the whole process — attach a logging no-op so the
  // pool just discards the dead client and carries on.
  pool.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[pg pool] idle client error (client discarded):', err.message);
  });
  return pool;
}

export type { Pool } from 'pg';
