import { Types } from 'mongoose';
import { REPORT_SEVERITY, reportDueAt, type ReportCategory } from '@marchmaker/shared';
import { withTransaction } from '../db/connection';
import { audit, emit } from '../lib/audit';
import { AppError, notFound } from '../lib/errors';
import { Block, Introduction } from '../models/matching';
import { Message, MessageThread, Report } from '../models/social';
import * as credits from './credits';
import type { AppContext } from '../context';
import * as attachments from './attachments';

const sid = (v: unknown) => String(v);
const OPEN = ['released', 'viewed', 'accepted_by_one'];

async function resolveTarget(me: string, input: { userId?: string; introductionId?: string }) {
  if (input.introductionId) {
    if (!Types.ObjectId.isValid(input.introductionId)) throw notFound('Introduction not found');
    const intro = await Introduction.findOne({ _id: input.introductionId, 'members.userId': me });
    if (!intro) throw notFound('Introduction not found');
    const other = intro.members.find((m) => sid(m.userId) !== me)!;
    return { targetId: sid(other.userId), introId: sid(intro._id) };
  }
  if (!input.userId || input.userId === me) throw new AppError(422, 'VALIDATION_ERROR', 'Choose another member');
  return { targetId: input.userId, introId: undefined };
}

/** Instant, mutual and quiet: the pair disappears for each other and the conversation ends. */
export async function block(me: string, input: { userId?: string; introductionId?: string }) {
  const { targetId } = await resolveTarget(me, input);
  try {
    await Block.create({ blockerId: me, blockedId: targetId });
  } catch (err) {
    // Already blocked: still make sure the effects below are applied.
    if ((err as { code?: number }).code !== 11000) throw err;
  }

  const pairKey = [me, targetId].sort().join(':');
  await withTransaction(async (session) => {
    const intro = await Introduction.findOne({ pairKey }).session(session);
    if (intro && OPEN.includes(intro.state)) {
      const holding = intro.members.filter((m) => m.status === 'accepted').map((m) => m.userId);
      intro.state = 'declined';
      intro.closedReason = 'blocked';
      for (const uid of holding) await credits.release(uid, intro._id, 'introduction ended', session);
      await intro.save({ session });
    }
    if (intro) {
      await MessageThread.updateOne({ introductionId: intro._id }, { $set: { status: 'closed', closedReason: 'blocked' } }, { session });
    }
  });
  await emit('member.blocked', { blockerId: me, blockedId: targetId });
  return { blocked: true };
}

export async function unblock(me: string, userId: string) {
  const res = await Block.deleteOne({ blockerId: me, blockedId: userId });
  return { removed: res.deletedCount === 1 };
}

export async function listBlocks(me: string) {
  const rows = await Block.find({ blockerId: me }).lean();
  return rows.map((b) => ({ userId: sid(b.blockedId), at: b.createdAt }));
}

export async function report(
  ctx: AppContext,
  me: string,
  input: { category: ReportCategory; userId?: string; introductionId?: string; details?: string; evidence?: string[] },
) {
  const { targetId, introId } = await resolveTarget(me, input);
  const severity = REPORT_SEVERITY[input.category];
  const evidence = input.evidence?.length ? await attachments.confirm(ctx, me, 'report', input.evidence) : [];

  // Keep a frozen copy of the recent conversation as evidence.
  let transcript: { at: Date; senderId: string; body: string }[] = [];
  if (introId) {
    const t = await MessageThread.findOne({ introductionId: introId }).lean();
    if (t) {
      const msgs = await Message.find({ threadId: t._id }).sort({ _id: -1 }).limit(30).lean();
      transcript = msgs.reverse().map((m) => ({ at: m.createdAt, senderId: sid(m.senderId), body: m.body }));
    }
  }
  const r = await Report.create({
    reporterId: me,
    reportedId: targetId,
    introductionId: introId,
    category: input.category,
    severity,
    details: input.details,
    transcript,
    evidence,
    slaDueAt: reportDueAt(severity, new Date()),
  });
  await audit(undefined, {
    action: 'report.created',
    actorId: me,
    subjectType: 'user',
    subjectId: targetId,
    after: { category: input.category, severity },
  });
  // Safety threats alert the on-call team straight away, not through the normal queue.
  if (severity === 'critical') await emit('safety.critical_report', { reportId: sid(r._id), category: input.category });
  await emit('report.created', { reportId: sid(r._id), severity });
  return { id: sid(r._id), status: 'open' as const, severity };
}

export async function myReports(me: string) {
  const rows = await Report.find({ reporterId: me }).sort({ createdAt: -1 }).limit(50).lean();
  return rows.map((r) => ({ id: sid(r._id), category: r.category, status: r.status, createdAt: r.createdAt }));
}
