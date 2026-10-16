import { describe, expect, it } from 'vitest';
import {
  ASSESSMENT_BANKS,
  ASSESSMENT_KEYS,
  bandFor,
  buildNarrative,
  isSafeRewrite,
  isValidAnswer,
  resumeIndex,
  rewriteNarrative,
  scoreAnswers,
  toPublicQuestion,
  type Answers,
  type QuestionDef,
} from '../src';

const likert: QuestionDef = { id: 'q1', type: 'likert', prompt: 'p', dimension: 'd' };
const rev: QuestionDef = { id: 'q2', type: 'likert', prompt: 'p', dimension: 'd', reverse: true };

describe('question banks', () => {
  it('provides six assessments with 8 to 15 questions and unique ids', () => {
    expect(ASSESSMENT_BANKS.map((b) => b.key).sort()).toEqual([...ASSESSMENT_KEYS].sort());
    for (const b of ASSESSMENT_BANKS) {
      expect(b.questions.length).toBeGreaterThanOrEqual(8);
      expect(b.questions.length).toBeLessThanOrEqual(15);
      const ids = b.questions.map((q) => q.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('only references declared dimensions and every dimension is measurable', () => {
    for (const b of ASSESSMENT_BANKS) {
      const used = new Set<string>();
      for (const q of b.questions) {
        if (q.dimension) used.add(q.dimension);
        q.items?.forEach((i) => used.add(i.dimension));
      }
      for (const d of used) expect(b.dimensions).toContain(d);
      for (const d of b.dimensions) expect(used.has(d)).toBe(true);
    }
  });

  it('never leaks scoring data through the public question shape', () => {
    for (const b of ASSESSMENT_BANKS) {
      const json = JSON.stringify(b.questions.map(toPublicQuestion));
      expect(json).not.toMatch(/"value"|"dimension"|"reverse"/);
    }
  });
});

describe('scoring', () => {
  it('maps likert answers to 0..1 and honours reverse items', () => {
    expect(scoreAnswers([likert], { q1: 5 })).toEqual({ d: 1 });
    expect(scoreAnswers([likert], { q1: 1 })).toEqual({ d: 0 });
    expect(scoreAnswers([likert, rev], { q1: 5, q2: 5 })).toEqual({ d: 0.5 });
  });

  it('scores single choice by option value and ranking by position', () => {
    const sc: QuestionDef = {
      id: 's',
      type: 'single_choice',
      prompt: 'p',
      dimension: 'd',
      options: [
        { id: 'a', label: 'A', value: 0.2 },
        { id: 'b', label: 'B', value: 0.9 },
      ],
    };
    expect(scoreAnswers([sc], { s: 'b' })).toEqual({ d: 0.9 });
    const rk: QuestionDef = {
      id: 'r',
      type: 'ranking',
      prompt: 'p',
      items: [
        { id: 'x', label: 'X', dimension: 'one' },
        { id: 'y', label: 'Y', dimension: 'two' },
        { id: 'z', label: 'Z', dimension: 'three' },
      ],
    };
    expect(scoreAnswers([rk], { r: ['y', 'x', 'z'] })).toEqual({ two: 1, one: 0.5, three: 0 });
  });

  it('ignores invalid and missing answers', () => {
    expect(scoreAnswers([likert], { q1: 9 })).toEqual({});
    expect(scoreAnswers([likert], {})).toEqual({});
  });

  it('validates answers per type', () => {
    expect(isValidAnswer(likert, 3)).toBe(true);
    expect(isValidAnswer(likert, 3.5)).toBe(false);
    expect(isValidAnswer(likert, '3')).toBe(false);
    const rk = ASSESSMENT_BANKS[0]!.questions.find((q) => q.type === 'ranking')!;
    const ids = rk.items!.map((i) => i.id);
    expect(isValidAnswer(rk, ids)).toBe(true);
    expect(isValidAnswer(rk, ids.slice(1))).toBe(false);
    expect(isValidAnswer(rk, [ids[0], ids[0], ...ids.slice(2)])).toBe(false);
  });

  it('finds the resume point', () => {
    const qs = ASSESSMENT_BANKS[0]!.questions;
    const a: Answers = { [qs[0]!.id]: 3, [qs[1]!.id]: 4 };
    expect(resumeIndex(qs, a)).toBe(2);
  });

  it('bands scores', () => {
    expect([0, 0.33, 0.34, 0.66, 0.67, 1].map(bandFor)).toEqual(['low', 'low', 'mid', 'mid', 'high', 'high']);
  });
});

describe('narratives', () => {
  it('writes in words only: no digits in any default text, for every band', () => {
    for (const b of ASSESSMENT_BANKS) {
      for (const level of [0, 0.5, 1]) {
        const scores = Object.fromEntries(b.dimensions.map((d) => [d, level]));
        const n = buildNarrative(b.key, scores);
        expect(n.sections).toHaveLength(b.dimensions.length);
        const all = [n.title, n.summary, n.closing, ...n.sections.map((s) => s.heading + s.body)].join(' ');
        expect(all).not.toMatch(/\d/);
        expect(all).not.toMatch(/\bscore|percent|%/i);
      }
    }
  });

  it('chooses the sentence for the band', () => {
    const low = buildNarrative('communication', { directness: 0.1 }).sections[0]!.body;
    const high = buildNarrative('communication', { directness: 0.9 }).sections[0]!.body;
    expect(low).not.toBe(high);
    expect(high).toMatch(/plainly|out in the open/);
  });

  it('accepts only safe rewrites', async () => {
    const orig = 'You are driven and like to be working towards something.';
    expect(isSafeRewrite(orig, 'You like to have a goal in front of you and work towards it.')).toBe(true);
    expect(isSafeRewrite(orig, 'You scored 85 percent on ambition.')).toBe(false);
    expect(isSafeRewrite(orig, 'Ok.')).toBe(false);
    expect(isSafeRewrite(orig, 'You are better than most people at being driven and working hard.')).toBe(false);

    const n = buildNarrative('values', { ambition: 0.9, tradition: 0.1 });
    const out = await rewriteNarrative(n, {
      rewrite: async (body, ctx) =>
        ctx.heading === 'Drive and ambition' ? 'You enjoy having something to aim for and tend to see growth as part of a good life.' : `${body} 99`,
    });
    expect(out.source).toBe('rewritten');
    expect(out.sections[0]!.body).toMatch(/aim for/);
    expect(out.sections[1]!.body).toBe(n.sections[1]!.body); // unsafe rewrite falls back to the template
  });

  it('falls back to templates when the rewriter fails', async () => {
    const n = buildNarrative('values', { ambition: 0.9 });
    const out = await rewriteNarrative(n, {
      rewrite: async () => {
        throw new Error('provider down');
      },
    });
    expect(out.source).toBe('template');
    expect(out.sections).toEqual(n.sections);
  });
});
