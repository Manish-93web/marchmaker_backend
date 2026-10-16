import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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

export function createStorage(env: Env): ObjectStorage {
  return env.STORAGE_PROVIDER === 's3' ? new S3Storage(env) : new MemoryStorage();
}
