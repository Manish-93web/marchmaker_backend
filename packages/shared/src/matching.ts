import type { Gender } from './enums';
import type { PreferenceDimension } from './schemas/preferences';

/**
 * Deterministic matching engine. No I/O, no randomness, no clock reads: callers pass `now`.
 * See docs/MATCHING.md for the full description.
 */

export interface PrefDim {
  key: PreferenceDimension;
  type: 'must' | 'flexible';
  values: string[];
  range?: { min: number; max: number };
  importance: number; // 1..3
}

export interface MatchProfile {
  id: string;
  gender: Gender;
  birthYear?: number;
  heightCm?: number;
  city?: string;
  state?: string;
  religion?: string;
  community?: string;
  motherTongue?: string;
  education?: string;
  profession?: string;
  incomeBand?: string;
  diet?: string;
  smoking?: string;
  drinking?: string;
  maritalStatus?: string;
  wantsKids?: string;
  familyType?: string;
  marriageTimeline?: string;
  livingWithFamily?: string;
  settleCity?: string;
  prefs: PrefDim[];
  /** assessment key -> dimension -> 0..1 */
  assessments: Record<string, Record<string, number>>;
  lastActiveAt?: Date;
  waitingSince?: Date;
  openIntroductions: number;
}

export interface MatchingConfig {
  weights: { preferences: number; assessments: number; plans: number };
  minScore: number;
  topN: number;
  maxOpenIntroductions: number;
  /** Maximum extra score for members who have waited a long time for an introduction. */
  fairnessMaxBoost: number;
  fairnessAfterDays: number;
  /** Assessment dimensions where a different style complements rather than clashes. */
  complementaryDimensions: string[];
  /** A member who answered "open" to children satisfies a must-have of either yes or no. */
  opennessSatisfiesMustHave: boolean;
}

export const DEFAULT_MATCHING_CONFIG: MatchingConfig = {
  weights: { preferences: 0.35, assessments: 0.3, plans: 0.35 },
  minScore: 0.55,
  topN: 5,
  maxOpenIntroductions: 2,
  fairnessMaxBoost: 0.1,
  fairnessAfterDays: 30,
  complementaryDimensions: [],
  opennessSatisfiesMustHave: true,
};

export type ReasonCode =
  | 'preferences_met'
  | 'shared_timeline'
  | 'shared_kids'
  | 'shared_living'
  | 'same_city'
  | 'same_state'
  | 'similar_family'
  | 'assessment_similar'
  | 'assessment_complement'
  | 'recently_active'
  | 'waiting_longer';

export interface MatchReason {
  code: ReasonCode;
  dimension?: string;
}

export interface HardFilterResult {
  ok: boolean;
  /** Which member's must-have failed, and on what. */
  failed: { by: 'a' | 'b'; dimension: PreferenceDimension }[];
}

export interface MatchResult {
  eligible: boolean;
  failed: HardFilterResult['failed'];
  /** Final score in 0..1. Internal only: never shown to members. */
  score: number;
  signals: { preferences: number; assessments: number; plans: number; availability: number; fairness: number };
  reasons: MatchReason[];
  assessmentsMissing: boolean;
}

const lc = (s?: string) => s?.trim().toLowerCase();
const DAY = 86_400_000;

export function ageOf(p: MatchProfile, now: Date): number | undefined {
  return p.birthYear === undefined ? undefined : now.getUTCFullYear() - p.birthYear;
}

/** True/false when the target's value is known, `null` when it cannot be evaluated. */
function fieldMatches(values: string[], actual: string | undefined): boolean | null {
  if (actual === undefined || actual === '') return null;
  if (values.length === 0) return true; // "no preference" cannot fail
  return values.some((v) => lc(v) === lc(actual));
}

export function satisfies(pref: PrefDim, target: MatchProfile, cfg: MatchingConfig, now: Date): boolean | null {
  switch (pref.key) {
    case 'age': {
      const age = ageOf(target, now);
      if (age === undefined || !pref.range) return age === undefined ? null : true;
      return age >= pref.range.min && age <= pref.range.max;
    }
    case 'height':
      if (target.heightCm === undefined) return null;
      return pref.range ? target.heightCm >= pref.range.min && target.heightCm <= pref.range.max : true;
    case 'location': {
      if (!target.city && !target.state) return null;
      if (pref.values.length === 0) return true;
      return pref.values.some((v) => lc(v) === lc(target.city) || lc(v) === lc(target.state));
    }
    case 'religion':
      return fieldMatches(pref.values, target.religion);
    case 'community':
      return fieldMatches(pref.values, target.community);
    case 'mother_tongue':
      return fieldMatches(pref.values, target.motherTongue);
    case 'education':
      return fieldMatches(pref.values, target.education);
    case 'profession':
      return fieldMatches(pref.values, target.profession);
    case 'income':
      return fieldMatches(pref.values, target.incomeBand);
    case 'diet':
      return fieldMatches(pref.values, target.diet);
    case 'smoking':
      return fieldMatches(pref.values, target.smoking);
    case 'drinking':
      return fieldMatches(pref.values, target.drinking);
    case 'marital_status':
      return fieldMatches(pref.values, target.maritalStatus);
    case 'family_setup':
      return fieldMatches(pref.values, target.familyType);
    case 'kids': {
      if (!target.wantsKids) return null;
      if (cfg.opennessSatisfiesMustHave && target.wantsKids === 'open') return true;
      return fieldMatches(pref.values, target.wantsKids);
    }
    case 'marriage_timeline': {
      if (!target.marriageTimeline) return null;
      if (target.marriageTimeline === 'flexible') return true;
      return fieldMatches(pref.values, target.marriageTimeline);
    }
  }
}

/** Both members' must-haves must hold, in both directions. Unknown values fail a must-have. */
export function hardFilter(a: MatchProfile, b: MatchProfile, cfg: MatchingConfig, now: Date): HardFilterResult {
  const failed: HardFilterResult['failed'] = [];
  for (const p of a.prefs) {
    if (p.type !== 'must') continue;
    if (satisfies(p, b, cfg, now) !== true) failed.push({ by: 'a', dimension: p.key });
  }
  for (const p of b.prefs) {
    if (p.type !== 'must') continue;
    if (satisfies(p, a, cfg, now) !== true) failed.push({ by: 'b', dimension: p.key });
  }
  return { ok: failed.length === 0, failed };
}

/** Importance-weighted share of flexible preferences met. Unknown values count as half. */
function preferenceFit(owner: MatchProfile, target: MatchProfile, cfg: MatchingConfig, now: Date): number {
  const flex = owner.prefs.filter((p) => p.type === 'flexible');
  if (flex.length === 0) return 0.5;
  let got = 0;
  let total = 0;
  for (const p of flex) {
    const s = satisfies(p, target, cfg, now);
    total += p.importance;
    got += p.importance * (s === true ? 1 : s === null ? 0.5 : 0);
  }
  return got / total;
}

const harmonic = (x: number, y: number) => (x + y === 0 ? 0 : (2 * x * y) / (x + y));

const TIMELINE_ORDER = ['within_1_year', '1_2_years', '2_3_years'];

function planAlignment(a: MatchProfile, b: MatchProfile): { score: number; reasons: MatchReason[] } {
  const parts: number[] = [];
  const reasons: MatchReason[] = [];

  // Marriage timeline: same band is best, adjacent is fine, "flexible" fits anyone.
  if (a.marriageTimeline && b.marriageTimeline) {
    if (a.marriageTimeline === 'flexible' || b.marriageTimeline === 'flexible') parts.push(0.8);
    else {
      const d = Math.abs(TIMELINE_ORDER.indexOf(a.marriageTimeline) - TIMELINE_ORDER.indexOf(b.marriageTimeline));
      parts.push(d === 0 ? 1 : d === 1 ? 0.6 : 0.2);
      if (d === 0) reasons.push({ code: 'shared_timeline', dimension: 'marriage_timeline' });
    }
  }
  const choice = (x?: string, y?: string, code?: ReasonCode, dim?: string) => {
    if (!x || !y) return;
    if (x === y) {
      parts.push(1);
      if (code) reasons.push({ code, dimension: dim });
    } else if (x === 'open' || y === 'open') parts.push(0.6);
    else parts.push(0);
  };
  choice(a.wantsKids, b.wantsKids, 'shared_kids', 'kids');
  choice(a.livingWithFamily, b.livingWithFamily, 'shared_living', 'living_with_family');

  if (a.city && b.city) {
    if (lc(a.city) === lc(b.city)) {
      parts.push(1);
      reasons.push({ code: 'same_city', dimension: 'location' });
    } else if (a.state && b.state && lc(a.state) === lc(b.state)) {
      parts.push(0.6);
      reasons.push({ code: 'same_state', dimension: 'location' });
    } else parts.push(0.2);
  }
  if (a.familyType && b.familyType) {
    if (a.familyType === b.familyType) {
      parts.push(1);
      reasons.push({ code: 'similar_family', dimension: 'family_setup' });
    } else parts.push(0.6);
  }
  return { score: parts.length ? parts.reduce((s, x) => s + x, 0) / parts.length : 0.5, reasons };
}

function assessmentFit(
  a: MatchProfile,
  b: MatchProfile,
  cfg: MatchingConfig,
): { score: number; reasons: MatchReason[]; missing: boolean } {
  const sims: { dim: string; sim: number; complement: boolean }[] = [];
  for (const [key, dimsA] of Object.entries(a.assessments)) {
    const dimsB = b.assessments[key];
    if (!dimsB) continue;
    for (const [dim, va] of Object.entries(dimsA)) {
      const vb = dimsB[dim];
      if (vb === undefined) continue;
      const complement = cfg.complementaryDimensions.includes(dim);
      // Similar styles score high; for complementary dimensions, opposite styles do.
      const sim = complement ? 1 - Math.abs(va + vb - 1) : 1 - Math.abs(va - vb);
      sims.push({ dim, sim, complement });
    }
  }
  if (sims.length === 0) return { score: 0.5, reasons: [], missing: true };
  const score = sims.reduce((s, x) => s + x.sim, 0) / sims.length;
  const reasons = sims
    .filter((s) => s.sim >= 0.85)
    .sort((x, y) => y.sim - x.sim || x.dim.localeCompare(y.dim))
    .slice(0, 3)
    .map<MatchReason>((s) => ({ code: s.complement ? 'assessment_complement' : 'assessment_similar', dimension: s.dim }));
  return { score, reasons, missing: false };
}

function availability(p: MatchProfile, now: Date): number {
  if (!p.lastActiveAt) return 0.75;
  const days = (now.getTime() - p.lastActiveAt.getTime()) / DAY;
  return days <= 7 ? 1 : days <= 30 ? 0.9 : 0.75;
}

function fairness(p: MatchProfile, cfg: MatchingConfig, now: Date): number {
  if (!p.waitingSince) return 0;
  const days = (now.getTime() - p.waitingSince.getTime()) / DAY;
  if (days <= 0) return 0;
  // Linear ramp: no boost on day zero, the full boost once they have waited the configured days.
  return cfg.fairnessMaxBoost * Math.min(1, days / cfg.fairnessAfterDays);
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function sortedPairKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** Compatibility of an ordered pair. Pure and symmetric in everything that affects `eligible` and `score`. */
export function scorePair(a: MatchProfile, b: MatchProfile, cfg: MatchingConfig, now: Date): MatchResult {
  const hf = hardFilter(a, b, cfg, now);
  const prefA = preferenceFit(a, b, cfg, now);
  const prefB = preferenceFit(b, a, cfg, now);
  const prefs = harmonic(prefA, prefB);
  const assess = assessmentFit(a, b, cfg);
  const plan = planAlignment(a, b);

  const w = cfg.weights;
  const wSum = w.preferences + w.assessments + w.plans || 1;
  const base = (w.preferences * prefs + w.assessments * assess.score + w.plans * plan.score) / wSum;

  const avail = Math.min(availability(a, now), availability(b, now));
  const fair = Math.max(fairness(a, cfg, now), fairness(b, cfg, now));
  // Members already holding open introductions are ranked slightly lower so attention spreads out.
  const load = 1 - 0.05 * Math.min(2, a.openIntroductions + b.openIntroductions);
  const score = clamp01(base * avail * load + fair);

  const reasons: MatchReason[] = [];
  if (prefs >= 0.75 && a.prefs.some((p) => p.type === 'flexible') && b.prefs.some((p) => p.type === 'flexible')) {
    reasons.push({ code: 'preferences_met' });
  }
  reasons.push(...plan.reasons, ...assess.reasons);
  if (fair > 0) reasons.push({ code: 'waiting_longer' });
  if (avail === 1) reasons.push({ code: 'recently_active' });

  return {
    eligible: hf.ok,
    failed: hf.failed,
    score: round3(score),
    signals: {
      preferences: round3(prefs),
      assessments: round3(assess.score),
      plans: round3(plan.score),
      availability: round3(avail * load),
      fairness: round3(fair),
    },
    reasons,
    assessmentsMissing: assess.missing,
  };
}

/** Basic pair eligibility that is not about preferences: gender, adult ages. */
export function genderCompatible(a: Gender, b: Gender): boolean {
  return a !== b || a === 'non_binary';
}

export interface RankedCandidate {
  candidateId: string;
  result: MatchResult;
}

/**
 * Ranked candidates for one member. `excluded` holds ids that must never be suggested
 * (blocked, already introduced, declined, over capacity...). Ties break on the pair key so
 * the output is identical for identical input.
 */
export function rankCandidates(
  subject: MatchProfile,
  pool: MatchProfile[],
  excluded: ReadonlySet<string>,
  cfg: MatchingConfig,
  now: Date,
): RankedCandidate[] {
  const out: RankedCandidate[] = [];
  for (const c of pool) {
    if (c.id === subject.id || excluded.has(c.id)) continue;
    if (!genderCompatible(subject.gender, c.gender)) continue;
    if (c.openIntroductions >= cfg.maxOpenIntroductions) continue;
    const result = scorePair(subject, c, cfg, now);
    if (!result.eligible || result.score < cfg.minScore) continue;
    out.push({ candidateId: c.id, result });
  }
  out.sort(
    (x, y) =>
      y.result.score - x.result.score ||
      sortedPairKey(subject.id, x.candidateId).localeCompare(sortedPairKey(subject.id, y.candidateId)),
  );
  return out.slice(0, cfg.topN);
}

// ------------------------------------------------------------------ reasons in words

const REASON_TEXT: Record<ReasonCode, string> = {
  preferences_met: 'What you each said you are looking for lines up well.',
  shared_timeline: 'You both hope to marry within a similar timeframe.',
  shared_kids: 'You share the same view on having children.',
  shared_living: 'You see living arrangements with family in the same way.',
  same_city: 'You live in the same city.',
  same_state: 'You live in the same state.',
  similar_family: 'You grew up in similar kinds of family set-ups.',
  assessment_similar: 'Your answers suggest a similar approach to everyday life.',
  assessment_complement: 'Your styles are different in a way that tends to balance well.',
  recently_active: 'You are both active on Marchmaker at the moment.',
  waiting_longer: 'You have both been waiting patiently for the right introduction.',
};

const DIMENSION_TEXT: Record<string, string> = {
  ambition: 'You approach drive and ambition in a similar way.',
  tradition: 'You feel similarly about tradition and change.',
  security: 'You weigh stability and adventure in much the same way.',
  giving: 'Giving to others matters to you both in a similar way.',
  directness: 'You both communicate with a similar level of directness.',
  conflict_pace: 'You tend to work through disagreements at a similar pace.',
  expressiveness: 'You share feelings in a similar way.',
  family_involvement: 'You both picture family in a similar role in your life.',
  role_traditionalism: 'You picture home life and roles in a similar way.',
  privacy_need: 'You both value a similar balance of space and togetherness.',
  saving_orientation: 'You think about saving and spending in a similar way.',
  financial_transparency: 'You share a view on how open to be about money.',
  risk_appetite: 'You are comfortable with a similar level of financial risk.',
  social_energy: 'You enjoy a similar level of social life.',
  routine: 'You both like your days to feel a similar way, in terms of routine.',
  activity: 'You keep a similar pace in everyday life.',
  religiosity: 'Faith sits in a similar place in both your lives.',
  ritual_importance: 'Rituals and observances matter to you both in a similar way.',
  openness_to_difference: 'You are both similarly open to differences of background.',
};

/** Plain-language sentences for a reviewer to build "Why we introduced you" from. Never contains a number. */
export function reasonSentences(reasons: MatchReason[], limit = 4): string[] {
  // Mix kinds so a long list of life-plan reasons never crowds out how the two actually relate.
  const assess = reasons.filter((r) => r.code.startsWith('assessment'));
  const rest = reasons.filter((r) => !r.code.startsWith('assessment'));
  const ordered = [...rest.slice(0, 2), ...assess.slice(0, 2), ...rest.slice(2), ...assess.slice(2)];
  const out: string[] = [];
  for (const r of ordered) {
    const text = (r.code === 'assessment_similar' && r.dimension && DIMENSION_TEXT[r.dimension]) || REASON_TEXT[r.code];
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

/** Text a reviewer writes for members must not leak contact details or scores. */
export function whyTextProblems(text: string): string[] {
  const problems: string[] = [];
  const t = text.trim();
  if (t.length < 20) problems.push('Please write at least a couple of sentences.');
  if (t.length > 600) problems.push('Please keep it under 600 characters.');
  if (/\d{6,}|\+?\d[\d\s-]{8,}\d/.test(t)) problems.push('Do not include phone numbers.');
  if (/https?:\/\/|www\.|\S+@\S+\.\S+/i.test(t)) problems.push('Do not include links or email addresses.');
  if (/\b\d+\s*(%|percent)|\bscore\b|\bmatch(ed)? (score|percentage)\b/i.test(t)) problems.push('Describe compatibility in words, not scores.');
  return problems;
}
