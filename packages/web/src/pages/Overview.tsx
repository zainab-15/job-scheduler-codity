import { Link } from 'react-router-dom';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useHealth, useOverview, useThroughput } from '../api/hooks';
import { QueryState } from '../components/QueryState';
import { Card, PageHeader } from '../components/ui';
import { JOB_STATUS_STYLE } from '../lib/status';
import { formatPercent } from '../lib/format';
import type { HealthResult, OverviewResult, ThroughputResult } from '../api/types';

function Tile({ label, value, tone = 'default', to }: { label: string; value: string | number; tone?: 'default' | 'good' | 'bad'; to?: string }) {
  const toneClass = tone === 'good' ? 'text-emerald-600' : tone === 'bad' ? 'text-red-600' : 'text-slate-900';
  const body = (
    <Card className={`transition ${to ? 'hover:border-indigo-300 hover:shadow' : ''}`}>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</div>
      {to && <div className="mt-1 text-xs text-indigo-600">View →</div>}
    </Card>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

function HealthBanner({ health }: { health: HealthResult }) {
  const map = {
    healthy: { text: 'All systems healthy', cls: 'border-emerald-200 bg-emerald-50 text-emerald-800' },
    degraded: { text: 'Degraded — jobs are backing up', cls: 'border-amber-200 bg-amber-50 text-amber-800' },
    unhealthy: { text: 'Unhealthy — check workers / DB', cls: 'border-red-200 bg-red-50 text-red-800' },
  }[health.status];
  return (
    <div className={`rounded-lg border px-4 py-2 text-sm font-medium ${map.cls}`}>
      {map.text}
      <span className="ml-2 font-normal opacity-75">
        workers alive: {health.checks.workers_alive.value ?? 0} · oldest pending:{' '}
        {Math.round((health.checks.oldest_pending_age_ms.value ?? 0) / 1000)}s · db: {health.checks.db.ok ? 'up' : 'down'}
      </span>
    </div>
  );
}

function ThroughputChart({ data }: { data: ThroughputResult }) {
  if (data.series.length === 0) {
    return <div className="flex h-56 items-center justify-center text-sm text-slate-400">No completed/failed jobs in the last {data.window}.</div>;
  }
  const chartData = data.series.map((p) => ({
    ts: new Date(p.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
    completed: p.completed,
    failed: p.failed,
  }));
  return (
    <ResponsiveContainer width="100%" height={224}>
      <AreaChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis dataKey="ts" tick={{ fontSize: 11 }} stroke="#94a3b8" />
        <YAxis allowDecimals={false} tick={{ fontSize: 11 }} stroke="#94a3b8" />
        <Tooltip />
        <Area type="monotone" dataKey="completed" stackId="1" stroke={JOB_STATUS_STYLE.completed.hex} fill={JOB_STATUS_STYLE.completed.hex} fillOpacity={0.25} />
        <Area type="monotone" dataKey="failed" stackId="1" stroke={JOB_STATUS_STYLE.dead.hex} fill={JOB_STATUS_STYLE.dead.hex} fillOpacity={0.25} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function StatusDonut({ o }: { o: OverviewResult }) {
  const slices = [
    { name: 'Queued', value: o.jobs.queued, fill: JOB_STATUS_STYLE.queued.hex },
    { name: 'Running', value: o.jobs.running, fill: JOB_STATUS_STYLE.running.hex },
    { name: 'Completed 24h', value: o.jobs.completed_24h, fill: JOB_STATUS_STYLE.completed.hex },
    { name: 'Dead-letter', value: o.jobs.dead_letter, fill: JOB_STATUS_STYLE.dead.hex },
  ].filter((s) => s.value > 0);
  if (slices.length === 0) return <div className="flex h-56 items-center justify-center text-sm text-slate-400">No jobs yet.</div>;
  return (
    <ResponsiveContainer width="100%" height={224}>
      <PieChart>
        <Pie data={slices} dataKey="value" nameKey="name" innerRadius={48} outerRadius={80} paddingAngle={2}>
          {slices.map((s) => (
            <Cell key={s.name} fill={s.fill} />
          ))}
        </Pie>
        <Tooltip />
      </PieChart>
    </ResponsiveContainer>
  );
}

function WorkerBars({ o }: { o: OverviewResult }) {
  const data = [
    { name: 'Alive', count: o.workers.alive, fill: '#10b981' },
    { name: 'Draining', count: o.workers.draining, fill: '#f59e0b' },
    { name: 'Dead', count: o.workers.dead, fill: '#ef4444' },
  ];
  return (
    <ResponsiveContainer width="100%" height={224}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis dataKey="name" tick={{ fontSize: 11 }} stroke="#94a3b8" />
        <YAxis allowDecimals={false} tick={{ fontSize: 11 }} stroke="#94a3b8" />
        <Tooltip />
        <Bar dataKey="count" radius={[4, 4, 0, 0]}>
          {data.map((d) => (
            <Cell key={d.name} fill={d.fill} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function OverviewPage() {
  const overview = useOverview();
  const health = useHealth();
  const throughput = useThroughput(24, 'hour');

  return (
    <div>
      <PageHeader title="Overview" subtitle="Is anything on fire?" />

      <div className="mb-5">
        <QueryState query={health} skeletonRows={1}>
          {(h) => <HealthBanner health={h} />}
        </QueryState>
      </div>

      <QueryState query={overview} skeletonRows={2}>
        {(o) => (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Tile label="Queued" value={o.jobs.queued} to="/jobs?status=queued" />
              <Tile label="Running" value={o.jobs.running} to="/jobs?status=running" />
              <Tile label="Completed 24h" value={o.jobs.completed_24h} tone="good" />
              <Tile label="Failed 24h" value={o.jobs.failed_24h} tone={o.jobs.failed_24h > 0 ? 'bad' : 'default'} />
              <Tile label="Success 24h" value={formatPercent(o.success_rate_24h)} tone="good" />
              <Tile label="Dead-letter" value={o.jobs.dead_letter} tone={o.jobs.dead_letter > 0 ? 'bad' : 'default'} to="/dead-letter" />
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
              <Card className="lg:col-span-2">
                <h2 className="mb-2 text-sm font-medium text-slate-700">Throughput (24h)</h2>
                <QueryState query={throughput} skeletonRows={3}>
                  {(t) => <ThroughputChart data={t} />}
                </QueryState>
              </Card>
              <Card>
                <h2 className="mb-2 text-sm font-medium text-slate-700">Job status mix</h2>
                <StatusDonut o={o} />
              </Card>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Card>
                <h2 className="mb-2 text-sm font-medium text-slate-700">
                  Worker fleet · {o.workers.alive} alive
                </h2>
                <WorkerBars o={o} />
              </Card>
              <Card>
                <h2 className="mb-2 text-sm font-medium text-slate-700">Scale</h2>
                <div className="grid grid-cols-2 gap-3">
                  <Tile label="Projects" value={o.projects} to="/projects" />
                  <Tile label="Queues" value={o.queues} />
                </div>
              </Card>
            </div>
          </>
        )}
      </QueryState>
    </div>
  );
}
