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

describe('member and admin sign-ins on one browser', () => {
  it('keep separate cookies, so signing in to the console does not replace the member', async () => {
    const log = createLogger('silent');
    const env = loadEnv({ NODE_ENV: 'test', STAFF_MFA_REQUIRED: 'false' } as NodeJS.ProcessEnv);
    const app = createApp({ env, log, isReady: () => true, ctx: buildContext({ env, log, mailer: new MemoryMailer(), sms: new MemorySms() }) });
    const common = { gender: 'woman' as const, dobEnc: 'x', dobYear: 1995, emailVerifiedAt: new Date(), passwordHash: await hashPassword('Passw0rd!long') };
    await User.create({ ...common, email: 'member@example.com', firstName: 'Meera', roles: ['member'] });
    await User.create({ ...common, email: 'admin@example.com', firstName: 'Admin', roles: ['super_admin'] });
    const body = (email: string) => ({ email, password: 'Passw0rd!long' });

    // One browser's cookie jar, filled by both sites.
    const jar: Record<string, string> = {};
    const take = (res: request.Response) => {
      for (const c of (res.headers['set-cookie'] ?? []) as unknown as string[]) {
        const [pair] = c.split(';');
        const [k, v] = pair!.split('=');
        jar[k!] = v!;
      }
    };
    const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

    take(await request(app).post('/api/v1/auth/login').send(body('member@example.com')));
    take(await request(app).post('/api/v1/auth/login').set('X-App', 'admin').send(body('admin@example.com')));
    expect(Object.keys(jar)).toEqual(expect.arrayContaining(['mm_at', 'mm_staff_at']));

    const member = await request(app).get('/api/v1/auth/me').set('Cookie', cookie());
    const admin = await request(app).get('/api/v1/auth/me').set('Cookie', cookie()).set('X-App', 'admin');
    expect(member.body.firstName).toBe('Meera');
    expect(admin.body.firstName).toBe('Admin');
  });
});
