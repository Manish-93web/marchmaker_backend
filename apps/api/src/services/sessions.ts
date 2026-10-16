import type { Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Role } from '@marchmaker/shared';
import { DEFAULTS, isStaff } from '@marchmaker/shared';
import type { AppContext } from '../context';
import { randomToken, sha256 } from '../lib/secrets';
import { Session } from '../models/core';
import { unauthorized } from '../lib/errors';
import { markActive } from './activity';

export interface AccessClaims {
  sub: string;
  sid: string;
  roles: Role[];
  mfa: boolean;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  sessionId: string;
}

interface ClientInfo {
  ip?: string;
  userAgent?: string;
}

const ENDED = 'Your session has ended. Please sign in again.';

function signAccess(ctx: AppContext, claims: AccessClaims): string {
  return jwt.sign(claims, ctx.env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: DEFAULTS.accessTokenTtlSec,
    issuer: 'marchmaker',
  });
}

export function verifyAccess(ctx: AppContext, token: string): AccessClaims {
  try {
    return jwt.verify(token, ctx.env.JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
      issuer: 'marchmaker',
    }) as AccessClaims;
  } catch {
    throw unauthorized(ENDED);
  }
}

/** Creates a session row + token set. `family` is reused when rotating a refresh token. */
export async function issueSession(
  ctx: AppContext,
  user: { _id: Types.ObjectId | string; roles: string[] },
  client: ClientInfo,
  opts: { mfa: boolean; family?: string; absoluteExpiresAt?: Date } = { mfa: false },
): Promise<IssuedTokens> {
  const staff = isStaff(user.roles as Role[]);
  if (!staff) void markActive(user._id);
  const now = Date.now();
  const refreshToken = randomToken(48);
  const familyId = opts.family ?? randomUUID();
  const absolute =
    opts.absoluteExpiresAt ??
    (staff
      ? new Date(now + DEFAULTS.adminAbsoluteSessionSec * 1000)
      : new Date(now + ctx.env.REFRESH_TTL_DAYS * 86_400_000));

  const session = await Session.create({
    userId: user._id,
    refreshTokenHash: sha256(refreshToken),
    familyId,
    userAgent: client.userAgent?.slice(0, 300),
    ip: client.ip,
    expiresAt: absolute,
    absoluteExpiresAt: absolute,
    lastSeenAt: new Date(now),
    mfa: opts.mfa,
  });

  const accessToken = signAccess(ctx, {
    sub: String(user._id),
    sid: String(session._id),
    roles: user.roles as Role[],
    mfa: opts.mfa,
  });
  return { accessToken, refreshToken, csrfToken: randomToken(24), sessionId: String(session._id) };
}

export interface RotationResult {
  tokens: IssuedTokens;
  userId: string;
}

/**
 * Rotating refresh tokens with reuse detection: each use revokes the presented
 * session and issues a new one in the same family. Presenting an already-rotated
 * token means it leaked, so the entire family is revoked.
 */
export async function rotateRefresh(
  ctx: AppContext,
  refreshToken: string,
  client: ClientInfo,
  loadUser: (id: string) => Promise<{ _id: Types.ObjectId | string; roles: string[]; status: string } | null>,
): Promise<RotationResult> {
  const session = await Session.findOne({ refreshTokenHash: sha256(refreshToken) });
  if (!session) throw unauthorized(ENDED);

  if (session.revokedAt) {
    if (session.revokedReason === 'rotated') {
      await Session.updateMany(
        { familyId: session.familyId, revokedAt: null },
        { $set: { revokedAt: new Date(), revokedReason: 'reuse_detected' } },
      );
      ctx.log.warn({ familyId: session.familyId }, 'refresh token reuse detected; family revoked');
    }
    throw unauthorized(ENDED);
  }

  const now = new Date();
  const user = await loadUser(String(session.userId));
  const staff = user ? isStaff(user.roles as Role[]) : false;
  const idleMs = DEFAULTS.adminIdleSessionSec * 1000;
  const expired =
    session.expiresAt <= now ||
    (session.absoluteExpiresAt && session.absoluteExpiresAt <= now) ||
    (staff && session.lastSeenAt && now.getTime() - session.lastSeenAt.getTime() > idleMs);
  if (!user || expired || ['banned', 'deleted'].includes(user.status)) {
    await Session.updateOne({ _id: session._id }, { $set: { revokedAt: now, revokedReason: 'expired' } });
    throw unauthorized(ENDED);
  }

  // Atomic claim: only one concurrent request may rotate this token.
  const claimed = await Session.findOneAndUpdate(
    { _id: session._id, revokedAt: null },
    { $set: { revokedAt: now, revokedReason: 'rotated' } },
  );
  if (!claimed) throw unauthorized(ENDED);

  const tokens = await issueSession(ctx, user, client, {
    mfa: Boolean(session.mfa),
    family: session.familyId,
    absoluteExpiresAt: session.absoluteExpiresAt ?? session.expiresAt,
  });
  return { tokens, userId: String(user._id) };
}

export async function revokeSession(sessionId: string, userId: string, reason = 'logout'): Promise<boolean> {
  const r = await Session.updateOne(
    { _id: sessionId, userId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
  return r.modifiedCount > 0;
}

export async function revokeAllSessions(userId: string, reason = 'logout_all', exceptSessionId?: string) {
  await Session.updateMany(
    { userId, revokedAt: null, ...(exceptSessionId && { _id: { $ne: exceptSessionId } }) },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
}
