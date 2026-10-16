import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { loadEnv } from '../src/config/env';
import { buildContext } from '../src/context';
import { MemoryMailer } from '../src/lib/mailer';
import { createLogger } from '../src/lib/logger';
import { MemorySms } from '../src/lib/sms';
import { FeatureFlag } from '../src/models/core';
import { ContactMessage, Guide, Plan, SuccessStory } from '../src/models/content';

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
});

function setup() {
  const env = loadEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
  const log = createLogger('silent');
  const mailer = new MemoryMailer();
  const ctx = buildContext({ env, log, mailer, sms: new MemorySms() });
  return { app: createApp({ env, log, isReady: () => true, ctx }), mailer, env };
}

describe('plans', () => {
  it('serves seed defaults on a fresh install, with paise prices and the GST flag', async () => {
    const res = await request(setup().app).get('/api/v1/plans').expect(200);
    expect(res.body.pricesIncludeGst).toBe(true);
    const codes = res.body.items.map((p: { code: string }) => p.code);
    expect(codes).toEqual(expect.arrayContaining(['free', 'essential', 'premium', 'concierge', 'pack_1', 'pack_3']));
    expect(res.headers['cache-control']).toContain('max-age');
  });

  it('prefers database plans and hides inactive ones', async () => {
    await Plan.create({ code: 'essential', kind: 'subscription', name: 'Essential', prices: { monthly: 89_900 }, credits: 2, sortOrder: 1 });
    await Plan.create({ code: 'premium', kind: 'subscription', name: 'Premium', prices: { monthly: 1 }, active: false });
    const res = await request(setup().app).get('/api/v1/plans').expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].prices.monthly).toBe(89_900);
  });
});

describe('success stories and guides', () => {
  it('returns only published stories that carry recorded consent', async () => {
    await SuccessStory.create({ coupleNames: 'A & R', quote: 'We met through Marchmaker.', published: true, consentGivenAt: new Date() });
    await SuccessStory.create({ coupleNames: 'No consent', quote: 'x', published: true });
    await SuccessStory.create({ coupleNames: 'Draft', quote: 'x', consentGivenAt: new Date() });
    const res = await request(setup().app).get('/api/v1/success-stories').expect(200);
    expect(res.body.items.map((s: { coupleNames: string }) => s.coupleNames)).toEqual(['A & R']);
  });

  it('lists published guides without exposing their body', async () => {
    await Guide.create({ slug: 'first-call', title: 'Your first call', bodyMarkdown: 'SECRET BODY', published: true, publishedAt: new Date() });
    await Guide.create({ slug: 'draft', title: 'Draft', published: false });
    const res = await request(setup().app).get('/api/v1/guides').expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain('SECRET BODY');
  });
});

describe('contact form', () => {
  const valid = { name: 'Asha', email: 'asha@example.com', topic: 'support', message: 'I need help with my verification.' };

  it('stores the message and notifies the team', async () => {
    const t = setup();
    await request(t.app).post('/api/v1/contact').send(valid).expect(202);
    expect(await ContactMessage.countDocuments()).toBe(1);
    expect(t.mailer.last(t.env.SUPPORT_EMAIL)?.subject).toContain('Asha');
  });

  it('validates input', async () => {
    const t = setup();
    await request(t.app).post('/api/v1/contact').send({ ...valid, email: 'nope' }).expect(422);
    await request(t.app).post('/api/v1/contact').send({ ...valid, message: 'short' }).expect(422);
  });

  it('silently drops honeypot submissions', async () => {
    const t = setup();
    await request(t.app).post('/api/v1/contact').send({ ...valid, website: 'http://spam.example' }).expect(202);
    expect(await ContactMessage.countDocuments()).toBe(0);
    expect(t.mailer.sent).toHaveLength(0);
  });
});

describe('feature flags', () => {
  it('exposes only key/enabled pairs', async () => {
    await FeatureFlag.create({ key: 'astrology', enabled: true, description: 'internal note', updatedBy: new mongoose.Types.ObjectId() });
    const res = await request(setup().app).get('/api/v1/flags').expect(200);
    expect(res.body).toEqual({ flags: { astrology: true } });
  });
});
