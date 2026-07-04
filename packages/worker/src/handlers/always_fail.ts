import { z } from 'zod';
import type { JobHandler } from './registry.js';

const AlwaysFailPayload = z.object({}).passthrough();

/** Demo handler for the retry -> backoff -> DLQ path: fails on every attempt. */
export const alwaysFailHandler: JobHandler<z.infer<typeof AlwaysFailPayload>> = {
  name: 'always_fail',
  payloadSchema: AlwaysFailPayload,
  async handle(ctx) {
    await ctx.log('warn', `attempt ${ctx.attempt}/${ctx.maxAttempts} — failing on purpose (demo)`);
    throw new Error(`always_fail: intentional failure on attempt ${ctx.attempt}`);
  },
};
