import { randomUUID } from 'node:crypto';
import {
  rankCandidates,
  sortedPairKey,
  type Gender,
  type MatchProfile,
  type MatchingConfig,
  type PrefDim,
} from '@marchmaker/shared';
import type { AppContext } from '../context';
import { emit } from '../lib/audit';
import { AssessmentResponse } from '../models/assessment';
import { User } from '../models/core';
import { Block, Introduction, MatchSuggestion } from '../models/matching';
import { Photo, Preference, Profile } from '../models/profile';
import { getMatchingConfig } from './settings';

const OPEN_STATES = ['released', 'viewed', 'accepted_by_one'];

type Step = Record<string, unknown> | undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

export interface MatchPool {
  profiles: Map<string, MatchProfile>;
  /** member id -> ids that must never be paired with them */
  excluded: Map<string, Set<string>>;
}

/** Everything that makes a member matchable right now, in one query pass per collection. */
export async function loadPool(ctx: AppContext): Promise<MatchPool> {
  const userFilter: Record<string, unknown> = {
    roles: 'member',
    status: 'active',
    journeyState: 'matching_active',
    'verification.idVerifiedAt': { $exists: true },
  };
  const users = await User.find(userFilter).lean();
  if (users.length === 0) return { profiles: new Map(), excluded: new Map() };
  const ids = users.map((u) => u._id);

  const [profiles, prefs, photos, assessments, blocks, intros, suggestions] = await Promise.all([
    Profile.find({ userId: { $in: ids }, status: 'approved' }).lean(),
    Preference.find({ userId: { $in: ids } }).lean(),
    Photo.aggregate([{ $match: { userId: { $in: ids }, status: 'approved' } }, { $group: { _id: '$userId' } }]),
    AssessmentResponse.find({ userId: { $in: ids }, status: 'completed' }).sort({ completedAt: -1 }).lean(),
    Block.find({ $or: [{ blockerId: { $in: ids } }, { blockedId: { $in: ids } }] }).lean(),
    Introduction.find({ 'members.userId': { $in: ids } }).select('pairKey state members.userId releasedAt').lean(),
    MatchSuggestion.find({ status: { $in: ['rejected', 'approved', 'in_review', 'escalated', 'snoozed'] } })
      .select('memberA memberB status')
      .lean(),
  ]);

  const withPhoto = new Set(photos.map((p) => String(p._id)));
  const profileBy = new Map(profiles.map((p) => [String(p.userId), p]));
  const prefBy = new Map(prefs.map((p) => [String(p.userId), p]));

  const vectors = new Map<string, Record<string, Record<string, number>>>();
  for (const a of assessments) {
    const uid = String(a.userId);
    const cur = vectors.get(uid) ?? {};
    if (!cur[a.key] && a.dimensionScores) cur[a.key] = a.dimensionScores as Record<string, number>;
    vectors.set(uid, cur);
  }

  const open = new Map<string, number>();
  const lastIntro = new Map<string, Date>();
  const excluded = new Map<string, Set<string>>();
  const exclude = (a: string, b: string) => {
    (excluded.get(a) ?? excluded.set(a, new Set()).get(a)!).add(b);
    (excluded.get(b) ?? excluded.set(b, new Set()).get(b)!).add(a);
  };

  for (const i of intros) {
    const [x, y] = i.members.map((m) => String(m.userId));
    if (x && y) exclude(x, y); // introduced before in any outcome: never again
    for (const m of i.members) {
      const uid = String(m.userId);
      if (OPEN_STATES.includes(i.state)) open.set(uid, (open.get(uid) ?? 0) + 1);
      const prev = lastIntro.get(uid);
      if (!prev || i.releasedAt > prev) lastIntro.set(uid, i.releasedAt);
    }
  }
  for (const b of blocks) exclude(String(b.blockerId), String(b.blockedId));
  for (const s of suggestions) {
    // A pair a person already decided on, or is deciding on, is not proposed again.
    exclude(String(s.memberA), String(s.memberB));
  }

  const out = new Map<string, MatchProfile>();
  for (const u of users) {
    const id = String(u._id);
    const prof = profileBy.get(id);
    if (!prof || !withPhoto.has(id)) continue;
    const d = (prof.data ?? {}) as Record<string, Step>;
    const bg = d.background;
    const edu = d.education_career;
    let income: string | undefined;
    if (prof.sensitive?.incomeBandEnc) {
      try {
        income = ctx.crypto.decrypt(prof.sensitive.incomeBandEnc);
      } catch {
        income = undefined;
      }
    }
    const prefDims = (prefBy.get(id)?.dimensions ?? []).map((p): PrefDim => ({
      key: p.key,
      type: p.type as 'must' | 'flexible',
      values: p.values ?? [],
      range:
        typeof p.range?.min === 'number' && typeof p.range?.max === 'number'
          ? { min: p.range.min, max: p.range.max }
          : undefined,
      importance: p.importance ?? 2,
    }));
    const activated = u.verification?.idVerifiedAt;
    const last = lastIntro.get(id);
    out.set(id, {
      id,
      gender: u.gender as Gender,
      birthYear: u.dobYear ?? prof.birthYear ?? undefined,
      heightCm: typeof d.basics?.heightCm === 'number' ? d.basics.heightCm : undefined,
      city: str(bg?.city),
      state: str(bg?.state),
      religion: str(bg?.religion),
      community: str(bg?.community),
      motherTongue: str(bg?.motherTongue),
      education: str(edu?.highestEducation),
      profession: str(edu?.profession),
      incomeBand: income,
      diet: str(d.lifestyle?.diet),
      smoking: str(d.lifestyle?.smoking),
      drinking: str(d.lifestyle?.drinking),
      maritalStatus: str(d.basics?.maritalStatus),
      wantsKids: str(d.values?.wantsKids),
      familyType: str(d.family?.familyType),
      marriageTimeline: str(d.values?.marriageTimeline),
      livingWithFamily: str(d.values?.livingWithFamily),
      settleCity: str(d.values?.settleCity),
      prefs: prefDims,
      assessments: vectors.get(id) ?? {},
      lastActiveAt: u.lastActiveAt ?? undefined,
      waitingSince: (last && activated && last > activated ? last : activated) ?? undefined,
      openIntroductions: open.get(id) ?? 0,
    });
  }
  return { profiles: out, excluded };
}

export interface RunSummary {
  runId: string;
  members: number;
  suggestionsCreated: number;
  suggestionsUpdated: number;
  staleRemoved: number;
}

/**
 * Builds ranked candidate lists and upserts them as `suggested` pairs. Pairs a person has
 * already touched are never overwritten. A full run also clears `suggested` pairs that no
 * longer qualify. Safe to run repeatedly.
 */
export async function runMatching(
  ctx: AppContext,
  opts: { onlyUserIds?: string[]; now?: Date; config?: MatchingConfig } = {},
): Promise<RunSummary> {
  const now = opts.now ?? new Date();
  const cfg = opts.config ?? (await getMatchingConfig());
  const runId = randomUUID();
  const pool = await loadPool(ctx);
  const all = [...pool.profiles.values()].sort((a, b) => a.id.localeCompare(b.id));
  const subjects = opts.onlyUserIds ? all.filter((p) => opts.onlyUserIds!.includes(p.id)) : all;

  let created = 0;
  let updated = 0;

  // Gather every qualifying pair once, then fill each member's quota with the best pairs first.
  // This keeps the number of suggestions involving any one member at `topN`, whichever side proposed it.
  const candidates = new Map<string, { a: string; b: string; result: ReturnType<typeof rankCandidates>[number]['result'] }>();
  for (const subject of subjects) {
    const ranked = rankCandidates(subject, all, pool.excluded.get(subject.id) ?? new Set(), cfg, now);
    for (const { candidateId, result } of ranked) {
      const pairKey = sortedPairKey(subject.id, candidateId);
      if (!candidates.has(pairKey)) {
        const [a, b] = pairKey.split(':') as [string, string];
        candidates.set(pairKey, { a, b, result });
      }
    }
  }

  // Pairs a person is already working on count towards each member's quota.
  const used = new Map<string, number>();
  const active = await MatchSuggestion.find({ status: { $in: ['in_review', 'approved', 'snoozed', 'escalated'] } })
    .select('memberA memberB')
    .lean();
  for (const s of active) {
    for (const id of [String(s.memberA), String(s.memberB)]) used.set(id, (used.get(id) ?? 0) + 1);
  }

  const ordered = [...candidates.entries()].sort(
    (x, y) => y[1].result.score - x[1].result.score || x[0].localeCompare(y[0]),
  );
  for (const [pairKey, { a, b, result }] of ordered) {
    if ((used.get(a) ?? 0) >= cfg.topN || (used.get(b) ?? 0) >= cfg.topN) continue;
    const existing = await MatchSuggestion.findOne({ pairKey }).select('status').lean();
    if (existing && existing.status !== 'suggested') continue;
    used.set(a, (used.get(a) ?? 0) + 1);
    used.set(b, (used.get(b) ?? 0) + 1);

    const doc = {
      score: result.score,
      signals: result.signals,
      reasons: result.reasons,
      assessmentsMissing: result.assessmentsMissing,
      runId,
      generatedAt: now,
    };
    if (existing) {
      await MatchSuggestion.updateOne({ pairKey, status: 'suggested' }, { $set: doc });
      updated++;
    } else {
      const needsTwoPerson = await requiresTwoPerson(a, b);
      try {
        await MatchSuggestion.create({ pairKey, memberA: a, memberB: b, status: 'suggested', needsTwoPerson, ...doc });
        created++;
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) throw err; // lost a race with another run
      }
    }
  }

  let stale = 0;
  if (!opts.onlyUserIds) {
    const res = await MatchSuggestion.deleteMany({ status: 'suggested', manual: { $ne: true }, runId: { $ne: runId } });
    stale = res.deletedCount ?? 0;
  }
  await emit('match.suggestions_generated', { runId, created, updated });
  return { runId, members: subjects.length, suggestionsCreated: created, suggestionsUpdated: updated, staleRemoved: stale };
}

/** Members flagged for double review, or with a past suspension, need two different approvers. */
export async function requiresTwoPerson(a: string, b: string): Promise<boolean> {
  const n = await User.countDocuments({
    _id: { $in: [a, b] },
    $or: [{ 'reviewFlags.twoPerson': true }, { 'moderation.at': { $exists: true } }],
  });
  return n > 0;
}
