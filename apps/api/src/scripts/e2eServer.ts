/**
 * API for the browser end-to-end tests. It starts a throwaway in-memory MongoDB replica set, seeds
 * the minimum (legal documents, plans, one staff account with two-factor on) and exposes three
 * test-only helpers under /__e2e. NEVER run this against real data: it refuses to start in production.
 */
import { createServer } from 'node:http';
import express from 'express';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { generateSecret } from 'otplib';
import { DEFAULT_PACKS, DEFAULT_PLANS } from '@marchmaker/shared';
import { createApp } from '../app';
import { loadEnv } from '../config/env';
import { buildContext } from '../context';
import { createLogger } from '../lib/logger';
import { MemoryMailer } from '../lib/mailer';
import { hashPassword } from '../lib/passwords';
import { MemorySms } from '../lib/sms';
import { LegalDocument } from '../models/auth';
import { Plan } from '../models/content';
import { Outbox, User } from '../models/core';
import { dispatchEvent } from '../services/notifications';
import { releaseDueMatches } from '../services/matchReview';
import { MatchSuggestion } from '../models/matching';
import { Photo, Preference, Profile } from '../models/profile';
import { Verification } from '../models/verification';
import { LEGAL_SEEDS } from './legalSeed';

if (process.env.NODE_ENV === 'production') throw new Error('The e2e server must never run in production');

const PORT = Number(process.env.E2E_API_PORT ?? 4000);
const STAFF = { email: 'staff@e2e.test', password: 'E2e-Staff-Pass-1' };

async function main() {
  const mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongod.getUri());

  const env = loadEnv({ NODE_ENV: 'test', EXPORT_DIR: './.data/e2e-exports' } as NodeJS.ProcessEnv);
  const log = createLogger('warn');
  const mailer = new MemoryMailer();
  const ctx = buildContext({ env, log, mailer, sms: new MemorySms() });
  const api = createApp({ env, log, ctx, isReady: () => true });

  for (const d of LEGAL_SEEDS) {
    await LegalDocument.updateOne({ type: d.type, version: d.version }, { $setOnInsert: { ...d, effectiveDate: new Date('2026-01-01'), material: true } }, { upsert: true });
  }
  for (const p of [...DEFAULT_PLANS, ...DEFAULT_PACKS]) {
    await Plan.updateOne({ code: p.code }, { $setOnInsert: { ...p, active: true } }, { upsert: true });
  }

  // A super admin whose authenticator secret the tests know, so they can sign in properly.
  const secret = generateSecret();
  await User.create({
    email: STAFF.email,
    passwordHash: await hashPassword(STAFF.password),
    firstName: 'Ops',
    gender: 'woman',
    dobEnc: ctx.crypto.encrypt('1985-05-05'),
    dobYear: 1985,
    roles: ['super_admin'],
    emailVerifiedAt: new Date(),
    twoFactor: { enabled: true, secretEnc: ctx.crypto.encrypt(secret) },
  });

  // No worker runs in this setup, so a tiny in-process relay turns domain events into notifications.
  const relay = setInterval(async () => {
    try {
      for (let i = 0; i < 20; i++) {
        const ev = await Outbox.findOneAndUpdate({ status: 'pending' }, { $set: { status: 'dispatched' } }, { sort: { createdAt: 1 }, returnDocument: 'after' });
        if (!ev) break;
        await dispatchEvent(ctx, ev.eventType, (ev.payload ?? {}) as Record<string, unknown>, String(ev._id)).catch(() => undefined);
      }
    } catch {
      // keep going
    }
  }, 400);
  relay.unref();

  const outer = express();
  outer.get('/__e2e/ready', (_req, res) => res.json({ ok: true }));
  outer.get('/__e2e/staff', (_req, res) => res.json({ ...STAFF, secret }));
  outer.get('/__e2e/mail', (req, res) => {
    const to = String(req.query.to ?? '');
    const m = [...mailer.sent].reverse().find((x) => x.to === to);
    res.json(m ? { subject: m.subject, html: m.html, text: m.text } : null);
  });

  /**
   * Test-only: a member who has finished the profile and uploaded their documents, waiting for the team.
   * The browser cannot upload to the in-memory storage, so this stands in for those two steps; everything
   * after (reviews, matching, introductions, payment, messages) is driven through the real screens.
   */
  const seedMember = async (o: { email: string; firstName: string; gender: 'woman' | 'man'; dobYear: number; password: string }) => {
    const user = await User.create({
      email: o.email,
      passwordHash: await hashPassword(o.password),
      firstName: o.firstName,
      gender: o.gender,
      dobEnc: ctx.crypto.encrypt(`${o.dobYear}-04-10`),
      dobYear: o.dobYear,
      roles: ['member'],
      emailVerifiedAt: new Date(),
      lastActiveAt: new Date(),
      journeyState: 'profile_submitted',
    });
    const data = {
      basics: { firstName: o.firstName, heightCm: o.gender === 'woman' ? 163 : 176, maritalStatus: 'never_married', hasChildren: false },
      background: { religion: 'Hindu', motherTongue: 'Hindi', city: 'Pune', state: 'Maharashtra', country: 'India', coordinates: [73.86, 18.52] },
      education_career: { highestEducation: 'Masters', profession: 'Product manager' },
      family: { familyType: 'nuclear', familyValues: 'moderate' },
      lifestyle: { diet: 'vegetarian', smoking: 'never', drinking: 'never', fitness: 'sometimes' },
      values: { marriageTimeline: 'within_1_year', wantsKids: 'yes', livingWithFamily: 'open', settleCity: 'Pune' },
      about: { bio: 'I like quiet weekends, long walks and cooking with my family. I am looking for someone kind and honest.', prompts: [] },
      photos: {},
    };
    await Profile.create({
      userId: user._id,
      data,
      completedSteps: ['basics', 'background', 'education_career', 'family', 'lifestyle', 'values', 'about', 'photos'],
      currentStep: 'photos',
      status: 'submitted',
      birthYear: o.dobYear,
      gender: o.gender,
      geo: { type: 'Point', coordinates: [73.86, 18.52] },
      submittedAt: new Date(),
    });
    await Preference.create({
      userId: user._id,
      dimensions: [
        { key: 'age', range: { min: 24, max: 42 }, values: [], type: 'must', importance: 3 },
        { key: 'religion', values: ['Hindu'], type: 'flexible', importance: 2 },
        { key: 'marriage_timeline', values: ['within_1_year'], type: 'flexible', importance: 2 },
      ],
    });
    const key = `e2e/${String(user._id)}/lg.webp`;
    await ctx.storage.put('photos', key, Buffer.from('e2e-photo'), 'image/webp');
    await Photo.create({ userId: user._id, key: `${key}.raw`, variants: { sm: key, md: key, lg: key, blur: key }, contentType: 'image/webp', width: 1080, height: 1350, isPrimary: true, order: 0, status: 'pending', hash: `e2e-${String(user._id)}` });
    const ev = async (kind: string) => {
      const k = `e2e/${String(user._id)}/${kind}.jpg`;
      await ctx.storage.put('identity', k, Buffer.from('e2e-id'), 'image/jpeg');
      return { key: k, contentType: 'image/jpeg', sizeBytes: 6, uploadedAt: new Date() };
    };
    await Verification.create({
      userId: user._id,
      method: 'manual',
      status: 'pending',
      docType: 'pan',
      docLast4: '1234',
      evidence: { id_front: await ev('id_front'), id_back: await ev('id_back'), selfie: await ev('selfie') },
      submittedAt: new Date(),
    });
    return String(user._id);
  };
  outer.use(express.json());
  outer.post('/__e2e/member', async (req, res) => {
    try {
      res.json({ id: await seedMember(req.body) });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });
  /** Skips the ten-minute cool-off after a match is approved, then releases what is due. */
  outer.post('/__e2e/release', async (_req, res) => {
    await MatchSuggestion.updateMany({ status: 'approved', releasedAt: { $exists: false } }, { $set: { releaseAt: new Date(Date.now() - 1000) } });
    const n = await releaseDueMatches(ctx);
    res.json({ released: n });
  });
  outer.use(api);

  const server = createServer(outer);
  server.listen(PORT, () => log.warn({ port: PORT }, 'e2e api listening'));
  const stop = async () => {
    server.close();
    await mongoose.disconnect();
    await mongod.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
