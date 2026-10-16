import { Types } from 'mongoose';
import { CALL_DAILY_LIMIT, callWindowOpen } from '@marchmaker/shared';
import type { AppContext } from '../context';
import { AppError, conflict } from '../lib/errors';
import type { CallEvent } from '../lib/telephony';
import { User } from '../models/core';
import { Introduction } from '../models/matching';
import { CallLog } from '../models/extras';
import { load, other } from './introductions';

const sid = (v: unknown) => String(v);
const DAY = 86_400_000;

export async function setOptIn(introId: string, userId: string, open: boolean) {
  const intro = await load(introId, userId);
  if (intro.state !== 'mutually_accepted') throw conflict('Voice calls open once you have both accepted');
  await Introduction.updateOne(
    { _id: intro._id },
    { $set: { 'members.$[m].voiceOptIn': open } },
    { arrayFilters: [{ 'm.userId': new Types.ObjectId(userId) }] },
  );
  const fresh = (await Introduction.findById(intro._id))!;
  const me = fresh.members.find((m) => sid(m.userId) === userId)!;
  const o = other(fresh, userId);
  return { iOptIn: !!me.voiceOptIn, theyOptIn: !!o.voiceOptIn };
}

/**
 * Places a call between two members who both chose it. Numbers never leave the server: the provider
 * rings the caller first and then bridges the other person, both seeing the platform's number.
 */
export async function startCall(ctx: AppContext, introId: string, userId: string, now = new Date()) {
  if (!ctx.calls) throw new AppError(503, 'CALLS_UNAVAILABLE', 'Calling is not available right now');
  const intro = await load(introId, userId);
  if (intro.state !== 'mutually_accepted') throw conflict('Voice calls open once you have both accepted');
  const me = intro.members.find((m) => sid(m.userId) === userId)!;
  const o = other(intro, userId);
  if (!me.voiceOptIn || !o.voiceOptIn) throw new AppError(409, 'VOICE_NOT_AGREED', 'Calls need both of you to say you are open to them');
  if (!callWindowOpen(now)) throw new AppError(409, 'OUTSIDE_CALL_HOURS', 'Calls can be placed between 9 am and 9 pm India time');

  const recent = await CallLog.countDocuments({ introductionId: intro._id, createdAt: { $gte: new Date(now.getTime() - DAY) } });
  if (recent >= CALL_DAILY_LIMIT) throw new AppError(429, 'CALL_LIMIT', 'You have reached the daily call limit for this introduction');

  const [a, b] = await Promise.all([
    User.findById(userId).select('phoneEnc phoneVerifiedAt status').lean(),
    User.findById(o.userId).select('phoneEnc phoneVerifiedAt status').lean(),
  ]);
  if (!a?.phoneEnc || !a.phoneVerifiedAt) throw new AppError(409, 'PHONE_NOT_VERIFIED', 'Verify your mobile number to make calls');
  // The other person's situation is not explained: only that the call cannot be placed.
  if (!b?.phoneEnc || !b.phoneVerifiedAt || b.status !== 'active') throw new AppError(409, 'CALL_UNAVAILABLE', 'This call cannot be placed right now');

  const log = await CallLog.create({ introductionId: intro._id, initiatedBy: userId });
  try {
    const { providerCallId } = await ctx.calls.connect({
      fromE164: ctx.crypto.decrypt(a.phoneEnc),
      toE164: ctx.crypto.decrypt(b.phoneEnc),
      reference: sid(log._id),
    });
    await CallLog.updateOne({ _id: log._id }, { $set: { providerCallId } });
  } catch (err) {
    ctx.log.warn({ err }, 'call could not be placed');
    await CallLog.updateOne({ _id: log._id }, { $set: { status: 'failed' } });
    throw new AppError(502, 'CALL_FAILED', 'We could not place the call. Please try again in a moment.');
  }
  return { status: 'initiated' as const, remainingToday: Math.max(0, CALL_DAILY_LIMIT - recent - 1) };
}

/** Provider status callbacks. Out-of-order or repeated events never move a finished call backwards. */
export async function applyEvent(e: CallEvent) {
  const rank = { initiated: 0, ringing: 1, in_progress: 2, completed: 3, failed: 3, no_answer: 3, busy: 3 } as const;
  const log = await CallLog.findOne({ providerCallId: e.providerCallId });
  if (!log) return false;
  if (rank[log.status as keyof typeof rank] >= 3) return true;
  if (rank[e.status] < rank[log.status as keyof typeof rank]) return true;
  log.status = e.status;
  if (e.durationSec !== undefined) log.durationSec = Math.min(e.durationSec, 4 * 3600);
  await log.save();
  return true;
}

export async function history(introId: string, userId: string) {
  const intro = await load(introId, userId);
  const rows = await CallLog.find({ introductionId: intro._id }).sort({ createdAt: -1 }).limit(20).lean();
  // Only when, who started it and how it went: never a number.
  return {
    items: rows.map((c) => ({ at: c.createdAt, byMe: sid(c.initiatedBy) === userId, status: c.status, durationSec: c.durationSec ?? null })),
  };
}
