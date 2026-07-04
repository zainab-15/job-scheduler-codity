import type { JobStatus, Liveness } from '../api/types';

// R17/R22: the ONE status → {label, color} map. Every StatusPill and legend
// reads this so a status can't render as a different color on different pages.
// Colors are Tailwind class fragments; label is always shown (never color alone).
export interface StatusStyle {
  label: string;
  // background + text + ring classes for a pill
  pill: string;
  // a solid dot/bar color (hex) for charts and saturation bars
  hex: string;
}

export const JOB_STATUS_STYLE: Record<JobStatus, StatusStyle> = {
  queued: { label: 'Queued', pill: 'bg-slate-100 text-slate-700 ring-slate-300', hex: '#64748b' },
  scheduled: { label: 'Scheduled', pill: 'bg-violet-100 text-violet-700 ring-violet-300', hex: '#8b5cf6' },
  running: { label: 'Running', pill: 'bg-blue-100 text-blue-700 ring-blue-300', hex: '#3b82f6' },
  retrying: { label: 'Retrying', pill: 'bg-amber-100 text-amber-800 ring-amber-300', hex: '#f59e0b' },
  completed: { label: 'Completed', pill: 'bg-emerald-100 text-emerald-700 ring-emerald-300', hex: '#10b981' },
  dead: { label: 'Dead', pill: 'bg-red-100 text-red-700 ring-red-300', hex: '#ef4444' },
  cancelled: { label: 'Cancelled', pill: 'bg-slate-200 text-slate-600 ring-slate-400', hex: '#94a3b8' },
};

export const LIVENESS_STYLE: Record<Liveness, StatusStyle> = {
  alive: { label: 'Alive', pill: 'bg-emerald-100 text-emerald-700 ring-emerald-300', hex: '#10b981' },
  draining: { label: 'Draining', pill: 'bg-amber-100 text-amber-800 ring-amber-300', hex: '#f59e0b' },
  dead: { label: 'Dead', pill: 'bg-red-100 text-red-700 ring-red-300', hex: '#ef4444' },
};

export const EXECUTION_STYLE: Record<string, StatusStyle> = {
  running: { label: 'Running', pill: 'bg-blue-100 text-blue-700 ring-blue-300', hex: '#3b82f6' },
  succeeded: { label: 'Succeeded', pill: 'bg-emerald-100 text-emerald-700 ring-emerald-300', hex: '#10b981' },
  failed: { label: 'Failed', pill: 'bg-red-100 text-red-700 ring-red-300', hex: '#ef4444' },
};

export const ALL_JOB_STATUSES: JobStatus[] = ['queued', 'scheduled', 'running', 'retrying', 'completed', 'dead', 'cancelled'];
export const ALL_JOB_TYPES = ['immediate', 'delayed', 'scheduled', 'recurring', 'batch'] as const;
