import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import { generateSync } from 'otplib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Role } from '@marchmaker/shared';
import { createApp } from '../src/app';
import { loadEnv } from '../src/config/env';
import { buildContext } from '../src/context';
import { sendSlaAlerts } from '../src/services/slaAlerts';
import { createLogger } from '../src/lib/logger';
import { MemoryMailer } from '../src/lib/mailer';
import { hashPassword } from '../src/lib/passwords';
import { MemorySms } from '../src/lib/sms';
import { LegalDocument } from '../src/models/auth';
import { Report } from '../src/models/social';
import { Ticket } from '../src/models/safety';
import { Introduction } from '../src/models/matching';
import { Message, MessageThread } from '../src/models/social';
import { AuditLog } from '../src/models/core';
import { User } from '../src/models/core';

let mongod: MongoMemoryReplSet;
beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongod.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
});

const PASSWORD = 'Sup3rSecretPass';

function setup() {
  const env = loadEnv({ NODE_ENV: 'test', EXPORT_DIR: mkdtempSync(path.join(tmpdir(), 'mm-cms-')) } as NodeJS.ProcessEnv);
  const log = createLogger('silent');
  const mailer = new MemoryMailer();
  const ctx = buildContext({ env, log, mailer, sms: new MemorySms() });
  return { app: createApp({ env, log, isReady: () => true, ctx }), ctx, mailer };
}
type T = ReturnType<typeof setup>;

const csrfOf = (res: request.Response) =>
  ((res.headers['set-cookie'] as unknown as string[]) ?? [])
    .find((c) => c.startsWith('mm_csrf='))!
    .split(';')[0]!
    .slice('mm_csrf='.length);

let n = 0;
async function session(t: T, roles: Role[] = ['member']) {
  n++;
  const email = `cms${n}@example.com`;
  const u = await User.create({
    email,
    passwordHash: await hashPassword(PASSWORD),
    firstName: 'Sam',
    gender: 'man',
    dobEnc: t.ctx.crypto.encrypt('1990-01-01'),
    dobYear: 1990,
    roles,
    emailVerifiedAt: new Date(),
    journeyState: 'matching_active',
  });
  const agent = request.agent(t.app);
  const login = await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
  let csrf = csrfOf(login);
  if (roles.some((r) => r !== 'member')) {
    const s = await agent.post('/api/v1/auth/2fa/setup').set('x-csrf-token', csrf).expect(200);
    const c = await agent.post('/api/v1/auth/2fa/confirm').set('x-csrf-token', csrf).send({ code: generateSync({ secret: String(s.body.secret) }) }).expect(200);
    csrf = csrfOf(c);
  }
  return {
    id: String(u._id),
    email,
    get: (url: string) => agent.get(`/api/v1${url}`),
    post: (url: string) => agent.post(`/api/v1${url}`).set('x-csrf-token', csrf),
    put: (url: string) => agent.put(`/api/v1${url}`).set('x-csrf-token', csrf),
    patch: (url: string) => agent.patch(`/api/v1${url}`).set('x-csrf-token', csrf),
    delete: (url: string) => agent.delete(`/api/v1${url}`).set('x-csrf-token', csrf),
  };
}


describe('legal versions', () => {
  it('publishes a new immutable version, which members then see', async () => {
    const t = setup();
    const boss = await session(t, ['super_admin']);
    const md = 'These terms describe how the service works and what we expect of members. '.repeat(3);
    await LegalDocument.create({ type: 'terms', version: 'v1', title: 'Terms', effectiveDate: new Date('2025-01-01'), markdown: md, material: true });
    const r = await boss.post('/admin/legal').send({ type: 'terms', title: 'Terms of use', markdown: md + ' Updated.', material: true }).expect(201);
    expect(r.body.version).toBe('v2');
    const list = (await boss.get('/admin/legal').expect(200)).body.items.find((i: { type: string }) => i.type === 'terms');
    expect(list.versions.map((v: { version: string }) => v.version)).toEqual(expect.arrayContaining(['v1', 'v2']));
    expect((await request(t.app).get('/api/v1/legal/terms').expect(200)).body.version).toBe('v2');
    await boss.post('/admin/legal').send({ type: 'terms', title: 'x', markdown: 'short' }).expect(422);
  });
});

describe('FAQ, monitor, filters and member tabs', () => {
  it('serves only published FAQs and lets staff manage them', async () => {
    const t = setup();
    const boss = await session(t, ['super_admin']);
    const f = await boss.post('/admin/faqs').send({ question: 'Is it free?', answer: 'Browsing is.', published: true }).expect(201);
    await boss.post('/admin/faqs').send({ question: 'Draft question', answer: 'Draft answer', published: false }).expect(201);
    const pub = (await request(t.app).get('/api/v1/faqs').expect(200)).body.items;
    expect(pub).toHaveLength(1);
    await boss.put(`/admin/faqs/${f.body.id}`).send({ question: 'Is it free?', answer: 'Yes, browsing is free.', published: false }).expect(200);
    expect((await request(t.app).get('/api/v1/faqs').expect(200)).body.items).toHaveLength(0);
    await boss.delete(`/admin/faqs/${f.body.id}`).expect(200);
  });

  it('keeps saved filters private to each staff member', async () => {
    const t = setup();
    const a = await session(t, ['super_admin']);
    const b = await session(t, ['super_admin']);
    await a.post('/admin/saved-filters').send({ name: 'Stuck', query: { status: 'active' } }).expect(201);
    await a.post('/admin/saved-filters').send({ name: 'Stuck', query: {} }).expect(409);
    expect((await a.get('/admin/saved-filters').expect(200)).body.items).toHaveLength(1);
    expect((await b.get('/admin/saved-filters').expect(200)).body.items).toHaveLength(0);
  });

  it('shows member finance, ledgers, safety and tickets tabs', async () => {
    const t = setup();
    const boss = await session(t, ['super_admin']);
    const m = await session(t);
    for (const tab of ['finance', 'ledgers', 'safety', 'tickets']) await boss.get(`/admin/members/${m.id}/${tab}`).expect(200);
    await m.get(`/admin/members/${m.id}/finance`).expect(403);
    expect((await boss.get('/admin/introductions').expect(200)).body.items).toEqual([]);
    expect((await boss.get('/admin/billing/reconcile/status').expect(200)).body).toMatchObject({ pendingOrders: 0 });
    expect((await boss.get('/admin/billing/invoices').expect(200)).body.items).toEqual([]);
  });

  it('creates a plan inactive and refuses a duplicate code', async () => {
    const t = setup();
    const boss = await session(t, ['super_admin']);
    const body = { code: 'trial_x', kind: 'pack', name: 'Trial', credits: 1, prices: { monthly: 9900 } };
    const r = await boss.post('/admin/billing/plans').send(body).expect(201);
    expect(r.body.active).toBe(false);
    await boss.post('/admin/billing/plans').send(body).expect(409);
  });
});

describe('SLA alerts', () => {
  it('alerts once per overdue report and ticket, and digests stale queues', async () => {
    const t = setup();
    const past = new Date(Date.now() - 3_600_000);
    const m = await session(t);
    const rep = await Report.create({ reporterId: m.id, reportedId: m.id, category: 'harassment', severity: 'critical', status: 'open', slaDueAt: past });
    await Ticket.create({ userId: m.id, number: 'T-1', email: m.email, subject: 'Help', category: 'billing', status: 'open', firstResponseDueAt: past });
    const first = await sendSlaAlerts(t.ctx);
    expect(first).toMatchObject({ reports: 1, tickets: 1 });
    expect(t.mailer.sent.length).toBeGreaterThanOrEqual(2);
    expect((await Report.findById(rep._id))?.slaAlertedAt).toBeTruthy();
    const second = await sendSlaAlerts(t.ctx);
    expect(second).toMatchObject({ reports: 0, tickets: 0 });
  });
});

describe('member detail: introductions and audited messages', () => {
  it('lists introductions, and shows messages only for a reported pair, with an audit entry', async () => {
    const t = setup();
    const boss = await session(t, ['super_admin']);
    const support = await session(t, ['support_agent']);
    const a = await session(t);
    const b = await session(t);
    const intro = await Introduction.create({ pairKey: `${a.id}:${b.id}`, members: [{ userId: a.id, status: 'accepted' }, { userId: b.id, status: 'accepted' }], whyText: 'You both want a calm family life.', state: 'mutually_accepted', expiresAt: new Date(Date.now() + 1e9) });
    const list = (await boss.get(`/admin/members/${a.id}/introductions`).expect(200)).body.items;
    expect(list[0]).toMatchObject({ state: 'mutually_accepted', myStatus: 'accepted' });

    expect((await boss.get(`/admin/members/${a.id}/messages`).expect(200)).body.available).toBe(false); // nobody reported them
    const thread = await MessageThread.create({ introductionId: intro._id, members: [a.id, b.id] });
    await Message.create({ threadId: thread._id, senderId: a.id, body: 'Hello there', clientId: 'x1' });
    await Report.create({ reporterId: b.id, reportedId: a.id, introductionId: intro._id, category: 'harassment', severity: 'high', slaDueAt: new Date() });
    const seen = (await boss.get(`/admin/members/${a.id}/messages`).expect(200)).body;
    expect(seen.threads[0].messages[0]).toMatchObject({ body: 'Hello there', mine: true });
    expect(await AuditLog.countDocuments({ action: 'member.messages_viewed' })).toBe(1);
    await support.get(`/admin/members/${a.id}/messages`).expect(403);
  });
});

describe('spec-named aliases', () => {
  it('answers on the names the API specification uses, and still needs a session', async () => {
    const t = setup();
    const m = await session(t);
    expect((await m.get('/wallet/ledger').expect(200)).body).toEqual((await m.get('/wallet').expect(200)).body);
    await m.post('/push/subscribe').send({}).expect(422); // the route exists and validates
    await m.put('/astrology/profile').send({}).expect(404); // behind its feature flag, like /astrology/details
    await request(t.app).get('/api/v1/wallet/ledger').expect(401);
    await request(t.app).post('/api/v1/push/subscribe').send({}).expect(401);
  });
});

describe('theme on the account and remaining aliases', () => {
  it('keeps the theme with the member, and accepts feedback under the introduction', async () => {
    const t = setup();
    const m = await session(t);
    await m.patch('/account').send({ theme: 'dark' }).expect(200);
    expect((await m.get('/auth/me').expect(200)).body.theme).toBe('dark');
    await m.patch('/account').send({ theme: 'neon' }).expect(422);
    await m.post(`/introductions/${'a'.repeat(24)}/feedback`).send({ rating: 4, tags: [] }).expect(404); // not their introduction, but the route exists
    await request(t.app).put('/api/v1/guides/some-guide/progress').send({ positionSec: 3 }).expect(401);
  });
});
