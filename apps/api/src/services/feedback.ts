import { preferenceHints, tallyReasons, type FeedbackTag } from '@marchmaker/shared';
import { Types } from 'mongoose';
import { emit } from '../lib/audit';
import { conflict, notFound } from '../lib/errors';
import { CheckinMarker, IntroFeedback } from '../models/growth';
import { Introduction } from '../models/matching';

const DAY = 86_400_000;
const CHECKIN_AFTER_DAYS = 7;
const CHECKIN_WINDOW_DAYS = 45;
const sid = (v: unknown) => String(v);

/** Feedback is about an introduction the member really took part in and that unlocked. */
export async function submit(userId: string, input: { introductionId: string; rating: number; tags: FeedbackTag[]; note?: string }) {
  const intro = await Introduction.findOne({ _id: input.introductionId, 'members.userId': userId, state: 'mutually_accepted' }).select('_id').lean();
  if (!intro) throw notFound('Introduction not found');
  try {
    await IntroFeedback.create({ introductionId: intro._id, userId, rating: input.rating, tags: input.tags, note: input.note });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw conflict('You have already shared how this went. Thank you.');
    throw err;
  }
  return { received: true };
}

/** Introductions that unlocked a while ago and have not been reviewed by this member. */
export async function pending(userId: string, now = new Date()) {
  const intros = await Introduction.find({
    'members.userId': userId,
    state: 'mutually_accepted',
    unlockedAt: { $lte: new Date(now.getTime() - CHECKIN_AFTER_DAYS * DAY), $gte: new Date(now.getTime() - CHECKIN_WINDOW_DAYS * DAY) },
  })
    .select('_id unlockedAt')
    .lean();
  if (!intros.length) return { items: [] };
  const done = await IntroFeedback.find({ userId, introductionId: { $in: intros.map((i) => i._id) } }).select('introductionId').lean();
  const doneIds = new Set(done.map((d) => sid(d.introductionId)));
  return { items: intros.filter((i) => !doneIds.has(sid(i._id))).map((i) => ({ introductionId: sid(i._id), unlockedAt: i.unlockedAt })) };
}

/** Once per member per introduction, a week after unlock. The marker makes retries and overlapping runs harmless. */
export async function sendCheckIns(now = new Date()): Promise<number> {
  const intros = await Introduction.find({
    state: 'mutually_accepted',
    unlockedAt: { $lte: new Date(now.getTime() - CHECKIN_AFTER_DAYS * DAY), $gte: new Date(now.getTime() - CHECKIN_WINDOW_DAYS * DAY) },
  })
    .select('_id members.userId')
    .limit(500)
    .lean();
  let sent = 0;
  for (const i of intros) {
    for (const m of i.members) {
      if (await IntroFeedback.exists({ introductionId: i._id, userId: m.userId })) continue;
      try {
        await CheckinMarker.create({ introductionId: i._id, userId: m.userId });
      } catch (err) {
        if ((err as { code?: number }).code === 11000) continue;
        throw err;
      }
      await emit('feedback.checkin', { userId: sid(m.userId), introductionId: sid(i._id) });
      sent++;
    }
  }
  return sent;
}

async function declineReasons(userId: string, since: Date) {
  const rows = await Introduction.find({
    members: { $elemMatch: { userId: new Types.ObjectId(userId), status: 'declined' } },
    updatedAt: { $gte: since },
  })
    .select('members')
    .lean();
  return rows.flatMap((r) => r.members.filter((m) => sid(m.userId) === userId && m.status === 'declined').map((m) => m.declineReason));
}

/** Patterns in a member's own declines, offered back to them as a suggestion. Never changes anything by itself. */
export async function hints(userId: string) {
  const tally = tallyReasons(await declineReasons(userId, new Date(Date.now() - 180 * DAY)));
  return { items: preferenceHints(tally) };
}

/** Staff view of the same signals plus ratings, to help a matchmaker choose better. */
export async function memberInsight(userId: string) {
  const [reasons, feedback] = await Promise.all([
    declineReasons(userId, new Date(Date.now() - 365 * DAY)),
    IntroFeedback.find({ userId }).sort({ createdAt: -1 }).limit(20).lean(),
  ]);
  const tally = tallyReasons(reasons);
  const avg = feedback.length ? Math.round((feedback.reduce((s, f) => s + f.rating, 0) / feedback.length) * 10) / 10 : null;
  return {
    declineReasons: tally,
    hints: preferenceHints(tally).map((h) => ({ reason: h.reason, count: h.count, title: h.title })),
    averageRating: avg,
    feedback: feedback.map((f) => ({ id: sid(f._id), rating: f.rating, tags: f.tags, note: f.note ?? null, at: f.createdAt })),
  };
}
