import 'dotenv/config';
import mongoose from 'mongoose';
import { loadEnv } from '../config/env';
import { connectMongo, disconnectMongo } from '../db/connection';
import { createLogger } from '../lib/logger';
import '../models';

/**
 * Production starts with autoIndex off (building indexes on a busy primary at boot is risky), so indexes,
 * unique constraints and TTLs are created here, as a release step after migrations:
 *   pnpm --filter @marchmaker/api sync-indexes
 * It only ever creates missing indexes. Dropping an index is always an explicit migration.
 */
export async function createAllIndexes(log: { info: (o: object, m: string) => void }) {
  let n = 0;
  for (const model of Object.values(mongoose.models)) {
    await model.createIndexes();
    n++;
  }
  log.info({ models: n }, 'indexes ensured');
  return n;
}

if (process.argv[1]?.includes('syncIndexes')) {
  const env = loadEnv();
  const log = createLogger('info', true);
  connectMongo(env.MONGODB_URI, log)
    .then(() => createAllIndexes(log))
    .then(() => disconnectMongo())
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}
