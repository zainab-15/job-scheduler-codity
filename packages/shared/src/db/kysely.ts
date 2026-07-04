import { Kysely, PostgresDialect, sql } from 'kysely';
import type pg from 'pg';
import { createPool } from './pool.js';
import type { Database } from './types.js';

// Re-exported so consumers (api, worker) never need `kysely` as a direct
// dependency — shared is the one place that touches Postgres.
export { sql };

export function createDb(connectionString: string, poolMax = 10, ssl = false): Kysely<Database> {
  const pool = createPool(connectionString, poolMax, ssl);
  return createDbFromPool(pool);
}

export function createDbFromPool(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
}

export type DB = Kysely<Database>;
