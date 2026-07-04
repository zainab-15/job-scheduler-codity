import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useCreateJob, useCreateSchedule, useQueue, useQueueStats, type CreateJobBody } from '../api/hooks';
import { QueryState } from '../components/QueryState';
import { SaturationBar } from '../components/SaturationBar';
import { Button, Card, Field, PageHeader, inputClass } from '../components/ui';
import { JOB_STATUS_STYLE } from '../lib/status';
import { formatDuration } from '../lib/format';
import type { QueueDetail, QueueStatsResult } from '../api/types';

const HANDLERS = ['sleep', 'http_fetch', 'always_fail'];

function parsePayload(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Payload must be a JSON object');
  return parsed as Record<string, unknown>;
}

/** Local "now + 1 min" as a datetime-local value (YYYY-MM-DDTHH:mm). Used as
 *  the input's `min` so a user can't pick a past instant that the API rejects. */
function minDatetimeLocal(): string {
  const d = new Date(Date.now() + 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function CreateJobForm({ queueId }: { queueId: string }) {
  const create = useCreateJob(queueId);
  const [type, setType] = useState<CreateJobBody['type']>('immediate');
  const [handler, setHandler] = useState('sleep');
  const [payload, setPayload] = useState('{ "ms": 1000 }');
  const [priority, setPriority] = useState(5);
  const [delaySeconds, setDelaySeconds] = useState(30);
  const [scheduledAt, setScheduledAt] = useState('');
  const [payloadError, setPayloadError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setPayloadError(null);
    let parsed: Record<string, unknown>;
    try {
      parsed = parsePayload(payload);
    } catch (err) {
      setPayloadError(err instanceof Error ? err.message : 'Invalid JSON');
      return;
    }
    const body: CreateJobBody = { type, handler_name: handler, payload: parsed, priority };
    if (type === 'delayed') body.delay_seconds = delaySeconds;
    if (type === 'scheduled') {
      // The API rejects a non-future scheduled_at with a 400 (jobs.ts). Guard
      // client-side so a near-now datetime-local pick surfaces inline here,
      // not as an opaque toast after the round trip. (datetime-local is
      // local wall-clock; new Date() interprets it locally -> correct UTC.)
      const at = new Date(scheduledAt);
      if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) {
        setPayloadError('Scheduled time must be in the future.');
        return;
      }
      body.scheduled_at = at.toISOString();
    }
    create.mutate(body);
  }

  return (
    <Card>
      <h2 className="mb-3 text-sm font-medium text-slate-700">Enqueue a job</h2>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">
            <select value={type} onChange={(e) => setType(e.target.value as CreateJobBody['type'])} className={inputClass}>
              <option value="immediate">immediate</option>
              <option value="delayed">delayed</option>
              <option value="scheduled">scheduled</option>
            </select>
          </Field>
          <Field label="Handler">
            <input list="handlers" value={handler} onChange={(e) => setHandler(e.target.value)} className={inputClass} />
            <datalist id="handlers">
              {HANDLERS.map((h) => (
                <option key={h} value={h} />
              ))}
            </datalist>
          </Field>
        </div>
        {type === 'delayed' && (
          <Field label="Delay (seconds)">
            <input type="number" min={1} value={delaySeconds} onChange={(e) => setDelaySeconds(+e.target.value)} className={inputClass} />
          </Field>
        )}
        {type === 'scheduled' && (
          <Field label="Run at (future)">
            <input
              type="datetime-local"
              required
              min={minDatetimeLocal()}
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
              className={inputClass}
            />
          </Field>
        )}
        <Field label="Priority (0–9)">
          <input type="number" min={0} max={9} value={priority} onChange={(e) => setPriority(+e.target.value)} className={inputClass} />
        </Field>
        <Field label="Payload (JSON)">
          <textarea value={payload} onChange={(e) => setPayload(e.target.value)} rows={3} className={`${inputClass} font-mono`} />
        </Field>
        {payloadError && <div className="text-xs text-red-600">{payloadError}</div>}
        <Button type="submit" variant="primary" disabled={create.isPending}>
          Enqueue
        </Button>
        <p className="text-xs text-slate-400">Try handler <span className="font-mono">always_fail</span> to watch retry → dead-letter.</p>
      </form>
    </Card>
  );
}

function CreateScheduleForm({ queueId }: { queueId: string }) {
  const create = useCreateSchedule(queueId);
  const [handler, setHandler] = useState('sleep');
  const [cron, setCron] = useState('*/15 * * * *');
  const [timezone, setTimezone] = useState('UTC');

  return (
    <Card>
      <h2 className="mb-3 text-sm font-medium text-slate-700">New recurring schedule</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate({ handler_name: handler, cron, timezone: timezone || undefined });
        }}
        className="space-y-3"
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Handler">
            <input list="handlers" value={handler} onChange={(e) => setHandler(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Timezone (IANA)">
            <input value={timezone} onChange={(e) => setTimezone(e.target.value)} className={inputClass} placeholder="UTC" />
          </Field>
        </div>
        <Field label="Cron expression">
          <input required value={cron} onChange={(e) => setCron(e.target.value)} className={`${inputClass} font-mono`} />
        </Field>
        <Button type="submit" variant="primary" disabled={create.isPending}>
          Create schedule
        </Button>
        <p className="text-xs text-slate-400">e.g. <span className="font-mono">*/15 * * * *</span> = every 15 minutes.</p>
      </form>
    </Card>
  );
}

function StatsCard({ stats }: { stats: QueueStatsResult }) {
  const counts = stats.counts;
  const entries = Object.entries(counts) as Array<[keyof typeof counts, number]>;
  return (
    <Card>
      <h2 className="mb-3 text-sm font-medium text-slate-700">Stats (last {stats.window_hours}h)</h2>
      <div className="grid grid-cols-3 gap-2 text-center">
        {entries.map(([status, n]) => (
          <div key={status} className="rounded border border-slate-200 py-1.5">
            <div className="tabular-nums text-lg font-semibold" style={{ color: JOB_STATUS_STYLE[status as keyof typeof JOB_STATUS_STYLE]?.hex }}>
              {n}
            </div>
            <div className="text-xs capitalize text-slate-500">{status}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs text-slate-600">
        <div>
          <div className="font-semibold text-emerald-600">{stats.completed_in_window}</div>
          completed
        </div>
        <div>
          <div className="font-semibold text-red-600">{stats.failed_in_window}</div>
          failed
        </div>
        <div>
          <div className="font-semibold">{formatDuration(stats.avg_duration_ms)}</div>
          avg duration
        </div>
      </div>
    </Card>
  );
}

function ConfigCard({ q }: { q: QueueDetail }) {
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-slate-700">Configuration</h2>
        {q.is_paused && <span className="rounded bg-amber-500 px-1.5 py-0.5 text-xs font-semibold text-white">PAUSED</span>}
      </div>
      <dl className="space-y-2 text-sm">
        <div className="flex justify-between">
          <dt className="text-slate-500">Concurrency</dt>
          <dd>
            <SaturationBar running={q.stat_running} limit={q.concurrency_limit} />
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-slate-500">Priority</dt>
          <dd className="tabular-nums">{q.priority}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-slate-500">Retry policy</dt>
          <dd className="text-right">
            {q.retry_policy ? (
              <span className="font-mono text-xs">
                {q.retry_policy.strategy}, base {q.retry_policy.base_delay_ms}ms ×{Number(q.retry_policy.backoff_factor)}, max {q.retry_policy.max_attempts} attempts
              </span>
            ) : (
              <span className="text-xs text-slate-400">default (exponential, 3 attempts)</span>
            )}
          </dd>
        </div>
      </dl>
    </Card>
  );
}

export function QueueDetailPage() {
  const { queueId } = useParams<{ queueId: string }>();
  const queue = useQueue(queueId);
  const stats = useQueueStats(queueId);

  return (
    <div>
      <PageHeader
        title={queue.data?.name ?? 'Queue'}
        actions={
          queue.data && (
            <div className="flex gap-3 text-sm">
              <Link to={`/jobs?queue=${queueId}`} className="text-indigo-600 hover:underline">
                Jobs →
              </Link>
              <Link to={`/dead-letter?project=${queue.data.project_id}`} className="text-indigo-600 hover:underline">
                Dead-letter →
              </Link>
              <Link to={`/projects/${queue.data.project_id}`} className="text-slate-500 hover:text-slate-800">
                ← Queues
              </Link>
            </div>
          )
        }
      />
      <QueryState query={queue}>
        {(q) => (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="space-y-4">
              <ConfigCard q={q} />
              <QueryState query={stats} skeletonRows={2}>
                {(s) => <StatsCard stats={s} />}
              </QueryState>
            </div>
            <div className="space-y-4">
              {queueId && <CreateJobForm queueId={queueId} />}
              {queueId && <CreateScheduleForm queueId={queueId} />}
            </div>
          </div>
        )}
      </QueryState>
    </div>
  );
}
