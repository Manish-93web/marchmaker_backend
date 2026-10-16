import type { ClientSession, Types } from 'mongoose';
import type { WalletEntryType } from '@marchmaker/shared';
import { AppError } from '../lib/errors';
import { User } from '../models/core';
import { WalletLedger } from '../models/referrals';

type Id = Types.ObjectId | string;

interface Entry {
  userId: Id;
  type: WalletEntryType;
  delta: number;
  reason?: string;
  orderId?: Id;
  referralId?: Id;
  actorId?: Id;
  key?: string;
}

/**
 * One ledger entry plus the cached balance, in the caller's transaction. A debit only matches
 * when the balance can cover it, so the wallet can never go negative.
 */
async function apply(e: Entry, session: ClientSession): Promise<{ balance: number; duplicate?: boolean }> {
  if (e.key) {
    const dup = await WalletLedger.findOne({ idempotencyKey: e.key }).session(session).lean();
    if (dup) return { balance: dup.balanceAfterPaise, duplicate: true };
  }
  const filter: Record<string, unknown> = { _id: e.userId };
  if (e.delta < 0) filter.walletBalancePaise = { $gte: -e.delta };
  const user = await User.findOneAndUpdate(filter, { $inc: { walletBalancePaise: e.delta } }, { returnDocument: 'after', session });
  if (!user) throw new AppError(402, 'WALLET_INSUFFICIENT', 'Your wallet does not have enough for that');
  await WalletLedger.create(
    [
      {
        userId: e.userId,
        type: e.type,
        deltaPaise: e.delta,
        balanceAfterPaise: user.walletBalancePaise,
        reason: e.reason,
        orderId: e.orderId,
        referralId: e.referralId,
        actorId: e.actorId,
        idempotencyKey: e.key,
      },
    ],
    { session },
  );
  return { balance: user.walletBalancePaise };
}

export const reward = (userId: Id, paise: number, referralId: Id, reason: string, key: string, session: ClientSession) =>
  apply({ userId, type: 'reward', delta: paise, referralId, reason, key }, session);

export const spend = (userId: Id, paise: number, orderId: Id, session: ClientSession) =>
  apply({ userId, type: 'spend', delta: -paise, orderId, reason: 'Used on an introduction pack', key: `wallet-spend:${orderId}` }, session);

/** Returns what an unpaid order had reserved. */
export const release = (userId: Id, paise: number, orderId: Id, session: ClientSession) =>
  apply({ userId, type: 'release', delta: paise, orderId, reason: 'Returned from an unfinished order', key: `wallet-release:${orderId}` }, session);

export const adjust = (userId: Id, delta: number, reason: string, actorId: Id, session: ClientSession) =>
  apply({ userId, type: 'adjust', delta, reason, actorId }, session);

export async function ledgerFor(userId: Id, limit = 50) {
  const rows = await WalletLedger.find({ userId }).sort({ _id: -1 }).limit(limit).lean();
  return rows.map((r) => ({
    id: String(r._id),
    type: r.type,
    deltaPaise: r.deltaPaise,
    balanceAfterPaise: r.balanceAfterPaise,
    reason: r.reason ?? null,
    at: r.createdAt,
  }));
}
