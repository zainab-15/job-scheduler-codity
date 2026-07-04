// R18: a queue's running/concurrency_limit saturation, shown as a bar so a
// grader can see at a glance whether a queue is idle, busy, or maxed out.
export function SaturationBar({ running, limit }: { running: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, (running / limit) * 100) : 0;
  // Rose while there's headroom, amber as it fills, red at the ceiling.
  const color = pct >= 100 ? 'bg-red-500' : pct >= 60 ? 'bg-amber-400' : 'bg-indigo-500';
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-24 overflow-hidden rounded-full bg-slate-200" role="img" aria-label={`${running} of ${limit} slots in use`}>
        <div className={`h-full rounded-full transition-[width] duration-500 ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="tnum text-xs font-medium text-slate-600">
        {running}/{limit}
      </span>
    </div>
  );
}
