import type { RetryStrategy } from '../db/types.js';

export interface RetryConfig {
  strategy: RetryStrategy;
  baseDelayMs: number;
  backoffFactor: number;
  maxDelayMs: number | null;
  maxAttempts: number;
}

/** Single source of truth for the product-default retry policy. Referenced by
 *  seeds and default queue creation so the value isn't copy-pasted out of sync. */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  strategy: 'exponential',
  baseDelayMs: 1000,
  backoffFactor: 2,
  maxDelayMs: 60000,
  maxAttempts: 3,
};

/**
 * Pre-jitter, pre-clamp delay. `attempt` = the attempt that JUST FAILED (1-based).
 *   fixed:       base
 *   linear:      base * attempt
 *   exponential: base * factor^(attempt-1)
 */
export function rawDelayMs(cfg: RetryConfig, attempt: number): number {
  switch (cfg.strategy) {
    case 'fixed':
      return cfg.baseDelayMs;
    case 'linear':
      return cfg.baseDelayMs * attempt;
    case 'exponential':
      return cfg.baseDelayMs * Math.pow(cfg.backoffFactor, attempt - 1);
    default: {
      // Defense-in-depth: the DB CHECK on retry_strategy makes this unreachable,
      // but a raw/legacy row must fail loudly rather than return NaN.
      const never: never = cfg.strategy;
      throw new Error(`unknown retry strategy: ${String(never)}`);
    }
  }
}

/** After clamping to maxDelayMs (if set). Still deterministic (no jitter). */
export function clampedDelayMs(cfg: RetryConfig, attempt: number): number {
  const raw = rawDelayMs(cfg, attempt);
  return cfg.maxDelayMs != null ? Math.min(raw, cfg.maxDelayMs) : raw;
}

/**
 * Final delay with equal-jitter: keeps at least half the clamped delay (so a
 * retry never fires instantly) plus up to half more, spreading a batch of
 * co-failing jobs. `rand` is injectable for deterministic tests.
 */
export function computeBackoffMs(
  cfg: RetryConfig,
  attempt: number,
  rand: () => number = Math.random,
): number {
  const d = clampedDelayMs(cfg, attempt);
  return Math.round(d / 2 + rand() * (d / 2));
}

/** True while the job still has attempts left; false => it belongs in the DLQ. */
export function shouldRetry(attempt: number, maxAttempts: number): boolean {
  return attempt < maxAttempts;
}
