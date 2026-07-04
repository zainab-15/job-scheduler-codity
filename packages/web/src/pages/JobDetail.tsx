import { Link, useParams } from 'react-router-dom';
import { useCancelJob, useJob, useRetryJob } from '../api/hooks';
import { QueryState } from '../components/QueryState';
import { Timeline } from '../components/Timeline';
import { LogViewer } from '../components/LogViewer';
import { StatusPill, ExecutionPill } from '../components/StatusPill';
import { Button, Card, PageHeader } from '../components/ui';
import { formatDateTime, formatDuration, isTerminal } from '../lib/format';
import type { JobDetail } from '../api/types';

function ExecutionsTable({ detail }: { detail: JobDetail }) {
  if (detail.executions.length === 0) return <div className="text-sm text-slate-400">No execution attempts yet.</div>;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="text-left text-xs uppercase text-slate-500">
          <tr>
            <th className="py-1.5 pr-3 font-medium">#</th>
            <th className="py-1.5 pr-3 font-medium">Status</th>
            <th className="py-1.5 pr-3 font-medium">Worker</th>
            <th className="py-1.5 pr-3 font-medium">Duration</th>
            <th className="py-1.5 pr-3 font-medium">Error</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {[...detail.executions]
            .sort((a, b) => a.attempt - b.attempt)
            .map((ex) => (
              <tr key={ex.id}>
                <td className="py-1.5 pr-3 tabular-nums">{ex.attempt}</td>
                <td className="py-1.5 pr-3">
                  <ExecutionPill status={ex.status} />
                </td>
                <td className="py-1.5 pr-3 font-mono text-xs text-slate-500">{ex.worker_id ? ex.worker_id.slice(0, 8) : '—'}</td>
                <td className="py-1.5 pr-3 text-slate-600">{formatDuration(ex.duration_ms)}</td>
                <td className="py-1.5 pr-3 font-mono text-xs text-red-600">{ex.error ?? '—'}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

export function JobDetailPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const job = useJob(jobId);
  const retry = useRetryJob();
  const cancel = useCancelJob();

  return (
    <div>
      <PageHeader
        title="Job detail"
        actions={
          <Link to="/jobs" className="text-sm text-slate-500 hover:text-slate-800">
            ← Jobs
          </Link>
        }
      />
      <QueryState query={job}>
        {(detail) => {
          const j = detail.job;
          const terminal = isTerminal(j.status);
          const canRetry = j.status === 'dead' || j.status === 'retrying';
          const canCancel = j.status === 'queued' || j.status === 'scheduled' || j.status === 'retrying';
          return (
            <div className="space-y-4">
              <Card>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm">{j.handler_name}</span>
                      <StatusPill status={j.status} />
                      <span className="text-xs text-slate-400">{j.type}</span>
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      id {j.id.slice(0, 8)} · attempts {j.attempts}/{j.max_attempts} · created {formatDateTime(j.created_at)}
                    </div>
                    {j.last_error && <div className="mt-2 rounded bg-red-50 px-2 py-1 font-mono text-xs text-red-700">{j.last_error}</div>}
                  </div>
                  <div className="flex gap-2">
                    <Button variant="primary" disabled={!canRetry || retry.isPending} onClick={() => jobId && retry.mutate(jobId)}>
                      Retry
                    </Button>
                    <Button variant="danger" disabled={!canCancel || cancel.isPending} onClick={() => jobId && cancel.mutate(jobId)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              </Card>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Card>
                  <h2 className="mb-3 text-sm font-medium text-slate-700">Lifecycle</h2>
                  <Timeline detail={detail} />
                </Card>
                <Card>
                  <h2 className="mb-3 text-sm font-medium text-slate-700">Attempts (retry history)</h2>
                  <ExecutionsTable detail={detail} />
                </Card>
              </div>

              <LogViewer logs={detail.logs} terminal={terminal} />

              <Card>
                <h2 className="mb-2 text-sm font-medium text-slate-700">Payload</h2>
                <pre className="overflow-x-auto rounded bg-slate-50 p-3 font-mono text-xs text-slate-700">{JSON.stringify(j.payload, null, 2)}</pre>
              </Card>
            </div>
          );
        }}
      </QueryState>
    </div>
  );
}
