/* eslint-disable no-console -- a command-line tool: its output is the console */
import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadEnv } from '../config/env';
import { connectMongo, disconnectMongo } from '../db/connection';
import { createLogger } from '../lib/logger';
import { MongoStorage, S3Storage, type Bucket, type ObjectStorage } from '../lib/storage';

/**
 * Copies files saved by the local development storage (STORAGE_PROVIDER=local) into the deployed storage, keeping every
 * key the same, so photos and ID images uploaded on a development machine open on a deployed site.
 *
 * To the database (STORAGE_PROVIDER=mongo on the server):
 *   set MONGODB_URI, then: pnpm --filter @marchmaker/api storage:copy-local -- --to=mongo [--dry-run]
 * To S3-compatible buckets:
 *   set S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_IDENTITY_ACCESS_KEY_ID and S3_IDENTITY_SECRET_ACCESS_KEY,
 *   then: pnpm --filter @marchmaker/api storage:copy-local [--dry-run]
 *
 * Safe to run again: an existing object is replaced with the same content. It never deletes anything it did not write.
 */
const BUCKETS: Bucket[] = ['photos', 'identity', 'documents'];
const TYPES: Record<string, string> = { '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.pdf': 'application/pdf', '.zip': 'application/zip' };

async function* walk(dir: string, base = dir): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full, base);
    else if (!e.name.endsWith('.type')) yield path.relative(base, full).split(path.sep).join('/');
  }
}

async function main() {
  const dry = process.argv.includes('--dry-run');
  const toMongo = process.argv.includes('--to=mongo');
  const env = loadEnv({ ...process.env, STORAGE_PROVIDER: toMongo ? 'mongo' : 's3' } as NodeJS.ProcessEnv);
  if (!toMongo && (!env.S3_ENDPOINT || !env.S3_ACCESS_KEY_ID || env.S3_ACCESS_KEY_ID === 'minioadmin')) {
    throw new Error('Set S3_ENDPOINT and the real S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY (and the S3_IDENTITY_* pair) for the destination, or use --to=mongo.');
  }
  const root = path.resolve(env.LOCAL_STORAGE_DIR);
  let store: ObjectStorage;
  if (toMongo) {
    if (!dry) await connectMongo(env.MONGODB_URI, createLogger('error'));
    store = new MongoStorage(env.JWT_REFRESH_SECRET);
    console.log(`Destination: the MongoDB database${dry ? ' (dry run, nothing is written)' : ''}`);
  } else {
    store = new S3Storage(env);
  }

  let copied = 0;
  let failed = 0;
  for (const bucket of BUCKETS) {
    const dir = path.join(root, bucket);
    for await (const key of walk(dir)) {
      const file = path.join(dir, key);
      const type = (await readFile(`${file}.type`, 'utf8').catch(() => '')) || TYPES[path.extname(key).toLowerCase()] || 'application/octet-stream';
      if (dry) {
        console.log(`would copy ${bucket}/${key} (${type})`);
        copied++;
        continue;
      }
      try {
        await store.put(bucket, key, await readFile(file), type);
        copied++;
      } catch (err) {
        failed++;
        console.error(`FAILED ${bucket}/${key}: ${(err as Error).message}`);
      }
    }
  }
  console.log(`${dry ? 'Would copy' : 'Copied'} ${copied} file(s) from ${root}${failed ? `; ${failed} failed` : ''}.`);
  if (toMongo && !dry) await disconnectMongo();
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
