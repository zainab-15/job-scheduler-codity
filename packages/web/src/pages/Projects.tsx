import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useCreateProject, useDeleteProject, useProjects } from '../api/hooks';
import { QueryState } from '../components/QueryState';
import { EmptyState } from '../components/EmptyState';
import { Button, Card, Field, PageHeader, inputClass } from '../components/ui';

function CreateProject() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const create = useCreateProject();

  if (!open)
    return (
      <Button variant="primary" onClick={() => setOpen(true)}>
        + New project
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
        className="space-y-2"
      >
        <Field label="Name">
          <input required value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {page.data.map((p) => (
                <Card key={p.id} className="flex flex-col justify-between">
                  <div>
                    <Link to={`/projects/${p.id}`} className="text-base font-medium text-slate-900 hover:text-indigo-600">
                      {p.name}
                    </Link>
                    {p.description && <p className="mt-1 text-sm text-slate-500">{p.description}</p>}
                    <p className="mt-2 text-xs text-slate-400">{p.queue_count ?? 0} queue(s)</p>
                  </div>
                  <div className="mt-3 flex justify-between">
                    <Link to={`/projects/${p.id}`} className="text-sm text-indigo-600 hover:underline">
                      Open queues →
                    </Link>
                    <Button
                      variant="ghost"
                      className="text-red-600 hover:bg-red-50"
                      disabled={del.isPending}
                      onClick={() => {
                        if (confirm(`Delete project "${p.name}"? This is blocked if it has pending work.`)) del.mutate(p.id);
                      }}
                    >
                      Delete
                    </Button>
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
