import { describe, expect, it } from 'vitest';
import {
  billingProfileSchema,
  couponDiscount,
  couponInputSchema,
  isUpgrade,
  prorateUpgradeCredits,
} from '../src';

describe('coupon discount', () => {
  it('applies percentages in whole paise with an optional cap', () => {
    expect(couponDiscount({ kind: 'percent', value: 20 }, 99_900)).toBe(19_980);
    expect(couponDiscount({ kind: 'percent', value: 50, maxDiscountPaise: 10_000 }, 99_900)).toBe(10_000);
    expect(couponDiscount({ kind: 'percent', value: 33 }, 100)).toBe(33);
  });
  it('never exceeds the amount and is never negative', () => {
    expect(couponDiscount({ kind: 'flat', value: 500_000 }, 49_900)).toBe(49_900);
    expect(couponDiscount({ kind: 'percent', value: 100 }, 49_900)).toBe(49_900);
    expect(couponDiscount({ kind: 'flat', value: 0 }, 49_900)).toBe(0);
  });
  it('validates coupon definitions', () => {
    expect(couponInputSchema.safeParse({ code: 'welcome10', kind: 'percent', value: 10 }).success).toBe(true);
    expect(couponInputSchema.parse({ code: 'welcome10', kind: 'percent', value: 10 }).code).toBe('WELCOME10');
    expect(couponInputSchema.safeParse({ code: 'x', kind: 'percent', value: 10 }).success).toBe(false);
    expect(couponInputSchema.safeParse({ code: 'BIG', kind: 'percent', value: 150 }).success).toBe(false);
  });
});

describe('upgrade proration', () => {
  const start = new Date('2026-06-01T00:00:00Z');
  const end = new Date('2026-07-01T00:00:00Z');
  it('scales the credit difference by the time left, rounding down', () => {
    expect(prorateUpgradeCredits(2, 5, start, end, start)).toBe(3);
    expect(prorateUpgradeCredits(2, 5, start, end, new Date('2026-06-16T00:00:00Z'))).toBe(1); // half left: 1.5 -> 1
    expect(prorateUpgradeCredits(2, 5, start, end, end)).toBe(0);
  });
  it('never gives negative credits, and handles odd periods', () => {
    expect(prorateUpgradeCredits(5, 2, start, end, start)).toBe(0);
    expect(prorateUpgradeCredits(0, 5, end, start, start)).toBe(5);
  });
  it('knows which direction is an upgrade', () => {
    expect(isUpgrade('essential', 'premium')).toBe(true);
    expect(isUpgrade('premium', 'essential')).toBe(false);
    expect(isUpgrade('free', 'essential')).toBe(true);
  });
});

describe('billing profile', () => {
  it('accepts a well-formed GSTIN and rejects others', () => {
    expect(billingProfileSchema.safeParse({ gstin: '27ABCDE1234F1Z5' }).success).toBe(true);
    expect(billingProfileSchema.safeParse({ gstin: '27abcde1234f1z5' }).success).toBe(true);
    expect(billingProfileSchema.safeParse({ gstin: 'NOTAGSTIN' }).success).toBe(false);
    expect(billingProfileSchema.safeParse({ stateCode: '7' }).success).toBe(false);
  });
});
