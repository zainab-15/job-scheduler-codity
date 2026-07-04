import type { Logger } from 'pino';
import { type DB, markDeadWorkers, promoteDueJobs, promoteRecurring, reclaimStuckJobs } from '@scheduler/shared';

/**
 * Runs reclaim -> markDead -> promote -> promoteRecurring as four SEPARATE
 * short transactions, each independently gated by its own
 * pg_try_advisory_xact_lock(2,0) inside the query itself (D2-Eng-1). This is
 * NOT one fused leader transaction — fusing them would hold write locks on
 * the `queues` rows the claim path also touches for the whole tick,
 * head-of-line-blocking claims exactly when a killed worker's backlog needs
 * them free.
 */
export class MaintenanceLoop {
  private stopping = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private db: DB,
    private intervalMs: number,
    private staleWorkerSeconds: number,
    private log: Logger,
  ) {}

  start(): void {
    this.schedule(0);
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;
    try {
      const reclaimed = await reclaimStuckJobs(this.db);
      const deadWorkers = await markDeadWorkers(this.db, this.staleWorkerSeconds);
      const promoted = await promoteDueJobs(this.db);
      const promotedRecurring = await promoteRecurring(this.db, this.log);
      if (reclaimed || deadWorkers || promoted || promotedRecurring) {
        this.log.info({ reclaimed, deadWorkers, promoted, promotedRecurring }, 'maintenance tick');
      }
    } catch (err) {
      this.log.error({ err }, 'maintenance tick failed');
    }
    this.schedule(this.intervalMs);
  }
}
