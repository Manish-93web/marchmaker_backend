import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { generateSync } from 'otplib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ASSESSMENT_BANKS, type Role } from '@marchmaker/shared';
import { createApp } from '../src/app';
import { loadEnv } from '../src/config/env';
import { buildContext } from '../src/context';
import { createLogger } from '../src/lib/logger';
import { MemoryMailer } from '../src/lib/mailer';
import { hashPassword } from '../src/lib/passwords';
import { MemorySms } from '../src/lib/sms';
import { MemoryStorage } from '../src/lib/storage';
import { AdminNote, RolePermission } from '../src/models/admin';
import { AssessmentResponse } from '../src/models/assessment';
import { AuditLog, FeatureFlag, Session, User } from '../src/models/core';
import { Photo, Preference, Profile } from '../src/models/profile';
import { csvCell } from '../src/services/adminOps';

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
  const env = loadEnv({ NODE_ENV: 'test', EXPORT_DIR: mkdtempSync(path.join(tmpdir(), 'mm-adm-')) } as NodeJS.ProcessEnv);
  const log = createLogger('silent');
  const mailer = new MemoryMailer();
  const ctx = buildContext({ env, log, mailer, sms: new MemorySms() }, { storage: new MemoryStorage() });
  return { app: createApp({ env, log, isReady: () => true, ctx }), ctx, mailer };
}
type T = ReturnType<typeof setup>;

const csrfOf = (res: request.Response) =>
  ((res.headers['set-cookie'] as unknown as string[]) ?? [])
    .find((c) => c.startsWith('mm_csrf='))!
    .split(';')[0]!
    .slice('mm_csrf='.length);

function client(agent: ReturnType<typeof request.agent>, csrf: string) {
  return {
    get: (url: string) => agent.get(`/api/v1${url}`),
    post: (url: string) => agent.post(`/api/v1${url}`).set('x-csrf-token', csrf),
    put: (url: string) => agent.put(`/api/v1${url}`).set('x-csrf-token', csrf),
    patch: (url: string) => agent.patch(`/api/v1${url}`).set('x-csrf-token', csrf),
    delete: (url: string) => agent.delete(`/api/v1${url}`).set('x-csrf-token', csrf),
  };
}

async function staff(t: T, roles: Role[], email: string, name = 'Sam') {
  await User.create({
    email,
    passwordHash: await hashPassword(PASSWORD),
    firstName: name,
    gender: 'woman',
    dobEnc: t.ctx.crypto.encrypt('1990-01-01'),
    roles: roles as never,
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
  return { id, ...client(agent, csrf) };
}

async function makeMember(
  t: T,
  email: string,
  over: { firstName?: string; journeyState?: string; phone?: string; gender?: 'woman' | 'man' } = {},
) {
  const user = await User.create({
    email,
    passwordHash: await hashPassword(PASSWORD),
    firstName: over.firstName ?? 'Asha',
    gender: over.gender ?? 'woman',
    dobEnc: t.ctx.crypto.encrypt('1996-04-02'),
    dobYear: 1996,
    roles: ['member'],
    emailVerifiedAt: new Date(),
    journeyState: (over.journeyState ?? 'email_verified') as never,
    ...(over.phone && { phoneEnc: t.ctx.crypto.encrypt(over.phone), phoneHash: t.ctx.crypto.blindIndex(over.phone) }),
  });
  return String(user._id);
}

async function memberSession(t: T, email: string) {
  const agent = request.agent(t.app);
  const login = await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
  return client(agent, csrfOf(login));
}

const submittedProfile = (userId: string, over: Record<string, unknown> = {}) =>
  Profile.create({
    userId,
    status: 'submitted',
    submittedAt: new Date(),
    birthYear: 1996,
    gender: 'woman',
    data: { basics: { firstName: 'Asha', heightCm: 165 }, background: { city: 'Pune' } },
    sensitive: {},
    ...over,
  });

describe('access control', () => {
  it('blocks members, anonymous callers and staff without the permission', async () => {
    const t = setup();
    await makeMember(t, 'm@example.com');
    const m = await memberSession(t, 'm@example.com');
    await request(t.app).get('/api/v1/admin/dashboard').expect(401);
    expect((await m.get('/admin/dashboard')).status).toBe(403);

    const support = await staff(t, ['support_agent'], 'support@example.com');
    expect((await support.get('/admin/dashboard')).status).toBe(403);
    expect((await support.get('/admin/audit')).status).toBe(403);
    expect((await support.get('/admin/staff')).status).toBe(403);
    expect((await support.get('/admin/members')).status).toBe(200);
  });

  it('shows queue sizes on the dashboard', async () => {
    const t = setup();
    const id = await makeMember(t, 'a@example.com');
    await submittedProfile(id);
    await Photo.create({ userId: id, key: 'k', status: 'pending', variants: { md: 'm' } });
    const admin = await staff(t, ['admin'], 'admin@example.com');
    const d = (await admin.get('/admin/dashboard').expect(200)).body;
    expect(d.members).toBe(1);
    expect(d.queues).toMatchObject({ profiles: 1, photos: 1, verifications: 0 });
  });
});

describe('member search and detail', () => {
  it('finds members by name, email, phone, id and filters, excluding staff, with paging', async () => {
    const t = setup();
    const a = await makeMember(t, 'asha.k@example.com', { firstName: 'Asha', phone: '+919876543210' });
    await makeMember(t, 'ravi@example.com', { firstName: 'Ravi', gender: 'man' });
    await makeMember(t, 'rina@example.com', { firstName: 'Rina' });
    await User.updateOne({ email: 'rina@example.com' }, { $set: { status: 'suspended' } });
    const s = await staff(t, ['support_agent'], 'support@example.com');

    const names = (q: string) => s.get(`/admin/members?q=${encodeURIComponent(q)}`).then((r) => r.body.items.map((i: { firstName: string }) => i.firstName));
    expect(await names('ash')).toEqual(['Asha']);
    expect(await names('RAVI@')).toEqual(['Ravi']);
    expect(await names('98765 43210')).toEqual(['Asha']);
    expect(await names(a)).toEqual(['Asha']);
    expect(await names('support')).toEqual([]); // staff never appear

    const suspended = (await s.get('/admin/members?status=suspended')).body.items;
    expect(suspended.map((i: { firstName: string }) => i.firstName)).toEqual(['Rina']);

    const p1 = (await s.get('/admin/members?limit=2')).body;
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = (await s.get(`/admin/members?limit=2&cursor=${p1.nextCursor}`)).body;
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
  });

  it('gives support basic data only, and matchmakers the full profile with internal scores (audited)', async () => {
    const t = setup();
    const id = await makeMember(t, 'a@example.com', { phone: '+919876543210' });
    await submittedProfile(id);
    await Preference.create({ userId: id, dimensions: [{ key: 'diet', type: 'must', values: ['vegetarian'], importance: 2 }] });
    await AssessmentResponse.create({
      userId: id,
      key: 'values',
      version: 1,
      status: 'completed',
      answers: {},
      dimensionScores: { ambition: 0.8 },
      completedAt: new Date(),
    });
    const support = await staff(t, ['support_agent'], 'support@example.com');
    const matchmaker = await staff(t, ['matchmaker'], 'mm@example.com');

    const basic = (await support.get(`/admin/members/${id}`).expect(200)).body;
    expect(basic.overview.phone).toMatch(/^\+91•+10$/);
    expect(basic.overview.age).toBeGreaterThan(20);
    expect(basic.canViewFull).toBe(false);
    expect(basic.profile).toBeUndefined();
    expect(basic.assessments).toBeUndefined();
    expect(JSON.stringify(basic)).not.toContain('9876543210');

    const full = (await matchmaker.get(`/admin/members/${id}`).expect(200)).body;
    expect(full.profile.data.basics.firstName).toBe('Asha');
    expect(full.preferences).toHaveLength(1);
    expect(full.assessments.values.ambition).toBe(0.8);
    expect(await AuditLog.countDocuments({ action: 'member.view_full', subjectId: id })).toBe(1);
    expect(await AuditLog.countDocuments({ action: 'member.view_full', actorId: support.id })).toBe(0);
  });
});

describe('status actions', () => {
  it('suspends with a reason, ends sessions, and restores the member to where they were', async () => {
    const t = setup();
    const id = await makeMember(t, 'a@example.com', { journeyState: 'profile_in_progress' });
    const m = await memberSession(t, 'a@example.com');
    await m.get('/auth/me').expect(200);
    const mod = await staff(t, ['moderator'], 'mod@example.com');

    await mod.post(`/admin/members/${id}/status`).send({ action: 'suspend', reason: 'no' }).expect(422);
    await mod.post(`/admin/members/${id}/status`).send({ action: 'suspend', reason: 'Harassment reports under review' }).expect(200);

    const u = await User.findById(id);
    expect(u).toMatchObject({ status: 'suspended', journeyState: 'suspended' });
    await m.get('/auth/me').expect(401); // sessions ended
    expect(await Session.countDocuments({ userId: id, revokedAt: null })).toBe(0);

    await mod.post(`/admin/members/${id}/status`).send({ action: 'suspend', reason: 'again please' }).expect(409);
    await mod.post(`/admin/members/${id}/status`).send({ action: 'restore', reason: 'Review complete, no action' }).expect(200);
    const back = await User.findById(id);
    expect(back).toMatchObject({ status: 'active', journeyState: 'profile_in_progress' });
    expect(back?.moderation?.at).toBeUndefined();

    const logs = await AuditLog.find({ action: { $in: ['member.suspend', 'member.restore'] } }).sort({ _id: 1 }).lean();
    expect(logs.map((l) => l.action)).toEqual(['member.suspend', 'member.restore']);
    expect((logs[0]!.after as { reason: string }).reason).toMatch(/Harassment/);
  });

  it('keeps banning behind its own permission and never touches staff accounts', async () => {
    const t = setup();
    const id = await makeMember(t, 'a@example.com');
    const matchmaker = await staff(t, ['matchmaker'], 'mm@example.com');
    expect((await matchmaker.post(`/admin/members/${id}/status`).send({ action: 'ban', reason: 'Fraud confirmed' })).status).toBe(403);

    const mod = await staff(t, ['moderator'], 'mod@example.com');
    await mod.post(`/admin/members/${id}/status`).send({ action: 'ban', reason: 'Fraud confirmed' }).expect(200);
    expect((await User.findById(id))?.status).toBe('banned');

    const other = await staff(t, ['verifier'], 'ver@example.com');
    const res = await mod.post(`/admin/members/${other.id}/status`).send({ action: 'suspend', reason: 'Testing staff guard' });
    expect(res.status).toBe(403);
  });
});

describe('internal notes', () => {
  it('adds, pins, lists newest and pinned first, and limits edits to the author or a moderator', async () => {
    const t = setup();
    const id = await makeMember(t, 'a@example.com');
    const a = await staff(t, ['support_agent'], 'a@staff.example', 'Anita');
    const b = await staff(t, ['support_agent'], 'b@staff.example', 'Bela');
    const mod = await staff(t, ['moderator'], 'mod@staff.example', 'Mo');

    const n1 = (await a.post(`/admin/members/${id}/notes`).send({ body: 'Called, prefers evenings' }).expect(201)).body.id;
    await a.post(`/admin/members/${id}/notes`).send({ body: 'Verified phone number', pinned: true }).expect(201);
    const list = (await a.get(`/admin/members/${id}/notes`).expect(200)).body.items;
    expect(list[0]).toMatchObject({ body: 'Verified phone number', pinned: true, author: 'Anita' });

    expect((await b.patch(`/admin/notes/${n1}`).send({ body: 'edited' })).status).toBe(403);
    await mod.patch(`/admin/notes/${n1}`).send({ pinned: true }).expect(200);
    await a.patch(`/admin/notes/${n1}`).send({ body: 'Called, prefers late evenings' }).expect(200);
    expect((await b.delete(`/admin/notes/${n1}`)).status).toBe(403);
    await a.delete(`/admin/notes/${n1}`).expect(204);
    expect(await AdminNote.countDocuments({ subjectUserId: id })).toBe(1);
  });
});

describe('profile review', () => {
  it('approves in queue order, and a member can see requested changes and fix them', async () => {
    const t = setup();
    const first = await makeMember(t, 'first@example.com', { journeyState: 'profile_submitted', firstName: 'Fiona' });
    const second = await makeMember(t, 'second@example.com', { journeyState: 'profile_submitted', firstName: 'Sana' });
    await submittedProfile(first, { submittedAt: new Date(Date.now() - 5 * 3_600_000) });
    await submittedProfile(second, { submittedAt: new Date(Date.now() - 1 * 3_600_000) });
    const mm = await staff(t, ['matchmaker'], 'mm@example.com');

    const queue = (await mm.get('/admin/profiles').expect(200)).body.items;
    expect(queue.map((q: { firstName: string }) => q.firstName)).toEqual(['Fiona', 'Sana']);
    expect(queue[0].waitingHours).toBeGreaterThanOrEqual(5);

    await mm.post(`/admin/profiles/${first}/decision`).send({ decision: 'approve' }).expect(200);
    expect((await User.findById(first))?.journeyState).toBe('profile_approved');
    expect((await Profile.findOne({ userId: first }))?.status).toBe('approved');
    await mm.post(`/admin/profiles/${first}/decision`).send({ decision: 'approve' }).expect(409);

    await mm.post(`/admin/profiles/${second}/decision`).send({ decision: 'request_changes', message: 'x' }).expect(422);
    await mm
      .post(`/admin/profiles/${second}/decision`)
      .send({ decision: 'request_changes', message: 'Please add a little more to your About section.', stepKeys: ['about'] })
      .expect(200);

    const member = await memberSession(t, 'second@example.com');
    const doc = (await member.get('/profile').expect(200)).body;
    expect(doc.status).toBe('changes_requested');
    expect(doc.reviewNotes[0].message).toMatch(/About section/);
    expect((await User.findById(second))?.journeyState).toBe('profile_changes_requested');

    // The profile is editable again, using the new version.
    await member
      .patch('/profile/steps/about')
      .set('If-Match', String(doc.version))
      .send({ bio: 'A fuller answer about who I am and what I am looking for in life.' })
      .expect(200);
  });

  it('can reopen an approved profile for corrections', async () => {
    const t = setup();
    const id = await makeMember(t, 'a@example.com', { journeyState: 'profile_approved' });
    await submittedProfile(id, { status: 'approved' });
    const mm = await staff(t, ['matchmaker'], 'mm@example.com');
    await mm.post(`/admin/profiles/${id}/decision`).send({ decision: 'reopen', message: 'Your height looks mistyped.' }).expect(200);
    expect((await Profile.findOne({ userId: id }))?.status).toBe('changes_requested');
    expect((await User.findById(id))?.journeyState).toBe('profile_changes_requested');
  });

  it('is not available to verifiers', async () => {
    const t = setup();
    const v = await staff(t, ['verifier'], 'v@example.com');
    expect((await v.get('/admin/profiles')).status).toBe(403);
  });
});

describe('photo review', () => {
  it('approves or rejects with a reason and hands the main photo to the next one', async () => {
    const t = setup();
    const id = await makeMember(t, 'a@example.com');
    const p1 = await Photo.create({ userId: id, key: 'k1', status: 'pending', isPrimary: true, order: 0, variants: { md: 'u/1/md.webp' } });
    const p2 = await Photo.create({ userId: id, key: 'k2', status: 'pending', isPrimary: false, order: 1, variants: { md: 'u/2/md.webp' } });
    const v = await staff(t, ['verifier'], 'v@example.com');

    const q = (await v.get('/admin/photos').expect(200)).body.items;
    expect(q).toHaveLength(2);
    expect(q[0].url).toContain('ttl=300');

    await v.post(`/admin/photos/${p1._id}/decision`).send({ decision: 'reject' }).expect(422); // reason required
    await v.post(`/admin/photos/${p1._id}/decision`).send({ decision: 'reject', reason: 'not_you' }).expect(200);
    const after1 = await Photo.findById(p1._id);
    expect(after1).toMatchObject({ status: 'rejected', rejectionReason: 'not_you', isPrimary: false });
    expect((await Photo.findById(p2._id))?.isPrimary).toBe(true);

    await v.post(`/admin/photos/${p2._id}/decision`).send({ decision: 'approve' }).expect(200);
    await v.post(`/admin/photos/${p2._id}/decision`).send({ decision: 'approve' }).expect(409);
    expect((await Photo.findById(p2._id))?.status).toBe('approved');
    expect(await AuditLog.countDocuments({ action: { $regex: '^photo\\.' } })).toBe(2);
  });
});

describe('audit explorer', () => {
  it('filters by actor, subject and action prefix, pages, and exports a formula-safe CSV (itself audited)', async () => {
    const t = setup();
    const id = await makeMember(t, 'a@example.com');
    const mod = await staff(t, ['moderator'], 'mod@example.com');
    await mod.post(`/admin/members/${id}/status`).send({ action: 'suspend', reason: '=HYPERLINK("http://evil","x")' }).expect(200);
    await mod.post(`/admin/members/${id}/notes`).send({ body: 'note' }).expect(201);
    const admin = await staff(t, ['admin'], 'admin@example.com');

    const byAction = (await admin.get('/admin/audit?action=member.').expect(200)).body.items;
    expect(byAction.every((r: { action: string }) => r.action.startsWith('member.'))).toBe(true);
    const byActor = (await admin.get('/admin/audit?actor=mod@example.com').expect(200)).body.items;
    expect(byActor.length).toBeGreaterThanOrEqual(2);
    const bySubject = (await admin.get(`/admin/audit?subject=${id}`).expect(200)).body.items;
    expect(bySubject.length).toBeGreaterThanOrEqual(2);

    const page = (await admin.get('/admin/audit?limit=1').expect(200)).body;
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeTruthy();

    const csv = await admin.get('/admin/audit/export.csv?action=member.suspend').expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\r\n')[0]).toContain('"action"'.replace(/"/g, '') || 'action');
    expect(csv.text).not.toMatch(/(^|,)"=HYPERLINK/); // never a bare formula
    expect(await AuditLog.countDocuments({ action: 'audit.export' })).toBe(1);
  });

  it('escapes CSV cells against formula injection', () => {
    expect(csvCell('=SUM(A1)')).toBe(`"'=SUM(A1)"`);
    expect(csvCell('+1')).toBe(`"'+1"`);
    expect(csvCell('@cmd')).toBe(`"'@cmd"`);
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
    expect(csvCell(null)).toBe('""');
  });
});

describe('team and permissions', () => {
  it('invites staff by single-use link, and only a super admin can grant admin roles', async () => {
    const t = setup();
    const root = await staff(t, ['super_admin'], 'root@example.com');
    const admin = await staff(t, ['admin', 'support_agent'], 'admin@example.com');
    // admin lacks admin_users.manage by default, so grant it through the role matrix first.
    const current = (await root.get('/admin/roles').expect(200)).body.roles.admin as string[];
    await root.put('/admin/roles/admin').send({ permissions: [...current, 'admin_users.manage'] }).expect(200);

    const ok = await admin.post('/admin/staff').send({ email: 'new@example.com', firstName: 'Nia', roles: ['support_agent'] }).expect(201);
    const mail = t.mailer.last('new@example.com')!;
    expect(mail.text).toMatch(/reset-password\?token=/);
    expect((await User.findById(ok.body.id))?.roles).toEqual(['support_agent']);

    const denied = await admin.post('/admin/staff').send({ email: 'x@example.com', firstName: 'X', roles: ['admin'] });
    expect(denied.status).toBe(403);
    await root.post('/admin/staff').send({ email: 'x@example.com', firstName: 'X', roles: ['admin'] }).expect(201);
    await root.post('/admin/staff').send({ email: 'new@example.com', firstName: 'Dup', roles: ['finance'] }).expect(409);
    expect((await root.post('/admin/staff').send({ email: 'm@example.com', firstName: 'M', roles: ['member'] })).status).toBe(400);
  });

  it('revokes sessions when roles change and protects the last super admin', async () => {
    const t = setup();
    const root = await staff(t, ['super_admin'], 'root@example.com');
    const target = await staff(t, ['support_agent'], 'sup@example.com');
    await target.get('/auth/me').expect(200);

    await root.put(`/admin/staff/${target.id}/roles`).send({ roles: ['finance'] }).expect(200);
    await target.get('/auth/me').expect(401);
    expect((await User.findById(target.id))?.roles).toEqual(['finance']);

    const res = await root.put(`/admin/staff/${root.id}/roles`).send({ roles: ['admin'] });
    expect(res.status).toBe(409);
    expect((await root.post(`/admin/staff/${root.id}/active`).send({ active: false })).status).toBe(409);

    await root.post(`/admin/staff/${target.id}/active`).send({ active: false }).expect(200);
    expect((await User.findById(target.id))?.status).toBe('suspended');
  });

  it('applies permission changes immediately and keeps super admin untouchable', async () => {
    const t = setup();
    const root = await staff(t, ['super_admin'], 'root@example.com');
    const sup = await staff(t, ['support_agent'], 'sup@example.com');
    await sup.get('/admin/members').expect(200);

    const matrix = (await root.get('/admin/roles').expect(200)).body;
    expect(matrix.roles.support_agent).toContain('member.search');
    const without = matrix.roles.support_agent.filter((p: string) => p !== 'member.search');
    await root.put('/admin/roles/support_agent').send({ permissions: without }).expect(200);

    expect((await sup.get('/admin/members')).status).toBe(403);
    expect(await RolePermission.countDocuments({ role: 'support_agent' })).toBe(1);
    expect((await root.put('/admin/roles/super_admin').send({ permissions: [] })).status).toBe(403);
    expect((await root.put('/admin/roles/member').send({ permissions: ['member.search'] })).status).toBe(404);
    expect(await AuditLog.countDocuments({ action: 'roles.permissions_changed' })).toBe(1);
  });

  it('requires roles.manage to read or change the matrix', async () => {
    const t = setup();
    const admin = await staff(t, ['admin'], 'admin@example.com');
    expect((await admin.get('/admin/roles')).status).toBe(403);
  });
});

describe('feature flags', () => {
  it('toggles a flag, audits it, and exposes it to the public flags endpoint', async () => {
    const t = setup();
    const admin = await staff(t, ['admin'], 'admin@example.com');
    const list = (await admin.get('/admin/flags').expect(200)).body.items;
    expect(list.find((f: { key: string }) => f.key === 'astrology').enabled).toBe(false);

    await admin.put('/admin/flags/astrology').send({ enabled: true }).expect(200);
    expect((await request(t.app).get('/api/v1/flags')).body.flags.astrology).toBe(true);
    expect((await admin.put('/admin/flags/not_a_flag').send({ enabled: true })).status).toBe(404);
    expect(await AuditLog.countDocuments({ action: 'flag.changed' })).toBe(1);
    expect((await FeatureFlag.findOne({ key: 'astrology' }))?.enabled).toBe(true);
  });
});

describe('question bank editor', () => {
  const faith = ASSESSMENT_BANKS.find((b) => b.key === 'faith')!;
  const payload = (over: Record<string, unknown> = {}) => ({
    title: faith.title,
    description: faith.description,
    minutes: faith.minutes,
    dimensions: faith.dimensions,
    questions: faith.questions,
    ...over,
  });

  it('lists banks with their scoring data, then publishes the next version', async () => {
    const t = setup();
    const admin = await staff(t, ['admin'], 'admin@example.com');
    const list = (await admin.get('/admin/assessments').expect(200)).body.items;
    expect(list).toHaveLength(6);
    const detail = (await admin.get('/admin/assessments/faith').expect(200)).body;
    expect(detail.version).toBe(1);
    expect(detail.questions[0].dimension).toBeTruthy(); // staff see scoring fields

    const edited = faith.questions.map((q, i) => (i === 0 ? { ...q, prompt: 'Faith shapes how I make everyday decisions.' } : q));
    const res = await admin.post('/admin/assessments/faith/versions').send(payload({ questions: edited })).expect(201);
    expect(res.body.version).toBe(2);
    const live = await request(t.app).get('/api/v1/assessments/faith'); // members need a session
    expect(live.status).toBe(401);
    expect((await admin.get('/admin/assessments/faith')).body.version).toBe(2);
    expect(await AuditLog.countDocuments({ action: 'assessment.published' })).toBe(1);
  });

  it('refuses banks with duplicate ids, undeclared or unmeasured dimensions, or too few questions', async () => {
    const t = setup();
    const admin = await staff(t, ['admin'], 'admin@example.com');
    const dup = [...faith.questions.slice(0, 7), { ...faith.questions[0]! }, faith.questions[7]!];
    expect((await admin.post('/admin/assessments/faith/versions').send(payload({ questions: dup }))).status).toBe(422);
    expect((await admin.post('/admin/assessments/faith/versions').send(payload({ dimensions: ['religiosity'] }))).status).toBe(422);
    expect(
      (await admin.post('/admin/assessments/faith/versions').send(payload({ dimensions: [...faith.dimensions, 'unused'] }))).status,
    ).toBe(422);
    expect((await admin.post('/admin/assessments/faith/versions').send(payload({ questions: faith.questions.slice(0, 3) }))).status).toBe(422);
    expect((await admin.get('/admin/assessments/faith')).body.version).toBe(1);
  });

  it('is not available to roles without content management', async () => {
    const t = setup();
    const mm = await staff(t, ['matchmaker'], 'mm@example.com');
    expect((await mm.get('/admin/assessments')).status).toBe(403);
  });
});

describe('view as member', () => {
  it('is read-only, audited, and refused for staff accounts', async () => {
    const t = setup();
    const id = await makeMember(t, 'a@example.com');
    await submittedProfile(id);
    const admin = await staff(t, ['admin'], 'admin@example.com');
    const view = (await admin.get(`/admin/members/${id}/as-member`).expect(200)).body;
    expect(view.readOnly).toBe(true);
    expect(view.me.firstName).toBe('Asha');
    expect(view.profile.data.basics.firstName).toBe('Asha');
    expect(await AuditLog.countDocuments({ action: 'member.impersonate_view', subjectId: id })).toBe(1);

    const other = await staff(t, ['finance'], 'fin@example.com');
    expect((await admin.get(`/admin/members/${other.id}/as-member`)).status).toBe(403);
    const sup = await staff(t, ['support_agent'], 'sup@example.com');
    expect((await sup.get(`/admin/members/${id}/as-member`)).status).toBe(403);
  });
});
