import { formatDateTime } from '../lib/format';
import type { JobLogRow } from '../api/types';

const LEVEL_COLOR: Record<string, string> = {
  error: 'text-red-300',
  warn: 'text-amber-300',
  info: 'text-slate-300',
  debug: 'text-slate-500',
};

// R21: reverse-chronological (the API returns logged_at DESC — newest first, so
// new lines appear at the top of a running job with no scrolling), level-colored,
// monospace, with an explicit terminal marker.
export function LogViewer({ logs, terminal }: { logs: JobLogRow[]; terminal: boolean }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-soft">
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2 text-xs font-medium text-slate-400">
        <span className="uppercase tracking-[0.08em]">Logs · {logs.length}</span>
        {terminal ? (
          <span className="rounded-full bg-slate-800 px-2 py-0.5 text-slate-300">stream ended</span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-emerald-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> live
          </span>
        )}
      </div>
      <div className="max-h-72 overflow-y-auto p-4 font-mono text-xs leading-relaxed">
        {logs.length === 0 ? (
          <div className="text-slate-500">No log lines yet.</div>
        ) : (
          logs.map((l) => (
            <div key={l.id} className="flex gap-3 py-px">
              <span className="shrink-0 text-slate-600">{formatDateTime(l.logged_at)}</span>
              <span className={`w-10 shrink-0 uppercase ${LEVEL_COLOR[l.level] ?? 'text-slate-300'}`}>{l.level}</span>
              <span className="whitespace-pre-wrap break-all text-slate-200">{l.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
