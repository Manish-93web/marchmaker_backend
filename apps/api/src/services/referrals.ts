import type { Request } from 'express';
import type { Types } from 'mongoose';
import {
  DEFAULT_REFERRAL_SETTINGS,
  formatInr,
  referralSettingsSchema,
  type ReferralFlag,
  type ReferralSettings,
  type Role,
} from '@marchmaker/shared';
import { withTransaction } from '../db/connection';
import type { AppContext } from '../context';
import { audit } from '../lib/audit';
import { AppError, conflict, notFound } from '../lib/errors';
import { Outbox, Setting, User } from '../models/core';
import { Payment } from '../models/billing';
import { Referral } from '../models/referrals';
import * as wallet from './wallet';

const sid = (v: unknown) => String(v);
const STALE_UNVERIFIED_DAYS = 60;

interface Actor {
  userId: string;
  roles: Role[];
}

export async function getSettings(): Promise<ReferralSettings> {
  const row = await Setting.findOne({ key: 'referral' }).lean();
  return { ...DEFAULT_REFERRAL_SETTINGS, ...((row?.value as Partial<ReferralSettings> | undefined) ?? {}) };
}

export async function saveSettings(req: Request, value: unknown, actor: Actor) {
  const parsed = referralSettingsSchema.parse(value);
  const before = await getSettings();
  await Setting.updateOne({ key: 'referral' }, { $set: { value: parsed, updatedBy: actor.userId } }, { upsert: true });
  await audit(req, { action: 'referral.settings_changed', actorId: actor.userId, actorRoles: actor.roles, subjectType: 'setting', subjectId: 'referral', before, after: parsed });
  return parsed;
}

// ------------------------------------------------------------------ attribution

/**
 * Called at sign-up. A referral is always recorded, but signs of a self-referral send the
 * eventual reward to a person for review instead of paying it automatically.
 */
export async function attribute(
  ctx: AppContext,
  newUser: { id: Types.ObjectId | string; phoneHash?: string | null; ipHash?: string | null },
  referrerId: Types.ObjectId | string,
  code: string,
) {
  const settings = await getSettings();
  if (!settings.enabled) return null;
  if (sid(newUser.id) === sid(referrerId)) return null;
  const referrer = await User.findById(referrerId).select('status phoneHash signupIpHash').lean();
  if (!referrer || referrer.status !== 'active') return null;

  const flags: ReferralFlag[] = [];
  if (newUser.ipHash && referrer.signupIpHash && newUser.ipHash === referrer.signupIpHash) flags.push('same_network');
  if (newUser.phoneHash && referrer.phoneHash && newUser.phoneHash === referrer.phoneHash) flags.push('same_phone');
  try {
    const r = await Referral.create({ referrerId, refereeId: newUser.id, code, flags });
    return r;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return null;
    throw err;
  }
}

/** The invited member's first qualifying payment starts the hold period. Later payments change nothing. */
export async function onPayment(userId: Types.ObjectId | string, razorpayPaymentId: string, amountPaise: number) {
  const settings = await getSettings();
  if (!settings.enabled || amountPaise < settings.minPurchasePaise) return false;
  const pay = await Payment.findOne({ razorpayPaymentId }).select('_id').lean();
  if (!pay) return false;
  const now = new Date();
  const r = await Referral.findOneAndUpdate(
    { refereeId: userId, status: 'attributed' },
    {
      $set: {
        status: 'qualified',
        qualifiedAt: now,
        qualifyingPaymentId: pay._id,
        releaseAt: new Date(now.getTime() + settings.holdDays * 86_400_000),
        referrerRewardPaise: settings.referrerRewardPaise,
        refereeRewardPaise: settings.refereeRewardPaise,
      },
    },
    { new: true },
  );
  return Boolean(r);
}

// ------------------------------------------------------------------ payout

async function payout(referralId: Types.ObjectId | string, from: ('qualified' | 'review')[]): Promise<boolean> {
  return withTransaction(async (session) => {
    const r = await Referral.findOneAndUpdate(
      { _id: referralId, status: { $in: from } },
      { $set: { status: 'rewarded', rewardedAt: new Date() } },
      { new: true, session },
    );
    if (!r) return false;
    const pairs: [Types.ObjectId, number, string][] = [
      [r.referrerId, r.referrerRewardPaise ?? 0, 'referrer'],
      [r.refereeId, r.refereeRewardPaise ?? 0, 'referee'],
    ];
    for (const [userId, paise, who] of pairs) {
      if (paise <= 0) continue;
      await wallet.reward(userId, paise, r._id, who === 'referrer' ? 'Reward for inviting a friend' : 'Welcome reward', `referral:${r._id}:${who}`, session);
      await Outbox.create(
        [{ eventType: 'referral.rewarded', payload: { userId: sid(userId), referralId: sid(r._id), amountLabel: formatInr(paise) } }],
        { session },
      );
    }
    return true;
  });
}

/** Sweep: releases rewards whose hold has ended, after re-checking everything that could have changed. */
export async function releaseDue(now = new Date()) {
  const settings = await getSettings();
  const out = { rewarded: 0, rejected: 0, review: 0, waiting: 0 };
  const due = await Referral.find({ status: 'qualified', releaseAt: { $lte: now } }).limit(200);
  for (const r of due) {
    const reject = async (reason: string) => {
      await Referral.updateOne({ _id: r._id, status: 'qualified' }, { $set: { status: 'rejected', rejectedReason: reason } });
      out.rejected++;
    };
    const [pay, referrer, referee] = await Promise.all([
      Payment.findById(r.qualifyingPaymentId).select('refundedPaise status').lean(),
      User.findById(r.referrerId).select('status').lean(),
      User.findById(r.refereeId).select('status verification').lean(),
    ]);
    if (!pay || pay.refundedPaise > 0 || pay.status !== 'captured') {
      await reject('purchase_refunded');
      continue;
    }
    if (referrer?.status !== 'active' || !referee || ['banned', 'deleted', 'suspended'].includes(referee.status)) {
      await reject('ineligible');
      continue;
    }
    if (settings.requireVerifiedReferee && !referee.verification?.idVerifiedAt) {
      if (r.qualifiedAt && now.getTime() - r.qualifiedAt.getTime() > STALE_UNVERIFIED_DAYS * 86_400_000) await reject('not_verified');
      else out.waiting++;
      continue;
    }
    const earned = await Referral.countDocuments({ referrerId: r.referrerId, status: 'rewarded' });
    if (earned >= settings.maxRewardsPerReferrer) {
      await reject('cap_reached');
      continue;
    }
    if (r.flags.length) {
      await Referral.updateOne({ _id: r._id, status: 'qualified' }, { $set: { status: 'review' } });
      out.review++;
      continue;
    }
    if (await payout(r._id, ['qualified'])) out.rewarded++;
  }
  return out;
}

export async function decide(
  req: Request,
  id: string,
  input: { decision: 'approve' | 'reject'; note: string },
  actor: Actor,
) {
  const r = await Referral.findById(id);
  if (!r) throw notFound();
  if (r.status !== 'review') throw conflict('Only referrals waiting for review can be decided');
  if ([sid(r.referrerId), sid(r.refereeId)].includes(actor.userId)) {
    throw new AppError(403, 'FORBIDDEN', 'You cannot decide your own referral');
  }
  if (input.decision === 'approve') {
    if (!(await payout(r._id, ['review']))) throw conflict('This referral was already decided');
    await Referral.updateOne({ _id: r._id }, { $set: { decisionNote: input.note, decidedBy: actor.userId } });
  } else {
    const done = await Referral.updateOne(
      { _id: r._id, status: 'review' },
      { $set: { status: 'rejected', rejectedReason: 'reviewer_rejected', decisionNote: input.note, decidedBy: actor.userId } },
    );
    if (!done.modifiedCount) throw conflict('This referral was already decided');
  }
  await audit(req, {
    action: `referral.${input.decision}`,
    actorId: actor.userId,
    actorRoles: actor.roles,
    subjectType: 'referral',
    subjectId: id,
    after: { note: input.note },
  });
  return { id, status: input.decision === 'approve' ? 'rewarded' : 'rejected' };
}

// ------------------------------------------------------------------ read models

const FRIENDLY: Record<string, 'joined' | 'in_progress' | 'rewarded'> = {
  attributed: 'joined',
  qualified: 'in_progress',
  review: 'in_progress',
  rewarded: 'rewarded',
  rejected: 'joined',
};

export async function memberView(ctx: AppContext, userId: string) {
  const [settings, user, mine] = await Promise.all([
    getSettings(),
    User.findById(userId).select('referralCode walletBalancePaise').lean(),
    Referral.find({ referrerId: userId }).sort({ createdAt: -1 }).limit(100).lean(),
  ]);
  if (!user) throw notFound();
  const names = await User.find({ _id: { $in: mine.map((m) => m.refereeId) } }).select('firstName').lean();
  const byId = new Map(names.map((n) => [sid(n._id), n.firstName]));
  const asReferee = await Referral.findOne({ refereeId: userId }).lean();
  return {
    enabled: settings.enabled,
    code: user.referralCode ?? null,
    link: user.referralCode ? `${ctx.env.APP_URL}/register?ref=${user.referralCode}` : null,
    rules: {
      referrerRewardPaise: settings.referrerRewardPaise,
      refereeRewardPaise: settings.refereeRewardPaise,
      minPurchasePaise: settings.minPurchasePaise,
      holdDays: settings.holdDays,
      maxRewardsPerReferrer: settings.maxRewardsPerReferrer,
    },
    wallet: { balancePaise: user.walletBalancePaise ?? 0 },
    stats: {
      joined: mine.length,
      inProgress: mine.filter((m) => ['qualified', 'review'].includes(m.status)).length,
      rewarded: mine.filter((m) => m.status === 'rewarded').length,
      earnedPaise: mine.filter((m) => m.status === 'rewarded').reduce((s, m) => s + (m.referrerRewardPaise ?? 0), 0),
    },
    // Only a first name and a friendly state: nothing about why a referral was not paid.
    invited: mine.map((m) => ({ name: byId.get(sid(m.refereeId)) ?? 'A friend', state: FRIENDLY[m.status] ?? 'joined', at: m.createdAt })),
    mine: asReferee
      ? { state: FRIENDLY[asReferee.status] ?? 'joined', rewardPaise: asReferee.refereeRewardPaise ?? settings.refereeRewardPaise }
      : null,
  };
}

export async function adminList(status?: string) {
  const q: Record<string, unknown> = status && status !== 'all' ? { status } : { status: { $in: ['review', 'qualified'] } };
  const rows = await Referral.find(q).sort({ createdAt: -1 }).limit(200).lean();
  const users = await User.find({ _id: { $in: rows.flatMap((r) => [r.referrerId, r.refereeId]) } }).select('firstName email').lean();
  const byId = new Map(users.map((u) => [sid(u._id), u]));
  return {
    items: rows.map((r) => ({
      id: sid(r._id),
      status: r.status,
      flags: r.flags,
      referrer: { id: sid(r.referrerId), name: byId.get(sid(r.referrerId))?.firstName ?? 'Member', email: byId.get(sid(r.referrerId))?.email ?? null },
      referee: { id: sid(r.refereeId), name: byId.get(sid(r.refereeId))?.firstName ?? 'Member', email: byId.get(sid(r.refereeId))?.email ?? null },
      referrerRewardPaise: r.referrerRewardPaise ?? null,
      refereeRewardPaise: r.refereeRewardPaise ?? null,
      releaseAt: r.releaseAt ?? null,
      rejectedReason: r.rejectedReason ?? null,
      decisionNote: r.decisionNote ?? null,
      at: r.createdAt,
    })),
  };
}
