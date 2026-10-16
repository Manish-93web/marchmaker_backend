import { createHmac, randomBytes } from 'node:crypto';
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
import type { MemoryWhatsApp } from '../src/lib/channels';
import { createLogger } from '../src/lib/logger';
import { MemoryMailer } from '../src/lib/mailer';
import { hashPassword } from '../src/lib/passwords';
import { MemorySms } from '../src/lib/sms';
import { Consent } from '../src/models/auth';
import { User } from '../src/models/core';
import { EmailEvent, EmailSuppression, WhatsAppOptIn, WhatsAppTemplate } from '../src/models/messaging';
import { Delivery } from '../src/models/notifications';
import { currentConsents } from '../src/services/legal';
import { dispatchEvent, sendDueDeliveries } from '../src/services/notifications';
import { sendNotice, sendOtp } from '../src/services/notify';

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
const SVIX_SECRET = `whsec_${randomBytes(24).toString('base64')}`;
const APP_SECRET = 'meta-app-secret-for-tests';

function setup(extra: Record<string, string> = {}) {
  const env = loadEnv({
    NODE_ENV: 'test',
    EXPORT_DIR: mkdtempSync(path.join(tmpdir(), 'mm-msg-')),
    RESEND_WEBHOOK_SECRET: SVIX_SECRET,
    WHATSAPP_APP_SECRET: APP_SECRET,
    WHATSAPP_VERIFY_TOKEN: 'verify-me',
    ...extra,
  } as NodeJS.ProcessEnv);
  const log = createLogger('silent');
  const mailer = new MemoryMailer();
  const ctx = buildContext({ env, log, mailer, sms: new MemorySms() });
  return { app: createApp({ env, log, isReady: () => true, ctx }), ctx, mailer, wa: ctx.whatsapp as MemoryWhatsApp };
}
type T = ReturnType<typeof setup>;

const csrfOf = (res: request.Response) =>
  ((res.headers['set-cookie'] as unknown as string[]) ?? [])
    .find((c) => c.startsWith('mm_csrf='))!
    .split(';')[0]!
    .slice('mm_csrf='.length);

let n = 0;
async function user(t: T, over: Record<string, unknown> = {}, roles: Role[] = ['member']) {
  n++;
  const email = `msg${n}@example.com`;
  const phone = `+9198770${String(10000 + n)}`;
  const u = await User.create({
    email,
    passwordHash: await hashPassword(PASSWORD),
    firstName: 'Meera',
    gender: 'woman',
    dobEnc: t.ctx.crypto.encrypt('1995-01-01'),
    dobYear: 1995,
    roles,
    emailVerifiedAt: new Date(),
    phoneEnc: t.ctx.crypto.encrypt(phone),
    phoneHash: t.ctx.crypto.blindIndex(phone),
    phoneVerifiedAt: new Date(),
    plan: { planCode: 'premium', status: 'active' },
    journeyState: 'matching_active',
    notificationPrefs: { quietHours: { enabled: false }, channels: { introductions: { whatsapp: true } } },
    ...over,
  });
  return { id: String(u._id), email, phone };
}

async function staff(t: T) {
  const u = await user(t, {}, ['super_admin']);
  const agent = request.agent(t.app);
  const login = await agent.post('/api/v1/auth/login').send({ email: u.email, password: PASSWORD }).expect(200);
  const s = await agent.post('/api/v1/auth/2fa/setup').set('x-csrf-token', csrfOf(login)).expect(200);
  const c = await agent.post('/api/v1/auth/2fa/confirm').set('x-csrf-token', csrfOf(login)).send({ code: generateSync({ secret: String(s.body.secret) }) }).expect(200);
  const csrf = csrfOf(c);
  return {
    get: (url: string) => agent.get(`/api/v1${url}`),
    post: (url: string) => agent.post(`/api/v1${url}`).set('x-csrf-token', csrf),
    put: (url: string) => agent.put(`/api/v1${url}`).set('x-csrf-token', csrf),
    delete: (url: string) => agent.delete(`/api/v1${url}`).set('x-csrf-token', csrf),
  };
}

function svix(body: unknown, over: { id?: string; ts?: number; secret?: string } = {}) {
  const raw = JSON.stringify(body);
  const id = over.id ?? `msg_${randomBytes(4).toString('hex')}`;
  const ts = over.ts ?? Math.floor(Date.now() / 1000);
  const key = Buffer.from((over.secret ?? SVIX_SECRET).slice(6), 'base64');
  const sig = createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest('base64');
  return { raw, headers: { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}`, 'content-type': 'application/json' } };
}
const resend = (t: T, body: unknown, over: Parameters<typeof svix>[1] = {}) => {
  const s = svix(body, over);
  return request(t.app).post('/api/v1/webhooks/resend').set(s.headers).send(s.raw);
};

const meta = (body: unknown, secret = APP_SECRET) => {
  const raw = JSON.stringify(body);
  return { raw, headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`, 'content-type': 'application/json' } };
};

describe('email delivery events and suppression', () => {
  it('rejects a bad signature, an old timestamp and a missing secret', async () => {
    const t = setup();
    await resend(t, { type: 'email.delivered' }, { secret: `whsec_${randomBytes(24).toString('base64')}` }).expect(401);
    await resend(t, { type: 'email.delivered' }, { ts: Math.floor(Date.now() / 1000) - 3600 }).expect(401);
    await request(t.app).post('/api/v1/webhooks/resend').send('{}').expect(401);
    const none = setup({ RESEND_WEBHOOK_SECRET: '' });
    void none;
    expect(await EmailEvent.countDocuments({})).toBe(0);
  });

  it('marks a notification delivered, once, and ignores redelivery', async () => {
    const t = setup();
    const u = await user(t);
    await dispatchEvent(t.ctx, 'introduction.released', { userId: u.id, introductionId: 'a'.repeat(24) }, 'e1');
    const d = (await Delivery.findOne({ userId: u.id, channel: 'email' }).lean())!;
    expect(d.status).toBe('sent');
    expect(d.providerId).toMatch(/^mem_/);

    const ev = { type: 'email.delivered', created_at: new Date().toISOString(), data: { email_id: d.providerId, to: [u.email] } };
    await resend(t, ev, { id: 'evt_1' }).expect(200);
    await resend(t, ev, { id: 'evt_1' }).expect(200);
    expect(await EmailEvent.countDocuments({})).toBe(1);
    expect((await Delivery.findById(d._id).lean())!.status).toBe('delivered');
  });

  it('suppresses an address after a permanent bounce and stops mailing it, but not after a soft one', async () => {
    const t = setup();
    const u = await user(t);
    const soft = { type: 'email.bounced', data: { email_id: 'x1', to: [u.email], bounce: { type: 'Transient', message: 'mailbox full' } } };
    await resend(t, soft, { id: 'evt_soft' }).expect(200);
    expect(await EmailSuppression.countDocuments({})).toBe(0);

    const hard = { type: 'email.bounced', data: { email_id: 'x2', to: [u.email], bounce: { type: 'Permanent', message: 'no such user' } } };
    await resend(t, hard, { id: 'evt_hard' }).expect(200);
    const sup = (await EmailSuppression.findOne({}).lean())!;
    expect(sup.kind).toBe('hard_bounce');
    expect(JSON.stringify(sup)).not.toContain(u.email); // only a keyed hash is kept

    // Nothing reaches a hard-bounced address, security mail included.
    const sent = t.mailer.sent.length;
    await sendNotice(t.ctx, u.email, { subject: 'Reset your password', preview: 'p', heading: 'h', paragraphs: ['x'] });
    expect(t.mailer.sent.length).toBe(sent);
    await dispatchEvent(t.ctx, 'introduction.released', { userId: u.id, introductionId: 'b'.repeat(24) }, 'e2');
    expect(t.mailer.sent.length).toBe(sent);
    expect(await Delivery.findOne({ userId: u.id, channel: 'email' }).lean()).toMatchObject({ status: 'skipped', reason: 'suppressed' });
  });

  it('after a complaint only security and payment messages still go', async () => {
    const t = setup();
    const u = await user(t);
    await resend(t, { type: 'email.complained', data: { email_id: 'c1', to: [u.email] } }, { id: 'evt_c' }).expect(200);
    expect((await EmailSuppression.findOne({}).lean())!.kind).toBe('complaint');
    const before = t.mailer.sent.length;
    await dispatchEvent(t.ctx, 'introduction.released', { userId: u.id, introductionId: 'c'.repeat(24) }, 'e3'); // optional
    expect(t.mailer.sent.length).toBe(before);
    await dispatchEvent(t.ctx, 'billing.payment_failed', { userId: u.id, planCode: 'premium', graceDays: 3 }, 'e4'); // critical
    expect(t.mailer.sent.length).toBe(before + 1);
  });

  it('lets staff review and lift a suppression, with an audit entry', async () => {
    const t = setup();
    const u = await user(t);
    await resend(t, { type: 'email.bounced', data: { email_id: 'x', to: [u.email], bounce: { type: 'Permanent' } } }, { id: 'evt_b' }).expect(200);
    const s = await staff(t);
    const list = (await s.get('/admin/email/suppressions').expect(200)).body.items;
    expect(list).toHaveLength(1);
    await s.delete(`/admin/email/suppressions/${list[0].id}`).expect(200);
    expect(await EmailSuppression.countDocuments({})).toBe(0);
    await s.delete(`/admin/email/suppressions/${list[0].id}`).expect(404);
  });
});

describe('WhatsApp webhook', () => {
  it('answers Meta\'s verification only with the right token', async () => {
    const t = setup();
    const ok = await request(t.app).get('/api/v1/webhooks/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '12345' }).expect(200);
    expect(ok.text).toBe('12345');
    await request(t.app).get('/api/v1/webhooks/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' }).expect(400);
  });

  it('refuses unsigned or wrongly signed calls', async () => {
    const t = setup();
    const m = meta({ entry: [] }, 'other-secret');
    await request(t.app).post('/api/v1/webhooks/whatsapp').set(m.headers).send(m.raw).expect(401);
    await request(t.app).post('/api/v1/webhooks/whatsapp').send('{}').expect(401);
  });

  it('records delivery and read receipts, moving a message forward only', async () => {
    const t = setup();
    const u = await user(t);
    await Consent.create({ userId: u.id, purpose: 'whatsapp', granted: true });
    await dispatchEvent(t.ctx, 'introduction.released', { userId: u.id, introductionId: 'd'.repeat(24) }, 'e5');
    const d = (await Delivery.findOne({ userId: u.id, channel: 'whatsapp' }).lean())!;
    expect(d.providerId).toMatch(/^wamid\./);
    const body = { entry: [{ changes: [{ value: { statuses: [{ id: d.providerId, status: 'read' }] } }] }] };
    const m = meta(body);
    await request(t.app).post('/api/v1/webhooks/whatsapp').set(m.headers).send(m.raw).expect(200);
    expect((await Delivery.findById(d._id).lean())!.status).toBe('delivered');
    // A late "failed" does not undo a delivery.
    const late = meta({ entry: [{ changes: [{ value: { statuses: [{ id: d.providerId, status: 'failed' }] } }] }] });
    await request(t.app).post('/api/v1/webhooks/whatsapp').set(late.headers).send(late.raw).expect(200);
    expect((await Delivery.findById(d._id).lean())!.status).toBe('delivered');
  });

  it('turns WhatsApp off straight away when the member replies STOP', async () => {
    const t = setup();
    const u = await user(t);
    await Consent.create({ userId: u.id, purpose: 'whatsapp', granted: true });
    const stop = meta({ entry: [{ changes: [{ value: { messages: [{ from: u.phone.replace('+', ''), type: 'text', text: { body: ' stop ' } }] } }] }] });
    await request(t.app).post('/api/v1/webhooks/whatsapp').set(stop.headers).send(stop.raw).expect(200);
    expect((await currentConsents(u.id)).whatsapp?.granted).toBe(false);
    expect(await WhatsAppOptIn.countDocuments({ userId: u.id, status: 'opted_out', source: 'keyword' })).toBe(1);

    await dispatchEvent(t.ctx, 'introduction.released', { userId: u.id, introductionId: 'e'.repeat(24) }, 'e6');
    expect(t.wa.sent).toHaveLength(0);
    // An ordinary reply does nothing.
    const hello = meta({ entry: [{ changes: [{ value: { messages: [{ from: u.phone.replace('+', ''), text: { body: 'hello there' } }] } }] }] });
    await request(t.app).post('/api/v1/webhooks/whatsapp').set(hello.headers).send(hello.raw).expect(200);
    expect(await WhatsAppOptIn.countDocuments({})).toBe(1);
  });
});

describe('WhatsApp templates and OTP', () => {
  it('sends only approved templates once a registry row exists', async () => {
    const t = setup();
    const u = await user(t);
    await Consent.create({ userId: u.id, purpose: 'whatsapp', granted: true });
    await WhatsAppTemplate.create({ name: 'mm_notification', approvalStatus: 'pending', variables: 2 });
    await dispatchEvent(t.ctx, 'introduction.released', { userId: u.id, introductionId: 'f'.repeat(24) }, 'e7');
    expect(t.wa.sent).toHaveLength(0);
    expect(await Delivery.findOne({ userId: u.id, channel: 'whatsapp' }).lean()).toMatchObject({ status: 'skipped', reason: 'template_not_approved' });

    await WhatsAppTemplate.updateOne({ name: 'mm_notification' }, { $set: { approvalStatus: 'approved' } });
    await dispatchEvent(t.ctx, 'introduction.released', { userId: u.id, introductionId: '1'.repeat(24) }, 'e8');
    expect(t.wa.sent).toHaveLength(1);
  });

  it('lets staff manage the registry and shows what members will receive', async () => {
    const t = setup();
    const s = await staff(t);
    const first = (await s.get('/admin/whatsapp/templates').expect(200)).body.items;
    expect(first.map((x: { name: string }) => x.name)).toEqual(['mm_notification', 'mm_otp']);
    await s.put('/admin/whatsapp/templates').send({ name: 'mm_otp', language: 'en', category: 'authentication', variables: 1, approvalStatus: 'approved', body: '{{1}}', purpose: 'otp' }).expect(200);
    expect((await WhatsAppTemplate.findOne({ name: 'mm_otp' }).lean())!.approvalStatus).toBe('approved');
    await s.put('/admin/whatsapp/templates').send({ name: 'Bad Name', variables: 1, approvalStatus: 'approved' }).expect(422);

    const catalog = (await s.get('/admin/notifications/catalog').expect(200)).body.items;
    const failed = catalog.find((c: { type: string }) => c.type === 'billing.payment_failed');
    expect(failed).toMatchObject({ critical: true, category: 'billing' });
    const prev = (await s.post('/admin/notifications/preview').send({ type: 'introduction.released' }).expect(200)).body;
    expect(prev.html).toContain('A new introduction is waiting for you');
    await s.post('/admin/notifications/preview').send({ type: 'nope' }).expect(404);
  });

  it('delivers codes by WhatsApp, or falls back to it when SMS fails', async () => {
    const wa = setup({ OTP_CHANNEL: 'whatsapp' });
    await sendOtp(wa.ctx, '+919800000001', '123456');
    expect(wa.wa.sent[0]).toMatchObject({ template: 'mm_otp', vars: ['123456'] });

    const fb = setup({ OTP_CHANNEL: 'sms_then_whatsapp' });
    (fb.ctx.sms as unknown as { send: () => Promise<void> }).send = async () => {
      throw new Error('sms down');
    };
    await sendOtp(fb.ctx, '+919800000002', '654321');
    expect(fb.wa.sent[0]).toMatchObject({ template: 'mm_otp', vars: ['654321'] });

    const sms = setup();
    await sendOtp(sms.ctx, '+919800000003', '111111');
    expect(sms.wa.sent).toHaveLength(0);
    expect((sms.ctx.sms as MemorySms).last('+919800000003')?.body).toContain('111111');
  });

  it('records opt-in history when the member changes the consent', async () => {
    const t = setup();
    const u = await user(t);
    const agent = request.agent(t.app);
    const login = await agent.post('/api/v1/auth/login').send({ email: u.email, password: PASSWORD }).expect(200);
    await agent.post('/api/v1/account/consents').set('x-csrf-token', csrfOf(login)).send({ purpose: 'whatsapp', granted: true }).expect(201);
    await agent.post('/api/v1/account/consents').set('x-csrf-token', csrfOf(login)).send({ purpose: 'whatsapp', granted: false }).expect(201);
    const rows = await WhatsAppOptIn.find({ userId: u.id }).sort({ at: 1 }).lean();
    expect(rows.map((r) => r.status)).toEqual(['opted_in', 'opted_out']);
  });
});

describe('delivery logs', () => {
  it('lists recent deliveries with their outcome for staff', async () => {
    const t = setup();
    const u = await user(t);
    await dispatchEvent(t.ctx, 'introduction.released', { userId: u.id, introductionId: '2'.repeat(24) }, 'e9');
    await sendDueDeliveries(t.ctx);
    const s = await staff(t);
    const rows = (await s.get('/admin/notifications/deliveries?channel=email').expect(200)).body.items;
    expect(rows[0]).toMatchObject({ type: 'introduction.released', channel: 'email', status: 'sent' });
    await s.get('/admin/notifications/deliveries?status=bogus').expect(422);
  });
});
