export const ROLES = [
  'member',
  'support_agent',
  'matchmaker',
  'verifier',
  'moderator',
  'finance',
  'admin',
  'super_admin',
] as const;
export type Role = (typeof ROLES)[number];

export const ACCOUNT_STATUSES = ['active', 'paused', 'suspended', 'banned', 'deletion_scheduled', 'deleted'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const PROFILE_STATUSES = ['draft', 'submitted', 'changes_requested', 'approved'] as const;
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];

export const PROFILE_STEPS = [
  'basics',
  'background',
  'education_career',
  'family',
  'lifestyle',
  'values',
  'about',
  'photos',
] as const;
export type ProfileStep = (typeof PROFILE_STEPS)[number];

export const VERIFICATION_TYPES = ['id', 'selfie', 'liveness'] as const;
export type VerificationType = (typeof VERIFICATION_TYPES)[number];

export const VERIFICATION_STATUSES = ['draft', 'pending', 'in_review', 'approved', 'rejected', 'reupload_requested'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const ID_DOC_TYPES = ['aadhaar_masked', 'pan', 'passport', 'driving_licence', 'voter_id'] as const;
export type IdDocType = (typeof ID_DOC_TYPES)[number];

export const SUGGESTION_STATUSES = ['suggested', 'in_review', 'approved', 'rejected', 'snoozed', 'escalated'] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

export const INTRO_STATES = [
  'released',
  'viewed',
  'accepted_by_one',
  'mutually_accepted',
  'declined',
  'expired',
] as const;
export type IntroState = (typeof INTRO_STATES)[number];

export const SUBSCRIPTION_STATES = [
  'created',
  'authenticated',
  'active',
  'pending',
  'halted',
  'paused',
  'cancelled',
  'completed',
  'expired',
] as const;
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];

export const PLAN_CODES = ['free', 'essential', 'premium', 'concierge'] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

export const BILLING_INTERVALS = ['monthly', 'quarterly', 'annual'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

export const CREDIT_LEDGER_TYPES = ['grant', 'reserve', 'release', 'consume', 'expire', 'refund', 'adjust'] as const;
export type CreditLedgerType = (typeof CREDIT_LEDGER_TYPES)[number];

export const REPORT_CATEGORIES = [
  'fake_profile',
  'harassment',
  'inappropriate_content',
  'scam_money_request',
  'underage',
  'married_misrepresentation',
  'safety_threat',
  'other',
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const NOTIFICATION_CHANNELS = ['in_app', 'email', 'whatsapp', 'push'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const GENDERS = ['woman', 'man', 'non_binary'] as const;
export type Gender = (typeof GENDERS)[number];

export const DECLINE_REASONS = [
  'different_life_plans',
  'location_doesnt_work',
  'not_feeling_connection',
  'timing_not_right',
  'prefer_not_to_say',
] as const;
export type DeclineReason = (typeof DECLINE_REASONS)[number];
