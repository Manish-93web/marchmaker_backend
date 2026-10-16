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
import { purgeDueAccounts } from '../src/jobs/accountJobs';
import type { FailedJob, JobsAdmin, QueueCounts, QueueKey } from '../src/lib/jobsAdmin';
import { createLogger } from '../src/lib/logger';
import { MemoryMailer } from '../src/lib/mailer';
import { hashPassword } from '../src/lib/passwords';
import { MemorySms } from '../src/lib/sms';
import { DataRequest } from '../src/models/auth';
import { AuditLog, Outbox, Setting, User } from '../src/models/core';

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

class FakeJobs implements JobsAdmin {
  failedEvents: FailedJob[] = [{ id: '7', name: 'introduction.released', attemptsMade: 6, failedReason: 'smtp down', failedAt: new Date().toISOString(), payloadKeys: ['userId'] }];
  dead: FailedJob[] = [{ id: 'd1', name: 'message.created', attemptsMade: 6, failedReason: 'boom', failedAt: null, payloadKeys: ['threadId'] }];
  retried: string[] = [];
  async counts(): Promise<Record<QueueKey, QueueCounts>> {
    return { events: { waiting: 1, active: 0, delayed: 2, failed: this.failedEvents.length, completed: 9 }, 'dead-letter': { waiting: this.dead.length, active: 0, delayed: 0, failed: 0, completed: 0 } };
  }
  async failed(q: QueueKey) {
    return q === 'events' ? this.failedEvents : this.dead;
  }
  async retry(q: QueueKey, id: string) {
    const list = q === 'events' ? this.failedEvents : this.dead;
    if (!list.some((j) => j.id === id)) return false;
    this.retried.push(`${q}:${id}`);
    return true;
  }
  async remove(q: QueueKey, id: string) {
    const list = q === 'events' ? this.failedEvents : this.dead;
    const i = list.findIndex((j) => j.id === id);
    if (i < 0) return false;
    list.splice(i, 1);
    return true;
  }
  async close() {}
}

function setup(withJobs = true) {
  const env = loadEnv({ NODE_ENV: 'test', EXPORT_DIR: mkdtempSync(path.join(tmpdir(), 'mm-sys-')) } as NodeJS.ProcessEnv);
  const log = createLogger('silent');
  const fake = new FakeJobs();
  const mailer = new MemoryMailer();
  const ctx = buildContext({ env, log, mailer, sms: new MemorySms() }, withJobs ? { jobs: fake } : {});
  return { app: createApp({ env, log, isReady: () => true, ctx }), ctx, fake, mailer };
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
  const email = `sys${n}@example.com`;
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
    delete: (url: string) => agent.delete(`/api/v1${url}`).set('x-csrf-token', csrf),
  };
}

describe('job queue console', () => {
  it('shows queue health and the outbox, and lets staff retry or discard failed work', async () => {
    const t = setup();
    const boss = await session(t, ['super_admin']);
    await Outbox.create({ eventType: 'a.b', status: 'pending' });
    await Outbox.create({ eventType: 'c.d', status: 'failed', attempts: 8, lastError: 'queue down' });

    const o = (await boss.get('/admin/jobs').expect(200)).body;
    expect(o.queuesAvailable).toBe(true);
    expect(o.queues.events).toMatchObject({ failed: 1, delayed: 2 });
    expect(o.outbox).toMatchObject({ pending: 1, failed: 1 });

    const failed = (await boss.get('/admin/jobs/failed?queue=events').expect(200)).body.items;
    expect(failed[0]).toMatchObject({ name: 'introduction.released', payloadKeys: ['userId'] });
    expect(JSON.stringify(failed)).not.toMatch(/@/); // keys only, never values

    await boss.post('/admin/jobs/events/7/retry').expect(200);
    expect(t.fake.retried).toEqual(['events:7']);
    await boss.post('/admin/jobs/dead-letter/d1/retry').expect(200);
    await boss.post('/admin/jobs/events/nope/retry').expect(404);
    await boss.delete('/admin/jobs/events/7').expect(200);
    await boss.get('/admin/jobs/failed?queue=bogus').expect(422);

    const ob = (await boss.get('/admin/outbox/failed').expect(200)).body.items;
    expect(ob[0]).toMatchObject({ eventType: 'c.d', lastError: 'queue down' });
    await boss.post(`/admin/outbox/${ob[0].id}/retry`).expect(200);
    expect((await Outbox.findOne({ eventType: 'c.d' }).lean())!.status).toBe('pending');
    await boss.post(`/admin/outbox/${ob[0].id}/retry`).expect(404);
    expect(await AuditLog.countDocuments({ action: { $regex: '^(job|outbox)\\.' } })).toBeGreaterThanOrEqual(4);
  });

  it('says so plainly when no queue is connected, and keeps the console to people with permission', async () => {
    const t = setup(false);
    const boss = await session(t, ['super_admin']);
    expect((await boss.get('/admin/jobs').expect(200)).body).toMatchObject({ queuesAvailable: false, queues: null });
    expect((await boss.get('/admin/jobs/failed').expect(503)).body.error.code).toBe('QUEUES_UNAVAILABLE');
    const support = await session(t, ['support_agent']);
    await support.get('/admin/jobs').expect(403);
    const member = await session(t);
    await member.get('/admin/jobs').expect(403);
  });
});

describe('data request approval', () => {
  const requireApproval = (boss: Awaited<ReturnType<typeof session>>) => boss.put('/admin/settings/data_requests').send({ requireApproval: true }).expect(200);

  it('runs exports straight away by default', async () => {
    const t = setup();
    const m = await session(t);
    const r = (await m.post('/account/export').send({}).expect(202)).body;
    expect(r.status).toBe('pending');
    expect(await Outbox.countDocuments({ eventType: 'account.export_requested' })).toBe(1);
  });

  it('holds an export until a super admin approves it, then runs it', async () => {
    const t = setup();
    const boss = await session(t, ['super_admin']);
    await requireApproval(boss);
    const m = await session(t);
    const r = (await m.post('/account/export').send({}).expect(202)).body;
    expect(r.status).toBe('awaiting_approval');
    expect(await Outbox.countDocuments({ eventType: 'account.export_requested' })).toBe(0);

    const list = (await boss.get('/admin/data-requests').expect(200)).body.items;
    expect(list[0]).toMatchObject({ kind: 'export', status: 'awaiting_approval', member: { id: m.id } });
    await boss.post(`/admin/data-requests/${list[0].id}/decision`).send({ decision: 'approve', note: 'x' }).expect(422);
    await boss.post(`/admin/data-requests/${list[0].id}/decision`).send({ decision: 'approve', note: 'Identity confirmed by phone' }).expect(200);
    expect(await Outbox.countDocuments({ eventType: 'account.export_requested' })).toBe(1);
    expect((await DataRequest.findById(list[0].id).lean())!.status).toBe('pending');
    await boss.post(`/admin/data-requests/${list[0].id}/decision`).send({ decision: 'reject', note: 'Changed my mind' }).expect(409);
    expect(await AuditLog.countDocuments({ action: 'data_request.approve' })).toBe(1);
  });

  it('keeps a deletion on hold past the grace period until approved, and restores the account if declined', async () => {
    const t = setup();
    const boss = await session(t, ['super_admin']);
    await requireApproval(boss);
    const m = await session(t);
    await m.post('/account/delete').send({ password: PASSWORD, confirm: 'DELETE' }).expect(200);
    const dr = (await DataRequest.findOne({ userId: m.id, kind: 'deletion' }).lean())!;
    expect(dr.status).toBe('awaiting_approval');

    // The grace period ends, but nothing is erased while the request waits.
    await User.updateOne({ _id: m.id }, { $set: { deletionScheduledFor: new Date(Date.now() - 1000) } });
    expect(await purgeDueAccounts(t.ctx)).toBe(0);
    expect(await User.countDocuments({ _id: m.id })).toBe(1);

    // Approving lets the normal purge go ahead.
    await boss.post(`/admin/data-requests/${dr._id}/decision`).send({ decision: 'approve', note: 'Verified by phone call' }).expect(200);
    expect(await purgeDueAccounts(t.ctx)).toBe(1);
    expect(await User.countDocuments({ _id: m.id })).toBe(0);
  });

  it('declining a deletion restores the account and tells the member', async () => {
    const t = setup();
    const boss = await session(t, ['super_admin']);
    await requireApproval(boss);
    const m = await session(t);
    await m.post('/account/delete').send({ password: PASSWORD, confirm: 'DELETE' }).expect(200);
    const dr = (await DataRequest.findOne({ userId: m.id, kind: 'deletion' }).lean())!;
    await boss.post(`/admin/data-requests/${dr._id}/decision`).send({ decision: 'reject', note: 'There is an open dispute we must resolve first' }).expect(200);
    const u = (await User.findById(m.id).lean())!;
    expect(u.status).toBe('active');
    expect(u.deletionScheduledFor).toBeUndefined();
    const mail = t.mailer.last(m.email)!;
    expect(mail.html).toContain('open dispute');
    expect(mail.html).toContain('has been restored');
  });

  it('is decided only by someone allowed to, and never about their own account', async () => {
    const t = setup();
    const boss = await session(t, ['super_admin']);
    await requireApproval(boss);
    const admin = await session(t, ['admin']); // admin lacks data_requests.approve by default
    await admin.get('/admin/data-requests').expect(403);
    await boss.post('/account/export').send({}).expect(202);
    const own = (await boss.get('/admin/data-requests').expect(200)).body.items[0];
    await boss.post(`/admin/data-requests/${own.id}/decision`).send({ decision: 'approve', note: 'Approving my own' }).expect(403);
  });
});

describe('retention settings', () => {
  it('uses the edited deletion grace period and shows the evidence retention to staff and members', async () => {
    const t = setup();
    const boss = await session(t, ['super_admin']);
    const before = (await boss.get('/admin/settings').expect(200)).body;
    expect(before.retention).toMatchObject({ evidenceDays: 30, deletionGraceDays: 14 });
    await boss.put('/admin/settings/retention').send({ evidenceDays: 15, deletionGraceDays: 7 }).expect(200);
    await boss.put('/admin/settings/retention').send({ evidenceDays: 0, deletionGraceDays: 7 }).expect(422);
    expect((await Setting.findOne({ key: 'retention' }).lean())!.value).toMatchObject({ evidenceDays: 15 });

    const m = await session(t);
    const out = (await m.post('/account/delete').send({ password: PASSWORD, confirm: 'DELETE' }).expect(200)).body;
    const days = (new Date(out.purgeAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });
});
