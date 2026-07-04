import parser from 'cron-parser';

/**
 * Next fire strictly after `from`. Wraps cron-parser (handles DST/timezones).
 */
export function nextRunAt(expr: string, from: Date, tz = 'UTC'): Date {
  return parser.parseExpression(expr, { currentDate: from, tz }).next().toDate();
}

export function isValidCron(expr: string): boolean {
  try {
    parser.parseExpression(expr);
    return true;
  } catch {
    return false;
  }
}

export type CronValidation = { valid: true } | { valid: false; message: string };

/** Like isValidCron, but surfaces cron-parser's own message (R27: an invalid
 *  cron expression should explain why, not just reject silently). */
export function validateCron(expr: string): CronValidation {
  try {
    parser.parseExpression(expr);
    return { valid: true };
  } catch (err) {
    return { valid: false, message: err instanceof Error ? err.message : String(err) };
  }
}
