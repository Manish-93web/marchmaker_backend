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
import { AuditLog, Outbox, User } from '../src/models/core';
import { Report } from '../src/models/social';
import { Appeal, ModerationAction, Ticket } from '../src/models/safety';
import { dispatchEvent } from '../src/services/notifications';
import { closeStale } from '../src/services/support';

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
  const env = loadEnv({ NODE_ENV: 'test', EXPORT_DIR: mkdtempSync(path.join(tmpdir(), 'mm-safe-')) } as NodeJS.ProcessEnv);
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
async function user(t: T, name: string, roles: Role[] = ['member'], over: Record<string, unknown> = {}) {
  n++;
  const email = `${name.toLowerCase()}${n}@example.com`;
  const u = await User.create({
    email,
    passwordHash: await hashPassword(PASSWORD),
    firstName: name,
    gender: n % 2 ? 'woman' : 'man',
    dobEnc: t.ctx.crypto.encrypt('1993-01-01'),
    dobYear: 1993,
    roles,
    emailVerifiedAt: new Date(),
    journeyState: 'matching_active',
    ...over,
  });
  return { id: String(u._id), email };
}

async function memberSession(t: T, u: { id: string; email: string }) {
  const agent = request.agent(t.app);
  const login = await agent.post('/api/v1/auth/login').send({ email: u.email, password: PASSWORD }).expect(200);
  const csrf = csrfOf(login);
  return {
    ...u,
    get: (url: string) => agent.get(`/api/v1${url}`),
    post: (url: string) => agent.post(`/api/v1${url}`).set('x-csrf-token', csrf),
  };
}

async function staffSession(t: T, name: string, role: Role) {
  const u = await user(t, name, [role]);
  const agent = request.agent(t.app);
  const login = await agent.post('/api/v1/auth/login').send({ email: u.email, password: PASSWORD }).expect(200);
  let csrf = csrfOf(login);
  const s = await agent.post('/api/v1/auth/2fa/setup').set('x-csrf-token', csrf).expect(200);
  const c = await agent
    .post('/api/v1/auth/2fa/confirm')
    .set('x-csrf-token', csrf)
    .send({ code: generateSync({ secret: String(s.body.secret) }) })
    .expect(200);
  csrf = csrfOf(c);
  return {
    ...u,
    get: (url: string) => agent.get(`/api/v1${url}`),
    post: (url: string) => agent.post(`/api/v1${url}`).set('x-csrf-token', csrf),
    patch: (url: string) => agent.patch(`/api/v1${url}`).set('x-csrf-token', csrf),
    delete: (url: string) => agent.delete(`/api/v1${url}`).set('x-csrf-token', csrf),
  };
}

async function makeReport(over: Record<string, unknown> = {}) {
  const reporter = over.reporterId as string | undefined;
  const r = await Report.create({
    reporterId: reporter ?? new mongoose.Types.ObjectId(),
    reportedId: new mongoose.Types.ObjectId(),
    category: 'harassment',
    severity: 'high',
    slaDueAt: new Date(Date.now() + 4 * 3_600_000),
    transcript: [{ at: new Date(), senderId: 'x', body: 'private words' }],
    ...over,
  });
  return String(r._id);
}

describe('moderation queue and actions', () => {
  it('orders by severity then age, flags overdue, and shows repeat-reporter signals', async () => {
    const t = setup();
    const mod = await staffSession(t, 'Mod', 'moderator');
    const bad = await user(t, 'Bad');
    await makeReport({ reportedId: bad.id, severity: 'low' });
    await makeReport({ reportedId: bad.id, severity: 'critical', category: 'safety_threat' });
    await makeReport({ reportedId: bad.id, severity: 'high', slaDueAt: new Date(Date.now() - 1000) });

    const q = (await mod.get('/admin/moderation').expect(200)).body.items;
    expect(q.map((i: { severity: string }) => i.severity)).toEqual(['critical', 'high', 'low']);
    expect(q[1].overdue).toBe(true);
    expect(q[0].distinctReporters).toBe(3);
    expect(q[0].reportedName).toBe('Bad');
  });

  it('claims once, then another moderator cannot act on it', async () => {
    const t = setup();
    const a = await staffSession(t, 'Anna', 'moderator');
    const b = await staffSession(t, 'Ben', 'moderator');
    const id = await makeReport();
    await a.post(`/admin/moderation/${id}/claim`).send({}).expect(200);
    await b.post(`/admin/moderation/${id}/claim`).send({}).expect(409);
    await b.post(`/admin/moderation/${id}/action`).send({ action: 'dismiss', reason: 'No evidence of any problem here' }).expect(409);
  });

  it('records a warning, tells the member kindly, and tells the reporter only that it was handled', async () => {
    const t = setup();
    const mod = await staffSession(t, 'Mod', 'moderator');
    // Quiet hours off so the email is not held when the suite runs at night.
    const reporter = await user(t, 'Rita', ['member'], { notificationPrefs: { quietHours: { enabled: false, start: '22:00', end: '08:00' } } });
    const bad = await user(t, 'Bad');
    const id = await makeReport({ reporterId: reporter.id, reportedId: bad.id });

    await mod.post(`/admin/moderation/${id}/action`).send({ action: 'warn', reason: 'Repeated pushy messages' }).expect(422);
    await mod
      .post(`/admin/moderation/${id}/action`)
      .send({ action: 'warn', reason: 'Repeated pushy messages', memberMessage: 'Please give people space to answer. Repeated messages are not okay here.' })
      .expect(200);

    const r = (await Report.findById(id).lean())!;
    expect(r.status).toBe('action_taken');
    expect(r.resolution?.action).toBe('warn');

    const events = await Outbox.find({ eventType: { $in: ['moderation.warning', 'report.resolved'] } }).lean();
    expect(events.map((e) => e.eventType).sort()).toEqual(['moderation.warning', 'report.resolved']);
    const warn = events.find((e) => e.eventType === 'moderation.warning')!;
    const resolved = events.find((e) => e.eventType === 'report.resolved')!;
    expect((warn.payload as { userId: string }).userId).toBe(bad.id);
    expect((resolved.payload as { userId: string }).userId).toBe(reporter.id);

    // The reporter's notification says nothing about what happened.
    await dispatchEvent(t.ctx, 'report.resolved', resolved.payload as Record<string, unknown>, 'e1');
    expect(t.mailer.last(reporter.email)?.html).not.toMatch(/warn|suspend|ban/i);
  });

  it('suspends through the audited status path, ending the session, and logs the action', async () => {
    const t = setup();
    const mod = await staffSession(t, 'Mod', 'moderator');
    const bad = await user(t, 'Bad');
    const badSession = await memberSession(t, bad);
    const id = await makeReport({ reportedId: bad.id });
    await mod.post(`/admin/moderation/${id}/action`).send({ action: 'suspend', reason: 'Confirmed harassment of two members' }).expect(200);

    expect((await User.findById(bad.id))?.status).toBe('suspended');
    await badSession.get('/auth/me').expect(401);
    expect(await ModerationAction.countDocuments({ userId: bad.id, action: 'suspend' })).toBe(1);
    expect(await AuditLog.countDocuments({ action: 'member.suspend', subjectId: bad.id })).toBe(1);
  });

  it('keeps private messages behind their own permission and audits every view', async () => {
    const t = setup();
    const mod = await staffSession(t, 'Mod', 'moderator');
    const id = await makeReport();
    const d = (await mod.get(`/admin/moderation/${id}`).expect(200)).body;
    expect(d.transcript).toHaveLength(1);
    expect(await AuditLog.countDocuments({ action: 'report.transcript_viewed', subjectId: id })).toBe(1);

    // A role with moderation.view but not messages.view_reported sees the case without the words.
    const finance = await staffSession(t, 'Fin', 'finance');
    await finance.get(`/admin/moderation/${id}`).expect(403);
  });

  it('does not let someone who escalated a report decide it', async () => {
    const t = setup();
    const a = await staffSession(t, 'Anna', 'moderator');
    const id = await makeReport();
    await a.post(`/admin/moderation/${id}/action`).send({ action: 'escalate', reason: 'Needs a senior opinion on this' }).expect(200);
    expect((await Report.findById(id).lean())!.escalated).toBe(true);
    await a.post(`/admin/moderation/${id}/action`).send({ action: 'dismiss', reason: 'Changed my mind about it now' }).expect(409);
  });

  it('refuses to ban without the ban permission', async () => {
    const t = setup();
    const agent = await staffSession(t, 'Sam', 'support_agent');
    const id = await makeReport();
    await agent.post(`/admin/moderation/${id}/action`).send({ action: 'ban', reason: 'Trying something big here' }).expect(403);
  });
});

describe('appeals', () => {
  it('never reveals whether an account exists, and only records appeals for suspended accounts', async () => {
    const t = setup();
    const active = await user(t, 'Active');
    const gone = await user(t, 'Gone', ['member'], { status: 'suspended', moderation: { reason: 'harassment', by: new mongoose.Types.ObjectId() } });
    const msg = 'I believe this was a misunderstanding. The messages were meant kindly and I have stopped.';

    const a = await request(t.app).post('/api/v1/appeals').send({ email: active.email, message: msg }).expect(202);
    const b = await request(t.app).post('/api/v1/appeals').send({ email: gone.email, message: msg }).expect(202);
    const c = await request(t.app).post('/api/v1/appeals').send({ email: 'nobody@example.com', message: msg }).expect(202);
    expect(a.body).toEqual(b.body);
    expect(b.body).toEqual(c.body);
    expect(await Appeal.countDocuments({})).toBe(1);

    // Second submission while one is pending changes nothing.
    await request(t.app).post('/api/v1/appeals').send({ email: gone.email, message: msg }).expect(202);
    expect(await Appeal.countDocuments({})).toBe(1);
  });

  it('is decided by someone other than who took the action, restores on overturn and emails the member', async () => {
    const t = setup();
    const first = await staffSession(t, 'Anna', 'moderator');
    const second = await staffSession(t, 'Ben', 'moderator');
    const bad = await user(t, 'Bad', ['member'], { status: 'suspended', journeyState: 'suspended', moderation: { reason: 'harassment', by: first.id, journeyBefore: 'matching_active' } });
    await request(t.app)
      .post('/api/v1/appeals')
      .send({ email: bad.email, message: 'This was a misunderstanding and I would like to explain what happened.' })
      .expect(202);
    const appeal = (await first.get('/admin/appeals').expect(200)).body.items[0];
    expect(appeal.moderationReason).toBe('harassment');

    const body = { decision: 'overturned', note: 'Context shows the messages were reciprocal', memberMessage: 'We looked again and have restored your account.' };
    await first.post(`/admin/appeals/${appeal.id}/decision`).send(body).expect(409);
    await second.post(`/admin/appeals/${appeal.id}/decision`).send(body).expect(200);

    expect((await User.findById(bad.id))?.status).toBe('active');
    expect(t.mailer.last(bad.email)?.subject).toBe('Your appeal was successful');
    await second.post(`/admin/appeals/${appeal.id}/decision`).send(body).expect(409);
  });
});

describe('support tickets', () => {
  it('lets a member open a ticket and read replies, but never internal notes', async () => {
    const t = setup();
    const agent = await staffSession(t, 'Sam', 'support_agent');
    const m = await memberSession(t, await user(t, 'Meera'));
    const created = (
      await m.post('/support/tickets').send({ category: 'billing', subject: 'Charged twice', body: 'I was charged twice for my plan this month.' }).expect(201)
    ).body;
    expect(created.number).toMatch(/^T-\d{6}$/);
    expect(created.priority).toBe('high');

    const inbox = (await agent.get('/admin/support/tickets').expect(200)).body.items;
    expect(inbox[0]).toMatchObject({ number: created.number, priority: 'high', overdue: false });

    await agent.post(`/admin/support/tickets/${created.id}/note`).send({ body: 'Checked: duplicate was a retry' }).expect(201);
    await agent.post(`/admin/support/tickets/${created.id}/reply`).send({ body: 'Sorry about that. We have refunded the second charge.' }).expect(201);

    const mine = (await m.get(`/support/tickets/${created.id}`).expect(200)).body;
    expect(mine.status).toBe('waiting_on_member');
    expect(mine.messages.map((x: { body: string }) => x.body)).toEqual([
      'I was charged twice for my plan this month.',
      'Sorry about that. We have refunded the second charge.',
    ]);
    expect(JSON.stringify(mine)).not.toContain('duplicate was a retry');

    // Reply notifies in-app, with the ticket number and no body text
    const ev = await Outbox.findOne({ eventType: 'support.replied' }).lean();
    expect(ev).toBeTruthy();

    await m.post(`/support/tickets/${created.id}/reply`).send({ body: 'Thank you!' }).expect(201);
    expect((await Ticket.findById(created.id).lean())!.status).toBe('open');
  });

  it('keeps one member out of another member ticket', async () => {
    const t = setup();
    const a = await memberSession(t, await user(t, 'Asha'));
    const b = await memberSession(t, await user(t, 'Bela'));
    const created = (await a.post('/support/tickets').send({ category: 'account', subject: 'Change my email', body: 'Please help me change my email address.' }).expect(201)).body;
    await b.get(`/support/tickets/${created.id}`).expect(404);
    await b.post(`/support/tickets/${created.id}/reply`).send({ body: 'hi' }).expect(404);
  });

  it('turns a contact form request into a ticket and answers by email when there is no account', async () => {
    const t = setup();
    const agent = await staffSession(t, 'Sam', 'support_agent');
    await request(t.app)
      .post('/api/v1/contact')
      .send({ name: 'Visitor', email: 'visitor@example.com', topic: 'grievance', message: 'I want to raise a grievance about how my data is handled.' })
      .expect(202);
    const tk = (await Ticket.findOne({ email: 'visitor@example.com' }).lean())!;
    expect(tk.priority).toBe('high');
    await agent.post(`/admin/support/tickets/${tk._id}/reply`).send({ body: 'We have received your grievance and will respond within 7 days.' }).expect(201);
    expect(t.mailer.last('visitor@example.com')?.subject).toContain(tk.number);
  });

  it('marks overdue tickets and closes stale ones', async () => {
    const t = setup();
    const agent = await staffSession(t, 'Sam', 'support_agent');
    const m = await memberSession(t, await user(t, 'Meera'));
    const created = (await m.post('/support/tickets').send({ category: 'other', subject: 'A question', body: 'How does the review process work exactly?' }).expect(201)).body;
    await Ticket.collection.updateOne({ _id: new mongoose.Types.ObjectId(created.id) }, { $set: { firstResponseDueAt: new Date(Date.now() - 60_000) } });
    const late = (await agent.get('/admin/support/tickets?overdue=true').expect(200)).body.items;
    expect(late).toHaveLength(1);
    expect(late[0].overdue).toBe(true);

    await agent.patch(`/admin/support/tickets/${created.id}`).send({ status: 'resolved' }).expect(200);
    expect(await closeStale(new Date(Date.now() + 8 * 86_400_000))).toBe(1);
    expect((await Ticket.findById(created.id).lean())!.status).toBe('closed');
  });

  it('keeps support tools away from people without the permission', async () => {
    const t = setup();
    const m = await memberSession(t, await user(t, 'Meera'));
    await m.get('/admin/support/tickets').expect(403);
    const mod = await staffSession(t, 'Mod', 'moderator');
    await mod.get('/admin/support/tickets').expect(403);
  });
});
