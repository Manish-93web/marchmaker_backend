import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { loadEnv } from '../src/config/env';
import { buildContext } from '../src/context';
import { createLogger } from '../src/lib/logger';
import { MemoryMailer } from '../src/lib/mailer';
import { hashPassword } from '../src/lib/passwords';
import { MemorySms } from '../src/lib/sms';
import { User } from '../src/models/core';

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
