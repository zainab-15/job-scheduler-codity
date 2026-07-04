import { z } from 'zod';
import type { JobHandler } from './registry.js';

const HttpFetchPayload = z.object({
  url: z.string().url(),
  method: z.enum(['GET', 'POST']).default('GET'),
});

export const httpFetchHandler: JobHandler<z.infer<typeof HttpFetchPayload>> = {
  name: 'http_fetch',
  payloadSchema: HttpFetchPayload,
  async handle(ctx) {
    await ctx.log('info', `fetching ${ctx.payload.method} ${ctx.payload.url}`);
    const res = await fetch(ctx.payload.url, { method: ctx.payload.method, signal: ctx.signal });
    if (!res.ok) throw new Error(`http_fetch: ${res.status} ${res.statusText}`);
    await ctx.log('info', `fetched ${ctx.payload.url}: ${res.status}`);
  },
};
