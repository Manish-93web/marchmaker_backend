import * as twoFactor from '../services/twoFactor';
import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import {
  forgotPasswordSchema,
  googleSignInSchema,
  loginSchema,
  otpRequestSchema,
  otpVerifySchema,
  refreshSchema,
  registerSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  totpCodeSchema,
  verifyEmailSchema,
} from '@marchmaker/shared';
import type { AppContext } from '../context';
import { audit } from '../lib/audit';
import { unauthorized } from '../lib/errors';
import { asyncHandler } from '../middleware/asyncHandler';
import { authedUser, clearAuthCookies, COOKIES, requireAuth, setAuthCookies } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { User } from '../models/core';
import * as auth from '../services/auth';
import { listSessions, revokeOwnSession } from '../services/account';
import { revokeAllSessions, revokeSession, rotateRefresh, type IssuedTokens } from '../services/sessions';

function limiter(ctx: AppContext, limit: number, windowMs: number) {
  return rateLimit({
    windowMs,
    limit: ctx.env.NODE_ENV === 'test' ? 10_000 : limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      res.status(429).json({
        error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please try again shortly.', requestId: req.id },
      });
    },
  });
}

export function authRouter(ctx: AppContext): Router {
  const r = Router();
  const refreshDays = ctx.env.REFRESH_TTL_DAYS;
  const staffRefreshDays = 1;

  const client = (req: Request) => ({ ip: req.ip, userAgent: req.get('user-agent'), deviceId: (req.get('x-device-id') ?? '').slice(0, 64) || undefined });

  function sendSession(
    res: Response,
    tokens: IssuedTokens,
    clientType: 'web' | 'mobile',
    extra: Record<string, unknown>,
    staff = false,
  ) {
    if (clientType === 'mobile') {
      res.json({ ...extra, tokens: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken } });
      return;
    }
    setAuthCookies(ctx, res, tokens, staff ? staffRefreshDays : refreshDays);
    res.json(extra);
  }

  r.post(
    '/register',
    limiter(ctx, 10, 60 * 60_000),
    validate({ body: registerSchema }),
    asyncHandler(async (req, res) => {
      await auth.register(ctx, req.body, client(req));
      // Always the same answer, whether or not the account already existed.
      res.status(202).json({ accepted: true, next: req.body.email ? 'verify_email' : 'verify_phone' });
    }),
  );

  r.post(
    '/login',
    limiter(ctx, 30, 15 * 60_000),
    validate({ body: loginSchema }),
    asyncHandler(async (req, res) => {
      const { clientType, ...input } = req.body;
      const result = await auth.login(ctx, input, client(req));
      const staff = result.roles.some((x) => x !== 'member');
      sendSession(
        res,
        result.tokens,
        clientType,
        { userId: result.userId, roles: result.roles, mfa: result.mfa, requiresTotpSetup: result.requiresTotpSetup },
        staff,
      );
    }),
  );

  r.post(
    '/google',
    limiter(ctx, 30, 15 * 60_000),
    validate({ body: googleSignInSchema }),
    asyncHandler(async (req, res) => {
      const { clientType, ...input } = req.body;
      const result = await auth.googleSignIn(ctx, input, client(req));
      sendSession(res, result.tokens, clientType, { userId: result.userId, roles: result.roles, mfa: false, requiresTotpSetup: false });
    }),
  );

  r.post(
    '/refresh',
    limiter(ctx, 60, 15 * 60_000),
    validate({ body: refreshSchema }),
    asyncHandler(async (req, res) => {
      const fromBody = req.body.refreshToken as string | undefined;
      const token = fromBody ?? (req.cookies?.[COOKIES.refresh] as string | undefined);
      if (!token) throw unauthorized('Your session has ended. Please sign in again.');
      const out = await rotateRefresh(ctx, token, client(req), (id) =>
        User.findById(id).select('roles status').lean() as never,
      );
      sendSession(res, out.tokens, fromBody ? 'mobile' : 'web', { userId: out.userId });
    }),
  );

  r.post(
    '/logout',
    asyncHandler(async (req, res) => {
      if (req.auth) await revokeSession(req.auth.sessionId, req.auth.userId, 'logout');
      clearAuthCookies(ctx, res);
      res.status(204).end();
    }),
  );

  r.post(
    '/logout-all',
    requireAuth,
    asyncHandler(async (req, res) => {
      const a = authedUser(req);
      await revokeAllSessions(a.userId, 'logout_all');
      await audit(req, { action: 'auth.logout_all', actorId: a.userId, subjectType: 'user', subjectId: a.userId });
      clearAuthCookies(ctx, res);
      res.status(204).end();
    }),
  );

  r.get(
    '/me',
    requireAuth,
    asyncHandler(async (req, res) => {
      const a = authedUser(req);
      res.json(await auth.buildMe(ctx, a.userId, a.sessionId, a.mfa));
    }),
  );

  r.post(
    '/verify-email',
    limiter(ctx, 20, 15 * 60_000),
    validate({ body: verifyEmailSchema }),
    asyncHandler(async (req, res) => {
      await auth.verifyEmail(ctx, req.body.token);
      res.json({ verified: true });
    }),
  );

  r.post(
    '/resend-verification',
    limiter(ctx, 5, 15 * 60_000),
    validate({ body: resendVerificationSchema }),
    asyncHandler(async (req, res) => {
      await auth.resendVerification(ctx, req.body.email);
      res.status(202).json({ accepted: true });
    }),
  );

  r.post(
    '/otp/request',
    limiter(ctx, 10, 15 * 60_000),
    validate({ body: otpRequestSchema }),
    asyncHandler(async (req, res) => {
      await auth.requestOtp(ctx, req.body, req.auth?.userId);
      res.status(202).json({ accepted: true, resendAfterSeconds: 60 });
    }),
  );

  r.post(
    '/otp/verify',
    limiter(ctx, 20, 15 * 60_000),
    validate({ body: otpVerifySchema }),
    asyncHandler(async (req, res) => {
      const { clientType, ...input } = req.body;
      const result = await auth.verifyOtp(ctx, input, client(req), req.auth?.userId);
      if ('tokens' in result) {
        sendSession(res, result.tokens, clientType, { userId: result.userId, roles: result.roles });
      } else {
        res.json(result);
      }
    }),
  );

  r.post(
    '/password/forgot',
    limiter(ctx, 5, 15 * 60_000),
    validate({ body: forgotPasswordSchema }),
    asyncHandler(async (req, res) => {
      await auth.forgotPassword(ctx, req.body.email);
      res.status(202).json({ accepted: true });
    }),
  );

  r.post(
    '/password/reset',
    limiter(ctx, 10, 15 * 60_000),
    validate({ body: resetPasswordSchema }),
    asyncHandler(async (req, res) => {
      await auth.resetPassword(ctx, req.body.token, req.body.password);
      clearAuthCookies(ctx, res);
      res.json({ reset: true });
    }),
  );

  r.get(
    '/sessions',
    requireAuth,
    asyncHandler(async (req, res) => {
      const a = authedUser(req);
      res.json({ items: await listSessions(a.userId, a.sessionId) });
    }),
  );

  r.delete(
    '/sessions/:id',
    requireAuth,
    asyncHandler(async (req, res) => {
      const a = authedUser(req);
      await revokeOwnSession(a.userId, String(req.params.id));
      if (String(req.params.id) === a.sessionId) clearAuthCookies(ctx, res);
      res.status(204).end();
    }),
  );

  // --- two-factor for staff accounts
  r.post(
    '/2fa/setup',
    requireAuth,
    asyncHandler(async (req, res) => {
      res.json(await auth.setupTotp(ctx, authedUser(req).userId));
    }),
  );

  r.post(
    '/2fa/confirm',
    requireAuth,
    validate({ body: totpCodeSchema }),
    asyncHandler(async (req, res) => {
      const { tokens, recoveryCodes } = await auth.confirmTotp(ctx, authedUser(req).userId, req.body.code, client(req));
      setAuthCookies(ctx, res, tokens, staffRefreshDays);
      // The recovery codes are shown exactly once, here.
      res.set('Cache-Control', 'no-store').json({ enabled: true, recoveryCodes, ...(req.auth?.viaBearer && { tokens }) });
    }),
  );

  r.get(
    '/2fa/recovery-codes',
    requireAuth,
    asyncHandler(async (req, res) => {
      res.set('Cache-Control', 'no-store').json({ remaining: await twoFactor.recoveryCodesLeft(authedUser(req).userId) });
    }),
  );

  // Replacing the codes needs a fresh authenticator code, so a stolen session alone cannot do it.
  r.post(
    '/2fa/recovery-codes',
    requireAuth,
    validate({ body: totpCodeSchema }),
    asyncHandler(async (req, res) => {
      res.set('Cache-Control', 'no-store').json({ recoveryCodes: await twoFactor.regenerate(ctx, authedUser(req).userId, req.body.code) });
    }),
  );

  return r;
}
