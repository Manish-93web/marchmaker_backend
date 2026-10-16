import type { BillingInterval, PlanCode } from './enums';
import type { Paise } from './money';

export interface PlanDefinition {
  code: PlanCode | `pack_${number}`;
  kind: 'subscription' | 'pack';
  name: string;
  tagline: string;
  /** Price in paise, GST inclusive, per billing interval offered. */
  prices: Partial<Record<BillingInterval, Paise>>;
  /** Introduction credits granted per billing cycle (subscriptions) or once (packs). */
  credits: number;
  /** Concierge only: fair-use cap on reviewed introductions per cycle. */
  fairUseCap?: number;
  features: string[];
  highlight?: boolean;
  sortOrder: number;
}

/** Quarterly = 3 months less 10%; annual = 12 months less 25% (seed defaults, editable in admin). */
const monthly = (p: Paise) => p;
const quarterly = (p: Paise) => Math.round(p * 3 * 0.9);
const annual = (p: Paise) => Math.round(p * 12 * 0.75);

/**
 * Seed defaults and the pre-render fallback. The live source of truth is the `plans`
 * collection, editable by admins; the API and the seed script both start from this list.
 */
export const DEFAULT_PLANS: PlanDefinition[] = [
  {
    code: 'free',
    kind: 'subscription',
    name: 'Free',
    tagline: 'Build your profile and see what we are about',
    prices: { monthly: 0 },
    credits: 0,
    features: [
      'Full profile, preferences and compatibility assessments',
      'ID and selfie verification',
      'Journey tracker so you always know what is next',
      'Receive reviewed introduction previews',
      'Support chat',
    ],
    sortOrder: 0,
  },
  {
    code: 'essential',
    kind: 'subscription',
    name: 'Essential',
    tagline: 'Unlock introductions at a steady pace',
    prices: { monthly: monthly(99_900), quarterly: quarterly(99_900), annual: annual(99_900) },
    credits: 2,
    features: [
      '2 introduction credits every month',
      'Accept introductions and send a first note',
      'Email and in-app alerts',
      'Credit returned if the other person declines or does not reply',
    ],
    sortOrder: 1,
  },
  {
    code: 'premium',
    kind: 'subscription',
    name: 'Premium',
    tagline: 'More introductions, reviewed first',
    prices: { monthly: monthly(249_900), quarterly: quarterly(249_900), annual: annual(249_900) },
    credits: 5,
    features: [
      '5 introduction credits every month',
      'Priority human review',
      'Expanded "why we introduced you" explanation',
      'Optional Kundli and astrology report',
      'WhatsApp alerts',
      'E-guides with audio',
    ],
    highlight: true,
    sortOrder: 2,
  },
  {
    code: 'concierge',
    kind: 'subscription',
    name: 'Concierge',
    tagline: 'A dedicated matchmaker, start to finish',
    prices: { quarterly: 799_900 },
    credits: 0,
    fairUseCap: 12,
    features: [
      'A dedicated matchmaker',
      'Unlimited reviewed introductions (fair use)',
      'A monthly call with your matchmaker',
      'Help writing your profile',
      'Everything in Premium',
    ],
    sortOrder: 3,
  },
];

export const DEFAULT_PACKS: PlanDefinition[] = [
  {
    code: 'pack_1',
    kind: 'pack',
    name: '1 introduction',
    tagline: 'A single credit that never expires',
    prices: { monthly: 49_900 },
    credits: 1,
    features: ['Credits never expire while your account is active'],
    sortOrder: 10,
  },
  {
    code: 'pack_3',
    kind: 'pack',
    name: '3 introductions',
    tagline: 'Three credits that never expire',
    prices: { monthly: 129_900 },
    credits: 3,
    features: ['Credits never expire while your account is active'],
    sortOrder: 11,
  },
];

/** Percentage saved versus paying monthly for the whole period. */
export function savingsPercent(plan: Pick<PlanDefinition, 'prices'>, interval: BillingInterval): number {
  const m = plan.prices.monthly;
  const p = plan.prices[interval];
  if (!m || p === undefined || interval === 'monthly') return 0;
  const months = interval === 'quarterly' ? 3 : 12;
  return Math.round((1 - p / (m * months)) * 100);
}
