import { z } from 'zod';
import { DEFAULTS, DEFAULT_MATCHING_CONFIG, type MatchingConfig } from '@marchmaker/shared';
import { Setting } from '../models/core';

const matchingSettingsSchema = z
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
    /** Let bounded nudges learned from member feedback adjust the weights. */
    useFeedback: z.boolean().optional(),
  })
  .refine((v) => v.weights.preferences + v.weights.assessments + v.weights.plans > 0, {
    path: ['weights'],
    message: 'At least one weight must be above zero',
  });

const reviewSettingsSchema = z.object({
  cooloffMinutes: z.number().int().min(0).max(240),
  introExpiryDays: z.number().int().min(1).max(30),
  matchmakerDailyCapacity: z.number().int().min(1).max(500),
  reviewSlaHours: z.number().int().min(1).max(240),
});
export type ReviewSettings = z.infer<typeof reviewSettingsSchema>;

const DEFAULT_REVIEW_SETTINGS: ReviewSettings = {
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
  const stored = await read<MatchingConfig & { useFeedback?: boolean }>('matching');
  const weights = { ...DEFAULT_MATCHING_CONFIG.weights, ...stored?.weights };
  if (stored?.useFeedback !== false) {
    // Bounded nudges learned from member feedback (see feedback.refreshLearnedWeights).
    const learned = (await Setting.findOne({ key: 'matching_learned' }).lean())?.value as { delta?: Record<string, number> } | undefined;
    for (const k of ['preferences', 'assessments', 'plans'] as const) weights[k] = Math.max(0.05, weights[k] + (learned?.delta?.[k] ?? 0));
  }
  return { ...DEFAULT_MATCHING_CONFIG, ...stored, weights };
}

export async function getReviewSettings(): Promise<ReviewSettings> {
  return { ...DEFAULT_REVIEW_SETTINGS, ...(await read<ReviewSettings>('review')) };
}

const retentionSettingsSchema = z.object({
  /** Days after a decision before identity images are deleted. */
  evidenceDays: z.number().int().min(1).max(365),
  /** Days a member can change their mind after asking to delete their account. */
  deletionGraceDays: z.number().int().min(1).max(60),
});
export type RetentionSettings = z.infer<typeof retentionSettingsSchema>;

const dataRequestSettingsSchema = z.object({
  /** When on, a super admin approves every export and deletion before it runs. */
  requireApproval: z.boolean(),
});
export type DataRequestSettings = z.infer<typeof dataRequestSettingsSchema>;

/** Defaults come from the environment and constants, so nothing changes until staff edit them. */
export async function getRetention(env: { EVIDENCE_RETENTION_DAYS: number }): Promise<RetentionSettings> {
  return {
    evidenceDays: env.EVIDENCE_RETENTION_DAYS,
    deletionGraceDays: DEFAULTS.accountDeletionGraceDays,
    ...(await read<RetentionSettings>('retention')),
  };
}

export async function getDataRequestSettings(): Promise<DataRequestSettings> {
  return { requireApproval: false, ...(await read<DataRequestSettings>('data_requests')) };
}

export type SettingKey = 'matching' | 'review' | 'retention' | 'data_requests';

export async function saveSettings(
  key: SettingKey,
  value: unknown,
  actorId: string,
  env: { EVIDENCE_RETENTION_DAYS: number } = { EVIDENCE_RETENTION_DAYS: 30 },
): Promise<{ before: unknown; after: unknown }> {
  const schemas = { matching: matchingSettingsSchema, review: reviewSettingsSchema, retention: retentionSettingsSchema, data_requests: dataRequestSettingsSchema };
  const parsed = schemas[key].parse(value);
  const before =
    key === 'matching' ? await getMatchingConfig() : key === 'review' ? await getReviewSettings() : key === 'retention' ? await getRetention(env) : await getDataRequestSettings();
  await Setting.updateOne({ key }, { $set: { value: parsed, updatedBy: actorId } }, { upsert: true });
  return { before, after: parsed };
}
