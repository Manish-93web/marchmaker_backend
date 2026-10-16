import { Outbox } from '@marchmaker/api/models';

export interface OutboxEvent {
  id: string;
  eventType: string;
  payload: unknown;
}

export interface OutboxRelayOptions {
  /** Pushes one event to the job queue. Must be idempotent per event id. */
  publish: (event: OutboxEvent) => Promise<void>;
  batchSize?: number;
  maxAttempts?: number;
  now?: () => Date;
}

/** Exponential backoff with a ceiling: 5s, 10s, 20s ... up to 15 minutes. */
export function backoffMs(attempt: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, attempt - 1), 15 * 60_000);
}

/**
 * Transactional-outbox relay: picks pending events written by the API in the same
 * transaction as the state change and hands them to the queue. Safe to run on
 * several workers: each event is claimed atomically before publishing.
 * Returns the number of events dispatched.
 */
export async function relayOutboxOnce(opts: OutboxRelayOptions): Promise<number> {
  const { publish, batchSize = 50, maxAttempts = 8, now = () => new Date() } = opts;
  let dispatched = 0;

  for (let i = 0; i < batchSize; i++) {
    const claimed = await Outbox.findOneAndUpdate(
      { status: 'pending', nextRunAt: { $lte: now() } },
      { $inc: { attempts: 1 }, $set: { nextRunAt: new Date(now().getTime() + 60_000) } },
      { sort: { nextRunAt: 1 }, new: true },
    );
    if (!claimed) break;

    try {
      await publish({ id: String(claimed._id), eventType: claimed.eventType, payload: claimed.payload });
      await Outbox.updateOne({ _id: claimed._id }, { $set: { status: 'dispatched' } });
      dispatched++;
    } catch (err) {
      const attempts = claimed.attempts;
      const failed = attempts >= maxAttempts;
      await Outbox.updateOne(
        { _id: claimed._id },
        {
          $set: {
            status: failed ? 'failed' : 'pending',
            nextRunAt: new Date(now().getTime() + backoffMs(attempts)),
            lastError: err instanceof Error ? err.message.slice(0, 500) : 'unknown error',
          },
        },
      );
    }
  }
  return dispatched;
}
