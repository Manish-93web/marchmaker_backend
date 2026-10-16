import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';
import { FieldCrypto } from '../src/lib/crypto';
import { fieldCryptoFromEnv, resolveKmsKeys } from '../src/lib/keys';
import { scrub } from '../src/lib/sentry';

const key = () => randomBytes(32).toString('base64');

describe('field encryption key ring', () => {
  it('reads old data after a rotation and writes new data with the new key', () => {
    const k1 = key();
    const k2 = key();
    const before = new FieldCrypto({ current: { version: 1, key: k1 } });
    const old = before.encrypt('+919876543210');
    expect(old.startsWith('v1.')).toBe(true);

    const after = new FieldCrypto({ current: { version: 2, key: k2 }, previous: { '1': k1 }, blindIndexKey: k1 });
    expect(after.decrypt(old)).toBe('+919876543210');
    expect(after.needsRotation(old)).toBe(true);
    const moved = after.rotate(old);
    expect(moved.startsWith('v2.')).toBe(true);
    expect(after.needsRotation(moved)).toBe(false);
    expect(after.rotate(moved)).toBe(moved);
    expect(after.decrypt(moved)).toBe('+919876543210');
    // The old key alone can no longer read the new ciphertext.
    expect(() => before.decrypt(moved)).toThrow();
  });

  it('keeps lookup hashes stable across rotation when the lookup key is fixed', () => {
    const k1 = key();
    const a = new FieldCrypto({ current: { version: 1, key: k1 }, blindIndexKey: k1 });
    const b = new FieldCrypto({ current: { version: 2, key: key() }, previous: { '1': k1 }, blindIndexKey: k1 });
    expect(b.blindIndex('+919876543210')).toBe(a.blindIndex('+919876543210'));
  });

  it('defaults the lookup key to the oldest key, so rotation does not break phone lookups', () => {
    const k1 = key();
    const a = new FieldCrypto(k1);
    const b = new FieldCrypto({ current: { version: 2, key: key() }, previous: { '1': k1 } });
    expect(b.blindIndex('x')).toBe(a.blindIndex('x'));
  });

  it('refuses unknown versions, tampering, short keys and clashing versions', () => {
    const c = new FieldCrypto(key());
    const enc = c.encrypt('secret');
    expect(() => c.decrypt(enc.replace(/^v1/, 'v9'))).toThrow(/unknown key version/);
    const parts = enc.split('.');
    parts[3] = (parts[3]!.startsWith('A') ? 'B' : 'A') + parts[3]!.slice(1);
    expect(() => c.decrypt(parts.join('.'))).toThrow();
    expect(() => new FieldCrypto(Buffer.alloc(8).toString('base64'))).toThrow(/32 bytes/);
    const k = key();
    expect(() => new FieldCrypto({ current: { version: 1, key: k }, previous: { '1': k } })).toThrow(/both/);
  });

  it('builds the ring from the environment', () => {
    const k1 = key();
    const k2 = key();
    const env = loadEnv({
      NODE_ENV: 'test',
      FIELD_ENCRYPTION_KEY: k2,
      FIELD_ENCRYPTION_KEY_VERSION: '2',
      FIELD_ENCRYPTION_KEYS_PREVIOUS: JSON.stringify({ '1': k1 }),
    } as NodeJS.ProcessEnv);
    const ring = fieldCryptoFromEnv(env);
    const legacy = new FieldCrypto(k1).encrypt('hello');
    expect(ring.decrypt(legacy)).toBe('hello');
    expect(ring.version).toBe(2);
    expect(() => fieldCryptoFromEnv({ ...env, FIELD_ENCRYPTION_KEYS_PREVIOUS: 'not json' })).toThrow(/JSON object/);
  });
});

describe('KMS-wrapped key', () => {
  it('unwraps the key at start-up into memory and leaves a plain environment alone', async () => {
    const plain = randomBytes(32);
    const env = loadEnv({ NODE_ENV: 'test', FIELD_ENCRYPTION_KEY_KMS_WRAPPED: Buffer.from('wrapped').toString('base64') } as NodeJS.ProcessEnv);
    const kms = { send: async () => ({ Plaintext: plain }) } as never;
    const out = await resolveKmsKeys(env, kms);
    expect(out.FIELD_ENCRYPTION_KEY).toBe(plain.toString('base64'));
    const untouched = loadEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    expect(await resolveKmsKeys(untouched)).toBe(untouched);
    await expect(resolveKmsKeys(env, { send: async () => ({}) } as never)).rejects.toThrow(/no key material/);
  });
});

describe('error-tracking scrubber', () => {
  it('redacts anything that looks personal or secret, at any depth', () => {
    const out = scrub({ route: '/x', user: { email: 'a@b.co', id: 'u1' }, headers: [{ authorization: 'Bearer t' }], nested: { otpCode: '123456', ok: 1 } });
    expect(JSON.stringify(out)).not.toMatch(/a@b\.co|Bearer|123456/);
    expect(out).toMatchObject({ route: '/x', nested: { ok: 1 } });
  });
});
