import { z } from 'zod';
import { BILLING_INTERVALS } from './enums';
import { assertPaise, type Paise } from './money';

// ------------------------------------------------------------------ coupons

export interface CouponTerms {
  kind: 'percent' | 'flat';
  /** percent: 1..100. flat: paise. */
  value: number;
  /** Optional ceiling for percentage coupons, in paise. */
  maxDiscountPaise?: number;
}

/** Discount in whole paise. Never more than the amount, never negative. */
export function couponDiscount(terms: CouponTerms, amountPaise: Paise): Paise {
  assertPaise(amountPaise);
  const raw = terms.kind === 'percent' ? Math.floor((amountPaise * terms.value) / 100) : terms.value;
  const capped = terms.maxDiscountPaise !== undefined ? Math.min(raw, terms.maxDiscountPaise) : raw;
  return Math.max(0, Math.min(capped, amountPaise));
}

export const couponInputSchema = z
  .object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,24}$/, 'Use 3 to 24 letters, numbers, - or _'),
    description: z.string().trim().max(200).optional(),
    kind: z.enum(['percent', 'flat']),
    value: z.number().int().min(1),
    maxDiscountPaise: z.number().int().min(1).optional(),
    expiresAt: z.coerce.date().optional(),
    maxUses: z.number().int().min(1).optional(),
    perUserLimit: z.number().int().min(1).max(20).default(1),
    /** Empty means valid for everything. Otherwise plan codes and pack codes it applies to. */
    appliesTo: z.array(z.string().max(30)).max(20).default([]),
    /** Razorpay offer to attach to subscriptions (created in the Razorpay dashboard). */
    razorpayOfferId: z.string().max(60).optional(),
    active: z.boolean().default(true),
  })
  .superRefine((c, ctx) => {
    if (c.kind === 'percent' && c.value > 100) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'A percentage cannot be more than 100' });
    }
  });
export type CouponInput = z.infer<typeof couponInputSchema>;

// ------------------------------------------------------------------ plan changes

/**
 * Extra credits when upgrading mid-cycle: the difference between the two plans' credits,
 * scaled by how much of the current cycle is left. Rounded down, never negative.
 */
export function prorateUpgradeCredits(
  oldCredits: number,
  newCredits: number,
  periodStart: Date,
  periodEnd: Date,
  now: Date,
): number {
  const total = periodEnd.getTime() - periodStart.getTime();
  if (total <= 0) return Math.max(0, newCredits - oldCredits);
  const left = Math.min(1, Math.max(0, (periodEnd.getTime() - now.getTime()) / total));
  return Math.max(0, Math.floor((newCredits - oldCredits) * left));
}

export const PLAN_RANK: Record<string, number> = { free: 0, essential: 1, premium: 2, concierge: 3 };

export function isUpgrade(from: string, to: string): boolean {
  return (PLAN_RANK[to] ?? 0) > (PLAN_RANK[from] ?? 0);
}

// ------------------------------------------------------------------ dunning

export const GRACE_DAYS = 3;
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

// ------------------------------------------------------------------ requests

export const subscribeSchema = z.object({
  planCode: z.enum(['essential', 'premium', 'concierge']),
  interval: z.enum(BILLING_INTERVALS),
  couponCode: z.string().trim().toUpperCase().max(24).optional(),
});

export const packOrderSchema = z.object({
  packCode: z.string().regex(/^pack_\d+$/),
  useWallet: z.boolean().optional(),
  couponCode: z.string().trim().toUpperCase().max(24).optional(),
});

export const changePlanSchema = z.object({
  planCode: z.enum(['essential', 'premium', 'concierge']),
  interval: z.enum(BILLING_INTERVALS),
});

export const billingProfileSchema = z.object({
  legalName: z.string().trim().max(120).optional(),
  /** Indian GSTIN: 15 characters. Optional, for B2B invoices. */
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Enter a valid 15 character GSTIN')
    .optional(),
  stateCode: z.string().regex(/^\d{2}$/, 'Choose your state').optional(),
});

export const refundSchema = z.object({
  amountPaise: z.number().int().min(100).optional(),
  reason: z.string().trim().min(5).max(300),
});

/** GST state codes, used for place of supply. */
export const GST_STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa',
  '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
};
