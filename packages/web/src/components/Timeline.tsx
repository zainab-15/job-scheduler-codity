import { formatDateTime } from '../lib/format';
import type { JobDetail } from '../api/types';

interface Step {
  label: string;
  at: string | null;
  state: 'done' | 'current' | 'pending' | 'failed';
  note?: string;
}

// R20: drive the lifecycle timeline from the job row + its executions, not from
// pretending the 4 scalar timestamps are a linear happy path. This renders
// scheduled-in-the-future, multi-attempt/retrying, and terminal states
// truthfully, and fuses the claimed_at==started_at 0ms artifact into one step.
export function Timeline({ detail }: { detail: JobDetail }) {
  const { job, executions } = detail;
  const steps: Step[] = [];

  steps.push({ label: 'Created', at: job.created_at, state: 'done' });

  // Scheduled/delayed jobs: show the future run_at as its own step.
  if ((job.type === 'delayed' || job.type === 'scheduled') && !job.claimed_at) {
    const future = new Date(job.run_at).getTime() > Date.now();
    steps.push({
      label: future ? `Scheduled for ${formatDateTime(job.run_at)}` : 'Due',
      at: job.run_at,
      state: future ? 'current' : 'done',
    });
  }

  // Claimed/Started fused (they're set in the same claim tx — a 0ms gap).
  if (job.claimed_at) {
    steps.push({ label: 'Claimed / Started', at: job.claimed_at, state: 'done' });
  }

  // One step per execution attempt, so retries are visible.
  const attempts = [...executions].sort((a, b) => a.attempt - b.attempt);
  for (const ex of attempts) {
    const failed = ex.status === 'failed';
    steps.push({
      label: `Attempt ${ex.attempt} — ${ex.status}`,
      at: ex.finished_at ?? ex.started_at,
      state: ex.status === 'running' ? 'current' : failed ? 'failed' : 'done',
      note: ex.error ?? undefined,
    });
  }

  // Terminal cap.
  if (job.status === 'completed') steps.push({ label: 'Completed', at: job.finished_at, state: 'done' });
  else if (job.status === 'dead') steps.push({ label: `Dead — ${job.death_reason ?? 'failed'}`, at: job.finished_at, state: 'failed', note: job.last_error ?? undefined });
  else if (job.status === 'cancelled') steps.push({ label: 'Cancelled', at: job.updated_at, state: 'failed' });
  else if (job.status === 'retrying') steps.push({ label: `Retrying — next run ${formatDateTime(job.run_at)}`, at: job.run_at, state: 'current' });

  const dotClass = (s: Step['state']) =>
    s === 'failed' ? 'bg-red-500' : s === 'current' ? 'bg-blue-500 animate-pulse' : s === 'pending' ? 'bg-slate-300' : 'bg-emerald-500';

  return (
    <ol className="relative ml-2 border-l border-slate-200 pl-4">
      {steps.map((s, i) => (
        <li key={i} className="mb-4 last:mb-0">
          <span className={`absolute -left-[7px] mt-1 h-3 w-3 rounded-full ring-4 ring-white ${dotClass(s.state)}`} aria-hidden />
          <div className="text-sm font-medium text-slate-800">{s.label}</div>
          <div className="text-xs text-slate-500">{formatDateTime(s.at)}</div>
          {s.note && <div className="mt-0.5 rounded bg-red-50 px-2 py-1 font-mono text-xs text-red-700">{s.note}</div>}
        </li>
      ))}
    </ol>
  );
}
