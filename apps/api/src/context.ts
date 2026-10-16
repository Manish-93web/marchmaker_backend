import type { Logger } from 'pino';
import type { Env } from './config/env';
import { fieldCryptoFromEnv } from './lib/keys';
import type { FieldCrypto } from './lib/crypto';
import type { Mailer } from './lib/mailer';
import type { SmsSender } from './lib/sms';
import { Redis } from 'ioredis';
import { SuppressingMailer } from './lib/mailer';
import { EmailSuppression } from './models/messaging';
import { memoryAttemptLimiter, redisAttemptLimiter, type AttemptLimiter } from './lib/attemptLimiter';
import { createStorage, type ObjectStorage } from './lib/storage';
import { createImageModeration, type ImageModeration } from './lib/moderation';
import { createTranscriber, type TranscriptionProvider } from './lib/transcription';
import { createNarrativeRewriter } from './lib/narrativeRewriter';
import { createKycProvider, CircuitBreaker, type KycProvider } from './lib/kyc';
import { createPush, createWhatsApp, type PushSender, type WhatsAppSender } from './lib/channels';
import { BullJobsAdmin, type JobsAdmin } from './lib/jobsAdmin';
import { createAstrology, type AstrologyProvider } from './lib/astrology';
import { createCallProvider, type CallProvider } from './lib/telephony';
import { createPaymentProvider, type PaymentProvider } from './lib/payments';
import { PermissionStore } from './services/permissions';
import type { NarrativeRewriter } from '@marchmaker/shared';

/** Everything services need from the outside world; swapped for fakes in tests. */
export interface AppContext {
  env: Env;
  log: Logger;
  mailer: Mailer;
  sms: SmsSender;
  crypto: FieldCrypto;
  storage: ObjectStorage;
  moderation: ImageModeration;
  transcriber: TranscriptionProvider | null;
  /** Optional LLM polish for assessment narratives; only used when the llm_narratives flag is on. */
  narrativeRewriter: NarrativeRewriter | null;
  /** Automated ID + liveness provider; null when not configured (manual review only). */
  kyc: KycProvider | null;
  kycBreaker: CircuitBreaker;
  /** Razorpay (or the mock); null when payments are not configured. */
  payments: PaymentProvider | null;
  whatsapp: WhatsAppSender | null;
  push: PushSender | null;
  calls: CallProvider | null;
  /** Queue controls for the admin console; null without Redis. */
  jobs: JobsAdmin | null;
  astrology: AstrologyProvider | null;
  permissions: PermissionStore;
  /** Shared Redis connection (limits across instances); null in tests and single-instance setups. */
  redis: Redis | null;
  loginLimiter: AttemptLimiter;
  otpLimiter: AttemptLimiter;
}

/** Adds the suppression check around whichever mailer was supplied. */
function wrapMailer(base: Pick<AppContext, 'env' | 'log' | 'mailer'>) {
  const crypto = fieldCryptoFromEnv(base.env);
  return new SuppressingMailer(
    base.mailer,
    async (email) => (await EmailSuppression.findOne({ toHash: crypto.blindIndex(email) }).select('kind').lean())?.kind ?? null,
    base.log,
  );
}

export function buildContext(
  base: Pick<AppContext, 'env' | 'log' | 'mailer' | 'sms'>,
  overrides: Partial<AppContext> = {},
): AppContext {
  const redis =
    base.env.REDIS_URL && base.env.NODE_ENV !== 'test'
      ? new Redis(base.env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 1, enableOfflineQueue: false })
      : null;
  redis?.on('error', (err) => base.log.warn({ err: err.message }, 'redis error'));
  const warn = (err: unknown) => base.log.warn({ err }, 'rate limiter falling back to memory');
  const limiter = (name: string, limit: number, windowMs: number) =>
    redis ? redisAttemptLimiter(redis, `rl:${name}`, limit, windowMs, warn) : memoryAttemptLimiter(limit, windowMs);
  return {
    ...base,
    mailer: wrapMailer(base),
    crypto: fieldCryptoFromEnv(base.env),
    storage: createStorage(base.env),
    moderation: createImageModeration(base.env, base.log),
    transcriber: createTranscriber(base.env),
    narrativeRewriter: createNarrativeRewriter(base.env),
    kyc: createKycProvider(base.env),
    payments: createPaymentProvider(base.env),
    whatsapp: createWhatsApp(base.env, base.log),
    push: createPush(base.env),
    calls: createCallProvider(base.env, base.log),
    jobs: base.env.REDIS_URL && base.env.NODE_ENV !== 'test' ? new BullJobsAdmin(base.env.REDIS_URL) : null,
    astrology: createAstrology(base.env),
    kycBreaker: new CircuitBreaker({ failureThreshold: 5, resetAfterMs: 30_000 }),
    permissions: new PermissionStore(),
    redis,
    loginLimiter: limiter('login', 10, 15 * 60_000),
    otpLimiter: limiter('otp', 5, 10 * 60_000),
    ...overrides,
  };
}
