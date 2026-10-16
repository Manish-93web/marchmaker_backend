import { Types } from 'mongoose';
import { z } from 'zod';
import type { Request } from 'express';
import {
  ASSESSMENT_KEYS,
  FEATURE_FLAGS,
  PERMISSIONS,
  ROLES,
  STAFF_ROLES,
  isStaff,
  type AssessmentKey,
  type Permission,
  type QuestionDef,
  type Role,
} from '@marchmaker/shared';
import type { AppContext } from '../context';
import { audit, emit } from '../lib/audit';
import { AppError, badRequest, conflict, notFound } from '../lib/errors';
import { RolePermission } from '../models/admin';
import { AssessmentDefinition } from '../models/assessment';
import { AuditLog, FeatureFlag, Session, User } from '../models/core';
import { Photo, Profile } from '../models/profile';
import { Verification } from '../models/verification';
import { createLinkToken } from './auth';
import { getDefinition } from './assessments';
import { sendNotice } from './notify';
import { revokeAllSessions } from './sessions';

interface Actor {
  userId: string;
  roles: Role[];
  permissions: readonly string[];
}

// ------------------------------------------------------------------ audit explorer

export interface AuditQuery {
  actor?: string;
  subject?: string;
  action?: string;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit: number;
}

async function auditFilter(q: Omit<AuditQuery, 'limit' | 'cursor'>) {
  const f: Record<string, unknown> = {};
  if (q.actor) {
    if (/^[a-f\d]{24}$/i.test(q.actor)) f.actorId = new Types.ObjectId(q.actor);
    else {
      const u = await User.findOne({ email: q.actor.toLowerCase() }).select('_id').lean();
      f.actorId = u?._id ?? new Types.ObjectId('000000000000000000000000');
    }
  }
  if (q.subject) f.subjectId = q.subject;
  if (q.action) f.action = { $regex: `^${q.action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` };
  if (q.from || q.to) f.createdAt = { ...(q.from && { $gte: q.from }), ...(q.to && { $lte: q.to }) };
  return f;
}

export async function searchAudit(q: AuditQuery) {
  const filter = await auditFilter(q);
  if (q.cursor && /^[a-f\d]{24}$/i.test(q.cursor)) filter._id = { $lt: new Types.ObjectId(q.cursor) };
  const rows = await AuditLog.find(filter).sort({ _id: -1 }).limit(q.limit + 1).lean();
  const page = rows.slice(0, q.limit);
  return {
    items: page.map((r) => ({
      id: String(r._id),
      at: r.createdAt,
      actorId: r.actorId ? String(r.actorId) : null,
      actorRoles: r.actorRoles ?? [],
      action: r.action,
      subjectType: r.subjectType ?? null,
      subjectId: r.subjectId ?? null,
      ip: r.ip ?? null,
      requestId: r.requestId ?? null,
      before: r.before ?? null,
      after: r.after ?? null,
    })),
    nextCursor: rows.length > q.limit ? String(page[page.length - 1]!._id) : null,
  };
}

/** Spreadsheet-safe CSV cell: quotes, and neutralises formulas so exports cannot run code in Excel. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export async function auditCsv(req: Request, q: Omit<AuditQuery, 'limit' | 'cursor'>, actor: Actor): Promise<string> {
  const filter = await auditFilter(q);
  const rows = await AuditLog.find(filter).sort({ _id: -1 }).limit(5000).lean();
  const head = ['time', 'actorId', 'actorRoles', 'action', 'subjectType', 'subjectId', 'ip', 'requestId', 'before', 'after'];
  const lines = rows.map((r) =>
    [
      r.createdAt.toISOString(),
      r.actorId ? String(r.actorId) : '',
      (r.actorRoles ?? []).join('|'),
      r.action,
      r.subjectType,
      r.subjectId,
      r.ip,
      r.requestId,
      r.before,
      r.after,
    ]
      .map(csvCell)
      .join(','),
  );
  await audit(req, { action: 'audit.export', actorId: actor.userId, actorRoles: actor.roles, after: { rows: rows.length, filter: q } });
  return [head.join(','), ...lines].join('\r\n');
}

// ------------------------------------------------------------------ team and roles

export const staffCreateSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  firstName: z.string().trim().min(1).max(60),
  roles: z.array(z.enum(ROLES as unknown as [Role, ...Role[]])).min(1).max(4),
});

const HIGH: readonly Role[] = ['admin', 'super_admin'];

function assertCanGrant(actor: Actor, roles: readonly Role[]) {
  if (roles.includes('member')) throw badRequest('Staff accounts cannot also be members');
  if (roles.some((r) => HIGH.includes(r)) && !actor.roles.includes('super_admin')) {
    throw new AppError(403, 'FORBIDDEN', 'Only a super admin can grant admin roles');
  }
}

export async function listStaff() {
  const rows = await User.find({ roles: { $in: STAFF_ROLES } }).sort({ createdAt: -1 }).limit(200).lean();
  return rows.map((u) => ({
    id: String(u._id),
    firstName: u.firstName,
    email: u.email ?? null,
    roles: u.roles,
    status: u.status,
    twoFactorEnabled: !!u.twoFactor?.enabled,
    lastActiveAt: u.lastActiveAt ?? null,
  }));
}

export async function inviteStaff(
  ctx: AppContext,
  req: Request,
  actor: Actor,
  input: z.infer<typeof staffCreateSchema>,
) {
  assertCanGrant(actor, input.roles);
  if (await User.exists({ email: input.email })) throw conflict('That email already has an account');
  const user = await User.create({
    email: input.email,
    firstName: input.firstName,
    gender: 'non_binary',
    // Staff date of birth is not needed; the field is required by the member schema.
    dobEnc: ctx.crypto.encrypt('1970-01-01'),
    roles: input.roles,
    emailVerifiedAt: new Date(),
    journeyState: 'email_verified',
  });
  // The invite is a single-use "set your password" link, valid for 48 hours.
  const token = await createLinkToken(user._id, 'password_reset', 48 * 3_600_000);
  await sendNotice(ctx, input.email, {
    subject: 'You have been invited to the Marchmaker team',
    preview: 'Set your password to get started',
    heading: `Welcome, ${input.firstName}`,
    paragraphs: [
      `You have been added to the Marchmaker team as ${input.roles.join(', ').replace(/_/g, ' ')}.`,
      'Set your password, then you will be asked to set up two-factor authentication. The link works once and expires in 48 hours.',
    ],
    cta: { label: 'Set my password', url: `${ctx.env.ADMIN_URL}/reset-password?token=${token}` },
  });
  await audit(req, {
    action: 'staff.invite',
    actorId: actor.userId,
    actorRoles: actor.roles,
    subjectType: 'user',
    subjectId: String(user._id),
    after: { roles: input.roles },
  });
  return { id: String(user._id) };
}

export async function setStaffRoles(req: Request, id: string, actor: Actor, roles: Role[]) {
  assertCanGrant(actor, roles);
  const user = await User.findById(id);
  if (!user || !isStaff(user.roles as Role[])) throw notFound('Staff member not found');
  if ((user.roles as Role[]).some((r) => HIGH.includes(r)) && !actor.roles.includes('super_admin')) {
    throw new AppError(403, 'FORBIDDEN', 'Only a super admin can change an admin');
  }
  if (user.roles.includes('super_admin') && !roles.includes('super_admin')) {
    const others = await User.countDocuments({ roles: 'super_admin', status: 'active', _id: { $ne: user._id } });
    if (others === 0) throw conflict('There must always be at least one active super admin');
  }
  const before = [...user.roles];
  user.roles = roles;
  await user.save();
  await revokeAllSessions(id, 'roles_changed');
  await audit(req, {
    action: 'staff.roles_changed',
    actorId: actor.userId,
    actorRoles: actor.roles,
    subjectType: 'user',
    subjectId: id,
    before: { roles: before },
    after: { roles },
  });
}

export async function setStaffActive(req: Request, id: string, actor: Actor, active: boolean) {
  if (id === actor.userId) throw conflict('You cannot deactivate your own account');
  const user = await User.findById(id);
  if (!user || !isStaff(user.roles as Role[])) throw notFound('Staff member not found');
  if (user.roles.includes('super_admin') && !active && !actor.roles.includes('super_admin')) {
    throw new AppError(403, 'FORBIDDEN', 'Only a super admin can deactivate a super admin');
  }
  if (!active && user.roles.includes('super_admin')) {
    const others = await User.countDocuments({ roles: 'super_admin', status: 'active', _id: { $ne: user._id } });
    if (others === 0) throw conflict('There must always be at least one active super admin');
  }
  user.status = active ? 'active' : 'suspended';
  await user.save();
  if (!active) await revokeAllSessions(id, 'staff_deactivated');
  await audit(req, {
    action: active ? 'staff.activated' : 'staff.deactivated',
    actorId: actor.userId,
    actorRoles: actor.roles,
    subjectType: 'user',
    subjectId: id,
  });
}

/**
 * For a staff member who has lost their authenticator and their recovery codes. It removes the
 * authenticator and codes and ends every session, so they must enrol again at their next sign-in.
 * It never lets a password alone open the console: enrolment happens after a normal password sign-in,
 * and the person is told by email.
 */
export async function resetStaffTwoFactor(ctx: AppContext, req: Request, id: string, actor: Actor) {
  if (id === actor.userId) throw conflict('Use a recovery code to sign in, or ask another super admin to reset yours');
  const user = await User.findById(id);
  if (!user || !isStaff(user.roles as Role[])) throw notFound('Staff member not found');
  if (user.roles.includes('super_admin') && !actor.roles.includes('super_admin')) {
    throw new AppError(403, 'FORBIDDEN', 'Only a super admin can reset a super admin');
  }
  await User.updateOne(
    { _id: id },
    { $set: { 'twoFactor.enabled': false }, $unset: { 'twoFactor.secretEnc': 1, 'twoFactor.recoveryHashes': 1, 'twoFactor.recentCodes': 1 } },
  );
  await revokeAllSessions(id, 'two_factor_reset');
  await audit(req, {
    action: 'staff.two_factor_reset',
    actorId: actor.userId,
    actorRoles: actor.roles,
    subjectType: 'user',
    subjectId: id,
  });
  if (user.email) {
    await sendNotice(ctx, user.email, {
      subject: 'Your two-factor sign-in was reset',
      preview: 'Security notice',
      heading: 'Your two-factor sign-in was reset',
      paragraphs: [
        'A super admin reset the authenticator on your staff account. You will be asked to set it up again the next time you sign in.',
        'If you did not ask for this, tell a super admin straight away.',
      ],
    });
  }
}

export async function roleMatrix(ctx: AppContext) {
  const mapping = await ctx.permissions.mapping();
  return { permissions: PERMISSIONS, roles: Object.fromEntries(ROLES.filter((r) => r !== 'member').map((r) => [r, mapping[r]])) };
}

export const rolePermissionsSchema = z.object({
  permissions: z.array(z.enum(PERMISSIONS as unknown as [Permission, ...Permission[]])).max(PERMISSIONS.length),
});

export async function setRolePermissions(
  ctx: AppContext,
  req: Request,
  role: string,
  actor: Actor,
  permissions: Permission[],
) {
  if (!(ROLES as readonly string[]).includes(role) || role === 'member') throw notFound('Unknown role');
  if (role === 'super_admin') throw new AppError(403, 'FORBIDDEN', 'The super admin role always has every permission');
  const before = (await ctx.permissions.mapping())[role as Role];
  const unique = [...new Set(permissions)];
  await RolePermission.updateOne(
    { role: role as Role },
    { $set: { permissions: unique, updatedBy: actor.userId } },
    { upsert: true },
  );
  ctx.permissions.invalidate();
  await audit(req, {
    action: 'roles.permissions_changed',
    actorId: actor.userId,
    actorRoles: actor.roles,
    subjectType: 'role',
    subjectId: role,
    before: { permissions: before },
    after: { permissions: unique },
  });
  return { role, permissions: unique };
}

// ------------------------------------------------------------------ feature flags

export async function listFlags() {
  const rows = await FeatureFlag.find().lean();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return FEATURE_FLAGS.map((key) => ({
    key,
    enabled: byKey.get(key)?.enabled ?? false,
    description: byKey.get(key)?.description ?? null,
  }));
}

export async function setFlag(req: Request, key: string, enabled: boolean, actor: Actor) {
  if (!(FEATURE_FLAGS as readonly string[]).includes(key)) throw notFound('Unknown flag');
  const before = (await FeatureFlag.findOne({ key }).lean())?.enabled ?? false;
  await FeatureFlag.updateOne({ key }, { $set: { enabled, updatedBy: actor.userId } }, { upsert: true });
  await audit(req, {
    action: 'flag.changed',
    actorId: actor.userId,
    actorRoles: actor.roles,
    subjectType: 'flag',
    subjectId: key,
    before: { enabled: before },
    after: { enabled },
  });
  return { key, enabled };
}

// ------------------------------------------------------------------ question bank editor

const questionSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,23}$/),
    type: z.enum(['likert', 'single_choice', 'ranking']),
    prompt: z.string().trim().min(8).max(300),
    dimension: z.string().min(1).max(40).optional(),
    reverse: z.boolean().optional(),
    options: z
      .array(z.object({ id: z.string().min(1).max(40), label: z.string().min(1).max(200), value: z.number().min(0).max(1) }))
      .min(2)
      .max(6)
      .optional(),
    items: z
      .array(z.object({ id: z.string().min(1).max(40), label: z.string().min(1).max(200), dimension: z.string().min(1).max(40) }))
      .min(2)
      .max(8)
      .optional(),
  })
  .superRefine((q, ctx) => {
    if (q.type === 'likert' && !q.dimension) ctx.addIssue({ code: 'custom', path: ['dimension'], message: 'A likert question needs a dimension' });
    if (q.type === 'single_choice' && (!q.dimension || !q.options)) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'A choice question needs a dimension and options' });
    }
    if (q.type === 'ranking' && !q.items) ctx.addIssue({ code: 'custom', path: ['items'], message: 'A ranking question needs items' });
  });

export const bankPublishSchema = z
  .object({
    title: z.string().trim().min(3).max(80),
    description: z.string().trim().max(300).default(''),
    minutes: z.number().int().min(1).max(30),
    dimensions: z.array(z.string().min(1).max(40)).min(1).max(8),
    questions: z.array(questionSchema).min(8).max(15),
  })
  .superRefine((b, ctx) => {
    const ids = b.questions.map((q) => q.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['questions'], message: 'Question ids must be unique' });
    const used = new Set<string>();
    for (const q of b.questions) {
      if (q.dimension) used.add(q.dimension);
      q.items?.forEach((i) => used.add(i.dimension));
    }
    for (const d of used) {
      if (!b.dimensions.includes(d)) ctx.addIssue({ code: 'custom', path: ['dimensions'], message: `Question uses undeclared dimension "${d}"` });
    }
    for (const d of b.dimensions) {
      if (!used.has(d)) ctx.addIssue({ code: 'custom', path: ['dimensions'], message: `Dimension "${d}" is never measured` });
    }
  });
export type BankPublish = z.infer<typeof bankPublishSchema>;

export async function listBanks() {
  const out = [];
  for (const key of ASSESSMENT_KEYS) {
    const def = await getDefinition(key);
    out.push({ key, version: def.version, title: def.title, questionCount: def.questions.length, dimensions: def.dimensions });
  }
  return out;
}

export async function bankDetail(key: string) {
  if (!(ASSESSMENT_KEYS as readonly string[]).includes(key)) throw notFound('Unknown assessment');
  const def = await getDefinition(key);
  const history = await AssessmentDefinition.find({ key: key as AssessmentKey }).sort({ version: -1 }).select('version publishedAt').lean();
  return { ...def, history: history.map((h) => ({ version: h.version, publishedAt: h.publishedAt })) };
}

/** Publishing never edits a version in place: it appends the next one. */
export async function publishBank(req: Request, key: string, actor: Actor, body: BankPublish) {
  if (!(ASSESSMENT_KEYS as readonly string[]).includes(key)) throw notFound('Unknown assessment');
  const current = await getDefinition(key);
  const next = current.version + 1;
  try {
    await AssessmentDefinition.create({
      key: key as AssessmentKey,
      version: next,
      ...body,
      questions: body.questions as QuestionDef[],
      active: true,
      publishedBy: actor.userId,
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw conflict('Someone published a new version first. Reload and try again.');
    throw err;
  }
  await audit(req, {
    action: 'assessment.published',
    actorId: actor.userId,
    actorRoles: actor.roles,
    subjectType: 'assessment',
    subjectId: key,
    after: { version: next, questions: body.questions.length },
  });
  await emit('assessment.bank_published', { key, version: next });
  return { key, version: next };
}

// ------------------------------------------------------------------ dashboard

export async function dashboard() {
  const week = new Date(Date.now() - 7 * 86_400_000);
  const [
    members,
    signups7d,
    profilesWaiting,
    photosWaiting,
    verificationWaiting,
    verificationManual,
    oldestProfile,
    suspended,
    staffOnline,
  ] = await Promise.all([
    User.countDocuments({ roles: 'member' }),
    User.countDocuments({ roles: 'member', createdAt: { $gte: week } }),
    Profile.countDocuments({ status: 'submitted' }),
    Photo.countDocuments({ status: 'pending' }),
    Verification.countDocuments({ status: { $in: ['pending', 'in_review'] } }),
    Verification.countDocuments({ status: 'in_review', manualReason: { $exists: true } }),
    Profile.findOne({ status: 'submitted' }).sort({ submittedAt: 1 }).select('submittedAt').lean(),
    User.countDocuments({ status: { $in: ['suspended', 'banned'] } }),
    Session.countDocuments({ revokedAt: null, lastSeenAt: { $gte: new Date(Date.now() - 15 * 60_000) } }),
  ]);
  return {
    members,
    signups7d,
    queues: {
      profiles: profilesWaiting,
      photos: photosWaiting,
      verifications: verificationWaiting,
      verificationsNeedingReview: verificationManual,
    },
    oldestProfileWaitingHours: oldestProfile?.submittedAt
      ? Math.round((Date.now() - oldestProfile.submittedAt.getTime()) / 3_600_000)
      : null,
    restricted: suspended,
    activeSessions15m: staffOnline,
  };
}
