import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { loadEnv } from '../src/config/env';
import { LocalStorage } from '../src/lib/storage';
import { createLogger } from '../src/lib/logger';

const dir = mkdtempSync(path.join(tmpdir(), 'mm-storage-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const env = loadEnv({ NODE_ENV: 'test', STORAGE_PROVIDER: 'local', LOCAL_STORAGE_DIR: dir } as NodeJS.ProcessEnv);
const app = createApp({ env, log: createLogger('silent'), isReady: () => true });
const store = new LocalStorage(dir, env.JWT_REFRESH_SECRET);
const bytes = Buffer.from('hello photo');

describe('local development storage', () => {
  it('uploads through a signed link and serves it back through a signed link', async () => {
    const put = await store.presignPut('photos', 'u1/a.jpg', 'image/jpeg', bytes.length, 60);
    const up = await request(app).put(put.url).set('Content-Type', 'image/jpeg').send(bytes);
    expect(up.status).toBe(200);
    expect(await store.head('photos', 'u1/a.jpg')).toMatchObject({ size: bytes.length, contentType: 'image/jpeg' });
    const get = await request(app).get(await store.presignGet('photos', 'u1/a.jpg', 60));
    expect(get.status).toBe(200);
    expect(get.headers['content-type']).toContain('image/jpeg');
    expect(Buffer.from(get.body)).toEqual(bytes);
  });

  it('refuses tampered, expired or mismatched links', async () => {
    const put = await store.presignPut('photos', 'u1/b.jpg', 'image/jpeg', bytes.length, 60);
    expect((await request(app).put(put.url.replace('b.jpg', 'c.jpg')).set('Content-Type', 'image/jpeg').send(bytes)).status).toBe(403);
    expect((await request(app).put(put.url).set('Content-Type', 'image/png').send(bytes)).status).toBe(400);
    expect((await request(app).put(put.url).set('Content-Type', 'image/jpeg').send(Buffer.from('longer body than agreed'))).status).toBe(400);
    const expired = await store.presignPut('photos', 'u1/d.jpg', 'image/jpeg', bytes.length, -5);
    expect((await request(app).put(expired.url).set('Content-Type', 'image/jpeg').send(bytes)).status).toBe(403);
    expect((await request(app).get('/api/v1/dev-storage/photos/u1/a.jpg')).status).toBe(403);
  });

  it('will not leave its folder', async () => {
    await expect(store.get('photos', '../../etc/passwd')).rejects.toThrow();
  });
});
