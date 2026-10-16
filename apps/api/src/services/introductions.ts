import { Types } from 'mongoose';
import {
  DEFAULTS,
  NEUTRAL_ENDING,
  ageOn,
  firstNoteProblems,
  introductionMachine,
  isTerminalIntro,
  type DeclineReason,
  type IntroState,
} from '@marchmaker/shared';
import type { AppContext } from '../context';
import { withTransaction } from '../db/connection';
import { emit } from '../lib/audit';
import { AppError, conflict, notFound } from '../lib/errors';
import { User } from '../models/core';
import { Block, Introduction } from '../models/matching';
import { Photo, Profile } from '../models/profile';
import { MessageThread } from '../models/social';
import * as credits from './credits';

type IntroDoc = NonNullable<Awaited<ReturnType<typeof Introduction.findOne>>>;

const OPEN: IntroState[] = ['released', 'viewed', 'accepted_by_one'];
const sid = (v: unknown) => String(v);

function mine(intro: IntroDoc, userId: string) {
  const m = intro.members.find((x) => sid(x.userId) === userId);
  if (!m) throw notFound('Introduction not found');
  return m;
}
export function other(intro: IntroDoc, userId: string) {
  return intro.members.find((x) => sid(x.userId) !== userId)!;
}

export async function load(introId: string, userId: string): Promise<IntroDoc> {
  if (!Types.ObjectId.isValid(introId)) throw notFound('Introduction not found');
  const intro = await Introduction.findOne({ _id: introId, 'members.userId': userId });
  if (!intro) throw notFound('Introduction not found');
  const otherId = sid(other(intro, userId).userId);
  // Mutual invisibility: a blocked introduction disappears for both people.
  const blocked = await Block.exists({
    $or: [
      { blockerId: userId, blockedId: otherId },
      { blockerId: otherId, blockedId: userId },
    ],
  });
  if (blocked) throw notFound('Introduction not found');
  return intro;
}

/** What each member is waiting on, expressed from their own point of view. */
function waitingOn(intro: IntroDoc, userId: string): 'you' | 'them' | 'none' {
  if (isTerminalIntro(intro.state as IntroState)) return 'none';
  return mine(intro, userId).status === 'pending' ? 'you' : 'them';
}

export async function present(ctx: AppContext, intro: IntroDoc, userId: string) {
  const o = other(intro, userId);
  const me = mine(intro, userId);
  const [user, profile, me2, photo] = await Promise.all([
    User.findById(o.userId).select('firstName dobYear verification phoneVerifiedAt emailVerifiedAt').lean(),
    Profile.findOne({ userId: o.userId }).lean(),
    User.findById(userId).select('creditBalance creditsReserved').lean(),
    Photo.findOne({ userId: o.userId, status: 'approved' }).sort({ isPrimary: -1, order: 1 }).lean(),
  ]);
  const d = ((profile?.data ?? {}) as Record<string, Record<string, unknown> | undefined>) ?? {};
  const unlocked = intro.state === 'mutually_accepted';
  const state = intro.state as IntroState;

  const blur = photo?.variants?.blur
    ? await ctx.storage.presignGet('photos', photo.variants.blur, DEFAULTS.signedUrlTtlSec)
    : null;
  const thread = unlocked ? await MessageThread.findOne({ introductionId: intro._id }).select('_id status').lean() : null;

  const declinedOrExpired = state === 'declined' || state === 'expired';
  return {
    id: sid(intro._id),
    state,
    waitingOn: waitingOn(intro, userId),
    myStatus: me.status,
    expiresAt: intro.expiresAt,
    releasedAt: intro.releasedAt,
    unlockedAt: intro.unlockedAt ?? null,
    // The other member's response stays private until both have accepted.
    endedMessage: declinedOrExpired ? NEUTRAL_ENDING : null,
    why: intro.whyText,
    highlights: intro.highlights ?? [],
    person: {
      firstName: user?.firstName ?? '',
      age: user?.dobYear ? new Date().getUTCFullYear() - user.dobYear : null,
      city: (d.background?.city as string | undefined) ?? null,
      state: (d.background?.state as string | undefined) ?? null,
      profession: (d.education_career?.profession as string | undefined) ?? null,
      education: (d.education_career?.highestEducation as string | undefined) ?? null,
      prompts: (Array.isArray(d.about?.prompts) ? d.about?.prompts : []) as { promptId: string; answer: string }[],
      bio: unlocked ? ((d.about?.bio as string | undefined) ?? null) : null,
      badges: {
        id: !!user?.verification?.idVerifiedAt,
        selfie: !!user?.verification?.selfieVerifiedAt,
        phone: !!user?.phoneVerifiedAt,
        email: !!user?.emailVerifiedAt,
      },
      blurredPhoto: blur,
    },
    credits: {
      available: me2?.creditBalance ?? 0,
      held: me2?.creditsReserved ?? 0,
      // A credit is only spent when you both say yes; it is held until then and returned otherwise.
      needsCredit: me.status === 'pending' && !isTerminalIntro(state) && (me2?.creditBalance ?? 0) < 1,
    },
    firstNoteFromThem: unlocked ? (o.firstNote ?? null) : null,
    myFirstNote: me.firstNote ?? null,
    contact: { iShared: me.contactShared, theyShared: o.contactShared },
    voice: unlocked ? { iOptIn: !!me.voiceOptIn, theyOptIn: !!o.voiceOptIn } : null,
    threadId: thread ? sid(thread._id) : null,
  };
}

export async function list(ctx: AppContext, userId: string) {
  const intros = await Introduction.find({ 'members.userId': userId }).sort({ releasedAt: -1 }).limit(50);
  const blockedIds = await blockedWith(userId);
  const visible = intros.filter((i) => !blockedIds.has(sid(other(i, userId).userId)));
  return Promise.all(visible.map((i) => present(ctx, i, userId)));
}

async function blockedWith(userId: string): Promise<Set<string>> {
  const rows = await Block.find({ $or: [{ blockerId: userId }, { blockedId: userId }] }).lean();
  return new Set(rows.map((b) => (sid(b.blockerId) === userId ? sid(b.blockedId) : sid(b.blockerId))));
}

export async function open(ctx: AppContext, introId: string, userId: string) {
  let intro = await load(introId, userId);
  const me = mine(intro, userId);
  if (!me.viewedAt) {
    const set: Record<string, unknown> = { 'members.$[m].viewedAt': new Date() };
    if (intro.state === 'released') set.state = 'viewed';
    await Introduction.updateOne({ _id: intro._id }, { $set: set }, { arrayFilters: [{ 'm.userId': new Types.ObjectId(userId) }] });
    intro = (await Introduction.findById(intro._id))!;
  }
  return present(ctx, intro, userId);
}

// ------------------------------------------------------------------ accept

export async function accept(ctx: AppContext, introId: string, userId: string, firstNote: string) {
  const problems = firstNoteProblems(firstNote);
  if (problems.length) throw new AppError(422, 'FIRST_NOTE_INVALID', problems[0]!, { problems });

  const result = await withTransaction(async (session) => {
    const intro = await Introduction.findOne({ _id: introId, 'members.userId': userId }).session(session);
    if (!intro) throw notFound('Introduction not found');
    const state = intro.state as IntroState;
    if (isTerminalIntro(state)) throw conflict('This introduction is no longer open');
    if (intro.expiresAt <= new Date()) throw conflict('This introduction has expired');
    const me = mine(intro, userId);
    if (me.status !== 'pending') throw conflict('You have already responded to this introduction');

    const otherId = sid(other(intro, userId).userId);
    const blocked = await Block.exists({
      $or: [
        { blockerId: userId, blockedId: otherId },
        { blockerId: otherId, blockedId: userId },
      ],
    }).session(session);
    if (blocked) throw notFound('Introduction not found');

    // Holds a credit now; fails with 402 (and rolls everything back) when there is none.
    await credits.reserve(userId, intro._id, session);

    const now = new Date();
    me.status = 'accepted';
    me.firstNote = firstNote.trim();
    me.respondedAt = now;

    const theirs = other(intro, userId);
    if (theirs.status === 'accepted') {
      introductionMachine.assertTransition('accepted_by_one', 'mutually_accepted');
      intro.state = 'mutually_accepted';
      intro.unlockedAt = now;
      await credits.consume(userId, intro._id, session);
      await credits.consume(theirs.userId, intro._id, session);
      await MessageThread.create(
        [{ introductionId: intro._id, members: intro.members.map((m) => m.userId), status: 'open', lastRead: {} }],
        { session },
      );
      await intro.save({ session });
      return { unlocked: true, introId: sid(intro._id), members: intro.members.map((m) => sid(m.userId)) };
    }

    intro.state = 'accepted_by_one';
    await intro.save({ session });
    return { unlocked: false, introId: sid(intro._id), members: [] as string[] };
  });

  if (result.unlocked) {
    for (const uid of result.members) await emit('introduction.unlocked', { userId: uid, introductionId: result.introId });
  } else {
    await emit('introduction.accepted_by_one', { introductionId: result.introId, byUserId: userId });
  }
  const fresh = await load(introId, userId);
  return present(ctx, fresh, userId);
}

// ------------------------------------------------------------------ decline

export async function decline(
  ctx: AppContext,
  introId: string,
  userId: string,
  input: { reason?: DeclineReason; note?: string },
) {
  const out = await withTransaction(async (session) => {
    const intro = await Introduction.findOne({ _id: introId, 'members.userId': userId }).session(session);
    if (!intro) throw notFound('Introduction not found');
    if (isTerminalIntro(intro.state as IntroState)) throw conflict('This introduction is no longer open');
    const me = mine(intro, userId);
    if (me.status === 'declined') throw conflict('You have already declined');

    // Capture who holds a credit before any status changes, including the person declining now.
    const holding = intro.members.filter((m) => m.status === 'accepted').map((m) => m.userId);

    const now = new Date();
    me.status = 'declined';
    me.respondedAt = now;
    me.declineReason = input.reason;
    me.declineNote = input.note;
    intro.state = 'declined';
    intro.closedReason = 'declined';

    for (const uid of holding) await credits.release(uid, intro._id, 'introduction declined', session);
    await intro.save({ session });
    return { otherId: sid(other(intro, userId).userId), introId: sid(intro._id) };
  });
  // The other person is told only that it did not move forward: no reason, no name.
  await emit('introduction.declined', { userId: out.otherId, introductionId: out.introId });
  const fresh = await Introduction.findById(introId);
  return present(ctx, fresh!, userId);
}

// ------------------------------------------------------------------ expiry and reminders

export interface ExpirySummary {
  expired: number;
  reminded: number;
}

/** Expires lapsed introductions (returning held credits) and sends the 48 h and 12 h reminders once each. */
export async function expireAndRemind(now: Date = new Date()): Promise<ExpirySummary> {
  let expired = 0;
  let reminded = 0;

  const lapsed = await Introduction.find({ state: { $in: OPEN }, expiresAt: { $lte: now } }).limit(200);
  for (const i of lapsed) {
    const ok = await withTransaction(async (session) => {
      const intro = await Introduction.findOne({ _id: i._id, state: { $in: OPEN } }).session(session);
      if (!intro) return false;
      intro.state = 'expired';
      intro.closedReason = 'expired';
      for (const m of intro.members) {
        if (m.status === 'accepted') await credits.release(m.userId, intro._id, 'introduction expired', session);
      }
      await intro.save({ session });
      return true;
    });
    if (ok) {
      expired++;
      for (const m of i.members) await emit('introduction.expired', { userId: sid(m.userId), introductionId: sid(i._id) });
    }
  }

  for (const hours of DEFAULTS.introReminderHours) {
    const cutoff = new Date(now.getTime() + hours * 3_600_000);
    const due = await Introduction.find({
      state: { $in: OPEN },
      expiresAt: { $lte: cutoff, $gt: now },
      remindersSent: { $ne: hours },
    }).limit(200);
    for (const i of due) {
      // The marker is claimed first so a second worker cannot send the same reminder.
      const claimed = await Introduction.findOneAndUpdate(
        { _id: i._id, remindersSent: { $ne: hours } },
        { $push: { remindersSent: hours } },
      );
      if (!claimed) continue;
      for (const m of i.members.filter((x) => x.status === 'pending')) {
        await emit('introduction.reminder', { userId: sid(m.userId), introductionId: sid(i._id), hoursLeft: hours });
        reminded++;
      }
    }
  }
  return { expired, reminded };
}

// ------------------------------------------------------------------ contact sharing and photos

export async function shareContact(ctx: AppContext, introId: string, userId: string) {
  const intro = await load(introId, userId);
  if (intro.state !== 'mutually_accepted') throw conflict('You can share contact details once you have both accepted');
  await Introduction.updateOne(
    { _id: intro._id },
    { $set: { 'members.$[m].contactShared': true } },
    { arrayFilters: [{ 'm.userId': new Types.ObjectId(userId) }] },
  );
  const fresh = (await Introduction.findById(intro._id))!;
  const both = fresh.members.every((m) => m.contactShared);
  if (both) await emit('introduction.contact_shared', { introductionId: sid(fresh._id) });
  return present(ctx, fresh, userId);
}

/** Phone and email appear only when BOTH members have chosen to share. */
export async function contactDetails(ctx: AppContext, introId: string, userId: string) {
  const intro = await load(introId, userId);
  if (intro.state !== 'mutually_accepted' || !intro.members.every((m) => m.contactShared)) {
    throw new AppError(403, 'FORBIDDEN', 'Contact details are shared only when you both choose to');
  }
  const o = other(intro, userId);
  const u = await User.findById(o.userId).select('firstName email phoneEnc').lean();
  return {
    firstName: u?.firstName ?? '',
    email: u?.email ?? null,
    phone: u?.phoneEnc ? ctx.crypto.decrypt(u.phoneEnc) : null,
  };
}

export async function revealedPhotos(ctx: AppContext, introId: string, userId: string) {
  const intro = await load(introId, userId);
  if (intro.state !== 'mutually_accepted') throw new AppError(403, 'FORBIDDEN', 'Photos open once you have both accepted');
  const o = other(intro, userId);
  const photos = await Photo.find({ userId: o.userId, status: 'approved' }).sort({ isPrimary: -1, order: 1 }).lean();
  const items = await Promise.all(
    photos.map(async (p) => ({
      id: sid(p._id),
      // Short-lived and never public. The client overlays the watermark below.
      url: p.variants?.lg ? await ctx.storage.presignGet('photos', p.variants.lg, DEFAULTS.signedUrlTtlSec) : null,
      thumb: p.variants?.sm ? await ctx.storage.presignGet('photos', p.variants.sm, DEFAULTS.signedUrlTtlSec) : null,
    })),
  );
  return { items: items.filter((i) => i.url), watermark: `Marchmaker · ${userId.slice(-6)}`, expiresInSeconds: DEFAULTS.signedUrlTtlSec };
}

export { ageOn };
