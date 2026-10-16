import { DecryptCommand, KMSClient } from '@aws-sdk/client-kms';
import type { Env } from '../config/env';
import { FieldCrypto } from './crypto';

/** Builds the key ring from the environment (current key, optional earlier versions, stable lookup key). */
export function fieldCryptoFromEnv(env: Env): FieldCrypto {
  let previous: Record<string, string> | undefined;
  if (env.FIELD_ENCRYPTION_KEYS_PREVIOUS) {
    try {
      previous = JSON.parse(env.FIELD_ENCRYPTION_KEYS_PREVIOUS) as Record<string, string>;
    } catch {
      throw new Error('FIELD_ENCRYPTION_KEYS_PREVIOUS must be a JSON object such as {"1":"<base64 key>"}');
    }
  }
  return new FieldCrypto({
    current: { version: env.FIELD_ENCRYPTION_KEY_VERSION, key: env.FIELD_ENCRYPTION_KEY },
    previous,
    blindIndexKey: env.FIELD_BLIND_INDEX_KEY,
  });
}

/**
 * If the encryption key is stored KMS-wrapped, unwrap it once at start-up and return an environment
 * that carries the plain key in memory only. The plain key is never written to disk or logged.
 * Without a wrapped key this returns the environment unchanged.
 */
export async function resolveKmsKeys(env: Env, kms?: Pick<KMSClient, 'send'>): Promise<Env> {
  if (!env.FIELD_ENCRYPTION_KEY_KMS_WRAPPED) return env;
  const client = kms ?? new KMSClient({ region: env.AWS_REGION });
  const out = await client.send(new DecryptCommand({ CiphertextBlob: Buffer.from(env.FIELD_ENCRYPTION_KEY_KMS_WRAPPED, 'base64') }));
  if (!out.Plaintext) throw new Error('KMS returned no key material');
  return { ...env, FIELD_ENCRYPTION_KEY: Buffer.from(out.Plaintext).toString('base64') };
}
