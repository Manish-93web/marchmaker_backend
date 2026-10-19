import { mkdtempSync } from 'node:fs';
import { readExport } from './helpers/exportFile';
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
import { buildExport, purgeDueAccounts } from '../src/jobs/accountJobs';
import { registerMemberDataHooks } from '../src/jobs/registerPurge';
import { createLogger } from '../src/lib/logger';
import { MemoryMailer } from '../src/lib/mailer';
import { hashPassword } from '../src/lib/passwords';
import { MemorySms } from '../src/lib/sms';
import { MemoryStorage } from '../src/lib/storage';
import { Outbox, User } from '../src/models/core';
import { Block, Introduction } from '../src/models/matching';
import { Photo, Profile } from '../src/models/profile';
import { CreditLedger, Message, MessageThread, Report } from '../src/models/social';
import { expireAndRemind } from '../src/services/introductions';

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
const NOTE =
  'Hello! I really liked what you wrote about long walks and cooking for family. I would love to hear what a perfect weekend looks like for you.';

function setup() {
  const env = loadEnv({ NODE_ENV: 'test', EXPORT_DIR: mkdtempSync(path.join(tmpdir(), 'mm-intro-')) } as NodeJS.ProcessEnv);
  const log = createLogger('silent');
  const storage = new MemoryStorage();
  const ctx = buildContext({ env, log, mailer: new MemoryMailer(), sms: new MemorySms() }, { storage });
  return { app: createApp({ env, log, isReady: () => true, ctx }), ctx, env };
}
type T = ReturnType<typeof setup>;

const csrfOf = (res: request.Response) =>
  ((res.headers['set-cookie'] as unknown as string[]) ?? [])
    .find((c) => c.startsWith('mm_csrf='))!
    .split(';')[0]!
    .slice('mm_csrf='.length);

let n = 0;
async function person(t: T, name: string, opts: { credits?: number; phone?: string } = {}) {
  n++;
  const email = `${name.toLowerCase()}${n}@example.com`;
  const u = await User.create({
    email,
    passwordHash: await hashPassword(PASSWORD),
    firstName: name,
    gender: n % 2 ? 'woman' : 'man',
    dobEnc: t.ctx.crypto.encrypt('1995-01-01'),
    dobYear: 1995,
    roles: ['member'],
    emailVerifiedAt: new Date(),
    journeyState: 'matching_active',
    creditBalance: opts.credits ?? 0,
    verification: { idVerifiedAt: new Date(), selfieVerifiedAt: new Date() },
    ...(opts.phone && { phoneEnc: t.ctx.crypto.encrypt(opts.phone), phoneHash: t.ctx.crypto.blindIndex(opts.phone), phoneVerifiedAt: new Date() }),
  });
  await Profile.create({
    userId: u._id,
    status: 'approved',
    data: {
      background: { city: 'Pune', state: 'Maharashtra' },
      education_career: { profession: 'Engineer', highestEducation: 'Masters' },
      about: { bio: `${name} enjoys the hills.`, prompts: [{ promptId: 'perfect_sunday', answer: 'Chai and a long book.' }] },
    },
  });
  await Photo.create({
    userId: u._id,
    key: `k${n}`,
    status: 'approved',
    isPrimary: true,
    variants: { sm: `u${n}/sm.webp`, md: `u${n}/md.webp`, lg: `u${n}/lg.webp`, blur: `u${n}/blur.webp` },
  });
  const agent = request.agent(t.app);
  const login = await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
  const csrf = csrfOf(login);
  return {
    id: String(u._id),
    email,
    get: (url: string) => agent.get(`/api/v1${url}`),
    post: (url: string) => agent.post(`/api/v1${url}`).set('x-csrf-token', csrf),
    delete: (url: string) => agent.delete(`/api/v1${url}`).set('x-csrf-token', csrf),
  };
}
type P = Awaited<ReturnType<typeof person>>;

async function introduce(a: P, b: P, over: Record<string, unknown> = {}) {
  const [x, y] = [a.id, b.id].sort();
  const i = await Introduction.create({
    pairKey: `${x}:${y}`,
    members: [{ userId: a.id }, { userId: b.id }],
    whyText: 'You both enjoy quiet weekends and see family in a similar way.',
    highlights: ['You live in the same city.'],
    state: 'released',
    expiresAt: new Date(Date.now() + 7 * 86_400_000),
    ...over,
  });
  return String(i._id);
}

let keyN = 0;
const key = () => `idem-key-${++keyN}-abcdefgh`;
const accept = (p: P, id: string, note = NOTE, k = key()) => p.post(`/introductions/${id}/accept`).set('Idempotency-Key', k).send({ firstNote: note });

async function unlockedPair(t: T) {
  const a = await person(t, 'Asha', { credits: 1 });
  const b = await person(t, 'Ravi', { credits: 1 });
  const id = await introduce(a, b);
  await accept(a, id).expect(200);
  await accept(b, id).expect(200);
  return { a, b, id };
}

describe('what a member sees', () => {
  it('shows a card with a blurred photo and kind wording, and nothing private', async () => {
    const t = setup();
    const a = await person(t, 'Asha');
    const b = await person(t, 'Ravi', { phone: '+919876543210' });
    const id = await introduce(a, b);

    const list = (await a.get('/introductions').expect(200)).body.items;
    expect(list).toHaveLength(1);
    const card = (await a.get(`/introductions/${id}`).expect(200)).body;
    expect(card).toMatchObject({ state: 'viewed', waitingOn: 'you', myStatus: 'pending' });
    expect(card.person).toMatchObject({ firstName: 'Ravi', city: 'Pune', profession: 'Engineer' });
    expect(card.person.blurredPhoto).toContain('blur.webp');
    expect(card.person.bio).toBeNull();
    expect(card.why).toMatch(/quiet weekends/);
    expect(card.person.prompts[0].answer).toMatch(/Chai/);
    const json = JSON.stringify(card);
    expect(json).not.toContain('9876543210');
    expect(json).not.toContain(b.email);
    expect(json).not.toMatch(/md\.webp|lg\.webp/); // sharp variants stay hidden until unlock
  });

  it('only lists introductions that belong to the member, and 404s others', async () => {
    const t = setup();
    const a = await person(t, 'Asha');
    const b = await person(t, 'Ravi');
    const stranger = await person(t, 'Sam');
    const id = await introduce(a, b);
    expect((await stranger.get('/introductions').expect(200)).body.items).toHaveLength(0);
    await stranger.get(`/introductions/${id}`).expect(404);
    await stranger.post(`/introductions/${id}/decline`).send({}).expect(404);
  });
});

describe('accepting', () => {
  it('requires an idempotency key, a valid first note, and an available credit', async () => {
    const t = setup();
    const a = await person(t, 'Asha', { credits: 0 });
    const b = await person(t, 'Ravi');
    const id = await introduce(a, b);

    await a.post(`/introductions/${id}/accept`).send({ firstNote: NOTE }).expect(428);
    const short = await accept(a, id, 'Hi there, nice to meet you.');
    expect(short.status).toBe(422);
    expect(short.body.error.code).toBe('FIRST_NOTE_INVALID');
    const contact = await accept(a, id, `${NOTE} My number is 98765 43210 so call me.`);
    expect(contact.status).toBe(422);

    const noCredit = await accept(a, id);
    expect(noCredit.status).toBe(402);
    expect(noCredit.body.error.code).toBe('NO_CREDITS');
    expect((await Introduction.findById(id))?.state).toBe('released');
    expect((await a.get(`/introductions/${id}`)).body.credits.needsCredit).toBe(true);
  });

  it('holds a credit, tells the member the rule, and keeps their response private', async () => {
    const t = setup();
    const a = await person(t, 'Asha', { credits: 2 });
    const b = await person(t, 'Ravi', { credits: 1 });
    const id = await introduce(a, b);
    const res = await accept(a, id).expect(200);

    expect(res.body).toMatchObject({ state: 'accepted_by_one', myStatus: 'accepted', waitingOn: 'them' });
    expect(res.body.credits).toMatchObject({ available: 1, held: 1 });
    expect(res.body.firstNoteFromThem).toBeNull();

    // The other person is not told, and sees no pressure.
    const theirs = (await b.get(`/introductions/${id}`).expect(200)).body;
    expect(theirs).toMatchObject({ state: 'accepted_by_one', waitingOn: 'you', myStatus: 'pending' });
    expect(JSON.stringify(theirs)).not.toContain('Asha enjoys');
    expect(theirs.firstNoteFromThem).toBeNull();

    const entries = await CreditLedger.find({ userId: a.id }).lean();
    expect(entries.map((e) => e.type)).toEqual(['reserve']);
  });

  it('replays a retried request exactly, and charges nothing twice', async () => {
    const t = setup();
    const a = await person(t, 'Asha', { credits: 3 });
    const b = await person(t, 'Ravi', { credits: 1 });
    const id = await introduce(a, b);
    const k = key();

    const first = await accept(a, id, NOTE, k).expect(200);
    const again = await accept(a, id, NOTE, k).expect(200);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.body).toEqual(first.body);
    expect(await CreditLedger.countDocuments({ userId: a.id, type: 'reserve' })).toBe(1);
    expect((await User.findById(a.id))?.creditBalance).toBe(2);

    // Same key, different request: refused. New key after responding: a clear conflict.
    expect((await accept(a, id, `${NOTE} Also, I like the monsoon season a lot.`, k)).status).toBe(422);
    expect((await accept(a, id, NOTE, key())).status).toBe(409);
    expect(await CreditLedger.countDocuments({ userId: a.id, type: 'reserve' })).toBe(1);
  });

  it('does not store failures, so a corrected retry with the same key works', async () => {
    const t = setup();
    const a = await person(t, 'Asha', { credits: 1 });
    const b = await person(t, 'Ravi', { credits: 1 });
    const id = await introduce(a, b);
    const k = key();
    expect((await accept(a, id, 'too short', k)).status).toBe(422);
    await accept(a, id, NOTE, k).expect(200);
  });
});

describe('mutual acceptance', () => {
  it('unlocks: spends one credit each, opens a thread, delivers first notes and reveals photos', async () => {
    const t = setup();
    const { a, b, id } = await unlockedPair(t);

    const card = (await a.get(`/introductions/${id}`).expect(200)).body;
    expect(card).toMatchObject({ state: 'mutually_accepted', waitingOn: 'none' });
    expect(card.firstNoteFromThem).toBe(NOTE);
    expect(card.person.bio).toMatch(/Ravi enjoys/);
    expect(card.threadId).toBeTruthy();

    for (const p of [a, b]) {
      const u = (await User.findById(p.id))!;
      expect(u.creditBalance).toBe(0);
      expect(u.creditsReserved).toBe(0);
      const types = (await CreditLedger.find({ userId: p.id }).sort({ _id: 1 }).lean()).map((e) => e.type);
      expect(types).toEqual(['reserve', 'consume']);
    }
    expect(await MessageThread.countDocuments({ introductionId: id })).toBe(1);
    expect(await Outbox.countDocuments({ eventType: 'introduction.unlocked' })).toBe(2);

    const photos = (await a.get(`/introductions/${id}/photos`).expect(200)).body;
    expect(photos.items).toHaveLength(1);
    expect(photos.items[0].url).toContain('lg.webp');
    expect(photos.items[0].url).toContain('ttl=300');
    expect(photos.watermark).toContain(a.id.slice(-6));
  });

  it('keeps photos closed until both have accepted', async () => {
    const t = setup();
    const a = await person(t, 'Asha', { credits: 1 });
    const b = await person(t, 'Ravi', { credits: 1 });
    const id = await introduce(a, b);
    await a.get(`/introductions/${id}/photos`).expect(403);
    await accept(a, id).expect(200);
    await a.get(`/introductions/${id}/photos`).expect(403);
  });

  it('survives both people accepting at the same moment: one unlock, one credit each', async () => {
    const t = setup();
    const a = await person(t, 'Asha', { credits: 1 });
    const b = await person(t, 'Ravi', { credits: 1 });
    const id = await introduce(a, b);
    const results = await Promise.all([accept(a, id), accept(b, id)]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);

    const intro = (await Introduction.findById(id))!;
    expect(intro.state).toBe('mutually_accepted');
    expect(await MessageThread.countDocuments({ introductionId: id })).toBe(1);
    for (const p of [a, b]) {
      expect(await CreditLedger.countDocuments({ userId: p.id, type: 'consume' })).toBe(1);
      expect(await CreditLedger.countDocuments({ userId: p.id, type: 'reserve' })).toBe(1);
      expect((await User.findById(p.id))?.creditBalance).toBe(0);
    }
  });

  it('rolls back completely when the second person has no credit', async () => {
    const t = setup();
    const a = await person(t, 'Asha', { credits: 1 });
    const b = await person(t, 'Ravi', { credits: 0 });
    const id = await introduce(a, b);
    await accept(a, id).expect(200);
    await accept(b, id).expect(402);
    const intro = (await Introduction.findById(id))!;
    expect(intro.state).toBe('accepted_by_one');
    expect(intro.members.find((m) => String(m.userId) === b.id)?.status).toBe('pending');
    expect(await MessageThread.countDocuments()).toBe(0);
  });
});

describe('declining and expiry', () => {
  it('tells the other person only that it did not move forward, and returns a held credit', async () => {
    const t = setup();
    const a = await person(t, 'Asha', { credits: 1 });
    const b = await person(t, 'Ravi', { credits: 1 });
    const id = await introduce(a, b);
    await accept(a, id).expect(200);
    expect((await User.findById(a.id))?.creditsReserved).toBe(1);

    const res = await b.post(`/introductions/${id}/decline`).send({ reason: 'different_life_plans', note: 'Wants to relocate abroad' }).expect(200);
    expect(res.body.state).toBe('declined');

    const theirs = (await a.get(`/introductions/${id}`).expect(200)).body;
    expect(theirs.state).toBe('declined');
    expect(theirs.endedMessage).toBe("This introduction didn't move forward. We'll keep looking.");
    expect(JSON.stringify(theirs)).not.toMatch(/different_life_plans|relocate/);

    const u = (await User.findById(a.id))!;
    expect([u.creditBalance, u.creditsReserved]).toEqual([1, 0]);
    // The reason is kept privately for the team.
    const stored = (await Introduction.findById(id))!.members.find((m) => String(m.userId) === b.id)!;
    expect(stored).toMatchObject({ declineReason: 'different_life_plans', declineNote: 'Wants to relocate abroad' });
    await b.post(`/introductions/${id}/decline`).send({}).expect(409);
    expect((await accept(a, id)).status).toBe(409);
  });

  it('lets someone who accepted change their mind, and gets their credit back', async () => {
    const t = setup();
    const a = await person(t, 'Asha', { credits: 1 });
    const b = await person(t, 'Ravi');
    const id = await introduce(a, b);
    await accept(a, id).expect(200);
    await a.post(`/introductions/${id}/decline`).send({}).expect(200);
    const u = (await User.findById(a.id))!;
    expect([u.creditBalance, u.creditsReserved]).toEqual([1, 0]);
  });

  it('sends reminders at 48 and 12 hours once each, then expires and releases credits', async () => {
    const t = setup();
    const a = await person(t, 'Asha', { credits: 1 });
    const b = await person(t, 'Ravi', { credits: 1 });
    const expiresAt = new Date(Date.now() + 40 * 3_600_000);
    const id = await introduce(a, b, { expiresAt });
    await accept(a, id).expect(200);

    const r1 = await expireAndRemind(new Date());
    expect(r1).toMatchObject({ expired: 0, reminded: 1 }); // 48 h marker; only Ravi is still pending
    expect((await expireAndRemind(new Date())).reminded).toBe(0); // not sent twice

    const r2 = await expireAndRemind(new Date(Date.now() + 30 * 3_600_000));
    expect(r2.reminded).toBe(1); // 12 h marker
    expect((await Introduction.findById(id))?.remindersSent.sort()).toEqual([12, 48]);
    expect(await Outbox.countDocuments({ eventType: 'introduction.reminder' })).toBe(2);

    const r3 = await expireAndRemind(new Date(expiresAt.getTime() + 1000));
    expect(r3.expired).toBe(1);
    expect((await Introduction.findById(id))?.state).toBe('expired');
    const u = (await User.findById(a.id))!;
    expect([u.creditBalance, u.creditsReserved]).toEqual([1, 0]);
    const card = (await b.get(`/introductions/${id}`).expect(200)).body;
    expect(card.endedMessage).toMatch(/didn't move forward/);
    expect((await accept(b, id)).status).toBe(409);
  });
});

describe('contact sharing', () => {
  it('reveals phone and email only when both choose to share', async () => {
    const t = setup();
    const a = await person(t, 'Asha', { credits: 1, phone: '+919811111111' });
    const b = await person(t, 'Ravi', { credits: 1, phone: '+919822222222' });
    const id = await introduce(a, b);
    await a.post(`/introductions/${id}/share-contact`).expect(409); // not unlocked yet
    await accept(a, id).expect(200);
    await accept(b, id).expect(200);

    await a.get(`/introductions/${id}/contact`).expect(403);
    await a.post(`/introductions/${id}/share-contact`).expect(200);
    await a.get(`/introductions/${id}/contact`).expect(403); // still waiting on Ravi
    const theirView = (await b.get(`/introductions/${id}`)).body;
    expect(theirView.contact).toEqual({ iShared: false, theyShared: true });

    await b.post(`/introductions/${id}/share-contact`).expect(200);
    const c = (await a.get(`/introductions/${id}/contact`).expect(200)).body;
    expect(c).toMatchObject({ firstName: 'Ravi', phone: '+919822222222' });
    expect((await b.get(`/introductions/${id}/contact`).expect(200)).body.phone).toBe('+919811111111');
  });
});

describe('messaging', () => {
  it('lets only the two members chat, with unread counts, read receipts and no contact leaks', async () => {
    const t = setup();
    const { a, b, id } = await unlockedPair(t);
    const threadId = (await a.get(`/introductions/${id}`)).body.threadId as string;
    const stranger = await person(t, 'Sam');

    await a.post(`/threads/${threadId}/messages`).send({ body: 'Hello Ravi, how was your week?' }).expect(201);
    await a.post(`/threads/${threadId}/messages`).send({ body: 'Text me on 98765 43210' }).expect(422);
    await a.post(`/threads/${threadId}/messages`).send({ body: 'Find me at www.example.com' }).expect(422);
    await stranger.get(`/threads/${threadId}/messages`).expect(404);
    await stranger.post(`/threads/${threadId}/messages`).send({ body: 'hi' }).expect(404);

    const bThreads = (await b.get('/threads').expect(200)).body.items;
    expect(bThreads[0]).toMatchObject({ unread: 1, with: { firstName: 'Asha' } });
    expect(bThreads[0].lastMessagePreview).toMatch(/Hello Ravi/);

    const asSeenByA = (await a.get(`/threads/${threadId}/messages`).expect(200)).body.items;
    expect(asSeenByA[0]).toMatchObject({ mine: true, readAt: null });
    await b.post(`/threads/${threadId}/read`).expect(200);
    expect((await a.get(`/threads/${threadId}/messages`)).body.items[0].readAt).toBeTruthy();
    expect((await b.get('/threads')).body.items[0].unread).toBe(0);
  });

  it('does not duplicate a retried message', async () => {
    const t = setup();
    const { a, id } = await unlockedPair(t);
    const threadId = (await a.get(`/introductions/${id}`)).body.threadId as string;
    const body = { body: 'Good morning!', clientId: 'c-1' };
    const first = await a.post(`/threads/${threadId}/messages`).send(body).expect(201);
    const second = await a.post(`/threads/${threadId}/messages`).send(body).expect(201);
    expect(second.body.id).toBe(first.body.id);
    expect(await Message.countDocuments({ threadId })).toBe(1);
  });
});

describe('blocking and reporting', () => {
  it('ends the introduction and conversation, returns held credits, and hides the pair both ways', async () => {
    const t = setup();
    const a = await person(t, 'Asha', { credits: 1 });
    const b = await person(t, 'Ravi', { credits: 1 });
    const id = await introduce(a, b);
    await accept(a, id).expect(200);

    await b.post('/blocks').send({ introductionId: id }).expect(201);
    expect((await Introduction.findById(id))?.state).toBe('declined');
    expect((await Introduction.findById(id))?.closedReason).toBe('blocked');
    const u = (await User.findById(a.id))!;
    expect([u.creditBalance, u.creditsReserved]).toEqual([1, 0]);

    expect((await a.get('/introductions').expect(200)).body.items).toHaveLength(0);
    expect((await b.get('/introductions').expect(200)).body.items).toHaveLength(0);
    await a.get(`/introductions/${id}`).expect(404);

    expect((await b.get('/blocks').expect(200)).body.items[0].userId).toBe(a.id);
    await b.delete(`/blocks/${a.id}`).expect(200);
    expect(await Block.countDocuments()).toBe(0);
  });

  it('closes a live conversation when someone blocks', async () => {
    const t = setup();
    const { a, b, id } = await unlockedPair(t);
    const threadId = (await a.get(`/introductions/${id}`)).body.threadId as string;
    await a.post('/blocks').send({ userId: b.id }).expect(201);
    expect((await MessageThread.findById(threadId))?.status).toBe('closed');
    await b.post(`/threads/${threadId}/messages`).send({ body: 'Are you there?' }).expect(404);
    expect((await a.get('/threads')).body.items).toHaveLength(0);
  });

  it('files a report with the conversation preserved, and escalates safety threats at once', async () => {
    const t = setup();
    const { a, b, id } = await unlockedPair(t);
    const threadId = (await a.get(`/introductions/${id}`)).body.threadId as string;
    await b.post(`/threads/${threadId}/messages`).send({ body: 'Please send some money for my emergency.' }).expect(201);

    const scam = await a.post('/reports').send({ introductionId: id, category: 'scam_money_request', details: 'Asked for money' }).expect(201);
    expect(scam.body.severity).toBe('high');
    const stored = (await Report.findById(scam.body.id))!;
    expect(String(stored.reportedId)).toBe(b.id);
    expect(stored.transcript.map((m) => m.body)).toEqual(['Please send some money for my emergency.']);
    expect(await Outbox.countDocuments({ eventType: 'safety.critical_report' })).toBe(0);

    const threat = await a.post('/reports').send({ introductionId: id, category: 'safety_threat' }).expect(201);
    expect(threat.body.severity).toBe('critical');
    expect(await Outbox.countDocuments({ eventType: 'safety.critical_report' })).toBe(1);

    const mine = (await a.get('/reports/mine').expect(200)).body.items;
    expect(mine).toHaveLength(2);
    expect(JSON.stringify(mine)).not.toMatch(/money for my emergency/); // reporters see status, not evidence
    await a.post('/reports').send({ category: 'other' }).expect(422);
  });
});

describe('credits and data rights', () => {
  it('grants credits only through an audited, permissioned route; the ledger cannot be edited', async () => {
    const t = setup();
    const m = await person(t, 'Asha');
    await User.create({
      email: 'fin@example.com',
      passwordHash: await hashPassword(PASSWORD),
      firstName: 'Fin',
      gender: 'woman',
      dobEnc: t.ctx.crypto.encrypt('1990-01-01'),
      roles: ['admin'] as Role[],
      emailVerifiedAt: new Date(),
    });
    const agent = request.agent(t.app);
    const login = await agent.post('/api/v1/auth/login').send({ email: 'fin@example.com', password: PASSWORD }).expect(200);
    let csrf = csrfOf(login);
    const s = await agent.post('/api/v1/auth/2fa/setup').set('x-csrf-token', csrf).expect(200);
    const c = await agent.post('/api/v1/auth/2fa/confirm').set('x-csrf-token', csrf).send({ code: generateSync({ secret: String(s.body.secret) }) }).expect(200);
    csrf = csrfOf(c);

    await agent.post(`/api/v1/admin/members/${m.id}/credits`).set('x-csrf-token', csrf).send({ amount: 2, reason: 'x' }).expect(422);
    await agent.post(`/api/v1/admin/members/${m.id}/credits`).set('x-csrf-token', csrf).send({ amount: 2, reason: 'Goodwill after an outage' }).expect(201);
    expect((await User.findById(m.id))?.creditBalance).toBe(2);
    const ledger = (await m.get('/billing/credits/ledger').expect(200)).body.items;
    expect(ledger[0]).toMatchObject({ type: 'grant', delta: 2, balanceAfter: 2 });

    await expect(CreditLedger.updateOne({}, { $set: { delta: 99 } })).rejects.toThrow(/immutable/);
    await expect(CreditLedger.deleteMany({})).rejects.toThrow(/immutable/);
  });

  it('exports a member\'s own words and erases their messages, ending open introductions kindly', async () => {
    const t = setup();
    registerMemberDataHooks(t.ctx);
    const { a, b, id } = await unlockedPair(t);
    const threadId = (await a.get(`/introductions/${id}`)).body.threadId as string;
    await a.post(`/threads/${threadId}/messages`).send({ body: 'See you on the weekend!' }).expect(201);

    const exp = await a.post('/account/export').expect(202);
    await buildExport(t.ctx, exp.body.id);
    const json = await readExport(t.ctx.storage, exp.body.id);
    expect(json.introductions[0]).toMatchObject({ state: 'mutually_accepted', myFirstNote: NOTE });
    expect(json.messagesSent.map((m: { body: string }) => m.body)).toContain('See you on the weekend!');
    expect(JSON.stringify(json)).not.toContain(b.id);

    // A third introduction left open by the leaver returns the other member's held credit.
    const c = await person(t, 'Cara', { credits: 1 });
    const open = await introduce(a, c);
    await accept(c, open).expect(200);
    expect((await User.findById(c.id))?.creditsReserved).toBe(1);

    await a.post('/account/delete').send({ confirm: 'DELETE', password: PASSWORD }).expect(200);
    await User.updateOne({ _id: a.id }, { $set: { deletionScheduledFor: new Date(Date.now() - 1000) } });
    expect(await purgeDueAccounts(t.ctx)).toBe(1);

    expect(await Message.countDocuments({ senderId: a.id })).toBe(0);
    expect((await MessageThread.findById(threadId))?.status).toBe('closed');
    const cu = (await User.findById(c.id))!;
    expect([cu.creditBalance, cu.creditsReserved]).toEqual([1, 0]);
    const kept = await Introduction.findById(id);
    expect(kept?.members.find((m) => String(m.userId) === a.id)?.firstNote).toBeUndefined();
  });
});
