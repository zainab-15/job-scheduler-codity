# API curl walkthrough

Every command below was run against a live `npm run dev:api` + `npm run dev:worker`
during development — copy-paste them as-is. Uses `jq` for readability; drop the
`| jq` if you don't have it installed.

Prereqs: `npm run db:up && npm run migrate` (once), then in separate terminals:
`npm run dev:api` and `npm run dev:worker` (run the worker in 2 terminals to see
the concurrency/kill-recovery story). `BASE=http://localhost:3000` below.

## 1. Register + login

```bash
BASE=http://localhost:3000

curl -s -X POST $BASE/api/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"password1234","org_name":"My Org"}' | jq

# Register returns a token directly; login is the same shape for a returning user.
TOKEN=$(curl -s -X POST $BASE/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"password1234"}' | jq -r .token)

curl -s $BASE/api/v1/auth/me -H "authorization: Bearer $TOKEN" | jq
```

Or skip straight to a pre-seeded account: `npm run seed` prints a ready-made
`admin@demo.test` login (with a project, 3 queues of differing
`concurrency_limit`, and a handful of demo jobs already in flight) on its own
stdout.

## 2. Create a project and a queue

```bash
PROJECT_ID=$(curl -s -X POST $BASE/api/v1/projects \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Demo Project"}' | jq -r .id)

QUEUE_ID=$(curl -s -X POST $BASE/api/v1/projects/$PROJECT_ID/queues \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"emails","concurrency_limit":2,"priority":7}' | jq -r .id)

curl -s $BASE/api/v1/queues/$QUEUE_ID -H "authorization: Bearer $TOKEN" | jq
```

## 3. Create each of the 4 job types

`POST /api/v1/queues/:queueId/jobs` is a discriminated union on `type`. Every
type requires `handler_name`; the reference handlers registered by the worker
are `sleep`, `http_fetch`, and `always_fail` (see
[`packages/worker/src/handlers/`](../packages/worker/src/handlers/)).

```bash
# immediate — runs as soon as a worker has a free slot
curl -s -X POST $BASE/api/v1/queues/$QUEUE_ID/jobs \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"type":"immediate","handler_name":"sleep","payload":{"ms":1000}}' | jq

# delayed — run_at = now() + delay_seconds
curl -s -X POST $BASE/api/v1/queues/$QUEUE_ID/jobs \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"type":"delayed","handler_name":"sleep","payload":{"ms":1000},"delay_seconds":30}' | jq

# scheduled — run_at = an explicit future timestamp (a past one is a 400)
curl -s -X POST $BASE/api/v1/queues/$QUEUE_ID/jobs \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"type":"scheduled","handler_name":"sleep","payload":{"ms":1000},"scheduled_at":"2026-12-31T00:00:00Z"}' | jq

# batch — up to 500 items in one call; response reports created vs. deduped separately
curl -s -X POST $BASE/api/v1/queues/$QUEUE_ID/jobs/batch \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"handler_name":"sleep","items":[{"payload":{"ms":100}},{"payload":{"ms":200}}]}' | jq
```

> `recurring` is deliberately **not** one of these branches — a cron template
> is a different resource (`POST /queues/:queueId/schedules`), not a job.
> Posting `"type":"recurring"` here gets a clean
> `{"error":{"code":"INVALID_JOB_TYPE", ...}}`, not a raw Ajv blob.

```bash
# recurring — a cron TEMPLATE, not a job; the worker's maintenance loop spawns
# one occurrence per due tick (visible as type=recurring on the jobs list).
curl -s -X POST $BASE/api/v1/queues/$QUEUE_ID/schedules \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"handler_name":"sleep","payload":{"ms":1},"cron":"*/15 * * * *","timezone":"UTC"}' | jq
# -> {"scheduled_job_id":"...","next_run_at":"...","cron":"*/15 * * * *","timezone":"UTC"}

# an invalid cron surfaces cron-parser's own message + a valid example (R27), not a raw Ajv blob
curl -s -X POST $BASE/api/v1/queues/$QUEUE_ID/schedules \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"handler_name":"sleep","cron":"not a cron"}' | jq
```

## 4. Watch a job complete, then inspect it

```bash
JOB_ID=$(curl -s -X POST $BASE/api/v1/queues/$QUEUE_ID/jobs \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"type":"immediate","handler_name":"sleep","payload":{"ms":500}}' | jq -r .id)

sleep 2  # give a running worker time to claim + finish it

curl -s $BASE/api/v1/jobs/$JOB_ID -H "authorization: Bearer $TOKEN" | jq
# -> { "job": {"status":"completed", ...}, "executions": [...], "logs": [...] }
```

## 5. Retry -> backoff -> DLQ, then requeue

```bash
FAIL_JOB=$(curl -s -X POST $BASE/api/v1/queues/$QUEUE_ID/jobs \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"type":"immediate","handler_name":"always_fail","payload":{}}' | jq -r .id)

sleep 8  # 3 attempts, exponential backoff (default policy) -> lands in the DLQ

curl -s $BASE/api/v1/jobs/$FAIL_JOB -H "authorization: Bearer $TOKEN" | jq '.job.status, .job.death_reason'

DLQ_ID=$(curl -s "$BASE/api/v1/queues/$QUEUE_ID/dead-letter" -H "authorization: Bearer $TOKEN" | jq -r '.data[0].id')
curl -s -X POST $BASE/api/v1/dead-letter/$DLQ_ID/requeue -H "authorization: Bearer $TOKEN" | jq
```

## 6. Cancel a queued job

```bash
CANCEL_JOB=$(curl -s -X POST $BASE/api/v1/queues/$QUEUE_ID/jobs \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"type":"delayed","handler_name":"sleep","payload":{},"delay_seconds":3600}' | jq -r .id)

curl -s -X POST $BASE/api/v1/jobs/$CANCEL_JOB/cancel -H "authorization: Bearer $TOKEN" | jq
# -> {"id":"...","status":"cancelled"}  — never lands in the DLQ
```

## 7. Metrics, health, and API docs (no token needed for the last two)

```bash
curl -s $BASE/api/v1/metrics/overview -H "authorization: Bearer $TOKEN" | jq
curl -s $BASE/api/v1/health | jq
open $BASE/docs   # Swagger UI, generated from the route schemas
```

## Distributed proof: kill a worker mid-job, watch another one finish it

```bash
# terminal 1
npm run dev:worker
# terminal 2
npm run dev:worker
# terminal 3: enqueue something that outlives one lease window (LEASE_MS, default 30s)
curl -s -X POST $BASE/api/v1/queues/$QUEUE_ID/jobs \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"type":"immediate","handler_name":"sleep","payload":{"ms":60000}}' | jq -r .id
# find whichever worker terminal logs "job claimed" for that id, Ctrl-C (or kill -9) IT
# poll the job: it flips back to `queued` (its lease expired), gets re-claimed by
# the survivor within one RECLAIM_INTERVAL_MS tick (default 5s), and completes there —
# exactly once, never twice.
curl -s $BASE/api/v1/jobs/<job-id> -H "authorization: Bearer $TOKEN" | jq '.job.status, .job.locked_by, .executions | length'
```
