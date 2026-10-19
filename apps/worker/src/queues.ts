import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { captureError } from '@marchmaker/api/sentry';
import type { OutboxEvent } from './outbox';

export const QUEUE_NAMES = { events: 'domain-events', deadLetter: 'dead-letter' } as const;

export type EventHandler = (event: { eventType: string; payload: unknown }, job: Job) => Promise<void>;

/** Handlers are registered per event type by later phases (notifications, matching, billing...). */
const handlers = new Map<string, EventHandler[]>();
/** Several consumers may react to one event (e.g. billing renders a PDF, notifications tell the member). */
export function registerHandler(eventType: string, handler: EventHandler): void {
  handlers.set(eventType, [...(handlers.get(eventType) ?? []), handler]);
}

/**
 * Development without Redis: runs the registered handlers straight away in this process, so photos get processed and
 * emails get sent. There are no retries or dead-letter queue here; a failure is thrown back to the outbox relay,
 * which tries again later. Production always uses the Redis queue.
 */
export async function dispatchInProcess(event: OutboxEvent): Promise<void> {
  const list = handlers.get(event.eventType);
  if (!list?.length) return;
  const job = { id: event.id, name: event.eventType, data: event.payload ?? {}, attemptsMade: 0, opts: { attempts: 1 } } as unknown as Job;
  for (const handler of list) await handler({ eventType: event.eventType, payload: event.payload ?? {} }, job);
}

export interface Queues {
  publish: (event: OutboxEvent) => Promise<void>;
  close: () => Promise<void>;
}

export function startQueues(redisUrl: string, log: Logger): Queues {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const events = new Queue(QUEUE_NAMES.events, {
    connection,
    defaultJobOptions: {
      attempts: 6,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 24 * 3600, count: 5_000 },
      removeOnFail: false,
    },
  });
  const deadLetter = new Queue(QUEUE_NAMES.deadLetter, { connection });

  const worker = new Worker(
    QUEUE_NAMES.events,
    async (job) => {
      const list = handlers.get(job.name);
      if (!list?.length) {
        log.warn({ eventType: job.name }, 'no handler registered; event acknowledged');
        return;
      }
      // Each consumer is idempotent, so a retry after a partial failure is safe.
      for (const handler of list) await handler({ eventType: job.name, payload: job.data }, job);
    },
    { connection, concurrency: 10 },
  );

  worker.on('failed', async (job, err) => {
    if (!job) return;
    log.warn({ eventType: job.name, attempt: job.attemptsMade, err: err.message }, 'job failed');
    if (job.attemptsMade >= (job.opts.attempts ?? 1)) captureError(err, { job: job.name });
    if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
      await deadLetter.add(job.name, { original: job.data, error: err.message, failedAt: new Date().toISOString() });
    }
  });

  return {
    // Using the outbox id as jobId makes publishing idempotent.
    publish: async (event) => {
      await events.add(event.eventType, event.payload ?? {}, { jobId: event.id });
    },
    close: async () => {
      await worker.close();
      await events.close();
      await deadLetter.close();
      connection.disconnect();
    },
  };
}
