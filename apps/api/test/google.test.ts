import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { loadEnv } from '../src/config/env';
import { buildContext } from '../src/context';
import { unauthorized } from '../src/lib/errors';
import { createLogger } from '../src/lib/logger';
import { MemoryMailer } from '../src/lib/mailer';
import { MemorySms } from '../src/lib/sms';
import { User } from '../src/models/core';

const profiles: Record<string, { sub: string; email: string; emailVerified: boolean; givenName: string }> = {
  newbie: { sub: 'g-1', email: 'asha@example.com', emailVerified: true, givenName: 'Asha' },
  unverified: { sub: 'g-2', email: 'nope@example.com', emailVerified: false, givenName: 'Nope' },
};
vi.mock('../src/lib/googleAuth', () => ({
  verifyGoogleIdToken: async (token: string) => {
    const key = token.replace(/^tok-/, '').replace(/-padding-padding$/, '');
    if (!profiles[key]) throw unauthorized('We could not verify your Google sign-in. Please try again.');
    return profiles[key];
  },
}));

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

function setup(clientId: string | null = 'test-client-id.apps.googleusercontent.com') {
  const log = createLogger('silent');
  const env = loadEnv({ NODE_ENV: 'test', ...(clientId ? { GOOGLE_CLIENT_ID: clientId } : {}) } as NodeJS.ProcessEnv);
  const ctx = buildContext({ env, log, mailer: new MemoryMailer(), sms: new MemorySms() });
  return createApp({ env, log, isReady: () => true, ctx });
}
const cred = (k: string) => `tok-${k}-padding-padding`;
const dob = '1996-04-02';

describe('Google sign-in', () => {
  it('asks a new person for the missing details, then creates a verified account and a session', async () => {
    const app = setup();
    const first = await request(app).post('/api/v1/auth/google').send({ credential: cred('newbie') });
    expect(first.status).toBe(422);
    expect(first.body.error.code).toBe('PROFILE_NEEDED');
    expect(first.body.error.details).toMatchObject({ email: 'asha@example.com', firstName: 'Asha' });
    expect(await User.countDocuments()).toBe(0);

    const second = await request(app).post('/api/v1/auth/google').send({ credential: cred('newbie'), gender: 'woman', dob, acceptTerms: true });
    expect(second.status).toBe(200);
    expect(String(second.headers['set-cookie'])).toContain('mm_');
    const u = await User.findOne({ email: 'asha@example.com' });
    expect(u?.googleSub).toBe('g-1');
    expect(u?.emailVerifiedAt).toBeTruthy();
    expect(u?.journeyState).toBe('email_verified');
  });

  it('signs an existing password account in and links it', async () => {
    const app = setup();
    await User.create({ email: 'asha@example.com', firstName: 'Asha', gender: 'woman', dobEnc: 'x', dobYear: 1996, roles: ['member'] });
    const res = await request(app).post('/api/v1/auth/google').send({ credential: cred('newbie') });
    expect(res.status).toBe(200);
    const u = await User.findOne({ email: 'asha@example.com' });
    expect(u?.googleSub).toBe('g-1');
    expect(u?.emailVerifiedAt).toBeTruthy();
  });

  it('keeps staff on password and authenticator sign-in', async () => {
    const app = setup();
    await User.create({ email: 'asha@example.com', firstName: 'Asha', gender: 'woman', dobEnc: 'x', dobYear: 1996, roles: ['admin'] });
    expect((await request(app).post('/api/v1/auth/google').send({ credential: cred('newbie') })).status).toBe(403);
  });

  it('rejects an under-age birth date, an unverified Google email and a bad token', async () => {
    const app = setup();
    const young = await request(app).post('/api/v1/auth/google').send({ credential: cred('newbie'), gender: 'man', dob: '2012-01-01', acceptTerms: true });
    expect(young.status).toBe(422);
    expect((await request(app).post('/api/v1/auth/google').send({ credential: cred('unverified') })).status).toBe(400);
    expect((await request(app).post('/api/v1/auth/google').send({ credential: cred('forged') })).status).toBe(401);
  });

  it('is off, and says so in /meta, until a client id is configured', async () => {
    const off = setup(null);
    expect((await request(off).get('/api/v1/meta')).body.googleClientId).toBeNull();
    expect((await request(off).post('/api/v1/auth/google').send({ credential: cred('newbie') })).status).toBe(400);
    const on = setup();
    expect((await request(on).get('/api/v1/meta')).body.googleClientId).toContain('googleusercontent');
  });
});
