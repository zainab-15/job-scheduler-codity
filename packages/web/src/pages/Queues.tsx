import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useCreateQueue, useProject, usePauseResumeQueue, useQueues } from '../api/hooks';
import { QueryState } from '../components/QueryState';
import { EmptyState } from '../components/EmptyState';
import { SaturationBar } from '../components/SaturationBar';
import { Button, Card, Field, PageHeader, inputClass } from '../components/ui';

function CreateQueue({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [concurrency, setConcurrency] = useState(5);
  const [priority, setPriority] = useState(5);
  const create = useCreateQueue(projectId);

  if (!open)
    return (
      <Button variant="primary" onClick={() => setOpen(true)}>
        + New queue
      </Button>
    );

  return (
    <Card className="w-80">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(
            { name, concurrency_limit: concurrency, priority },
            { onSuccess: () => { setName(''); setOpen(false); } },
          );
        }}
        className="space-y-2"
      >
        <Field label="Name">
          <input required value={name} onChange={(e) => setName(e.target.value)} className={inputClass} placeholder="emails" />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Concurrency limit">
            <input type="number" min={1} value={concurrency} onChange={(e) => setConcurrency(+e.target.value)} className={inputClass} />
          </Field>
          <Field label="Priority (0–9)">
            <input type="number" min={0} max={9} value={priority} onChange={(e) => setPriority(+e.target.value)} className={inputClass} />
          </Field>
        </div>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={create.isPending}>
            Create
          </Button>
          <Button type="button" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function QueuesPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const project = useProject(projectId);
  const queues = useQueues(projectId);
  const pauseResume = usePauseResumeQueue();

  return (
    <div>
      <PageHeader
        title={project.data?.name ?? 'Queues'}
        subtitle="Each queue enforces its own concurrency limit."
        actions={
          <div className="flex items-center gap-3">
            <Link to="/projects" className="text-sm text-slate-500 hover:text-slate-800">
              ← Projects
            </Link>
            {projectId && <CreateQueue projectId={projectId} />}
          </div>
        }
      />
      <QueryState query={queues}>
        {(page) =>
          page.data.length === 0 ? (
            <EmptyState title="No queues yet" hint="Create a queue, then enqueue jobs into it." />
          ) : (
            <div className="space-y-2">
              {page.data.map((q) => (
                <Card key={q.id} className={q.is_paused ? 'border-amber-300 bg-amber-50' : ''}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <Link to={`/queues/${q.id}`} className="font-medium text-slate-900 hover:text-indigo-600">
                        {q.name}
                      </Link>
                      {q.is_paused && (
                        <span className="ml-2 rounded bg-amber-500 px-1.5 py-0.5 text-xs font-semibold text-white">PAUSED</span>
                      )}
                      <div className="mt-1 text-xs text-slate-500">priority {q.priority}</div>
                    </div>

                    <div className="flex items-center gap-4">
                      <SaturationBar running={q.stat_running} limit={q.concurrency_limit} />
                      <div className="flex gap-3 text-xs tabular-nums text-slate-600">
                        <span>{q.stat_queued} queued</span>
                        <span className="text-emerald-600">{q.stat_completed} done</span>
                        {q.stat_dead > 0 && (
                          <span className="rounded bg-red-100 px-1.5 font-semibold text-red-700">{q.stat_dead} dead</span>
                        )}
                      </div>
                      <Button
                        onClick={() => pauseResume.mutate({ queueId: q.id, pause: !q.is_paused })}
                        disabled={pauseResume.isPending}
                      >
                        {q.is_paused ? 'Resume' : 'Pause'}
                      </Button>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )
        }
      </QueryState>
    </div>
  );
}
