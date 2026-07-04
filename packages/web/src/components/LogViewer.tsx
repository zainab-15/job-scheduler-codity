import { formatDateTime } from '../lib/format';
import type { JobLogRow } from '../api/types';

const LEVEL_COLOR: Record<string, string> = {
  error: 'text-red-400',
  warn: 'text-amber-300',
  info: 'text-slate-300',
  debug: 'text-slate-500',
};

// R21: reverse-chronological (the API returns logged_at DESC — newest first, so
// new lines appear at the top of a running job with no scrolling), level-colored,
// monospace, with an explicit terminal marker.
export function LogViewer({ logs, terminal }: { logs: JobLogRow[]; terminal: boolean }) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-700 bg-slate-900">
      <div className="flex items-center justify-between border-b border-slate-700 px-3 py-1.5 text-xs text-slate-400">
        <span>Logs ({logs.length})</span>
        {terminal ? (
          <span className="rounded bg-slate-700 px-1.5 py-0.5 text-slate-300">stream ended</span>
        ) : (
          <span className="inline-flex items-center gap-1 text-emerald-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> live
          </span>
        )}
      </div>
      <div className="max-h-72 overflow-y-auto p-3 font-mono text-xs leading-relaxed">
        {logs.length === 0 ? (
          <div className="text-slate-500">No log lines yet.</div>
        ) : (
          logs.map((l) => (
            <div key={l.id} className="flex gap-2">
              <span className="shrink-0 text-slate-600">{formatDateTime(l.logged_at)}</span>
              <span className={`shrink-0 uppercase ${LEVEL_COLOR[l.level] ?? 'text-slate-300'}`}>{l.level}</span>
              <span className="whitespace-pre-wrap break-all text-slate-200">{l.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
