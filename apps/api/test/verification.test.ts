import { mkdtempSync, readFileSync } from 'node:fs';
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
import { buildExport, purgeDueAccounts } from '../src/jobs/accountJobs';
import { registerMemberDataHooks } from '../src/jobs/registerPurge';
import { pollPendingKyc, processKycEvent, purgeExpiredEvidence } from '../src/jobs/verificationJobs';
import { breakerStates, CircuitOpenError, ProviderBreaker, withBreaker } from '../src/lib/breaker';
import { signWebhook, type MockKycProvider } from '../src/lib/kyc';
import { MemoryMailer } from '../src/lib/mailer';
import { createLogger } from '../src/lib/logger';
import { hashPassword } from '../src/lib/passwords';
import { MemorySms } from '../src/lib/sms';
import { MemoryStorage } from '../src/lib/storage';
import { AuditLog, FeatureFlag, User } from '../src/models/core';
import { Verification, WebhookEvent } from '../src/models/verification';

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
  const env = loadEnv({
    NODE_ENV: 'test',
    KYC_PROVIDER: 'mock',
    KYC_WEBHOOK_SECRET: 'test-webhook-secret',
    EXPORT_DIR: mkdtempSync(path.join(tmpdir(), 'mm-ver-')),
  } as NodeJS.ProcessEnv);
  const log = createLogger('silent');
  const mailer = new MemoryMailer();
  const storage = new MemoryStorage();
  const ctx = buildContext({ env, log, mailer, sms: new MemorySms() }, { storage });
  const kyc = ctx.kyc as MockKycProvider;
  const app = createApp({ env, log, isReady: () => true, ctx });
  return { app, ctx, mailer, storage, kyc, env };
}
type T = ReturnType<typeof setup>;

const csrfOf = (res: request.Response) =>
  ((res.headers['set-cookie'] as unknown as string[]) ?? [])
    .find((c) => c.startsWith('mm_csrf='))!
    .split(';')[0]!
    .slice('mm_csrf='.length);

async function member(t: T, email = 'asha@example.com', journeyState = 'profile_approved') {
  const dob = `${new Date().getUTCFullYear() - 28}-03-04`;
  await request(t.app)
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, firstName: 'Asha', gender: 'woman', dob, acceptTerms: true })
    .expect(202);
  const token = t.mailer.last(email)!.text.match(/token=([A-Za-z0-9_-]+)/)![1]!;
  await request(t.app).post('/api/v1/auth/verify-email').send({ token }).expect(200);
  await User.updateOne({ email }, { $set: { journeyState } });
  const agent = request.agent(t.app);
  const login = await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
  const csrf = csrfOf(login);
  const userId = String((await User.findOne({ email }))!._id);
  return {
    userId,
    get: (url: string) => agent.get(`/api/v1${url}`),
    post: (url: string) => agent.post(`/api/v1${url}`).set('x-csrf-token', csrf),
  };
}
type M = Awaited<ReturnType<typeof member>>;

/** A staff account that has completed TOTP enrolment, as the API requires. */
async function staff(t: T, roles: Role[], email = 'verifier@example.com', withTotp = true) {
  await User.create({
    email,
    passwordHash: await hashPassword(PASSWORD),
    firstName: 'Vera',
    gender: 'woman',
    dobEnc: t.ctx.crypto.encrypt('1990-01-01'),
    roles,
    emailVerifiedAt: new Date(),
  });
  const agent = request.agent(t.app);
  const login = await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
  let csrf = csrfOf(login);
  if (withTotp) {
    const setupRes = await agent.post('/api/v1/auth/2fa/setup').set('x-csrf-token', csrf).expect(200);
    const confirm = await agent
      .post('/api/v1/auth/2fa/confirm')
      .set('x-csrf-token', csrf)
      .send({ code: generateSync({ secret: String(setupRes.body.secret) }) })
      .expect(200);
    csrf = csrfOf(confirm);
  }
  const userId = String((await User.findOne({ email }))!._id);
  return {
    userId,
    get: (url: string) => agent.get(`/api/v1${url}`),
    post: (url: string) => agent.post(`/api/v1${url}`).set('x-csrf-token', csrf),
  };
}

const IMG = Buffer.alloc(4096, 7);

async function uploadEvidence(t: T, m: M, kinds = ['id_front', 'id_back', 'selfie']) {
  for (const kind of kinds) {
    const up = await m.post('/verification/upload-url').send({ kind, contentType: 'image/jpeg', sizeBytes: IMG.length }).expect(201);
    expect(up.body.upload.method).toBe('PUT');
    const v = await Verification.findById(up.body.caseId);
    const key = (v!.evidence as unknown as Record<string, { key: string }>)[kind]!.key;
    await t.storage.put('identity', key, IMG, 'image/jpeg');
  }
}

const SUBMIT = { docType: 'pan', docLast4: '234F' };
const APPROVE = {
  decision: 'approve',
  checklist: { nameMatches: true, dobMatches: true, photoMatches: true, notExpired: true, notTampered: true },
};

async function submitted(t: T, email?: string) {
  const m = await member(t, email);
  await uploadEvidence(t, m);
  await m.post('/verification/submit').send(SUBMIT).expect(200);
  const v = (await Verification.findOne({ userId: m.userId }))!;
  return { m, id: String(v._id) };
}

describe('member evidence upload and submission', () => {
  it('stays closed until the profile has been approved', async () => {
    const t = setup();
    const m = await member(t, 'early@example.com', 'email_verified');
    const res = await m.post('/verification/upload-url').send({ kind: 'selfie', contentType: 'image/jpeg', sizeBytes: 4096 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VERIFICATION_NOT_READY');
    expect((await m.get('/verification/status')).body.ready).toBe(false);
  });

  it('uploads straight to the identity bucket under the member prefix, never the photo bucket', async () => {
    const t = setup();
    const m = await member(t);
    const up = await m.post('/verification/upload-url').send({ kind: 'id_front', contentType: 'image/png', sizeBytes: 5000 }).expect(201);
    const v = await Verification.findById(up.body.caseId);
    const key = (v!.evidence as unknown as Record<string, { key: string }>).id_front!.key;
    expect(key.startsWith(`identity/${m.userId}/`)).toBe(true);
    expect(up.body.upload.url).toContain('identity');
    await m.post('/verification/upload-url').send({ kind: 'id_front', contentType: 'application/pdf', sizeBytes: 5000 }).expect(422);
    await m.post('/verification/upload-url').send({ kind: 'id_front', contentType: 'image/png', sizeBytes: 99_000_000 }).expect(422);
    await m.post('/verification/upload-url').send({ kind: 'passport_scan', contentType: 'image/png', sizeBytes: 5000 }).expect(422);
  });

  it('shows each document as received as soon as it is uploaded, before submitting', async () => {
    const t = setup();
    const m = await member(t);
    expect((await m.get('/verification/status')).body.uploaded).toEqual({ id_front: false, id_back: false, selfie: false });
    const up = await m.post('/verification/upload-url').send({ kind: 'id_front', contentType: 'image/jpeg', sizeBytes: IMG.length }).expect(201);
    // Declared but not yet in storage: still not received.
    expect((await m.get('/verification/status')).body.uploaded.id_front).toBe(false);
    const v = await Verification.findById(up.body.caseId);
    await t.storage.put('identity', (v!.evidence as unknown as Record<string, { key: string }>).id_front!.key, IMG, 'image/jpeg');
    expect((await m.get('/verification/status')).body.uploaded).toEqual({ id_front: true, id_back: false, selfie: false });
  });

  it('names what is missing, then submits and moves the journey forward', async () => {
    const t = setup();
    const m = await member(t);
    await uploadEvidence(t, m, ['id_front']);
    const early = await m.post('/verification/submit').send(SUBMIT);
    expect(early.status).toBe(422);
    expect(early.body.error.details.missing.sort()).toEqual(['id_back', 'selfie']);

    await uploadEvidence(t, m, ['id_back', 'selfie']);
    await m.post('/verification/submit').send({ docType: 'aadhaar', docLast4: '1234' }).expect(422); // unmasked type
    await m.post('/verification/submit').send({ docType: 'pan', docLast4: 'ABCDE1234F' }).expect(422); // not just last 4
    const ok = await m.post('/verification/submit').send(SUBMIT).expect(200);
    expect(ok.body.state).toBe('pending');
    expect(ok.body.docLast4).toBe('234F');
    expect((await User.findById(m.userId))?.journeyState).toBe('verification_pending');

    await m.post('/verification/submit').send(SUBMIT).expect(409);
    await m.post('/verification/upload-url').send({ kind: 'selfie', contentType: 'image/jpeg', sizeBytes: 4096 }).expect(409);
  });

  it('rejects an object whose size does not match what was declared', async () => {
    const t = setup();
    const m = await member(t);
    const up = await m.post('/verification/upload-url').send({ kind: 'id_front', contentType: 'image/jpeg', sizeBytes: 4096 }).expect(201);
    const key = ((await Verification.findById(up.body.caseId))!.evidence as unknown as Record<string, { key: string }>).id_front!.key;
    await t.storage.put('identity', key, Buffer.alloc(9000), 'image/jpeg');
    await uploadEvidence(t, m, ['id_back', 'selfie']);
    const res = await m.post('/verification/submit').send(SUBMIT);
    expect(res.status).toBe(422);
    expect(res.body.error.details.missing).toContain('id_front');
  });
});

describe('staff access and audit', () => {
  it('keeps the queue closed to members, to staff without the permission, and to staff without TOTP', async () => {
    const t = setup();
    const { id } = await submitted(t);
    await request(t.app).get('/api/v1/admin/verification').expect(401);

    const member2 = await member(t, 'other@example.com');
    expect((await member2.get('/admin/verification')).status).toBe(403);

    const support = await staff(t, ['support_agent'], 'support@example.com');
    expect((await support.get('/admin/verification')).status).toBe(403);
    expect((await support.get(`/admin/verification/${id}`)).status).toBe(403);

    const noTotp = await staff(t, ['verifier'], 'nototp@example.com', false);
    const res = await noTotp.get('/admin/verification');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TOTP_SETUP_REQUIRED');
  });

  it('lists the queue oldest first and audits every evidence view with the exact items shown', async () => {
    const t = setup();
    const a = await submitted(t, 'a@example.com');
    await submitted(t, 'b@example.com');
    const v = await staff(t, ['verifier']);

    const list = (await v.get('/admin/verification').expect(200)).body.items;
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe(a.id);
    expect(JSON.stringify(list)).not.toMatch(/identity\//); // no storage keys in the list

    const detail = (await v.get(`/admin/verification/${a.id}`).expect(200)).body;
    expect(Object.keys(detail.evidence).sort()).toEqual(['id_back', 'id_front', 'selfie']);
    expect(detail.evidence.id_front).toContain('ttl=300'); // short-lived link
    expect(detail.member.dateOfBirth).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(detail.docLast4).toBe('234F');
    expect(detail.status).toBe('in_review');

    const logs = await AuditLog.find({ action: 'verification.view_evidence', subjectId: a.id }).lean();
    expect(logs).toHaveLength(1);
    expect(String(logs[0]!.actorId)).toBe(v.userId);
    expect((logs[0]!.after as { kinds: string[] }).kinds.sort()).toEqual(['id_back', 'id_front', 'selfie']);

    await v.get(`/admin/verification/${a.id}`).expect(200);
    expect(await AuditLog.countDocuments({ action: 'verification.view_evidence', subjectId: a.id })).toBe(2);
  });
});

describe('decisions', () => {
  it('approves only when every check passes, then verifies and activates the member', async () => {
    const t = setup();
    const { m, id } = await submitted(t);
    const v = await staff(t, ['verifier']);

    const partial = await v
      .post(`/admin/verification/${id}/decision`)
      .send({ ...APPROVE, checklist: { ...APPROVE.checklist, photoMatches: false } });
    expect(partial.status).toBe(422);
    expect(partial.body.error.code).toBe('CHECKLIST_INCOMPLETE');

    await v.post(`/admin/verification/${id}/decision`).send(APPROVE).expect(200);
    const user = await User.findById(m.userId);
    expect(user?.journeyState).toBe('matching_active');
    expect(user?.verification?.idVerifiedAt).toBeTruthy();
    expect(user?.verification?.selfieVerifiedAt).toBeTruthy();

    const status = (await m.get('/verification/status')).body;
    expect(status.state).toBe('approved');
    expect(status.badges).toMatchObject({ id: true, selfie: true, email: true });

    const row = await Verification.findById(id);
    expect(row?.purgeAfter).toBeTruthy();
    expect(row?.decidedBy).toBe('staff');
    expect(await AuditLog.countDocuments({ action: 'verification.approve' })).toBe(1);
    await v.post(`/admin/verification/${id}/decision`).send(APPROVE).expect(409);
  });

  it('lets exactly one of two simultaneous decisions win', async () => {
    const t = setup();
    const { id } = await submitted(t);
    const v1 = await staff(t, ['verifier'], 'v1@example.com');
    const v2 = await staff(t, ['verifier'], 'v2@example.com');
    const [a, b] = await Promise.all([
      v1.post(`/admin/verification/${id}/decision`).send(APPROVE),
      v2.post(`/admin/verification/${id}/decision`).send({ decision: 'reject', reason: 'expired' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it('rejects with a kind message for the member, never the internal note, and allows a fresh attempt', async () => {
    const t = setup();
    const { m, id } = await submitted(t);
    const v = await staff(t, ['verifier']);
    await v.post(`/admin/verification/${id}/decision`).send({ decision: 'reject', reason: 'expired', note: 'looks forged, escalate' }).expect(200);

    const status = (await m.get('/verification/status')).body;
    expect(status.state).toBe('rejected');
    expect(status.message).toMatch(/expired/);
    expect(JSON.stringify(status)).not.toMatch(/forged|escalate/);
    expect((await User.findById(m.userId))?.journeyState).toBe('verification_rejected');

    await uploadEvidence(t, m);
    await m.post('/verification/submit').send(SUBMIT).expect(200);
    expect((await User.findById(m.userId))?.journeyState).toBe('verification_pending');
    expect(await Verification.countDocuments({ userId: m.userId })).toBe(2);
  });

  it('asks for specific items again and accepts a resubmission with only those replaced', async () => {
    const t = setup();
    const { m, id } = await submitted(t);
    const v = await staff(t, ['verifier']);
    await v.post(`/admin/verification/${id}/decision`).send({ decision: 'request_reupload', kinds: ['selfie'] }).expect(200);

    const status = (await m.get('/verification/status')).body;
    expect(status.state).toBe('reupload_requested');
    expect(status.reuploadKinds).toEqual(['selfie']);
    expect(status.uploaded).toMatchObject({ id_front: true, id_back: true, selfie: false });
    expect((await User.findById(m.userId))?.journeyState).toBe('verification_pending');

    await m.post('/verification/submit').send(SUBMIT).expect(422); // selfie still missing
    await uploadEvidence(t, m, ['selfie']);
    const again = await m.post('/verification/submit').send(SUBMIT).expect(200);
    expect(again.body.state).toBe('pending');
  });
});

describe('retention', () => {
  it('deletes raw images after the retention window but keeps the decision record', async () => {
    const t = setup();
    const { m, id } = await submitted(t);
    const v = await staff(t, ['verifier']);
    await v.post(`/admin/verification/${id}/decision`).send(APPROVE).expect(200);

    const keys = Object.values((await Verification.findById(id))!.evidence as unknown as Record<string, { key: string }>).map((e) => e.key);
    expect(keys).toHaveLength(3);
    expect(keys.every((k) => t.storage.has('identity', k))).toBe(true);

    expect(await purgeExpiredEvidence(t.ctx, new Date())).toBe(0); // not yet due
    expect(keys.every((k) => t.storage.has('identity', k))).toBe(true);

    const later = new Date(Date.now() + 31 * 86_400_000);
    expect(await purgeExpiredEvidence(t.ctx, later)).toBe(1);
    expect(keys.some((k) => t.storage.has('identity', k))).toBe(false);

    const row = await Verification.findById(id);
    expect(row?.status).toBe('approved');
    expect(row?.docLast4).toBe('234F');
    expect(String(row?.reviewerId)).toBe(v.userId);
    expect(row?.evidencePurgedAt).toBeTruthy();

    const detail = (await v.get(`/admin/verification/${id}`).expect(200)).body;
    expect(detail.evidence).toEqual({});
    expect(detail.evidencePurged).toBe(true);
    expect((await m.get('/verification/status')).body.badges.id).toBe(true);
  });

  it('never purges a case that is still waiting for a decision', async () => {
    const t = setup();
    const { id } = await submitted(t);
    const later = new Date(Date.now() + 365 * 86_400_000);
    expect(await purgeExpiredEvidence(t.ctx, later)).toBe(0);
    expect((await Verification.findById(id))?.evidencePurgedAt).toBeUndefined();
  });

  it('removes evidence and cases when an account is erased, and exports only the decision summary', async () => {
    const t = setup();
    registerMemberDataHooks(t.ctx);
    const { m, id } = await submitted(t);
    const keys = Object.values((await Verification.findById(id))!.evidence as unknown as Record<string, { key: string }>).map((e) => e.key);

    const exp = await m.post('/account/export').expect(202);
    await buildExport(t.ctx, exp.body.id);
    const json = JSON.parse(readFileSync(path.join(t.env.EXPORT_DIR, `${exp.body.id}.json`), 'utf8'));
    expect(json.verification).toHaveLength(1);
    expect(json.verification[0]).toMatchObject({ method: 'manual', documentType: 'pan', documentLast4: '234F' });
    expect(JSON.stringify(json.verification)).not.toMatch(/identity\//);

    await m.post('/account/delete').send({ confirm: 'DELETE', password: PASSWORD }).expect(200);
    await User.updateOne({ _id: m.userId }, { $set: { deletionScheduledFor: new Date(Date.now() - 1000) } });
    expect(await purgeDueAccounts(t.ctx)).toBe(1);
    expect(keys.some((k) => t.storage.has('identity', k))).toBe(false);
    expect(await Verification.countDocuments({ userId: m.userId })).toBe(0);
  });
});

describe('automated KYC and liveness', () => {
  const GOOD = { confidence: 0.96, nameMatch: true, dobMatch: true, faceMatch: true, livenessPassed: true, docType: 'pan' as const, docLast4: '234F' };

  async function kycMember(t: T, email = 'k@example.com') {
    await FeatureFlag.updateOne({ key: 'kyc_automated' }, { $set: { enabled: true } }, { upsert: true });
    const m = await member(t, email);
    const res = await m.post('/verification/kyc/session').expect(201);
    const v = (await Verification.findOne({ userId: m.userId }))!;
    return { m, v, sessionId: v.provider!.sessionId!, redirectUrl: res.body.redirectUrl as string };
  }

  const deliver = async (t: T, eventId: string, sessionId: string, secret = 'test-webhook-secret') => {
    const body = JSON.stringify({ eventId, sessionId });
    return request(t.app)
      .post('/api/v1/webhooks/kyc')
      .set('Content-Type', 'application/json')
      .set('X-KYC-Signature', signWebhook(secret, body))
      .send(body);
  };

  it('is unavailable until the flag is on, and manual upload keeps working', async () => {
    const t = setup();
    const m = await member(t);
    const res = await m.post('/verification/kyc/session');
    expect(res.status).toBe(501);
    expect((await m.get('/verification/status')).body.kycAvailable).toBe(false);
    await uploadEvidence(t, m);
    await m.post('/verification/submit').send(SUBMIT).expect(200);
  });

  it('starts a session and reports automated verification as available', async () => {
    const t = setup();
    const { m, redirectUrl, v } = await kycMember(t);
    expect(redirectUrl).toContain('kyc.mock.invalid');
    expect(v.status).toBe('pending');
    expect(v.method).toBe('kyc');
    expect((await User.findById(m.userId))?.journeyState).toBe('verification_pending');
    expect((await m.get('/verification/status')).body.kycAvailable).toBe(true);
  });

  it('rejects unsigned or wrongly signed callbacks and stores nothing', async () => {
    const t = setup();
    const { sessionId } = await kycMember(t);
    const forged = await deliver(t, 'evt_bad', sessionId, 'wrong-secret');
    expect(forged.status).toBe(401);
    const unsigned = await request(t.app).post('/api/v1/webhooks/kyc').set('Content-Type', 'application/json').send({ eventId: 'x', sessionId });
    expect(unsigned.status).toBe(401);
    expect(await WebhookEvent.countDocuments()).toBe(0);
  });

  it('stores a signed callback once, even if the provider delivers it twice', async () => {
    const t = setup();
    const { sessionId } = await kycMember(t);
    await deliver(t, 'evt_1', sessionId).then((r) => expect(r.status).toBe(200));
    await deliver(t, 'evt_1', sessionId).then((r) => expect(r.status).toBe(200));
    expect(await WebhookEvent.countDocuments({ eventId: 'evt_1' })).toBe(1);
  });

  it('auto-approves a high-confidence result and records liveness', async () => {
    const t = setup();
    const { m, v, sessionId } = await kycMember(t);
    t.kyc.complete(sessionId, GOOD);
    await deliver(t, 'evt_ok', sessionId);
    await processKycEvent(t.ctx, 'evt_ok');

    const row = await Verification.findById(v._id);
    expect(row?.status).toBe('approved');
    expect(row?.decidedBy).toBe('provider');
    const user = await User.findById(m.userId);
    expect(user?.journeyState).toBe('matching_active');
    expect(user?.verification?.livenessVerifiedAt).toBeTruthy();

    // Processing the same event again changes nothing.
    await processKycEvent(t.ctx, 'evt_ok');
    expect(await AuditLog.countDocuments({ action: 'verification.auto_approved' })).toBe(1);
  });

  it('routes doubts to a person instead of rejecting', async () => {
    const t = setup();
    const { v, sessionId } = await kycMember(t);
    t.kyc.complete(sessionId, { ...GOOD, faceMatch: false });
    await deliver(t, 'evt_doubt', sessionId);
    await processKycEvent(t.ctx, 'evt_doubt');
    const row = await Verification.findById(v._id);
    expect(row?.status).toBe('in_review');
    expect(row?.manualReason).toBe('mismatch');

    // The verifier sees it in the same queue as manual cases.
    const verifier = await staff(t, ['verifier']);
    const queue = (await verifier.get('/admin/verification').expect(200)).body.items;
    expect(queue[0]).toMatchObject({ method: 'kyc', manualReason: 'mismatch' });
  });

  it('re-fetches the result itself and never trusts the callback body', async () => {
    const t = setup();
    const { v, sessionId } = await kycMember(t);
    // Callback claims success but the provider still says pending.
    const body = JSON.stringify({ eventId: 'evt_lie', sessionId, status: 'completed', confidence: 1 });
    await request(t.app)
      .post('/api/v1/webhooks/kyc')
      .set('Content-Type', 'application/json')
      .set('X-KYC-Signature', signWebhook('test-webhook-secret', body))
      .send(body)
      .expect(200);
    await processKycEvent(t.ctx, 'evt_lie');
    expect((await Verification.findById(v._id))?.status).toBe('pending');
  });

  it('keeps the member waiting through a provider outage, then falls back to manual review', async () => {
    const t = setup();
    const { m, v, sessionId } = await kycMember(t);
    t.kyc.sessions.delete(sessionId); // provider now errors for this session

    let now = new Date(Date.now() + 10 * 60_000);
    for (let i = 0; i < 5; i++) {
      await pollPendingKyc(t.ctx, now);
      expect((await Verification.findById(v._id))?.status).toBe('pending');
      now = new Date(now.getTime() + 6 * 60_000);
    }
    expect((await m.get('/verification/status')).body.state).toBe('pending'); // honest pending state

    await pollPendingKyc(t.ctx, now);
    const row = await Verification.findById(v._id);
    expect(row?.status).toBe('in_review');
    expect(row?.manualReason).toBe('provider_error');
  });

  it('polling completes a case whose callback never arrived', async () => {
    const t = setup();
    const { v, sessionId } = await kycMember(t);
    t.kyc.complete(sessionId, GOOD);
    await pollPendingKyc(t.ctx, new Date(Date.now() + 10 * 60_000));
    expect((await Verification.findById(v._id))?.status).toBe('approved');
  });
});

describe('circuit breaker', () => {
  it('opens after repeated provider failures, ignores caller mistakes, and probes again after the reset window', async () => {
    const b = new ProviderBreaker('test-provider', { volumeThreshold: 3, errorThresholdPercentage: 50, resetTimeoutMs: 150 });
    const down = async () => {
      throw new Error('down');
    };
    // A 4xx is the caller's mistake and does not count against the provider.
    for (let i = 0; i < 1; i++) await expect(b.run(async () => { throw Object.assign(new Error('bad request'), { status: 400 }); })).rejects.toThrow('bad request');
    expect(b.state).toBe('closed');

    for (let i = 0; i < 2; i++) await expect(b.run(down)).rejects.toThrow('down');
    expect(b.state).toBe('open');
    await expect(b.run(async () => 'ok')).rejects.toBeInstanceOf(CircuitOpenError);

    await new Promise((r) => setTimeout(r, 250));
    await expect(b.run(async () => 'ok')).resolves.toBe('ok');
    expect(b.state).toBe('closed');
    expect(breakerStates().map((s) => s.name)).toContain('test-provider');
    b.close();
  });

  it('wraps only the named adapter methods', async () => {
    const adapter = { name: 'x', async send(n: number) { return n * 2; }, sync() { return 'plain'; } };
    const wrapped = withBreaker('wrap-test', adapter, ['send'], { volumeThreshold: 2 })!;
    expect(await wrapped.send(4)).toBe(8);
    expect(wrapped.sync()).toBe('plain');
    expect(wrapped.name).toBe('x');
  });
});
