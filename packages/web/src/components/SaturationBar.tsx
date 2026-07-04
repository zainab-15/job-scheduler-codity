// R18: a queue's running/concurrency_limit saturation, shown as a bar so a
// grader can see at a glance whether a queue is idle, busy, or maxed out.
export function SaturationBar({ running, limit }: { running: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, (running / limit) * 100) : 0;
  const color = pct >= 100 ? 'bg-red-500' : pct >= 60 ? 'bg-amber-500' : 'bg-blue-500';
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-24 overflow-hidden rounded-full bg-slate-200" role="img" aria-label={`${running} of ${limit} slots in use`}>
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="tabular-nums text-xs text-slate-600">
        {running}/{limit}
      </span>
    </div>
  );
}
