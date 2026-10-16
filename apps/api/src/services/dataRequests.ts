import type { Request } from 'express';
import type { Role } from '@marchmaker/shared';
import type { AppContext } from '../context';
import { audit, emit } from '../lib/audit';
import { AppError, conflict, notFound } from '../lib/errors';
import { DataRequest } from '../models/auth';
import { User } from '../models/core';
import { restoreAccount } from './account';
import { sendNotice } from './notify';

interface Actor {
  userId: string;
  roles: Role[];
}
const sid = (v: unknown) => String(v);

export async function list(status?: string) {
  const q: Record<string, unknown> = status && status !== 'all' ? { status } : { status: 'awaiting_approval' };
  const rows = await DataRequest.find(q).sort({ createdAt: 1 }).limit(200).lean();
  const users = await User.find({ _id: { $in: rows.map((r) => r.userId) } }).select('firstName email status deletionScheduledFor').lean();
  const byId = new Map(users.map((u) => [sid(u._id), u]));
  return {
    items: rows.map((r) => ({
      id: sid(r._id),
      kind: r.kind,
      status: r.status,
      requestedAt: r.createdAt,
      dueAt: r.expiresAt ?? null,
      decisionNote: r.decisionNote ?? null,
      member: { id: sid(r.userId), name: byId.get(sid(r.userId))?.firstName ?? 'Member', email: byId.get(sid(r.userId))?.email ?? null },
    })),
  };
}

/**
 * A super admin approves or declines an export or deletion. Approving an export runs it at once; approving a
 * deletion lets the normal purge proceed once the grace period has ended. Declining a deletion restores the account.
 */
export async function decide(ctx: AppContext, req: Request, id: string, input: { decision: 'approve' | 'reject'; note: string }, actor: Actor) {
  const r = await DataRequest.findById(id);
  if (!r) throw notFound();
  if (r.status !== 'awaiting_approval') throw conflict('This request is not waiting for a decision');
  if (sid(r.userId) === actor.userId) throw new AppError(403, 'FORBIDDEN', 'You cannot decide a request about your own account');
  const user = await User.findById(r.userId).select('email firstName');

  r.approvedBy = actor.userId as never;
  r.decidedAt = new Date();
  r.decisionNote = input.note;
  if (input.decision === 'approve') {
    r.status = 'pending';
    await r.save();
    if (r.kind === 'export') await emit('account.export_requested', { userId: sid(r.userId), dataRequestId: sid(r._id) });
  } else {
    r.status = 'rejected';
    await r.save();
    if (r.kind === 'deletion') await restoreAccount(sid(r.userId)).catch(() => undefined);
    if (user?.email) {
      await sendNotice(ctx, user.email, {
        subject: r.kind === 'export' ? 'About your data request' : 'About your deletion request',
        preview: 'An update on your request',
        heading: 'An update on your request',
        paragraphs: [
          input.note,
          r.kind === 'deletion' ? 'Your account has been restored and nothing has been deleted.' : 'You can contact our Grievance Officer if you would like to discuss this.',
        ],
      });
    }
  }
  await audit(req, {
    action: `data_request.${input.decision}`,
    actorId: actor.userId,
    actorRoles: actor.roles,
    subjectType: 'data_request',
    subjectId: id,
    after: { kind: r.kind, note: input.note },
  });
  return { id, status: r.status };
}
