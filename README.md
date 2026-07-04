# job-scheduler

A distributed job scheduler. N independent worker processes execute jobs concurrently with **PostgreSQL as the only shared state** — there is no broker, no Redis, no coordinator process. Workers claim work atomically with `SELECT ... FOR UPDATE SKIP LOCKED` guarded by a per-queue `pg_advisory_xact_lock`, so a queue's `concurrency_limit` is never exceeded even under concurrent claimers. Every claim takes a time-bounded **lease**; the executing worker renews it via **heartbeats**, and all terminal writes are **fenced** (`WHERE locked_by = me AND locked_until > now()`) so a stalled or crashed worker's late write is a silent no-op. If a lease expires, a reaper **reclaims** the job back to `queued` and another worker finishes it — exactly once. On top of the core: bounded **retries** with configurable backoff to a **dead-letter queue**, **cron** schedules (delayed / scheduled / recurring jobs), a JWT-authenticated org-scoped **REST API** (Fastify), and a **React dashboard**.

## Architecture at a glance

Four npm workspaces under `packages/*`:

| Workspace | Package | Role |
|-----------|---------|------|
| `shared` | `@scheduler/shared` | Postgres schema (Kysely migrations) + the atomic-claim / lease / fence / retry / promote / reclaim query core. The single source of truth every process imports. |
| `worker` | `@scheduler/worker` | The long-running worker: poll loop, heartbeat renewal, maintenance loop (leader-gated promote/reclaim + cron), handler registry, graceful shutdown. |
| `api` | `@scheduler/api` | Fastify 5 REST API under `/api/v1`, JWT + argon2id auth, org-scoped multi-tenancy, Swagger docs, the `seed` script. |
| `web` | `@scheduler/web` | React 18 + Vite dashboard (TanStack Query, React Router, Recharts). Talks to the API same-origin via a dev proxy. |

More detail: [docs/architecture.md](docs/architecture.md) · [docs/er-diagram.md](docs/er-diagram.md) · [docs/design-decisions.md](docs/design-decisions.md) · [docs/api-curl-walkthrough.md](docs/api-curl-walkthrough.md) · [DEPLOY.md](DEPLOY.md)

## Prerequisites

- **Node 22** (`.nvmrc` pins it; the root `package.json` enforces `>=22`)
- **Docker** — only for local dev's Postgres 16 container (`docker compose`); not used anywhere in deployment, see below
- **npm** (workspaces; ships with Node)

## Quick start

```bash
cp .env.example .env      # defaults work out of the box against the compose Postgres
npm install               # installs all four workspaces
npm run db:up             # docker compose up -d postgres  (Postgres 16, port 5432)
npm run migrate           # applies migrations 001–003
npm run seed              # provisions demo data; PRINTS the login on its own stdout
```

`npm run seed` prints a ready-to-use account:

```
Login:    admin@demo.test / demo12345678
```

It also creates a project with three queues of differing `concurrency_limit` (`fast-queue`=2, `slow-queue`=5, `flaky-queue`=3) and a handful of in-flight demo jobs (including a 60s `sleep` on `slow-queue` — the kill/reclaim target). The script is idempotent for the account/project/queues and additive for the demo jobs, so re-running it is safe.

Then, in **three separate terminals**:

```bash
npm run dev:api      # API on http://localhost:3000
npm run dev:worker   # a worker process
npm run dev:web      # dashboard on http://localhost:5173
```

Open **http://localhost:5173**. The Vite dev server proxies `/api` → the API on `:3000`, so the frontend is same-origin. **The dashboard needs the API and at least one worker running** — the API only enqueues and reports; workers are what actually execute jobs.

## Prove it's distributed (2-terminal kill demo)

This is the whole point of the design. Copy-paste:

```bash
# terminal 1
npm run dev:worker
# terminal 2  — a SECOND worker
npm run dev:worker
# terminal 3  — enqueue a job that outlives one lease window (60s > LEASE_MS default 30s)
BASE=http://localhost:3000
TOKEN=$(curl -s -X POST $BASE/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"admin@demo.test","password":"demo12345678"}' | jq -r .token)
# grab a queue id (the seeded slow-queue), then enqueue a 60s sleep
QUEUE_ID=$(curl -s "$BASE/api/v1/projects" -H "authorization: Bearer $TOKEN" \
  | jq -r '.data[0].id' | xargs -I{} curl -s "$BASE/api/v1/projects/{}/queues" \
  -H "authorization: Bearer $TOKEN" | jq -r '.data[] | select(.name=="slow-queue").id')
JOB=$(curl -s -X POST $BASE/api/v1/queues/$QUEUE_ID/jobs -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"type":"immediate","handler_name":"sleep","payload":{"ms":60000}}' | jq -r .id)
```

(Or just enqueue the 60s sleep from the queue page in the dashboard UI.)

Find whichever worker terminal logs that it **claimed** the job, then **`kill -9`** that process (or `Ctrl-C` it — the demo works either way). Poll the job:

```bash
curl -s $BASE/api/v1/jobs/$JOB -H "authorization: Bearer $TOKEN" \
  | jq '.job.status, .job.locked_by'
```

Within about **one `LEASE_MS` + `RECLAIM_INTERVAL_MS`** (defaults ≈ 30s + 5s) it flips back to `queued`, gets re-claimed by the surviving worker, and completes there. **Exactly once — no loss, no duplicate.**

**Why this works:**

1. The dead worker held a **lease** (`locked_until = now() + LEASE_MS`). It stopped sending heartbeats, so the lease is never renewed.
2. Once `locked_until` passes, the surviving worker's **maintenance/reclaim loop** (every `RECLAIM_INTERVAL_MS`) finds the row (`status = 'running' AND locked_until < now()`) and resets it to `queued` with `locked_by = NULL`.
3. The survivor **re-claims** it on its next poll and runs it to completion.
4. If the killed process were somehow only *paused* (not dead) and woke up to write its result, that write is **fenced**: every terminal update carries `WHERE locked_by = <me> AND locked_until > now()`. Its lease has expired and the row now belongs to another worker, so the stale write matches **zero rows** and is a no-op. No double completion is possible.

## Testing

```bash
npm test          # unit tests (pure domain logic — backoff, cron, lifecycle)
npm run test:int  # integration tests — needs the compose Postgres up (npm run db:up)
```

**107 tests: 20 unit + 87 integration.** The integration suite runs against a real Postgres (`scheduler_test` DB, provisioned by the compose init script) and includes:

- The flagship **concurrency proof** ([`claim-concurrency.int.test.ts`](packages/shared/test/claim-concurrency.int.test.ts)): 4 workers drain 100 jobs with **zero duplicates**, plus a negative control that runs the *identical* claim SQL **without** the advisory lock and demonstrates it over-admits past `concurrency_limit` — proving the lock is load-bearing, not decoration.
- The **kill-recovery test** ([`kill-recovery.int.test.ts`](packages/worker/test/kill-recovery.int.test.ts)) and **fencing/reclaim** tests, which assert the recovery path above at the query level.

## API docs

- **Swagger UI: http://localhost:3000/docs** — generated from the route schemas, unauthenticated, browsable.
- **[docs/api-curl-walkthrough.md](docs/api-curl-walkthrough.md)** — a copy-paste `curl` walkthrough of every endpoint: register/login, projects/queues, all job types (immediate / delayed / scheduled / batch / recurring cron), watch-a-job-complete, retry → backoff → DLQ → requeue, cancel, and metrics/health.

## Deployment

Runs on **Railway (api + worker + web) + Supabase (Postgres)** with zero
Docker involved — Railway builds directly from source. Full step-by-step
guide, env vars, and the two live-demo gotchas worth knowing about in advance:
**[DEPLOY.md](DEPLOY.md)**.

## Limitations / out of scope

Honest boundaries, kept deliberately:

- **Docker compose runs Postgres only, in local dev.** The app services (API, workers, web) run via npm scripts, not containers — in local dev *and* in production (see [DEPLOY.md](DEPLOY.md)). This is intentional — the kill demo above proves the distributed property with real OS processes and `kill -9`, which is more convincing than container orchestration would be here. Multi-worker distribution needs nothing more than running `npm run dev:worker` in more than one terminal (or on more than one host pointed at the same `DATABASE_URL`).
- **Single user per org.** No RBAC, roles, or team invites — one account owns one organization.
- **No auth refresh tokens.** Login returns a single JWT; when it expires you log in again.
- **No rate limiting** on the API.
- **At-least-once delivery**, documented — not exactly-once *delivery*. The lease/fence machinery guarantees a job is never *committed as completed* twice, and the reference handlers are safe to re-run; a handler that performs external side effects should be written to tolerate re-execution.
