import { describe, expect, it } from 'vitest';
import { isValidCron, nextRunAt, validateCron } from './cron.js';

describe('nextRunAt', () => {
  it('every 5 minutes lands on the next 5-min boundary', () => {
    const from = new Date('2026-07-04T10:02:00Z');
    const next = nextRunAt('*/5 * * * *', from, 'UTC');
    expect(next.toISOString()).toBe('2026-07-04T10:05:00.000Z');
  });

  it('weekly Monday 09:00 finds the next Monday', () => {
    // 2026-07-04 is a Saturday; next Monday is 2026-07-06.
    const from = new Date('2026-07-04T10:00:00Z');
    const next = nextRunAt('0 9 * * 1', from, 'UTC');
    expect(next.toISOString()).toBe('2026-07-06T09:00:00.000Z');
  });

  it('is strictly after `from`', () => {
    const from = new Date('2026-07-04T10:05:00Z');
    const next = nextRunAt('*/5 * * * *', from, 'UTC');
    expect(next.getTime()).toBeGreaterThan(from.getTime());
  });
});

describe('isValidCron', () => {
  it('accepts a valid expression', () => {
    expect(isValidCron('*/15 * * * *')).toBe(true);
  });
  it('rejects garbage', () => {
    expect(isValidCron('not a cron')).toBe(false);
    expect(isValidCron('99 99 99 99 99')).toBe(false);
  });
});

describe('validateCron', () => {
  it('accepts a valid expression with no message', () => {
    expect(validateCron('*/15 * * * *')).toEqual({ valid: true });
  });
  it('rejects garbage and surfaces cron-parser\'s own message (R27)', () => {
    const result = validateCron('not a cron');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.message.length).toBeGreaterThan(0);
  });
});
