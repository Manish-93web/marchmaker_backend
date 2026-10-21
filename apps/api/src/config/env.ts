import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/marchmaker?replicaSet=rs0'),
  REDIS_URL: z.string().optional(),

  JWT_ACCESS_SECRET: z.string().min(32).default('dev-only-access-secret-change-me-0123456789'),
  JWT_REFRESH_SECRET: z.string().min(32).default('dev-only-refresh-secret-change-me-012345678'),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: bool,
  /** Staff must pass an authenticator code. Setting this to false is for local development only; production refuses it. */
  STAFF_MFA_REQUIRED: z.string().optional().transform((v) => v !== 'false' && v !== '0'),

  /** How many proxies sit in front of the API and add to X-Forwarded-For. 1 when users reach Render directly; 2 when the site's Vercel rewrite forwards to Render. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),

  /**
   * Production only: lets staff sign in without an authenticator code until this date (for example 2026-11-05). It must be
   * no more than 14 days away, and every session started this way ends on that date. After it, codes are required again.
   */
  STAFF_MFA_OFF_UNTIL: z.string().optional(),

  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173,http://localhost:5174')
    .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean)),

  APP_URL: z.string().url().default('http://localhost:5173'),
  ADMIN_URL: z.string().url().default('http://localhost:5174'),

  REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  EMAIL_PROVIDER: z.enum(['mock', 'smtp', 'resend']).default('mock'),
  RESEND_API_KEY: z.string().optional(),
  RESEND_WEBHOOK_SECRET: z.string().optional(),
  SUPPORT_EMAIL: z.string().email().default('support@marchmaker.local'),
  EMAIL_FROM: z.string().default('Marchmaker <hello@marchmaker.local>'),
  SMTP_HOST: z.string().default('127.0.0.1'),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMS_PROVIDER: z.enum(['mock', 'msg91']).default('mock'),
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_OTP_TEMPLATE_ID: z.string().optional(),
  TOTP_ISSUER: z.string().default('Marchmaker'),

  /** OAuth client id for Sign in with Google (Google Cloud console). Unset hides the button. */
  GOOGLE_CLIENT_ID: z.string().trim().min(10).optional(),
  STORAGE_PROVIDER: z.enum(['memory', 'local', 'mongo', 's3']).default('memory'),
  /** This API's own public address (for example https://marchmaker-api.onrender.com). With STORAGE_PROVIDER=mongo, uploads go straight to it instead of through the site's proxy. */
  PUBLIC_API_URL: z.string().url().optional(),
  /** Where the local development storage keeps files. The API and the worker both run from their own folder under apps/, so this default lands in one shared place at the repo root. */
  LOCAL_STORAGE_DIR: z.string().default('../../.data/storage'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  S3_BUCKET_PHOTOS: z.string().default('marchmaker-photos'),
  S3_BUCKET_IDENTITY: z.string().default('marchmaker-identity'),
  S3_BUCKET_DOCUMENTS: z.string().default('marchmaker-documents'),
  S3_IDENTITY_ACCESS_KEY_ID: z.string().optional(),
  S3_IDENTITY_SECRET_ACCESS_KEY: z.string().optional(),
  KYC_PROVIDER: z.enum(['none', 'mock', 'rest', 'hyperverge', 'idfy', 'digio']).default('none'),
  /** Second credential for vendors that need one (HyperVerge appKey, IDfy account id, Digio client secret). */
  KYC_API_SECRET: z.string().optional(),
  /** JSON merged over a vendor preset's request and result mapping, to correct it without a release. */
  KYC_MAPPING_JSON: z.string().optional(),
  KYC_BASE_URL: z.string().optional(),
  KYC_API_KEY: z.string().optional(),
  KYC_WEBHOOK_SECRET: z.string().default('dev-only-kyc-webhook-secret'),
  EVIDENCE_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  TRANSCRIPTION_PROVIDER: z.enum(['none', 'openai']).default('none'),
  OPENAI_API_KEY: z.string().optional(),

  WHATSAPP_PROVIDER: z.enum(['none', 'mock', 'meta']).default('mock'),
  WHATSAPP_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_ID: z.string().optional(),
  /** Echoed back to Meta when it verifies the webhook URL. */
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  /** Meta app secret: signs every webhook call (X-Hub-Signature-256). */
  WHATSAPP_APP_SECRET: z.string().optional(),
  /** Where phone one-time codes go: SMS, WhatsApp, or SMS with WhatsApp as the fallback. */
  OTP_CHANNEL: z.enum(['sms', 'whatsapp', 'sms_then_whatsapp']).default('sms'),
  PUSH_PROVIDER: z.enum(['none', 'mock', 'webpush']).default('mock'),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:support@marchmaker.local'),
  ONCALL_EMAIL: z.string().email().optional(),
  /** Comma-separated E.164 numbers that get a WhatsApp page for critical and overdue safety reports. */
  ONCALL_WHATSAPP: z.string().optional(),
  CALLS_PROVIDER: z.enum(['none', 'mock', 'exotel']).default('mock'),
  /** In-app (WebRTC) voice calls: STUN and TURN servers. TURN credentials are short-lived and derived from the shared secret. */
  RTC_STUN_URLS: z.string().default('stun:stun.l.google.com:19302'),
  RTC_TURN_URLS: z.string().optional(),
  RTC_TURN_SECRET: z.string().optional(),
  RTC_TURN_TTL_SEC: z.coerce.number().int().min(60).max(86_400).default(3600),
  CALLS_WEBHOOK_SECRET: z.string().min(8).default('dev-only-calls-webhook-secret'),
  CALLS_CALLER_ID: z.string().optional(),
  EXOTEL_SID: z.string().optional(),
  EXOTEL_KEY: z.string().optional(),
  EXOTEL_TOKEN: z.string().optional(),
  ASTROLOGY_PROVIDER: z.enum(['none', 'mock', 'rest']).default('mock'),
  ASTROLOGY_BASE_URL: z.string().url().optional(),
  ASTROLOGY_API_KEY: z.string().optional(),
  PAYMENTS_PROVIDER: z.enum(['none', 'mock', 'razorpay', 'stripe']).default('mock'),
  /** Stripe (an alternative to Razorpay). The secret key stays on the server; members pay on Stripe's hosted Checkout page. */
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  /** The signing secret (whsec_...) of the webhook endpoint you add in the Stripe dashboard. */
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(8).default('dev-only-razorpay-webhook-secret'),
  GST_RATE_PERCENT: z.coerce.number().min(0).max(28).default(18),
  GST_SELLER_NAME: z.string().default('Marchmaker Matrimonial Services Pvt Ltd'),
  GST_SELLER_GSTIN: z.string().default('29AAAAA0000A1Z5'),
  GST_SELLER_STATE_CODE: z.string().regex(/^\d{2}$/).default('29'),
  GST_SELLER_ADDRESS: z.string().default('Bengaluru, Karnataka, India'),
  GST_SAC_CODE: z.string().default('999799'),

  /** Version number of FIELD_ENCRYPTION_KEY. Increase it (and move the old key to _PREVIOUS) when rotating. */
  FIELD_ENCRYPTION_KEY_VERSION: z.coerce.number().int().min(1).default(1),
  /** JSON object of earlier keys by version, for example {"1":"<base64>"}. */
  FIELD_ENCRYPTION_KEYS_PREVIOUS: z.string().optional(),
  /** Stable key for lookup hashes (phone). Set once and never change it. */
  FIELD_BLIND_INDEX_KEY: z.string().optional(),
  /** Alternative to FIELD_ENCRYPTION_KEY: the key encrypted by AWS KMS (base64), unwrapped at start-up. */
  FIELD_ENCRYPTION_KEY_KMS_WRAPPED: z.string().optional(),
  AWS_REGION: z.string().optional(),
  /** Automated photo checks (face present, explicit content). A human still approves every photo. */
  IMAGE_MODERATION: z.enum(['none', 'mock', 'rekognition']).default('none'),
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().default('development'),
  SENTRY_RELEASE: z.string().optional(),
  FIELD_ENCRYPTION_KEY: z
    .string()
    .regex(/^[A-Za-z0-9+/=]{43,}$/, 'Expected a base64-encoded 32 byte key')
    .default('ZGV2LW9ubHktZmllbGQtZW5jcnlwdGlvbi1rZXktMzI='),
});

export type Env = z.infer<typeof envSchema>;

const DAY_MS = 86_400_000;
export const MAX_STAFF_MFA_OFF_DAYS = 14;

/**
 * Whether staff may sign in without an authenticator code right now. On a development machine, whenever
 * STAFF_MFA_REQUIRED=false. In production, only until STAFF_MFA_OFF_UNTIL, so it cannot be left on by accident.
 */
export function staffMfaBypass(
  env: Pick<Env, 'STAFF_MFA_REQUIRED' | 'NODE_ENV' | 'STAFF_MFA_OFF_UNTIL'>,
  now: Date = new Date(),
): { active: boolean; until?: Date } {
  if (env.STAFF_MFA_REQUIRED) return { active: false };
  if (env.NODE_ENV !== 'production') return { active: true };
  const until = env.STAFF_MFA_OFF_UNTIL ? new Date(env.STAFF_MFA_OFF_UNTIL) : undefined;
  if (!until || Number.isNaN(until.getTime()) || until <= now) return { active: false };
  return { active: true, until };
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production') {
    const insecure = [env.JWT_ACCESS_SECRET, env.JWT_REFRESH_SECRET].some((s) => s.startsWith('dev-only'));
    if (insecure) throw new Error('Refusing to start in production with development secrets');
    if (env.PAYMENTS_PROVIDER === 'razorpay' && env.RAZORPAY_WEBHOOK_SECRET.startsWith('dev-only')) {
      throw new Error('Set RAZORPAY_WEBHOOK_SECRET before taking real payments');
    }
    if (env.CALLS_PROVIDER === 'mock' || env.ASTROLOGY_PROVIDER === 'mock') {
      throw new Error('Mock calling or astrology providers are not allowed in production');
    }
    if (env.CALLS_PROVIDER === 'exotel' && env.CALLS_WEBHOOK_SECRET.startsWith('dev-only')) {
      throw new Error('Set CALLS_WEBHOOK_SECRET before enabling voice calls');
    }
    if (env.IMAGE_MODERATION === 'mock') {
      throw new Error('Mock image moderation is not allowed in production');
    }
    if (env.WHATSAPP_PROVIDER === 'mock' || env.PUSH_PROVIDER === 'mock') {
      throw new Error('Mock WhatsApp or push providers are not allowed in production');
    }
    if (env.PAYMENTS_PROVIDER === 'mock') throw new Error('PAYMENTS_PROVIDER=mock is not allowed in production');
    if (!env.STAFF_MFA_REQUIRED) {
      // Allowed only as a temporary, self-expiring exception: an end date no more than 14 days away (see staffMfaBypass).
      const until = env.STAFF_MFA_OFF_UNTIL ? new Date(env.STAFF_MFA_OFF_UNTIL) : undefined;
      const inWindow = !!until && !Number.isNaN(until.getTime()) && until.getTime() > Date.now() && until.getTime() <= Date.now() + MAX_STAFF_MFA_OFF_DAYS * DAY_MS;
      if (!inWindow) {
        throw new Error(`STAFF_MFA_REQUIRED=false is not allowed in production, except temporarily: set STAFF_MFA_OFF_UNTIL to a date within the next ${MAX_STAFF_MFA_OFF_DAYS} days (for example 2026-11-05)`);
      }
    }
    if (!env.COOKIE_SECURE) throw new Error('COOKIE_SECURE must be true in production');

    // Launch guards: anything that would silently do nothing, or run on a development default, is refused.
    const problems: string[] = [];
    if (env.FIELD_ENCRYPTION_KEY === 'ZGV2LW9ubHktZmllbGQtZW5jcnlwdGlvbi1rZXktMzI=') problems.push('FIELD_ENCRYPTION_KEY is the development key');
    if (env.EMAIL_PROVIDER === 'mock') problems.push('EMAIL_PROVIDER=mock would never send email');
    if (env.EMAIL_PROVIDER === 'resend' && !(env.RESEND_API_KEY && env.RESEND_WEBHOOK_SECRET)) problems.push('RESEND_API_KEY and RESEND_WEBHOOK_SECRET are required for Resend');
    if (env.WHATSAPP_PROVIDER === 'meta' && !(env.WHATSAPP_VERIFY_TOKEN && env.WHATSAPP_APP_SECRET)) problems.push('WHATSAPP_VERIFY_TOKEN and WHATSAPP_APP_SECRET are required for WhatsApp webhooks');
    if (env.SMS_PROVIDER === 'mock') problems.push('SMS_PROVIDER=mock would never send OTP codes');
    if (env.SMS_PROVIDER === 'msg91' && !(env.MSG91_AUTH_KEY && env.MSG91_OTP_TEMPLATE_ID)) problems.push('MSG91_AUTH_KEY and MSG91_OTP_TEMPLATE_ID are required');
    if (env.STORAGE_PROVIDER !== 's3' && env.STORAGE_PROVIDER !== 'mongo') problems.push('STORAGE_PROVIDER must be s3 (or mongo for a small deployment): memory would lose every upload, and local is for development only');
    if (env.KYC_PROVIDER === 'mock') problems.push('KYC_PROVIDER=mock is not allowed');
    if (env.KYC_PROVIDER !== 'none' && env.KYC_WEBHOOK_SECRET.startsWith('dev-only')) problems.push('KYC_WEBHOOK_SECRET is the development secret');
    if (env.PAYMENTS_PROVIDER === 'none') problems.push('PAYMENTS_PROVIDER=none: members could not pay');
    if (env.PAYMENTS_PROVIDER === 'stripe' && !(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET)) problems.push('STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are required for Stripe');
    // REDIS_URL is optional: without it rate limits are kept per API instance and the worker runs events in its own process (see server.ts).
    if (!env.APP_URL.startsWith('https://') || !env.ADMIN_URL.startsWith('https://')) problems.push('APP_URL and ADMIN_URL must be https');
    if (env.CORS_ORIGINS.some((o) => !o.startsWith('https://'))) problems.push('CORS_ORIGINS must all be https');
    if (env.FIELD_ENCRYPTION_KEY_VERSION > 1 && !env.FIELD_ENCRYPTION_KEYS_PREVIOUS) problems.push('FIELD_ENCRYPTION_KEYS_PREVIOUS must list the earlier keys when the key version is above 1');
    if (!env.SENTRY_DSN) problems.push('SENTRY_DSN is required so production errors are visible');
    if (problems.length) throw new Error(`Refusing to start in production: ${problems.join('; ')}`);
  }
  return env;
}
