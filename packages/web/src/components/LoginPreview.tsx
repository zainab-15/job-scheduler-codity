import type { ReactNode } from 'react';
import { ActivityIcon, CheckIcon, ChevronLeftIcon, ChevronRightIcon, CodityMark, JobsIcon, WorkersIcon } from './icons';

// A realistic, non-interactive product preview for the login left panel — a
// premium scheduling dashboard built entirely from the app's own design system
// (warm ivory surfaces, soft pastel event colors, dusty-rose accent, Manrope).
// The whole thing is decorative: it's marked aria-hidden so assistive tech skips
// straight to the real login form on the right. Layout follows an 8px rhythm;
// cards are borderless and float on the blush panel with a soft, diffuse shadow.

type Tone = 'blush' | 'coral' | 'beige' | 'peach';

// Softer, more premium event palette: blush pink, soft coral, warm beige, light
// peach. Airy tints, legible text, no dull pinks.
const EVENT_TONE: Record<Tone, string> = {
  blush: 'bg-[#FBE7EA] text-[#B15E6E]',
  coral: 'bg-[#FBE2D9] text-[#C0684A]',
  beige: 'bg-[#F2E9D8] text-[#8A7551]',
  peach: 'bg-[#FDEBDA] text-[#C17A48]',
};
const DOT_TONE: Record<Tone, string> = {
  blush: 'bg-[#E39BAB]',
  coral: 'bg-[#E7A088]',
  beige: 'bg-[#CBB88E]',
  peach: 'bg-[#EDB183]',
};
const ICON_TILE: Record<Tone, string> = {
  blush: 'bg-[#FBE7EA] text-[#B15E6E]',
  coral: 'bg-[#FBE2D9] text-[#C0684A]',
  beige: 'bg-[#F2E9D8] text-[#8A7551]',
  peach: 'bg-[#FDEBDA] text-[#C17A48]',
};

// Calendar events keyed by day-of-month for the current month.
const EVENTS: Record<number, { label: string; tone: Tone }> = {
  2: { label: 'Kickoff', tone: 'peach' },
  4: { label: 'Standup', tone: 'blush' },
  8: { label: 'Ingest', tone: 'coral' },
  13: { label: 'Reports', tone: 'coral' },
  16: { label: 'Digest', tone: 'blush' },
  20: { label: 'Cleanup', tone: 'beige' },
  23: { label: 'Webhook', tone: 'coral' },
  27: { label: 'Backup', tone: 'beige' },
  30: { label: 'DB sync', tone: 'peach' },
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const WORKER_STATUS: Array<{ icon: typeof WorkersIcon; tone: Tone; label: string; value: string; sub: string }> = [
  { icon: WorkersIcon, tone: 'coral', label: 'Workers online', value: '12', sub: 'of 24 active' },
  { icon: ActivityIcon, tone: 'peach', label: 'Active jobs', value: '37', sub: 'running now' },
  { icon: JobsIcon, tone: 'beige', label: 'Queue health', value: '98%', sub: 'healthy' },
  { icon: CheckIcon, tone: 'blush', label: 'Success rate', value: '99.98%', sub: '+0.02% today' },
];

const UPCOMING: Array<{ name: string; time: string; tone: Tone }> = [
  { name: 'Data Processing', time: 'Today · 10:00 AM', tone: 'coral' },
  { name: 'Report Generation', time: 'Today · 1:30 PM', tone: 'peach' },
  { name: 'Email Reports', time: 'Today · 4:00 PM', tone: 'blush' },
  { name: 'Cleanup Jobs', time: 'Tomorrow · 9:00 AM', tone: 'beige' },
];

const SCHEDULE: Array<{ time: string; name: string; status: Status }> = [
  { time: '10:00', name: 'Data Processing', status: 'Running' },
  { time: '13:30', name: 'Report Generation', status: 'Scheduled' },
  { time: '16:00', name: 'Email Reports', status: 'Scheduled' },
  { time: '23:00', name: 'Night Backup', status: 'Scheduled' },
];

const TIMELINE: Array<{ t: string; name: string; status: Status }> = [
  { t: '10:00:15', name: 'Data Processing', status: 'Completed' },
  { t: '10:01:02', name: 'Report Generation', status: 'Running' },
  { t: '10:01:45', name: 'Email Reports', status: 'Queued' },
  { t: '10:02:10', name: 'Cleanup Jobs', status: 'Queued' },
];

const ACTIVITY: Array<{ text: string; time: string; tone: Tone }> = [
  { text: 'Worker 7 picked up “Data Processing”', time: '2m', tone: 'coral' },
  { text: 'Job “Report Generation” completed', time: '5m', tone: 'beige' },
  { text: 'Job “Email Reports” queued', time: '7m', tone: 'peach' },
  { text: 'Worker 3 went offline', time: '12m', tone: 'blush' },
];

type Status = 'Running' | 'Scheduled' | 'Queued' | 'Completed';
const PILL: Record<Status, string> = {
  Running: 'bg-indigo-50 text-indigo-700',
  Scheduled: 'bg-[#F2E9D8] text-[#8A7551]',
  Queued: 'bg-slate-100 text-slate-500',
  Completed: 'bg-emerald-50 text-emerald-700',
};
const STATUS_DOT: Record<Status, string> = {
  Running: 'bg-indigo-500',
  Scheduled: 'bg-[#CBB88E]',
  Queued: 'bg-slate-300',
  Completed: 'bg-emerald-500',
};

function buildMonth(base: Date) {
  const year = base.getFullYear();
  const month = base.getMonth();
  const startDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevDays = new Date(year, month, 0).getDate();
  const cells: Array<{ day: number; cur: boolean }> = [];
  for (let i = 0; i < startDow; i++) cells.push({ day: prevDays - startDow + 1 + i, cur: false });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, cur: true });
  let next = 1;
  while (cells.length % 7 !== 0 || cells.length < 35) cells.push({ day: next++, cur: false });
  return cells;
}

// Borderless floating card — spacing + soft shadow separate it, not a border.
function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-3xl bg-white shadow-soft-lg ${className}`}>{children}</div>;
}

function WidgetHead({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <span className="text-[0.72rem] font-bold uppercase tracking-[0.07em] text-slate-500">{title}</span>
      {meta && <span className="text-[0.66rem] font-semibold text-indigo-700">{meta}</span>}
    </div>
  );
}

export function LoginPreview() {
  const now = new Date();
  const todayNum = now.getDate();
  const monthLabel = now.toLocaleString(undefined, { month: 'long', year: 'numeric' });
  const cells = buildMonth(now);

  return (
    <div aria-hidden="true" className="flex w-full max-w-[960px] flex-col gap-5">
      {/* App-chrome header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <CodityMark className="h-10 w-10" />
          <div>
            <div className="text-base font-bold leading-none tracking-tight text-slate-900">Codity</div>
            <div className="mt-1.5 text-[0.72rem] font-medium text-slate-500">Job Scheduler</div>
          </div>
        </div>
        <div className="inline-flex items-center gap-2 rounded-full bg-white px-3.5 py-2 shadow-soft-lg">
          <span className="h-2 w-2 rounded-full bg-emerald-500" />
          <span className="text-[0.72rem] font-semibold text-slate-600">All systems operational</span>
        </div>
      </div>

      {/* Hero calendar + side widgets */}
      <div className="grid grid-cols-[1.55fr_1fr] gap-6">
        {/* Calendar — the hero */}
        <Card className="p-6">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <div className="text-lg font-bold tracking-tight text-slate-900">{monthLabel}</div>
              <div className="mt-0.5 text-[0.72rem] font-medium text-slate-400">9 jobs scheduled this month</div>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-xl bg-slate-50 px-3 py-1.5 text-[0.7rem] font-semibold text-slate-500">Today</span>
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-50 text-slate-400">
                <ChevronLeftIcon width={15} height={15} />
              </span>
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-50 text-slate-400">
                <ChevronRightIcon width={15} height={15} />
              </span>
            </div>
          </div>
          <div className="grid grid-cols-7 gap-2">
            {WEEKDAYS.map((w, i) => (
              <div key={w} className={`pb-1 text-center text-[0.66rem] font-bold uppercase tracking-wide ${i === 0 || i === 6 ? 'text-slate-300' : 'text-slate-400'}`}>
                {w}
              </div>
            ))}
            {cells.map((c, idx) => {
              const col = idx % 7;
              const weekend = col === 0 || col === 6;
              const ev = c.cur ? EVENTS[c.day] : undefined;
              const isToday = c.cur && c.day === todayNum;
              return (
                <div key={idx} className={`min-h-[56px] rounded-xl p-1.5 ${weekend ? 'bg-slate-50/60' : ''}`}>
                  <div
                    className={`flex h-7 w-7 items-center justify-center rounded-full text-[0.78rem] font-semibold ${
                      isToday ? 'bg-indigo-600 text-white shadow-soft' : !c.cur ? 'text-slate-300' : weekend ? 'text-slate-400' : 'text-slate-600'
                    }`}
                  >
                    {c.day}
                  </div>
                  {ev && (
                    <div className={`mt-1 truncate rounded-md px-1.5 py-0.5 text-[0.6rem] font-semibold leading-tight ${EVENT_TONE[ev.tone]}`}>
                      {ev.label}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>

        {/* Side column: Worker Status + Upcoming Jobs */}
        <div className="flex flex-col gap-6">
          <Card className="p-5">
            <WidgetHead title="Worker status" />
            <div className="grid grid-cols-2 gap-3">
              {WORKER_STATUS.map(({ icon: Icon, tone, label, value, sub }) => (
                <div key={label} className="rounded-2xl bg-slate-50/70 p-3">
                  <span className={`flex h-7 w-7 items-center justify-center rounded-lg ${ICON_TILE[tone]}`}>
                    <Icon width={15} height={15} />
                  </span>
                  <div className="mt-2 text-base font-bold leading-none tracking-tight text-slate-900">{value}</div>
                  <div className="mt-1 text-[0.66rem] font-semibold text-slate-600">{label}</div>
                  <div className="text-[0.6rem] font-medium text-slate-400">{sub}</div>
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-5">
            <WidgetHead title="Upcoming jobs" meta="View all" />
            <ul className="space-y-3">
              {UPCOMING.map((u) => (
                <li key={u.name} className="flex items-center gap-3">
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT_TONE[u.tone]}`} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[0.78rem] font-semibold text-slate-700">{u.name}</div>
                    <div className="text-[0.66rem] text-slate-400">{u.time}</div>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>

      {/* Supporting information */}
      <div className="grid grid-cols-3 gap-6">
        <Card className="p-5">
          <WidgetHead title="Today's schedule" meta="View all" />
          <ul className="space-y-3">
            {SCHEDULE.map((s) => (
              <li key={s.name} className="flex items-center gap-2.5">
                <span className="tnum w-10 shrink-0 text-[0.66rem] font-semibold text-slate-400">{s.time}</span>
                <span className="min-w-0 flex-1 truncate text-[0.74rem] font-semibold text-slate-700">{s.name}</span>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[0.58rem] font-bold ${PILL[s.status]}`}>{s.status}</span>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="p-5">
          <WidgetHead title="Job timeline" meta="Live" />
          <ol className="space-y-3">
            {TIMELINE.map((t) => (
              <li key={t.t} className="flex items-center gap-2.5">
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_DOT[t.status]}`} />
                <span className="tnum shrink-0 text-[0.62rem] text-slate-400">{t.t}</span>
                <span className="min-w-0 flex-1 truncate text-[0.74rem] font-semibold text-slate-700">{t.name}</span>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[0.58rem] font-bold ${PILL[t.status]}`}>{t.status}</span>
              </li>
            ))}
          </ol>
        </Card>

        <Card className="p-5">
          <WidgetHead title="Recent activity" />
          <ul className="space-y-3">
            {ACTIVITY.map((a, i) => (
              <li key={i} className="flex items-start gap-2.5">
                <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${DOT_TONE[a.tone]}`} />
                <span className="flex-1 text-[0.7rem] leading-snug text-slate-600">{a.text}</span>
                <span className="shrink-0 text-[0.62rem] font-medium text-slate-400">{a.time}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
