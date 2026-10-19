import { z } from 'zod';
import { GENDERS, NOTIFICATION_CHANNELS } from '../enums';
import { MIN_AGE } from '../constants';
import { emailSchema, passwordSchema, phoneSchema } from './common';

export function ageOn(dob: Date, today: Date = new Date()): number {
  let age = today.getUTCFullYear() - dob.getUTCFullYear();
  const m = today.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && today.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}

/**
 * Sign up with email + password, or with a phone number only (verified by OTP).
 * At least one of the two paths must be complete.
 */
export const registerSchema = z
  .object({
    email: emailSchema.optional(),
    phone: phoneSchema.optional(),
    password: passwordSchema.optional(),
    firstName: z.string().trim().min(1).max(60),
    gender: z.enum(GENDERS),
    dob: z.coerce.date(),
    acceptTerms: z.literal(true),
    referralCode: z.string().trim().max(32).optional(),
    clientType: z.enum(['web', 'mobile']).default('web'),
  })
  .superRefine((v, ctx) => {
    if (!v.phone && !(v.email && v.password)) {
      ctx.addIssue({ code: 'custom', path: ['email'], message: 'Enter an email and password, or a mobile number' });
    }
    if (v.email && !v.password) {
      ctx.addIssue({ code: 'custom', path: ['password'], message: 'Choose a password' });
    }
    if (ageOn(v.dob) < MIN_AGE[v.gender]) {
      ctx.addIssue({
        code: 'custom',
        path: ['dob'],
        message: `You must be at least ${MIN_AGE[v.gender]} years old to join`,
      });
    }
  });
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
  totp: z.string().regex(/^\d{6}$/).optional(),
  /** One of the staff member's one-time recovery codes, used instead of an authenticator code. */
  recoveryCode: z.string().trim().regex(/^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/).optional(),
  clientType: z.enum(['web', 'mobile']).default('web'),
});
export type LoginInput = z.infer<typeof loginSchema>;

/** The credential is the ID token from the Google button; birth date, gender and terms are only needed for a new account. */
export const googleSignInSchema = z.object({
  credential: z.string().min(20).max(4096),
  gender: z.enum(GENDERS).optional(),
  dob: z.coerce.date().optional(),
  acceptTerms: z.literal(true).optional(),
  referralCode: z.string().trim().max(32).optional(),
  clientType: z.enum(['web', 'mobile']).default('web'),
});
export type GoogleSignInInput = z.infer<typeof googleSignInSchema>;

export const OTP_PURPOSES = ['login', 'verify_phone', 'verify_email', 'change_contact'] as const;
export const otpRequestSchema = z.object({
  target: z.union([emailSchema, phoneSchema]),
  purpose: z.enum(OTP_PURPOSES),
});
export const otpVerifySchema = otpRequestSchema.extend({
  code: z.string().regex(/^\d{6}$/),
  clientType: z.enum(['web', 'mobile']).default('web'),
});

export const verifyEmailSchema = z.object({ token: z.string().min(20).max(200) });
export const resendVerificationSchema = z.object({ email: emailSchema });
export const forgotPasswordSchema = z.object({ email: emailSchema });
export const resetPasswordSchema = z.object({ token: z.string().min(20).max(200), password: passwordSchema });
export const refreshSchema = z.object({ refreshToken: z.string().min(20).max(300).optional() });

export const accountPatchSchema = z
  .object({
    firstName: z.string().trim().min(1).max(60).optional(),
    locale: z.enum(['en-IN', 'hi-IN']).optional(),
    theme: z.enum(['light', 'dark', 'system']).optional(),
    currentPassword: z.string().max(128).optional(),
    newPassword: passwordSchema.optional(),
  })
  .refine((v) => !v.newPassword || !!v.currentPassword, {
    path: ['currentPassword'],
    message: 'Enter your current password to set a new one',
  });

export const changeContactSchema = z.object({
  kind: z.enum(['email', 'phone']),
  value: z.union([emailSchema, phoneSchema]),
});

export const deleteAccountSchema = z.object({
  password: z.string().max(128).optional(),
  confirm: z.literal('DELETE'),
});

export const notificationCategories = [
  'introductions',
  'messages',
  'billing',
  'verification',
  'safety',
  'product_updates',
] as const;
export const notificationPrefsSchema = z.object({
  // Partial: anything left out keeps its default (see resolvePrefs).
  channels: z.partialRecord(
    z.enum(notificationCategories),
    z.partialRecord(z.enum(NOTIFICATION_CHANNELS), z.boolean()),
  ),
  quietHours: z
    .object({ enabled: z.boolean(), start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) })
    .optional(),
});
export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>;

export const CONSENT_PURPOSES = [
  'terms',
  'privacy',
  'analytics',
  'whatsapp',
  'marketing_email',
  'astrology',
  'photos_sharing',
] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];
export const consentSchema = z.object({
  purpose: z.enum(CONSENT_PURPOSES),
  granted: z.boolean(),
});

export const LEGAL_TYPES = [
  'terms',
  'privacy',
  'refund',
  'community_guidelines',
  'cookies',
  'grievance',
] as const;
export type LegalType = (typeof LEGAL_TYPES)[number];

export const totpCodeSchema = z.object({ code: z.string().regex(/^\d{6}$/) });
