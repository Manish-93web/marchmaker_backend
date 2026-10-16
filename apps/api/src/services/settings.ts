import { z } from 'zod';
import { DEFAULTS, DEFAULT_MATCHING_CONFIG, type MatchingConfig } from '@marchmaker/shared';
import { Setting } from '../models/core';

export const matchingSettingsSchema = z
  .object({
    weights: z.object({
      preferences: z.number().min(0).max(1),
      assessments: z.number().min(0).max(1),
      plans: z.number().min(0).max(1),
    }),
    minScore: z.number().min(0).max(1),
    topN: z.number().int().min(1).max(25),
    maxOpenIntroductions: z.number().int().min(1).max(10),
    fairnessMaxBoost: z.number().min(0).max(0.3),
    fairnessAfterDays: z.number().int().min(1).max(180),
    complementaryDimensions: z.array(z.string().max(40)).max(30),
    opennessSatisfiesMustHave: z.boolean(),
  })
  .refine((v) => v.weights.preferences + v.weights.assessments + v.weights.plans > 0, {
    path: ['weights'],
    message: 'At least one weight must be above zero',
  });

export const reviewSettingsSchema = z.object({
  cooloffMinutes: z.number().int().min(0).max(240),
  introExpiryDays: z.number().int().min(1).max(30),
  matchmakerDailyCapacity: z.number().int().min(1).max(500),
  reviewSlaHours: z.number().int().min(1).max(240),
});
export type ReviewSettings = z.infer<typeof reviewSettingsSchema>;

export const DEFAULT_REVIEW_SETTINGS: ReviewSettings = {
  cooloffMinutes: DEFAULTS.releaseCooloffMinutes,
  introExpiryDays: DEFAULTS.introExpiryDays,
  matchmakerDailyCapacity: 25,
  reviewSlaHours: 48,
};

async function read<T>(key: string): Promise<Partial<T> | undefined> {
  const row = await Setting.findOne({ key }).lean();
  return (row?.value as Partial<T> | undefined) ?? undefined;
}

export async function getMatchingConfig(): Promise<MatchingConfig> {
  const stored = await read<MatchingConfig>('matching');
  return { ...DEFAULT_MATCHING_CONFIG, ...stored, weights: { ...DEFAULT_MATCHING_CONFIG.weights, ...stored?.weights } };
}

export async function getReviewSettings(): Promise<ReviewSettings> {
  return { ...DEFAULT_REVIEW_SETTINGS, ...(await read<ReviewSettings>('review')) };
}

export async function saveSettings(
  key: 'matching' | 'review',
  value: unknown,
  actorId: string,
): Promise<{ before: unknown; after: unknown }> {
  const schema = key === 'matching' ? matchingSettingsSchema : reviewSettingsSchema;
  const parsed = schema.parse(value);
  const before = key === 'matching' ? await getMatchingConfig() : await getReviewSettings();
  await Setting.updateOne({ key }, { $set: { value: parsed, updatedBy: actorId } }, { upsert: true });
  return { before, after: parsed };
}
