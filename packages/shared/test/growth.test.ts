import { describe, expect, it } from 'vitest';
import {
  HINT_THRESHOLD,
  analyticsBatchSchema,
  assignVariant,
  experimentSchema,
  median,
  pct,
  preferenceHints,
  sanitizeProps,
  tallyReasons,
} from '../src/growth';

describe('sanitizeProps', () => {
  it('keeps only known keys with short safe values', () => {
    expect(
      sanitizeProps({
        path: '/pricing',
        plan: 'premium',
        email: 'a@b.com',
        cta: 'hero button with spaces',
        step: 3,
        variant: 'b',
        note: 'free text',
      }),
    ).toEqual({ path: '/pricing', plan: 'premium', step: 3, variant: 'b' });
  });
  it('drops values that could hold personal data', () => {
    expect(sanitizeProps({ path: '/me?email=a@b.com', source: 'x'.repeat(100) })).toEqual({});
  });
  it('handles nothing', () => {
    expect(sanitizeProps(undefined)).toEqual({});
  });
});

describe('analytics batch', () => {
  const ok = { consent: true, anonId: 'abcd1234-ef', events: [{ name: 'page_view' }] };
  it('requires explicit consent and known events', () => {
    expect(analyticsBatchSchema.safeParse(ok).success).toBe(true);
    expect(analyticsBatchSchema.safeParse({ ...ok, consent: false }).success).toBe(false);
    expect(analyticsBatchSchema.safeParse({ ...ok, events: [{ name: 'keystroke' }] }).success).toBe(false);
    expect(analyticsBatchSchema.safeParse({ ...ok, events: [] }).success).toBe(false);
  });
});

describe('assignVariant', () => {
  const v = [
    { name: 'control', weight: 50 },
    { name: 'b', weight: 50 },
  ];
  it('is deterministic per subject and experiment', () => {
    expect(assignVariant('hero', 'user-1', v)).toBe(assignVariant('hero', 'user-1', v));
  });
  it('splits roughly by weight', () => {
    let b = 0;
    for (let i = 0; i < 4000; i++) if (assignVariant('hero', `u${i}`, v) === 'b') b++;
    expect(b).toBeGreaterThan(1800);
    expect(b).toBeLessThan(2200);
    let c = 0;
    for (let i = 0; i < 4000; i++) if (assignVariant('hero', `u${i}`, [{ name: 'x', weight: 90 }, { name: 'y', weight: 10 }]) === 'y') c++;
    expect(c).toBeGreaterThan(300);
    expect(c).toBeLessThan(500);
  });
  it('differs between experiments so tests do not correlate', () => {
    let same = 0;
    for (let i = 0; i < 1000; i++) if (assignVariant('one', `u${i}`, v) === assignVariant('two', `u${i}`, v)) same++;
    expect(same).toBeGreaterThan(400);
    expect(same).toBeLessThan(600);
  });
  it('never assigns a zero-weight variant, and returns null with no weight', () => {
    for (let i = 0; i < 500; i++) expect(assignVariant('k', `u${i}`, [{ name: 'a', weight: 0 }, { name: 'b', weight: 5 }])).toBe('b');
    expect(assignVariant('k', 'u', [{ name: 'a', weight: 0 }])).toBeNull();
    expect(assignVariant('k', 'u', [])).toBeNull();
  });
});

describe('experiment definition', () => {
  it('needs two different variants with some weight', () => {
    const base = { key: 'hero_copy', enabled: true };
    expect(experimentSchema.safeParse({ ...base, variants: [{ name: 'a', weight: 1 }, { name: 'a', weight: 1 }] }).success).toBe(false);
    expect(experimentSchema.safeParse({ ...base, variants: [{ name: 'a', weight: 0 }, { name: 'b', weight: 0 }] }).success).toBe(false);
    expect(experimentSchema.safeParse({ ...base, variants: [{ name: 'a', weight: 1 }, { name: 'b', weight: 1 }] }).success).toBe(true);
  });
});

describe('feedback hints', () => {
  it('ignores "prefer not to say" and counts the rest', () => {
    expect(tallyReasons(['location_doesnt_work', 'prefer_not_to_say', undefined, 'location_doesnt_work'])).toEqual({ location_doesnt_work: 2 });
  });
  it('only suggests a change once a pattern is clear', () => {
    expect(preferenceHints({ location_doesnt_work: HINT_THRESHOLD - 1 })).toEqual([]);
    const h = preferenceHints({ location_doesnt_work: HINT_THRESHOLD, timing_not_right: HINT_THRESHOLD + 2 });
    expect(h.map((x) => x.reason)).toEqual(['timing_not_right', 'location_doesnt_work']);
    expect(h[0]!.body).not.toMatch(/\d/);
  });
});

describe('metric helpers', () => {
  it('computes medians and percentages safely', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(pct(1, 3)).toBe(33.3);
    expect(pct(1, 0)).toBeNull();
  });
});
