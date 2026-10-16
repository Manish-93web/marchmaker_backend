import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

/**
 * Field-level encryption (AES-256-GCM) for sensitive fields: phone, DOB, ID numbers, income.
 * Output format: v1.<iv>.<tag>.<ciphertext> (base64url). The key comes from env / KMS.
 */
export class FieldCrypto {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    const key = Buffer.from(base64Key, 'base64');
    if (key.length < 32) throw new Error('FIELD_ENCRYPTION_KEY must decode to at least 32 bytes');
    this.key = key.subarray(0, 32);
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join('.');
  }

  decrypt(payload: string): string {
    const [version, iv, tag, data] = payload.split('.');
    if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unsupported ciphertext format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  }

  /** Deterministic keyed hash so encrypted fields (e.g. phone) can still be looked up. */
  blindIndex(value: string): string {
    return createHmac('sha256', this.key).update(value.trim().toLowerCase()).digest('hex');
  }
}
