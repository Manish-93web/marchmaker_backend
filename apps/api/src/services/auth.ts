import type { Types } from 'mongoose';
import { generateSecret, generateURI } from 'otplib';
import {
  DEFAULTS,
  isStaff,
  journeyMachine,
  trackerFor,
  type JourneyState,
  type RegisterInput,
  type Role,
} from '@marchmaker/shared';
import type { AppContext } from '../context';
import { audit, emit, logTransition } from '../lib/audit';
import { AppError, badRequest, forbidden, unauthorized } from '../lib/errors';
import { dummyHash, hashPassword, verifyPassword } from '../lib/passwords';
import { hmac, randomOtp, randomToken, safeEqual, sha256 } from '../lib/secrets';
import { AuthToken, OtpCode } from '../models/auth';
import { User } from '../models/core';
import * as referrals from './referrals';
import { latestLegal, pendingLegal, recordConsent, currentConsents } from './legal';
import { sendNotice, sendOtp } from './notify';
import { consumeRecoveryCode, storeRecoveryCodes, verifyTotpOnce } from './twoFactor';
import { issueSession, revokeAllSessions, type IssuedTokens } from './sessions';

export interface ClientInfo {
  ip?: string;
  userAgent?: string;
}

const BAD_LOGIN = 'Email or password is incorrect';
const BAD_CODE = 'That code is incorrect or has expired';
const LINK_BAD = 'This link is invalid or has expired';
const HOUR = 3_600_000;

const normPhone = (ctx: AppContext, phone: string) => ctx.crypto.blindIndex(phone);

function newReferralCode(): string {
  return randomToken(6).replace(/[-_]/g, 'x').slice(0, 8).toUpperCase();
}

async function createLinkToken(
  userId: Types.ObjectId | string,
  purpose: 'verify_email' | 'password_reset' | 'change_email',
  ttlMs: number,
  payload?: Record<string, unknown>,
): Promise<string> {
  const token = randomToken(32);
  await AuthToken.create({
    userId,
    purpose,
    tokenHash: sha256(token),
    payload,
    expiresAt: new Date(Date.now() + ttlMs),
  });
  return token;
}

async function consumeLinkToken(token: string, purpose: 'verify_email' | 'password_reset' | 'change_email') {
  const doc = await AuthToken.findOneAndUpdate(
    { tokenHash: sha256(token), purpose, usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
  );
  if (!doc) throw badRequest(LINK_BAD);
  return doc;
}

async function transition(userId: string, from: JourneyState, to: JourneyState, actorId?: Types.ObjectId | string) {
  if (from === to || !journeyMachine.canTransition(from, to)) return false;
  await User.updateOne({ _id: userId, journeyState: from }, { $set: { journeyState: to } });
  await logTransition('user_journey', userId, from, to, actorId);
  return true;
}

/** Contact (email or phone) proven: moves the journey from `registered` to `email_verified`. */
async function onContactVerified(user: { _id: Types.ObjectId | string; journeyState: string }) {
  await transition(String(user._id), user.journeyState as JourneyState, 'email_verified');
}

// ---------------------------------------------------------------- register

export async function register(ctx: AppContext, input: RegisterInput, client: ClientInfo): Promise<void> {
  const phoneHash = input.phone ? normPhone(ctx, input.phone) : undefined;
  const existing = await User.findOne({
    $or: [...(input.email ? [{ email: input.email }] : []), ...(phoneHash ? [{ phoneHash }] : [])],
  }).select('_id email');

  if (existing) {
    // Same response as success: never reveal whether an account exists.
    if (existing.email) {
      await sendNotice(ctx, existing.email, {
        subject: 'You already have a Marchmaker account',
        preview: 'Sign in or reset your password',
        heading: 'You already have an account',
        paragraphs: [
          'Someone (hopefully you) tried to create an account with this email.',
          'You can sign in, or reset your password if you have forgotten it.',
        ],
        cta: { label: 'Go to sign in', url: `${ctx.env.APP_URL}/login` },
      });
    }
    return;
  }

  let referredBy: Types.ObjectId | undefined;
  if (input.referralCode) {
    const ref = await User.findOne({ referralCode: input.referralCode.toUpperCase() }).select('_id');
    referredBy = ref?._id;
  }

  let user;
  try {
    user = await User.create({
      email: input.email,
      passwordHash: input.password ? await hashPassword(input.password) : undefined,
      firstName: input.firstName,
      gender: input.gender,
      dobEnc: ctx.crypto.encrypt(input.dob.toISOString().slice(0, 10)),
      dobYear: input.dob.getUTCFullYear(),
      phoneEnc: input.phone ? ctx.crypto.encrypt(input.phone) : undefined,
      phoneHash,
      referralCode: newReferralCode(),
      referredBy,
      signupIpHash: client.ip ? ctx.crypto.blindIndex(client.ip) : undefined,
      roles: ['member'],
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return; // lost a race with a concurrent sign-up
    throw err;
  }

  const legal = await latestLegal(['terms', 'privacy']);
  for (const purpose of ['terms', 'privacy'] as const) {
    await recordConsent(user._id, purpose, true, {
      ...client,
      documentVersion: legal.find((d) => d.type === purpose)?.version,
    });
  }
  if (referredBy && input.referralCode) {
    await referrals
      .attribute(ctx, { id: user._id, phoneHash, ipHash: client.ip ? ctx.crypto.blindIndex(client.ip) : undefined }, referredBy, input.referralCode.toUpperCase())
      .catch((err) => ctx.log.warn({ err }, 'referral attribution failed'));
  }
  await logTransition('user_journey', String(user._id), undefined, 'registered');
  await emit('user.registered', { userId: String(user._id) });

  if (input.email) {
    const token = await createLinkToken(user._id, 'verify_email', 24 * HOUR);
    await sendNotice(ctx, input.email, {
      subject: 'Confirm your email',
      preview: 'Confirm your email to continue',
      heading: `Welcome, ${input.firstName}`,
      paragraphs: ['Please confirm your email address to continue building your profile. This link works for 24 hours.'],
      cta: { label: 'Confirm my email', url: `${ctx.env.APP_URL}/verify-email?token=${token}` },
      footnote: 'If you did not create an account, you can safely ignore this message.',
    });
  } else if (input.phone) {
    await issueOtp(ctx, input.phone, 'login');
  }
}

// ---------------------------------------------------------------- email verification

export async function verifyEmail(ctx: AppContext, token: string): Promise<void> {
  const doc = await AuthToken.findOne({ tokenHash: sha256(token), usedAt: null, expiresAt: { $gt: new Date() } });
  if (!doc || !['verify_email', 'change_email'].includes(doc.purpose)) throw badRequest(LINK_BAD);
  const used = await consumeLinkToken(token, doc.purpose as 'verify_email' | 'change_email');
  const user = await User.findById(used.userId);
  if (!user) throw badRequest(LINK_BAD);

  if (used.purpose === 'change_email') {
    const email = String((used.payload as { email?: string } | undefined)?.email ?? '');
    const taken = await User.exists({ email, _id: { $ne: user._id } });
    if (!email || taken) throw badRequest(LINK_BAD);
    user.email = email;
  }
  user.emailVerifiedAt = new Date();
  await user.save();
  await onContactVerified(user);
  await emit('user.email_verified', { userId: String(user._id) });
}

export async function resendVerification(ctx: AppContext, email: string): Promise<void> {
  if (!(await ctx.otpLimiter.hit(`resend:${sha256(email)}`))) return;
  const user = await User.findOne({ email, emailVerifiedAt: null }).select('_id firstName');
  if (!user) return;
  const token = await createLinkToken(user._id, 'verify_email', 24 * HOUR);
  await sendNotice(ctx, email, {
    subject: 'Confirm your email',
    preview: 'Confirm your email to continue',
    heading: `Welcome, ${user.firstName}`,
    paragraphs: ['Here is a fresh link to confirm your email. It works for 24 hours.'],
    cta: { label: 'Confirm my email', url: `${ctx.env.APP_URL}/verify-email?token=${token}` },
  });
}

// ---------------------------------------------------------------- login

export interface LoginResult {
  tokens: IssuedTokens;
  userId: string;
  roles: Role[];
  mfa: boolean;
  requiresTotpSetup: boolean;
}

function lockFor(failures: number): Date | undefined {
  if (failures < 5) return undefined;
  const minutes = Math.min(2 ** (failures - 5), 60);
  return new Date(Date.now() + minutes * 60_000);
}

export async function login(
  ctx: AppContext,
  input: { email: string; password: string; totp?: string; recoveryCode?: string },
  client: ClientInfo,
): Promise<LoginResult> {
  if (!(await ctx.loginLimiter.hit(`login:${sha256(input.email)}`))) {
    throw new AppError(429, 'RATE_LIMITED', 'Too many attempts. Please try again in a few minutes.');
  }

  const user = await User.findOne({ email: input.email }).select('+passwordHash +twoFactor.secretEnc');
  const hash = user?.passwordHash ?? (await dummyHash());
  const ok = await verifyPassword(hash, input.password);
  const locked = !!user?.lockedUntil && user.lockedUntil > new Date();

  if (!user || !user.passwordHash || !ok || locked) {
    if (user && !locked) {
      const failures = (user.failedLoginCount ?? 0) + 1;
      await User.updateOne({ _id: user._id }, { $set: { failedLoginCount: failures, lockedUntil: lockFor(failures) } });
    }
    throw unauthorized(BAD_LOGIN);
  }

  if (['banned', 'deleted'].includes(user.status)) {
    throw forbidden('This account is not available. Please contact support.');
  }

  const staff = isStaff(user.roles as Role[]);
  let mfa = false;
  if (staff && user.twoFactor?.enabled) {
    if (input.recoveryCode) {
      const left = await consumeRecoveryCode(ctx, String(user._id), input.recoveryCode);
      if (left === null) throw unauthorized('That code is incorrect');
      await audit(undefined, { action: 'auth.recovery_code_used', actorId: user._id, subjectType: 'user', subjectId: String(user._id), after: { left } });
      if (user.email) {
        await sendNotice(ctx, user.email, {
          subject: 'A recovery code was used to sign in',
          preview: 'Security notice',
          heading: 'A recovery code was used',
          paragraphs: [
            `A one-time recovery code was used to sign in to your staff account. You have ${left} left.`,
            'If this was not you, tell a super admin straight away so they can reset your sign-in.',
          ],
        });
      }
    } else {
      if (!input.totp) throw new AppError(401, 'TOTP_REQUIRED', 'Enter the 6-digit code from your authenticator app');
      if (!(await verifyTotpOnce(ctx, String(user._id), user.twoFactor.secretEnc ?? '', input.totp))) throw unauthorized('That code is incorrect');
    }
    mfa = true;
  }

  await User.updateOne(
    { _id: user._id },
    { $set: { failedLoginCount: 0, lastActiveAt: new Date() }, $unset: { lockedUntil: 1 } },
  );
  await ctx.loginLimiter.reset(`login:${sha256(input.email)}`);

  const tokens = await issueSession(ctx, user, client, { mfa });
  await audit(undefined, { action: 'auth.login', actorId: user._id, actorRoles: user.roles, subjectType: 'user', subjectId: String(user._id) });
  return {
    tokens,
    userId: String(user._id),
    roles: user.roles as Role[],
    mfa,
    requiresTotpSetup: staff && !user.twoFactor?.enabled,
  };
}

// ---------------------------------------------------------------- OTP

type OtpPurpose = 'login' | 'verify_phone' | 'verify_email' | 'change_contact';

async function issueOtp(ctx: AppContext, target: string, purpose: OtpPurpose): Promise<void> {
  const recent = await OtpCode.findOne({
    target,
    purpose,
    createdAt: { $gt: new Date(Date.now() - 60_000) },
  }).select('_id');
  if (recent) return; // resend cooldown: 60 seconds

  const code = randomOtp();
  await OtpCode.create({
    target,
    purpose,
    codeHash: hmac(ctx.env.JWT_REFRESH_SECRET, `${target}:${purpose}:${code}`),
    expiresAt: new Date(Date.now() + DEFAULTS.otpTtlSec * 1000),
  });
  await sendOtp(ctx, target, code);
}

export async function requestOtp(
  ctx: AppContext,
  input: { target: string; purpose: OtpPurpose },
  authUserId?: string,
): Promise<void> {
  if (!(await ctx.otpLimiter.hit(`otp:${sha256(input.target)}`))) return;
  const isEmail = input.target.includes('@');

  if (input.purpose === 'login') {
    const user = await User.findOne(
      isEmail ? { email: input.target } : { phoneHash: normPhone(ctx, input.target) },
    ).select('_id status');
    if (!user || ['banned', 'deleted'].includes(user.status)) return; // silent: no enumeration
  } else {
    if (!authUserId) throw unauthorized();
    if (input.purpose === 'change_contact' && !isEmail) {
      const taken = await User.exists({ phoneHash: normPhone(ctx, input.target), _id: { $ne: authUserId } });
      if (taken) return;
    }
  }
  await issueOtp(ctx, input.target, input.purpose);
}

export async function verifyOtp(
  ctx: AppContext,
  input: { target: string; purpose: OtpPurpose; code: string },
  client: ClientInfo,
  authUserId?: string,
): Promise<LoginResult | { verified: true }> {
  const doc = await OtpCode.findOne({
    target: input.target,
    purpose: input.purpose,
    usedAt: null,
    expiresAt: { $gt: new Date() },
  }).sort({ createdAt: -1 });
  if (!doc || doc.attempts >= DEFAULTS.otpMaxAttempts) throw badRequest(BAD_CODE);

  const expected = hmac(ctx.env.JWT_REFRESH_SECRET, `${input.target}:${input.purpose}:${input.code}`);
  if (!safeEqual(expected, doc.codeHash)) {
    await OtpCode.updateOne({ _id: doc._id }, { $inc: { attempts: 1 } });
    throw badRequest(BAD_CODE);
  }
  const claimed = await OtpCode.findOneAndUpdate({ _id: doc._id, usedAt: null }, { $set: { usedAt: new Date() } });
  if (!claimed) throw badRequest(BAD_CODE);

  const isEmail = input.target.includes('@');
  if (input.purpose === 'login') {
    const user = await User.findOne(
      isEmail ? { email: input.target } : { phoneHash: normPhone(ctx, input.target) },
    );
    if (!user || ['banned', 'deleted'].includes(user.status)) throw badRequest(BAD_CODE);
    if (isStaff(user.roles as Role[])) {
      throw forbidden('Staff accounts must sign in with a password and authenticator code');
    }
    if (isEmail) user.emailVerifiedAt ??= new Date();
    else user.phoneVerifiedAt ??= new Date();
    user.lastActiveAt = new Date();
    await user.save();
    await onContactVerified(user);
    const tokens = await issueSession(ctx, user, client, { mfa: false });
    return { tokens, userId: String(user._id), roles: user.roles as Role[], mfa: false, requiresTotpSetup: false };
  }

  if (!authUserId) throw unauthorized();
  const user = await User.findById(authUserId);
  if (!user) throw unauthorized();
  if (isEmail) {
    user.emailVerifiedAt = new Date();
  } else {
    if (await User.exists({ phoneHash: normPhone(ctx, input.target), _id: { $ne: user._id } })) {
      throw badRequest('That number cannot be used');
    }
    user.phoneEnc = ctx.crypto.encrypt(input.target);
    user.phoneHash = normPhone(ctx, input.target);
    user.phoneVerifiedAt = new Date();
  }
  await user.save();
  await onContactVerified(user);
  return { verified: true };
}

// ---------------------------------------------------------------- password reset

export async function forgotPassword(ctx: AppContext, email: string): Promise<void> {
  if (!(await ctx.otpLimiter.hit(`forgot:${sha256(email)}`))) return;
  const user = await User.findOne({ email }).select('_id firstName status');
  if (!user || ['banned', 'deleted'].includes(user.status)) return;
  const token = await createLinkToken(user._id, 'password_reset', 30 * 60_000);
  await sendNotice(ctx, email, {
    subject: 'Reset your password',
    preview: 'Reset your Marchmaker password',
    heading: 'Reset your password',
    paragraphs: ['Use the button below to choose a new password. The link works once and expires in 30 minutes.'],
    cta: { label: 'Choose a new password', url: `${ctx.env.APP_URL}/reset-password?token=${token}` },
    footnote: 'If you did not ask for this, you can ignore this email. Your password will not change.',
  });
}

export async function resetPassword(ctx: AppContext, token: string, password: string): Promise<void> {
  const doc = await consumeLinkToken(token, 'password_reset');
  const user = await User.findById(doc.userId).select('+passwordHash');
  if (!user) throw badRequest(LINK_BAD);
  user.passwordHash = await hashPassword(password);
  user.failedLoginCount = 0;
  user.lockedUntil = undefined;
  await user.save();
  await revokeAllSessions(String(user._id), 'password_reset');
  await audit(undefined, { action: 'auth.password_reset', actorId: user._id, subjectType: 'user', subjectId: String(user._id) });
  if (user.email) {
    await sendNotice(ctx, user.email, {
      subject: 'Your password was changed',
      preview: 'Your password was changed',
      heading: 'Your password was changed',
      paragraphs: ['You were signed out of all devices. If this was not you, contact support right away.'],
    });
  }
}

// ---------------------------------------------------------------- two-factor (staff)

export async function setupTotp(ctx: AppContext, userId: string) {
  const user = await User.findById(userId).select('email twoFactor roles');
  if (!user) throw unauthorized();
  if (!isStaff(user.roles as Role[])) throw forbidden();
  if (user.twoFactor?.enabled) throw new AppError(409, 'CONFLICT', 'Two-factor authentication is already enabled');
  const secret = generateSecret();
  await User.updateOne({ _id: userId }, { $set: { 'twoFactor.secretEnc': ctx.crypto.encrypt(secret), 'twoFactor.enabled': false } });
  const label = user.email ?? String(user._id);
  return { secret, otpauthUrl: generateURI({ issuer: ctx.env.TOTP_ISSUER, label, secret }) };
}

export async function confirmTotp(ctx: AppContext, userId: string, code: string, client: ClientInfo) {
  const user = await User.findById(userId).select('+twoFactor.secretEnc roles');
  if (!user?.twoFactor?.secretEnc) throw badRequest('Start two-factor setup first');
  if (!(await verifyTotpOnce(ctx, userId, user.twoFactor.secretEnc, code))) throw badRequest('That code is incorrect');
  user.twoFactor.enabled = true;
  await user.save();
  await revokeAllSessions(userId, 'mfa_enabled');
  const tokens = await issueSession(ctx, user, client, { mfa: true });
  const recoveryCodes = await storeRecoveryCodes(ctx, userId);
  await audit(undefined, { action: 'auth.2fa_enabled', actorId: user._id, subjectType: 'user', subjectId: userId });
  return { tokens, recoveryCodes };
}

// ---------------------------------------------------------------- me

export async function buildMe(ctx: AppContext, userId: string, sessionId: string, mfa: boolean) {
  const user = await User.findById(userId);
  if (!user) throw unauthorized();
  const [pending, consents] = await Promise.all([pendingLegal(userId), currentConsents(userId)]);
  const phone = user.phoneEnc ? ctx.crypto.decrypt(user.phoneEnc) : undefined;
  return {
    id: String(user._id),
    email: user.email ?? null,
    emailVerified: !!user.emailVerifiedAt,
    phoneMasked: phone ? `${phone.slice(0, 3)}******${phone.slice(-2)}` : null,
    phoneVerified: !!user.phoneVerifiedAt,
    firstName: user.firstName,
    gender: user.gender,
    roles: user.roles,
    permissions: isStaff(user.roles as Role[]) ? await ctx.permissions.forRoles(user.roles as Role[]) : [],
    status: user.status,
    journeyState: user.journeyState,
    tracker: trackerFor(user.journeyState as JourneyState),
    plan: user.plan,
    creditBalance: user.creditBalance,
    walletBalancePaise: user.walletBalancePaise,
    referralCode: user.referralCode,
    locale: user.locale,
    hasPassword: !!(await User.exists({ _id: userId, passwordHash: { $exists: true, $ne: null } })),
    twoFactorEnabled: !!user.twoFactor?.enabled,
    mfa,
    sessionId,
    pendingLegal: pending,
    consents,
    deletionScheduledFor: user.deletionScheduledFor ?? null,
  };
}

export { createLinkToken };
