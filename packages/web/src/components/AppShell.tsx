import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useOverview } from '../api/hooks';

const NAV = [
  { to: '/overview', label: 'Overview' },
  { to: '/projects', label: 'Projects' },
  { to: '/jobs', label: 'Jobs' },
  { to: '/workers', label: 'Workers' },
  { to: '/dead-letter', label: 'Dead-letter', badge: true },
];

export function AppShell() {
  const { userEmail, orgName, logout } = useAuth();
  // R18: a live DLQ nav badge — dead-lettered work should be visible from
  // anywhere, not buried a click away.
  const overview = useOverview();
  const dlqCount = overview.data?.jobs.dead_letter ?? 0;

  return (
    <div className="flex min-h-full">
      {/* R22: sidebar collapses to a top strip under sm; nav is a real <nav>. */}
      <aside className="flex w-56 shrink-0 flex-col bg-slate-900 text-slate-200 max-sm:w-full max-sm:flex-row max-sm:overflow-x-auto">
        <div className="px-4 py-4 max-sm:shrink-0">
          <div className="text-sm font-semibold text-white">Job Scheduler</div>
          <div className="truncate text-xs text-slate-400">{orgName ?? '—'}</div>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 px-2 max-sm:flex-row max-sm:items-center">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex items-center justify-between gap-2 rounded px-3 py-2 text-sm max-sm:whitespace-nowrap ${
                  isActive ? 'bg-slate-700 text-white' : 'text-slate-300 hover:bg-slate-800'
                }`
              }
            >
              <span>{item.label}</span>
              {item.badge && dlqCount > 0 && (
                <span className="rounded-full bg-red-500 px-1.5 text-xs font-semibold text-white">{dlqCount}</span>
              )}
            </NavLink>
          ))}
          {/* Mobile-only logout: the desktop footer below is hidden when the
              sidebar collapses to a top strip, so surface Log out inline here
              so touch users always have a sign-out affordance. */}
          <button
            type="button"
            onClick={logout}
            className="hidden rounded px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 max-sm:block max-sm:whitespace-nowrap"
          >
            Log out
          </button>
        </nav>
        <div className="border-t border-slate-800 px-4 py-3 text-xs text-slate-400 max-sm:hidden">
          <div className="truncate">{userEmail}</div>
          <button type="button" onClick={logout} className="mt-1 text-slate-300 hover:text-white">
            Log out
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-x-hidden">
        <div className="mx-auto max-w-6xl px-6 py-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
