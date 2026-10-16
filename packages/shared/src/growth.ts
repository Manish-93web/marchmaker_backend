import { z } from 'zod';

// ------------------------------------------------------------------ analytics events

export const ANALYTICS_EVENTS = [
  'page_view',
  'cta_click',
  'signup_started',
  'onboarding_step',
  'pricing_viewed',
  'checkout_started',
  'experiment_exposed',
  'feature_used',
] as const;
export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number];

/** Only these property names are ever stored: nothing that could hold a name, email or free text. */
export const ANALYTICS_PROP_KEYS = ['path', 'step', 'plan', 'interval', 'cta', 'variant', 'experiment', 'feature', 'source'] as const;

const SAFE_VALUE = /^[A-Za-z0-9_\-./:]{1,60}$/;

export const analyticsBatchSchema = z.object({
  /** The browser's own consent decision. The server also checks signed-in members' stored consent. */
  consent: z.literal(true),
  anonId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  events: z
    .array(
      z.object({
        name: z.enum(ANALYTICS_EVENTS),
        props: z.record(z.string().max(30), z.union([z.string().max(200), z.number(), z.boolean()])).optional(),
        at: z.coerce.date().optional(),
      }),
    )
    .min(1)
    .max(20),
});

/** Keeps allowed keys with short, safe values and drops everything else. */
export function sanitizeProps(props: Record<string, unknown> | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!props) return out;
  for (const key of ANALYTICS_PROP_KEYS) {
    const v = props[key];
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[key] = v;
    else if (typeof v === 'string' && SAFE_VALUE.test(v)) out[key] = v;
  }
  return out;
}

// ------------------------------------------------------------------ experiments

export interface Variant {
  name: string;
  weight: number;
}

/** 32-bit FNV-1a: tiny, deterministic and the same in the browser and on the server. */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The same subject always lands in the same variant, and changing weights moves as few people as possible. */
export function assignVariant(experimentKey: string, subjectId: string, variants: Variant[]): string | null {
  const total = variants.reduce((s, v) => s + Math.max(0, v.weight), 0);
  if (!variants.length || total <= 0) return null;
  const point = (hash32(`${experimentKey}:${subjectId}`) / 0x1_0000_0000) * total;
  let acc = 0;
  for (const v of variants) {
    acc += Math.max(0, v.weight);
    if (point < acc) return v.name;
  }
  return variants[variants.length - 1]!.name;
}

export const experimentSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/),
  description: z.string().trim().max(300).default(''),
  enabled: z.boolean(),
  variants: z
    .array(z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/), weight: z.number().int().min(0).max(100) }))
    .min(2)
    .max(5)
    .refine((v) => new Set(v.map((x) => x.name)).size === v.length, 'Variant names must be different')
    .refine((v) => v.some((x) => x.weight > 0), 'At least one variant needs a weight'),
});
export type ExperimentInput = z.infer<typeof experimentSchema>;

// ------------------------------------------------------------------ feedback

export const FEEDBACK_TAGS = [
  'kind',
  'respectful',
  'shared_values',
  'good_conversation',
  'different_expectations',
  'slow_to_reply',
  'not_my_type',
  'felt_unsafe',
] as const;
export type FeedbackTag = (typeof FEEDBACK_TAGS)[number];

/** checkin = a week after unlock, closed = when a member ends the conversation, meeting = "did you meet?" three weeks in. */
export const FEEDBACK_STAGES = ['checkin', 'closed', 'meeting'] as const;
export type FeedbackStage = (typeof FEEDBACK_STAGES)[number];

export const introFeedbackSchema = z
  .object({
    introductionId: z.string().regex(/^[a-f\d]{24}$/i),
    stage: z.enum(FEEDBACK_STAGES).default('checkin'),
    /** How well the introduction fitted what you are looking for, 1 to 5. Optional only for the meeting question. */
    rating: z.number().int().min(1).max(5).optional(),
    /** For the meeting stage: did the two of you meet in person? */
    met: z.boolean().optional(),
    tags: z.array(z.enum(FEEDBACK_TAGS)).max(4).default([]),
    note: z.string().trim().max(500).optional(),
  })
  .refine((v) => (v.stage === 'meeting' ? v.met !== undefined : v.rating !== undefined), { message: 'Please answer the question' });

export const MEETING_AFTER_DAYS = 21;
/** Feedback can move each matching weight by at most this much, whatever the data says. */
export const MAX_LEARNED_SHIFT = 0.05;
export const MIN_LEARNED_SAMPLES = 30;

/** Pure: tallies decline reasons so staff and members can see a pattern. */
export function tallyReasons(reasons: (string | undefined | null)[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of reasons) if (r && r !== 'prefer_not_to_say') out[r] = (out[r] ?? 0) + 1;
  return out;
}

export interface PreferenceHint {
  reason: string;
  count: number;
  title: string;
  body: string;
  /** Preference page section to open. */
  focus: 'location' | 'life_plans' | 'timing' | 'general';
}

const HINTS: Record<string, Omit<PreferenceHint, 'reason' | 'count'>> = {
  location_doesnt_work: {
    title: 'Location keeps coming up',
    body: 'You have passed on a few introductions because of where people live. Widening or narrowing your location preference could help us send better ones.',
    focus: 'location',
  },
  different_life_plans: {
    title: 'Life plans matter a lot to you',
    body: 'Several introductions did not match what you want from life. Marking the plans that are essential for you helps us filter earlier.',
    focus: 'life_plans',
  },
  timing_not_right: {
    title: 'Is now the right time?',
    body: 'You have said the timing was not right a few times. You can pause introductions for a while, and we will be here when you are ready.',
    focus: 'timing',
  },
  not_feeling_connection: {
    title: 'Tell us what a good connection feels like',
    body: 'A few introductions did not feel right. Adding to your "about me" and completing the assessments helps our team understand what clicks for you.',
    focus: 'general',
  },
};

/** After this many of the same reason we suggest a change. Never automatic: the member decides. */
export const HINT_THRESHOLD = 3;

export function preferenceHints(tally: Record<string, number>): PreferenceHint[] {
  return Object.entries(tally)
    .filter(([reason, count]) => count >= HINT_THRESHOLD && HINTS[reason])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([reason, count]) => ({ reason, count, ...HINTS[reason]! }));
}

// ------------------------------------------------------------------ stories

export const storySubmitSchema = z.object({
  coupleNames: z.string().trim().min(3).max(80),
  city: z.string().trim().max(60).optional(),
  quote: z.string().trim().min(40, 'Please write a few sentences').max(600),
  /** Both people must agree to share their story publicly. */
  consent: z.literal(true),
  partnerConsent: z.literal(true),
});

export const storyDecisionSchema = z.object({
  decision: z.enum(['publish', 'reject']),
  /** The wording that will be shown. Staff may lightly edit it; the couple is told. */
  coupleNames: z.string().trim().min(3).max(80).optional(),
  quote: z.string().trim().min(20).max(600).optional(),
  partnerConsentConfirmed: z.boolean().optional(),
  note: z.string().trim().min(3).max(300),
});

// ------------------------------------------------------------------ metrics helpers

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export const pct = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

export const metricsRangeSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
