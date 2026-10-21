import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import mongoose from 'mongoose';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Env } from '../config/env';

export type Bucket = 'photos' | 'identity' | 'documents';

export interface PresignedPut {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresInSec: number;
}

export interface ObjectStorage {
  /** Signed so the declared type and exact byte length are enforced by the bucket. */
  presignPut(b: Bucket, key: string, contentType: string, sizeBytes: number, ttlSec: number): Promise<PresignedPut>;
  presignGet(b: Bucket, key: string, ttlSec: number): Promise<string>;
  head(b: Bucket, key: string): Promise<{ size: number; contentType?: string } | null>;
  get(b: Bucket, key: string): Promise<Buffer>;
  put(b: Bucket, key: string, body: Buffer, contentType: string): Promise<void>;
  delete(b: Bucket, key: string): Promise<void>;
}

/** In-memory storage for tests and for running without an object store. */
export class MemoryStorage implements ObjectStorage {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  private k = (b: Bucket, key: string) => `${b}/${key}`;

  async presignPut(b: Bucket, key: string, contentType: string, sizeBytes: number, ttlSec: number) {
    return {
      url: `memory://${this.k(b, key)}`,
      method: 'PUT' as const,
      headers: { 'Content-Type': contentType, 'Content-Length': String(sizeBytes) },
      expiresInSec: ttlSec,
    };
  }
  async presignGet(b: Bucket, key: string, ttlSec: number) {
    return `memory://${this.k(b, key)}?ttl=${ttlSec}`;
  }
  async head(b: Bucket, key: string) {
    const o = this.objects.get(this.k(b, key));
    return o ? { size: o.body.length, contentType: o.contentType } : null;
  }
  async get(b: Bucket, key: string) {
    const o = this.objects.get(this.k(b, key));
    if (!o) throw new Error(`object not found: ${this.k(b, key)}`);
    return o.body;
  }
  async put(b: Bucket, key: string, body: Buffer, contentType: string) {
    this.objects.set(this.k(b, key), { body, contentType });
  }
  async delete(b: Bucket, key: string) {
    this.objects.delete(this.k(b, key));
  }
  has(b: Bucket, key: string) {
    return this.objects.has(this.k(b, key));
  }
}

/** S3-compatible storage (Cloudflare R2, AWS S3, MinIO). Identity bucket uses separate credentials. */
export class S3Storage implements ObjectStorage {
  private readonly general: S3Client;
  private readonly identity: S3Client;
  private readonly names: Record<Bucket, string>;

  constructor(env: Env) {
    const base = { region: env.S3_REGION, endpoint: env.S3_ENDPOINT, forcePathStyle: true } as const;
    this.general = new S3Client({
      ...base,
      credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
    });
    this.identity = new S3Client({
      ...base,
      credentials: {
        accessKeyId: env.S3_IDENTITY_ACCESS_KEY_ID ?? env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_IDENTITY_SECRET_ACCESS_KEY ?? env.S3_SECRET_ACCESS_KEY,
      },
    });
    this.names = { photos: env.S3_BUCKET_PHOTOS, identity: env.S3_BUCKET_IDENTITY, documents: env.S3_BUCKET_DOCUMENTS };
  }

  private client(b: Bucket) {
    return b === 'identity' ? this.identity : this.general;
  }

  async presignPut(b: Bucket, key: string, contentType: string, sizeBytes: number, ttlSec: number) {
    const cmd = new PutObjectCommand({
      Bucket: this.names[b],
      Key: key,
      ContentType: contentType,
      ContentLength: sizeBytes,
      ServerSideEncryption: 'AES256',
    });
    const url = await getSignedUrl(this.client(b), cmd, {
      expiresIn: ttlSec,
      signableHeaders: new Set(['content-type', 'content-length']),
    });
    return {
      url,
      method: 'PUT' as const,
      headers: { 'Content-Type': contentType, 'Content-Length': String(sizeBytes) },
      expiresInSec: ttlSec,
    };
  }

  presignGet(b: Bucket, key: string, ttlSec: number) {
    return getSignedUrl(this.client(b), new GetObjectCommand({ Bucket: this.names[b], Key: key }), { expiresIn: ttlSec });
  }

  async head(b: Bucket, key: string) {
    try {
      const r = await this.client(b).send(new HeadObjectCommand({ Bucket: this.names[b], Key: key }));
      return { size: Number(r.ContentLength ?? 0), contentType: r.ContentType };
    } catch (err) {
      if ((err as { name?: string }).name === 'NotFound') return null;
      throw err;
    }
  }

  async get(b: Bucket, key: string) {
    const r = await this.client(b).send(new GetObjectCommand({ Bucket: this.names[b], Key: key }));
    const bytes = await r.Body?.transformToByteArray();
    if (!bytes) throw new Error('empty object');
    return Buffer.from(bytes);
  }

  async put(b: Bucket, key: string, body: Buffer, contentType: string) {
    await this.client(b).send(
      new PutObjectCommand({ Bucket: this.names[b], Key: key, Body: body, ContentType: contentType, ServerSideEncryption: 'AES256' }),
    );
  }

  async delete(b: Bucket, key: string) {
    await this.client(b).send(new DeleteObjectCommand({ Bucket: this.names[b], Key: key }));
  }
}

/**
 * Storage whose uploads and downloads go through the API itself, using short-lived signed links. Each link names the
 * exact content type and size it allows, like a presigned S3 link. Subclasses decide where the bytes are kept.
 */
export abstract class SignedUrlStorage implements ObjectStorage {
  /** `basePath` is where the API serves the links, under /api/v1. `publicBase` is the API's own address, used for uploads so they go straight to it. */
  protected constructor(
    private readonly secret: string,
    readonly basePath: string,
    private readonly publicBase = '',
  ) {}

  sign(method: 'PUT' | 'GET', b: Bucket, key: string, exp: number, ct = '', len = 0) {
    return createHmac('sha256', this.secret).update(`${method}:${b}/${key}:${exp}:${ct}:${len}`).digest('hex');
  }
  verify(method: 'PUT' | 'GET', b: Bucket, key: string, q: { exp?: string; sig?: string; ct?: string; len?: string }) {
    const exp = Number(q.exp);
    if (!Number.isFinite(exp) || exp < Date.now() || !q.sig) return false;
    const want = Buffer.from(this.sign(method, b, key, exp, q.ct ?? '', Number(q.len ?? 0)));
    const got = Buffer.from(q.sig);
    return want.length === got.length && timingSafeEqual(want, got);
  }
  async presignPut(b: Bucket, key: string, contentType: string, sizeBytes: number, ttlSec: number) {
    const exp = Date.now() + ttlSec * 1000;
    const sig = this.sign('PUT', b, key, exp, contentType, sizeBytes);
    // Uploads can be large, so they may go to the API's own address instead of through the site's proxy.
    const url = `${this.publicBase}/api/v1/${this.basePath}/${b}/${key}?exp=${exp}&sig=${sig}&ct=${encodeURIComponent(contentType)}&len=${sizeBytes}`;
    return { url, method: 'PUT' as const, headers: { 'Content-Type': contentType }, expiresInSec: ttlSec };
  }
  /** Relative on purpose: pictures are loaded from the site's own address, so they are not blocked as cross-site. */
  async presignGet(b: Bucket, key: string, ttlSec: number) {
    const exp = Date.now() + ttlSec * 1000;
    return `/api/v1/${this.basePath}/${b}/${key}?exp=${exp}&sig=${this.sign('GET', b, key, exp)}`;
  }
  abstract head(b: Bucket, key: string): Promise<{ size: number; contentType?: string } | null>;
  abstract get(b: Bucket, key: string): Promise<Buffer>;
  abstract put(b: Bucket, key: string, body: Buffer, contentType: string): Promise<void>;
  abstract delete(b: Bucket, key: string): Promise<void>;
}

/**
 * Files on this machine's disk, for development. Never used in production (the start-up guard refuses it).
 */
export class LocalStorage extends SignedUrlStorage {
  constructor(
    private readonly dir: string,
    secret: string,
  ) {
    super(secret, 'dev-storage');
  }

  private file(b: Bucket, key: string) {
    const root = path.resolve(this.dir, b);
    const full = path.resolve(root, key);
    if (!full.startsWith(root + path.sep)) throw new Error('invalid object key');
    return full;
  }
  async head(b: Bucket, key: string) {
    try {
      const f = this.file(b, key);
      const st = await stat(f);
      const ct = await readFile(`${f}.type`, 'utf8').catch(() => undefined);
      return { size: st.size, contentType: ct };
    } catch {
      return null;
    }
  }
  async get(b: Bucket, key: string) {
    return readFile(this.file(b, key));
  }
  async put(b: Bucket, key: string, body: Buffer, contentType: string) {
    const f = this.file(b, key);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, body);
    await writeFile(`${f}.type`, contentType);
  }
  async delete(b: Bucket, key: string) {
    const f = this.file(b, key);
    await rm(f, { force: true });
    await rm(`${f}.type`, { force: true });
  }
}

/**
 * Files kept in the MongoDB database itself (GridFS), one collection set per bucket. It needs no object store account,
 * and the API and the worker both see the same files, so photos, ID images, invoices and exports work on a small
 * deployment. The database grows with every picture, so move to S3 storage before the numbers get large.
 */
export class MongoStorage extends SignedUrlStorage {
  constructor(secret: string, publicBase?: string) {
    super(secret, 'files', publicBase?.replace(/\/$/, ''));
  }

  private bucket(b: Bucket) {
    const db = mongoose.connection.db;
    if (!db) throw new Error('MongoDB is not connected');
    return new mongoose.mongo.GridFSBucket(db, { bucketName: `files_${b}` });
  }
  private async find(b: Bucket, key: string) {
    const files = await this.bucket(b).find({ filename: key }).sort({ uploadDate: -1 }).limit(1).toArray();
    return files[0] ?? null;
  }
  async head(b: Bucket, key: string) {
    const f = await this.find(b, key);
    return f ? { size: f.length, contentType: (f.metadata as { contentType?: string } | undefined)?.contentType } : null;
  }
  async get(b: Bucket, key: string) {
    if (!(await this.find(b, key))) throw new Error('object not found');
    const chunks: Buffer[] = [];
    for await (const c of this.bucket(b).openDownloadStreamByName(key)) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }
  async put(b: Bucket, key: string, body: Buffer, contentType: string) {
    await this.delete(b, key); // one current version per key, like an object store
    await pipeline(Readable.from(body), this.bucket(b).openUploadStream(key, { metadata: { contentType } }));
  }
  async delete(b: Bucket, key: string) {
    const bucket = this.bucket(b);
    for (const f of await bucket.find({ filename: key }).toArray()) await bucket.delete(f._id);
  }
}

export function createStorage(env: Env): ObjectStorage {
  if (env.STORAGE_PROVIDER === 'local') return new LocalStorage(env.LOCAL_STORAGE_DIR, env.JWT_REFRESH_SECRET);
  if (env.STORAGE_PROVIDER === 'mongo') return new MongoStorage(env.JWT_REFRESH_SECRET, env.PUBLIC_API_URL);
  return env.STORAGE_PROVIDER === 's3' ? new S3Storage(env) : new MemoryStorage();
}
