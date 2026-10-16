import type { ClientSession, Types } from 'mongoose';
import type { CreditLedgerType } from '@marchmaker/shared';
import { AppError } from '../lib/errors';
import { User } from '../models/core';
import { CreditLot } from '../models/billing';
import { CreditLedger } from '../models/social';
import { withTransaction } from '../db/connection';

type Id = Types.ObjectId | string;

interface Entry {
  userId: Id;
  type: CreditLedgerType;
  delta: number;
  heldDelta: number;
  reason?: string;
  introductionId?: Id;
  actorId?: Id;
  idempotencyKey?: string;
}

/**
 * Applies one ledger entry and updates the cached balance in the same transaction.
 * `guard` stops a balance from ever going negative: the update only matches if it can.
 */
async function apply(e: Entry, session: ClientSession): Promise<{ balance: number; held: number; duplicate?: boolean }> {
  if (e.idempotencyKey) {
    const dup = await CreditLedger.findOne({ idempotencyKey: e.idempotencyKey }).session(session).lean();
    if (dup) return { balance: dup.balanceAfter, held: dup.heldAfter, duplicate: true };
  }
  const filter: Record<string, unknown> = { _id: e.userId };
  if (e.delta < 0) filter.creditBalance = { $gte: -e.delta };
  if (e.heldDelta < 0) filter.creditsReserved = { $gte: -e.heldDelta };

  const user = await User.findOneAndUpdate(
    filter,
    { $inc: { creditBalance: e.delta, creditsReserved: e.heldDelta } },
    { returnDocument: 'after', session },
  );
  if (!user) throw new AppError(402, 'NO_CREDITS', 'You need an introduction credit for this');

  await CreditLedger.create(
    [
      {
        userId: e.userId,
        type: e.type,
        delta: e.delta,
        heldDelta: e.heldDelta,
        balanceAfter: user.creditBalance,
        heldAfter: user.creditsReserved,
        reason: e.reason,
        introductionId: e.introductionId,
        actorId: e.actorId,
        idempotencyKey: e.idempotencyKey,
      },
    ],
    { session },
  );
  return { balance: user.creditBalance, held: user.creditsReserved };
}

/** Takes credits out of lots, soonest-expiring first, so credits that would lapse are spent before ones that will not. */
async function drawLots(userId: Id, amount: number, session: ClientSession) {
  let need = amount;
  const lots = await CreditLot.find({ userId, remaining: { $gt: 0 }, expiredAt: { $exists: false } })
    .sort({ expiresAt: 1, createdAt: 1 })
    .session(session);
  // Lots without an expiry sort first in Mongo; spend dated lots first.
  lots.sort((a, b) => (a.expiresAt?.getTime() ?? Infinity) - (b.expiresAt?.getTime() ?? Infinity));
  for (const lot of lots) {
    if (need <= 0) break;
    const take = Math.min(need, lot.remaining);
    lot.remaining -= take;
    await lot.save({ session });
    need -= take;
  }
}

/** Holds one credit while an introduction is waiting on the other person. */
export async function reserve(userId: Id, introductionId: Id, session: ClientSession) {
  const out = await apply(
    { userId, type: 'reserve', delta: -1, heldDelta: 1, introductionId, reason: 'accepted introduction', idempotencyKey: `reserve:${introductionId}:${userId}` },
    session,
  );
  if (!out.duplicate) await drawLots(userId, 1, session);
  return out;
}

/** Gives a held credit back (declined, expired, blocked). It returns as a non-expiring lot. */
export async function release(userId: Id, introductionId: Id, reason: string, session: ClientSession) {
  const out = await apply(
    { userId, type: 'release', delta: 1, heldDelta: -1, introductionId, reason, idempotencyKey: `release:${introductionId}:${userId}` },
    session,
  );
  if (!out.duplicate) {
    await CreditLot.create([{ userId, source: 'admin', amount: 1, remaining: 1, ref: `release:${introductionId}:${userId}` }], { session });
  }
  return out;
}

/** Spends a held credit: both members accepted. */
export const consume = (userId: Id, introductionId: Id, session: ClientSession) =>
  apply(
    { userId, type: 'consume', delta: 0, heldDelta: -1, introductionId, reason: 'introduction unlocked', idempotencyKey: `consume:${introductionId}:${userId}` },
    session,
  );

export interface GrantOptions {
  actorId?: Id;
  /** Idempotency key: the same key never grants twice. */
  key?: string;
  source?: 'subscription' | 'pack' | 'admin' | 'referral';
  expiresAt?: Date;
  type?: CreditLedgerType;
}

export async function grant(userId: Id, amount: number, reason: string, session: ClientSession, actorId?: Id, key?: string, opts: Omit<GrantOptions, 'actorId' | 'key'> = {}) {
  const out = await apply({ userId, type: opts.type ?? 'grant', delta: amount, heldDelta: 0, reason, actorId, idempotencyKey: key }, session);
  if (!out.duplicate && amount > 0) {
    await CreditLot.create(
      [{ userId, source: opts.source ?? 'admin', amount, remaining: amount, expiresAt: opts.expiresAt, ref: key ? `lot:${key}` : undefined }],
      { session },
    );
  }
  return out;
}

/** Takes credits back after a refund, newest lots first. Never goes below zero. Returns how many were revoked. */
export async function revoke(userId: Id, amount: number, reason: string, key: string, session: ClientSession): Promise<number> {
  const user = await User.findById(userId).select('creditBalance').session(session);
  const n = Math.min(amount, user?.creditBalance ?? 0);
  if (n <= 0) return 0;
  const out = await apply({ userId, type: 'refund', delta: -n, heldDelta: 0, reason, idempotencyKey: key }, session);
  if (!out.duplicate) await drawLots(userId, n, session);
  return out.duplicate ? 0 : n;
}

/** Lapses credits whose lot has passed its expiry. Safe to run repeatedly and concurrently. */
export async function expireDueLots(now = new Date()): Promise<number> {
  const due = await CreditLot.find({ expiresAt: { $lte: now }, remaining: { $gt: 0 }, expiredAt: { $exists: false } }).limit(500).lean();
  let expired = 0;
  for (const lot of due) {
    try {
      await withTransaction(async (session) => {
        const fresh = await CreditLot.findOneAndUpdate(
          { _id: lot._id, remaining: { $gt: 0 }, expiredAt: { $exists: false } },
          { $set: { expiredAt: now, remaining: 0 } },
          { session },
        );
        if (!fresh) return;
        const user = await User.findById(lot.userId).select('creditBalance').session(session);
        const n = Math.min(fresh.remaining, user?.creditBalance ?? 0);
        if (n > 0) {
          await apply({ userId: lot.userId, type: 'expire', delta: -n, heldDelta: 0, reason: 'subscription credits expired', idempotencyKey: `expire:${lot._id}` }, session);
          expired += n;
        }
      });
    } catch {
      // A concurrent writer got there first; the next run picks it up.
    }
  }
  return expired;
}

export async function ledgerFor(userId: Id, limit = 50) {
  const rows = await CreditLedger.find({ userId }).sort({ createdAt: -1 }).limit(limit).lean();
  return rows.map((r) => ({
    id: String(r._id),
    type: r.type,
    delta: r.delta,
    held: r.heldDelta,
    balanceAfter: r.balanceAfter,
    reason: r.reason ?? null,
    at: r.createdAt,
  }));
}
