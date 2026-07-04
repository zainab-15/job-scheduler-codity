import type { JobStatus } from '../api/types';

const TERMINAL: ReadonlySet<JobStatus> = new Set(['completed', 'dead', 'cancelled']);

/** Mirrors the backend's lifecycle.isTerminal — drives "stop polling on terminal". */
export function isTerminal(status: JobStatus | undefined): boolean {
  return status ? TERMINAL.has(status) : false;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diffMs = Date.now() - then;
  const abs = Math.abs(diffMs);
  const sign = diffMs >= 0 ? 'ago' : 'from now';
  const sec = Math.round(abs / 1000);
  if (sec < 60) return `${sec}s ${sign}`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ${sign}`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ${sign}`;
  const day = Math.round(hr / 24);
  return `${day}d ${sign}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 1000) / 10}%`;
}
