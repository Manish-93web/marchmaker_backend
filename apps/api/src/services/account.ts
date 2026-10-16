import { DEFAULTS, journeyMachine, notificationPrefsSchema, type JourneyState } from '@marchmaker/shared';
import type { AppContext } from '../context';
import { audit, emit, logTransition } from '../lib/audit';
import { AppError, badRequest, conflict, notFound } from '../lib/errors';
import { hashPassword, verifyPassword } from '../lib/passwords';
import { Consent, DataRequest } from '../models/auth';
import { Session, User } from '../models/core';
import { createLinkToken } from './auth';
import { latestLegal, recordConsent } from './legal';
import { sendNotice } from './notify';
import { revokeAllSessions, revokeSession } from './sessions';

const DAY = 86_400_000;

async function setJourney(userId: string, from: JourneyState, to: JourneyState) {
  if (from === to) return;
  if (!journeyMachine.canTransition(from, to)) return;
  await User.updateOne({ _id: userId }, { $set: { journeyState: to } });
  await logTransition('user_journey', userId, from, to, userId);
}

export async function patchAccount(
  ctx: AppContext,
  userId: string,
  patch: { firstName?: string; locale?: string; currentPassword?: string; newPassword?: string },
  currentSessionId: string,
) {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user) throw notFound();
  if (patch.firstName) user.firstName = patch.firstName;
  if (patch.locale) user.locale = patch.locale;

  if (patch.newPassword) {
    if (user.passwordHash) {
      const ok = await verifyPassword(user.passwordHash, patch.currentPassword ?? '');
      if (!ok) throw badRequest('Your current password is incorrect');
    }
    user.passwordHash = await hashPassword(patch.newPassword);
    await revokeAllSessions(userId, 'password_changed', currentSessionId);
  }
  await user.save();
}

/** Starts an email change: the new address must be confirmed through a link. */
export async function requestEmailChange(ctx: AppContext, userId: string, email: string, password: string) {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user) throw notFound();
  if (user.passwordHash && !(await verifyPassword(user.passwordHash, password))) {
    throw badRequest('Your current password is incorrect');
  }
  if (await User.exists({ email, _id: { $ne: userId } })) return; // silent: no enumeration
  const token = await createLinkToken(userId, 'change_email', 24 * 3_600_000, { email });
  await sendNotice(ctx, email, {
    subject: 'Confirm your new email',
    preview: 'Confirm your new email address',
    heading: 'Confirm your new email',
    paragraphs: ['Use the button below to make this your Marchmaker email. The link works for 24 hours.'],
    cta: { label: 'Confirm new email', url: `${ctx.env.APP_URL}/verify-email?token=${token}` },
  });
}

export async function pauseAccount(userId: string) {
  const user = await User.findById(userId);
  if (!user) throw notFound();
  if (user.status !== 'active') throw conflict('Your account cannot be paused right now');
  user.status = 'paused';
  user.pausedAt = new Date();
  await user.save();
  await setJourney(userId, user.journeyState as JourneyState, 'paused');
  await emit('account.paused', { userId });
}

export async function resumeAccount(userId: string) {
  const user = await User.findById(userId);
  if (!user) throw notFound();
  if (user.status !== 'paused') throw conflict('Your account is not paused');
  user.status = 'active';
  user.pausedAt = undefined;
  await user.save();
  await setJourney(userId, user.journeyState as JourneyState, 'matching_active');
  await emit('account.resumed', { userId });
}

export async function scheduleDeletion(
  ctx: AppContext,
  userId: string,
  input: { password?: string },
  currentSessionId: string,
) {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user) throw notFound();
  if (user.status === 'deletion_scheduled') throw conflict('Deletion is already scheduled');
  if (user.passwordHash && !(await verifyPassword(user.passwordHash, input.password ?? ''))) {
    throw badRequest('Your password is incorrect');
  }

  const when = new Date(Date.now() + DEFAULTS.accountDeletionGraceDays * DAY);
  user.statusBeforeDeletion = user.status;
  user.journeyBeforeDeletion = user.journeyState;
  user.status = 'deletion_scheduled';
  user.deletionScheduledFor = when;
  user.journeyState = 'deletion_scheduled';
  await user.save();
  await logTransition('user_journey', userId, user.journeyBeforeDeletion, 'deletion_scheduled', userId);
  await DataRequest.create({ userId, kind: 'deletion', status: 'pending', expiresAt: when });
  await revokeAllSessions(userId, 'deletion_scheduled', currentSessionId);
  await audit(undefined, { action: 'account.deletion_scheduled', actorId: userId, subjectType: 'user', subjectId: userId });
  await emit('account.deletion_scheduled', { userId, purgeAt: when.toISOString() });
  if (user.email) {
    await sendNotice(ctx, user.email, {
      subject: 'Your account is scheduled for deletion',
      preview: `Your account will be deleted on ${when.toDateString()}`,
      heading: 'Your account is scheduled for deletion',
      paragraphs: [
        `Your profile and data will be permanently deleted on ${when.toDateString()}.`,
        `Changed your mind? Sign in before then and restore your account.`,
      ],
      cta: { label: 'Restore my account', url: `${ctx.env.APP_URL}/login` },
    });
  }
  return { purgeAt: when };
}

export async function restoreAccount(userId: string) {
  const user = await User.findById(userId);
  if (!user || user.status !== 'deletion_scheduled') throw conflict('There is no deletion to cancel');
  if (user.deletionScheduledFor && user.deletionScheduledFor <= new Date()) {
    throw new AppError(410, 'GONE', 'This account has passed its restore window');
  }
  user.status = (user.statusBeforeDeletion as typeof user.status) ?? 'active';
  user.journeyState = (user.journeyBeforeDeletion as typeof user.journeyState) ?? 'registered';
  user.deletionScheduledFor = undefined;
  user.statusBeforeDeletion = undefined;
  user.journeyBeforeDeletion = undefined;
  await user.save();
  await DataRequest.updateMany({ userId, kind: 'deletion', status: 'pending' }, { $set: { status: 'cancelled' } });
  await logTransition('user_journey', userId, 'deletion_scheduled', user.journeyState, userId, 'restored');
  await emit('account.restored', { userId });
}

export async function requestExport(userId: string) {
  const since = new Date(Date.now() - DAY);
  const recent = await DataRequest.exists({ userId, kind: 'export', createdAt: { $gt: since }, status: { $ne: 'failed' } });
  if (recent) throw new AppError(429, 'RATE_LIMITED', 'You can request one export per day');
  const req = await DataRequest.create({ userId, kind: 'export', status: 'pending' });
  await emit('account.export_requested', { userId, dataRequestId: String(req._id) });
  return { id: String(req._id), status: req.status };
}

export async function listDataRequests(userId: string) {
  const rows = await DataRequest.find({ userId }).sort({ createdAt: -1 }).limit(20).lean();
  return rows.map((r) => ({
    id: String(r._id),
    kind: r.kind,
    status: r.status,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt ?? null,
  }));
}

export async function getNotificationPrefs(userId: string) {
  const user = await User.findById(userId).select('notificationPrefs');
  return user?.notificationPrefs ?? {};
}

export async function setNotificationPrefs(userId: string, input: unknown) {
  const prefs = notificationPrefsSchema.parse(input);
  // Security and safety messages cannot be switched off.
  const safe = structuredClone(prefs);
  for (const cat of ['safety', 'verification'] as const) {
    const row = safe.channels[cat];
    if (row) {
      row.in_app = true;
      row.email = true;
    }
  }
  await User.updateOne({ _id: userId }, { $set: { notificationPrefs: safe } });
  return safe;
}

export async function setConsent(
  userId: string,
  purpose: Parameters<typeof recordConsent>[1],
  granted: boolean,
  meta: { ip?: string; userAgent?: string },
) {
  if ((purpose === 'terms' || purpose === 'privacy') && !granted) {
    throw badRequest('Terms and privacy must be accepted to keep using Marchmaker. You can delete your account instead.');
  }
  const legal = purpose === 'terms' || purpose === 'privacy' ? await latestLegal([purpose]) : [];
  await recordConsent(userId, purpose, granted, { ...meta, documentVersion: legal[0]?.version });
}

export async function consentHistory(userId: string) {
  const rows = await Consent.find({ userId }).sort({ createdAt: -1 }).limit(100).lean();
  return rows.map((r) => ({
    purpose: r.purpose,
    granted: r.granted,
    documentVersion: r.documentVersion ?? null,
    at: r.createdAt,
  }));
}

export async function listSessions(userId: string, currentSessionId: string) {
  const rows = await Session.find({ userId, revokedAt: null, expiresAt: { $gt: new Date() } })
    .sort({ lastSeenAt: -1 })
    .lean();
  return rows.map((s) => ({
    id: String(s._id),
    current: String(s._id) === currentSessionId,
    userAgent: s.userAgent ?? null,
    ip: s.ip ?? null,
    lastSeenAt: s.lastSeenAt ?? s.createdAt,
    createdAt: s.createdAt,
  }));
}

export async function revokeOwnSession(userId: string, id: string) {
  const ok = await revokeSession(id, userId, 'user_revoked');
  if (!ok) throw notFound('That session was not found');
}
