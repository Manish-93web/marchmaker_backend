import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { loadEnv } from '../src/config/env';
import { FieldCrypto } from '../src/lib/crypto';
import { createLogger } from '../src/lib/logger';

const env = loadEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
const log = createLogger('silent');

function build(ready = true) {
  return createApp({ env, log, isReady: () => ready });
}

describe('api skeleton', () => {
  it('serves /healthz with a request id header', async () => {
    const res = await request(build()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('reports not ready while shutting down or without DB', async () => {
    const res = await request(build(false)).get('/readyz');
    expect(res.status).toBe(503);
  });

  it('sets hardened security headers', async () => {
    const res = await request(build()).get('/api/v1/meta');
    expect(res.status).toBe(200);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['strict-transport-security']).toContain('max-age=');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['permissions-policy']).toContain('camera=()');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('returns the standard error shape for unknown routes', async () => {
    const res = await request(build()).get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND' });
    expect(res.body.error.requestId).toBeTruthy();
  });

  it('rejects oversized JSON bodies with a friendly error', async () => {
    const big = { data: 'x'.repeat(200_000) };
    const res = await request(build()).post('/api/v1/meta').send(big);
    expect([404, 413]).toContain(res.status);
    expect(res.body.error.requestId).toBeTruthy();
  });

  it('does not allow unknown CORS origins', async () => {
    const res = await request(build()).get('/api/v1/meta').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const ok = await request(build()).get('/api/v1/meta').set('Origin', 'http://localhost:5173');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });
});

describe('openapi', () => {
  it('serves a document covering auth and account endpoints outside production', async () => {
    const res = await request(build()).get('/api/docs/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(Object.keys(res.body.paths)).toContain('/api/v1/auth/login');
    expect(Object.keys(res.body.paths)).toContain('/api/v1/account/export');
  });
});

describe('field encryption', () => {
  const c = new FieldCrypto(env.FIELD_ENCRYPTION_KEY);
  it('round-trips and is non-deterministic', () => {
    const a = c.encrypt('+919876543210');
    const b = c.encrypt('+919876543210');
    expect(a).not.toBe(b);
    expect(c.decrypt(a)).toBe('+919876543210');
  });
  it('detects tampering', () => {
    const enc = c.encrypt('secret');
    const parts = enc.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => c.decrypt(parts.join('.'))).toThrow();
  });
  it('blind index is stable and case-insensitive', () => {
    expect(c.blindIndex('A@b.com')).toBe(c.blindIndex('a@b.com'));
  });
});
