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
            <div className="overflow-x-auto rounded-2xl border border-slate-200/80 bg-white shadow-soft">
              <table className="min-w-full text-sm">
                <thead className="border-b border-slate-200/70 bg-slate-50/70 text-left text-[0.7rem] uppercase tracking-[0.06em] text-slate-500">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Hostname</th>
                    <th className="px-4 py-3 font-semibold">Liveness</th>
                    <th className="px-4 py-3 font-semibold">Concurrency</th>
                    <th className="px-4 py-3 font-semibold">Last heartbeat</th>
                    <th className="px-4 py-3 font-semibold">Started</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {page.data.map((w) => (
                    <tr key={w.id} className="transition-colors hover:bg-slate-50/70">
                      <td className="px-4 py-3 font-mono text-xs font-medium text-slate-700">{w.hostname}</td>
                      <td className="px-4 py-3">
                        <LivenessPill liveness={w.liveness} />
                      </td>
                      <td className="px-4 py-3 tnum text-slate-600">{w.concurrency}</td>
                      <td className="px-4 py-3 text-slate-500">{formatRelative(w.last_heartbeat_at)}</td>
                      <td className="px-4 py-3 text-slate-500">{formatRelative(w.started_at)}</td>
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
