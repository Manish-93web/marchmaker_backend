import type { Request } from 'express';
import type { Role } from '@marchmaker/shared';
import type { AppContext } from '../context';
import { audit } from '../lib/audit';
import { AppError, notFound } from '../lib/errors';
import type { QueueKey } from '../lib/jobsAdmin';
import { Outbox } from '../models/core';
import { breakerStates } from '../lib/breaker';

interface Actor {
  userId: string;
  roles: Role[];
}

function queues(ctx: AppContext) {
  if (!ctx.jobs) throw new AppError(503, 'QUEUES_UNAVAILABLE', 'The job queue is not connected (REDIS_URL is not set)');
  return ctx.jobs;
}

export async function overview(ctx: AppContext) {
  const [pending, failed, oldest] = await Promise.all([
    Outbox.countDocuments({ status: 'pending' }),
    Outbox.countDocuments({ status: 'failed' }),
    Outbox.findOne({ status: 'pending' }).sort({ createdAt: 1 }).select('createdAt').lean(),
  ]);
  let counts = null;
  try {
    counts = ctx.jobs ? await ctx.jobs.counts() : null;
  } catch (err) {
    ctx.log.warn({ err }, 'could not read queue counts');
  }
  return {
    queuesAvailable: Boolean(ctx.jobs) && counts !== null,
    queues: counts,
    /** Circuit state of each outside provider; "open" means calls are paused after repeated failures. */
    circuits: breakerStates(),
    outbox: { pending, failed, oldestPendingAgeSec: oldest ? Math.round((Date.now() - oldest.createdAt.getTime()) / 1000) : 0 },
  };
}

export const failedJobs = (ctx: AppContext, queue: QueueKey, limit = 50) => queues(ctx).failed(queue, limit);

export async function retryJob(ctx: AppContext, req: Request, queue: QueueKey, id: string, actor: Actor) {
  if (!(await queues(ctx).retry(queue, id))) throw notFound('That job no longer exists');
  await audit(req, { action: 'job.retried', actorId: actor.userId, actorRoles: actor.roles, subjectType: 'job', subjectId: `${queue}:${id}` });
  return { retried: true };
}

export async function discardJob(ctx: AppContext, req: Request, queue: QueueKey, id: string, actor: Actor) {
  if (!(await queues(ctx).remove(queue, id))) throw notFound('That job no longer exists');
  await audit(req, { action: 'job.discarded', actorId: actor.userId, actorRoles: actor.roles, subjectType: 'job', subjectId: `${queue}:${id}` });
  return { discarded: true };
}

export async function failedOutbox() {
  const rows = await Outbox.find({ status: 'failed' }).sort({ updatedAt: -1 }).limit(100).lean();
  return rows.map((o) => ({ id: String(o._id), eventType: o.eventType, attempts: o.attempts, lastError: o.lastError ?? null, at: o.updatedAt }));
}

/** Puts a failed outbox event back in line; the relay picks it up on its next pass. */
export async function retryOutbox(req: Request, id: string, actor: Actor) {
  const r = await Outbox.updateOne({ _id: id, status: 'failed' }, { $set: { status: 'pending', attempts: 0, nextRunAt: new Date() }, $unset: { lastError: 1 } });
  if (!r.matchedCount) throw notFound('That event is not in a failed state');
  await audit(req, { action: 'outbox.retried', actorId: actor.userId, actorRoles: actor.roles, subjectType: 'outbox', subjectId: id });
  return { retried: true };
}
