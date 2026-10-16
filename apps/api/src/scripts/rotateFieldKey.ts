/**
 * Re-encrypts every encrypted field with the current key. Safe to run repeatedly and while the
 * service is running: each document is rewritten only if its ciphertext uses an older key version.
 *
 * Rotation procedure (docs/RUNBOOK.md):
 *   1. Generate a new key. Set FIELD_ENCRYPTION_KEY_VERSION to the next number, FIELD_ENCRYPTION_KEY to the
 *      new key, and move the old key into FIELD_ENCRYPTION_KEYS_PREVIOUS. Keep FIELD_BLIND_INDEX_KEY unchanged.
 *   2. Deploy. New writes use the new key; old data is still readable.
 *   3. Run:  pnpm --filter @marchmaker/api exec tsx src/scripts/rotateFieldKey.ts   (add --dry-run first)
 *   4. When the report shows 0 remaining, the old key can be removed from FIELD_ENCRYPTION_KEYS_PREVIOUS.
 */
import 'dotenv/config';
import type { Model } from 'mongoose';
import { loadEnv } from '../config/env';
import { connectMongo, disconnectMongo } from '../db/connection';
import { fieldCryptoFromEnv, resolveKmsKeys } from '../lib/keys';
import { createLogger } from '../lib/logger';
import { User } from '../models/core';
import { AstroProfile } from '../models/extras';
import { Profile } from '../models/profile';

interface Target {
  name: string;
  // Each collection has its own document type; this script only needs find() and the raw collection.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: Model<any>;
  /** Dotted paths of encrypted string fields. */
  paths: string[];
  /** Paths that are `select: false` and must be requested explicitly. */
  select: string;
}

const TARGETS: Target[] = [
  { name: 'users', model: User, paths: ['dobEnc', 'phoneEnc', 'twoFactor.secretEnc'], select: '+twoFactor.secretEnc dobEnc phoneEnc' },
  { name: 'profiles', model: Profile, paths: ['sensitive.incomeBandEnc', 'sensitive.healthNotesEnc'], select: 'sensitive' },
  { name: 'astroprofiles', model: AstroProfile, paths: ['birthEnc'], select: 'birthEnc' },
];

const get = (obj: unknown, path: string): unknown => path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);

async function main() {
  const dry = process.argv.includes('--dry-run');
  const env = await resolveKmsKeys(loadEnv());
  const log = createLogger('info', true);
  const crypto = fieldCryptoFromEnv(env);
  await connectMongo(env.MONGODB_URI, log);

  let rotated = 0;
  let remaining = 0;
  for (const t of TARGETS) {
    const cursor = t.model.find().select(t.select).lean().cursor();
    let n = 0;
    for await (const doc of cursor) {
      const set: Record<string, string> = {};
      for (const p of t.paths) {
        const v = get(doc, p);
        if (typeof v === 'string' && crypto.needsRotation(v)) set[p] = crypto.rotate(v);
      }
      if (!Object.keys(set).length) continue;
      n++;
      if (dry) remaining += Object.keys(set).length;
      else await t.model.collection.updateOne({ _id: (doc as { _id: unknown })._id } as never, { $set: set });
    }
    rotated += dry ? 0 : n;
    log.info({ collection: t.name, documents: n, dryRun: dry }, dry ? 'would re-encrypt' : 're-encrypted');
  }
  log.info({ rotated, remaining, currentVersion: crypto.version }, 'done');
  await disconnectMongo();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
