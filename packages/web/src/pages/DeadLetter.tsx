import { Link, useSearchParams } from 'react-router-dom';
import { useDiscardDlq, useProjectDlq, useProjects, useRequeueDlq } from '../api/hooks';
import { QueryState } from '../components/QueryState';
import { EmptyState } from '../components/EmptyState';
import { Button, PageHeader, inputClass } from '../components/ui';
import { formatRelative } from '../lib/format';

export function DeadLetterPage() {
  const [params, setParams] = useSearchParams();
  const projects = useProjects();
  const projectId = params.get('project') ?? projects.data?.data[0]?.id ?? '';
  const dlq = useProjectDlq(projectId || undefined);
  const requeue = useRequeueDlq();
  const discard = useDiscardDlq();

  function setProject(id: string) {
    const merged = new URLSearchParams(params);
    merged.set('project', id);
    setParams(merged);
  }

  return (
    <div>
      <PageHeader
        title="Dead-letter"
        subtitle="Jobs that exhausted their retries. Requeue to try again, or discard the record."
        actions={
          <label className="text-sm">
            <select value={projectId} onChange={(e) => setProject(e.target.value)} className={inputClass}>
              {projects.data?.data.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        }
      />

      {!projectId ? (
        <EmptyState title="No project selected" hint="Create a project first." />
      ) : (
        <QueryState query={dlq}>
          {(page) =>
            page.data.length === 0 ? (
              <EmptyState variant="win" title="Nothing dead-lettered" hint="Every job in this project either succeeded or is still in flight." />
            ) : (
              <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">Reason</th>
                      <th className="px-3 py-2 font-medium">Attempts</th>
                      <th className="px-3 py-2 font-medium">Final error</th>
                      <th className="px-3 py-2 font-medium">Died</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {page.data.map((d) => (
                      <tr key={d.id} className="hover:bg-slate-50">
                        <td className="px-3 py-2">
                          <span className="rounded bg-red-100 px-1.5 py-0.5 font-mono text-xs text-red-700">{d.death_reason}</span>
                        </td>
                        <td className="px-3 py-2 tabular-nums">{d.attempts}</td>
                        <td className="max-w-xs truncate px-3 py-2 font-mono text-xs text-slate-600" title={d.final_error ?? ''}>
                          {d.final_error ?? '—'}
                        </td>
                        <td className="px-3 py-2 text-slate-500">{formatRelative(d.died_at)}</td>
                        <td className="px-3 py-2">
                          <div className="flex justify-end gap-1.5">
                            {d.job_id && (
                              <Link to={`/jobs/${d.job_id}`} className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50">
                                Detail
                              </Link>
                            )}
                            <Button className="text-xs" variant="primary" disabled={requeue.isPending} onClick={() => requeue.mutate(d.id)}>
                              Requeue
                            </Button>
                            <Button
                              className="text-xs"
                              disabled={discard.isPending}
                              onClick={() => {
                                if (confirm('Discard this dead-letter record?')) discard.mutate(d.id);
                              }}
                            >
                              Discard
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </QueryState>
      )}
    </div>
  );
}
