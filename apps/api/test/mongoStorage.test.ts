import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { loadEnv } from '../src/config/env';
import { buildContext } from '../src/context';
import { createLogger } from '../src/lib/logger';
import { MemoryMailer } from '../src/lib/mailer';
import { MemorySms } from '../src/lib/sms';
import { MongoStorage } from '../src/lib/storage';

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

const log = createLogger('silent');
const env = loadEnv({ NODE_ENV: 'test', STORAGE_PROVIDER: 'mongo', PUBLIC_API_URL: 'https://api.example.com' } as NodeJS.ProcessEnv);
const ctx = buildContext({ env, log, mailer: new MemoryMailer(), sms: new MemorySms() });
const app = createApp({ env, log, isReady: () => true, ctx });
const store = ctx.storage as MongoStorage;
const bytes = Buffer.from('a small picture');

describe('MongoDB file storage', () => {
  it('stores, reads, replaces and deletes objects, one current version per key', async () => {
    expect(store).toBeInstanceOf(MongoStorage);
    expect(await store.head('photos', 'u/a.webp')).toBeNull();
    await store.put('photos', 'u/a.webp', bytes, 'image/webp');
    expect(await store.head('photos', 'u/a.webp')).toMatchObject({ size: bytes.length, contentType: 'image/webp' });
    expect((await store.get('photos', 'u/a.webp')).equals(bytes)).toBe(true);
    await store.put('photos', 'u/a.webp', Buffer.from('replaced'), 'image/webp');
    expect((await store.get('photos', 'u/a.webp')).toString()).toBe('replaced');
    expect(await mongoose.connection.db!.collection('files_photos.files').countDocuments({ filename: 'u/a.webp' })).toBe(1);
    await store.delete('photos', 'u/a.webp');
    expect(await store.head('photos', 'u/a.webp')).toBeNull();
    await expect(store.get('photos', 'u/a.webp')).rejects.toThrow(/not found/);
  });

  it('keeps the three buckets apart', async () => {
    await store.put('identity', 'same/key', Buffer.from('id'), 'image/jpeg');
    expect(await store.head('photos', 'same/key')).toBeNull();
    expect(await store.head('identity', 'same/key')).not.toBeNull();
  });

  it('sends uploads to the API address and downloads through the site, both signed', async () => {
    const put = await store.presignPut('photos', 'u/b.jpg', 'image/jpeg', bytes.length, 60);
    expect(put.url.startsWith('https://api.example.com/api/v1/files/photos/u/b.jpg?')).toBe(true);
    const get = await store.presignGet('photos', 'u/b.jpg', 60);
    expect(get.startsWith('/api/v1/files/photos/u/b.jpg?')).toBe(true);
  });

  it('accepts a signed upload and serves it back, and refuses anything unsigned or altered', async () => {
    const put = await store.presignPut('photos', 'u/c.jpg', 'image/jpeg', bytes.length, 60);
    const path = put.url.replace('https://api.example.com', '');
    expect((await request(app).put(path).set('Content-Type', 'image/jpeg').send(bytes)).status).toBe(200);
    const down = await request(app).get(await store.presignGet('photos', 'u/c.jpg', 60));
    expect(down.status).toBe(200);
    expect(down.headers['content-type']).toContain('image/jpeg');
    expect(Buffer.from(down.body).equals(bytes)).toBe(true);

    expect((await request(app).get('/api/v1/files/photos/u/c.jpg')).status).toBe(403); // no signature
    expect((await request(app).put(path.replace('c.jpg', 'd.jpg')).set('Content-Type', 'image/jpeg').send(bytes)).status).toBe(403);
    expect((await request(app).put(path).set('Content-Type', 'image/png').send(bytes)).status).toBe(400); // wrong type
    expect((await request(app).put(path).set('Content-Type', 'image/jpeg').send(Buffer.from('much longer than agreed'))).status).toBe(400);
  });

  it('is allowed in production, unlike the disk storage', () => {
    const good = {
      NODE_ENV: 'production', JWT_ACCESS_SECRET: 'a'.repeat(40), JWT_REFRESH_SECRET: 'b'.repeat(40), COOKIE_SECURE: 'true',
      FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), EMAIL_PROVIDER: 'smtp', SMS_PROVIDER: 'msg91',
      MSG91_AUTH_KEY: 'k', MSG91_OTP_TEMPLATE_ID: 't', KYC_PROVIDER: 'none', PAYMENTS_PROVIDER: 'razorpay',
      RAZORPAY_KEY_ID: 'i', RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'real-webhook-secret',
      CALLS_PROVIDER: 'none', ASTROLOGY_PROVIDER: 'none', WHATSAPP_PROVIDER: 'none', PUSH_PROVIDER: 'none',
      REDIS_URL: 'redis://redis:6379', SENTRY_DSN: 'https://public@o0.ingest.sentry.io/1',
      APP_URL: 'https://app.example.com', ADMIN_URL: 'https://admin.example.com',
      CORS_ORIGINS: 'https://app.example.com,https://admin.example.com',
    };
    expect(() => loadEnv({ ...good, STORAGE_PROVIDER: 'mongo' } as unknown as NodeJS.ProcessEnv)).not.toThrow();
    expect(() => loadEnv({ ...good, STORAGE_PROVIDER: 'local' } as unknown as NodeJS.ProcessEnv)).toThrow(/STORAGE_PROVIDER/);
    expect(() => loadEnv({ ...good, STORAGE_PROVIDER: 'memory' } as unknown as NodeJS.ProcessEnv)).toThrow(/lose every upload/);
  });
});
