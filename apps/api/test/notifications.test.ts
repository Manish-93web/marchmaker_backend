import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { loadEnv } from '../src/config/env';
import { buildContext } from '../src/context';
import type { MemoryPush, MemoryWhatsApp } from '../src/lib/channels';
import { createLogger } from '../src/lib/logger';
import { MemoryMailer } from '../src/lib/mailer';
import { hashPassword } from '../src/lib/passwords';
import { MemorySms } from '../src/lib/sms';
import { Consent } from '../src/models/auth';
import { Outbox, User } from '../src/models/core';
import { Message, MessageThread } from '../src/models/social';
import { sendMessageDigests } from '../src/services/digest';
import { Introduction } from '../src/models/matching';
import { Delivery, Notification, PushSubscription } from '../src/models/notifications';
import { dispatchEvent, sendDueDeliveries, unsubscribeToken } from '../src/services/notifications';

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
  const env = loadEnv({ NODE_ENV: 'test', EXPORT_DIR: mkdtempSync(path.join(tmpdir(), 'mm-notif-')) } as NodeJS.ProcessEnv);
  const log = createLogger('silent');
  const mailer = new MemoryMailer();
  const ctx = buildContext({ env, log, mailer, sms: new MemorySms() });
  return {
    app: createApp({ env, log, isReady: () => true, ctx }),
    ctx,
    mailer,
    push: ctx.push as MemoryPush,
    wa: ctx.whatsapp as MemoryWhatsApp,
  };
}
type T = ReturnType<typeof setup>;

const csrfOf = (res: request.Response) =>
  ((res.headers['set-cookie'] as unknown as string[]) ?? [])
    .find((c) => c.startsWith('mm_csrf='))!
    .split(';')[0]!
    .slice('mm_csrf='.length);

const NO_QUIET = { quietHours: { enabled: false, start: '22:00', end: '08:00' } };
const ALWAYS_QUIET = { quietHours: { enabled: true, start: '00:00', end: '23:59' } };

let n = 0;
async function member(t: T, over: Record<string, unknown> = {}) {
  n++;
  const email = `notif${n}@example.com`;
  const u = await User.create({
    email,
    passwordHash: await hashPassword(PASSWORD),
    firstName: 'Meera',
    gender: 'woman',
    dobEnc: t.ctx.crypto.encrypt('1995-01-01'),
    dobYear: 1995,
    roles: ['member'],
    emailVerifiedAt: new Date(),
    journeyState: 'matching_active',
    notificationPrefs: NO_QUIET,
    ...over,
  });
  const agent = request.agent(t.app);
  const login = await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
  const csrf = csrfOf(login);
  const cookie = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
  return {
    id: String(u._id),
    email,
    cookie,
    get: (url: string) => agent.get(`/api/v1${url}`),
    post: (url: string) => agent.post(`/api/v1${url}`).set('x-csrf-token', csrf),
    put: (url: string) => agent.put(`/api/v1${url}`).set('x-csrf-token', csrf),
  };
}

const released = (userId: string, introductionId = 'a'.repeat(24)) => ({ userId, introductionId });

const drain = async (t: T) => {
  for (const e of await Outbox.find({ eventType: 'message.digest' }).lean()) await dispatchEvent(t.ctx, e.eventType, e.payload as Record<string, unknown>, String(e._id));
};

describe('dispatch', () => {
  it('writes an in-app note and emails by default, with no private detail in either', async () => {
    const t = setup();
    const m = await member(t);
    expect(await dispatchEvent(t.ctx, 'introduction.released', released(m.id), 'evt1')).toBe(1);

    const list = (await m.get('/notifications').expect(200)).body;
    expect(list.unread).toBe(1);
    expect(list.items[0]).toMatchObject({ title: 'A new introduction is waiting for you', read: false });
    expect(list.items[0].url).toBe(`/introductions/${'a'.repeat(24)}`);

    const mail = t.mailer.last(m.email)!;
    expect(mail.subject).toBe('A new introduction is waiting for you');
    expect(mail.headers?.['List-Unsubscribe']).toContain('/unsubscribe?t=');
    expect(mail.html).toContain('/introductions/');
    expect(mail.html).toContain('Chosen for you'); // the introduction template, not the generic notice
  });

  it('sends one unread-message digest a day with a count and no message text', async () => {
    const t = setup();
    const a = await member(t);
    // Message emails are off by default, so the digest only goes to members who turned them on.
    const b = await member(t, { notificationPrefs: { ...NO_QUIET, channels: { messages: { email: true } } } });
    const thread = await MessageThread.create({ introductionId: new mongoose.Types.ObjectId(), members: [a.id, b.id], lastMessageAt: new Date(Date.now() - 3 * 3_600_000) });
    await Message.create([{ threadId: thread._id, senderId: a.id, body: 'secret words one', clientId: 'c1', createdAt: new Date(Date.now() - 3 * 3_600_000) }, { threadId: thread._id, senderId: a.id, body: 'secret words two', clientId: 'c2', createdAt: new Date(Date.now() - 3 * 3_600_000) }]);
    expect(await sendMessageDigests()).toBe(1);
    await drain(t);
    const mail = t.mailer.last(b.email)!;
    expect(mail.html).toContain('2 unread');
    expect(mail.html).not.toContain('secret words');
    expect(t.mailer.last(a.email)).toBeUndefined();
    await sendMessageDigests();
    await drain(t);
    expect(t.mailer.sent.filter((m) => m.to === b.email)).toHaveLength(1);
  });

  it('is idempotent when an event is delivered twice', async () => {
    const t = setup();
    const m = await member(t);
    await dispatchEvent(t.ctx, 'introduction.released', released(m.id), 'evt1');
    await dispatchEvent(t.ctx, 'introduction.released', released(m.id), 'evt1-retry');
    expect(await Notification.countDocuments({ userId: m.id })).toBe(1);
    expect(t.mailer.sent).toHaveLength(1);
  });

  it('skips email when the member turned it off, and records why', async () => {
    const t = setup();
    const m = await member(t);
    await m
      .put('/notifications/preferences')
      .send({ ...NO_QUIET, channels: { introductions: { in_app: true, email: false, whatsapp: false, push: false } } })
      .expect(200);
    await dispatchEvent(t.ctx, 'introduction.released', released(m.id), 'e');
    expect(t.mailer.sent).toHaveLength(0);
    const d = await Delivery.findOne({ userId: m.id, channel: 'email' }).lean();
    expect(d).toMatchObject({ status: 'skipped', reason: 'turned_off' });
  });

  it('holds external channels during quiet hours and sends them after', async () => {
    const t = setup();
    const m = await member(t, { notificationPrefs: ALWAYS_QUIET });
    await dispatchEvent(t.ctx, 'introduction.released', released(m.id), 'e');
    expect((await m.get('/notifications').expect(200)).body.unread).toBe(1);
    expect(t.mailer.sent).toHaveLength(0);
    const d = (await Delivery.findOne({ userId: m.id, channel: 'email' }).lean())!;
    expect(d.status).toBe('queued');
    expect(d.sendAfter.getTime()).toBeGreaterThan(Date.now());

    await sendDueDeliveries(t.ctx, new Date(d.sendAfter.getTime() + 1000));
    expect(t.mailer.sent).toHaveLength(1);
  });

  it('never defers a payment failure', async () => {
    const t = setup();
    const m = await member(t, { notificationPrefs: ALWAYS_QUIET });
    await dispatchEvent(t.ctx, 'billing.payment_failed', { userId: m.id, planCode: 'essential', graceDays: 3 }, 'e');
    expect(t.mailer.last(m.email)?.subject).toBe('We could not take your payment');
    expect(t.mailer.last(m.email)?.headers?.['List-Unsubscribe']).toBeUndefined();
  });

  it('collapses a conversation into one unread note and pings once', async () => {
    const t = setup();
    const m = await member(t, { notificationPrefs: { ...NO_QUIET, channels: { messages: { email: true } } } });
    for (const i of [1, 2, 3]) {
      await dispatchEvent(t.ctx, 'message.created', { userId: m.id, threadId: 't1', messageId: `m${i}` }, `e${i}`);
    }
    const notes = await Notification.find({ userId: m.id }).lean();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.count).toBe(3);
    expect(t.mailer.sent).toHaveLength(1);

    await m.post(`/notifications/${notes[0]!._id}/read`).send({}).expect(200);
    await dispatchEvent(t.ctx, 'message.created', { userId: m.id, threadId: 't1', messageId: 'm4' }, 'e4');
    expect(await Notification.countDocuments({ userId: m.id })).toBe(2);
  });

  it('uses WhatsApp only with consent, a verified phone and a premium plan', async () => {
    const t = setup();
    const phone = '+919876543210';
    const base = {
      phoneEnc: t.ctx.crypto.encrypt(phone),
      phoneHash: t.ctx.crypto.blindIndex(phone),
      phoneVerifiedAt: new Date(),
      notificationPrefs: { ...NO_QUIET, channels: { introductions: { whatsapp: true } } },
    };
    const free = await member(t, base);
    await Consent.create({ userId: free.id, purpose: 'whatsapp', granted: true });
    await dispatchEvent(t.ctx, 'introduction.released', released(free.id), 'e1');
    expect(t.wa.sent).toHaveLength(0);

    const premium = await member(t, {
      ...base,
      phoneHash: t.ctx.crypto.blindIndex('+919876543211'),
      plan: { planCode: 'premium', status: 'active' },
    });
    await Consent.create({ userId: premium.id, purpose: 'whatsapp', granted: true });
    await dispatchEvent(t.ctx, 'introduction.released', released(premium.id, 'b'.repeat(24)), 'e2');
    expect(t.wa.sent).toHaveLength(1);
    expect(t.wa.sent[0]).toMatchObject({ to: phone, template: 'mm_notification' });
  });

  it('retries a failed channel with backoff and then succeeds', async () => {
    const t = setup();
    const phone = '+919876543212';
    const m = await member(t, {
      phoneEnc: t.ctx.crypto.encrypt(phone),
      phoneHash: t.ctx.crypto.blindIndex(phone),
      phoneVerifiedAt: new Date(),
      plan: { planCode: 'premium', status: 'active' },
      notificationPrefs: { ...NO_QUIET, channels: { introductions: { whatsapp: true } } },
    });
    await Consent.create({ userId: m.id, purpose: 'whatsapp', granted: true });
    t.wa.failNext = true;
    await dispatchEvent(t.ctx, 'introduction.released', released(m.id), 'e');
    const first = (await Delivery.findOne({ userId: m.id, channel: 'whatsapp' }).lean())!;
    expect(first.status).toBe('queued');
    expect(first.attempts).toBe(1);
    expect(t.wa.sent).toHaveLength(0);
    await sendDueDeliveries(t.ctx, new Date(Date.now() + 10 * 60_000));
    expect(t.wa.sent).toHaveLength(1);
    expect((await Delivery.findById(first._id).lean())!.status).toBe('sent');
  });

  it('sends push to registered devices and drops ones the browser has revoked', async () => {
    const t = setup();
    const m = await member(t);
    await m.post('/notifications/push').send({ endpoint: 'https://push.example/ok', keys: { p256dh: 'k', auth: 'a' } }).expect(201);
    await m.post('/notifications/push').send({ endpoint: 'https://push.example/gone', keys: { p256dh: 'k', auth: 'a' } }).expect(201);
    t.push.goneEndpoints.add('https://push.example/gone');
    await dispatchEvent(t.ctx, 'introduction.released', released(m.id), 'e');
    expect(t.push.sent).toHaveLength(1);
    expect(t.push.sent[0]!.payload.url).toMatch(/^\/introductions\//);
    expect(await PushSubscription.countDocuments({ userId: m.id })).toBe(1);
  });

  it('notifies both people when contact is shared, but nobody when only one accepted', async () => {
    const t = setup();
    const a = await member(t);
    const b = await member(t);
    const i = await Introduction.create({
      pairKey: [a.id, b.id].sort().join(':'),
      members: [{ userId: a.id }, { userId: b.id }],
      whyText: 'Why',
      state: 'mutually_accepted',
      expiresAt: new Date(Date.now() + 1e9),
    });
    expect(await dispatchEvent(t.ctx, 'introduction.contact_shared', { introductionId: String(i._id) }, 'e')).toBe(2);
    expect(await dispatchEvent(t.ctx, 'introduction.accepted_by_one', { introductionId: String(i._id), byUserId: a.id }, 'e2')).toBe(0);
  });

  it('alerts the on-call address for a critical safety report', async () => {
    const t = setup();
    await dispatchEvent(t.ctx, 'safety.critical_report', { reportId: 'r1', category: 'safety_threat' }, 'e');
    expect(t.mailer.last()?.to).toBe(t.ctx.env.SUPPORT_EMAIL);
    expect(t.mailer.last()?.subject).toMatch(/Critical safety report/);
  });
});

describe('inbox and preferences', () => {
  it('lists, marks read and marks all read, only for the owner', async () => {
    const t = setup();
    const a = await member(t);
    const b = await member(t);
    await dispatchEvent(t.ctx, 'introduction.released', released(a.id, '1'.repeat(24)), 'e1');
    await dispatchEvent(t.ctx, 'introduction.released', released(a.id, '2'.repeat(24)), 'e2');
    const items = (await a.get('/notifications').expect(200)).body.items;
    expect(items).toHaveLength(2);
    await b.post(`/notifications/${items[0].id}/read`).send({}).expect(404);
    expect((await a.post(`/notifications/${items[0].id}/read`).send({}).expect(200)).body.unread).toBe(1);
    expect((await a.get('/notifications?unread=true').expect(200)).body.items).toHaveLength(1);
    expect((await a.post('/notifications/read-all').send({}).expect(200)).body.unread).toBe(0);
  });

  it('keeps safety messages on even if switched off', async () => {
    const t = setup();
    const m = await member(t);
    const res = await m
      .put('/notifications/preferences')
      .send({ channels: { safety: { in_app: false, email: false, whatsapp: false, push: false } } })
      .expect(200);
    expect(res.body.prefs.channels.safety).toMatchObject({ in_app: true, email: true });
  });

  it('unsubscribes from one category with a signed link and rejects a forged one', async () => {
    const t = setup();
    const m = await member(t);
    const token = unsubscribeToken(t.ctx, m.id, 'introductions');
    await request(t.app).post('/api/v1/unsubscribe').send({ token }).expect(200);
    const prefs = (await m.get('/notifications/preferences').expect(200)).body.prefs;
    expect(prefs.channels.introductions.email).toBe(false);
    expect(prefs.channels.messages.in_app).toBe(true);
    await request(t.app).post('/api/v1/unsubscribe').send({ token: `${token.slice(0, -3)}abc` }).expect(400);
  });

  it('requires a session for the inbox', async () => {
    const t = setup();
    await request(t.app).get('/api/v1/notifications').expect(401);
  });
});

describe('live stream', () => {
  it('pushes an event as soon as a notification is written', async () => {
    const t = setup();
    const m = await member(t);
    const server = http.createServer(t.app).listen(0);
    const port = (server.address() as AddressInfo).port;
    let triggered = false;
    const received = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no stream event')), 8000);
      const req = http.get({ port, path: '/api/v1/notifications/stream', headers: { cookie: m.cookie } }, (res) => {
        let buf = '';
        res.on('data', (d: Buffer) => {
          buf += d.toString();
          if (buf.includes('event: ready') && !triggered) {
            triggered = true;
            // Give the change stream a moment to start before writing.
            setTimeout(() => void dispatchEvent(t.ctx, 'introduction.released', released(m.id), 'live'), 500);
          }
          if (buf.includes('event: notify')) {
            clearTimeout(timer);
            req.destroy();
            resolve(buf);
          }
        });
      });
      req.on('error', () => undefined);
    });
    expect(received).toContain('"unread":1');
    // Let the server notice the closed stream and close its change stream before the DB goes away.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
});
