import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { generateSync } from 'otplib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Role } from '@marchmaker/shared';
import { createApp } from '../src/app';
import { loadEnv } from '../src/config/env';
import { buildContext } from '../src/context';
import { runNightlyIfDue } from '../src/jobs/matchingJobs';
import { createLogger } from '../src/lib/logger';
import { MemoryMailer } from '../src/lib/mailer';
import { hashPassword } from '../src/lib/passwords';
import { MemorySms } from '../src/lib/sms';
import { MemoryStorage } from '../src/lib/storage';
import { AssessmentResponse } from '../src/models/assessment';
import { AuditLog, Outbox, User } from '../src/models/core';
import { Block, Introduction, MatchSuggestion } from '../src/models/matching';
import { Photo, Preference, Profile } from '../src/models/profile';
import { runMatching } from '../src/services/matching';
import { releaseDueMatches } from '../src/services/matchReview';

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

const PASSWORD = 'Sup3rSecretPass';

function setup() {
  const env = loadEnv({ NODE_ENV: 'test', EXPORT_DIR: mkdtempSync(path.join(tmpdir(), 'mm-match-')) } as NodeJS.ProcessEnv);
  const log = createLogger('silent');
  const ctx = buildContext({ env, log, mailer: new MemoryMailer(), sms: new MemorySms() }, { storage: new MemoryStorage() });
  return { app: createApp({ env, log, isReady: () => true, ctx }), ctx };
}
type T = ReturnType<typeof setup>;

const csrfOf = (res: request.Response) =>
  ((res.headers['set-cookie'] as unknown as string[]) ?? [])
    .find((c) => c.startsWith('mm_csrf='))!
    .split(';')[0]!
    .slice('mm_csrf='.length);

async function staff(t: T, roles: Role[], email: string) {
  await User.create({
    email,
    passwordHash: await hashPassword(PASSWORD),
    firstName: email.split('@')[0],
    gender: 'woman',
    dobEnc: t.ctx.crypto.encrypt('1990-01-01'),
    roles,
    emailVerifiedAt: new Date(),
  });
  const agent = request.agent(t.app);
  const login = await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
  let csrf = csrfOf(login);
  const setupRes = await agent.post('/api/v1/auth/2fa/setup').set('x-csrf-token', csrf).expect(200);
  const confirm = await agent
    .post('/api/v1/auth/2fa/confirm')
    .set('x-csrf-token', csrf)
    .send({ code: generateSync({ secret: String(setupRes.body.secret) }) })
    .expect(200);
  csrf = csrfOf(confirm);
  const id = String((await User.findOne({ email }))!._id);
  return {
    id,
    get: (u: string) => agent.get(`/api/v1${u}`),
    post: (u: string) => agent.post(`/api/v1${u}`).set('x-csrf-token', csrf),
    put: (u: string) => agent.put(`/api/v1${u}`).set('x-csrf-token', csrf),
  };
}

interface MemberOpts {
  gender?: 'woman' | 'man';
  city?: string;
  state?: string;
  diet?: string;
  religion?: string;
  prefs?: { key: string; type: 'must' | 'flexible'; values?: string[]; range?: { min: number; max: number }; importance?: number }[];
  scores?: Record<string, number>;
  photo?: boolean;
  verified?: boolean;
  status?: string;
  birthYear?: number;
  plan?: string;
}

let counter = 0;
async function matchable(t: T, name: string, o: MemberOpts = {}) {
  counter++;
  const gender = o.gender ?? (counter % 2 ? 'woman' : 'man');
  const u = await User.create({
    email: `${name.toLowerCase()}${counter}@example.com`,
    firstName: name,
    gender,
    dobEnc: t.ctx.crypto.encrypt('1995-01-01'),
    dobYear: o.birthYear ?? 1995,
    roles: ['member'],
    status: (o.status ?? 'active') as 'active',
    journeyState: 'matching_active',
    emailVerifiedAt: new Date(),
    lastActiveAt: new Date(),
    plan: { planCode: (o.plan ?? 'free') as 'free', status: 'none' },
    ...(o.verified === false ? {} : { verification: { idVerifiedAt: new Date(Date.now() - 20 * 86_400_000) } }),
  });
  await Profile.create({
    userId: u._id,
    status: 'approved',
    gender,
    birthYear: o.birthYear ?? 1995,
    submittedAt: new Date(),
    data: {
      basics: { firstName: name, heightCm: gender === 'man' ? 178 : 165, maritalStatus: 'never_married' },
      background: { city: o.city ?? 'Pune', state: o.state ?? 'Maharashtra', religion: o.religion ?? 'Hindu', motherTongue: 'Marathi' },
      lifestyle: { diet: o.diet ?? 'vegetarian', smoking: 'never', drinking: 'never' },
      values: { marriageTimeline: '1_2_years', wantsKids: 'yes', livingWithFamily: 'open' },
      family: { familyType: 'nuclear' },
    },
  });
  if (o.photo !== false) {
    await Photo.create({ userId: u._id, key: `k${counter}`, status: 'approved', isPrimary: true, variants: { md: `p/${counter}/md.webp` } });
  }
  if (o.prefs) {
    await Preference.create({
      userId: u._id,
      dimensions: o.prefs.map((p) => ({ values: [], importance: 2, ...p })) as never,
    });
  }
  if (o.scores) {
    await AssessmentResponse.create({
      userId: u._id,
      key: 'values',
      version: 1,
      status: 'completed',
      answers: {},
      dimensionScores: o.scores,
      completedAt: new Date(),
    });
  }
  return String(u._id);
}

const WHY = 'You both want a settled life in Pune within the next couple of years and think about family in a similar way.';

async function openForReview(t: T, mm: Awaited<ReturnType<typeof staff>>, aId: string, bId: string) {
  await runMatching(t.ctx);
  const s = await MatchSuggestion.findOne({ $or: [{ memberA: aId, memberB: bId }, { memberA: bId, memberB: aId }] });
  expect(s).toBeTruthy();
  await mm.get(`/admin/matches/${s!._id}`).expect(200); // opening claims it
  return String(s!._id);
}

describe('matching run', () => {
  it('suggests only verified, active, approved members with an approved photo, of compatible gender', async () => {
    const t = setup();
    const w = await matchable(t, 'Asha', { gender: 'woman' });
    const m = await matchable(t, 'Ravi', { gender: 'man' });
    await matchable(t, 'NoPhoto', { gender: 'man', photo: false });
    await matchable(t, 'Unverified', { gender: 'man', verified: false });
    await matchable(t, 'Suspended', { gender: 'man', status: 'suspended' });
    await matchable(t, 'Sameg', { gender: 'woman' });

    const summary = await runMatching(t.ctx);
    expect(summary.members).toBe(3); // Asha, Ravi, and the other woman
    const pairs = await MatchSuggestion.find().lean();
    const keys = pairs.map((p) => [String(p.memberA), String(p.memberB)].sort().join(':'));
    expect(keys).toContain([w, m].sort().join(':'));
    for (const p of pairs) {
      const users = await User.find({ _id: { $in: [p.memberA, p.memberB] } }).select('gender firstName');
      expect(new Set(users.map((u) => u.gender)).size).toBe(2);
      expect(users.map((u) => u.firstName)).not.toEqual(expect.arrayContaining(['NoPhoto']));
    }
  });

  it('honours must-have preferences in both directions', async () => {
    const t = setup();
    const w = await matchable(t, 'Asha', { gender: 'woman', prefs: [{ key: 'diet', type: 'must', values: ['vegetarian'] }] });
    const nonVeg = await matchable(t, 'Karan', { gender: 'man', diet: 'non_vegetarian' });
    const picky = await matchable(t, 'Picky', { gender: 'man', prefs: [{ key: 'religion', type: 'must', values: ['Sikh'] }] });
    const ok = await matchable(t, 'Vikram', { gender: 'man' });
    await runMatching(t.ctx);
    const partners = (await MatchSuggestion.find({ $or: [{ memberA: w }, { memberB: w }] }).lean()).map((p) =>
      String(p.memberA) === w ? String(p.memberB) : String(p.memberA),
    );
    expect(partners).toEqual([ok]);
    expect(partners).not.toContain(nonVeg);
    expect(partners).not.toContain(picky);
  });

  it('never pairs blocked members, and is idempotent without touching reviewed pairs', async () => {
    const t = setup();
    const w = await matchable(t, 'Asha', { gender: 'woman' });
    const blocked = await matchable(t, 'Blocked', { gender: 'man' });
    const ok = await matchable(t, 'Vikram', { gender: 'man' });
    await Block.create({ blockerId: w, blockedId: blocked });

    const first = await runMatching(t.ctx);
    expect(first.suggestionsCreated).toBe(1);
    const second = await runMatching(t.ctx);
    expect(second.suggestionsCreated).toBe(0);
    expect(await MatchSuggestion.countDocuments()).toBe(1);

    await MatchSuggestion.updateOne({}, { $set: { status: 'rejected' } });
    await runMatching(t.ctx);
    expect((await MatchSuggestion.findOne())?.status).toBe('rejected'); // reviewed pairs stay decided
    void ok;
  });

  it('keeps scores internal: never in a member-facing introduction', async () => {
    const t = setup();
    const mm = await staff(t, ['matchmaker'], 'mm@example.com');
    const w = await matchable(t, 'Asha', { gender: 'woman', scores: { ambition: 0.8 } });
    const m = await matchable(t, 'Ravi', { gender: 'man', scores: { ambition: 0.75 } });
    const id = await openForReview(t, mm, w, m);
    await mm.post(`/admin/matches/${id}/decision`).send({ decision: 'approve', whyText: WHY, confirmed: true }).expect(200);
    await MatchSuggestion.updateOne({ _id: id }, { $set: { releaseAt: new Date(Date.now() - 1000) } });
    await releaseDueMatches(t.ctx);
    const intro = (await Introduction.findOne().lean())!;
    expect(JSON.stringify(intro)).not.toMatch(/score|signals|reasons/);
  });

  it('releases an approved match once even when the API and the worker run the release step together', async () => {
    const t = setup();
    const mm = await staff(t, ['matchmaker'], 'mm@example.com');
    const w = await matchable(t, 'Asha', { gender: 'woman', scores: { ambition: 0.8 } });
    const m = await matchable(t, 'Ravi', { gender: 'man', scores: { ambition: 0.75 } });
    const id = await openForReview(t, mm, w, m);
    await mm.post(`/admin/matches/${id}/decision`).send({ decision: 'approve', whyText: WHY, confirmed: true }).expect(200);
    await MatchSuggestion.updateOne({ _id: id }, { $set: { releaseAt: new Date(Date.now() - 1000) } });
    const runs = await Promise.all([releaseDueMatches(t.ctx), releaseDueMatches(t.ctx), releaseDueMatches(t.ctx)]);
    expect(runs.reduce((n, r) => n + r.released, 0)).toBe(1);
    expect(await Introduction.countDocuments()).toBe(1);
  });

  it('runs the nightly job at most once a day', async () => {
    const t = setup();
    await matchable(t, 'Asha', { gender: 'woman' });
    await matchable(t, 'Ravi', { gender: 'man' });
    const now = new Date();
    expect(await runNightlyIfDue(t.ctx, now)).not.toBeNull();
    expect(await runNightlyIfDue(t.ctx, new Date(now.getTime() + 3_600_000))).toBeNull();
    expect(await runNightlyIfDue(t.ctx, new Date(now.getTime() + 25 * 3_600_000))).not.toBeNull();
  });
});

describe('review queue and console', () => {
  it('is limited to matchmakers, shows plan priority first, and bands instead of numbers', async () => {
    const t = setup();
    const mm = await staff(t, ['matchmaker'], 'mm@example.com');
    const support = await staff(t, ['support_agent'], 'support@example.com');
    await matchable(t, 'Free1', { gender: 'woman' });
    await matchable(t, 'FreeM', { gender: 'man' });
    await matchable(t, 'Prem1', { gender: 'woman', plan: 'premium', city: 'Mumbai' });
    await matchable(t, 'PremM', { gender: 'man', plan: 'premium', city: 'Mumbai' });
    await runMatching(t.ctx);

    expect((await support.get('/admin/matches')).status).toBe(403);
    const q = (await mm.get('/admin/matches').expect(200)).body.items;
    expect(q.length).toBeGreaterThan(0);
    expect(q[0].priorityPlan).toBe('premium');
    expect(['strong', 'good', 'possible']).toContain(q[0].fit);
    expect(JSON.stringify(q)).not.toMatch(/"score"/);
  });

  it('claims on open, shows both members side by side with a draft explanation in words', async () => {
    const t = setup();
    const mm = await staff(t, ['matchmaker'], 'mm@example.com');
    const w = await matchable(t, 'Asha', { gender: 'woman', scores: { ambition: 0.8 } });
    const m = await matchable(t, 'Ravi', { gender: 'man', scores: { ambition: 0.78 } });
    const id = await openForReview(t, mm, w, m);

    const d = (await mm.get(`/admin/matches/${id}`).expect(200)).body;
    expect(d.status).toBe('in_review');
    expect(d.reviewerId).toBe(mm.id);
    expect(d.members.a.profile).toBeTruthy();
    expect(d.members.b.profile).toBeTruthy();
    expect(d.suggestedWhy.length).toBeGreaterThan(10);
    expect(d.suggestedWhy).not.toMatch(/\d/);
    expect(d.signals).toBeTruthy(); // internal signals are for staff
    expect(d.history[0].action).toBe('claim');
  });

  it('stops a matchmaker once their daily capacity is used', async () => {
    const t = setup();
    const admin = await staff(t, ['admin'], 'admin@example.com');
    await admin.put('/admin/settings/review').send({ cooloffMinutes: 10, introExpiryDays: 7, matchmakerDailyCapacity: 1, reviewSlaHours: 48 }).expect(200);
    const mm = await staff(t, ['matchmaker'], 'mm@example.com');
    await matchable(t, 'A1', { gender: 'woman' });
    await matchable(t, 'A2', { gender: 'woman', city: 'Pune' });
    await matchable(t, 'B1', { gender: 'man' });
    await matchable(t, 'B2', { gender: 'man' });
    await runMatching(t.ctx);
    const items = await MatchSuggestion.find().sort({ _id: 1 });
    expect(items.length).toBeGreaterThanOrEqual(2);
    await mm.get(`/admin/matches/${items[0]!._id}`).expect(200);
    const res = await mm.get(`/admin/matches/${items[1]!._id}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CAPACITY_REACHED');
  });
});

describe('approval, undo and release', () => {
  it('requires a confirmed, contact-free explanation, then releases only after the cool-off', async () => {
    const t = setup();
    const mm = await staff(t, ['matchmaker'], 'mm@example.com');
    const w = await matchable(t, 'Asha', { gender: 'woman' });
    const m = await matchable(t, 'Ravi', { gender: 'man' });
    const id = await openForReview(t, mm, w, m);

    await mm.post(`/admin/matches/${id}/decision`).send({ decision: 'approve', whyText: WHY }).expect(422); // not confirmed
    const bad = await mm.post(`/admin/matches/${id}/decision`).send({ decision: 'approve', whyText: 'Call her on 98765 43210 for a chat about life.', confirmed: true });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('WHY_TEXT_INVALID');

    const ok = await mm.post(`/admin/matches/${id}/decision`).send({ decision: 'approve', whyText: WHY, confirmed: true }).expect(200);
    expect(ok.body.status).toBe('approved');
    const wait = new Date(ok.body.releaseAt).getTime() - Date.now();
    expect(wait).toBeGreaterThan(9 * 60_000);
    expect(wait).toBeLessThanOrEqual(10 * 60_000);

    // Nothing reaches a member during the cool-off.
    expect((await releaseDueMatches(t.ctx)).released).toBe(0);
    expect(await Introduction.countDocuments()).toBe(0);

    // After it, the introduction is created once, with the reviewer's words.
    const later = new Date(Date.now() + 11 * 60_000);
    expect((await releaseDueMatches(t.ctx, later)).released).toBe(1);
    expect((await releaseDueMatches(t.ctx, later)).released).toBe(0);
    const intro = (await Introduction.findOne().lean())!;
    expect(intro.state).toBe('released');
    expect(intro.whyText).toBe(WHY);
    expect(intro.members).toHaveLength(2);
    const days = (intro.expiresAt.getTime() - later.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(await Outbox.countDocuments({ eventType: 'introduction.released' })).toBe(2);
  });

  it('can be undone inside the window, and not after release', async () => {
    const t = setup();
    const mm = await staff(t, ['matchmaker'], 'mm@example.com');
    const w = await matchable(t, 'Asha', { gender: 'woman' });
    const m = await matchable(t, 'Ravi', { gender: 'man' });
    const id = await openForReview(t, mm, w, m);
    await mm.post(`/admin/matches/${id}/decision`).send({ decision: 'approve', whyText: WHY, confirmed: true }).expect(200);

    await mm.post(`/admin/matches/${id}/undo`).expect(200);
    const s = (await MatchSuggestion.findById(id))!;
    expect(s.status).toBe('in_review');
    expect(s.releaseAt).toBeUndefined();
    expect((await releaseDueMatches(t.ctx, new Date(Date.now() + 60 * 60_000))).released).toBe(0);

    await mm.post(`/admin/matches/${id}/decision`).send({ decision: 'approve', whyText: WHY, confirmed: true }).expect(200);
    await releaseDueMatches(t.ctx, new Date(Date.now() + 11 * 60_000));
    expect((await mm.post(`/admin/matches/${id}/undo`)).status).toBe(409);
  });

  it('re-checks safety at release: a block or suspension in the meantime stops the introduction', async () => {
    const t = setup();
    const mm = await staff(t, ['matchmaker'], 'mm@example.com');
    const w = await matchable(t, 'Asha', { gender: 'woman' });
    const m = await matchable(t, 'Ravi', { gender: 'man' });
    const id = await openForReview(t, mm, w, m);
    await mm.post(`/admin/matches/${id}/decision`).send({ decision: 'approve', whyText: WHY, confirmed: true }).expect(200);

    await Block.create({ blockerId: m, blockedId: w });
    const out = await releaseDueMatches(t.ctx, new Date(Date.now() + 11 * 60_000));
    expect(out).toMatchObject({ released: 0, dropped: 1 });
    expect(await Introduction.countDocuments()).toBe(0);
    const s = (await MatchSuggestion.findById(id))!;
    expect(s.status).toBe('rejected');
    expect(s.rejectionCode).toBe('release_blocked');
    expect(s.reviewHistory.some((h) => h.action === 'release_blocked')).toBe(true);
  });

  it('does not release when a member was suspended after approval', async () => {
    const t = setup();
    const mm = await staff(t, ['matchmaker'], 'mm@example.com');
    const w = await matchable(t, 'Asha', { gender: 'woman' });
    const m = await matchable(t, 'Ravi', { gender: 'man' });
    const id = await openForReview(t, mm, w, m);
    await mm.post(`/admin/matches/${id}/decision`).send({ decision: 'approve', whyText: WHY, confirmed: true }).expect(200);
    await User.updateOne({ _id: w }, { $set: { status: 'suspended', journeyState: 'suspended' } });
    expect((await releaseDueMatches(t.ctx, new Date(Date.now() + 11 * 60_000))).released).toBe(0);
    expect(await Introduction.countDocuments()).toBe(0);
  });

  it('holds back an introduction when a member already has the maximum open', async () => {
    const t = setup();
    const mm = await staff(t, ['matchmaker'], 'mm@example.com');
    const w = await matchable(t, 'Asha', { gender: 'woman' });
    const m = await matchable(t, 'Ravi', { gender: 'man' });
    const id = await openForReview(t, mm, w, m);
    await mm.post(`/admin/matches/${id}/decision`).send({ decision: 'approve', whyText: WHY, confirmed: true }).expect(200);

    for (let i = 0; i < 2; i++) {
      const other = await matchable(t, `Other${i}`, { gender: 'man' });
      await Introduction.create({
        pairKey: `${w}:${other}`,
        members: [{ userId: w }, { userId: other }],
        whyText: 'x',
        state: 'released',
        expiresAt: new Date(Date.now() + 86_400_000),
      });
    }
    const out = await releaseDueMatches(t.ctx, new Date(Date.now() + 11 * 60_000));
    expect(out.released).toBe(0);
    expect((await MatchSuggestion.findById(id))?.status).toBe('in_review'); // back to the reviewer, not lost
  });
});

describe('other decisions and safeguards', () => {
  it('rejects for good, snoozes and wakes, and escalates to someone else', async () => {
    const t = setup();
    const mm = await staff(t, ['matchmaker'], 'mm@example.com');
    const other = await staff(t, ['matchmaker'], 'mm2@example.com');
    const w = await matchable(t, 'Asha', { gender: 'woman' });
    const m = await matchable(t, 'Ravi', { gender: 'man' });
    const id = await openForReview(t, mm, w, m);

    await mm.post(`/admin/matches/${id}/decision`).send({ decision: 'snooze', days: 3 }).expect(200);
    expect((await MatchSuggestion.findById(id))?.status).toBe('snoozed');
    await releaseDueMatches(t.ctx, new Date(Date.now() + 4 * 86_400_000));
    expect((await MatchSuggestion.findById(id))?.status).toBe('suggested');

    await mm.get(`/admin/matches/${id}`).expect(200);
    await mm.post(`/admin/matches/${id}/decision`).send({ decision: 'escalate', reason: 'Wants a second opinion on safety' }).expect(200);
    expect((await MatchSuggestion.findById(id))?.status).toBe('escalated');
    expect((await mm.post(`/admin/matches/${id}/decision`).send({ decision: 'reject', code: 'not_a_fit' })).status).toBe(409);

    await other.post(`/admin/matches/${id}/decision`).send({ decision: 'reject', code: 'safety_concern', note: 'Reported before' }).expect(200);
    expect((await MatchSuggestion.findById(id))?.status).toBe('rejected');

    // A rejected pair is never proposed again.
    await runMatching(t.ctx);
    expect((await MatchSuggestion.findById(id))?.status).toBe('rejected');
    expect(await MatchSuggestion.countDocuments()).toBe(1);
  });

  it('needs two different approvers for a flagged member', async () => {
    const t = setup();
    const mod = await staff(t, ['moderator'], 'mod@example.com');
    const a = await staff(t, ['matchmaker'], 'a@example.com');
    const b = await staff(t, ['matchmaker'], 'b@example.com');
    const w = await matchable(t, 'Asha', { gender: 'woman' });
    const m = await matchable(t, 'Ravi', { gender: 'man' });
    await mod.post(`/admin/members/${w}/review-flag`).send({ twoPerson: true, reason: 'Previous harassment report' }).expect(200);
    const id = await openForReview(t, a, w, m);
    expect((await MatchSuggestion.findById(id))?.needsTwoPerson).toBe(true);

    const first = await a.post(`/admin/matches/${id}/decision`).send({ decision: 'approve', whyText: WHY, confirmed: true }).expect(200);
    expect(first.body).toMatchObject({ status: 'in_review', awaitingSecondApproval: true });
    expect((await a.post(`/admin/matches/${id}/decision`).send({ decision: 'approve', whyText: WHY, confirmed: true })).status).toBe(409);
    expect((await releaseDueMatches(t.ctx, new Date(Date.now() + 60 * 60_000))).released).toBe(0);

    const second = await b.post(`/admin/matches/${id}/decision`).send({ decision: 'approve', whyText: WHY, confirmed: true }).expect(200);
    expect(second.body.status).toBe('approved');
    expect(second.body.releaseAt).toBeTruthy();
    expect((await MatchSuggestion.findById(id))?.approvals).toHaveLength(2);
  });

  it('lets a matchmaker create a manual introduction, recording overridden must-haves', async () => {
    const t = setup();
    const mm = await staff(t, ['matchmaker'], 'mm@example.com');
    const w = await matchable(t, 'Asha', { gender: 'woman', prefs: [{ key: 'religion', type: 'must', values: ['Sikh'] }] });
    const m = await matchable(t, 'Ravi', { gender: 'man' });

    const res = await mm.post('/admin/matches/manual').send({ memberA: w, memberB: m, whyText: WHY, reason: 'Families already know each other' }).expect(201);
    expect(res.body.overrides).toBe(1);
    const s = (await MatchSuggestion.findById(res.body.id))!;
    expect(s).toMatchObject({ manual: true, status: 'approved' });
    expect(s.overrides[0]).toMatchObject({ dimension: 'religion' });
    await mm.post('/admin/matches/manual').send({ memberA: w, memberB: m, whyText: WHY, reason: 'Duplicate attempt' }).expect(409);

    const unverified = await matchable(t, 'Nope', { gender: 'man', verified: false });
    const bad = await mm.post('/admin/matches/manual').send({ memberA: w, memberB: unverified, whyText: WHY, reason: 'Trying anyway' });
    expect(bad.status).toBe(409);
    expect(await AuditLog.countDocuments({ action: 'match.manual_create' })).toBe(1);
  });

  it('validates and audits matching weights', async () => {
    const t = setup();
    const admin = await staff(t, ['admin'], 'admin@example.com');
    const cfg = (await admin.get('/admin/settings').expect(200)).body.matching;
    expect(cfg.weights.preferences).toBeCloseTo(0.35);

    await admin.put('/admin/settings/matching').send({ ...cfg, weights: { preferences: 0, assessments: 0, plans: 0 } }).expect(422);
    await admin.put('/admin/settings/matching').send({ ...cfg, minScore: 2 }).expect(422);
    await admin.put('/admin/settings/matching').send({ ...cfg, weights: { preferences: 0.6, assessments: 0.2, plans: 0.2 }, topN: 2 }).expect(200);
    const after = (await admin.get('/admin/settings').expect(200)).body.matching;
    expect(after.topN).toBe(2);
    expect(await AuditLog.countDocuments({ action: 'settings.matching_changed' })).toBe(1);

    const mm = await staff(t, ['matchmaker'], 'mm@example.com');
    expect((await mm.get('/admin/settings')).status).toBe(403);
  });

  it('caps suggestions per member at the configured top N', async () => {
    const t = setup();
    const admin = await staff(t, ['admin'], 'admin@example.com');
    const cfg = (await admin.get('/admin/settings').expect(200)).body.matching;
    await admin.put('/admin/settings/matching').send({ ...cfg, topN: 2 }).expect(200);
    const w = await matchable(t, 'Asha', { gender: 'woman' });
    for (let i = 0; i < 5; i++) await matchable(t, `Man${i}`, { gender: 'man' });
    await runMatching(t.ctx);
    const forW = await MatchSuggestion.countDocuments({ $or: [{ memberA: w }, { memberB: w }] });
    expect(forW).toBeLessThanOrEqual(2);
  });
});
