import { EXECUTION_STYLE, JOB_STATUS_STYLE, LIVENESS_STYLE } from '../lib/status';
import type { JobStatus, Liveness } from '../api/types';

// R22: status is color + LABEL, never color alone.
function Pill({ label, pill }: { label: string; pill: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${pill}`}>
      {label}
    </span>
  );
}

export function StatusPill({ status }: { status: JobStatus }) {
  const s = JOB_STATUS_STYLE[status];
  return <Pill label={s.label} pill={s.pill} />;
}

export function LivenessPill({ liveness }: { liveness: Liveness }) {
  const s = LIVENESS_STYLE[liveness];
  return <Pill label={s.label} pill={s.pill} />;
}

export function ExecutionPill({ status }: { status: string }) {
  const s = EXECUTION_STYLE[status] ?? { label: status, pill: 'bg-slate-100 text-slate-700 ring-slate-300' };
  return <Pill label={s.label} pill={s.pill} />;
}
