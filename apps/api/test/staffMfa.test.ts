import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { loadEnv, staffMfaBypass } from '../src/config/env';
import { buildContext } from '../src/context';
import { createLogger } from '../src/lib/logger';
import { MemoryMailer } from '../src/lib/mailer';
import { hashPassword } from '../src/lib/passwords';
import { MemorySms } from '../src/lib/sms';
import { Session, User } from '../src/models/core';
import { login } from '../src/services/auth';

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

function app(extra: Record<string, string> = {}) {
  const log = createLogger('silent');
  const env = loadEnv({ NODE_ENV: 'test', ...extra } as NodeJS.ProcessEnv);
  return createApp({ env, log, isReady: () => true, ctx: buildContext({ env, log, mailer: new MemoryMailer(), sms: new MemorySms() }) });
}
const body = { email: 'admin@example.com', password: 'Admin@12345', clientType: 'mobile' };

describe('staff authenticator code', () => {
  it('is required by default, and can be switched off only for development', async () => {
    await User.create({ email: 'admin@example.com', passwordHash: await hashPassword('Admin@12345'), firstName: 'Admin', gender: 'non_binary', dobEnc: 'x', roles: ['super_admin'], emailVerifiedAt: new Date() });
    const on = await request(app()).post('/api/v1/auth/login').send(body);
    expect(on.status).toBe(200);
    expect(on.body.mfa).toBe(false);
    expect(on.body.requiresTotpSetup).toBe(true);

    const off = await request(app({ STAFF_MFA_REQUIRED: 'false' })).post('/api/v1/auth/login').send(body);
    expect(off.status).toBe(200);
    expect(off.body.mfa).toBe(true);
    expect(off.body.requiresTotpSetup).toBe(false);
    const me = await request(app({ STAFF_MFA_REQUIRED: 'false' })).get('/api/v1/admin/overview').set('Authorization', `Bearer ${off.body.tokens.accessToken}`);
    expect(me.status).not.toBe(403);
  });

  it('is refused in production', () => {
    expect(() => loadEnv({ NODE_ENV: 'production', STAFF_MFA_REQUIRED: 'false' } as NodeJS.ProcessEnv)).toThrow(/STAFF_MFA_REQUIRED|Refusing|development/);
  });
});

describe('temporary production switch for the staff authenticator code', () => {
  const DAY = 86_400_000;
  const iso = (days: number) => new Date(Date.now() + days * DAY).toISOString();
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
    SENTRY_DSN: 'https://public@o0.ingest.sentry.io/1',
    APP_URL: 'https://app.example.com',
    ADMIN_URL: 'https://admin.example.com',
    CORS_ORIGINS: 'https://app.example.com,https://admin.example.com',
  };
  const prod = (extra: Record<string, string>) => loadEnv({ ...good, ...extra } as unknown as NodeJS.ProcessEnv);

  it('is refused without an end date, with a date too far away, or with a date in the past', () => {
    expect(() => prod({ STAFF_MFA_REQUIRED: 'false' })).toThrow(/STAFF_MFA_OFF_UNTIL/);
    expect(() => prod({ STAFF_MFA_REQUIRED: 'false', STAFF_MFA_OFF_UNTIL: iso(30) })).toThrow(/STAFF_MFA_OFF_UNTIL/);
    expect(() => prod({ STAFF_MFA_REQUIRED: 'false', STAFF_MFA_OFF_UNTIL: iso(-1) })).toThrow(/STAFF_MFA_OFF_UNTIL/);
    expect(() => prod({ STAFF_MFA_REQUIRED: 'false', STAFF_MFA_OFF_UNTIL: 'not-a-date' })).toThrow(/STAFF_MFA_OFF_UNTIL/);
  });

  it('is accepted with an end date within 14 days, and is active only until then', () => {
    const env = prod({ STAFF_MFA_REQUIRED: 'false', STAFF_MFA_OFF_UNTIL: iso(5) });
    const now = new Date();
    expect(staffMfaBypass(env, now).active).toBe(true);
    expect(staffMfaBypass(env, now).until?.getTime()).toBeGreaterThan(now.getTime());
    expect(staffMfaBypass(env, new Date(Date.now() + 6 * DAY)).active).toBe(false); // after the deadline
    expect(staffMfaBypass(prod({}), now).active).toBe(false); // the code stays required by default
  });

  it('signs a super admin in without a code, and ends that session at the deadline', async () => {
    const until = iso(3);
    const log = createLogger('silent');
    const base = loadEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    const ctx = buildContext({ env: base, log, mailer: new MemoryMailer(), sms: new MemorySms() });
    const prodCtx = { ...ctx, env: { ...base, NODE_ENV: 'production' as const, STAFF_MFA_REQUIRED: false, STAFF_MFA_OFF_UNTIL: until } };
    await User.updateOne({ email: 'admin@example.com' }, { $set: { failedLoginCount: 0 }, $unset: { lockedUntil: 1 } });
    const result = await login(prodCtx, { email: 'admin@example.com', password: 'Admin@12345' }, {});
    expect(result.mfa).toBe(true);
    expect(result.requiresTotpSetup).toBe(false);
    const s = await Session.findOne({ userId: result.userId }).sort({ createdAt: -1 });
    expect(s?.absoluteExpiresAt?.toISOString()).toBe(new Date(until).toISOString());
  });
});
