import argon2 from 'argon2';

// OWASP-recommended argon2id parameters (19 MiB, t=2, p=1).
const OPTS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (plain: string) => argon2.hash(plain, OPTS);

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

/** A real hash to verify against when the account does not exist, so timing does not reveal it. */
let dummy: Promise<string> | undefined;
export const dummyHash = () => (dummy ??= argon2.hash('not-a-real-password', OPTS));
