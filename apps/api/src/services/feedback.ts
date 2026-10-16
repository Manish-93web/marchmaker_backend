import { MAX_LEARNED_SHIFT, MEETING_AFTER_DAYS, MIN_LEARNED_SAMPLES, preferenceHints, tallyReasons, type FeedbackStage, type FeedbackTag } from '@marchmaker/shared';
import { Types } from 'mongoose';
import { emit } from '../lib/audit';
import { conflict, notFound } from '../lib/errors';
import { CheckinMarker, IntroFeedback } from '../models/growth';
import { Introduction, MatchSuggestion } from '../models/matching';
import { Setting, User } from '../models/core';
import { MessageThread } from '../models/social';

const DAY = 86_400_000;
const CHECKIN_AFTER_DAYS = 7;
const CHECKIN_WINDOW_DAYS = 45;
const sid = (v: unknown) => String(v);

/** Feedback is about an introduction the member really took part in and that unlocked. */
export async function submit(userId: string, input: { introductionId: string; stage?: FeedbackStage; rating?: number; met?: boolean; tags: FeedbackTag[]; note?: string }) {
  const stage = input.stage ?? 'checkin';
  const intro = await Introduction.findOne({ _id: input.introductionId, 'members.userId': userId, state: 'mutually_accepted' }).select('_id').lean();
  if (!intro) throw notFound('Introduction not found');
  if (stage === 'closed') {
    const closed = await MessageThread.exists({ introductionId: intro._id, members: userId, status: 'closed' });
    if (!closed) throw conflict('This conversation is still open');
  }
  try {
    await IntroFeedback.create({ introductionId: intro._id, userId, stage, rating: input.rating, met: input.met, tags: input.tags, note: input.note });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw conflict('You have already shared how this went. Thank you.');
    throw err;
  }
  return { received: true };
}

/** Questions waiting for this member: the week-one check-in, the meeting question, and a note after ending a conversation. */
export async function pending(userId: string, now = new Date()) {
  const items: { introductionId: string; stage: FeedbackStage; since: Date }[] = [];
  const intros = await Introduction.find({
    'members.userId': userId,
    state: 'mutually_accepted',
    unlockedAt: { $lte: new Date(now.getTime() - CHECKIN_AFTER_DAYS * DAY), $gte: new Date(now.getTime() - 90 * DAY) },
  })
    .select('_id unlockedAt')
    .lean();
  const closedThreads = await MessageThread.find({ members: userId, status: 'closed', updatedAt: { $gte: new Date(now.getTime() - 30 * DAY) } }).select('introductionId updatedAt').lean();
  const ids = [...intros.map((i) => i._id), ...closedThreads.map((t) => t.introductionId)];
  if (!ids.length) return { items };
  const done = await IntroFeedback.find({ userId, introductionId: { $in: ids } }).select('introductionId stage').lean();
  const has = (id: unknown, stage: string) => done.some((d) => sid(d.introductionId) === sid(id) && d.stage === stage);
  for (const i of intros) {
    const age = now.getTime() - (i.unlockedAt as Date).getTime();
    if (age <= CHECKIN_WINDOW_DAYS * DAY && !has(i._id, 'checkin')) items.push({ introductionId: sid(i._id), stage: 'checkin', since: i.unlockedAt as Date });
    if (age >= MEETING_AFTER_DAYS * DAY && !has(i._id, 'meeting')) items.push({ introductionId: sid(i._id), stage: 'meeting', since: i.unlockedAt as Date });
  }
  for (const t of closedThreads) if (!has(t.introductionId, 'closed')) items.push({ introductionId: sid(t.introductionId), stage: 'closed', since: t.updatedAt });
  return { items };
}

/** Once per member per introduction and stage. The marker makes retries and overlapping runs harmless. */
export async function sendCheckIns(now = new Date()): Promise<number> {
  const intros = await Introduction.find({
    state: 'mutually_accepted',
    unlockedAt: { $lte: new Date(now.getTime() - CHECKIN_AFTER_DAYS * DAY), $gte: new Date(now.getTime() - 90 * DAY) },
  })
    .select('_id unlockedAt members.userId')
    .limit(500)
    .lean();
  let sent = 0;
  for (const i of intros) {
    const age = now.getTime() - (i.unlockedAt as Date).getTime();
    const stages: { stage: FeedbackStage; event: string }[] = [];
    if (age <= CHECKIN_WINDOW_DAYS * DAY) stages.push({ stage: 'checkin', event: 'feedback.checkin' });
    if (age >= MEETING_AFTER_DAYS * DAY) stages.push({ stage: 'meeting', event: 'feedback.meeting' });
    for (const m of i.members) {
      for (const { stage, event } of stages) {
        if (await IntroFeedback.exists({ introductionId: i._id, userId: m.userId, stage })) continue;
        try {
          await CheckinMarker.create({ introductionId: i._id, userId: m.userId, stage });
        } catch (err) {
          if ((err as { code?: number }).code === 11000) continue;
          throw err;
        }
        await emit(event, { userId: sid(m.userId), introductionId: sid(i._id) });
        sent++;
      }
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
  const rated = feedback.filter((f) => f.rating != null);
  const avg = rated.length ? Math.round((rated.reduce((s, f) => s + (f.rating ?? 0), 0) / rated.length) * 10) / 10 : null;
  return {
    declineReasons: tally,
    hints: preferenceHints(tally).map((h) => ({ reason: h.reason, count: h.count, title: h.title })),
    averageRating: avg,
    feedback: feedback.map((f) => ({ id: sid(f._id), stage: f.stage, met: f.met ?? null, rating: f.rating ?? null, tags: f.tags, note: f.note ?? null, at: f.createdAt })),
  };
}

// ------------------------------------------------------------------ learning from feedback

const SIGNALS = ['preferences', 'assessments', 'plans'] as const;

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}

/** One sample per rated feedback: the match's signals and the rating the member gave it. */
async function samples(since: Date) {
  const fb = await IntroFeedback.find({ createdAt: { $gte: since }, rating: { $exists: true }, stage: { $in: ['checkin', 'closed'] } }).select('introductionId rating').lean();
  if (!fb.length) return [];
  const intros = await Introduction.find({ _id: { $in: fb.map((f) => f.introductionId) } }).select('suggestionId').lean();
  const sugg = new Map(intros.map((i) => [sid(i._id), i.suggestionId]));
  const rows = await MatchSuggestion.find({ _id: { $in: [...sugg.values()].filter(Boolean) } }).select('signals reviewerId').lean();
  const bySug = new Map(rows.map((r) => [sid(r._id), r]));
  const out: { rating: number; signals: Record<string, number>; reviewerId?: string }[] = [];
  for (const f of fb) {
    const sg = bySug.get(sid(sugg.get(sid(f.introductionId))));
    const signals = sg?.signals as Record<string, number> | undefined;
    if (sg && signals && f.rating != null) out.push({ rating: f.rating, signals, reviewerId: sg.reviewerId ? sid(sg.reviewerId) : undefined });
  }
  return out;
}

/**
 * Signals that predict happier members earn a little more weight and those that do not, a little less.
 * The shift is capped at MAX_LEARNED_SHIFT per weight and ignored below MIN_LEARNED_SAMPLES, so a handful of
 * unhappy members can never swing who gets introduced to whom. A person can switch it off in matching settings.
 */
export async function refreshLearnedWeights(now = new Date()) {
  const rows = await samples(new Date(now.getTime() - 180 * DAY));
  const delta: Record<string, number> = { preferences: 0, assessments: 0, plans: 0 };
  const correlation: Record<string, number> = {};
  if (rows.length >= MIN_LEARNED_SAMPLES) {
    for (const k of SIGNALS) correlation[k] = pearson(rows.map((r) => r.signals[k] ?? 0), rows.map((r) => r.rating));
    const mean = SIGNALS.reduce((a, k) => a + (correlation[k] ?? 0), 0) / SIGNALS.length;
    for (const k of SIGNALS) delta[k] = Math.max(-MAX_LEARNED_SHIFT, Math.min(MAX_LEARNED_SHIFT, ((correlation[k] ?? 0) - mean) * MAX_LEARNED_SHIFT * 2));
  }
  const value = { at: now.toISOString(), samples: rows.length, delta, correlation };
  await Setting.updateOne({ key: 'matching_learned' }, { $set: { value } }, { upsert: true });
  return value;
}

export async function learnedWeights() {
  const row = await Setting.findOne({ key: 'matching_learned' }).lean();
  return (row?.value ?? null) as { at: string; samples: number; delta: Record<string, number>; correlation: Record<string, number> } | null;
}

/** How well introductions are landing, per matchmaker and per signal, so staff can see what is working. */
export async function relevanceReport(days = 90) {
  const since = new Date(Date.now() - days * DAY);
  const rows = await samples(since);
  const meet = await IntroFeedback.find({ createdAt: { $gte: since }, stage: 'meeting' }).select('met').lean();
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);
  const byReviewer = new Map<string, number[]>();
  for (const r of rows) if (r.reviewerId) byReviewer.set(r.reviewerId, [...(byReviewer.get(r.reviewerId) ?? []), r.rating]);
  const users = await User.find({ _id: { $in: [...byReviewer.keys()] } }).select('firstName').lean();
  const name = new Map(users.map((u) => [sid(u._id), u.firstName]));
  return {
    days,
    responses: rows.length,
    averageRating: avg(rows.map((r) => r.rating)),
    metRate: meet.length ? Math.round((meet.filter((m) => m.met).length / meet.length) * 100) / 100 : null,
    meetingResponses: meet.length,
    byMatchmaker: [...byReviewer.entries()].map(([id, xs]) => ({ reviewerId: id, name: name.get(id) ?? 'Staff', responses: xs.length, averageRating: avg(xs) })).sort((a, b) => b.responses - a.responses),
    bySignal: SIGNALS.map((k) => ({
      signal: k,
      high: avg(rows.filter((r) => (r.signals[k] ?? 0) >= 0.7).map((r) => r.rating)),
      low: avg(rows.filter((r) => (r.signals[k] ?? 0) < 0.7).map((r) => r.rating)),
    })),
    learned: await learnedWeights(),
    meetingAfterDays: MEETING_AFTER_DAYS,
  };
}
