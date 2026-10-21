import express, { Router } from 'express';
import { LocalStorage, SignedUrlStorage, type Bucket } from '../lib/storage';
import type { AppContext } from '../context';

const BUCKETS = ['photos', 'identity', 'documents'] as const;

/**
 * Accepts the signed uploads and serves the signed downloads that the disk and MongoDB storages hand out, so the browser
 * can upload a photo or ID image without an object store. Each link names the exact type and size it allows. The disk
 * storage is for development only; the MongoDB storage is allowed in production.
 */
export function signedStorageRouter(ctx: AppContext): Router | null {
  const store = ctx.storage;
  if (!(store instanceof SignedUrlStorage)) return null;
  if (store instanceof LocalStorage && ctx.env.NODE_ENV === 'production') return null;
  const r = Router();
  const parse = (req: express.Request) => {
    const bucket = String(req.params.bucket) as Bucket;
    const key = String(req.params[0] ?? '');
    return BUCKETS.includes(bucket) && key && !key.includes('..') ? { bucket, key } : null;
  };

  r.put(`/${store.basePath}/:bucket/*`, express.raw({ type: () => true, limit: '12mb' }), async (req, res) => {
    const p = parse(req);
    const q = req.query as Record<string, string>;
    if (!p || !store.verify('PUT', p.bucket, p.key, q)) return void res.status(403).json({ error: { code: 'FORBIDDEN', message: 'This upload link is not valid or has expired' } });
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length !== Number(q.len) || (req.get('content-type') ?? '').split(';')[0] !== q.ct) {
      return void res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'The upload did not match what was agreed' } });
    }
    await store.put(p.bucket, p.key, body, q.ct ?? 'application/octet-stream');
    res.status(200).end();
  });

  r.get(`/${store.basePath}/:bucket/*`, async (req, res) => {
    const p = parse(req);
    if (!p || !store.verify('GET', p.bucket, p.key, req.query as Record<string, string>)) return void res.status(403).end();
    const head = await store.head(p.bucket, p.key);
    if (!head) return void res.status(404).end();
    res.set({ 'Content-Type': head.contentType ?? 'application/octet-stream', 'Cache-Control': 'private, no-store' });
    res.send(await store.get(p.bucket, p.key));
  });
  return r;
}
