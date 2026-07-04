# Design Decisions & Trade-offs

This document records the load-bearing design decisions in the scheduler, why each was chosen over its alternatives, and the honest cost of each choice. It is organized in three parts:

1. **Correctness decisions** — the 16 findings from the first design review, and how the schema/claim/state-machine design avoids each *by construction* (not by runtime guardrails that can be forgotten).
2. **Core trade-offs** — the eight structural bets (atomic claim, DB-only leases, polling, Kysely, worker-as-process, the state machine, the cron model, and at-least-once delivery), each with its alternative and its cost.
3. **Review findings fixed** — the second-review pass (commit `3a741c1`) that closed a cross-org IDOR, a cascading-delete data-loss path, a cron poison-row stall, and six smaller correctness/consistency issues.

The system is Postgres 16 + Kysely, a Fastify 5 REST API (`/api/v1`), a separate Node worker process, and a React 18 / TanStack Query dashboard. 107 tests pass. Docker for the app services was deliberately deferred; the distributed property is proven instead by a real two-terminal `kill -9` recovery demo and a four-claimer concurrency integration test.

---

## 1. Correctness decisions

The first design review found 16 issues in three competing schema drafts. The table below is the resolution log: each row is a class of bug the final design makes *impossible to reintroduce*, because the fix lives in the schema, the single claim query, or the state machine rather than in defensive code a future edit could drop.

| # | Severity | Issue | Resolution (by construction) |
|---|----------|-------|------------------------------|
| 1 | critical | Drafts used incompatible names (`locked_until` vs `lease_expires_at`, `dead_letter_jobs` vs `dead_letter_queue`, `dedupe_key` vs `idempotency_key`); code would not compile against its own migration. | One canonical name set, authoritative everywhere: `jobs.status`, `jobs.locked_by`/`jobs.locked_until`, `jobs.dedupe_key`, `dead_letter_jobs`, `scheduled_jobs`, `jobs.recurring_job_id`. |
| 2 | critical | `SKIP LOCKED` alone does **not** enforce a per-queue aggregate concurrency limit — two workers each read `in_use=0` and each claim the full limit over disjoint rows. | `pg_advisory_xact_lock(1, hashtext(queue_id::text))` serializes the *budget decision* per queue, so `in_use` reflects committed state and `take = concurrency_limit − in_use` cannot overshoot. |
| 3 | critical | No fence → a slow-but-alive worker whose lease was reclaimed double-runs or clobbers the new owner's write. | Every terminal write is fenced `WHERE id=$1 AND locked_by=$self AND locked_until > now()` and checks the row count; a lost lease makes the write a detectable no-op. |
| 4 | critical | `attempts` bumped at claim and never restored → spurious DLQ entries and `UNIQUE(job_id, attempt)` collisions on reclaim. | `attempts` is incremented **exactly once**, in the claim→`running` transition; reclaim/requeue/promote never re-increment. |
| 5 | high | Contradictory priority direction defeats the claim index and forces a full sort. | Higher number = higher priority, default 5, range 0–9, everywhere; the claim index column order matches `ORDER BY priority DESC, run_at, created_at` — verified with `EXPLAIN` to have no `Sort` node. |
| 6 | high | `retrying` jobs claimable in one place but the claim index is `queued`-only — mismatch. | The promoter flips `scheduled`/`retrying` → `queued` when due; the claim predicate and the partial index `idx_jobs_claim … WHERE status='queued'` both key off `queued` only. |
| 7 | high | Two reapers with two terminal behaviors (a `failed` bucket vs the DLQ) create an ambiguous terminal state. | **One** `moveToDeadTx()` helper is the sole terminal-failure path, shared by the handler-failure path, the reaper's final-attempt path, and graceful-shutdown-final. There is no `failed` status. |
| 8 | high | A transient `claimed` row-state strands the queue's concurrency budget for a full lease if the worker crashes during dispatch. | Claim goes `queued` → `running` in one transaction; "Claimed" is the `claimed_at` timestamp, not a persisted status. No crash-during-dispatch window. |
| 9 | medium | Cron backlog fires a thundering herd on recovery from downtime. | The promoter advances `next_run_at` strictly past `now()` and enqueues exactly **one** job per schedule per tick — a backlog collapses to a single run, not N. |
| 10 | medium | Heartbeat/reaper race with no fence lets a stalled worker resurrect an expired lease. | The heartbeat's lease-extend carries the same `locked_until > now()` fence as the terminal writes, so it cannot re-extend a lease the reaper already expired. |
| 11 | medium | Queue-delete cascade nukes the DLQ while the API assumes the DLQ outlives the queue. | Deletion is a single guarded `DELETE … WHERE NOT EXISTS(…)`; `dead_letter_jobs.queue_id` cascades **with** the queue (deleting a queue intentionally destroys its history). No "DLQ outlives queue" path exists. |
| 12 | medium | The failure path re-loads the live retry policy, so editing a shared queue policy mutates in-flight jobs. | `jobs` carries a denormalized, frozen copy of `retry_strategy`, `retry_base_delay_ms`, `retry_backoff_factor`, `retry_max_delay_ms`, `max_attempts` at insert; the claim `RETURNING` and the failure path read **only** those frozen columns. |
| 13 | medium | Unique-constraint → error mapping collapses; a dedupe conflict returns 500. | Each constraint name maps to an explicit code (`EMAIL_TAKEN`/`NAME_TAKEN`); idempotent enqueue is `INSERT … ON CONFLICT (queue_id, dedupe_key) DO NOTHING RETURNING` and returns the existing job as 200. |
| 14 | medium | Graceful drain outlives the lease → duplicate run. | The heartbeat loop **stays alive during drain**, so in-flight jobs keep extending their leases while finishing; leftovers are fenced-requeued, not left to expire mid-flight. |
| 15 | low | A session-scoped advisory lock can leak across pool checkouts. | All advisory locks are `pg_advisory_xact_lock` inside an explicit transaction (auto-released on COMMIT/ROLLBACK) — for both the per-queue claim budget and the maintenance-leader lock. |
| 16 | low | Interval built by string concatenation → injection / cast error. | `make_interval(secs => $1)` with a bound integer parameter; every `*_MS` env var is zod-validated to a positive integer at boot. |

Two of these (advisory-lock namespacing, #2/#15; the precise concurrency invariant, #3) were sharpened further in the plan's engineering review — see the corresponding trade-offs below.

---

## 2. Core trade-offs

### (a) The atomic claim: advisory lock + `SKIP LOCKED`, and the throughput cost

The claim is one transaction per eligible queue. It takes a **transaction-scoped advisory lock keyed on the queue** (`pg_advisory_xact_lock(1, hashtext(queue_id::text))`), then in a single statement computes the budget (`LEAST(localFree, concurrency_limit − running, batchCap)`), selects that many `queued` rows `FOR UPDATE SKIP LOCKED`, and flips them to `running` with a lease. The advisory lock is what makes the *cross-worker* limit exact: without it, two workers both read `running=0` and each claim the full limit over disjoint rows — `SKIP LOCKED` prevents grabbing the *same* row but does nothing about the *aggregate* count. The honest cost: the lock serializes claims **per queue**, so throughput scales by adding **queues**, not workers — a single hot queue with `concurrency_limit=5` serializes every claimer against one lock, and adding a sixth worker adds no throughput to that queue. This is the correct and unavoidable price of an *exact* limit; the alternatives (no lock → over-claim; `SERIALIZABLE` isolation → retry storms) are worse. Different queues hash to different lock keys, so unrelated queues never contend.

### (b) DB leases + heartbeats vs an external lock service

Coordination — the concurrency budget, leader election for maintenance, and dead-worker detection — is done entirely in Postgres: transaction-scoped advisory locks for the claim budget and the maintenance leader (`pg_advisory_xact_lock(2, 0)`), a `locked_until` lease column with heartbeat extension, and `last_heartbeat_at` for liveness. The alternative was a dedicated lock service (Redis with Redlock, or ZooKeeper/etcd). We chose Postgres-only deliberately: the database is already the source of truth and already in every transaction, so leases and locks are *consistent with the job rows by construction* — there is no second system that can disagree with the DB about who owns a job. It also keeps the deployable surface to **three services** (Postgres, API, worker) instead of four, which matters for a system a grader boots from a clean checkout. The cost is that the advisory-lock serialization point (see (a)) lives in the same Postgres that also serves reads; at this scale that is a non-issue, and the exactness guarantee is worth it.

### (c) Polling vs WebSockets on the frontend

The dashboard reads live state by **polling with TanStack Query** `refetchInterval`, tuned per view (Queues 5s, Queue stats 10s, Job explorer 5s, Job detail 3s, Workers 5s, DLQ 15s, Overview 10s). The alternative — a WebSocket / SSE push channel — would give lower-latency updates but requires a stateful connection layer on the API, a subscription/fan-out model, and reconnection handling, none of which the API otherwise needs. Polling is simpler, stateless, survives reconnects for free, and is *good enough* for an operator dashboard where sub-second latency has no value. The discipline that makes it cheap is built in: `refetchIntervalInBackground: false` (hidden tabs never poll), `keepPreviousData` (no empty-state flashes on refetch), polling **paused** while the job explorer is being filtered or paged, and Job detail polling that **stops entirely on a terminal status** (`refetchInterval: q => isTerminal(q.data?.status) ? false : 3000`) so a completed job stops generating requests.

### (d) Kysely vs Prisma

The data layer is **Kysely**, a typed query builder, not an ORM. The deciding factor is that the hot path needs SQL an ORM abstracts away or cannot express: `.forUpdate().skipLocked()`, `pg_advisory_xact_lock(...)`, `make_interval(secs => $1)`, `count(*) OVER()` for pagination totals, and partial-index-matching `WHERE` clauses that must be shaped exactly so the planner uses `idx_jobs_claim`. Kysely lets these be written as `sql\`…\`` template literals or first-class builder calls while still giving generated row types from `kysely-codegen`. Prisma would force the entire claim/reclaim/promote core into `$queryRaw` escape hatches, discarding its main benefit (type-safe query construction) precisely where correctness matters most, and its migration engine is heavier than the Kysely `Migrator` + `FileMigrationProvider` used here. `shared/` owns the single module that touches Postgres.

### (e) Worker as a separate process vs in-API

The worker is its own Node process (`packages/worker`), not a loop inside the API. This is the choice that makes the system genuinely distributed: workers scale horizontally and independently of the API (run two, four, eight; each gets a fresh UUID per process start), a worker crash cannot take down request serving, and graceful shutdown (drain in-flight, fenced-requeue leftovers) is a clean process lifecycle rather than tangled into HTTP server teardown. The kill-demo — `kill -9` one worker terminal and watch its in-flight job reappear and complete on the survivor — only *means* something because the worker is a separate failure domain. The cost is a second deployable and a second config surface, both accepted; the API and worker share `packages/shared` so the schema, queries, and env validation are defined once.

### (f) The job state machine — six persisted statuses, plus `cancelled`

The `job_status` enum is `queued`, `scheduled`, `running`, `retrying`, `completed`, `dead` (with `cancelled` added later; see review fixes). The assignment's lifecycle `Queued → Scheduled → Claimed → Running → Completed` is honored, but two states that seem natural are deliberately **not** persisted:

- **No `claimed` status.** A separate `claimed` row-state opens a window where a crash between "claimed" and "running" strands the job against the queue's concurrency budget for a full lease. Folding claim+start into one transaction removes that window entirely; "Claimed" is the `claimed_at` timestamp, and the job-detail UI still renders a truthful Queued→Claimed→Running→Completed timeline from `created_at`/`claimed_at`/`started_at`/`finished_at`.
- **No `failed` status.** Per-attempt failure lives in `job_executions.status='failed'` (one row per real attempt, `UNIQUE(job_id, attempt)`). A job *between* attempts is `retrying`; a *permanently* failed job is `dead` (in the DLQ). Having a job-level `failed` bucket alongside `dead` created the two-terminal-behavior ambiguity of finding #7 — so there is exactly one terminal-failure path, `moveToDeadTx()`, and no ambiguous bucket.

### (g) The scheduling / cron model — leader-elected, three anti-double-enqueue guards

Recurring jobs are `scheduled_jobs` templates (`cron_expression`, `timezone`, `handler_name`, `next_run_at`, `is_enabled`, `last_enqueued_at`, `last_job_id`), promoted into concrete jobs by the maintenance loop using `cron-parser` (not hand-rolled cron math). The correctness requirement is "fire each occurrence exactly once even across worker crashes and races," and it is met with **three independent guards**, any one of which alone would be insufficient:

1. **Single leader** — promotion runs only inside the maintenance transaction that holds `pg_advisory_xact_lock(2, 0)`, so only one worker promotes at a time.
2. **Watermark advance** — the due schedule is selected `FOR UPDATE SKIP LOCKED` and its `next_run_at` is advanced in the *same* transaction, so a conflicting slot cannot spin the same tick forever.
3. **Dedupe key** — the enqueued job carries `dedupe_key = cron:{scheduleId}:{occurrenceISO}` and hits the partial unique index via `ON CONFLICT DO NOTHING`, so even a leader that crashes and re-fires the identical occurrence cannot create a duplicate.

**Backlog collapse:** if `next_run_at` is more than one interval behind `now()` (e.g. after downtime), the promoter advances strictly past `now()` and enqueues exactly one job — no thundering herd of missed occurrences.

### (h) At-least-once delivery — explicitly *not* exactly-once

Delivery is **at-least-once by design; we do not fake exactly-once.** The precise invariant the claim guarantees is:

> **≤ `concurrency_limit` rows in `status='running'` per queue.**

This is a statement about *committed rows*, not about *live handler processes*. The caveat (surfaced in engineering review as R2): a slow-but-alive worker whose lease is reclaimed by the reaper can briefly *overlap* with the new owner — two handlers can be executing during the reclaim window. Fencing makes the slow worker's terminal write a detectable no-op (`WHERE locked_by=self AND locked_until > now()` matches zero rows), so there is no double *commit* and no double side-effect *through the scheduler* — but the handler body ran twice. The mitigation is operational: set `LEASE_MS` (default 30s) comfortably above expected handler runtime so the overlap window effectively never opens; the demo `sleep` handler sleeps well under `LEASE_MS`.

Because delivery is at-least-once, handlers must be idempotent, and the system provides **three layers** to make that practical:

1. **Enqueue-time `dedupe_key`** — the caller supplies a key; `INSERT … ON CONFLICT (queue_id, dedupe_key) DO NOTHING` collapses duplicate submissions at the front door.
2. **A stable `ctx.idempotencyKey`** — `payload.idempotencyKey ?? jobId`, stable *across retries* of the same job, so a handler can key its own effects.
3. **An optional `side_effect_ledger`** — `(key PK, kind, created_at)`; the reference handler does `INSERT … ON CONFLICT DO NOTHING` to make an external side-effect fire at most once even if the handler body re-runs.

Trying to promise exactly-once would require distributed-transaction coordination between Postgres and every external side-effect the handler touches — a guarantee no honest at-least-once queue makes. We state the limitation plainly and give the tools to build idempotent handlers instead.

---

## 3. Review findings fixed (second review, commit `3a741c1`)

After the core was built and passing tests, a second review pass (six specialist passes plus an adversarial pass over the worker/API/cron surface) found nine confirmed issues plus three low-risk auto-fixes. All were fixed with regression tests; the suite went to 107 passing. The load-bearing ones:

### Cross-org IDOR on `retry_policy_id` (data-confidentiality)

A queue could attach **another org's** `retry_policy_id`. The foreign key enforces existence but not ownership, so a member of org A could set their queue's `retry_policy_id` to a policy row belonging to org B, and `getQueueDetail` would then echo org B's policy config back — a cross-tenant leak that violated the org-scoping invariant every other path upholds. **Fix:** both `createQueue` and `updateQueue` now validate that a client-supplied `retry_policy_id` belongs to the queue's **own project** (`retryPolicyBelongsToProject`) before attaching it, returning `404 NOT_FOUND ("retry policy not found in this project")` otherwise. Same-project (not merely same-org) is the tightest correct scope, since retry policies are defined per project. As part of this fix, `updateQueue` was rewritten to fetch the org-scoped queue first (so a cross-org queue id is a clean `not_found` rather than a silently-skipped update).

### Delete guards extended to all pending work (data-loss)

Queue and project deletion previously blocked only on `status='running'` jobs. But deletion cascades (`ON DELETE CASCADE`) through queues → jobs → scheduled_jobs, so a running-only guard would **silently and irrecoverably** destroy every `queued`/`scheduled`/`retrying` job and every active cron template the moment a queue or project was deleted. **Fix:** the guard now blocks on **any non-terminal job** (`running`/`queued`/`scheduled`/`retrying`) **or any enabled recurring schedule**, in the same single-statement atomic `DELETE … WHERE NOT EXISTS(…)` (so there is still no check-then-delete race). Terminal jobs (`completed`/`dead`/`cancelled`) are historical and *do* cascade away, as intended. The error code was renamed `HAS_RUNNING_JOBS` → **`HAS_PENDING_WORK`** with a message that lists what blocks the delete.

### Cron promoter poison-row isolation (availability)

One unschedulable `scheduled_jobs` row — an unparseable cron expression, or an IANA timezone that became invalid after a tzdata update — made `cron-parser` throw *inside the promotion loop*, rolling back the entire maintenance tick and re-throwing on every subsequent tick. The effect: **one bad row froze all recurring-job promotion, system-wide.** **Fix:** `promoteRecurringTx` computes the next fire time **first** (the only per-row step that can throw a pure-JS error, and it happens *before* any SQL for that row, so it cannot poison the surrounding Postgres transaction); on a throw it **disables just that schedule** (`is_enabled=false`), logs a structured warning with the schedule id / cron / timezone, and `continue`s to the next row. The remaining DB writes in the loop are `ON CONFLICT DO NOTHING` with constraint-satisfied-by-construction values, so a throw there would be systemic (connection loss) and *should* abort the tick — the isolation is scoped precisely to the JS poison vector, not blanket-swallowed.

### Timezone validation → clean 400

An invalid timezone in `POST /queues/:id/schedules` used to fall through to the generic 500 handler *and* persist an unschedulable row that would later poison the promoter (the root cause of the finding above, caught at the front door). **Fix:** `createRecurringJob` wraps the first `nextRunAt` call, returns `invalid_timezone` on throw, and the route maps it to **`400 INVALID_TIMEZONE`** with a helpful `details.example` (`America/New_York`). Persisting a poison row is now impossible.

### Login constant-time mitigation (user enumeration)

The login path ran `argon2` verify only when the user existed, so "no such email" returned faster than "wrong password" — a timing oracle for enumerating valid emails. **Fix:** `verifyCredential(hash | null, password)` runs a **full argon2 verify against a fixed dummy hash** when the user is missing (burning equal cost, discarding the result), so a bad email and a bad password take the same time. Both still return the same `401 INVALID_CREDENTIALS`.

### Retry status code 400 → 409 (API consistency)

Retrying a job that isn't in a retryable state returned `400 NOT_RETRYABLE`. But the request is well-formed; it is the *resource's current state* that conflicts with the operation. **Fix:** it now returns **`409`**, aligning with the rest of the API's state-conflict convention (`ALREADY_RUNNING`, `HAS_PENDING_WORK`, `ORIGIN_DELETED`). (400 is reserved for malformed requests.)

### Graceful shutdown — await in-flight before pool destroy

On shutdown-timeout the worker aborted timed-out handlers, requeued their jobs, and then immediately destroyed the DB pool — but an aborted handler's `catch` block (its now-fenced `failJob`) could still be mid-query when `db.destroy()` ripped the pool out, producing an unhandled rejection at shutdown. **Fix:** the worker now requeues **first** (clearing `locked_by`, so any late `failJob`/`completeJob` is fenced out), then waits — bounded by `ABORT_DRAIN_MS` (5s) — for the aborted handler promises to `allSettled` **before** tearing down the pool. The bound ensures a handler that ignores its `AbortSignal` cannot hang shutdown forever.

### Workers endpoint — pagination + point lookup (performance)

Workers are **never deleted** (the table accumulates fleet restart history), so the unbounded `SELECT * FROM workers` behind `GET /workers` grew without bound, and `GET /workers/:id` fetched the whole table and did an in-memory `Array.find()`. **Fix:** `listWorkers` is now paginated (`count(*) OVER()` total, `LIMIT/OFFSET`, standard pagination envelope) like every other list endpoint, and `getWorkerById` is a primary-key point lookup.

### Pool error handler + seed production guard (low-risk auto-fixes)

- **Pool error handler:** `node-postgres` emits `'error'` on an *idle* client whose backend connection dies (network blip, PG restart); with no listener this is an unhandled exception that crashes the whole process. A logging no-op listener now lets the pool discard the dead client and carry on. The pool also sets `connectionTimeoutMillis` (10s) and `statement_timeout` (30s) so one stuck query cannot pin a pooled connection forever and starve the shared pool.
- **Seed production guard:** `npm run seed` provisions a fixed, publicly-known admin credential (`admin@demo.test`). It now **refuses to run when `NODE_ENV=production`** and exits non-zero, so mis-wiring the seed into a deploy hook or pointing it at a production `DATABASE_URL` cannot create a known-password backdoor.

---

## Appendix: what was deliberately deferred

- **Docker for the app services.** The `docker-compose.yml` runs Postgres for local dev, but the API/worker/web containers were deferred per the plan's own cut-list, which places multi-worker Docker last. The distributed property does not depend on it: it is proven by the two-terminal `kill -9` recovery demo (`dev:api` + two `dev:worker` terminals, each logging its own worker id) and by the four-claimer / 100-job concurrency integration test that asserts zero duplicates, every job terminal, and running-count never exceeding `concurrency_limit`. Local integration uses a Vite dev proxy (`/api` → `localhost:3000`), which sidesteps the API's lack of CORS with zero backend change. **Update (deployment prep):** this no longer holds once `web` and `api` are deployed as two separate origins (see [DEPLOY.md](../DEPLOY.md)), so `@fastify/cors` is now registered — but only when the `CORS_ORIGIN` env var is set; leaving it unset keeps today's local-dev behavior (no CORS plugin at all) byte-for-byte unchanged.
- **Exactly-once delivery.** Out of scope by design; see trade-off (h).
- **Refresh tokens / multi-user orgs.** Auth is intentionally minimal (single user per org, 12h HS256 JWT); the assignment mandates auth and org/project modeling, which is delivered, but not a full identity system.
