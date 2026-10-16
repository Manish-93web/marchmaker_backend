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
import { Payment } from '../src/models/billing';
import { Consent } from '../src/models/auth';
import { SuccessStory } from '../src/models/content';
import { AuditLog, Outbox, StateTransition, User } from '../src/models/core';
import { ActiveDay, AnalyticsEvent, CheckinMarker, Experiment } from '../src/models/growth';
import { Introduction } from '../src/models/matching';
import { sendCheckIns } from '../src/services/feedback';
import { clearMetricsCache } from '../src/services/metrics';

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
  clearMetricsCache();
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
});

const PASSWORD = 'Sup3rSecretPass';
const DAY = 86_400_000;

function setup() {
  const env = loadEnv({ NODE_ENV: 'test', EXPORT_DIR: mkdtempSync(path.join(tmpdir(), 'mm-growth-')) } as NodeJS.ProcessEnv);
  const log = createLogger('silent');
  const ctx = buildContext({ env, log, mailer: new MemoryMailer(), sms: new MemorySms() });
  return { app: createApp({ env, log, isReady: () => true, ctx }), ctx };
}
type T = ReturnType<typeof setup>;

const csrfOf = (res: request.Response) =>
  ((res.headers['set-cookie'] as unknown as string[]) ?? [])
    .find((c) => c.startsWith('mm_csrf='))!
    .split(';')[0]!
    .slice('mm_csrf='.length);

let n = 0;
async function person(t: T, roles: Role[] = ['member'], over: Record<string, unknown> = {}) {
  n++;
  const email = `g${n}@example.com`;
  const u = await User.create({
    email,
    passwordHash: await hashPassword(PASSWORD),
    firstName: `Person${n}`,
    gender: 'woman',
    dobEnc: t.ctx.crypto.encrypt('1995-01-01'),
    dobYear: 1995,
    roles,
    emailVerifiedAt: new Date(),
    journeyState: 'matching_active',
    ...over,
  });
  const agent = request.agent(t.app);
  const login = await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
  let csrf = csrfOf(login);
  if (roles.some((r) => r !== 'member')) {
    const s = await agent.post('/api/v1/auth/2fa/setup').set('x-csrf-token', csrf).expect(200);
    const c = await agent
      .post('/api/v1/auth/2fa/confirm')
      .set('x-csrf-token', csrf)
      .send({ code: generateSync({ secret: String(s.body.secret) }) })
      .expect(200);
    csrf = csrfOf(c);
  }
  return {
    id: String(u._id),
    email,
    get: (url: string) => agent.get(`/api/v1${url}`),
    post: (url: string) => agent.post(`/api/v1${url}`).set('x-csrf-token', csrf),
    put: (url: string) => agent.put(`/api/v1${url}`).set('x-csrf-token', csrf),
    delete: (url: string) => agent.delete(`/api/v1${url}`).set('x-csrf-token', csrf),
  };
}
type P = Awaited<ReturnType<typeof person>>;

const batch = (events: unknown[], over: Record<string, unknown> = {}) => ({ consent: true, anonId: 'anon-12345678', events, ...over });

async function unlocked(a: P, b: P, daysAgo = 8) {
  const [x, y] = [a.id, b.id].sort();
  const i = await Introduction.create({
    pairKey: `${x}:${y}`,
    members: [{ userId: a.id, status: 'accepted' }, { userId: b.id, status: 'accepted' }],
    whyText: 'You both like quiet weekends and long walks.',
    state: 'mutually_accepted',
    unlockedAt: new Date(Date.now() - daysAgo * DAY),
    expiresAt: new Date(Date.now() + 5 * DAY),
  });
  return String(i._id);
}

describe('analytics', () => {
  it('stores only allowed events and properties, for visitors who consented', async () => {
    const t = setup();
    await request(t.app)
      .post('/api/v1/analytics/events')
      .send(batch([{ name: 'page_view', props: { path: '/pricing', email: 'a@b.com', note: 'free text' } }]))
      .expect(202);
    const e = (await AnalyticsEvent.findOne({}).lean())!;
    expect(e.props).toEqual({ path: '/pricing' });
    expect(e.uid).toBeUndefined();
    expect(JSON.stringify(e)).not.toContain('a@b.com');
    expect(e.expiresAt.getTime()).toBeGreaterThan(Date.now() + 300 * DAY);
  });

  it('refuses without consent and refuses unknown events', async () => {
    const t = setup();
    await request(t.app).post('/api/v1/analytics/events').send(batch([{ name: 'page_view' }], { consent: false })).expect(422);
    await request(t.app).post('/api/v1/analytics/events').send(batch([{ name: 'keylog' }])).expect(422);
    expect(await AnalyticsEvent.countDocuments({})).toBe(0);
  });

  it('checks a signed-in member\'s stored consent on the server and never stores their id', async () => {
    const t = setup();
    const m = await person(t);
    const noConsent = await m.post('/analytics/events').send(batch([{ name: 'page_view', props: { path: '/dashboard' } }])).expect(202);
    expect(noConsent.body).toEqual({ accepted: 0 });
    expect(await AnalyticsEvent.countDocuments({})).toBe(0);

    await Consent.create({ userId: m.id, purpose: 'analytics', granted: true });
    expect((await m.post('/analytics/events').send(batch([{ name: 'page_view', props: { path: '/dashboard' } }])).expect(202)).body).toEqual({ accepted: 1 });
    const e = (await AnalyticsEvent.findOne({}).lean())!;
    expect(e.uid).toBeTruthy();
    expect(JSON.stringify(e)).not.toContain(m.id);

    // Withdrawing consent stops it immediately.
    await Consent.create({ userId: m.id, purpose: 'analytics', granted: false });
    expect((await m.post('/analytics/events').send(batch([{ name: 'page_view' }])).expect(202)).body).toEqual({ accepted: 0 });
  });
});

describe('experiments', () => {
  it('gives the same variant every time and ignores disabled experiments', async () => {
    const t = setup();
    await Experiment.create({ key: 'hero_copy', enabled: true, variants: [{ name: 'control', weight: 50 }, { name: 'warm', weight: 50 }] });
    await Experiment.create({ key: 'old_test', enabled: false, variants: [{ name: 'a', weight: 1 }, { name: 'b', weight: 1 }] });
    const get = () => request(t.app).get('/api/v1/experiments?anonId=anon-abcdefgh');
    const first = (await get().expect(200)).body.assignments;
    expect(Object.keys(first)).toEqual(['hero_copy']);
    expect((await get().expect(200)).body.assignments).toEqual(first);
    expect((await request(t.app).get('/api/v1/experiments').expect(200)).body.assignments).toEqual({});
  });

  it('is managed only by people who can manage flags, and every change is logged', async () => {
    const t = setup();
    const admin = await person(t, ['admin']);
    const support = await person(t, ['support_agent']);
    const body = { key: 'pricing_layout', description: 'Compare layouts', enabled: true, variants: [{ name: 'a', weight: 1 }, { name: 'b', weight: 1 }] };
    await support.put('/admin/experiments').send(body).expect(403);
    await admin.put('/admin/experiments').send({ ...body, variants: [{ name: 'a', weight: 1 }] }).expect(422);
    await admin.put('/admin/experiments').send(body).expect(200);
    expect((await admin.get('/admin/experiments').expect(200)).body.items).toHaveLength(1);
    await admin.delete('/admin/experiments/pricing_layout').expect(200);
    expect(await AuditLog.countDocuments({ action: { $regex: '^experiment\\.' } })).toBe(2);
  });
});

describe('feedback loop', () => {
  it('accepts one note per unlocked introduction, from a participant only', async () => {
    const t = setup();
    const a = await person(t);
    const b = await person(t);
    const outsider = await person(t);
    const id = await unlocked(a, b);
    const body = { introductionId: id, rating: 4, tags: ['kind', 'good_conversation'], note: 'We had a lovely call.' };
    await outsider.post('/feedback/introductions').send(body).expect(404);
    await a.post('/feedback/introductions').send(body).expect(201);
    await a.post('/feedback/introductions').send(body).expect(409);
    await b.post('/feedback/introductions').send({ ...body, rating: 2, tags: ['different_expectations'] }).expect(201);
    await a.post('/feedback/introductions').send({ ...body, rating: 9 }).expect(422);
  });

  it('only asks about an introduction that is still open for feedback, once, a week after unlock', async () => {
    const t = setup();
    const a = await person(t);
    const b = await person(t);
    await unlocked(a, b, 8);
    const fresh1 = await person(t);
    const fresh2 = await person(t);
    await unlocked(fresh1, fresh2, 2);

    expect((await a.get('/feedback/pending').expect(200)).body.items).toHaveLength(1);
    expect((await fresh1.get('/feedback/pending').expect(200)).body.items).toHaveLength(0);

    expect(await sendCheckIns()).toBe(2); // a and b, not the recent pair
    expect(await sendCheckIns()).toBe(0); // never twice
    expect(await CheckinMarker.countDocuments({})).toBe(2);
    expect(await Outbox.countDocuments({ eventType: 'feedback.checkin' })).toBe(2);
  });

  it('offers a gentle suggestion only after a clear pattern, and tells staff the same', async () => {
    const t = setup();
    const me = await person(t);
    const admin = await person(t, ['admin']);
    const reasons = ['location_doesnt_work', 'location_doesnt_work', 'timing_not_right', 'location_doesnt_work'];
    for (const reason of reasons) {
      const other = await person(t);
      const [x, y] = [me.id, other.id].sort();
      await Introduction.create({
        pairKey: `${x}:${y}`,
        members: [{ userId: me.id, status: 'declined', declineReason: reason }, { userId: other.id, status: 'pending' }],
        whyText: 'Why',
        state: 'declined',
        expiresAt: new Date(Date.now() + DAY),
      });
    }
    const hints = (await me.get('/feedback/hints').expect(200)).body.items;
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ reason: 'location_doesnt_work', count: 3, focus: 'location' });

    const insight = (await admin.get(`/admin/members/${me.id}/feedback`).expect(200)).body;
    expect(insight.declineReasons).toEqual({ location_doesnt_work: 3, timing_not_right: 1 });
  });
});

describe('success stories', () => {
  const story = { coupleNames: 'Asha and Ravi', city: 'Pune', quote: 'We met through Marchmaker and talked for hours on our first call. It felt easy from the start.', consent: true, partnerConsent: true };

  it('stays private until staff confirm the partner agreed, and can be withdrawn at any time', async () => {
    const t = setup();
    const m = await person(t);
    const admin = await person(t, ['admin']);
    await m.post('/stories').send({ ...story, partnerConsent: false }).expect(422);
    const created = (await m.post('/stories').send(story).expect(201)).body;
    await m.post('/stories').send(story).expect(409);

    const publicList = async () => (await request(t.app).get('/api/v1/success-stories').expect(200)).body;
    expect(JSON.stringify(await publicList())).not.toContain('Asha and Ravi');

    const queue = (await admin.get('/admin/stories').expect(200)).body.items;
    expect(queue[0].id).toBe(created.id);
    await admin.post(`/admin/stories/${created.id}/decision`).send({ decision: 'publish', note: 'Looks good to publish' }).expect(409);
    await admin
      .post(`/admin/stories/${created.id}/decision`)
      .send({ decision: 'publish', partnerConsentConfirmed: true, note: 'Spoke to both of them', quote: 'We met through Marchmaker and talked for hours on our first call.' })
      .expect(200);
    expect(JSON.stringify(await publicList())).toContain('Asha and Ravi');
    expect((await SuccessStory.findById(created.id).lean())!.originalQuote).toContain('felt easy from the start');
    expect(await Outbox.countDocuments({ eventType: 'story.decided' })).toBe(1);

    await m.post(`/stories/${created.id}/withdraw`).send({}).expect(200);
    expect(JSON.stringify(await publicList())).not.toContain('Asha and Ravi');
    // After withdrawing they may share a new one.
    await m.post('/stories').send(story).expect(201);
  });

  it('lets staff decline a story with a kind note, and keeps it off the site', async () => {
    const t = setup();
    const m = await person(t);
    const admin = await person(t, ['admin']);
    const created = (await m.post('/stories').send(story).expect(201)).body;
    await admin.post(`/admin/stories/${created.id}/decision`).send({ decision: 'reject', note: 'We cannot reach your partner yet' }).expect(200);
    const mine = (await m.get('/stories/mine').expect(200)).body.items[0];
    expect(mine).toMatchObject({ status: 'rejected', note: 'We cannot reach your partner yet' });
    await admin.post(`/admin/stories/${created.id}/decision`).send({ decision: 'publish', partnerConsentConfirmed: true, note: 'Changed my mind' }).expect(409);
  });
});

describe('metrics', () => {
  it('keeps the dashboard to people with metrics access', async () => {
    const t = setup();
    const m = await person(t);
    await m.get('/admin/metrics').expect(403);
    const support = await person(t, ['support_agent']);
    await support.get('/admin/metrics').expect(403);
  });

  it('builds a funnel from what members actually did, plus revenue, backlog and retention', async () => {
    const t = setup();
    const admin = await person(t, ['admin']);
    const mk = (over: Record<string, unknown> = {}) => person(t, ['member'], { journeyState: 'registered', emailVerifiedAt: undefined, ...over });
    const a = await mk({ emailVerifiedAt: new Date() });
    const b = await mk({ emailVerifiedAt: new Date() });
    const c = await mk();
    const trail = async (u: P, states: string[]) => {
      let at = Date.now() - 3 * DAY;
      for (const s of states) {
        at += 3_600_000 * 2; // two hours between steps
        await StateTransition.create({ entityType: 'user_journey', entityId: u.id, to: s, createdAt: new Date(at) });
      }
    };
    await trail(a, ['profile_submitted', 'profile_approved', 'verified', 'matching_active']);
    await trail(b, ['profile_submitted']);
    await trail(c, []);
    await User.updateOne({ _id: b.id }, { $set: { journeyState: 'profile_submitted' } });

    const other = await mk();
    const [x, y] = [a.id, other.id].sort();
    await Introduction.create({
      pairKey: `${x}:${y}`,
      members: [{ userId: a.id, status: 'accepted' }, { userId: other.id, status: 'accepted' }],
      whyText: 'Why',
      state: 'mutually_accepted',
      unlockedAt: new Date(),
      expiresAt: new Date(Date.now() + DAY),
    });
    await Payment.create({ userId: a.id, razorpayPaymentId: 'pay_m1', kind: 'pack', amountPaise: 49_900, status: 'captured', capturedAt: new Date(), refundedPaise: 0 });
    await Payment.create({ userId: b.id, razorpayPaymentId: 'pay_m2', kind: 'pack', amountPaise: 129_900, status: 'partially_refunded', capturedAt: new Date(), refundedPaise: 30_000 });

    const m = (await admin.get('/admin/metrics').expect(200)).body;
    const step = (k: string) => m.funnel.find((f: { key: string }) => f.key === k);
    expect(step('registered').count).toBeGreaterThanOrEqual(4);
    expect(step('profile_submitted').count).toBe(2);
    expect(step('matching_active').count).toBe(1);
    // Both people in the introduction registered in the range, so both count.
    expect(step('introduced').count).toBe(2);
    expect(step('mutual').count).toBe(2);
    expect(step('paid').count).toBe(2);
    expect(step('matching_active').ofStart).toBeGreaterThan(0);

    expect(m.revenue).toMatchObject({ grossPaise: 179_800, refundedPaise: 30_000, netPaise: 149_800, payingMembers: 2 });
    expect(m.revenue.arppuPaise).toBe(74_900);
    expect(m.reviews.profile.count).toBe(1); // only a's submission has a decision yet
    expect(m.reviews.profile.medianHours).toBe(2);
    expect(m.backlog.profilesWaiting).toBe(1);
    expect(m.retention).toHaveLength(8);
    expect(m.matching.introductions.total).toBe(1);
  });

  it('records a member as active for the day when they sign in', async () => {
    const t = setup();
    const m = await person(t);
    await new Promise((r) => setTimeout(r, 200));
    expect(await ActiveDay.countDocuments({ userId: m.id })).toBe(1);
  });
});
