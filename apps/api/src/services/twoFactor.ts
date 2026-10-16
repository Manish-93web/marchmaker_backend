import { randomInt } from 'node:crypto';
import { verifySync } from 'otplib';
import type { AppContext } from '../context';
import { AppError, unauthorized } from '../lib/errors';
import { hmac } from '../lib/secrets';
import { User } from '../models/core';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const COUNT = 10;
// A code is valid for about 90 seconds with the allowed drift; remember it for longer than that.
const REPLAY_WINDOW_MS = 180_000;

const normalise = (code: string) => code.replace(/[\s-]/g, '').toUpperCase();
const recoveryHash = (ctx: AppContext, code: string) => hmac(ctx.env.JWT_REFRESH_SECRET, `recovery:${normalise(code)}`);
const codeHash = (ctx: AppContext, userId: string, code: string) => hmac(ctx.env.JWT_REFRESH_SECRET, `totp:${userId}:${code}`);

/** Ten one-time codes, 10 characters each (about 50 bits). Shown once; only keyed hashes are kept. */
function newRecoveryCodes(): string[] {
  return Array.from({ length: COUNT }, () => {
    const raw = Array.from({ length: 10 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

export async function storeRecoveryCodes(ctx: AppContext, userId: string): Promise<string[]> {
  const codes = newRecoveryCodes();
  await User.updateOne({ _id: userId }, { $set: { 'twoFactor.recoveryHashes': codes.map((c) => recoveryHash(ctx, c)) } });
  return codes;
}

export async function recoveryCodesLeft(userId: string): Promise<number> {
  const u = await User.findById(userId).select('+twoFactor.recoveryHashes').lean();
  return u?.twoFactor?.recoveryHashes?.length ?? 0;
}

/** Uses a recovery code exactly once. The pull is atomic, so two simultaneous logins cannot both succeed. */
export async function consumeRecoveryCode(ctx: AppContext, userId: string, code: string): Promise<number | null> {
  const h = recoveryHash(ctx, code);
  const u = await User.findOneAndUpdate(
    { _id: userId, 'twoFactor.recoveryHashes': h },
    { $pull: { 'twoFactor.recoveryHashes': h } },
    { returnDocument: 'after' },
  ).select('+twoFactor.recoveryHashes');
  return u ? (u.twoFactor?.recoveryHashes?.length ?? 0) : null;
}

/**
 * Verifies an authenticator code and refuses to accept the same one twice within its validity,
 * so a code seen over a shoulder or in a log cannot be replayed.
 */
export async function verifyTotpOnce(ctx: AppContext, userId: string, secretEnc: string, code: string): Promise<boolean> {
  const secret = ctx.crypto.decrypt(secretEnc);
  if (!verifySync({ token: code, secret, epochTolerance: 30 }).valid) return false;
  const h = codeHash(ctx, userId, code);
  const now = new Date();
  // Matches only if this exact code has not been accepted in the last few minutes; the push is
  // in the same atomic update, so two simultaneous attempts with one code cannot both pass.
  const r = await User.updateOne(
    {
      _id: userId,
      'twoFactor.recentCodes': { $not: { $elemMatch: { h, at: { $gte: new Date(now.getTime() - REPLAY_WINDOW_MS) } } } },
    },
    { $push: { 'twoFactor.recentCodes': { $each: [{ h, at: now }], $slice: -8 } } },
  );
  return r.matchedCount === 1;
}

export async function regenerate(ctx: AppContext, userId: string, code: string): Promise<string[]> {
  const u = await User.findById(userId).select('+twoFactor.secretEnc twoFactor.enabled');
  if (!u?.twoFactor?.enabled || !u.twoFactor.secretEnc) throw new AppError(409, 'CONFLICT', 'Two-factor authentication is not enabled');
  if (!(await verifyTotpOnce(ctx, userId, u.twoFactor.secretEnc, code))) throw unauthorized('That code is incorrect');
  return storeRecoveryCodes(ctx, userId);
}
