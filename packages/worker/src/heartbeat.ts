import type { Logger } from 'pino';
import { type DB, heartbeatWorker } from '@scheduler/shared';

/**
 * Periodic worker liveness + lease-extend. Callers MUST keep this alive
 * during graceful drain (only stop it once the drain window has closed) —
 * stopping it early lets a genuinely-alive worker's in-flight job leases
 * lapse, letting the reaper reclaim (and double-run) a job that's still
 * finishing (R14).
 */
export class HeartbeatLoop {
  private stopping = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private db: DB,
    private workerId: string,
    private intervalMs: number,
    private leaseSeconds: number,
    private runningIds: () => string[],
    private log: Logger,
  ) {}

  start(): void {
    this.schedule();
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => void this.beat(), this.intervalMs);
  }

  private async beat(): Promise<void> {
    if (this.stopping) return;
    try {
      await heartbeatWorker(this.db, {
        workerId: this.workerId,
        jobIds: this.runningIds(),
        leaseSeconds: this.leaseSeconds,
      });
    } catch (err) {
      this.log.error({ err }, 'heartbeat failed');
    }
    this.schedule();
  }
}
