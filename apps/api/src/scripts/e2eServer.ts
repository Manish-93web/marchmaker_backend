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
        const ev = await Outbox.findOneAndUpdate({ status: 'pending' }, { $set: { status: 'dispatched' } }, { sort: { createdAt: 1 }, new: true });
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
