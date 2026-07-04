import type { JobStatus } from '../db/types.js';

/**
 * The job state machine. "Claimed" is NOT a persisted status (it is the
 * claimed_at timestamp set inside the atomic claim); the claim transitions
 * queued -> running directly. `dead -> queued` is the manual-retry edge (R6).
 * `cancelled` is its own terminal state, NOT a route through `dead` (R7) —
 * collapsing a user cancel into `dead` would pollute the DLQ with jobs that
 * never actually failed.
 */
const EDGES: Record<JobStatus, JobStatus[]> = {
  queued: ['running', 'cancelled'], // claim, cancel
  scheduled: ['queued', 'cancelled'], // promote, cancel
  running: ['completed', 'retrying', 'queued', 'dead'], // success, retry, reclaim-requeue, fail/reclaim-final
  retrying: ['queued', 'cancelled'], // promote, cancel
  completed: [],
  dead: ['queued'], // manual retry / DLQ requeue
  cancelled: [], // terminal, one-way — no "un-cancel"; re-enqueue as a new job if needed
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return EDGES[from].includes(to);
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal job transition: ${from} -> ${to}`);
  }
}

const TERMINAL: ReadonlySet<JobStatus> = new Set(['completed', 'dead', 'cancelled']);
export function isTerminal(status: JobStatus): boolean {
  return TERMINAL.has(status);
}
