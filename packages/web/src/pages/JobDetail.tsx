import { Link, useParams } from 'react-router-dom';
import { useCancelJob, useJob, useRetryJob } from '../api/hooks';
import { QueryState } from '../components/QueryState';
import { Timeline } from '../components/Timeline';
import { LogViewer } from '../components/LogViewer';
import { StatusPill, ExecutionPill } from '../components/StatusPill';
import { Button, Card, PageHeader, SectionLabel } from '../components/ui';
import { ChevronLeftIcon } from '../components/icons';
import { formatDateTime, formatDuration, isTerminal } from '../lib/format';
import type { JobDetail } from '../api/types';

function ExecutionsTable({ detail }: { detail: JobDetail }) {
  if (detail.executions.length === 0) return <div className="text-sm text-slate-400">No execution attempts yet.</div>;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="text-left text-[0.7rem] uppercase tracking-[0.06em] text-slate-500">
          <tr>
            <th className="py-2 pr-3 font-semibold">#</th>
            <th className="py-2 pr-3 font-semibold">Status</th>
            <th className="py-2 pr-3 font-semibold">Worker</th>
            <th className="py-2 pr-3 font-semibold">Duration</th>
            <th className="py-2 pr-3 font-semibold">Error</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {[...detail.executions]
            .sort((a, b) => a.attempt - b.attempt)
            .map((ex) => (
              <tr key={ex.id}>
                <td className="py-2 pr-3 tnum">{ex.attempt}</td>
                <td className="py-2 pr-3">
                  <ExecutionPill status={ex.status} />
                </td>
                <td className="py-2 pr-3 font-mono text-xs text-slate-500">{ex.worker_id ? ex.worker_id.slice(0, 8) : '—'}</td>
                <td className="py-2 pr-3 text-slate-600">{formatDuration(ex.duration_ms)}</td>
                <td className="py-2 pr-3 font-mono text-xs text-red-600">{ex.error ?? '—'}</td>
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
          <Link to="/jobs" className="inline-flex items-center gap-1 text-sm font-medium text-slate-500 hover:text-slate-800">
            <ChevronLeftIcon width={15} height={15} /> Jobs
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
            <div className="space-y-5">
              <Card>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <span className="font-mono text-sm font-semibold text-slate-900">{j.handler_name}</span>
                      <StatusPill status={j.status} />
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">{j.type}</span>
                    </div>
                    <div className="mt-2 text-xs text-slate-500">
                      id <span className="font-mono text-slate-600">{j.id.slice(0, 8)}</span> · attempts{' '}
                      <span className="tnum">{j.attempts}/{j.max_attempts}</span> · created {formatDateTime(j.created_at)}
                    </div>
                    {j.last_error && <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 font-mono text-xs text-red-700">{j.last_error}</div>}
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

              <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                <Card>
                  <SectionLabel className="mb-4">Lifecycle</SectionLabel>
                  <Timeline detail={detail} />
                </Card>
                <Card>
                  <SectionLabel className="mb-4">Attempts · retry history</SectionLabel>
                  <ExecutionsTable detail={detail} />
                </Card>
              </div>

              <LogViewer logs={detail.logs} terminal={terminal} />

              <Card>
                <SectionLabel className="mb-3">Payload</SectionLabel>
                <pre className="overflow-x-auto rounded-xl bg-slate-900 p-4 font-mono text-xs leading-relaxed text-slate-200">{JSON.stringify(j.payload, null, 2)}</pre>
              </Card>
            </div>
          );
        }}
      </QueryState>
    </div>
  );
}
