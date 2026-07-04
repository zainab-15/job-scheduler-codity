import { describe, expect, it } from 'vitest';
import {
  type RetryConfig,
  clampedDelayMs,
  computeBackoffMs,
  rawDelayMs,
  shouldRetry,
} from './backoff.js';

const base = (over: Partial<RetryConfig> = {}): RetryConfig => ({
  strategy: 'exponential',
  baseDelayMs: 1000,
  backoffFactor: 2,
  maxDelayMs: null,
  maxAttempts: 3,
  ...over,
});

describe('rawDelayMs', () => {
  it('fixed: constant regardless of attempt', () => {
    const c = base({ strategy: 'fixed' });
    expect(rawDelayMs(c, 1)).toBe(1000);
    expect(rawDelayMs(c, 5)).toBe(1000);
  });

  it('linear: base * attempt', () => {
    const c = base({ strategy: 'linear' });
    expect(rawDelayMs(c, 1)).toBe(1000);
    expect(rawDelayMs(c, 3)).toBe(3000);
  });

  it('exponential: base * factor^(attempt-1)', () => {
    const c = base({ strategy: 'exponential', backoffFactor: 2 });
    expect(rawDelayMs(c, 1)).toBe(1000);
    expect(rawDelayMs(c, 2)).toBe(2000);
    expect(rawDelayMs(c, 4)).toBe(8000);
  });
});

describe('clampedDelayMs', () => {
  it('clamps exponential growth to maxDelayMs', () => {
    const c = base({ strategy: 'exponential', maxDelayMs: 5000 });
    expect(clampedDelayMs(c, 1)).toBe(1000);
    expect(clampedDelayMs(c, 4)).toBe(5000); // 8000 -> capped
    expect(clampedDelayMs(c, 10)).toBe(5000);
  });
});

describe('computeBackoffMs (equal jitter)', () => {
  it('returns exact pinned values across the rand range (fixed base 1000)', () => {
    const c = base({ strategy: 'fixed', baseDelayMs: 1000 });
    // delay = round(clamped/2 + rand*clamped/2) = round(500 + rand*500)
    expect(computeBackoffMs(c, 1, () => 0)).toBe(500);
    expect(computeBackoffMs(c, 1, () => 0.25)).toBe(625);
    expect(computeBackoffMs(c, 1, () => 0.5)).toBe(750);
    expect(computeBackoffMs(c, 1, () => 1)).toBe(1000);
  });

  it('applies jitter on top of the exponential+clamp (attempt 2, base 1000)', () => {
    const c = base({ strategy: 'exponential', baseDelayMs: 1000, backoffFactor: 2 });
    // clamped(attempt 2) = 2000; delay = round(1000 + rand*1000)
    expect(computeBackoffMs(c, 2, () => 0.5)).toBe(1500);
  });

  it('stays within [clamped/2, clamped] for any rand', () => {
    const c = base({ strategy: 'fixed', baseDelayMs: 1000 });
    for (let i = 0; i < 50; i++) {
      const d = computeBackoffMs(c, 1);
      expect(d).toBeGreaterThanOrEqual(500);
      expect(d).toBeLessThanOrEqual(1000);
    }
  });
});

describe('shouldRetry', () => {
  it('retries while attempt < maxAttempts, DLQs at the boundary', () => {
    expect(shouldRetry(1, 3)).toBe(true);
    expect(shouldRetry(2, 3)).toBe(true);
    expect(shouldRetry(3, 3)).toBe(false);
    expect(shouldRetry(4, 3)).toBe(false);
  });
});
