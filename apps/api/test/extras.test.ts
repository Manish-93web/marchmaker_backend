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
import { createLogger } from '../src/lib/logger';
import { MemoryMailer } from '../src/lib/mailer';
import { hashPassword } from '../src/lib/passwords';
import { MemorySms } from '../src/lib/sms';
import type { MockCallProvider } from '../src/lib/telephony';
import { MemoryStorage } from '../src/lib/storage';
import { Consent } from '../src/models/auth';
import { Guide } from '../src/models/content';
import { FeatureFlag, User } from '../src/models/core';
import { AstroProfile, AstroReport, CallLog } from '../src/models/extras';
import { Introduction } from '../src/models/matching';
import { startCall } from '../src/services/voice';

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
// 11:00 India time, inside calling hours whatever the machine clock says.
const DAYTIME = new Date('2026-03-10T05:30:00Z');

function setup() {
  const env = loadEnv({ NODE_ENV: 'test', EXPORT_DIR: mkdtempSync(path.join(tmpdir(), 'mm-extras-')) } as NodeJS.ProcessEnv);
  const log = createLogger('silent');
  const storage = new MemoryStorage();
  const ctx = buildContext({ env, log, mailer: new MemoryMailer(), sms: new MemorySms() }, { storage });
  return { app: createApp({ env, log, isReady: () => true, ctx }), ctx, storage, calls: ctx.calls as MockCallProvider };
}
type T = ReturnType<typeof setup>;

const csrfOf = (res: request.Response) =>
  ((res.headers['set-cookie'] as unknown as string[]) ?? [])
    .find((c) => c.startsWith('mm_csrf='))!
    .split(';')[0]!
    .slice('mm_csrf='.length);

let n = 0;
async function person(t: T, over: Record<string, unknown> = {}, roles: Role[] = ['member']) {
  n++;
  const email = `x${n}@example.com`;
  const phone = `+9198765${String(10000 + n)}`;
  const u = await User.create({
    email,
    passwordHash: await hashPassword(PASSWORD),
    firstName: `Person${n}`,
    gender: 'woman',
    dobEnc: t.ctx.crypto.encrypt('1995-01-01'),
    dobYear: 1995,
    roles,
    emailVerifiedAt: new Date(),
    phoneEnc: t.ctx.crypto.encrypt(phone),
    phoneHash: t.ctx.crypto.blindIndex(phone),
    phoneVerifiedAt: new Date(),
    journeyState: 'matching_active',
    ...over,
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
    phone,
    get: (url: string) => agent.get(`/api/v1${url}`),
    post: (url: string) => agent.post(`/api/v1${url}`).set('x-csrf-token', csrf),
    put: (url: string) => agent.put(`/api/v1${url}`).set('x-csrf-token', csrf),
    delete: (url: string) => agent.delete(`/api/v1${url}`).set('x-csrf-token', csrf),
  };
}

const flag = (key: string, enabled = true) => FeatureFlag.updateOne({ key }, { $set: { enabled } }, { upsert: true });

async function unlockedPair(t: T, aOver: Record<string, unknown> = {}, bOver: Record<string, unknown> = {}) {
  const a = await person(t, aOver);
  const b = await person(t, bOver);
  const [x, y] = [a.id, b.id].sort();
  const i = await Introduction.create({
    pairKey: `${x}:${y}`,
    members: [{ userId: a.id, status: 'accepted' }, { userId: b.id, status: 'accepted' }],
    whyText: 'You both enjoy quiet weekends and long walks.',
    state: 'mutually_accepted',
    unlockedAt: new Date(),
    expiresAt: new Date(Date.now() + 1e9),
  });
  return { a, b, id: String(i._id) };
}

describe('feature flags', () => {
  it('make switched-off features look like they do not exist', async () => {
    const t = setup();
    const { a, id } = await unlockedPair(t);
    await Guide.create({ slug: 'first-call', title: 'First call', published: true, bodyMarkdown: 'Hi' });
    await request(t.app).get('/api/v1/guides/first-call').expect(404);
    await a.post(`/introductions/${id}/voice/opt-in`).send({ open: true }).expect(404);
    await a.get('/astrology').expect(404);
    await flag('e_guides');
    await request(t.app).get('/api/v1/guides/first-call').expect(200);
  });
});

describe('e-guides', () => {
  beforeEach(() => flag('e_guides'));

  it('remembers where a member got to, per guide, and rejects nonsense values', async () => {
    const t = setup();
    await Guide.create({ slug: 'first-call', title: 'First call', published: true, bodyMarkdown: 'x', access: 'free', audioKey: 'guides/first-call/a.mp3' });
    const m = await person(t);
    expect((await m.get('/guide-progress/first-call').expect(200)).body).toEqual({ positionSec: 0, scrollPct: 0, speed: 1, completed: false });
    await m.put('/guide-progress/first-call').send({ positionSec: 95, speed: 1.5 }).expect(200);
    expect((await m.get('/guide-progress/first-call').expect(200)).body).toMatchObject({ positionSec: 95, speed: 1.5 });
    await m.put('/guide-progress/first-call').send({ speed: 5 }).expect(422);
    await m.put('/guide-progress/missing').send({ positionSec: 1 }).expect(404);
    await request(t.app).get('/api/v1/guide-progress/first-call').expect(401);
  });

  it('gives free guides to everyone and premium ones only to premium members, with the audio gated the same way', async () => {
    const t = setup();
    await Guide.create({ slug: 'free-one', title: 'Free', summary: 'Open to all', published: true, bodyMarkdown: 'Body A', access: 'free', audioKey: 'guides/free-one/a.mp3', audioSeconds: 120 });
    await Guide.create({ slug: 'prem-one', title: 'Premium', summary: 'For members', published: true, bodyMarkdown: 'Secret body', access: 'premium', audioKey: 'guides/prem-one/a.mp3', audioSeconds: 300 });
    await Guide.create({ slug: 'draft', title: 'Draft', published: false, bodyMarkdown: 'x' });
    await t.storage.put('documents', 'guides/free-one/a.mp3', Buffer.from('a'), 'audio/mpeg');
    await t.storage.put('documents', 'guides/prem-one/a.mp3', Buffer.from('a'), 'audio/mpeg');

    const visitor = request(t.app);
    expect((await visitor.get('/api/v1/guides/free-one').expect(200)).body).toMatchObject({ allowed: true, bodyMarkdown: 'Body A', hasAudio: true });
    expect((await visitor.get('/api/v1/guides/free-one/audio').expect(200)).body.url).toContain('guides/free-one');
    const locked = (await visitor.get('/api/v1/guides/prem-one').expect(200)).body;
    expect(locked).toMatchObject({ allowed: false, bodyMarkdown: null, summary: 'For members' });
    expect(JSON.stringify(locked)).not.toContain('Secret body');
    await visitor.get('/api/v1/guides/prem-one/audio').expect(402);
    await visitor.get('/api/v1/guides/draft').expect(404);

    const essential = await person(t, { plan: { planCode: 'essential', status: 'active' } });
    expect((await essential.get('/guides/prem-one').expect(200)).body.allowed).toBe(false);
    const premium = await person(t, { plan: { planCode: 'premium', status: 'active' } });
    expect((await premium.get('/guides/prem-one').expect(200)).body).toMatchObject({ allowed: true, bodyMarkdown: 'Secret body' });
    expect((await premium.get('/guides/prem-one/audio').expect(200)).body.url).toContain('guides/prem-one');
  });

  it('lets content staff write a guide and attach audio through a signed upload', async () => {
    const t = setup();
    const admin = await person(t, {}, ['admin']);
    const member = await person(t);
    const body = { slug: 'making-the-first-call', title: 'Making the first call', summary: 'What to say', bodyMarkdown: '# Hello\n\nBe **kind**.', access: 'premium', published: true };
    await member.put('/admin/guides').send(body).expect(403);
    await admin.put('/admin/guides').send({ ...body, slug: 'Bad Slug' }).expect(422);
    await admin.put('/admin/guides').send(body).expect(200);

    await admin.post('/admin/guides/making-the-first-call/audio').send({ contentType: 'video/mp4', sizeBytes: 5_000_000, seconds: 100 }).expect(422);
    const up = (await admin.post('/admin/guides/making-the-first-call/audio').send({ contentType: 'audio/mpeg', sizeBytes: 5_000_000, seconds: 100 }).expect(201)).body;
    expect(up.key).toMatch(/^guides\/making-the-first-call\/.+\.mp3$/);
    // Confirming before the file arrives is refused, and keys for another guide are refused.
    await admin.post('/admin/guides/making-the-first-call/audio/confirm').send({ key: up.key, seconds: 100 }).expect(409);
    await t.storage.put('documents', up.key, Buffer.from('audio'), 'audio/mpeg');
    await admin.post('/admin/guides/other/audio/confirm').send({ key: up.key, seconds: 100 }).expect(409);
    await admin.post('/admin/guides/making-the-first-call/audio/confirm').send({ key: up.key, seconds: 100 }).expect(200);
    const g = (await Guide.findOne({ slug: 'making-the-first-call' }).lean())!;
    expect(g.audioKey).toBe(up.key);
    expect(g.publishedAt).toBeTruthy();
  });
});

describe('voice calls', () => {
  beforeEach(() => flag('voice_calls'));

  it('needs both people to opt in, and never reveals or logs a number', async () => {
    const t = setup();
    const { a, b, id } = await unlockedPair(t);
    await a.post(`/introductions/${id}/voice/call`).send({}).expect(409); // nobody has opted in
    expect((await a.post(`/introductions/${id}/voice/opt-in`).send({ open: true }).expect(200)).body).toEqual({ iOptIn: true, theyOptIn: false });
    expect((await b.get(`/introductions/${id}`).expect(200)).body.voice).toEqual({ iOptIn: false, theyOptIn: true });
    await expect(startCall(t.ctx, id, a.id, DAYTIME)).rejects.toMatchObject({ code: 'VOICE_NOT_AGREED' });
    await b.post(`/introductions/${id}/voice/opt-in`).send({ open: true }).expect(200);

    const out = await startCall(t.ctx, id, a.id, DAYTIME);
    expect(out).toEqual({ status: 'initiated', remainingToday: 2 });
    expect(t.calls.calls).toHaveLength(1);
    expect(t.calls.calls[0]).toMatchObject({ fromE164: a.phone, toE164: b.phone });

    const hist = (await a.get(`/introductions/${id}/voice/history`).expect(200)).body;
    expect(hist.items).toHaveLength(1);
    expect(JSON.stringify(hist)).not.toContain(b.phone.slice(-6));
    expect(JSON.stringify(await CallLog.find().lean())).not.toContain(b.phone.slice(-6));
    // Withdrawing opt-in stops further calls.
    await b.post(`/introductions/${id}/voice/opt-in`).send({ open: false }).expect(200);
    await expect(startCall(t.ctx, id, a.id, DAYTIME)).rejects.toMatchObject({ code: 'VOICE_NOT_AGREED' });
  });

  it('keeps to calling hours, the daily limit and verified phones', async () => {
    const t = setup();
    const { a, b, id } = await unlockedPair(t);
    for (const p of [a, b]) await p.post(`/introductions/${id}/voice/opt-in`).send({ open: true }).expect(200);

    await expect(startCall(t.ctx, id, a.id, new Date('2026-03-10T17:30:00Z'))).rejects.toMatchObject({ code: 'OUTSIDE_CALL_HOURS' }); // 23:00 IST
    for (let i = 0; i < 3; i++) await startCall(t.ctx, id, i % 2 ? b.id : a.id, DAYTIME);
    await expect(startCall(t.ctx, id, a.id, DAYTIME)).rejects.toMatchObject({ code: 'CALL_LIMIT' });

    await CallLog.deleteMany({});
    await User.updateOne({ _id: b.id }, { $unset: { phoneVerifiedAt: 1 } });
    await expect(startCall(t.ctx, id, a.id, DAYTIME)).rejects.toMatchObject({ code: 'CALL_UNAVAILABLE' });
    await User.updateOne({ _id: a.id }, { $unset: { phoneVerifiedAt: 1 } });
    await expect(startCall(t.ctx, id, a.id, DAYTIME)).rejects.toMatchObject({ code: 'PHONE_NOT_VERIFIED' });
  });

  it('reports a provider failure kindly and keeps status events in order', async () => {
    const t = setup();
    const { a, b, id } = await unlockedPair(t);
    for (const p of [a, b]) await p.post(`/introductions/${id}/voice/opt-in`).send({ open: true }).expect(200);
    t.calls.failNext = true;
    await expect(startCall(t.ctx, id, a.id, DAYTIME)).rejects.toMatchObject({ code: 'CALL_FAILED' });
    expect((await CallLog.findOne().lean())!.status).toBe('failed');

    await CallLog.deleteMany({});
    await startCall(t.ctx, id, a.id, DAYTIME);
    const hook = (e: Parameters<MockCallProvider['event']>[0]) => {
      const w = t.calls.event(e);
      return request(t.app).post('/api/v1/webhooks/calls').set(w.headers).send(w.body);
    };
    await hook({ providerCallId: 'call_1', status: 'completed', durationSec: 95 }).expect(200);
    await hook({ providerCallId: 'call_1', status: 'ringing' }).expect(200); // late, must not move backwards
    const log = (await CallLog.findOne({ providerCallId: 'call_1' }).lean())!;
    expect(log).toMatchObject({ status: 'completed', durationSec: 95 });

    await request(t.app).post('/api/v1/webhooks/calls').set({ 'x-call-signature': 'bad', 'content-type': 'application/json' }).send('{}').expect(401);
  });
});

describe('astrology', () => {
  beforeEach(() => flag('astrology'));
  const birth = { time: '06:45', place: 'Pune', latitude: 18.52, longitude: 73.85 };
  const premium = { plan: { planCode: 'premium', status: 'active' } };
  const agree = (id: string) => Consent.create({ userId: id, purpose: 'astrology', granted: true });

  it('needs consent and the Premium plan, and stores birth details encrypted', async () => {
    const t = setup();
    const free = await person(t);
    await agree(free.id);
    await free.put('/astrology/details').send({ ...birth, shareWithMatches: false }).expect(402);

    const m = await person(t, premium);
    await m.put('/astrology/details').send({ ...birth, shareWithMatches: false }).expect(403); // no consent yet
    await agree(m.id);
    await m.put('/astrology/details').send({ time: '25:99', place: 'Pune', latitude: 18, longitude: 73 }).expect(422);
    const s = (await m.put('/astrology/details').send({ ...birth, shareWithMatches: false }).expect(200)).body;
    expect(s).toMatchObject({ hasDetails: true, place: 'Pune', consent: true });
    expect(s.disclaimer).toMatch(/never used to choose, rank or filter/);
    const raw = JSON.stringify(await AstroProfile.findOne({ userId: m.id }).lean());
    expect(raw).not.toContain('Pune');
    expect(raw).not.toContain('06:45');

    const report = (await m.get('/astrology/report').expect(200)).body;
    expect(report).toMatchObject({ kind: 'kundli', sample: true });
    expect(report.chart.moonSign).toBeTruthy();
    expect(['yes', 'partial', 'no', 'unknown']).toContain(report.chart.manglik);

    // Withdrawing consent stops it straight away.
    await Consent.create({ userId: m.id, purpose: 'astrology', granted: false });
    await m.get('/astrology/report').expect(403);
  });

  it('gives a compatibility reading only when both agreed, caches it, and removes it when either erases', async () => {
    const t = setup();
    const { a, b, id } = await unlockedPair(t, premium, premium);
    for (const p of [a, b]) await agree(p.id);
    await a.put('/astrology/details').send({ ...birth, shareWithMatches: true }).expect(200);
    await a.get(`/introductions/${id}/astrology`).expect(409); // b has no details yet
    await b.put('/astrology/details').send({ ...birth, place: 'Mumbai', shareWithMatches: false }).expect(200);
    await a.get(`/introductions/${id}/astrology`).expect(409); // b has not agreed to share
    await b.put('/astrology/details').send({ ...birth, place: 'Mumbai', shareWithMatches: true }).expect(200);

    const first = (await a.get(`/introductions/${id}/astrology`).expect(200)).body;
    expect(first).toMatchObject({ kind: 'match', sample: true });
    expect(first.result.points).toBeLessThanOrEqual(36);
    expect(first.result.gunaVerdict).toBeTruthy();
    expect(first.result.manglik).toHaveProperty('balanced');
    const again = (await b.get(`/introductions/${id}/astrology`).expect(200)).body;
    expect(again.result).toEqual(first.result);
    expect(await AstroReport.countDocuments({ kind: 'match' })).toBe(1);

    // If the other person withdraws consent, the reading is no longer available.
    await Consent.create({ userId: b.id, purpose: 'astrology', granted: false });
    await a.get(`/introductions/${id}/astrology`).expect(409);
    await Consent.create({ userId: b.id, purpose: 'astrology', granted: true });

    await b.delete('/astrology').expect(200);
    expect(await AstroProfile.countDocuments({ userId: b.id })).toBe(0);
    expect(await AstroReport.countDocuments({ kind: 'match' })).toBe(0);
  });

  it('only gives a reading for an introduction the member is part of', async () => {
    const t = setup();
    const { id } = await unlockedPair(t, premium, premium);
    const outsider = await person(t, premium);
    await agree(outsider.id);
    await outsider.get(`/introductions/${id}/astrology`).expect(404);
  });
});
