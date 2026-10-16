import type { Request } from 'express';
import {
  SEVERITY_ORDER,
  type CaseActionInput,
  type Role,
  type Severity,
} from '@marchmaker/shared';
import type { AppContext } from '../context';
import { audit, emit } from '../lib/audit';
import { AppError, conflict, forbidden, notFound } from '../lib/errors';
import { User } from '../models/core';
import { Report } from '../models/social';
import { Appeal, ModerationAction } from '../models/safety';
import { changeStatus } from './adminMembers';
import { sendNotice } from './notify';
import * as attachments from './attachments';

interface Actor {
  userId: string;
  roles: Role[];
  permissions: readonly string[];
}
const sid = (v: unknown) => String(v);

const present = (r: {
  _id: unknown;
  category: string;
  severity: string;
  status: string;
  createdAt: Date;
  slaDueAt?: Date | null;
  assigneeId?: unknown;
  escalated?: boolean;
  reportedId: unknown;
}) => ({
  id: sid(r._id),
  category: r.category,
  severity: r.severity as Severity,
  status: r.status,
  createdAt: r.createdAt,
  slaDueAt: r.slaDueAt ?? null,
  overdue: Boolean(r.slaDueAt && r.slaDueAt.getTime() < Date.now() && ['open', 'investigating'].includes(r.status)),
  assigneeId: r.assigneeId ? sid(r.assigneeId) : null,
  escalated: Boolean(r.escalated),
  reportedId: sid(r.reportedId),
});

export async function queue(filter: { status?: string; mine?: string; severity?: string }) {
  const q: Record<string, unknown> = {};
  q.status = filter.status && filter.status !== 'all' ? filter.status : { $in: ['open', 'investigating'] };
  if (filter.severity) q.severity = filter.severity;
  if (filter.mine) q.assigneeId = filter.mine;
  const rows = await Report.find(q).sort({ createdAt: 1 }).limit(200).lean();
  const users = await User.find({ _id: { $in: rows.map((r) => r.reportedId) } }).select('firstName status').lean();
  const byId = new Map(users.map((u) => [sid(u._id), u]));
  const counts = await Report.aggregate<{ _id: unknown; n: number }>([
    { $match: { reportedId: { $in: rows.map((r) => r.reportedId) } } },
    { $group: { _id: '$reportedId', n: { $addToSet: '$reporterId' } } },
    { $project: { n: { $size: '$n' } } },
  ]);
  const distinct = new Map(counts.map((c) => [sid(c._id), c.n]));
  const items = rows.map((r) => ({
    ...present(r),
    reportedName: byId.get(sid(r.reportedId))?.firstName ?? 'Member',
    reportedStatus: byId.get(sid(r.reportedId))?.status ?? 'active',
    distinctReporters: distinct.get(sid(r.reportedId)) ?? 1,
  }));
  // Critical first, then oldest. Overdue items float to the top of their severity.
  items.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      Number(b.overdue) - Number(a.overdue) ||
      a.createdAt.getTime() - b.createdAt.getTime(),
  );
  return { items };
}

export async function detail(ctx: AppContext, req: Request, id: string, actor: Actor) {
  const r = await Report.findById(id).lean();
  if (!r) throw notFound();
  const [reported, reporter, otherReports, actions] = await Promise.all([
    User.findById(r.reportedId).select('firstName status journeyState createdAt plan roles').lean(),
    User.findById(r.reporterId).select('firstName').lean(),
    Report.find({ reportedId: r.reportedId, _id: { $ne: r._id } }).sort({ createdAt: -1 }).limit(20).lean(),
    ModerationAction.find({ userId: r.reportedId }).sort({ createdAt: -1 }).limit(20).lean(),
  ]);

  const mayReadMessages = actor.permissions.includes('messages.view_reported');
  if (mayReadMessages && (r.transcript?.length || r.evidence?.length)) {
    // Reading private messages is always recorded.
    await audit(req, {
      action: r.evidence?.length ? 'report.evidence_viewed' : 'report.transcript_viewed',
      actorId: actor.userId,
      actorRoles: actor.roles,
      subjectType: 'report',
      subjectId: id,
    });
  }
  const distinctReporters = new Set([sid(r.reporterId), ...otherReports.map((o) => sid(o.reporterId))]).size;
  return {
    ...present(r),
    details: r.details ?? null,
    reporterName: reporter?.firstName ?? 'Member',
    reported: reported
      ? { id: sid(reported._id), name: reported.firstName, status: reported.status, journeyState: reported.journeyState, since: reported.createdAt, plan: reported.plan?.planCode ?? 'free' }
      : null,
    signals: {
      distinctReporters,
      otherReports: otherReports.length,
      priorWarnings: actions.filter((a) => a.action === 'warn').length,
      priorSuspensions: actions.filter((a) => a.action === 'suspend').length,
    },
    otherReports: otherReports.map(present),
    history: actions.map((a) => ({ id: sid(a._id), action: a.action, reason: a.reason, at: a.createdAt, by: sid(a.by) })),
    transcript: mayReadMessages ? r.transcript : null,
    evidence: mayReadMessages ? await attachments.withUrls(ctx, r.evidence as attachments.StoredAttachment[]) : [],
    evidenceRestricted: !mayReadMessages && (r.evidence?.length ?? 0) > 0,
    sourceTicketId: r.sourceTicketId ? sid(r.sourceTicketId) : null,
    transcriptRestricted: !mayReadMessages && (r.transcript?.length ?? 0) > 0,
    resolution: r.resolution ?? null,
  };
}

export async function claim(req: Request, id: string, actor: Actor) {
  const r = await Report.findOneAndUpdate(
    { _id: id, status: { $in: ['open', 'investigating'] }, $or: [{ assigneeId: { $exists: false } }, { assigneeId: null }, { assigneeId: actor.userId }] },
    { $set: { assigneeId: actor.userId, claimedAt: new Date(), status: 'investigating' } },
    { returnDocument: 'after' },
  );
  if (!r) {
    const exists = await Report.exists({ _id: id });
    if (!exists) throw notFound();
    throw conflict('This report has already been picked up by someone else or is closed');
  }
  await audit(req, { action: 'report.claimed', actorId: actor.userId, actorRoles: actor.roles, subjectType: 'report', subjectId: id });
  return present(r);
}

export async function act(ctx: AppContext, req: Request, id: string, input: CaseActionInput, actor: Actor) {
  const r = await Report.findById(id);
  if (!r) throw notFound();
  if (!['open', 'investigating'].includes(r.status)) throw conflict('This report is already closed');
  if (r.assigneeId && sid(r.assigneeId) !== actor.userId) throw conflict('Someone else is working on this report');

  const needs = { suspend: 'member.suspend', ban: 'member.ban' } as const;
  if (input.action in needs && !actor.permissions.includes(needs[input.action as keyof typeof needs])) {
    throw forbidden('You do not have permission for that action');
  }
  // As with matching, whoever escalated a case cannot be the one to close it.
  if (input.action !== 'escalate' && (await ModerationAction.exists({ reportId: r._id, action: 'escalate', by: actor.userId }))) {
    throw new AppError(409, 'CONFLICT', 'You escalated this report, so someone else needs to decide it');
  }

  const record = await ModerationAction.create({
    userId: r.reportedId,
    reportId: r._id,
    action: input.action,
    reason: input.reason,
    memberMessage: input.memberMessage,
    by: actor.userId,
  });

  if (input.action === 'escalate') {
    r.escalated = true;
    r.status = 'open';
    r.assigneeId = undefined;
    await r.save();
  } else {
    if (input.action === 'suspend' || input.action === 'ban') {
      await changeStatus(ctx, req, sid(r.reportedId), input.action, input.reason, actor);
    }
    if (input.action === 'warn') {
      await emit('moderation.warning', { userId: sid(r.reportedId), actionId: sid(record._id) });
    }
    r.status = input.action === 'dismiss' ? 'dismissed' : 'action_taken';
    r.resolution = { action: input.action, reason: input.reason, by: actor.userId as never, at: new Date() };
    r.assigneeId = (r.assigneeId ?? actor.userId) as never;
    await r.save();
    await emit('report.resolved', { userId: sid(r.reporterId), reportId: sid(r._id) });
  }

  await audit(req, {
    action: `report.${input.action}`,
    actorId: actor.userId,
    actorRoles: actor.roles,
    subjectType: 'report',
    subjectId: id,
    after: { reason: input.reason, reportedId: sid(r.reportedId) },
  });
  return present(r);
}

/** The text of a warning, for the member's "messages from our team" view. */
export async function warningsFor(userId: string) {
  const rows = await ModerationAction.find({ userId, action: 'warn' }).sort({ createdAt: -1 }).limit(10).lean();
  return rows.map((w) => ({ id: sid(w._id), message: w.memberMessage ?? '', at: w.createdAt }));
}

// ------------------------------------------------------------------ appeals

/**
 * Public. The answer never reveals whether the email belongs to an account, so this cannot be
 * used to discover who is on the platform.
 */
export async function submitAppeal(ctx: AppContext, email: string, message: string) {
  const user = await User.findOne({ email, status: { $in: ['suspended', 'banned'] } }).select('status moderation').lean();
  if (user) {
    const pending = await Appeal.exists({ userId: user._id, status: 'pending' });
    if (!pending) {
      await Appeal.create({
        userId: user._id,
        message,
        accountStatus: user.status,
        moderationReason: user.moderation?.reason,
      });
    }
  }
  ctx.log.info({ found: Boolean(user) }, 'appeal received');
  return { received: true };
}

export async function listAppeals(status?: string) {
  const rows = await Appeal.find(status && status !== 'all' ? { status: status as 'pending' | 'upheld' | 'overturned' } : { status: 'pending' as const }).sort({ createdAt: 1 }).limit(100).lean();
  const users = await User.find({ _id: { $in: rows.map((a) => a.userId) } }).select('firstName email moderation').lean();
  const byId = new Map(users.map((u) => [sid(u._id), u]));
  return {
    items: rows.map((a) => ({
      id: sid(a._id),
      userId: sid(a.userId),
      name: byId.get(sid(a.userId))?.firstName ?? 'Member',
      accountStatus: a.accountStatus,
      moderationReason: a.moderationReason ?? null,
      suspendedBy: byId.get(sid(a.userId))?.moderation?.by ? sid(byId.get(sid(a.userId))!.moderation!.by) : null,
      message: a.message,
      status: a.status,
      note: a.note ?? null,
      at: a.createdAt,
    })),
  };
}

export async function decideAppeal(
  ctx: AppContext,
  req: Request,
  id: string,
  input: { decision: 'upheld' | 'overturned'; note: string; memberMessage: string },
  actor: Actor,
) {
  const a = await Appeal.findById(id);
  if (!a) throw notFound();
  if (a.status !== 'pending') throw conflict('This appeal has already been decided');
  const user = await User.findById(a.userId).select('email moderation status firstName');
  if (!user) throw notFound();
  // A second pair of eyes: the person who took the action does not review the appeal.
  if (user.moderation?.by && sid(user.moderation.by) === actor.userId) {
    throw new AppError(409, 'CONFLICT', 'You took this action, so someone else needs to review the appeal');
  }
  if (input.decision === 'overturned' && ['suspended', 'banned'].includes(user.status)) {
    await changeStatus(ctx, req, sid(a.userId), 'restore', `Appeal overturned: ${input.note}`, actor);
  }
  a.status = input.decision;
  a.decidedBy = actor.userId as never;
  a.decidedAt = new Date();
  a.note = input.note;
  await a.save();
  await ModerationAction.create({
    userId: a.userId,
    action: 'dismiss',
    reason: `Appeal ${input.decision}: ${input.note}`,
    by: actor.userId,
  });
  await audit(req, {
    action: `appeal.${input.decision}`,
    actorId: actor.userId,
    actorRoles: actor.roles,
    subjectType: 'user',
    subjectId: sid(a.userId),
    after: { note: input.note },
  });
  // The member cannot sign in, so the decision goes by email.
  if (user.email) {
    await sendNotice(ctx, user.email, {
      subject: input.decision === 'overturned' ? 'Your appeal was successful' : 'About your appeal',
      preview: 'The outcome of your appeal',
      heading: input.decision === 'overturned' ? 'Your account has been restored' : 'We have reviewed your appeal',
      paragraphs: [input.memberMessage],
      ...(input.decision === 'overturned' ? { cta: { label: 'Sign in', url: `${ctx.env.APP_URL}/login` } } : {}),
    });
  }
  return { id, status: a.status };
}
