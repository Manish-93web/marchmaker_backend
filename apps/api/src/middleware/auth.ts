import type { Request, RequestHandler, Response } from 'express';
import { DEFAULTS, isStaff, type Permission, type Role } from '@marchmaker/shared';
import type { AppContext } from '../context';
import { AppError, forbidden, unauthorized } from '../lib/errors';
import { safeEqual } from '../lib/secrets';
import { Session, User } from '../models/core';
import { tag } from '../lib/routeIntrospect';
import { verifyAccess } from '../services/sessions';
import type { IssuedTokens } from '../services/sessions';

export const COOKIES = { access: 'mm_at', refresh: 'mm_rt', csrf: 'mm_csrf' } as const;

export interface AuthInfo {
  userId: string;
  roles: Role[];
  sessionId: string;
  mfa: boolean;
  permissions: Permission[];
  viaBearer: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthInfo;
    }
  }
}

export function setAuthCookies(ctx: AppContext, res: Response, t: IssuedTokens, refreshDays: number) {
  const common = {
    secure: ctx.env.COOKIE_SECURE,
    sameSite: 'lax' as const,
    domain: ctx.env.COOKIE_DOMAIN || undefined,
  };
  res.cookie(COOKIES.access, t.accessToken, {
    ...common,
    httpOnly: true,
    path: '/',
    maxAge: DEFAULTS.accessTokenTtlSec * 1000,
  });
  res.cookie(COOKIES.refresh, t.refreshToken, {
    ...common,
    httpOnly: true,
    path: '/api/v1/auth',
    maxAge: refreshDays * 86_400_000,
  });
  res.cookie(COOKIES.csrf, t.csrfToken, { ...common, httpOnly: false, path: '/', maxAge: refreshDays * 86_400_000 });
}

export function clearAuthCookies(ctx: AppContext, res: Response) {
  const base = { domain: ctx.env.COOKIE_DOMAIN || undefined };
  res.clearCookie(COOKIES.access, { ...base, path: '/' });
  res.clearCookie(COOKIES.refresh, { ...base, path: '/api/v1/auth' });
  res.clearCookie(COOKIES.csrf, { ...base, path: '/' });
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Rejects state-changing browser requests from origins outside the allow-list. */
export function originCheck(ctx: AppContext): RequestHandler {
  return (req, _res, next) => {
    const origin = req.get('origin');
    if (!SAFE_METHODS.has(req.method) && origin && !ctx.env.CORS_ORIGINS.includes(origin)) {
      return next(forbidden('This request origin is not allowed'));
    }
    next();
  };
}

const CSRF_EXEMPT = [
  /^\/auth\/(register|login|otp\/|verify-email|resend-verification|password\/)/,
  /^\/webhooks\//,
];

/**
 * Double-submit CSRF: cookie-authenticated unsafe requests must echo the csrf cookie in
 * X-CSRF-Token. Bearer-token clients (mobile) are not browser-ambient and are exempt.
 */
export const csrfProtection: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  if (req.get('authorization')?.startsWith('Bearer ')) return next();
  if (CSRF_EXEMPT.some((r) => r.test(req.path))) return next();
  const hasCookieAuth = !!(req.cookies?.[COOKIES.access] || req.cookies?.[COOKIES.refresh]);
  if (!hasCookieAuth) return next();
  const cookie: string | undefined = req.cookies?.[COOKIES.csrf];
  const header = req.get('x-csrf-token');
  if (!cookie || !header || !safeEqual(cookie, header)) {
    return next(new AppError(403, 'CSRF', 'Your session could not be verified. Please refresh and try again.'));
  }
  next();
};

/** Resolves the caller from a Bearer token or access cookie and enforces session state. */
export function authenticate(ctx: AppContext): RequestHandler {
  return async (req, _res, next) => {
    try {
      const header = req.get('authorization');
      const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
      const token = bearer ?? (req.cookies?.[COOKIES.access] as string | undefined);
      if (!token) return next();

      const claims = verifyAccess(ctx, token);
      const session = await Session.findById(claims.sid).select('revokedAt expiresAt absoluteExpiresAt lastSeenAt userId');
      const now = new Date();
      if (!session || session.revokedAt || session.expiresAt <= now || String(session.userId) !== claims.sub) {
        throw unauthorized('Your session has ended. Please sign in again.');
      }
      const staff = isStaff(claims.roles);
      if (staff && session.lastSeenAt && now.getTime() - session.lastSeenAt.getTime() > DEFAULTS.adminIdleSessionSec * 1000) {
        await Session.updateOne({ _id: session._id }, { $set: { revokedAt: now, revokedReason: 'idle_timeout' } });
        throw unauthorized('You were signed out after a period of inactivity.');
      }
      if (!session.lastSeenAt || now.getTime() - session.lastSeenAt.getTime() > 60_000) {
        await Session.updateOne({ _id: session._id }, { $set: { lastSeenAt: now } });
      }

      const user = await User.findById(claims.sub).select('roles status');
      if (!user || ['banned', 'deleted'].includes(user.status)) throw unauthorized();
      const roles = user.roles as Role[];
      req.auth = {
        userId: claims.sub,
        roles,
        sessionId: claims.sid,
        mfa: claims.mfa,
        permissions: isStaff(roles) ? await ctx.permissions.forRoles(roles) : [],
        viaBearer: !!bearer,
      };
      next();
    } catch (err) {
      next(err);
    }
  };
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.auth) return next(unauthorized());
  next();
};

/** Staff endpoints: needs the permission AND a session that passed TOTP. */
export function requirePermission(...perms: Permission[]): RequestHandler {
  return tag((req, _res, next) => {
    const a: AuthInfo | undefined = req.auth;
    if (!a) return next(unauthorized());
    if (!a.mfa) {
      return next(new AppError(403, 'TOTP_SETUP_REQUIRED', 'Two-factor authentication is required for staff accounts'));
    }
    if (!perms.every((p) => a.permissions.includes(p))) return next(forbidden());
    next();
  }, { permissions: perms });
}

/** Passes when the caller holds at least one of the permissions (for example view_basic or view_full). */
export function requireAnyPermission(...perms: Permission[]): RequestHandler {
  return (req, _res, next) => {
    const a: AuthInfo | undefined = req.auth;
    if (!a) return next(unauthorized());
    if (!a.mfa) {
      return next(new AppError(403, 'TOTP_SETUP_REQUIRED', 'Two-factor authentication is required for staff accounts'));
    }
    if (!perms.some((p) => a.permissions.includes(p))) return next(forbidden());
    next();
  };
}

export const authedUser = (req: Request): AuthInfo => {
  if (!req.auth) throw unauthorized();
  return req.auth;
};
