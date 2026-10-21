import 'dotenv/config';
import { createServer } from 'node:http';
import { createApp } from './app';
import { buildContext } from './context';
import { createMailer } from './lib/mailer';
import { createSms } from './lib/sms';
import { loadEnv, staffMfaBypass } from './config/env';
import { resolveKmsKeys } from './lib/keys';
import { captureError, initSentry, flushSentry } from './lib/sentry';
import { connectMongo, disconnectMongo, isMongoReady } from './db/connection';
import { createLogger } from './lib/logger';

async function main() {
  // The field-encryption key may be stored wrapped by KMS; it is unwrapped once here, in memory only.
  const env = await resolveKmsKeys(loadEnv());
  initSentry(env, 'api');
  const log = createLogger(env.LOG_LEVEL, env.NODE_ENV === 'development');

  const mfaBypass = staffMfaBypass(env);
  if (env.NODE_ENV === 'production' && mfaBypass.active) {
    log.warn(
      { until: mfaBypass.until?.toISOString() },
      'SECURITY: staff can sign in WITHOUT an authenticator code until the date shown. Remove STAFF_MFA_REQUIRED=false and STAFF_MFA_OFF_UNTIL to require the code again.',
    );
  }

  let shuttingDown = false;
  await connectMongo(env.MONGODB_URI, log);

  const ctx = buildContext({ env, log, mailer: createMailer(env, log), sms: createSms(env, log) });
  const app = createApp({ env, log, ctx, isReady: () => !shuttingDown && isMongoReady() });
  const server = createServer(app);
  server.keepAliveTimeout = 65_000;
  server.listen(env.PORT, () => log.info({ port: env.PORT }, 'api listening'));

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    server.close(async () => {
      await ctx.jobs?.close().catch(() => undefined);
      await ctx.redis?.quit().catch(() => undefined);
      await disconnectMongo().catch(() => undefined);
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => {
    log.error({ err }, 'unhandledRejection');
    captureError(err);
  });
  process.on('beforeExit', () => void flushSentry());
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
