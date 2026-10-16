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

  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173,http://localhost:5174')
    .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean)),

  APP_URL: z.string().url().default('http://localhost:5173'),
  ADMIN_URL: z.string().url().default('http://localhost:5174'),

  REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  EMAIL_PROVIDER: z.enum(['mock', 'smtp']).default('mock'),
  SUPPORT_EMAIL: z.string().email().default('support@marchmaker.local'),
  EMAIL_FROM: z.string().default('Marchmaker <hello@marchmaker.local>'),
  SMTP_HOST: z.string().default('127.0.0.1'),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMS_PROVIDER: z.enum(['mock', 'msg91']).default('mock'),
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_OTP_TEMPLATE_ID: z.string().optional(),
  EXPORT_DIR: z.string().default('./.data/exports'),
  TOTP_ISSUER: z.string().default('Marchmaker'),

  STORAGE_PROVIDER: z.enum(['memory', 's3']).default('memory'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  S3_BUCKET_PHOTOS: z.string().default('marchmaker-photos'),
  S3_BUCKET_IDENTITY: z.string().default('marchmaker-identity'),
  S3_BUCKET_DOCUMENTS: z.string().default('marchmaker-documents'),
  S3_IDENTITY_ACCESS_KEY_ID: z.string().optional(),
  S3_IDENTITY_SECRET_ACCESS_KEY: z.string().optional(),
  KYC_PROVIDER: z.enum(['none', 'mock', 'rest']).default('none'),
  KYC_BASE_URL: z.string().optional(),
  KYC_API_KEY: z.string().optional(),
  KYC_WEBHOOK_SECRET: z.string().default('dev-only-kyc-webhook-secret'),
  EVIDENCE_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  TRANSCRIPTION_PROVIDER: z.enum(['none', 'openai']).default('none'),
  OPENAI_API_KEY: z.string().optional(),

  WHATSAPP_PROVIDER: z.enum(['none', 'mock', 'meta']).default('mock'),
  WHATSAPP_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_ID: z.string().optional(),
  PUSH_PROVIDER: z.enum(['none', 'mock', 'webpush']).default('mock'),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:support@marchmaker.local'),
  ONCALL_EMAIL: z.string().email().optional(),
  CALLS_PROVIDER: z.enum(['none', 'mock', 'exotel']).default('mock'),
  CALLS_WEBHOOK_SECRET: z.string().min(8).default('dev-only-calls-webhook-secret'),
  CALLS_CALLER_ID: z.string().optional(),
  EXOTEL_SID: z.string().optional(),
  EXOTEL_KEY: z.string().optional(),
  EXOTEL_TOKEN: z.string().optional(),
  ASTROLOGY_PROVIDER: z.enum(['none', 'mock', 'rest']).default('mock'),
  ASTROLOGY_BASE_URL: z.string().url().optional(),
  ASTROLOGY_API_KEY: z.string().optional(),
  PAYMENTS_PROVIDER: z.enum(['none', 'mock', 'razorpay']).default('mock'),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(8).default('dev-only-razorpay-webhook-secret'),
  GST_RATE_PERCENT: z.coerce.number().min(0).max(28).default(18),
  GST_SELLER_NAME: z.string().default('Marchmaker Matrimonial Services Pvt Ltd'),
  GST_SELLER_GSTIN: z.string().default('29AAAAA0000A1Z5'),
  GST_SELLER_STATE_CODE: z.string().regex(/^\d{2}$/).default('29'),
  GST_SELLER_ADDRESS: z.string().default('Bengaluru, Karnataka, India'),
  GST_SAC_CODE: z.string().default('999799'),

  FIELD_ENCRYPTION_KEY: z
    .string()
    .regex(/^[A-Za-z0-9+/=]{43,}$/, 'Expected a base64-encoded 32 byte key')
    .default('ZGV2LW9ubHktZmllbGQtZW5jcnlwdGlvbi1rZXktMzI='),
});

export type Env = z.infer<typeof envSchema>;

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
    if (env.WHATSAPP_PROVIDER === 'mock' || env.PUSH_PROVIDER === 'mock') {
      throw new Error('Mock WhatsApp or push providers are not allowed in production');
    }
    if (env.PAYMENTS_PROVIDER === 'mock') throw new Error('PAYMENTS_PROVIDER=mock is not allowed in production');
    if (!env.COOKIE_SECURE) throw new Error('COOKIE_SECURE must be true in production');

    // Launch guards: anything that would silently do nothing, or run on a development default, is refused.
    const problems: string[] = [];
    if (env.FIELD_ENCRYPTION_KEY === 'ZGV2LW9ubHktZmllbGQtZW5jcnlwdGlvbi1rZXktMzI=') problems.push('FIELD_ENCRYPTION_KEY is the development key');
    if (env.EMAIL_PROVIDER === 'mock') problems.push('EMAIL_PROVIDER=mock would never send email');
    if (env.SMS_PROVIDER === 'mock') problems.push('SMS_PROVIDER=mock would never send OTP codes');
    if (env.SMS_PROVIDER === 'msg91' && !(env.MSG91_AUTH_KEY && env.MSG91_OTP_TEMPLATE_ID)) problems.push('MSG91_AUTH_KEY and MSG91_OTP_TEMPLATE_ID are required');
    if (env.STORAGE_PROVIDER === 'memory') problems.push('STORAGE_PROVIDER=memory would lose every upload');
    if (env.KYC_PROVIDER === 'mock') problems.push('KYC_PROVIDER=mock is not allowed');
    if (env.KYC_PROVIDER !== 'none' && env.KYC_WEBHOOK_SECRET.startsWith('dev-only')) problems.push('KYC_WEBHOOK_SECRET is the development secret');
    if (env.PAYMENTS_PROVIDER === 'none') problems.push('PAYMENTS_PROVIDER=none: members could not pay');
    if (!env.REDIS_URL) problems.push('REDIS_URL is required (shared rate limits and the job queue)');
    if (!env.APP_URL.startsWith('https://') || !env.ADMIN_URL.startsWith('https://')) problems.push('APP_URL and ADMIN_URL must be https');
    if (env.CORS_ORIGINS.some((o) => !o.startsWith('https://'))) problems.push('CORS_ORIGINS must all be https');
    if (problems.length) throw new Error(`Refusing to start in production: ${problems.join('; ')}`);
  }
  return env;
}
