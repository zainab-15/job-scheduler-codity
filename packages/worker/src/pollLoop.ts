import type { Logger } from 'pino';
import { type ClaimedRow, type DB, claimJobs, listClaimableQueueIds } from '@scheduler/shared';

export interface PollLoopConfig {
  pollIntervalMs: number;
  leaseSeconds: number;
  batchCap?: number;
}

export class PollLoop {
  private stopping = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private db: DB,
    private workerId: string,
    private cfg: PollLoopConfig,
    /** LIVE read of this worker's remaining capacity — re-invoked before EACH
     *  per-queue claim below, never cached once per tick (D2-Eng-5): a
     *  per-tick snapshot can locally over-claim past WORKER_CONCURRENCY across
     *  multiple queues in one tick, exhausting the local pool/connection
     *  budget under --scale even though the DB per-queue limit still holds. */
    private freeSlots: () => number,
    private onClaimed: (row: ClaimedRow) => void,
    private log: Logger,
  ) {}

  start(): void {
    this.scheduleNext(0);
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;
    let claimedTotal = 0;
    try {
      claimedTotal = await this.pollOnce();
    } catch (err) {
      this.log.error({ err }, 'poll tick failed'); // never let a throw kill the loop
    }
    if (this.stopping) return;
    // drain the backlog immediately if we filled capacity; otherwise jittered sleep
    // (±20%, R9) so co-started workers don't lockstep-hammer the same advisory lock
    const jitter = this.cfg.pollIntervalMs * (0.8 + Math.random() * 0.4);
    const delay = claimedTotal > 0 && this.freeSlots() === 0 ? 0 : jitter;
    this.scheduleNext(delay);
  }

  private async pollOnce(): Promise<number> {
    let claimedTotal = 0;
    const queueIds = await listClaimableQueueIds(this.db);
    for (const queueId of queueIds) {
      const free = this.freeSlots();
      if (free <= 0) break; // local capacity exhausted this tick
      const rows = await claimJobs(this.db, {
        queueId,
        workerId: this.workerId,
        localFree: free,
        leaseSeconds: this.cfg.leaseSeconds,
        batchCap: this.cfg.batchCap,
      });
      for (const row of rows) {
        this.onClaimed(row); // synchronously registers into the running map before the next queue's freeSlots() read
        claimedTotal++;
      }
    }
    return claimedTotal;
  }
}
