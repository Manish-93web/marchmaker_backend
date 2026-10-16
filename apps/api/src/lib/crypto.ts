import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const toKey = (base64: string, label: string): Buffer => {
  const key = Buffer.from(base64, 'base64');
  if (key.length < 32) throw new Error(`${label} must decode to at least 32 bytes`);
  return key.subarray(0, 32);
};

export interface KeyRingOptions {
  /** Key used for every new encryption. */
  current: { version: number; key: string };
  /** Earlier keys, kept only so old ciphertext can still be read until it is re-encrypted. */
  previous?: Record<string, string>;
  /**
   * Key for the keyed lookup hash (phone). It must NOT change when the encryption key rotates, or
   * every stored hash would stop matching. Defaults to the oldest key in the ring.
   */
  blindIndexKey?: string;
}

/**
 * Field-level encryption (AES-256-GCM) for sensitive fields: phone, date of birth, income, health
 * notes, authenticator secrets, birth details. Output: v<N>.<iv>.<tag>.<ciphertext> (base64url).
 *
 * A key ring makes rotation safe: new data uses the current key, old data stays readable with its
 * own version, and `needsRotation` / `rotate` bring old ciphertext forward (see scripts/rotateFieldKey.ts).
 */
export class FieldCrypto {
  private readonly keys = new Map<number, Buffer>();
  private readonly currentVersion: number;
  private readonly blindKey: Buffer;

  constructor(arg: string | KeyRingOptions) {
    const opts: KeyRingOptions = typeof arg === 'string' ? { current: { version: 1, key: arg } } : arg;
    this.currentVersion = opts.current.version;
    this.keys.set(opts.current.version, toKey(opts.current.key, 'FIELD_ENCRYPTION_KEY'));
    for (const [v, k] of Object.entries(opts.previous ?? {})) {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid key version "${v}"`);
      if (n === opts.current.version) throw new Error(`Key version ${n} is used by both the current and a previous key`);
      this.keys.set(n, toKey(k, `previous key v${n}`));
    }
    const oldest = Math.min(...this.keys.keys());
    this.blindKey = opts.blindIndexKey ? toKey(opts.blindIndexKey, 'FIELD_BLIND_INDEX_KEY') : this.keys.get(oldest)!;
  }

  get version(): number {
    return this.currentVersion;
  }

  encrypt(plain: string): string {
    const key = this.keys.get(this.currentVersion)!;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [`v${this.currentVersion}`, iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join('.');
  }

  /** The key version a ciphertext was written with, or null if it is not in our format. */
  versionOf(payload: string): number | null {
    const m = /^v(\d+)\./.exec(payload);
    return m ? Number(m[1]) : null;
  }

  needsRotation(payload: string): boolean {
    const v = this.versionOf(payload);
    return v !== null && v !== this.currentVersion;
  }

  decrypt(payload: string): string {
    const [version, iv, tag, data] = payload.split('.');
    const n = /^v(\d+)$/.exec(version ?? '')?.[1];
    const key = n ? this.keys.get(Number(n)) : undefined;
    if (!key || !iv || !tag || !data) throw new Error('Unsupported ciphertext format or unknown key version');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  }

  /** Re-encrypts with the current key. Returns the input unchanged if it is already current. */
  rotate(payload: string): string {
    return this.needsRotation(payload) ? this.encrypt(this.decrypt(payload)) : payload;
  }

  /** Deterministic keyed hash so encrypted fields (e.g. phone) can still be looked up. */
  blindIndex(value: string): string {
    return createHmac('sha256', this.blindKey).update(value.trim().toLowerCase()).digest('hex');
  }
}
