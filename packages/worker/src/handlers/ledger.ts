/**
 * ctx.once(key, fn) — the idempotency helper handlers are told to use for any
 * side effect that must not double-run under at-least-once delivery.
 *
 * The optional `side_effect_ledger` table (key text PRIMARY KEY, kind text,
 * created_at timestamptz — INSERT ... ON CONFLICT DO NOTHING, only call fn()
 * if the insert happened) was cut from Day-1 scope (spec §11/R31: lowest
 * rubric ROI, first thing cut if short on time). Until it exists, `once` is a
 * PASSTHROUGH — it always calls fn(). Handlers written against `ctx.once`
 * compile and run unchanged whether or not the ledger table is ever added;
 * adding it later means swapping this one function's body, not touching any
 * handler.
 */
export async function once<R>(_key: string, fn: () => Promise<R>): Promise<R> {
  return fn();
}
