import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Role } from '@marchmaker/shared';
import type { AppContext } from '../context';
import { asyncHandler } from '../middleware/asyncHandler';
import { authedUser, requirePermission } from '../middleware/auth';
import { validate } from '../middleware/validate';
import * as dataRequests from '../services/dataRequests';
import * as jobs from '../services/jobs';

const id24 = z.string().regex(/^[a-f\d]{24}$/i);
const queueParam = z.enum(['events', 'dead-letter']);
const actorOf = (req: Request) => {
  const a = authedUser(req);
  return { userId: a.userId, roles: a.roles as Role[] };
};

/** Job queues and data-request approvals. */
export function adminSystemRouter(ctx: AppContext): Router {
  const r = Router();

  // ----- job queues and the outbox
  r.get(
    '/jobs',
    requirePermission('jobs.manage'),
    asyncHandler(async (_req, res) => {
      res.set('Cache-Control', 'no-store').json(await jobs.overview(ctx));
    }),
  );
  r.get(
    '/jobs/failed',
    requirePermission('jobs.manage'),
    validate({ query: z.object({ queue: queueParam.default('events'), limit: z.coerce.number().int().min(1).max(100).default(50) }) }),
    asyncHandler(async (req, res) => {
      const q = req.query as unknown as { queue: 'events' | 'dead-letter'; limit: number };
      res.set('Cache-Control', 'no-store').json({ items: await jobs.failedJobs(ctx, q.queue, q.limit) });
    }),
  );
  r.post(
    '/jobs/:queue/:id/retry',
    requirePermission('jobs.manage'),
    validate({ params: z.object({ queue: queueParam, id: z.string().max(80) }) }),
    asyncHandler(async (req, res) => {
      res.json(await jobs.retryJob(ctx, req, req.params.queue as 'events', String(req.params.id), actorOf(req)));
    }),
  );
  r.delete(
    '/jobs/:queue/:id',
    requirePermission('jobs.manage'),
    validate({ params: z.object({ queue: queueParam, id: z.string().max(80) }) }),
    asyncHandler(async (req, res) => {
      res.json(await jobs.discardJob(ctx, req, req.params.queue as 'events', String(req.params.id), actorOf(req)));
    }),
  );
  r.get(
    '/outbox/failed',
    requirePermission('jobs.manage'),
    asyncHandler(async (_req, res) => {
      res.set('Cache-Control', 'no-store').json({ items: await jobs.failedOutbox() });
    }),
  );
  r.post(
    '/outbox/:id/retry',
    requirePermission('jobs.manage'),
    validate({ params: z.object({ id: id24 }) }),
    asyncHandler(async (req, res) => {
      res.json(await jobs.retryOutbox(req, String(req.params.id), actorOf(req)));
    }),
  );

  // ----- data requests
  r.get(
    '/data-requests',
    requirePermission('data_requests.approve'),
    asyncHandler(async (req, res) => {
      res.set('Cache-Control', 'no-store').json(await dataRequests.list(z.string().max(30).optional().parse(req.query.status)));
    }),
  );
  r.post(
    '/data-requests/:id/decision',
    requirePermission('data_requests.approve'),
    validate({
      params: z.object({ id: id24 }),
      body: z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().min(5).max(500) }),
    }),
    asyncHandler(async (req, res) => {
      res.json(await dataRequests.decide(ctx, req, String(req.params.id), req.body, actorOf(req)));
    }),
  );
  return r;
}
