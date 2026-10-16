import type { Request } from 'express';
import {
  defaultPriority,
  ticketDueAt,
  type Role,
  type TicketCategory,
  type TicketPriority,
  type TicketStatus,
} from '@marchmaker/shared';
import type { AppContext } from '../context';
import { audit, emit } from '../lib/audit';
import { conflict, notFound } from '../lib/errors';
import { User } from '../models/core';
import { InvoiceCounter } from '../models/billing';
import { CannedReply, Ticket, TicketMessage } from '../models/safety';
import { Report } from '../models/social';
import { reportDueAt } from '@marchmaker/shared';
import * as attachments from './attachments';
import { sendNotice } from './notify';

interface Actor {
  userId: string;
  roles: Role[];
  permissions: readonly string[];
}
const sid = (v: unknown) => String(v);

async function nextNumber() {
  const c = await InvoiceCounter.findOneAndUpdate({ key: 'TICKET' }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  return `T-${String(c.seq).padStart(6, '0')}`;
}

const overdue = (t: { status: string; firstResponseAt?: Date | null; firstResponseDueAt?: Date | null }) =>
  Boolean(t.status === 'open' && !t.firstResponseAt && t.firstResponseDueAt && t.firstResponseDueAt.getTime() < Date.now());

const presentTicket = (t: {
  _id: unknown;
  number: string;
  category: string;
  subject: string;
  priority: string;
  status: string;
  lastMessageAt: Date;
  lastMessageBy?: string | null;
  createdAt: Date;
}) => ({
  id: sid(t._id),
  number: t.number,
  category: t.category,
  subject: t.subject,
  priority: t.priority,
  status: t.status,
  lastMessageAt: t.lastMessageAt,
  lastMessageBy: t.lastMessageBy ?? null,
  createdAt: t.createdAt,
});

export async function create(
  ctx: AppContext,
  input: {
    userId?: string;
    email: string;
    name?: string;
    category: TicketCategory;
    subject: string;
    body: string;
    priority?: TicketPriority;
    attachments?: string[];
  },
) {
  const now = new Date();
  const files = input.userId && input.attachments?.length ? await attachments.confirm(ctx, input.userId, 'ticket', input.attachments) : [];
  const priority = input.priority ?? defaultPriority(input.category);
  const t = await Ticket.create({
    number: await nextNumber(),
    userId: input.userId,
    email: input.email,
    name: input.name,
    category: input.category,
    subject: input.subject,
    priority,
    firstResponseDueAt: ticketDueAt(priority, now),
    lastMessageAt: now,
    lastMessageBy: 'member',
  });
  await TicketMessage.create({ ticketId: t._id, author: 'member', authorId: input.userId, body: input.body, attachments: files });
  await emit('support.ticket_created', { ticketId: sid(t._id), number: t.number, priority });
  return presentTicket(t);
}

// ------------------------------------------------------------------ member side

export async function listMine(userId: string) {
  const rows = await Ticket.find({ userId }).sort({ lastMessageAt: -1 }).limit(50).lean();
  return { items: rows.map(presentTicket) };
}

export async function getMine(ctx: AppContext, userId: string, id: string) {
  const t = await Ticket.findOne({ _id: id, userId }).lean();
  if (!t) throw notFound();
  const msgs = await TicketMessage.find({ ticketId: t._id, internal: false }).sort({ _id: 1 }).lean();
  return {
    ...presentTicket(t),
    rating: t.csat?.rating ?? null,
    messages: await Promise.all(msgs.map(async (m) => ({ id: sid(m._id), author: m.author, body: m.body, at: m.createdAt, attachments: await attachments.withUrls(ctx, m.attachments as attachments.StoredAttachment[]) }))),
  };
}

export async function replyMine(ctx: AppContext, userId: string, id: string, body: string, keys: string[] = []) {
  const t = await Ticket.findOne({ _id: id, userId });
  if (!t) throw notFound();
  if (t.status === 'closed') throw conflict('This conversation is closed. Please start a new one.');
  const files = keys.length ? await attachments.confirm(ctx, userId, 'ticket', keys) : [];
  const m = await TicketMessage.create({ ticketId: t._id, author: 'member', authorId: userId, body, attachments: files });
  t.status = t.firstResponseAt ? 'awaiting_team' : 'open';
  t.lastMessageAt = new Date();
  t.lastMessageBy = 'member';
  t.resolvedAt = undefined;
  await t.save();
  return { id: sid(m._id) };
}

export async function closeMine(userId: string, id: string) {
  const r = await Ticket.updateOne({ _id: id, userId, status: { $ne: 'closed' } }, { $set: { status: 'closed' } });
  if (!r.matchedCount && !(await Ticket.exists({ _id: id, userId }))) throw notFound();
  return { status: 'closed' as const };
}

/** One rating per ticket, only once the team has finished with it. */
export async function rateMine(userId: string, id: string, input: { rating: number; comment?: string }) {
  const r = await Ticket.updateOne({ _id: id, userId, status: { $in: ['resolved', 'closed'] }, 'csat.rating': { $exists: false } }, { $set: { csat: { ...input, at: new Date() } } });
  if (!r.matchedCount) {
    const t = await Ticket.findOne({ _id: id, userId }).select('status csat').lean();
    if (!t) throw notFound();
    if (t.csat?.rating) throw conflict('You have already rated this conversation');
    throw conflict('You can rate a conversation once it has been resolved');
  }
  return { rated: true };
}

/** Average rating and counts for the support dashboard. */
export async function csatSummary(days = 30) {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await Ticket.aggregate([{ $match: { 'csat.at': { $gte: since } } }, { $group: { _id: null, avg: { $avg: '$csat.rating' }, n: { $sum: 1 } } }]);
  return { days, responses: rows[0]?.n ?? 0, average: rows[0] ? Math.round(rows[0].avg * 100) / 100 : null };
}

/** Raises a safety report from a ticket so the moderation workflow (SLA, claim, action) takes over. */
export async function escalateToModeration(
  req: Request,
  id: string,
  input: { category: (typeof import('@marchmaker/shared'))['REPORT_CATEGORIES'][number]; reportedUserId: string; note: string },
  actor: Actor,
) {
  const t = await Ticket.findById(id);
  if (!t) throw notFound();
  if (!t.userId) throw conflict('This ticket is not linked to a member, so it cannot become a report');
  if (await Report.exists({ sourceTicketId: t._id })) throw conflict('This ticket has already been escalated');
  const { REPORT_SEVERITY } = await import('@marchmaker/shared');
  const severity = REPORT_SEVERITY[input.category];
  const r = await Report.create({
    reporterId: t.userId,
    reportedId: input.reportedUserId,
    category: input.category,
    severity,
    details: `From ticket ${t.number}: ${input.note}`,
    sourceTicketId: t._id,
    slaDueAt: reportDueAt(severity, new Date()),
  });
  await TicketMessage.create({ ticketId: t._id, author: 'system', body: `Escalated to moderation as a ${severity} report.`, internal: true });
  await audit(req, { action: 'ticket.escalated', actorId: actor.userId, actorRoles: actor.roles, subjectType: 'ticket', subjectId: id, after: { reportId: sid(r._id), severity } });
  if (severity === 'critical') await emit('safety.critical_report', { reportId: sid(r._id), category: input.category });
  await emit('report.created', { reportId: sid(r._id), severity });
  return { reportId: sid(r._id), severity };
}

// ------------------------------------------------------------------ staff side

export async function listStaff(
  actor: Actor,
  f: { status?: string; assignee?: string; overdue?: boolean; q?: string; category?: string },
) {
  const q: Record<string, unknown> = {};
  q.status = f.status && f.status !== 'all' ? f.status : { $in: ['open', 'awaiting_team', 'awaiting_member'] };
  if (f.assignee === 'me') q.assigneeId = actor.userId;
  if (f.assignee === 'unassigned') q.assigneeId = { $exists: false };
  if (f.category) q.category = f.category;
  if (f.q) {
    const term = f.q.trim();
    q.$or = [{ number: term.toUpperCase() }, { email: term.toLowerCase() }, { subject: { $regex: term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }];
  }
  if (f.overdue) {
    q.status = 'open';
    q.firstResponseAt = { $exists: false };
    q.firstResponseDueAt = { $lt: new Date() };
  }
  const rows = await Ticket.find(q).sort({ priority: 1, firstResponseDueAt: 1, lastMessageAt: 1 }).limit(200).lean();
  return {
    items: rows.map((t) => ({
      ...presentTicket(t),
      email: t.email,
      name: t.name ?? null,
      assigneeId: t.assigneeId ? sid(t.assigneeId) : null,
      firstResponseDueAt: t.firstResponseDueAt ?? null,
      overdue: overdue(t),
    })),
  };
}

export async function getStaff(ctx: AppContext, id: string) {
  const t = await Ticket.findById(id).lean();
  if (!t) throw notFound();
  const [msgs, member] = await Promise.all([
    TicketMessage.find({ ticketId: t._id }).sort({ _id: 1 }).lean(),
    t.userId ? User.findById(t.userId).select('firstName status plan journeyState').lean() : null,
  ]);
  return {
    ...presentTicket(t),
    email: t.email,
    name: t.name ?? null,
    assigneeId: t.assigneeId ? sid(t.assigneeId) : null,
    firstResponseDueAt: t.firstResponseDueAt ?? null,
    firstResponseAt: t.firstResponseAt ?? null,
    overdue: overdue(t),
    member: member
      ? { id: sid(member._id), name: member.firstName, status: member.status, plan: member.plan?.planCode ?? 'free', journeyState: member.journeyState }
      : null,
    rating: t.csat?.rating ?? null,
    messages: await Promise.all(
      msgs.map(async (m) => ({
        id: sid(m._id),
        author: m.author,
        authorId: m.authorId ? sid(m.authorId) : null,
        body: m.body,
        internal: m.internal,
        at: m.createdAt,
        attachments: await attachments.withUrls(ctx, m.attachments as attachments.StoredAttachment[]),
      })),
    ),
  };
}

export async function replyStaff(ctx: AppContext, req: Request, id: string, body: string, actor: Actor) {
  const t = await Ticket.findById(id);
  if (!t) throw notFound();
  if (t.status === 'closed') throw conflict('This ticket is closed');
  const m = await TicketMessage.create({ ticketId: t._id, author: 'staff', authorId: actor.userId, body });
  t.status = 'awaiting_member';
  t.lastMessageAt = new Date();
  t.lastMessageBy = 'staff';
  if (!t.firstResponseAt) t.firstResponseAt = new Date();
  if (!t.assigneeId) t.assigneeId = actor.userId as never;
  await t.save();

  if (t.userId) {
    await emit('support.replied', { userId: sid(t.userId), ticketId: sid(t._id), messageId: sid(m._id), number: t.number });
  } else {
    // People who wrote from the public form have no inbox, so the reply goes to their email.
    await sendNotice(ctx, t.email, {
      subject: `Re: ${t.subject} [${t.number}]`,
      preview: body.slice(0, 80),
      heading: `Reply to ${t.number}`,
      paragraphs: [body, 'Reply to this email or write to us again from the contact page if you need more help.'],
    });
  }
  await audit(req, { action: 'ticket.replied', actorId: actor.userId, actorRoles: actor.roles, subjectType: 'ticket', subjectId: id });
  return { id: sid(m._id) };
}

export async function addNote(req: Request, id: string, body: string, actor: Actor) {
  const t = await Ticket.exists({ _id: id });
  if (!t) throw notFound();
  const m = await TicketMessage.create({ ticketId: id, author: 'staff', authorId: actor.userId, body, internal: true });
  await audit(req, { action: 'ticket.noted', actorId: actor.userId, actorRoles: actor.roles, subjectType: 'ticket', subjectId: id });
  return { id: sid(m._id) };
}

export async function update(
  ctx: AppContext,
  req: Request,
  id: string,
  patch: { status?: TicketStatus; priority?: TicketPriority; assigneeId?: string | null },
  actor: Actor,
) {
  const t = await Ticket.findById(id);
  if (!t) throw notFound();
  const set: Record<string, unknown> = {};
  const unset: Record<string, 1> = {};
  if (patch.status) {
    set.status = patch.status;
    if (patch.status === 'resolved') set.resolvedAt = new Date();
  }
  if (patch.priority && patch.priority !== t.priority) {
    set.priority = patch.priority;
    if (!t.firstResponseAt) set.firstResponseDueAt = ticketDueAt(patch.priority, t.createdAt);
  }
  if (patch.assigneeId === null) unset.assigneeId = 1;
  else if (patch.assigneeId) set.assigneeId = patch.assigneeId;
  await Ticket.updateOne({ _id: id }, { ...(Object.keys(set).length && { $set: set }), ...(Object.keys(unset).length && { $unset: unset }) });
  await audit(req, {
    action: 'ticket.updated',
    actorId: actor.userId,
    actorRoles: actor.roles,
    subjectType: 'ticket',
    subjectId: id,
    after: patch,
  });
  return getStaff(ctx, id);
}

/** Resolved tickets close after 7 quiet days, tickets waiting on a member after 14. */
export async function closeStale(now = new Date()) {
  const d = (n: number) => new Date(now.getTime() - n * 86_400_000);
  const a = await Ticket.updateMany({ status: 'resolved', resolvedAt: { $lt: d(7) } }, { $set: { status: 'closed' } });
  const b = await Ticket.updateMany({ status: 'awaiting_member', lastMessageAt: { $lt: d(14) } }, { $set: { status: 'closed' } });
  return a.modifiedCount + b.modifiedCount;
}

// ------------------------------------------------------------------ canned replies

export async function listCanned() {
  const rows = await CannedReply.find().sort({ title: 1 }).lean();
  return { items: rows.map((c) => ({ id: sid(c._id), title: c.title, body: c.body })) };
}
export async function createCanned(input: { title: string; body: string }, actor: Actor) {
  const c = await CannedReply.create({ ...input, createdBy: actor.userId });
  return { id: sid(c._id), title: c.title, body: c.body };
}
export async function deleteCanned(id: string) {
  const r = await CannedReply.deleteOne({ _id: id });
  if (!r.deletedCount) throw notFound();
  return { deleted: true };
}
