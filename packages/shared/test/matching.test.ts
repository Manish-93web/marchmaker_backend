import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MATCHING_CONFIG as CFG,
  genderCompatible,
  hardFilter,
  rankCandidates,
  reasonSentences,
  scorePair,
  sortedPairKey,
  whyTextProblems,
  type MatchProfile,
} from '../src';

const NOW = new Date('2026-06-01T00:00:00Z');

function person(id: string, over: Partial<MatchProfile> = {}): MatchProfile {
  return {
    id,
    gender: 'woman',
    birthYear: 1996,
    heightCm: 165,
    city: 'Pune',
    state: 'Maharashtra',
    religion: 'Hindu',
    motherTongue: 'Marathi',
    diet: 'vegetarian',
    smoking: 'never',
    drinking: 'never',
    maritalStatus: 'never_married',
    wantsKids: 'yes',
    familyType: 'nuclear',
    marriageTimeline: '1_2_years',
    livingWithFamily: 'open',
    prefs: [],
    assessments: {},
    lastActiveAt: new Date('2026-05-30T00:00:00Z'),
    openIntroductions: 0,
    ...over,
  };
}
const man = (id: string, over: Partial<MatchProfile> = {}) =>
  person(id, { gender: 'man', birthYear: 1993, heightCm: 178, ...over });

describe('hard filters', () => {
  it('require every must-have, in both directions', () => {
    const a = person('a', { prefs: [{ key: 'diet', type: 'must', values: ['vegetarian'], importance: 3 }] });
    expect(hardFilter(a, man('b'), CFG, NOW).ok).toBe(true);
    const r = hardFilter(a, man('c', { diet: 'non_vegetarian' }), CFG, NOW);
    expect(r.ok).toBe(false);
    expect(r.failed).toEqual([{ by: 'a', dimension: 'diet' }]);

    const b = man('d', { prefs: [{ key: 'religion', type: 'must', values: ['Muslim'], importance: 2 }] });
    expect(hardFilter(person('e'), b, CFG, NOW).failed).toEqual([{ by: 'b', dimension: 'religion' }]);
  });

  it('treats an unknown value as failing a must-have, but not a flexible preference', () => {
    const must = person('a', { prefs: [{ key: 'smoking', type: 'must', values: ['never'], importance: 1 }] });
    expect(hardFilter(must, man('b', { smoking: undefined }), CFG, NOW).ok).toBe(false);
    const flex = person('c', { prefs: [{ key: 'smoking', type: 'flexible', values: ['never'], importance: 1 }] });
    expect(hardFilter(flex, man('d', { smoking: undefined }), CFG, NOW).ok).toBe(true);
  });

  it('evaluates age and height ranges and location lists', () => {
    const a = person('a', {
      prefs: [
        { key: 'age', type: 'must', values: [], range: { min: 28, max: 34 }, importance: 2 },
        { key: 'height', type: 'must', values: [], range: { min: 170, max: 190 }, importance: 2 },
        { key: 'location', type: 'must', values: ['Pune', 'Maharashtra'], importance: 2 },
      ],
    });
    expect(hardFilter(a, man('b'), CFG, NOW).ok).toBe(true);
    expect(hardFilter(a, man('c', { birthYear: 1980 }), CFG, NOW).failed.map((f) => f.dimension)).toEqual(['age']);
    const far = hardFilter(a, man('d', { heightCm: 160, city: 'Delhi', state: 'Delhi' }), CFG, NOW);
    expect(far.failed.map((f) => f.dimension).sort()).toEqual(['height', 'location']);
  });

  it('lets open and flexible members satisfy kids and timeline must-haves', () => {
    const a = person('a', {
      prefs: [
        { key: 'kids', type: 'must', values: ['no'], importance: 3 },
        { key: 'marriage_timeline', type: 'must', values: ['within_1_year'], importance: 3 },
      ],
    });
    expect(hardFilter(a, man('b', { wantsKids: 'open', marriageTimeline: 'flexible' }), CFG, NOW).ok).toBe(true);
    expect(hardFilter(a, man('c', { wantsKids: 'yes', marriageTimeline: '2_3_years' }), CFG, NOW).ok).toBe(false);
    const strict = { ...CFG, opennessSatisfiesMustHave: false };
    const r = hardFilter(a, man('d', { wantsKids: 'open', marriageTimeline: 'flexible' }), strict, NOW);
    expect(r.failed.map((f) => f.dimension)).toEqual(['kids']);
  });
});

describe('scoring', () => {
  it('is symmetric and deterministic', () => {
    const a = person('a', {
      prefs: [{ key: 'diet', type: 'flexible', values: ['vegetarian'], importance: 3 }],
      assessments: { communication: { directness: 0.8, conflict_pace: 0.4 } },
      waitingSince: new Date('2026-05-01T00:00:00Z'),
    });
    const b = man('b', { assessments: { communication: { directness: 0.7, conflict_pace: 0.5 } } });
    const ab = scorePair(a, b, CFG, NOW);
    const ba = scorePair(b, a, CFG, NOW);
    expect(ab.score).toBe(ba.score);
    expect(ab.signals).toEqual(ba.signals);
    expect(scorePair(a, b, CFG, NOW)).toEqual(ab);
  });

  it('scores a closer fit higher', () => {
    const a = person('a', { assessments: { values: { ambition: 0.9, tradition: 0.2 } } });
    const close = man('close', { assessments: { values: { ambition: 0.85, tradition: 0.25 } } });
    const far = man('far', {
      assessments: { values: { ambition: 0.1, tradition: 0.9 } },
      city: 'Chennai',
      state: 'Tamil Nadu',
      marriageTimeline: '2_3_years',
    });
    expect(scorePair(a, close, CFG, NOW).score).toBeGreaterThan(scorePair(a, far, CFG, NOW).score);
  });

  it('uses the harmonic mean so a one-sided fit is not enough', () => {
    const flex = (vals: string[]) => [{ key: 'diet' as const, type: 'flexible' as const, values: vals, importance: 3 }];
    const a = person('a', { prefs: flex(['vegetarian']) });
    const happyBoth = man('b', { prefs: flex(['vegetarian']) });
    const oneSided = man('c', { prefs: flex(['jain']) });
    expect(scorePair(a, happyBoth, CFG, NOW).signals.preferences).toBeGreaterThan(
      scorePair(a, oneSided, CFG, NOW).signals.preferences,
    );
  });

  it('treats complementary dimensions as best when opposite', () => {
    const cfg = { ...CFG, complementaryDimensions: ['social_energy'] };
    const a = person('a', { assessments: { lifestyle: { social_energy: 0.9 } } });
    const opposite = man('b', { assessments: { lifestyle: { social_energy: 0.1 } } });
    const same = man('c', { assessments: { lifestyle: { social_energy: 0.9 } } });
    expect(scorePair(a, opposite, cfg, NOW).signals.assessments).toBeGreaterThan(
      scorePair(a, same, cfg, NOW).signals.assessments,
    );
    expect(scorePair(a, opposite, cfg, NOW).reasons.some((r) => r.code === 'assessment_complement')).toBe(true);
  });

  it('flags missing assessments and stays neutral rather than guessing', () => {
    const r = scorePair(person('a'), man('b'), CFG, NOW);
    expect(r.assessmentsMissing).toBe(true);
    expect(r.signals.assessments).toBe(0.5);
  });

  it('boosts long-waiting members up to a cap, and ranks busy members slightly lower', () => {
    const waiting = person('a', { waitingSince: new Date('2026-03-01T00:00:00Z') });
    const fresh = person('a2');
    const b = man('b');
    const boosted = scorePair(waiting, b, CFG, NOW);
    expect(boosted.signals.fairness).toBe(CFG.fairnessMaxBoost);
    expect(boosted.score).toBeGreaterThan(scorePair(fresh, b, CFG, NOW).score);

    const busy = man('c', { openIntroductions: 1 });
    expect(scorePair(fresh, busy, CFG, NOW).score).toBeLessThan(scorePair(fresh, b, CFG, NOW).score);
  });

  it('never exceeds 1 and always rounds to three places', () => {
    const r = scorePair(person('a', { waitingSince: new Date('2020-01-01T00:00:00Z') }), man('b'), CFG, NOW);
    expect(r.score).toBeLessThanOrEqual(1);
    expect(Math.round(r.score * 1000) / 1000).toBe(r.score);
  });
});

describe('ranking', () => {
  it('excludes blocked, over-capacity, same-gender and must-have-failing candidates', () => {
    const subject = person('s');
    const pool = [
      man('m1'),
      man('m2', { city: 'Chennai', state: 'Tamil Nadu' }),
      man('blocked'),
      man('busy', { openIntroductions: 2 }),
      person('sameGender'),
      man('hardFail', { prefs: [{ key: 'religion', type: 'must', values: ['Sikh'], importance: 3 }] }),
    ];
    const out = rankCandidates(subject, pool, new Set(['blocked']), CFG, NOW);
    const ids = out.map((r) => r.candidateId);
    expect(ids).toContain('m1');
    for (const bad of ['blocked', 'busy', 'sameGender', 'hardFail']) expect(ids).not.toContain(bad);
    expect(out[0]!.result.score).toBeGreaterThanOrEqual(out[out.length - 1]!.result.score);
  });

  it('respects topN and the minimum score, and breaks ties by pair key', () => {
    const subject = person('s');
    const pool = Array.from({ length: 8 }, (_, i) => man(`m${i}`));
    const out = rankCandidates(subject, pool, new Set(), { ...CFG, topN: 3 }, NOW);
    expect(out.map((r) => r.candidateId)).toEqual(['m0', 'm1', 'm2']);
    expect(rankCandidates(subject, pool, new Set(), { ...CFG, minScore: 0.999 }, NOW)).toEqual([]);
  });

  it('gives the same answer for the same input, in any pool order', () => {
    const subject = person('s');
    const pool = [man('a', { city: 'Mumbai' }), man('b'), man('c', { marriageTimeline: '2_3_years' })];
    const one = rankCandidates(subject, pool, new Set(), CFG, NOW);
    const two = rankCandidates(subject, [...pool].reverse(), new Set(), CFG, NOW);
    expect(two).toEqual(one);
  });

  it('allows non-binary members to be matched with anyone', () => {
    expect(genderCompatible('woman', 'man')).toBe(true);
    expect(genderCompatible('woman', 'woman')).toBe(false);
    expect(genderCompatible('non_binary', 'non_binary')).toBe(true);
    expect(genderCompatible('non_binary', 'woman')).toBe(true);
  });

  it('sorts pair keys regardless of order', () => {
    expect(sortedPairKey('b', 'a')).toBe(sortedPairKey('a', 'b'));
  });
});

describe('reasons in words', () => {
  it('turns machine reasons into number-free sentences', () => {
    const r = scorePair(
      person('a', { assessments: { communication: { directness: 0.8 } } }),
      man('b', { assessments: { communication: { directness: 0.82 } } }),
      CFG,
      NOW,
    );
    const lines = reasonSentences(r.reasons);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join(' ')).not.toMatch(/\d/);
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(lines.some((l) => /directness/.test(l))).toBe(true);
  });

  it('catches contact details, links and scores in the written explanation', () => {
    expect(whyTextProblems('You both love long walks and quiet weekends, and want a similar pace of life.')).toEqual([]);
    expect(whyTextProblems('Call her on 98765 43210 to talk about it.').join(' ')).toMatch(/phone/);
    expect(whyTextProblems('See www.example.com or mail a@b.co for details of this match.').join(' ')).toMatch(/links/);
    expect(whyTextProblems('You are a 92% match and your score is very high for each other.').join(' ')).toMatch(/words, not scores/);
    expect(whyTextProblems('Too short.').join(' ')).toMatch(/at least/);
  });
});
