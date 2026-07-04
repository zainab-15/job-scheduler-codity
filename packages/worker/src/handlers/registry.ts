import type { ZodType, ZodTypeDef } from 'zod';

/**
 * `payload` is typed T, not `Record<string,unknown>` (D2-DX-1): the registry
 * (see executor.ts) zod-parses the raw job payload against the handler's own
 * `payloadSchema` BEFORE calling handle(), so a malformed payload dead-letters
 * cleanly (death_reason='invalid_payload') instead of throwing inside the
 * handler body.
 */
export interface JobContext<T = unknown> {
  jobId: string;
  /** 1-based attempt number for THIS execution. Do NOT use for idempotency — it
   *  differs across retries; use `idempotencyKey` instead. */
  attempt: number;
  maxAttempts: number;
  payload: T;
  /** Stable across every retry/reclaim of this logical job (== payload.idempotencyKey ?? jobId). */
  idempotencyKey: string;
  /** Fires on graceful shutdown (drain timeout) or a lost lease's abort. */
  signal: AbortSignal;
  log: (level: 'info' | 'warn' | 'error', message: string) => Promise<void>;
  /** Call ONLY for a single step that will itself exceed LEASE_MS — the worker's
   *  normal heartbeat loop already extends the lease every HEARTBEAT_INTERVAL_MS
   *  for anything shorter; this is not a substitute for that loop. */
  heartbeat: () => Promise<void>;
  /** Idempotency helper: dedupe fn() by key if the optional side_effect_ledger
   *  table exists; a passthrough (always calls fn()) if it doesn't (R31 cut). */
  once: <R>(key: string, fn: () => Promise<R>) => Promise<R>;
}

export interface JobHandler<T = unknown> {
  readonly name: string;
  /** If present, the registry parses+validates payload against this schema
   *  before handle() runs. Strongly recommended — see handlers/example.template.ts.
   *  Input is deliberately loose (`any`): a schema using `.default()` has
   *  Input != Output (a default-backed field is optional on input, guaranteed
   *  present on output) — we only care that parsing PRODUCES T. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly payloadSchema?: ZodType<T, ZodTypeDef, any>;
  handle(ctx: JobContext<T>): Promise<void>;
}

export class HandlerRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handlers = new Map<string, JobHandler<any>>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(handler: JobHandler<any>): void {
    if (this.handlers.has(handler.name)) {
      throw new Error(`duplicate handler registered: "${handler.name}"`);
    }
    this.handlers.set(handler.name, handler);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(name: string): JobHandler<any> | undefined {
    return this.handlers.get(name);
  }
}
