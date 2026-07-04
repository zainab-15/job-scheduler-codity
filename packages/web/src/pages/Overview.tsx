import { Link } from 'react-router-dom';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useHealth, useOverview, useThroughput } from '../api/hooks';
import { QueryState } from '../components/QueryState';
import { Card, PageHeader, SectionLabel } from '../components/ui';
import { ArrowRightIcon } from '../components/icons';
import { JOB_STATUS_STYLE } from '../lib/status';
import { formatPercent } from '../lib/format';
import type { HealthResult, OverviewResult, ThroughputResult } from '../api/types';

// Warm chart neutrals matching the sand palette (grid line + axis label).
const GRID = '#EDE6DB';
const AXIS = '#A99E8C';

function Tile({ label, value, tone = 'default', to }: { label: string; value: string | number; tone?: 'default' | 'good' | 'bad'; to?: string }) {
  const toneClass = tone === 'good' ? 'text-emerald-600' : tone === 'bad' ? 'text-red-600' : 'text-slate-900';
  const body = (
    <Card className={`h-full ${to ? 'transition hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-card' : ''}`}>
      <div className="text-[0.7rem] font-semibold uppercase tracking-[0.07em] text-slate-500">{label}</div>
      <div className={`mt-2 text-[1.75rem] font-bold leading-none tnum ${toneClass}`}>{value}</div>
      {to && (
        <div className="mt-2.5 inline-flex items-center gap-1 text-xs font-medium text-indigo-700">
          View <ArrowRightIcon width={13} height={13} />
        </div>
      )}
    </Card>
  );
  return to ? (
    <Link to={to} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

function HealthBanner({ health }: { health: HealthResult }) {
  const map = {
    healthy: { text: 'All systems healthy', cls: 'border-emerald-200 bg-emerald-50 text-emerald-800', dot: 'bg-emerald-500' },
    degraded: { text: 'Degraded — jobs are backing up', cls: 'border-amber-200 bg-amber-50 text-amber-800', dot: 'bg-amber-500' },
    unhealthy: { text: 'Unhealthy — check workers / DB', cls: 'border-red-200 bg-red-50 text-red-800', dot: 'bg-red-500' },
  }[health.status];
  return (
    <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-2xl border px-4 py-3 text-sm font-semibold ${map.cls}`}>
      <span className={`h-2 w-2 rounded-full ${map.dot}`} aria-hidden />
      {map.text}
      <span className="font-normal opacity-75">
        · workers alive: {health.checks.workers_alive.value ?? 0} · oldest pending:{' '}
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
        <CartesianGrid strokeDasharray="4 4" stroke={GRID} vertical={false} />
        <XAxis dataKey="ts" tick={{ fontSize: 11, fill: AXIS }} tickLine={false} axisLine={false} dy={4} />
        <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: AXIS }} tickLine={false} axisLine={false} width={28} />
        <Tooltip contentStyle={{ borderRadius: 12, border: `1px solid ${GRID}`, fontSize: 12, boxShadow: '0 6px 20px -8px rgb(40 31 24 / 0.12)' }} />
        <Area type="monotone" dataKey="completed" stackId="1" stroke={JOB_STATUS_STYLE.completed.hex} fill={JOB_STATUS_STYLE.completed.hex} fillOpacity={0.2} strokeWidth={2} />
        <Area type="monotone" dataKey="failed" stackId="1" stroke={JOB_STATUS_STYLE.dead.hex} fill={JOB_STATUS_STYLE.dead.hex} fillOpacity={0.2} strokeWidth={2} />
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
        <Pie data={slices} dataKey="value" nameKey="name" innerRadius={50} outerRadius={82} paddingAngle={2} stroke="none">
          {slices.map((s) => (
            <Cell key={s.name} fill={s.fill} />
          ))}
        </Pie>
        <Tooltip contentStyle={{ borderRadius: 12, border: `1px solid ${GRID}`, fontSize: 12, boxShadow: '0 6px 20px -8px rgb(40 31 24 / 0.12)' }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

function WorkerBars({ o }: { o: OverviewResult }) {
  const data = [
    { name: 'Alive', count: o.workers.alive, fill: '#4EA07E' },
    { name: 'Draining', count: o.workers.draining, fill: '#E0A44E' },
    { name: 'Dead', count: o.workers.dead, fill: '#D26B66' },
  ];
  return (
    <ResponsiveContainer width="100%" height={224}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
        <CartesianGrid strokeDasharray="4 4" stroke={GRID} vertical={false} />
        <XAxis dataKey="name" tick={{ fontSize: 11, fill: AXIS }} tickLine={false} axisLine={false} dy={4} />
        <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: AXIS }} tickLine={false} axisLine={false} width={28} />
        <Tooltip cursor={{ fill: 'rgb(133 124 109 / 0.06)' }} contentStyle={{ borderRadius: 12, border: `1px solid ${GRID}`, fontSize: 12, boxShadow: '0 6px 20px -8px rgb(40 31 24 / 0.12)' }} />
        <Bar dataKey="count" radius={[8, 8, 0, 0]} maxBarSize={56}>
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

            <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-3">
              <Card className="lg:col-span-2">
                <SectionLabel className="mb-3">Throughput · 24h</SectionLabel>
                <QueryState query={throughput} skeletonRows={3}>
                  {(t) => <ThroughputChart data={t} />}
                </QueryState>
              </Card>
              <Card>
                <SectionLabel className="mb-3">Job status mix</SectionLabel>
                <StatusDonut o={o} />
              </Card>
            </div>

            <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
              <Card>
                <SectionLabel className="mb-3">Worker fleet · {o.workers.alive} alive</SectionLabel>
                <WorkerBars o={o} />
              </Card>
              <Card>
                <SectionLabel className="mb-3">Scale</SectionLabel>
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
