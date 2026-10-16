import { z } from 'zod';
import type { Request } from 'express';
import {
  reasonSentences,
  scorePair,
  sortedPairKey,
  whyTextProblems,
  type MatchReason,
} from '@marchmaker/shared';
import type { AppContext } from '../context';
import { audit, emit } from '../lib/audit';
import { AppError, badRequest, conflict, notFound } from '../lib/errors';
import { AdminNote } from '../models/admin';
import { User } from '../models/core';
import { Block, Introduction, MatchSuggestion } from '../models/matching';
import { loadPool, requiresTwoPerson } from './matching';
import { memberDetail } from './adminMembers';
import { getMatchingConfig, getReviewSettings } from './settings';

type Doc = NonNullable<Awaited<ReturnType<typeof MatchSuggestion.findOne>>>;

export interface Reviewer {
  userId: string;
  roles: string[];
  permissions: readonly string[];
}

const PLAN_RANK: Record<string, number> = { concierge: 3, premium: 2, essential: 1, free: 0 };
const MIN = 60_000;

const REJECTION_CODES = [
  'not_a_fit',
  'safety_concern',
  'profile_quality',
  'member_unavailable',
  'duplicate_or_known',
  'other',
] as const;

export const decisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve'), whyText: z.string().trim().max(700), confirmed: z.literal(true) }),
  z.object({ decision: z.literal('reject'), code: z.enum(REJECTION_CODES), note: z.string().trim().max(500).optional() }),
  z.object({ decision: z.literal('snooze'), days: z.number().int().min(1).max(30), note: z.string().trim().max(500).optional() }),
  z.object({ decision: z.literal('escalate'), reason: z.string().trim().min(5).max(500) }),
]);
export type MatchDecision = z.infer<typeof decisionSchema>;

const OPEN_STATUSES = ['suggested', 'in_review', 'snoozed', 'escalated'] as const;
const entry = (by: string, action: string, note?: string, details?: unknown) => ({ at: new Date(), by, action, note, details });

// ------------------------------------------------------------------ queue

export async function queue(
  status: 'open' | 'suggested' | 'in_review' | 'snoozed' | 'escalated' | 'approved' = 'open',
  limit = 100,
) {
  const settings = await getReviewSettings();
  const filter: Record<string, unknown> =
    status === 'open' ? { status: { $in: ['suggested', 'in_review', 'escalated'] } } : { status };
  const rows = await MatchSuggestion.find(filter).sort({ createdAt: 1 }).limit(300).lean();
  const ids = new Set(rows.flatMap((r) => [String(r.memberA), String(r.memberB)]));
  const users = await User.find({ _id: { $in: [...ids] } })
    .select('firstName gender plan')
    .lean();
  const by = new Map(users.map((u) => [String(u._id), u]));
  const now = Date.now();

  const items = rows.map((r) => {
    const a = by.get(String(r.memberA));
    const b = by.get(String(r.memberB));
    const waitingHours = Math.round((now - (r.createdAt?.getTime() ?? now)) / 3_600_000);
    const planRank = Math.max(PLAN_RANK[a?.plan?.planCode ?? 'free'] ?? 0, PLAN_RANK[b?.plan?.planCode ?? 'free'] ?? 0);
    return {
      id: String(r._id),
      status: r.status,
      a: { id: String(r.memberA), firstName: a?.firstName ?? '' },
      b: { id: String(r.memberB), firstName: b?.firstName ?? '' },
      priorityPlan: Object.keys(PLAN_RANK).find((k) => PLAN_RANK[k] === planRank) ?? 'free',
      waitingHours,
      slaBreached: waitingHours >= settings.reviewSlaHours,
      needsTwoPerson: r.needsTwoPerson,
      manual: r.manual ?? false,
      reviewerId: r.reviewerId ? String(r.reviewerId) : null,
      approvals: r.approvals?.length ?? 0,
      releaseAt: r.releaseAt ?? null,
      // A band, not a number: even staff queues stay free of percentages.
      fit: r.score >= 0.75 ? 'strong' : r.score >= 0.62 ? 'good' : 'possible',
      _rank: planRank * 1000 + Math.min(waitingHours, 999),
    };
  });
  items.sort((x, y) => y._rank - x._rank);
  return items.slice(0, limit).map(({ _rank, ...rest }) => rest);
}

// ------------------------------------------------------------------ detail and claim

async function dayCount(userId: string, now: Date): Promise<number> {
  // Day boundaries are Indian Standard Time (UTC+5:30).
  const ist = new Date(now.getTime() + 330 * MIN);
  const startIst = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
  const start = new Date(startIst - 330 * MIN);
  return MatchSuggestion.countDocuments({ reviewerId: userId, claimedAt: { $gte: start } });
}

export async function detail(ctx: AppContext, req: Request, id: string, me: Reviewer) {
  const s = await MatchSuggestion.findById(id);
  if (!s) throw notFound('Suggestion not found');
  const settings = await getReviewSettings();
  const now = new Date();

  // Opening a fresh suggestion claims it, within the matchmaker's daily capacity.
  if (s.status === 'suggested') {
    if ((await dayCount(me.userId, now)) >= settings.matchmakerDailyCapacity) {
      throw new AppError(409, 'CAPACITY_REACHED', 'You have reached your review limit for today. Someone else can pick this up.');
    }
    const claimed = await MatchSuggestion.findOneAndUpdate(
      { _id: id, status: 'suggested' },
      {
        $set: { status: 'in_review', reviewerId: me.userId, claimedAt: now },
        $push: { reviewHistory: entry(me.userId, 'claim') },
      },
      { returnDocument: 'after' },
    );
    if (claimed) Object.assign(s, claimed.toObject());
  }

  const [aView, bView, notes] = await Promise.all([
    memberDetail(ctx, req, String(s.memberA), me as never),
    memberDetail(ctx, req, String(s.memberB), me as never),
    AdminNote.find({ subjectUserId: { $in: [s.memberA, s.memberB] }, pinned: true }).lean(),
  ]);

  const reasons = (s.reasons ?? []) as MatchReason[];
  const undoUntil = s.status === 'approved' && s.releaseAt && s.releaseAt > now && !s.releasedAt ? s.releaseAt : null;
  return {
    id,
    status: s.status,
    reviewerId: s.reviewerId ? String(s.reviewerId) : null,
    needsTwoPerson: s.needsTwoPerson,
    approvals: (s.approvals ?? []).map((a) => String(a.userId)),
    manual: s.manual ?? false,
    overrides: s.overrides ?? [],
    whyText: s.whyText ?? null,
    suggestedWhy: reasonSentences(reasons).join(' '),
    reasonCodes: reasons,
    signals: s.signals,
    score: s.score,
    assessmentsMissing: s.assessmentsMissing ?? false,
    undoUntil,
    releaseAt: s.releaseAt ?? null,
    snoozeUntil: s.snoozeUntil ?? null,
    escalation: s.escalation ?? null,
    history: (s.reviewHistory ?? []).map((h) => ({ at: h.at, by: h.by, action: h.action, note: h.note ?? null })),
    members: { a: aView, b: bView },
    pinnedNotes: notes.map((n) => ({ subject: String(n.subjectUserId), body: n.body })),
    cooloffMinutes: settings.cooloffMinutes,
  };
}

// ------------------------------------------------------------------ decisions

function canAct(s: Doc, me: Reviewer): void {
  const isOwner = s.reviewerId && String(s.reviewerId) === me.userId;
  const unclaimed = !s.reviewerId;
  const secondApprover =
    s.needsTwoPerson && s.status === 'in_review' && (s.approvals?.length ?? 0) > 0 && String(s.approvals[0]!.userId) !== me.userId;
  if (s.status === 'escalated') {
    // An escalation exists to get a second pair of eyes, so the person who raised it cannot close it.
    if (String(s.escalation?.by) === me.userId) {
      throw new AppError(409, 'NOT_ASSIGNED', 'You escalated this. Another reviewer needs to decide it.');
    }
    return;
  }
  if (!(isOwner || unclaimed || secondApprover)) {
    throw new AppError(409, 'NOT_ASSIGNED', 'This suggestion is being handled by another reviewer');
  }
}

export async function decide(ctx: AppContext, req: Request, id: string, me: Reviewer, d: MatchDecision) {
  const s = await MatchSuggestion.findById(id);
  if (!s) throw notFound('Suggestion not found');
  if (!['suggested', 'in_review', 'escalated', 'snoozed'].includes(s.status)) {
    throw conflict(`This suggestion is already ${s.status}`);
  }
  canAct(s, me);
  const settings = await getReviewSettings();
  const now = new Date();
  const open = { status: { $in: [...OPEN_STATUSES] } };

  if (d.decision === 'approve') {
    if (!me.permissions.includes('match.approve')) throw new AppError(403, 'FORBIDDEN', 'You cannot approve introductions');
    const problems = whyTextProblems(d.whyText);
    if (problems.length) throw new AppError(422, 'WHY_TEXT_INVALID', problems[0]!, { problems });

    const already = (s.approvals ?? []).some((a) => String(a.userId) === me.userId);
    if (already) throw conflict('You have already approved this. A second reviewer is needed.');
    const approvals = [...(s.approvals ?? []).map((a) => ({ userId: a.userId, at: a.at })), { userId: me.userId, at: now }];
    const needsSecond = s.needsTwoPerson && approvals.length < 2;

    const set: Record<string, unknown> = { whyText: d.whyText.trim(), approvals };
    if (needsSecond) {
      set.status = 'in_review';
    } else {
      set.status = 'approved';
      set.releaseAt = new Date(now.getTime() + settings.cooloffMinutes * MIN);
    }
    const claimed = await MatchSuggestion.findOneAndUpdate(
      { _id: id, ...open, 'approvals.userId': { $ne: me.userId } },
      {
        $set: { ...set, reviewerId: s.reviewerId ?? me.userId, claimedAt: s.claimedAt ?? now },
        $push: { reviewHistory: entry(me.userId, needsSecond ? 'approve_first' : 'approve', undefined, { whyText: d.whyText.trim() }) },
      },
      { returnDocument: 'after' },
    );
    if (!claimed) throw conflict('This suggestion changed while you were reviewing it');
    await audit(req, {
      action: needsSecond ? 'match.approve_first' : 'match.approve',
      actorId: me.userId,
      actorRoles: me.roles as never,
      subjectType: 'match',
      subjectId: id,
      after: { pair: s.pairKey, releaseAt: claimed.releaseAt ?? null },
    });
    return {
      id,
      status: claimed.status,
      awaitingSecondApproval: needsSecond,
      releaseAt: claimed.releaseAt ?? null,
      undoWindowMinutes: needsSecond ? null : settings.cooloffMinutes,
    };
  }

  if (d.decision === 'reject') {
    const claimed = await MatchSuggestion.findOneAndUpdate(
      { _id: id, ...open },
      {
        $set: { status: 'rejected', rejectionCode: d.code, reviewerId: s.reviewerId ?? me.userId },
        $push: { reviewHistory: entry(me.userId, 'reject', d.note, { code: d.code }) },
      },
    );
    if (!claimed) throw conflict('This suggestion changed while you were reviewing it');
  } else if (d.decision === 'snooze') {
    const until = new Date(now.getTime() + d.days * 86_400_000);
    const claimed = await MatchSuggestion.findOneAndUpdate(
      { _id: id, ...open },
      {
        $set: { status: 'snoozed', snoozeUntil: until },
        $unset: { reviewerId: 1 },
        $push: { reviewHistory: entry(me.userId, 'snooze', d.note, { until }) },
      },
    );
    if (!claimed) throw conflict('This suggestion changed while you were reviewing it');
  } else {
    const claimed = await MatchSuggestion.findOneAndUpdate(
      { _id: id, ...open },
      {
        $set: { status: 'escalated', escalation: { by: me.userId, reason: d.reason, at: now } },
        $unset: { reviewerId: 1 },
        $push: { reviewHistory: entry(me.userId, 'escalate', d.reason) },
      },
    );
    if (!claimed) throw conflict('This suggestion changed while you were reviewing it');
  }

  await audit(req, {
    action: `match.${d.decision}`,
    actorId: me.userId,
    actorRoles: me.roles as never,
    subjectType: 'match',
    subjectId: id,
    after: d.decision === 'reject' ? { code: d.code } : d.decision === 'snooze' ? { days: d.days } : { reason: (d as { reason?: string }).reason },
  });
  return { id, status: d.decision === 'reject' ? 'rejected' : d.decision === 'snooze' ? 'snoozed' : 'escalated' };
}

/** Takes back an approval while it is still inside the cool-off window. */
export async function undo(req: Request, id: string, me: Reviewer) {
  const now = new Date();
  const claimed = await MatchSuggestion.findOneAndUpdate(
    { _id: id, status: 'approved', releasedAt: { $exists: false }, releaseAt: { $gt: now } },
    {
      $set: { status: 'in_review', approvals: [] },
      $unset: { releaseAt: 1 },
      $push: { reviewHistory: entry(me.userId, 'undo') },
    },
  );
  if (!claimed) throw conflict('This can no longer be undone. It has already been released.');
  await audit(req, {
    action: 'match.undo',
    actorId: me.userId,
    actorRoles: me.roles as never,
    subjectType: 'match',
    subjectId: id,
  });
  return { id, status: 'in_review' };
}

// ------------------------------------------------------------------ manual introductions

export const manualSchema = z.object({
  memberA: z.string().regex(/^[a-f\d]{24}$/i),
  memberB: z.string().regex(/^[a-f\d]{24}$/i),
  whyText: z.string().trim().max(700),
  reason: z.string().trim().min(5).max(300),
});

/** A matchmaker's own pairing. Safety exclusions still apply; unmet must-haves are recorded as overrides. */
export async function createManual(ctx: AppContext, req: Request, me: Reviewer, input: z.infer<typeof manualSchema>) {
  if (input.memberA === input.memberB) throw badRequest('Choose two different members');
  const problems = whyTextProblems(input.whyText);
  if (problems.length) throw new AppError(422, 'WHY_TEXT_INVALID', problems[0]!, { problems });

  const pairKey = sortedPairKey(input.memberA, input.memberB);
  const [exists, intro, blocked] = await Promise.all([
    MatchSuggestion.exists({ pairKey }),
    Introduction.exists({ pairKey }),
    Block.exists({
      $or: [
        { blockerId: input.memberA, blockedId: input.memberB },
        { blockerId: input.memberB, blockedId: input.memberA },
      ],
    }),
  ]);
  if (exists || intro) throw conflict('These two already have a suggestion or an introduction');
  if (blocked) throw new AppError(409, 'BLOCKED', 'One of these members has blocked the other');

  const now = new Date();
  const pool = await loadPool(ctx);
  const pa = pool.profiles.get(input.memberA);
  const pb = pool.profiles.get(input.memberB);
  if (!pa || !pb) {
    throw new AppError(409, 'NOT_MATCHABLE', 'Both members must be verified, active, approved and have an approved photo');
  }
  const cfg = await getMatchingConfig();
  const r = scorePair(pa, pb, cfg, now);
  const settings = await getReviewSettings();
  const [a, b] = pairKey.split(':') as [string, string];
  const needsTwoPerson = await requiresTwoPerson(a, b);

  const s = await MatchSuggestion.create({
    pairKey,
    memberA: a,
    memberB: b,
    score: r.score,
    signals: r.signals,
    reasons: r.reasons,
    assessmentsMissing: r.assessmentsMissing,
    manual: true,
    overrides: r.failed.map((f) => ({ by: f.by, dimension: f.dimension })),
    needsTwoPerson,
    whyText: input.whyText.trim(),
    reviewerId: me.userId,
    claimedAt: now,
    approvals: [{ userId: me.userId, at: now }],
    status: needsTwoPerson ? 'in_review' : 'approved',
    releaseAt: needsTwoPerson ? undefined : new Date(now.getTime() + settings.cooloffMinutes * MIN),
    generatedAt: now,
    reviewHistory: [entry(me.userId, 'manual_create', input.reason, { overrides: r.failed })],
  });
  await audit(req, {
    action: 'match.manual_create',
    actorId: me.userId,
    actorRoles: me.roles as never,
    subjectType: 'match',
    subjectId: String(s._id),
    after: { pair: pairKey, overrides: r.failed.length, reason: input.reason },
  });
  return { id: String(s._id), status: s.status, overrides: r.failed.length };
}

// ------------------------------------------------------------------ release

export interface ReleaseSummary {
  released: number;
  dropped: number;
  woken: number;
}

/**
 * Releases approved matches whose cool-off has ended. Eligibility is re-checked at the last
 * moment: members may have been blocked, suspended or filled their open slots in the meantime.
 * Idempotent: the unique pair key on introductions means a pair can only ever be released once.
 */
export async function releaseDueMatches(ctx: AppContext, now: Date = new Date()): Promise<ReleaseSummary> {
  const settings = await getReviewSettings();
  const cfg = await getMatchingConfig();
  let released = 0;
  let dropped = 0;

  // Snoozed items return to the queue.
  const woke = await MatchSuggestion.updateMany(
    { status: 'snoozed', snoozeUntil: { $lte: now } },
    { $set: { status: 'suggested' }, $unset: { snoozeUntil: 1 }, $push: { reviewHistory: entry('system', 'snooze_ended') } },
  );

  const due = await MatchSuggestion.find({ status: 'approved', releaseAt: { $lte: now }, releasedAt: { $exists: false } }).limit(100);
  for (const s of due) {
    const [a, b] = [String(s.memberA), String(s.memberB)];
    const [users, blocked, existing, openCounts] = await Promise.all([
      User.find({ _id: { $in: [a, b] } })
        .select('status journeyState')
        .lean(),
      Block.exists({ $or: [{ blockerId: a, blockedId: b }, { blockerId: b, blockedId: a }] }),
      Introduction.exists({ pairKey: s.pairKey }),
      Introduction.aggregate([
        { $match: { state: { $in: ['released', 'viewed', 'accepted_by_one'] }, 'members.userId': { $in: [s.memberA, s.memberB] } } },
        { $unwind: '$members' },
        { $match: { 'members.userId': { $in: [s.memberA, s.memberB] } } },
        { $group: { _id: '$members.userId', n: { $sum: 1 } } },
      ]),
    ]);

    let reason: string | null = null;
    if (existing) reason = 'already_introduced';
    else if (blocked) reason = 'blocked';
    else if (users.length !== 2 || users.some((u) => u.status !== 'active' || u.journeyState !== 'matching_active')) {
      reason = 'member_unavailable';
    } else if (openCounts.some((c) => c.n >= cfg.maxOpenIntroductions)) reason = 'capacity';

    if (reason) {
      await MatchSuggestion.updateOne(
        { _id: s._id, status: 'approved' },
        {
          $set: { status: reason === 'capacity' ? 'in_review' : 'rejected', rejectionCode: `release_${reason}` },
          $unset: { releaseAt: 1 },
          $push: { reviewHistory: entry('system', 'release_blocked', reason) },
        },
      );
      dropped++;
      continue;
    }

    try {
      const intro = await Introduction.create({
        pairKey: s.pairKey,
        suggestionId: s._id,
        members: [{ userId: s.memberA }, { userId: s.memberB }],
        whyText: s.whyText ?? '',
        highlights: reasonSentences((s.reasons ?? []) as MatchReason[], 3),
        state: 'released',
        releasedAt: now,
        expiresAt: new Date(now.getTime() + settings.introExpiryDays * 86_400_000),
      });
      await MatchSuggestion.updateOne(
        { _id: s._id },
        {
          $set: { releasedAt: now, introductionId: intro._id },
          $push: { reviewHistory: entry('system', 'released') },
        },
      );
      for (const uid of [a, b]) await emit('introduction.released', { userId: uid, introductionId: String(intro._id) });
      released++;
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }
  return { released, dropped, woken: woke.modifiedCount };
}
