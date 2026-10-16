import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export type QueueKey = 'events' | 'dead-letter';
export const QUEUE_NAMES: Record<QueueKey, string> = { events: 'domain-events', 'dead-letter': 'dead-letter' };

export interface QueueCounts {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
}

export interface FailedJob {
  id: string;
  name: string;
  attemptsMade: number;
  failedReason: string;
  failedAt: string | null;
  /** The keys of the payload, never its values, so no personal data is shown. */
  payloadKeys: string[];
}

/** What staff can do to the job queues. A fake implements this in tests. */
export interface JobsAdmin {
  counts(): Promise<Record<QueueKey, QueueCounts>>;
  failed(queue: QueueKey, limit: number): Promise<FailedJob[]>;
  retry(queue: QueueKey, id: string): Promise<boolean>;
  remove(queue: QueueKey, id: string): Promise<boolean>;
  close(): Promise<void>;
}

const keysOf = (data: unknown): string[] => (data && typeof data === 'object' ? Object.keys(data as object).slice(0, 12) : []);

/** BullMQ implementation, on its own Redis connection (BullMQ needs one that never gives up on a command). */
export class BullJobsAdmin implements JobsAdmin {
  private conn?: Redis;
  private qs?: Record<QueueKey, Queue>;
  constructor(private readonly redisUrl: string) {}
  /** Connects on first use, so processes that never open the queue console hold no extra connection. */
  private get queues(): Record<QueueKey, Queue> {
    if (!this.qs) {
      this.conn = new Redis(this.redisUrl, { maxRetriesPerRequest: null });
      this.conn.on('error', () => undefined);
      this.qs = {
        events: new Queue(QUEUE_NAMES.events, { connection: this.conn }),
        'dead-letter': new Queue(QUEUE_NAMES['dead-letter'], { connection: this.conn }),
      };
    }
    return this.qs;
  }
  async counts() {
    const out = {} as Record<QueueKey, QueueCounts>;
    for (const k of Object.keys(this.queues) as QueueKey[]) {
      const c = await this.queues[k].getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
      out[k] = { waiting: c.waiting ?? 0, active: c.active ?? 0, delayed: c.delayed ?? 0, failed: c.failed ?? 0, completed: c.completed ?? 0 };
    }
    return out;
  }
  async failed(queue: QueueKey, limit: number) {
    // The dead-letter queue stores jobs as waiting; the events queue keeps real failures.
    const jobs = queue === 'events' ? await this.queues.events.getFailed(0, limit - 1) : await this.queues['dead-letter'].getWaiting(0, limit - 1);
    return jobs.map((j) => ({
      id: String(j.id),
      name: j.name,
      attemptsMade: j.attemptsMade,
      failedReason: String(j.failedReason ?? (j.data as { error?: string })?.error ?? '').slice(0, 300),
      failedAt: j.finishedOn ? new Date(j.finishedOn).toISOString() : j.timestamp ? new Date(j.timestamp).toISOString() : null,
      payloadKeys: keysOf(queue === 'dead-letter' ? (j.data as { original?: unknown })?.original : j.data),
    }));
  }
  async retry(queue: QueueKey, id: string) {
    const q = this.queues[queue];
    const job = await q.getJob(id);
    if (!job) return false;
    if (queue === 'events') {
      await job.retry();
    } else {
      // Put the original event back on the main queue and drop the dead-letter record.
      const data = job.data as { original?: unknown };
      await this.queues.events.add(job.name, data.original ?? {}, { attempts: 6, backoff: { type: 'exponential', delay: 5_000 } });
      await job.remove();
    }
    return true;
  }
  async remove(queue: QueueKey, id: string) {
    const job = await this.queues[queue].getJob(id);
    if (!job) return false;
    await job.remove();
    return true;
  }
  async close() {
    if (!this.qs) return;
    await Promise.all(Object.values(this.qs).map((q) => q.close()));
    this.conn?.disconnect();
  }
}
