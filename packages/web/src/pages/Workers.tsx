import { useWorkers } from '../api/hooks';
import { QueryState } from '../components/QueryState';
import { EmptyState } from '../components/EmptyState';
import { LivenessPill } from '../components/StatusPill';
import { PageHeader } from '../components/ui';
import { formatRelative } from '../lib/format';

export function WorkersPage() {
  const workers = useWorkers();
  return (
    <div>
      <PageHeader title="Workers" subtitle="Liveness is derived from the last heartbeat, not a stale status column." />
      <QueryState query={workers}>
        {(page) =>
          page.data.length === 0 ? (
            <EmptyState title="No workers registered" hint="Start one with `npm run dev:worker`." />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Hostname</th>
                    <th className="px-3 py-2 font-medium">Liveness</th>
                    <th className="px-3 py-2 font-medium">Concurrency</th>
                    <th className="px-3 py-2 font-medium">Last heartbeat</th>
                    <th className="px-3 py-2 font-medium">Started</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {page.data.map((w) => (
                    <tr key={w.id} className="hover:bg-slate-50">
                      <td className="px-3 py-2 font-mono text-xs">{w.hostname}</td>
                      <td className="px-3 py-2">
                        <LivenessPill liveness={w.liveness} />
                      </td>
                      <td className="px-3 py-2 tabular-nums">{w.concurrency}</td>
                      <td className="px-3 py-2 text-slate-500">{formatRelative(w.last_heartbeat_at)}</td>
                      <td className="px-3 py-2 text-slate-500">{formatRelative(w.started_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </QueryState>
    </div>
  );
}
