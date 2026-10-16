/** Minimum legal marriage ages in India (Prohibition of Child Marriage Act). */
export const MIN_AGE = { woman: 18, man: 21, non_binary: 21 } as const;

export const API_PREFIX = '/api/v1';

export const DEFAULTS = {
  accessTokenTtlSec: 15 * 60,
  adminAbsoluteSessionSec: 8 * 60 * 60,
  adminIdleSessionSec: 30 * 60,
  introExpiryDays: 7,
  introReminderHours: [48, 12] as const,
  maxActiveIntroductions: 2,
  releaseCooloffMinutes: 10,
  assessmentRetakeDays: 90,
  idEvidenceRetentionDays: 30,
  accountDeletionGraceDays: 14,
  maxPhotos: 6,
  firstNoteMin: 50,
  firstNoteMax: 500,
  autosaveDebounceMs: 800,
  signedUrlTtlSec: 300,
  otpTtlSec: 300,
  otpMaxAttempts: 5,
  haltedGraceDays: 3,
} as const;

export const FEATURE_FLAGS = [
  'kyc_automated',
  'astrology',
  'voice_calls',
  'voice_transcription_server',
  'llm_narratives',
  'whatsapp',
  'web_push',
  'e_guides',
] as const;
export type FeatureFlagKey = (typeof FEATURE_FLAGS)[number];
