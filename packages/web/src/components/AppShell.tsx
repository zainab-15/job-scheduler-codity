import { NavLink, Outlet } from 'react-router-dom';
import type { ComponentType, SVGProps } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useOverview } from '../api/hooks';
import { CodityMark, DeadLetterIcon, GaugeIcon, JobsIcon, LayersIcon, LogOutIcon, WorkersIcon } from './icons';

type IconType = ComponentType<SVGProps<SVGSVGElement>>;
const NAV: Array<{ to: string; label: string; icon: IconType; badge?: boolean }> = [
  { to: '/overview', label: 'Overview', icon: GaugeIcon },
  { to: '/projects', label: 'Projects', icon: LayersIcon },
  { to: '/jobs', label: 'Jobs', icon: JobsIcon },
  { to: '/workers', label: 'Workers', icon: WorkersIcon },
  { to: '/dead-letter', label: 'Dead-letter', icon: DeadLetterIcon, badge: true },
];

export function AppShell() {
  const { userEmail, orgName, logout } = useAuth();
  // R18: a live DLQ nav badge — dead-lettered work should be visible from
  // anywhere, not buried a click away.
  const overview = useOverview();
  const dlqCount = overview.data?.jobs.dead_letter ?? 0;

  return (
    <div className="flex min-h-full max-sm:flex-col">
      {/* R22: sidebar collapses to a top strip under sm; nav is a real <nav>. */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-white/80 backdrop-blur-sm max-sm:w-full max-sm:flex-row max-sm:items-center max-sm:overflow-x-auto max-sm:border-b max-sm:border-r-0">
        <div className="flex items-center gap-2.5 px-5 py-5 max-sm:shrink-0 max-sm:py-3">
          <CodityMark className="h-9 w-9" />
          <div className="min-w-0">
            <div className="text-[0.95rem] font-bold leading-none tracking-tight text-slate-900">Codity</div>
            <div className="mt-1 truncate text-xs text-slate-500">{orgName ?? 'Job Scheduler'}</div>
          </div>
        </div>

        <nav className="flex flex-1 flex-col gap-1 px-3 max-sm:flex-row max-sm:items-center max-sm:px-2">
          {NAV.map(({ to, label, icon: Icon, badge }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `group flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium transition-colors max-sm:whitespace-nowrap ${
                  isActive
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <Icon className={isActive ? 'text-indigo-600' : 'text-slate-400 group-hover:text-slate-600'} width={20} height={20} />
                  <span className="flex-1">{label}</span>
                  {badge && dlqCount > 0 && (
                    <span className="tnum inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-red-500 px-1.5 py-0.5 text-[0.65rem] font-bold text-white">
                      {dlqCount}
                    </span>
                  )}
                </>
              )}
            </NavLink>
          ))}
          {/* Mobile-only logout: the desktop footer below is hidden when the
              sidebar collapses to a top strip, so surface Log out inline here
              so touch users always have a sign-out affordance. */}
          <button
            type="button"
            onClick={logout}
            className="hidden items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 max-sm:flex max-sm:whitespace-nowrap"
          >
            <LogOutIcon width={20} height={20} /> Log out
          </button>
        </nav>

        <div className="mx-3 mb-3 rounded-xl border border-slate-200/80 bg-slate-50 px-3 py-2.5 max-sm:hidden">
          <div className="truncate text-xs font-medium text-slate-700">{userEmail}</div>
          <button
            type="button"
            onClick={logout}
            className="mt-1 inline-flex items-center gap-1.5 text-xs text-slate-500 transition hover:text-indigo-700"
          >
            <LogOutIcon width={14} height={14} /> Log out
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-x-hidden">
        <div className="mx-auto w-full max-w-6xl px-5 py-8 sm:px-8">
          <div className="animate-fade-in">
            <Outlet />
          </div>
        </div>
      </main>
    </div>
  );
}
