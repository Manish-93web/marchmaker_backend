import { ASTROLOGY_DISCLAIMER, birthDetailsSchema, type BirthDetails } from '@marchmaker/shared';
import { Types } from 'mongoose';
import type { AppContext } from '../context';
import { AppError, conflict, notFound } from '../lib/errors';
import { User } from '../models/core';
import { AstroProfile, AstroReport } from '../models/extras';
import { currentConsents } from './legal';
import { load, other } from './introductions';

const sid = (v: unknown) => String(v);
type Cached = { sample?: boolean | null; payload?: unknown } | null;

function provider(ctx: AppContext) {
  if (!ctx.astrology) throw new AppError(503, 'ASTROLOGY_UNAVAILABLE', 'Astrology reports are not available right now');
  return ctx.astrology;
}

/** Consent, plan and details are checked every time, so withdrawing any of them stops everything at once. */
async function assertEligible(userId: string) {
  const [user, consents] = await Promise.all([User.findById(userId).select('plan dobEnc').lean(), currentConsents(userId)]);
  if (!user) throw notFound();
  if (consents.astrology?.granted !== true) throw new AppError(403, 'CONSENT_REQUIRED', 'Please agree to astrology readings first');
  if (!['premium', 'concierge'].includes(user.plan?.planCode ?? 'free')) {
    throw new AppError(402, 'PREMIUM_ONLY', 'Astrology reports are part of the Premium plan');
  }
  return user;
}

async function birthOf(ctx: AppContext, userId: string): Promise<BirthDetails | null> {
  const p = await AstroProfile.findOne({ userId }).lean();
  if (!p) return null;
  return birthDetailsSchema.parse(JSON.parse(ctx.crypto.decrypt(p.birthEnc)));
}

export async function status(ctx: AppContext, userId: string) {
  const [p, consents] = await Promise.all([AstroProfile.findOne({ userId }).lean(), currentConsents(userId)]);
  const birth = p ? await birthOf(ctx, userId) : null;
  return {
    available: Boolean(ctx.astrology),
    consent: consents.astrology?.granted === true,
    hasDetails: Boolean(p),
    place: birth?.place ?? null,
    shareWithMatches: p?.shareWithMatches ?? false,
    disclaimer: ASTROLOGY_DISCLAIMER,
  };
}

export async function saveDetails(ctx: AppContext, userId: string, birth: BirthDetails, shareWithMatches: boolean) {
  await assertEligible(userId);
  await AstroProfile.updateOne(
    { userId },
    { $set: { birthEnc: ctx.crypto.encrypt(JSON.stringify(birth)), shareWithMatches } },
    { upsert: true },
  );
  // Details changed, so earlier readings no longer apply.
  await AstroReport.deleteMany({ userId, kind: 'kundli' });
  return status(ctx, userId);
}

/** Removes birth details and every reading that used them. */
export async function erase(userId: string) {
  // A match reading used both people's details, so it goes when either of them withdraws.
  await Promise.all([AstroProfile.deleteOne({ userId }), AstroReport.deleteMany({ $or: [{ userId }, { memberIds: userId }] })]);
  return { deleted: true };
}

export async function myReport(ctx: AppContext, userId: string) {
  const user = await assertEligible(userId);
  const birth = await birthOf(ctx, userId);
  if (!birth) throw conflict('Add your birth details first');
  const prov = provider(ctx);
  let r: Cached = await AstroReport.findOne({ userId, kind: 'kundli' }).lean();
  if (!r) {
    const dob = ctx.crypto.decrypt(user.dobEnc);
    const chart = await prov.chart({ dob, birth });
    r = (await AstroReport.create({ userId, kind: 'kundli', provider: prov.name, sample: prov.sample, payload: chart })).toObject();
  }
  return { kind: 'kundli' as const, sample: Boolean(r?.sample), chart: r?.payload, disclaimer: ASTROLOGY_DISCLAIMER };
}

/**
 * A compatibility reading for an unlocked introduction, only when both people have agreed. It is
 * cached once per introduction and shown to both. It plays no part in matching.
 */
export async function matchReport(ctx: AppContext, introId: string, userId: string) {
  await assertEligible(userId);
  const intro = await load(introId, userId);
  if (intro.state !== 'mutually_accepted') throw conflict('Readings are available once you have both accepted');
  const otherId = sid(other(intro, userId).userId);
  // The other person's agreement is checked with the same strictness as the member's own.
  await assertEligible(otherId).catch(() => {
    throw new AppError(409, 'MATCH_NOT_READY', 'A reading needs both of you to have agreed and added birth details');
  });
  const [mine, theirs, a, b] = await Promise.all([
    AstroProfile.findOne({ userId }).lean(),
    AstroProfile.findOne({ userId: otherId }).lean(),
    User.findById(userId).select('dobEnc').lean(),
    User.findById(otherId).select('dobEnc').lean(),
  ]);
  if (!mine?.shareWithMatches || !theirs?.shareWithMatches || !a || !b) {
    throw new AppError(409, 'MATCH_NOT_READY', 'A reading needs both of you to have agreed and added birth details');
  }
  const prov = provider(ctx);
  const existing = await AstroReport.findOne({ introductionId: intro._id, kind: 'match' }).lean();
  let report: Cached = existing;
  if (!report) {
    const result = await prov.match(
      { dob: ctx.crypto.decrypt(a.dobEnc), birth: (await birthOf(ctx, userId))! },
      { dob: ctx.crypto.decrypt(b.dobEnc), birth: (await birthOf(ctx, otherId))! },
    );
    try {
      report = (
        await AstroReport.create({ userId, memberIds: [userId, otherId], introductionId: new Types.ObjectId(introId), kind: 'match', provider: prov.name, sample: prov.sample, payload: result })
      ).toObject();
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      report = await AstroReport.findOne({ introductionId: intro._id, kind: 'match' }).lean();
    }
  }
  return { kind: 'match' as const, sample: Boolean(report?.sample), result: report?.payload, disclaimer: ASTROLOGY_DISCLAIMER };
}
