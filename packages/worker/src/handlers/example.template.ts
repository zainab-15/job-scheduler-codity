/**
 * TEMPLATE — copy this file to write a new handler, then register it in
 * `handlers/index.ts` (buildDefaultRegistry). This is NOT a live handler
 * (its name is prefixed so it can never collide with a real one).
 *
 * 1. Define your payload shape with zod. The registry parses+validates the
 *    raw JSON payload against `payloadSchema` BEFORE handle() runs — a bad
 *    payload dead-letters cleanly (death_reason='invalid_payload') instead
 *    of throwing partway through your handler.
 * 2. `ctx.idempotencyKey` is STABLE across every retry/reclaim of this
 *    logical job (== payload.idempotencyKey ?? jobId). Use it — never
 *    `ctx.attempt` — to dedupe any side effect you perform.
 * 3. `ctx.once(key, fn)` dedupes fn() by key if the optional
 *    side_effect_ledger table exists; otherwise it's a passthrough (always
 *    calls fn()), so code written against it is safe either way.
 * 4. Call `ctx.heartbeat()` ONLY if a SINGLE step inside handle() will
 *    itself take longer than LEASE_MS — the worker's normal heartbeat loop
 *    already extends your lease every HEARTBEAT_INTERVAL_MS for anything
 *    shorter. Do not call it in a tight loop "just in case."
 * 5. Check/propagate `ctx.signal` so a graceful shutdown can actually
 *    cancel your in-flight work (pass it to any abortable I/O, e.g. fetch).
 */
import { z } from 'zod';
import type { JobHandler } from './registry.js';

const ExamplePayload = z.object({
  targetId: z.string(),
});

export const exampleTemplateHandler: JobHandler<z.infer<typeof ExamplePayload>> = {
  name: '__example_template', // never registered by default
  payloadSchema: ExamplePayload,
  async handle(ctx) {
    if (ctx.signal.aborted) throw new Error('aborted before start');
    await ctx.log('info', `processing ${ctx.payload.targetId}`);

    await ctx.once(`example:${ctx.idempotencyKey}`, async () => {
      // ... your side-effecting work goes here ...
    });

    await ctx.log('info', 'done');
  },
};
