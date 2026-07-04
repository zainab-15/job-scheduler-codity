import { z } from 'zod';

/**
 * Single validated env schema for every service. Both api and worker call
 * loadEnv() as their first line and refuse to boot on a bad var (fail-fast).
 * All *_MS vars are coerced to positive ints so a stray "30000 " or float can
 * never reach an interval literal (R16).
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  TEST_DATABASE_URL: z.string().url().optional(),
  PG_POOL_MAX: z.coerce.number().int().positive().default(10),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  // worker
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(10000),
  LEASE_MS: z.coerce.number().int().positive().default(30000),
  RECLAIM_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  // graceful shutdown: how long a worker waits for in-flight jobs before
  // aborting + fenced-requeuing them (§7). Heartbeat stays alive during this
  // window (R14), so this is not bounded by LEASE_MS the way it once was.
  SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().default(25000),

  // api (optional so the worker doesn't require them)
  PORT: z.coerce.number().int().positive().default(3000),
  // R30: min length enforced so an intern can't ship JWT_SECRET=secret.
  JWT_SECRET: z.string().min(32).optional(),
}).superRefine((v, ctx) => {
  // Cross-field *_MS invariants (the .env.example promises these). A live worker
  // must heartbeat well within its lease, or the reaper reclaims jobs out from
  // under it.
  if (v.HEARTBEAT_INTERVAL_MS >= v.LEASE_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['HEARTBEAT_INTERVAL_MS'],
      message: `HEARTBEAT_INTERVAL_MS (${v.HEARTBEAT_INTERVAL_MS}) must be < LEASE_MS (${v.LEASE_MS})`,
    });
  }
  if (v.RECLAIM_INTERVAL_MS > v.LEASE_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['RECLAIM_INTERVAL_MS'],
      message: `RECLAIM_INTERVAL_MS (${v.RECLAIM_INTERVAL_MS}) should be <= LEASE_MS (${v.LEASE_MS})`,
    });
  }
});

export type Env = z.infer<typeof EnvSchema>;

/** Thrown by loadEnv on invalid config; entrypoints decide whether to exit. */
export class EnvValidationError extends Error {
  constructor(readonly fieldErrors: Record<string, string[] | undefined>) {
    super('Invalid environment. Fix these in your .env (see .env.example):\n' + JSON.stringify(fieldErrors, null, 2));
    this.name = 'EnvValidationError';
  }
}

let cached: Env | null = null;

/** Parse + cache env. THROWS EnvValidationError on bad config (do not swallow) —
 *  entrypoints (cli-migrate, api, worker) catch it and exit non-zero. */
export function loadEnv(overrides: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(overrides);
  if (!parsed.success) {
    throw new EnvValidationError(parsed.error.flatten().fieldErrors);
  }
  cached = parsed.data;
  return cached;
}

/** Test-only: parse without touching the module cache. */
export function parseEnv(overrides: NodeJS.ProcessEnv): Env {
  return EnvSchema.parse(overrides);
}

/** Test-only: reset the loadEnv cache between cases. */
export function resetEnvCache(): void {
  cached = null;
}
