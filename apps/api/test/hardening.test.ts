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
import { memoryAttemptLimiter, redisAttemptLimiter, type RedisLike } from '../src/lib/attemptLimiter';
import { createLogger } from '../src/lib/logger';
import { MemoryMailer } from '../src/lib/mailer';
import { hashPassword } from '../src/lib/passwords';
import { MemorySms } from '../src/lib/sms';
import { AuditLog, User } from '../src/models/core';

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
  const env = loadEnv({ NODE_ENV: 'test', EXPORT_DIR: mkdtempSync(path.join(tmpdir(), 'mm-hard-')) } as NodeJS.ProcessEnv);
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
async function staffUser(t: T, role: Role = 'admin') {
  n++;
  const email = `hard${n}@example.com`;
  await User.create({
    email,
    passwordHash: await hashPassword(PASSWORD),
    firstName: 'Sam',
    gender: 'man',
    dobEnc: t.ctx.crypto.encrypt('1990-01-01'),
    dobYear: 1990,
    roles: [role],
    emailVerifiedAt: new Date(),
  });
  return email;
}

/** Signs in, sets up two-factor and returns the secret plus the one-time recovery codes. */
async function enroll(t: T) {
  const email = await staffUser(t);
  const agent = request.agent(t.app);
  const login = await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
  const csrf = csrfOf(login);
  const s = await agent.post('/api/v1/auth/2fa/setup').set('x-csrf-token', csrf).expect(200);
  const secret = String(s.body.secret);
  const c = await agent.post('/api/v1/auth/2fa/confirm').set('x-csrf-token', csrf).send({ code: generateSync({ secret }) }).expect(200);
  return { email, secret, agent, csrf: csrfOf(c), recoveryCodes: c.body.recoveryCodes as string[], confirmCode: generateSync({ secret }) };
}

// A code from the next 30 second step: valid (the server allows one step of drift) but never seen before.
const nextCode = (secret: string, steps = 1) => generateSync({ secret, epoch: Math.floor(Date.now() / 1000) + 30 * steps });

describe('two-factor recovery codes', () => {
  it('shows ten codes once at enrolment and keeps only hashes', async () => {
    const t = setup();
    const e = await enroll(t);
    expect(e.recoveryCodes).toHaveLength(10);
    expect(new Set(e.recoveryCodes).size).toBe(10);
    for (const c of e.recoveryCodes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    const stored = JSON.stringify(await User.findOne({ email: e.email }).select('+twoFactor.recoveryHashes').lean());
    for (const c of e.recoveryCodes) expect(stored).not.toContain(c.replace('-', ''));
    expect((await e.agent.get('/api/v1/auth/2fa/recovery-codes').expect(200)).body.remaining).toBe(10);
  });

  it('signs in with a recovery code exactly once, tells the person, and counts them down', async () => {
    const t = setup();
    const e = await enroll(t);
    const login = (code: string) => request(t.app).post('/api/v1/auth/login').send({ email: e.email, password: PASSWORD, recoveryCode: code });
    await login(e.recoveryCodes[0]!).expect(200);
    await login(e.recoveryCodes[0]!).expect(401); // already used
    // Lower case and no dash are accepted: people type these from paper.
    await login(e.recoveryCodes[1]!.replace('-', '').toLowerCase()).expect(200);
    await login('AAAAA-BBBBB').expect(401);
    expect((await e.agent.get('/api/v1/auth/2fa/recovery-codes').expect(200)).body.remaining).toBe(8);
    expect(t.mailer.sent.some((m) => m.subject === 'A recovery code was used to sign in')).toBe(true);
    expect(await AuditLog.countDocuments({ action: 'auth.recovery_code_used' })).toBe(2);
  });

  it('lets only one of two simultaneous logins use the same code', async () => {
    const t = setup();
    const e = await enroll(t);
    const code = e.recoveryCodes[2]!;
    const results = await Promise.all(
      [1, 2, 3].map(() => request(t.app).post('/api/v1/auth/login').send({ email: e.email, password: PASSWORD, recoveryCode: code })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it('replaces the codes only with a fresh authenticator code, and the old ones stop working', async () => {
    const t = setup();
    const e = await enroll(t);
    await e.agent.post('/api/v1/auth/2fa/recovery-codes').set('x-csrf-token', e.csrf).send({ code: '000000' }).expect(401);
    const fresh = (await e.agent.post('/api/v1/auth/2fa/recovery-codes').set('x-csrf-token', e.csrf).send({ code: nextCode(e.secret) }).expect(200)).body.recoveryCodes as string[];
    expect(fresh).toHaveLength(10);
    await request(t.app).post('/api/v1/auth/login').send({ email: e.email, password: PASSWORD, recoveryCode: e.recoveryCodes[0] }).expect(401);
    await request(t.app).post('/api/v1/auth/login').send({ email: e.email, password: PASSWORD, recoveryCode: fresh[0] }).expect(200);
  });

  it('does not accept a recovery code without the password', async () => {
    const t = setup();
    const e = await enroll(t);
    await request(t.app).post('/api/v1/auth/login').send({ email: e.email, password: 'wrong-password-1', recoveryCode: e.recoveryCodes[0] }).expect(401);
    expect((await e.agent.get('/api/v1/auth/2fa/recovery-codes').expect(200)).body.remaining).toBe(10);
  });
});

describe('staff two-factor reset', () => {
  it('lets a super admin reset someone who lost their phone and codes; they must enrol again', async () => {
    const t = setup();
    const lost = await enroll(t); // an admin with 2FA on
    // A super admin (with their own 2FA) does the reset.
    n++;
    const bossEmail = `boss${n}@example.com`;
    await User.create({
      email: bossEmail,
      passwordHash: await hashPassword(PASSWORD),
      firstName: 'Boss',
      gender: 'man',
      dobEnc: t.ctx.crypto.encrypt('1980-01-01'),
      dobYear: 1980,
      roles: ['super_admin'],
      emailVerifiedAt: new Date(),
    });
    const boss = request.agent(t.app);
    const login = await boss.post('/api/v1/auth/login').send({ email: bossEmail, password: PASSWORD }).expect(200);
    const s1 = await boss.post('/api/v1/auth/2fa/setup').set('x-csrf-token', csrfOf(login)).expect(200);
    const c1 = await boss.post('/api/v1/auth/2fa/confirm').set('x-csrf-token', csrfOf(login)).send({ code: generateSync({ secret: String(s1.body.secret) }) }).expect(200);
    const csrf = csrfOf(c1);

    const target = String((await User.findOne({ email: lost.email }).lean())!._id);
    await boss.post(`/api/v1/admin/staff/${target}/reset-2fa`).set('x-csrf-token', csrf).expect(200);

    // Their old session is gone and neither the old code nor a recovery code works any more.
    await lost.agent.get('/api/v1/auth/me').expect(401);
    const again = await request(t.app).post('/api/v1/auth/login').send({ email: lost.email, password: PASSWORD, recoveryCode: lost.recoveryCodes[0] });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ requiresTotpSetup: true, mfa: false });
    expect(t.mailer.sent.some((m) => m.to === lost.email && m.subject === 'Your two-factor sign-in was reset')).toBe(true);
    expect(await AuditLog.countDocuments({ action: 'staff.two_factor_reset', subjectId: target })).toBe(1);

    // Nobody can reset themselves this way.
    const self = String((await User.findOne({ email: bossEmail }).lean())!._id);
    await boss.post(`/api/v1/admin/staff/${self}/reset-2fa`).set('x-csrf-token', csrf).expect(409);
  });
});

describe('authenticator code replay', () => {
  it('refuses a code that was just used, even though it is still valid', async () => {
    const t = setup();
    const e = await enroll(t);
    const code = nextCode(e.secret);
    const login = (totp: string) => request(t.app).post('/api/v1/auth/login').send({ email: e.email, password: PASSWORD, totp });
    await login(code).expect(200);
    await login(code).expect(401); // same code a moment later
    // The code used to confirm enrolment cannot be used again either.
    await login(e.confirmCode).expect(401);
  });
});

describe('input hardening', () => {
  it('rejects operator injection in credentials without a server error', async () => {
    const t = setup();
    const res = await request(t.app).post('/api/v1/auth/login').send({ email: { $gt: '' }, password: { $ne: null } });
    expect([400, 401, 422]).toContain(res.status);
    const res2 = await request(t.app).post('/api/v1/auth/login').send({ email: 'a@b.co', password: 'x', '$where': 'sleep(1000)' });
    expect(res2.status).toBeLessThan(500);
  });

  it('sends the security headers and hides the framework', async () => {
    const t = setup();
    const res = await request(t.app).get('/api/v1/meta');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['strict-transport-security']).toBeDefined();
  });

  it('does not leak internals in an error', async () => {
    const t = setup();
    const res = await request(t.app).post('/api/v1/auth/login').set('content-type', 'application/json').send('{ not json');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/stack|node_modules|SyntaxError/);
  });

  it('refuses an oversized body', async () => {
    const t = setup();
    const res = await request(t.app).post('/api/v1/auth/login').send({ email: 'a@b.co', password: 'x'.repeat(200_000) });
    expect(res.status).toBe(413);
  });
});

describe('shared rate limiting', () => {
  const fakeRedis = () => {
    const store = new Map<string, number>();
    const ttl = new Map<string, number>();
    let down = false;
    const client: RedisLike = {
      async incr(k) {
        if (down) throw new Error('redis down');
        store.set(k, (store.get(k) ?? 0) + 1);
        return store.get(k)!;
      },
      async pexpire(k, ms) {
        ttl.set(k, ms);
      },
      async del(k) {
        store.delete(k);
      },
    };
    return { client, store, ttl, setDown: (v: boolean) => (down = v) };
  };

  it('counts across limiter instances, as separate API servers would', async () => {
    const r = fakeRedis();
    const a = redisAttemptLimiter(r.client, 'rl:login', 3, 60_000);
    const b = redisAttemptLimiter(r.client, 'rl:login', 3, 60_000);
    expect(await a.hit('k')).toBe(true);
    expect(await b.hit('k')).toBe(true);
    expect(await a.hit('k')).toBe(true);
    expect(await b.hit('k')).toBe(false); // the fourth attempt, from the other server
    expect(r.ttl.get('rl:login:k')).toBe(60_000);
    await a.reset('k');
    expect(await b.hit('k')).toBe(true);
  });

  it('keeps protecting, per server, if Redis goes away', async () => {
    const r = fakeRedis();
    const errors: unknown[] = [];
    const l = redisAttemptLimiter(r.client, 'x', 2, 60_000, (e) => errors.push(e));
    r.setDown(true);
    expect(await l.hit('k')).toBe(true);
    expect(await l.hit('k')).toBe(true);
    expect(await l.hit('k')).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('memory limiter still behaves', () => {
    let t = 0;
    const l = memoryAttemptLimiter(2, 1000, () => t);
    expect([l.hit('k'), l.hit('k'), l.hit('k')]).toEqual([true, true, false]);
    t = 1001;
    expect(l.hit('k')).toBe(true);
  });
});

describe('production configuration guard', () => {
  const good = {
    NODE_ENV: 'production',
    JWT_ACCESS_SECRET: 'a'.repeat(40),
    JWT_REFRESH_SECRET: 'b'.repeat(40),
    COOKIE_SECURE: 'true',
    FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    EMAIL_PROVIDER: 'smtp',
    SMS_PROVIDER: 'msg91',
    MSG91_AUTH_KEY: 'key',
    MSG91_OTP_TEMPLATE_ID: 'tpl',
    STORAGE_PROVIDER: 's3',
    KYC_PROVIDER: 'none',
    PAYMENTS_PROVIDER: 'razorpay',
    RAZORPAY_KEY_ID: 'id',
    RAZORPAY_KEY_SECRET: 'secret',
    RAZORPAY_WEBHOOK_SECRET: 'real-webhook-secret',
    CALLS_PROVIDER: 'none',
    ASTROLOGY_PROVIDER: 'none',
    WHATSAPP_PROVIDER: 'none',
    PUSH_PROVIDER: 'none',
    REDIS_URL: 'redis://redis:6379',
    APP_URL: 'https://app.example.com',
    ADMIN_URL: 'https://admin.example.com',
    CORS_ORIGINS: 'https://app.example.com,https://admin.example.com',
  } as unknown as NodeJS.ProcessEnv;

  it('accepts a complete production setup', () => {
    expect(() => loadEnv(good)).not.toThrow();
  });

  it.each([
    ['the development encryption key', { FIELD_ENCRYPTION_KEY: 'ZGV2LW9ubHktZmllbGQtZW5jcnlwdGlvbi1rZXktMzI=' }, /development key/],
    ['mock email', { EMAIL_PROVIDER: 'mock' }, /never send email/],
    ['mock SMS', { SMS_PROVIDER: 'mock' }, /OTP/],
    ['in-memory storage', { STORAGE_PROVIDER: 'memory' }, /lose every upload/],
    ['a mock KYC provider', { KYC_PROVIDER: 'mock' }, /KYC_PROVIDER=mock/],
    ['no Redis', { REDIS_URL: '' }, /REDIS_URL/],
    ['an http origin', { CORS_ORIGINS: 'http://app.example.com' }, /https/],
    ['an http app url', { APP_URL: 'http://app.example.com' }, /https/],
    ['insecure cookies', { COOKIE_SECURE: 'false' }, /COOKIE_SECURE/],
  ])('refuses %s', (_name, over, message) => {
    const env = { ...good, ...over } as NodeJS.ProcessEnv;
    if (env.REDIS_URL === '') delete env.REDIS_URL;
    expect(() => loadEnv(env)).toThrow(message);
  });
});
