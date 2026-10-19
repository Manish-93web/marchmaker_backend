import { createPublicKey, type JsonWebKeyInput } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { unauthorized } from './errors';

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  givenName?: string;
  name?: string;
}

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
type Jwk = JsonWebKeyInput['key'] & { kid?: string };
let cache: { keys: Jwk[]; until: number } | null = null;

async function signingKeys(force = false) {
  if (!force && cache && cache.until > Date.now()) return cache.keys;
  const res = await fetch(CERTS_URL, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Google certificate fetch failed (${res.status})`);
  const body = (await res.json()) as { keys: Jwk[] };
  cache = { keys: body.keys, until: Date.now() + 60 * 60_000 };
  return cache.keys;
}

/**
 * Checks a Google ID token (the credential from the Sign in with Google button): signature against Google's published
 * keys, issuer, audience (our client id) and expiry. Returns the profile only if all of that holds.
 */
export async function verifyGoogleIdToken(idToken: string, clientId: string): Promise<GoogleProfile> {
  const bad = () => unauthorized('We could not verify your Google sign-in. Please try again.');
  const decoded = jwt.decode(idToken, { complete: true });
  const kid = decoded && typeof decoded === 'object' ? decoded.header.kid : undefined;
  if (!kid) throw bad();
  let key = (await signingKeys()).find((k) => k.kid === kid);
  if (!key) key = (await signingKeys(true)).find((k) => k.kid === kid);
  if (!key) throw bad();
  try {
    const claims = jwt.verify(idToken, createPublicKey({ key, format: 'jwk' }), {
      algorithms: ['RS256'],
      audience: clientId,
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
    }) as jwt.JwtPayload;
    if (!claims.sub || typeof claims.email !== 'string') throw bad();
    return {
      sub: claims.sub,
      email: claims.email.toLowerCase(),
      emailVerified: claims.email_verified === true || claims.email_verified === 'true',
      givenName: typeof claims.given_name === 'string' ? claims.given_name : undefined,
      name: typeof claims.name === 'string' ? claims.name : undefined,
    };
  } catch {
    throw bad();
  }
}
