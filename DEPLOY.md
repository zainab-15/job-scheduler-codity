# Deploying to Railway + Supabase

No Docker anywhere in this path. Railway builds straight from source (Nixpacks),
and Supabase is a fully managed Postgres — `docker-compose.yml` in this repo
stays local-dev-only (it spins up Postgres for `npm run db:up`) and is
unrelated to this guide.

## What you're deploying

One Supabase Postgres, and **3 Railway services** built from this same repo —
each service points at its own config-as-code file so the monorepo's shared
build step (`@scheduler/shared` must compile before `api`/`worker`/`web`) is
explicit rather than guessed by Railway:

| Service | Config file | Type | Always-on? |
|---|---|---|---|
| `api` | [railway.api.json](railway.api.json) | HTTP (Fastify) | Yes — stateless, can scale horizontally |
| `worker` | [railway.worker.json](railway.worker.json) | Background process | **Required** — holds leader-election locks; can't sleep-on-idle |
| `web` | [railway.web.json](railway.web.json) | Static SPA (served by `serve`) | Yes |

For each Railway service: **Root Directory stays `/`** (repo root) — don't
point it at `packages/api`, or npm workspace resolution breaks. Instead, set
**Settings → Config-as-code → Config File Path** to that service's
`railway.*.json`.

## 1. Supabase: create the project

Create a project at supabase.com. Under **Project Settings → Database** you'll
get two connection strings — you need both, for different things:

- **Direct** (port `5432`) — use this once, for the migration in step 2.
- **Pooled / "Transaction" mode** (port `6543`, PgBouncer) — use this for the
  `api` and `worker` services' `DATABASE_URL` at runtime.

This split matters here specifically: every advisory lock in this codebase
(`packages/shared/src/queries/*.ts`) uses the transaction-scoped
`pg_advisory_xact_lock`/`pg_try_advisory_xact_lock`, which is the one lock
flavor that's safe under PgBouncer's transaction pooling (session-scoped locks
are not — see [docs/design-decisions.md](docs/design-decisions.md), trade-off
15). So the pooled connection is safe to use for runtime traffic, not just a
performance nicety.

Both connection strings need `PGSSL=true` (see below) — Supabase requires TLS,
and this repo's pool wasn't configured for it until this change
([packages/shared/src/db/pool.ts](packages/shared/src/db/pool.ts)).

## 2. Run the migration once, from your machine

```bash
DATABASE_URL="<supabase DIRECT connection string>" PGSSL=true npm run migrate
```

This applies migrations 001–003 and only needs to happen once (and again for
any future migration you add). Do **not** run this against the pooled (6543)
connection — DDL is safer on the direct one.

### Optional: seed demo data now, from your machine

`npm run seed` refuses to run when `NODE_ENV=production`
([design-decisions.md](docs/design-decisions.md), "Seed production guard") —
deliberately, so it can never become a deploy-hook backdoor. That guard checks
`NODE_ENV`, not where `DATABASE_URL` points, so you can still seed your real
Supabase database safely by running it locally, before you set
`NODE_ENV=production` on the Railway services themselves:

```bash
DATABASE_URL="<supabase DIRECT connection string>" PGSSL=true npm run seed -w @scheduler/api
```

This prints the demo login (`admin@demo.test` / `demo12345678`) and seeds the
three demo queues + in-flight jobs described in the README — useful for a live
demo, skip it if you want a clean instance.

## 3. Railway: create the 3 services

One Railway project, three services, all from this GitHub repo:

For **every** service, set these shared variables:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Supabase **pooled** (6543) connection string |
| `PGSSL` | `true` |
| `NODE_ENV` | `production` |
| `LOG_LEVEL` | `info` |

`api`-specific:

| Variable | Value |
|---|---|
| `JWT_SECRET` | A real random 32+ char secret (**not** the `.env.example` placeholder) |
| `CORS_ORIGIN` | The `web` service's Railway URL (see step 4 — chicken-and-egg, deploy web first) |

`web` has no server-side env vars to set on Railway — its config is baked in
at **build** time (see step 4).

`worker` needs nothing else beyond the shared table; its tuning knobs
(`POLL_INTERVAL_MS`, `LEASE_MS`, etc.) already default sanely from
`.env.example` and only need overriding if you want to.

Railway injects `PORT` automatically for `api` and `web`; both already read it
(`packages/api/src/index.ts`, and `serve -l $PORT` in
[packages/web/package.json](packages/web/package.json)).

## 4. Wire up CORS_ORIGIN ↔ VITE_API_URL

`web` and `api` land on two different Railway URLs, so this needs one pass in
this order:

1. Deploy `api` first. Copy its public Railway URL.
2. Set `web`'s build to bake in `VITE_API_URL=https://<api-url>/api/v1`
   (Railway → `web` service → Variables — Vite inlines `VITE_`-prefixed vars
   **at build time**, so this must be set before `web` builds, not just at
   runtime). Deploy `web`. Copy its public Railway URL.
3. Set `CORS_ORIGIN=https://<web-url>` on the `api` service and redeploy it.

Until step 3, the API will reject the dashboard's requests with a CORS error
— that's expected in between steps 1 and 3, not a bug.

## 5. Verify it's live

```bash
curl https://<api-url>/api/v1/health
# {"status":"ok","db":"up"}
```

Then open the `web` URL, log in with the seeded demo account (or register a
fresh one), and open Swagger at `https://<api-url>/docs`.

---

## Before you demo it live: two gotchas

- **Supabase pauses free-tier projects after 7 days of inactivity** (~30s cold
  wake on the next request). If there's a gap between setting this up and
  demo day, hit `/api/v1/health` a few minutes before you go live.
- **Railway's worker can't sleep-on-idle** — it's holding leader-election
  locks continuously by design, so budget for the paid Hobby tier
  (not the trial credit) if the demo is more than ~30 days out.

## Cost

Railway: ~$5/mo (Hobby plan) covering all three services at demo-level
traffic. Supabase: free tier is enough for this (small dataset, low QPS) —
upgrade only if you want to remove the pause-after-inactivity behavior.
