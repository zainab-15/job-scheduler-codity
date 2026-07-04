import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useProjectJobs, useProjects, useQueueJobs, useQueues, type JobListParams } from '../api/hooks';
import { QueryState } from '../components/QueryState';
import { EmptyState } from '../components/EmptyState';
import { Pagination } from '../components/Pagination';
import { StatusPill } from '../components/StatusPill';
import { PageHeader, inputClass } from '../components/ui';
import { ALL_JOB_STATUSES, ALL_JOB_TYPES, JOB_STATUS_STYLE } from '../lib/status';
import { formatRelative } from '../lib/format';
import type { JobRow } from '../api/types';

const LIMIT = 20;

function JobsTable({ jobs }: { jobs: JobRow[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
          <tr>
            <th className="px-3 py-2 font-medium">Handler</th>
            <th className="px-3 py-2 font-medium">Type</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Attempts</th>
            <th className="px-3 py-2 font-medium">Created</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {jobs.map((j) => (
            <tr key={j.id} className="hover:bg-slate-50">
              <td className="px-3 py-2 font-mono text-xs">{j.handler_name}</td>
              <td className="px-3 py-2 text-slate-500">{j.type}</td>
              <td className="px-3 py-2">
                <StatusPill status={j.status} />
              </td>
              <td className="px-3 py-2 tabular-nums text-slate-600">
                {j.attempts}/{j.max_attempts}
              </td>
              <td className="px-3 py-2 text-slate-500">{formatRelative(j.created_at)}</td>
              <td className="px-3 py-2 text-right">
                <Link to={`/jobs/${j.id}`} className="text-indigo-600 hover:underline">
                  Detail →
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function JobExplorerPage() {
  const [params, setParams] = useSearchParams();
  const projects = useProjects();

  const projectId = params.get('project') ?? projects.data?.data[0]?.id ?? '';
  const queueId = params.get('queue') ?? '';
  const type = params.get('type') ?? '';
  const sort = params.get('sort') ?? 'created_at:desc';
  const offset = Number(params.get('offset') ?? 0);
  // filter(Boolean): a hand-crafted URL like ?status=queued, would otherwise
  // split to ['queued',''] and send an empty status value that the API enum
  // rejects with a 400, killing the whole list.
  const statuses = useMemo(() => (params.get('status') ? params.get('status')!.split(',').filter(Boolean) : []), [params]);

  const queues = useQueues(projectId || undefined);

  function update(next: Record<string, string | null>, resetOffset = true) {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === '') merged.delete(k);
      else merged.set(k, v);
    }
    if (resetOffset) merged.delete('offset');
    setParams(merged);
  }

  const listParams: JobListParams = { status: statuses, type: type || undefined, sort, limit: LIMIT, offset };
  const queueJobs = useQueueJobs(queueId || undefined, listParams);
  const projectJobs = useProjectJobs(!queueId && projectId ? projectId : undefined, listParams);
  const active = queueId ? queueJobs : projectJobs;
  const filtering = statuses.length > 0 || !!type;

  function toggleStatus(s: string) {
    const next = statuses.includes(s) ? statuses.filter((x) => x !== s) : [...statuses, s];
    update({ status: next.length ? next.join(',') : null });
  }

  return (
    <div>
      <PageHeader title="Jobs" subtitle="Filter, sort, and drill into any job." />

      <div className="mb-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block font-medium text-slate-600">Project</span>
            <select value={projectId} onChange={(e) => update({ project: e.target.value, queue: null })} className={inputClass}>
              {projects.data?.data.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium text-slate-600">Queue</span>
            <select value={queueId} onChange={(e) => update({ queue: e.target.value || null })} className={inputClass}>
              <option value="">All queues in project</option>
              {queues.data?.data.map((q) => (
                <option key={q.id} value={q.id}>
                  {q.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium text-slate-600">Type</span>
            <select value={type} onChange={(e) => update({ type: e.target.value || null })} className={inputClass}>
              <option value="">All types</option>
              {ALL_JOB_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium text-slate-600">Sort</span>
            <select value={sort} onChange={(e) => update({ sort: e.target.value })} className={inputClass}>
              <option value="created_at:desc">Newest first</option>
              <option value="created_at:asc">Oldest first</option>
              <option value="priority:desc">Priority high→low</option>
              <option value="run_at:asc">Run-at soonest</option>
            </select>
          </label>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {ALL_JOB_STATUSES.map((s) => {
            const on = statuses.includes(s);
            return (
              <button
                key={s}
                type="button"
                onClick={() => toggleStatus(s)}
                className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${
                  on ? JOB_STATUS_STYLE[s].pill : 'bg-white text-slate-500 ring-slate-200 hover:bg-slate-50'
                }`}
              >
                {JOB_STATUS_STYLE[s].label}
              </button>
            );
          })}
          {filtering && (
            <button type="button" onClick={() => update({ status: null, type: null })} className="px-2 py-1 text-xs text-slate-500 hover:text-slate-800">
              Clear
            </button>
          )}
        </div>
      </div>

      {!projectId ? (
        <EmptyState title="No project selected" hint="Create a project and a queue first." />
      ) : (
        <QueryState query={active}>
          {(page) =>
            page.data.length === 0 ? (
              filtering ? (
                <EmptyState title="No jobs match this filter" variant="filter" hint="Try clearing a status or type." />
              ) : (
                <EmptyState title="No jobs in this scope yet" hint="Enqueue a job from a queue page." />
              )
            ) : (
              <>
                <JobsTable jobs={page.data} />
                <Pagination meta={page.pagination} offset={offset} limit={LIMIT} onOffset={(o) => update({ offset: String(o) }, false)} />
              </>
            )
          }
        </QueryState>
      )}
    </div>
  );
}
