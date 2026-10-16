import 'dotenv/config';
import { connectMongo, disconnectMongo } from '@marchmaker/api/db';
import { loadEnv } from '@marchmaker/api/env';
import { createLogger } from '@marchmaker/api/logger';
import { createWorkerContext, registerHandlers, runReleaseTick, runSweeps } from './handlers';
import { relayOutboxOnce } from './outbox';
import { startQueues, type Queues } from './queues';

async function main() {
  const env = loadEnv();
  const log = createLogger(env.LOG_LEVEL, env.NODE_ENV === 'development');
  await connectMongo(env.MONGODB_URI, log);

  const ctx = createWorkerContext(env, log);
  registerHandlers(ctx);

  let queues: Queues | undefined;
  if (env.REDIS_URL) {
    queues = startQueues(env.REDIS_URL, log);
  } else {
    log.warn('REDIS_URL not set: outbox events are logged but not processed (dev mode)');
  }

  const publish =
    queues?.publish ??
    (async (e) => {
      log.info({ eventType: e.eventType, id: e.id }, 'outbox event (no queue configured)');
    });

  let stopping = false;
  const loop = (async () => {
    while (!stopping) {
      try {
        const n = await relayOutboxOnce({ publish });
        if (n === 0) await new Promise((r) => setTimeout(r, 1_000));
      } catch (err) {
        log.error({ err }, 'outbox relay error');
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
  })();

  const sweep = setInterval(() => {
    runSweeps(ctx).catch((err) => log.error({ err }, 'sweep failed'));
  }, 10 * 60_000);

  const release = setInterval(() => {
    runReleaseTick(ctx).catch((err) => log.error({ err }, 'release tick failed'));
  }, 60_000);

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    clearInterval(sweep);
    clearInterval(release);
    log.info({ signal }, 'worker shutting down');
    await loop;
    await queues?.close();
    await disconnectMongo();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  log.info('worker started');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
