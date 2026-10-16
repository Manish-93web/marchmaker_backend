import { existsSync, readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { strFromU8, unzipSync } from 'fflate';
import { generateSync } from 'otplib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { loadEnv } from '../src/config/env';
import { buildContext } from '../src/context';
import { buildExport, purgeDueAccounts } from '../src/jobs/accountJobs';
import { hashPassword } from '../src/lib/passwords';
import { MemoryMailer } from '../src/lib/mailer';
import { createLogger } from '../src/lib/logger';
import { MemorySms } from '../src/lib/sms';
import { Session, User } from '../src/models/core';
import { Photo } from '../src/models/profile';
import { DataRequest, LegalDocument, OtpCode } from '../src/models/auth';

let mongod: MongoMemoryServer;
const log = createLogger('silent');

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

function setup() {
  const env = loadEnv({
    NODE_ENV: 'test',
    EXPORT_DIR: mkdtempSync(path.join(tmpdir(), 'mm-export-')),
  } as NodeJS.ProcessEnv);
  const mailer = new MemoryMailer();
  const sms = new MemorySms();
  const ctx = buildContext({ env, log, mailer, sms });
  const app = createApp({ env, log, isReady: () => true, ctx });
  return { app, ctx, mailer, sms, env };
}

const dob = (yearsAgo: number) => {
  const n = new Date();
  return `${n.getUTCFullYear() - yearsAgo}-01-15`;
};
const PASSWORD = 'Sup3rSecretPass';

const body = (over: Record<string, unknown> = {}) => ({
  email: 'asha@example.com',
  password: PASSWORD,
  firstName: 'Asha',
  gender: 'woman',
  dob: dob(27),
  acceptTerms: true,
  ...over,
});

/** Pulls `token=...` out of the most recent email to an address. */
function tokenFrom(mailer: MemoryMailer, to: string): string {
  const m = mailer.last(to)?.text.match(/token=([A-Za-z0-9_-]+)/);
  if (!m?.[1]) throw new Error(`no token mail for ${to}`);
  return m[1];
}

function cookieValue(res: request.Response, name: string): string | undefined {
  const raw = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  const hit = raw.find((c) => c.startsWith(`${name}=`));
  return hit?.split(';')[0]?.slice(name.length + 1);
}

async function registerVerifyLogin(t: ReturnType<typeof setup>) {
  await request(t.app).post('/api/v1/auth/register').send(body()).expect(202);
  const token = tokenFrom(t.mailer, 'asha@example.com');
  await request(t.app).post('/api/v1/auth/verify-email').send({ token }).expect(200);
  const agent = request.agent(t.app);
  const res = await agent.post('/api/v1/auth/login').send({ email: 'asha@example.com', password: PASSWORD });
  expect(res.status).toBe(200);
  const csrf = cookieValue(res, 'mm_csrf')!;
  return { agent, csrf, res };
}

describe('registration and email verification', () => {
  it('registers, verifies the email link once, and moves the journey forward', async () => {
    const t = setup();
    const { agent } = await registerVerifyLogin(t);
    const me = await agent.get('/api/v1/auth/me').expect(200);
    expect(me.body).toMatchObject({
      email: 'asha@example.com',
      emailVerified: true,
      journeyState: 'email_verified',
      roles: ['member'],
    });
    expect(me.body.pendingLegal).toEqual([]);

    // The link is single-use.
    const token = tokenFrom(t.mailer, 'asha@example.com');
    await request(t.app).post('/api/v1/auth/verify-email').send({ token }).expect(400);
  });

  it('stores phone and date of birth encrypted, never in plain text', async () => {
    const t = setup();
    await request(t.app).post('/api/v1/auth/register').send(body({ phone: '+919876543210' })).expect(202);
    const raw = await User.collection.findOne({ email: 'asha@example.com' });
    expect(raw?.phoneEnc).toMatch(/^v1\./);
    expect(raw?.dobEnc).toMatch(/^v1\./);
    expect(JSON.stringify(raw)).not.toContain('9876543210');
    expect(raw?.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('does not reveal whether an email is already registered', async () => {
    const t = setup();
    const first = await request(t.app).post('/api/v1/auth/register').send(body());
    const second = await request(t.app).post('/api/v1/auth/register').send(body());
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
    expect(await User.countDocuments()).toBe(1);
    expect(t.mailer.last('asha@example.com')?.subject).toMatch(/already have/i);
  });

  it('enforces the age gate and password rules', async () => {
    const t = setup();
    const young = await request(t.app).post('/api/v1/auth/register').send(body({ dob: dob(17) }));
    expect(young.status).toBe(422);
    const weak = await request(t.app).post('/api/v1/auth/register').send(body({ password: 'short' }));
    expect(weak.status).toBe(422);
    const man = await request(t.app).post('/api/v1/auth/register').send(body({ gender: 'man', dob: dob(20) }));
    expect(man.status).toBe(422);
  });
});

describe('login, lockout and sessions', () => {
  it('gives the same error for an unknown email and a wrong password', async () => {
    const t = setup();
    await registerVerifyLogin(t);
    const wrong = await request(t.app).post('/api/v1/auth/login').send({ email: 'asha@example.com', password: 'Wrong-Password1' });
    const unknown = await request(t.app).post('/api/v1/auth/login').send({ email: 'nobody@example.com', password: 'Wrong-Password1' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it('locks the account after repeated failures even with the right password', async () => {
    const t = setup();
    await registerVerifyLogin(t);
    for (let i = 0; i < 5; i++) {
      await request(t.app).post('/api/v1/auth/login').send({ email: 'asha@example.com', password: 'Wrong-Password1' });
    }
    const res = await request(t.app).post('/api/v1/auth/login').send({ email: 'asha@example.com', password: PASSWORD });
    expect(res.status).toBe(401);
  });

  it('sets httpOnly cookies and lists/revokes sessions', async () => {
    const t = setup();
    const { agent, csrf, res } = await registerVerifyLogin(t);
    const set = res.headers['set-cookie'] as unknown as string[];
    const at = set.find((c) => c.startsWith('mm_at='))!;
    const rt = set.find((c) => c.startsWith('mm_rt='))!;
    const csrfCookie = set.find((c) => c.startsWith('mm_csrf='))!;
    expect(at).toMatch(/HttpOnly/i);
    expect(at).toMatch(/SameSite=Lax/i);
    expect(rt).toMatch(/HttpOnly/i);
    expect(rt).toMatch(/Path=\/api\/v1\/auth/i);
    expect(csrfCookie).not.toMatch(/HttpOnly/i); // must be readable by the SPA

    const list = await agent.get('/api/v1/auth/sessions').expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].current).toBe(true);

    await agent.post('/api/v1/auth/logout').set('x-csrf-token', csrf).expect(204);
    await agent.get('/api/v1/auth/me').expect(401);
  });

  it('logout-all revokes every device', async () => {
    const t = setup();
    const { agent, csrf } = await registerVerifyLogin(t);
    const other = request.agent(t.app);
    await other.post('/api/v1/auth/login').send({ email: 'asha@example.com', password: PASSWORD }).expect(200);
    await agent.post('/api/v1/auth/logout-all').set('x-csrf-token', csrf).expect(204);
    await other.get('/api/v1/auth/me').expect(401);
    expect(await Session.countDocuments({ revokedAt: null })).toBe(0);
  });
});

describe('refresh token rotation', () => {
  it('rotates, and revokes the whole family if an old token is replayed', async () => {
    const t = setup();
    const { res: loginRes, csrf } = await registerVerifyLogin(t);
    const oldRefresh = cookieValue(loginRes, 'mm_rt')!;

    const rotated = await request(t.app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', [`mm_rt=${oldRefresh}`, `mm_csrf=${csrf}`])
      .set('x-csrf-token', csrf)
      .send({});
    expect(rotated.status).toBe(200);
    const newRefresh = cookieValue(rotated, 'mm_rt')!;
    expect(newRefresh).not.toBe(oldRefresh);

    // Replay of the already-used token: rejected, and the new one dies with it.
    const replay = await request(t.app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', [`mm_rt=${oldRefresh}`, `mm_csrf=${csrf}`])
      .set('x-csrf-token', csrf)
      .send({});
    expect(replay.status).toBe(401);

    const afterReplay = await request(t.app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', [`mm_rt=${newRefresh}`, `mm_csrf=${csrf}`])
      .set('x-csrf-token', csrf)
      .send({});
    expect(afterReplay.status).toBe(401);
  });

  it('only one of two concurrent refreshes can win', async () => {
    const t = setup();
    const { res: loginRes, csrf } = await registerVerifyLogin(t);
    const rt = cookieValue(loginRes, 'mm_rt')!;
    const call = () =>
      request(t.app)
        .post('/api/v1/auth/refresh')
        .set('Cookie', [`mm_rt=${rt}`, `mm_csrf=${csrf}`])
        .set('x-csrf-token', csrf)
        .send({});
    const results = await Promise.all([call(), call()]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });
});

describe('csrf and origin protection', () => {
  it('rejects cookie-authenticated writes without the csrf header', async () => {
    const t = setup();
    const { agent, csrf } = await registerVerifyLogin(t);
    await agent.post('/api/v1/account/pause').expect(403);
    await agent.post('/api/v1/account/pause').set('x-csrf-token', 'wrong').expect(403);
    await agent.post('/api/v1/account/pause').set('x-csrf-token', csrf).expect(200);
  });

  it('rejects writes from a foreign origin', async () => {
    const t = setup();
    const res = await request(t.app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: 'a@b.co', password: 'x' });
    expect(res.status).toBe(403);
  });

  it('supports bearer tokens for mobile clients without csrf', async () => {
    const t = setup();
    await registerVerifyLogin(t);
    const res = await request(t.app)
      .post('/api/v1/auth/login')
      .send({ email: 'asha@example.com', password: PASSWORD, clientType: 'mobile' })
      .expect(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    const { accessToken, refreshToken } = res.body.tokens;
    await request(t.app).get('/api/v1/auth/me').set('Authorization', `Bearer ${accessToken}`).expect(200);
    await request(t.app).post('/api/v1/account/pause').set('Authorization', `Bearer ${accessToken}`).expect(200);
    const refreshed = await request(t.app).post('/api/v1/auth/refresh').send({ refreshToken }).expect(200);
    expect(refreshed.body.tokens.refreshToken).not.toBe(refreshToken);
  });
});

describe('password reset', () => {
  it('is single-use, expires sessions, and never confirms unknown emails', async () => {
    const t = setup();
    const { agent } = await registerVerifyLogin(t);

    const unknown = await request(t.app).post('/api/v1/auth/password/forgot').send({ email: 'ghost@example.com' });
    expect(unknown.status).toBe(202);
    expect(t.mailer.last('ghost@example.com')).toBeUndefined();

    await request(t.app).post('/api/v1/auth/password/forgot').send({ email: 'asha@example.com' }).expect(202);
    const token = tokenFrom(t.mailer, 'asha@example.com');
    const newPassword = 'Brand-New-Passw0rd';
    await request(t.app).post('/api/v1/auth/password/reset').send({ token, password: newPassword }).expect(200);
    await request(t.app).post('/api/v1/auth/password/reset').send({ token, password: 'Another-Passw0rd1' }).expect(400);

    await agent.get('/api/v1/auth/me').expect(401); // old session revoked
    await request(t.app).post('/api/v1/auth/login').send({ email: 'asha@example.com', password: PASSWORD }).expect(401);
    await request(t.app).post('/api/v1/auth/login').send({ email: 'asha@example.com', password: newPassword }).expect(200);
  });
});

describe('phone OTP', () => {
  const phone = '+919876543210';

  it('signs up with a phone number only and logs in with the code', async () => {
    const t = setup();
    await request(t.app)
      .post('/api/v1/auth/register')
      .send({ phone, firstName: 'Ravi', gender: 'man', dob: dob(30), acceptTerms: true })
      .expect(202);
    const code = t.sms.last(phone)!.body.slice(0, 6);
    const res = await request(t.app).post('/api/v1/auth/otp/verify').send({ target: phone, purpose: 'login', code });
    expect(res.status).toBe(200);
    expect(cookieValue(res, 'mm_at')).toBeTruthy();
    const user = await User.findOne({ phoneVerifiedAt: { $exists: true } });
    expect(user?.journeyState).toBe('email_verified');
  });

  it('blocks a code after five wrong attempts and enforces the resend cooldown', async () => {
    const t = setup();
    await request(t.app).post('/api/v1/auth/register').send({ phone, firstName: 'Ravi', gender: 'man', dob: dob(30), acceptTerms: true });
    const code = t.sms.last(phone)!.body.slice(0, 6);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      await request(t.app).post('/api/v1/auth/otp/verify').send({ target: phone, purpose: 'login', code: wrong }).expect(400);
    }
    await request(t.app).post('/api/v1/auth/otp/verify').send({ target: phone, purpose: 'login', code }).expect(400);

    const before = t.sms.sent.length;
    await request(t.app).post('/api/v1/auth/otp/request').send({ target: phone, purpose: 'login' }).expect(202);
    expect(t.sms.sent.length).toBe(before); // still inside the 60s cooldown
    expect(await OtpCode.countDocuments({ target: phone })).toBe(1);
  });

  it('stays silent for numbers without an account', async () => {
    const t = setup();
    const res = await request(t.app).post('/api/v1/auth/otp/request').send({ target: '+919000000001', purpose: 'login' });
    expect(res.status).toBe(202);
    expect(t.sms.sent).toHaveLength(0);
  });
});

describe('account lifecycle', () => {
  it('pauses and resumes', async () => {
    const t = setup();
    const { agent, csrf } = await registerVerifyLogin(t);
    await agent.post('/api/v1/account/pause').set('x-csrf-token', csrf).expect(200);
    expect((await agent.get('/api/v1/auth/me')).body.status).toBe('paused');
    await agent.post('/api/v1/account/resume').set('x-csrf-token', csrf).expect(200);
    expect((await agent.get('/api/v1/auth/me')).body.status).toBe('active');
  });

  it('schedules deletion with a 14 day grace, restores, then hard-deletes after the window', async () => {
    const t = setup();
    const { agent, csrf } = await registerVerifyLogin(t);

    await agent.post('/api/v1/account/delete').set('x-csrf-token', csrf).send({ confirm: 'DELETE', password: 'wrong-password' }).expect(400);
    const del = await agent.post('/api/v1/account/delete').set('x-csrf-token', csrf).send({ confirm: 'DELETE', password: PASSWORD }).expect(200);
    const days = (new Date(del.body.purgeAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);

    // Sign in again and restore inside the grace period.
    const again = request.agent(t.app);
    const login = await again.post('/api/v1/auth/login').send({ email: 'asha@example.com', password: PASSWORD }).expect(200);
    const csrf2 = cookieValue(login, 'mm_csrf')!;
    expect((await again.get('/api/v1/auth/me')).body.status).toBe('deletion_scheduled');
    await again.post('/api/v1/account/restore').set('x-csrf-token', csrf2).expect(200);
    expect((await again.get('/api/v1/auth/me')).body.status).toBe('active');

    // Schedule again, let the window pass, and run the purge job.
    await again.post('/api/v1/account/delete').set('x-csrf-token', csrf2).send({ confirm: 'DELETE', password: PASSWORD }).expect(200);
    await User.updateOne({ email: 'asha@example.com' }, { $set: { deletionScheduledFor: new Date(Date.now() - 1000) } });
    expect(await purgeDueAccounts(t.ctx)).toBe(1);
    expect(await User.countDocuments()).toBe(0);
    expect(await Session.countDocuments()).toBe(0);
    expect(t.mailer.last('asha@example.com')?.subject).toMatch(/deleted/i);
  });

  it('exports member data asynchronously and serves it only through a valid signed link', async () => {
    const t = setup();
    const { agent, csrf } = await registerVerifyLogin(t);
    const reqRes = await agent.post('/api/v1/account/export').set('x-csrf-token', csrf).expect(202);
    await agent.post('/api/v1/account/export').set('x-csrf-token', csrf).expect(429);

    await buildExport(t.ctx, reqRes.body.id);
    const dr = await DataRequest.findById(reqRes.body.id);
    expect(dr?.status).toBe('ready');
    expect(existsSync(path.join(t.env.EXPORT_DIR, `${reqRes.body.id}.json`))).toBe(true);

    const link = t.mailer.last('asha@example.com')!.text.match(/https?:\/\/\S+download\?exp=\d+&sig=[a-f0-9]+/)![0];
    const url = new URL(link);
    const ok = await request(t.app)
      .get(`${url.pathname}${url.search}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(ok.headers['content-type']).toContain('application/zip');
    const data = JSON.parse(strFromU8(unzipSync(new Uint8Array(ok.body as Buffer))['data.json']!));
    expect(data.account.email).toBe('asha@example.com');
    expect(data.account.dateOfBirth).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(JSON.stringify(data)).not.toContain('passwordHash');

    await request(t.app).get(`${url.pathname}?exp=${url.searchParams.get('exp')}&sig=deadbeef`).expect(400);
  });

  it('includes the members own photos in the export zip', async () => {
    const t = setup();
    const { agent, csrf } = await registerVerifyLogin(t);
    const u = await User.findOne({ email: 'asha@example.com' });
    await t.ctx.storage.put('photos', 'p/lg1.jpg', Buffer.from('jpegbytes'), 'image/jpeg');
    await Photo.create({ userId: u!._id, key: 'raw/1', status: 'approved', variants: { lg: 'p/lg1.jpg' }, order: 0 });
    const r = await agent.post('/api/v1/account/export').set('x-csrf-token', csrf).expect(202);
    await buildExport(t.ctx, r.body.id);
    const zip = unzipSync(new Uint8Array(readFileSync(path.join(t.env.EXPORT_DIR, `${r.body.id}.zip`))));
    expect(Object.keys(zip)).toEqual(expect.arrayContaining(['data.json', 'photos/photo-1.jpg']));
    expect(strFromU8(zip['photos/photo-1.jpg']!)).toBe('jpegbytes');
  });

  it('changes password only with the current one and signs out other devices', async () => {
    const t = setup();
    const { agent, csrf } = await registerVerifyLogin(t);
    const other = request.agent(t.app);
    await other.post('/api/v1/auth/login').send({ email: 'asha@example.com', password: PASSWORD }).expect(200);

    await agent.patch('/api/v1/account').set('x-csrf-token', csrf).send({ newPassword: 'Newer-Passw0rd9' }).expect(422);
    await agent.patch('/api/v1/account').set('x-csrf-token', csrf).send({ currentPassword: 'nope-Nope-1', newPassword: 'Newer-Passw0rd9' }).expect(400);
    await agent.patch('/api/v1/account').set('x-csrf-token', csrf).send({ currentPassword: PASSWORD, newPassword: 'Newer-Passw0rd9' }).expect(200);
    await agent.get('/api/v1/auth/me').expect(200);
    await other.get('/api/v1/auth/me').expect(401);
  });
});

describe('consents and legal documents', () => {
  it('serves the latest effective version and forces re-acceptance on material changes', async () => {
    const t = setup();
    // Published before sign-up, as in production.
    await LegalDocument.create({ type: 'terms', version: '1.0', title: 'Terms of Service', effectiveDate: new Date('2026-01-01'), markdown: '# Terms v1' });
    await LegalDocument.create({ type: 'privacy', version: '1.0', title: 'Privacy Policy', effectiveDate: new Date('2026-01-01'), markdown: '# Privacy v1' });

    const { agent, csrf } = await registerVerifyLogin(t);
    expect((await request(t.app).get('/api/v1/legal/terms').expect(200)).body.version).toBe('1.0');
    expect((await agent.get('/api/v1/auth/me')).body.pendingLegal).toEqual([]);

    await LegalDocument.create({ type: 'terms', version: '2.0', title: 'Terms of Service', effectiveDate: new Date('2026-06-01'), markdown: '# Terms v2' });
    const me = await agent.get('/api/v1/auth/me');
    expect(me.body.pendingLegal).toEqual([{ type: 'terms', version: '2.0', title: 'Terms of Service' }]);

    await agent.post('/api/v1/account/consents').set('x-csrf-token', csrf).send({ purpose: 'terms', granted: true }).expect(201);
    expect((await agent.get('/api/v1/auth/me')).body.pendingLegal).toEqual([]);

    await agent.post('/api/v1/account/consents').set('x-csrf-token', csrf).send({ purpose: 'terms', granted: false }).expect(400);
    await agent.post('/api/v1/account/consents').set('x-csrf-token', csrf).send({ purpose: 'analytics', granted: true }).expect(201);
    const hist = await agent.get('/api/v1/account/consents').expect(200);
    expect(hist.body.items.map((c: { purpose: string }) => c.purpose)).toContain('analytics');
  });

  it('returns 404 for unknown legal types', async () => {
    const t = setup();
    await request(t.app).get('/api/v1/legal/nonsense').expect(404);
  });
});

describe('staff two-factor authentication', () => {
  async function createStaff(t: ReturnType<typeof setup>) {
    await User.create({
      email: 'ops@example.com',
      passwordHash: await hashPassword('Sup3rSecretPass'),
      firstName: 'Ops',
      gender: 'woman',
      dobEnc: t.ctx.crypto.encrypt('1990-01-01'),
      roles: ['super_admin'],
      emailVerifiedAt: new Date(),
    });
  }

  it('requires TOTP setup, then demands a code at every login', async () => {
    const t = setup();
    await createStaff(t);
    const agent = request.agent(t.app);
    const login = await agent.post('/api/v1/auth/login').send({ email: 'ops@example.com', password: PASSWORD }).expect(200);
    expect(login.body).toMatchObject({ requiresTotpSetup: true, mfa: false });
    const csrf = cookieValue(login, 'mm_csrf')!;

    const setupRes = await agent.post('/api/v1/auth/2fa/setup').set('x-csrf-token', csrf).expect(200);
    expect(setupRes.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    await agent.post('/api/v1/auth/2fa/confirm').set('x-csrf-token', csrf).send({ code: '000000' }).expect(400);

    const code = generateSync({ secret: setupRes.body.secret });
    const confirm = await agent.post('/api/v1/auth/2fa/confirm').set('x-csrf-token', csrf).send({ code }).expect(200);
    expect(confirm.body.enabled).toBe(true);
    expect((await agent.get('/api/v1/auth/me')).body).toMatchObject({ mfa: true, twoFactorEnabled: true });

    const noCode = await request(t.app).post('/api/v1/auth/login').send({ email: 'ops@example.com', password: PASSWORD });
    expect(noCode.status).toBe(401);
    expect(noCode.body.error.code).toBe('TOTP_REQUIRED');
    const wrong = await request(t.app).post('/api/v1/auth/login').send({ email: 'ops@example.com', password: PASSWORD, totp: '123456' });
    expect(wrong.status).toBe(401);
    const good = await request(t.app)
      .post('/api/v1/auth/login')
      .send({ email: 'ops@example.com', password: PASSWORD, totp: generateSync({ secret: setupRes.body.secret, epoch: Math.floor(Date.now() / 1000) + 30 }) });
    expect(good.status).toBe(200);
    // The code that confirmed set-up cannot be replayed to sign in.
    const replay = await request(t.app).post('/api/v1/auth/login').send({ email: 'ops@example.com', password: PASSWORD, totp: code });
    expect(replay.status).toBe(401);
    expect(good.body.mfa).toBe(true);
  });

  it('gives staff shorter sessions: idle timeout ends the session', async () => {
    const t = setup();
    await createStaff(t);
    const agent = request.agent(t.app);
    await agent.post('/api/v1/auth/login').send({ email: 'ops@example.com', password: PASSWORD }).expect(200);
    await agent.get('/api/v1/auth/me').expect(200);
    await Session.updateMany({}, { $set: { lastSeenAt: new Date(Date.now() - 31 * 60_000) } });
    await agent.get('/api/v1/auth/me').expect(401);
  });

  it('does not let staff sign in with a phone code', async () => {
    const t = setup();
    await User.create({
      email: 'ops2@example.com',
      phoneHash: t.ctx.crypto.blindIndex('+919811111111'),
      firstName: 'Ops',
      gender: 'man',
      dobEnc: t.ctx.crypto.encrypt('1990-01-01'),
      roles: ['admin'],
    });
    await request(t.app).post('/api/v1/auth/otp/request').send({ target: '+919811111111', purpose: 'login' }).expect(202);
    const code = t.sms.last('+919811111111')!.body.slice(0, 6);
    await request(t.app).post('/api/v1/auth/otp/verify').send({ target: '+919811111111', purpose: 'login', code }).expect(403);
  });
});
