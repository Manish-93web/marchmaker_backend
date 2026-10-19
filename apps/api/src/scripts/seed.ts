import 'dotenv/config';
import { loadEnv } from '../config/env';
import { connectMongo, disconnectMongo } from '../db/connection';
import { fieldCryptoFromEnv } from '../lib/keys';
import { createLogger } from '../lib/logger';
import { hashPassword } from '../lib/passwords';
import { LegalDocument } from '../models/auth';
import { FeatureFlag, User } from '../models/core';
import { ASSESSMENT_BANKS, DEFAULT_PACKS, DEFAULT_PLANS, FEATURE_FLAGS } from '@marchmaker/shared';
import { AssessmentDefinition } from '../models/assessment';
import { Plan } from '../models/content';
import { LEGAL_SEEDS } from './legalSeed';

/**
 * Idempotent seed: legal documents, feature flags and one super admin.
 * Usage: SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD='...' pnpm --filter @marchmaker/api seed
 * Further seed data (plans, assessments, demo members) is added by the phases that own them.
 */
async function main() {
  const env = loadEnv();
  const log = createLogger('info', true);
  await connectMongo(env.MONGODB_URI, log);

  for (const d of LEGAL_SEEDS) {
    await LegalDocument.updateOne(
      { type: d.type, version: d.version },
      { $setOnInsert: { ...d, effectiveDate: new Date('2026-01-01'), material: true } },
      { upsert: true },
    );
  }
  log.info({ count: LEGAL_SEEDS.length }, 'legal documents ensured');

  for (const p of [...DEFAULT_PLANS, ...DEFAULT_PACKS]) {
    await Plan.updateOne({ code: p.code }, { $setOnInsert: { ...p, active: true } }, { upsert: true });
  }
  log.info('plans ensured (existing admin edits are never overwritten)');

  for (const b of ASSESSMENT_BANKS) {
    await AssessmentDefinition.updateOne(
      { key: b.key, version: 1 },
      { $setOnInsert: { ...b, version: 1, active: true } },
      { upsert: true },
    );
  }
  log.info({ count: ASSESSMENT_BANKS.length }, 'assessment question banks ensured (v1)');

  for (const key of FEATURE_FLAGS) {
    await FeatureFlag.updateOne({ key }, { $setOnInsert: { key, enabled: false } }, { upsert: true });
  }
  log.info('feature flags ensured (all off by default)');

  const email = process.env.SEED_ADMIN_EMAIL?.toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (email && password) {
    // Production needs a long password; a shorter one is allowed only on a development machine.
    const minLength = env.NODE_ENV === 'production' ? 12 : 8;
    if (password.length < minLength) throw new Error(`SEED_ADMIN_PASSWORD must be at least ${minLength} characters`);
    const crypto = fieldCryptoFromEnv(env);
    await User.updateOne(
      { email },
      {
        $setOnInsert: {
          email,
          passwordHash: await hashPassword(password),
          firstName: 'Admin',
          gender: 'non_binary',
          dobEnc: crypto.encrypt('1990-01-01'),
          roles: ['super_admin'],
          emailVerifiedAt: new Date(),
          journeyState: 'email_verified',
        },
      },
      { upsert: true },
    );
    log.info('super admin ensured; two-factor setup is required at first sign-in');
  } else {
    log.info('SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set: skipping admin user');
  }

  await disconnectMongo();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
