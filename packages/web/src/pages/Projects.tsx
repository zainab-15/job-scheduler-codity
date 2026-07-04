import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useCreateProject, useDeleteProject, useProjects } from '../api/hooks';
import { QueryState } from '../components/QueryState';
import { EmptyState } from '../components/EmptyState';
import { Button, Card, Field, PageHeader, inputClass } from '../components/ui';
import { ArrowRightIcon, LayersIcon, PlusIcon, TrashIcon } from '../components/icons';

function CreateProject() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const create = useCreateProject();

  if (!open)
    return (
      <Button variant="primary" onClick={() => setOpen(true)}>
        <PlusIcon width={16} height={16} /> New project
      </Button>
    );

  return (
    <Card className="w-80">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(
            { name, description: description || undefined },
            {
              onSuccess: () => {
                setName('');
                setDescription('');
                setOpen(false);
              },
            },
          );
        }}
        className="space-y-3"
      >
        <Field label="Name">
          <input required value={name} onChange={(e) => setName(e.target.value)} className={inputClass} autoFocus />
        </Field>
        <Field label="Description (optional)">
          <input value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
        </Field>
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

export function ProjectsPage() {
  const projects = useProjects();
  const del = useDeleteProject();

  return (
    <div>
      <PageHeader title="Projects" subtitle="Group queues under a project." actions={<CreateProject />} />
      <QueryState query={projects}>
        {(page) =>
          page.data.length === 0 ? (
            <EmptyState title="No projects yet" hint="Create a project to hold your queues and jobs." />
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {page.data.map((p) => (
                <Card key={p.id} className="group flex flex-col justify-between transition hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-card">
                  <div>
                    <div className="flex items-start gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 ring-1 ring-indigo-100">
                        <LayersIcon width={19} height={19} />
                      </div>
                      <div className="min-w-0">
                        <Link to={`/projects/${p.id}`} className="block truncate text-[0.95rem] font-semibold text-slate-900 group-hover:text-indigo-700">
                          {p.name}
                        </Link>
                        <p className="mt-0.5 text-xs font-medium text-slate-400">{p.queue_count ?? 0} queue(s)</p>
                      </div>
                    </div>
                    {p.description && <p className="mt-3 line-clamp-2 text-sm leading-relaxed text-slate-500">{p.description}</p>}
                  </div>
                  <div className="mt-5 flex items-center justify-between border-t border-slate-100 pt-3">
                    <Link to={`/projects/${p.id}`} className="inline-flex items-center gap-1 text-sm font-medium text-indigo-700 hover:text-indigo-800">
                      Open queues <ArrowRightIcon width={14} height={14} />
                    </Link>
                    <button
                      type="button"
                      disabled={del.isPending}
                      onClick={() => {
                        if (confirm(`Delete project "${p.name}"? This is blocked if it has pending work.`)) del.mutate(p.id);
                      }}
                      className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-slate-400 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                    >
                      <TrashIcon width={14} height={14} /> Delete
                    </button>
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
