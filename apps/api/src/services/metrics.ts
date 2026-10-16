import { median, pct } from '@marchmaker/shared';
import { Types } from 'mongoose';
import { Payment, Subscription } from '../models/billing';
import { StateTransition, User } from '../models/core';
import { ActiveDay } from '../models/growth';
import { Introduction, MatchSuggestion } from '../models/matching';
import { Report } from '../models/social';
import { Ticket } from '../models/safety';
import { catalogEntry } from './billing';
import { eventSummary } from './analytics';
import { istDay } from './activity';

const DAY = 86_400_000;
const cache = new Map<string, { at: number; value: unknown }>();
const TTL = 5 * 60_000;

const percentile = (values: number[], p: number): number | null => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};
const hours = (ms: number) => Math.round((ms / 3_600_000) * 10) / 10;
const oid = (ids: string[]) => ids.map((i) => new Types.ObjectId(i));

/** Cohort funnel: of the members who registered in the range, how many reached each step. */
async function funnel(from: Date, to: Date) {
  const cohort = await User.find({ createdAt: { $gte: from, $lte: to }, roles: 'member' })
    .select('_id emailVerifiedAt phoneVerifiedAt')
    .limit(50_000)
    .lean();
  const ids = cohort.map((u) => String(u._id));
  const oids = oid(ids);
  const reached = async (state: string) =>
    ids.length ? (await StateTransition.distinct('entityId', { entityType: 'user_journey', to: state, entityId: { $in: ids } })).length : 0;
  const introduced = async (extra: Record<string, unknown> = {}) => {
    if (!ids.length) return 0;
    const r = await Introduction.aggregate<{ n: number }>([
      { $match: { 'members.userId': { $in: oids }, ...extra } },
      { $unwind: '$members' },
      { $match: { 'members.userId': { $in: oids } } },
      { $group: { _id: '$members.userId' } },
      { $count: 'n' },
    ]);
    return r[0]?.n ?? 0;
  };
  const paid = ids.length
    ? (await Payment.distinct('userId', { userId: { $in: oids }, status: { $in: ['captured', 'partially_refunded', 'refunded'] } })).length
    : 0;

  const counts: [string, string, number][] = [
    ['registered', 'Registered', cohort.length],
    ['verified_contact', 'Confirmed email or phone', cohort.filter((u) => u.emailVerifiedAt || u.phoneVerifiedAt).length],
    ['profile_submitted', 'Submitted a profile', await reached('profile_submitted')],
    ['profile_approved', 'Profile approved', await reached('profile_approved')],
    ['verified', 'ID verified', await reached('verified')],
    ['matching_active', 'Ready for introductions', await reached('matching_active')],
    ['introduced', 'Received an introduction', await introduced()],
    ['mutual', 'Reached a mutual yes', await introduced({ state: 'mutually_accepted' })],
    ['paid', 'Made a payment', paid],
  ];
  const first = counts[0]![2];
  return counts.map(([key, label, n], i) => ({
    key,
    label,
    count: n,
    ofPrevious: i === 0 ? null : pct(n, counts[i - 1]![2]),
    ofStart: pct(n, first),
  }));
}

async function reviewTimes(from: Date, to: Date) {
  const rows = await StateTransition.find({
    entityType: 'user_journey',
    to: { $in: ['profile_submitted', 'profile_approved', 'profile_changes_requested', 'verification_pending', 'verified', 'verification_rejected'] },
    createdAt: { $gte: new Date(from.getTime() - 30 * DAY), $lte: to },
  })
    .sort({ createdAt: 1 })
    .limit(100_000)
    .lean();
  const byUser = new Map<string, typeof rows>();
  for (const r of rows) byUser.set(r.entityId, [...(byUser.get(r.entityId) ?? []), r]);
  const profile: number[] = [];
  const verification: number[] = [];
  for (const list of byUser.values()) {
    let pendingProfile: Date | null = null;
    let pendingVerification: Date | null = null;
    for (const r of list) {
      if (r.to === 'profile_submitted') pendingProfile = r.createdAt;
      else if (pendingProfile && (r.to === 'profile_approved' || r.to === 'profile_changes_requested')) {
        if (r.createdAt >= from) profile.push(r.createdAt.getTime() - pendingProfile.getTime());
        pendingProfile = null;
      }
      if (r.to === 'verification_pending') pendingVerification = r.createdAt;
      else if (pendingVerification && (r.to === 'verified' || r.to === 'verification_rejected')) {
        if (r.createdAt >= from) verification.push(r.createdAt.getTime() - pendingVerification.getTime());
        pendingVerification = null;
      }
    }
  }
  const sum = (v: number[]) => ({ count: v.length, medianHours: median(v.map(hours)), p90Hours: percentile(v.map(hours), 90) });
  return { profile: sum(profile), verification: sum(verification) };
}

async function backlog() {
  const now = new Date();
  const [profilesWaiting, verificationsWaiting, suggestionsWaiting, reportsOpen, reportsOverdue, ticketsOpen, ticketsOverdue] = await Promise.all([
    User.countDocuments({ journeyState: 'profile_submitted', status: 'active' }),
    User.countDocuments({ journeyState: 'verification_pending', status: 'active' }),
    MatchSuggestion.countDocuments({ status: { $in: ['suggested', 'in_review', 'escalated'] } }),
    Report.countDocuments({ status: { $in: ['open', 'investigating'] } }),
    Report.countDocuments({ status: { $in: ['open', 'investigating'] }, slaDueAt: { $lt: now } }),
    Ticket.countDocuments({ status: 'open' }),
    Ticket.countDocuments({ status: 'open', firstResponseAt: { $exists: false }, firstResponseDueAt: { $lt: now } }),
  ]);
  return { profilesWaiting, verificationsWaiting, suggestionsWaiting, reportsOpen, reportsOverdue, ticketsOpen, ticketsOverdue };
}

async function revenue(from: Date, to: Date) {
  const range = { capturedAt: { $gte: from, $lte: to }, status: { $in: ['captured', 'partially_refunded', 'refunded'] } };
  const [totals, daily, active] = await Promise.all([
    Payment.aggregate<{ _id: string; gross: number; refunded: number; n: number; users: string[] }>([
      { $match: range },
      { $group: { _id: '$kind', gross: { $sum: '$amountPaise' }, refunded: { $sum: '$refundedPaise' }, n: { $sum: 1 }, users: { $addToSet: '$userId' } } },
    ]),
    Payment.aggregate<{ _id: string; gross: number; refunded: number }>([
      { $match: range },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$capturedAt' } }, gross: { $sum: '$amountPaise' }, refunded: { $sum: '$refundedPaise' } } },
      { $sort: { _id: 1 } },
    ]),
    Subscription.find({ status: 'active' }).select('planCode interval').lean(),
  ]);
  const months = { monthly: 1, quarterly: 3, annual: 12 } as const;
  let mrr = 0;
  const priceCache = new Map<string, number>();
  for (const s of active) {
    const k = `${s.planCode}:${s.interval}`;
    if (!priceCache.has(k)) {
      const entry = await catalogEntry(s.planCode).catch(() => null);
      priceCache.set(k, entry?.prices[s.interval as keyof typeof months] ?? 0);
    }
    mrr += Math.round((priceCache.get(k) ?? 0) / months[s.interval as keyof typeof months]);
  }
  const gross = totals.reduce((s, t) => s + t.gross, 0);
  const refunded = totals.reduce((s, t) => s + t.refunded, 0);
  const payers = new Set(totals.flatMap((t) => t.users.map(String))).size;
  return {
    grossPaise: gross,
    refundedPaise: refunded,
    netPaise: gross - refunded,
    payments: totals.reduce((s, t) => s + t.n, 0),
    payingMembers: payers,
    arppuPaise: payers ? Math.round((gross - refunded) / payers) : null,
    byKind: totals.map((t) => ({ kind: t._id, grossPaise: t.gross, payments: t.n })),
    daily: daily.map((d) => ({ day: d._id, netPaise: d.gross - d.refunded })),
    mrrPaise: mrr,
    activeSubscriptions: active.length,
  };
}

async function matching(from: Date, to: Date) {
  const [suggestions, intros] = await Promise.all([
    MatchSuggestion.aggregate<{ _id: string; n: number }>([
      { $match: { createdAt: { $gte: from, $lte: to } } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
    Introduction.aggregate<{ _id: string; n: number }>([
      { $match: { releasedAt: { $gte: from, $lte: to } } },
      { $group: { _id: '$state', n: { $sum: 1 } } },
    ]),
  ]);
  const s = Object.fromEntries(suggestions.map((r) => [r._id, r.n]));
  const i = Object.fromEntries(intros.map((r) => [r._id, r.n]));
  const sTotal = suggestions.reduce((a, r) => a + r.n, 0);
  const iTotal = intros.reduce((a, r) => a + r.n, 0);
  const decided = (s.approved ?? 0) + (s.rejected ?? 0);
  return {
    suggestions: { total: sTotal, byStatus: s, approvalRate: pct(s.approved ?? 0, decided) },
    introductions: {
      total: iTotal,
      byState: i,
      mutualRate: pct(i.mutually_accepted ?? 0, iTotal),
      declineRate: pct(i.declined ?? 0, iTotal),
      expiryRate: pct(i.expired ?? 0, iTotal),
    },
  };
}

/** Weekly cohorts of members who became ready for introductions, and how many came back. */
async function retention(weeks = 8) {
  const mondayUtc = (d: Date) => {
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
    return x;
  };
  const thisWeek = mondayUtc(new Date());
  const out: { week: string; size: number; w1: number | null; w2: number | null; w4: number | null }[] = [];
  for (let w = weeks; w >= 1; w--) {
    const start = new Date(thisWeek.getTime() - w * 7 * DAY);
    const end = new Date(start.getTime() + 7 * DAY);
    const ids = await StateTransition.distinct('entityId', { entityType: 'user_journey', to: 'matching_active', createdAt: { $gte: start, $lt: end } });
    const size = ids.length;
    const rate = async (k: number) => {
      const wStart = new Date(start.getTime() + k * 7 * DAY);
      if (wStart.getTime() + 7 * DAY > Date.now()) return null; // that week is not over yet
      if (!size) return null;
      const active = await ActiveDay.distinct('userId', {
        userId: { $in: oid(ids) },
        day: { $gte: istDay(wStart), $lt: istDay(new Date(wStart.getTime() + 7 * DAY)) },
      });
      return pct(active.length, size);
    };
    out.push({ week: start.toISOString().slice(0, 10), size, w1: await rate(1), w2: await rate(2), w4: await rate(4) });
  }
  return out;
}

export async function overview(rangeIn: { from?: Date; to?: Date }) {
  const to = rangeIn.to ?? new Date();
  const from = rangeIn.from ?? new Date(to.getTime() - 30 * DAY);
  const key = `${from.toISOString().slice(0, 13)}|${to.toISOString().slice(0, 13)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;

  const [f, reviews, b, rev, m, ret, ev] = await Promise.all([
    funnel(from, to),
    reviewTimes(from, to),
    backlog(),
    revenue(from, to),
    matching(from, to),
    retention(),
    eventSummary(from, to),
  ]);
  const value = { range: { from, to }, generatedAt: new Date(), funnel: f, reviews, backlog: b, revenue: rev, matching: m, retention: ret, events: ev };
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** For tests. */
export const clearMetricsCache = () => cache.clear();
