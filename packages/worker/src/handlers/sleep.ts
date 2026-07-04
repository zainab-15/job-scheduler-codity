import { z } from 'zod';
import type { JobHandler } from './registry.js';

const SleepPayload = z.object({ ms: z.number().int().positive().default(1000) });

/**
 * Demo/kill-target handler: sleeps for `payload.ms` (default 1s). The money
 * demo (§17 Verify-2A) uses a long sleep (e.g. 60000) so killing either
 * worker terminal in the 2-terminal manual demo reclaims something without
 * needing to identify which terminal actually owned the job.
 */
export const sleepHandler: JobHandler<z.infer<typeof SleepPayload>> = {
  name: 'sleep',
  payloadSchema: SleepPayload,
  async handle(ctx) {
    await ctx.log('info', `sleeping for ${ctx.payload.ms}ms`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ctx.payload.ms);
      ctx.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('sleep aborted'));
      });
    });
    await ctx.log('info', 'woke up');
  },
};
