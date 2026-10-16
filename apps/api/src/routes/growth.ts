import rateLimit from 'express-rate-limit';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  analyticsBatchSchema,
  experimentSchema,
  introFeedbackSchema,
  metricsRangeSchema,
  storyDecisionSchema,
  storySubmitSchema,
  type Role,
} from '@marchmaker/shared';
import type { AppContext } from '../context';
import { asyncHandler } from '../middleware/asyncHandler';
import { authedUser, requirePermission } from '../middleware/auth';
import { validate } from '../middleware/validate';
import * as analytics from '../services/analytics';
import * as experiments from '../services/experiments';
import * as feedback from '../services/feedback';
import * as metrics from '../services/metrics';
import * as stories from '../services/stories';

export const GROWTH_PREFIXES = ['/feedback', '/stories'];

const id24 = z.string().regex(/^[a-f\d]{24}$/i);
const idParams = z.object({ id: id24 });
const noStore = (res: Response) => res.set('Cache-Control', 'no-store');
const actorOf = (req: Request) => {
  const a = authedUser(req);
  return { userId: a.userId, roles: a.roles as Role[] };
};

/** Open to visitors: events and experiment variants. Consent is enforced inside. */
export function publicGrowthRouter(ctx: AppContext): Router {
  const r = Router();
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: ctx.env.NODE_ENV === 'test' ? 10_000 : 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Slow down', requestId: req.id } });
    },
  });
  r.post(
    '/analytics/events',
    limiter,
    validate({ body: analyticsBatchSchema }),
    asyncHandler(async (req, res) => {
      res.status(202).json(await analytics.ingest(ctx, req.auth?.userId ?? null, req.body));
    }),
  );
  r.get(
    '/experiments',
    validate({ query: z.object({ anonId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/).optional() }) }),
    asyncHandler(async (req, res) => {
      const anonId = (req.query as { anonId?: string }).anonId;
      const subject = req.auth?.userId ?? anonId;
      res.set('Cache-Control', 'private, max-age=60').json({ assignments: subject ? await experiments.assignmentsFor(subject) : {} });
    }),
  );
  return r;
}

export function growthRouter(): Router {
  const r = Router();
  r.post(
    '/feedback/introductions',
    validate({ body: introFeedbackSchema }),
    asyncHandler(async (req, res) => {
      res.status(201).json(await feedback.submit(authedUser(req).userId, req.body));
    }),
  );
  r.post(
    '/introductions/:id/feedback',
    validate({ params: idParams }),
    (req, _res, next) => {
      req.body = { ...(req.body as object), introductionId: String(req.params.id) };
      next();
    },
    validate({ body: introFeedbackSchema }),
    asyncHandler(async (req, res) => {
      res.status(201).json(await feedback.submit(authedUser(req).userId, req.body));
    }),
  );
  r.get(
    '/feedback/pending',
    asyncHandler(async (req, res) => {
      noStore(res).json(await feedback.pending(authedUser(req).userId));
    }),
  );
  r.get(
    '/feedback/hints',
    asyncHandler(async (req, res) => {
      noStore(res).json(await feedback.hints(authedUser(req).userId));
    }),
  );
  r.get(
    '/stories/mine',
    asyncHandler(async (req, res) => {
      noStore(res).json(await stories.mine(authedUser(req).userId));
    }),
  );
  r.post(
    '/stories',
    validate({ body: storySubmitSchema }),
    asyncHandler(async (req, res) => {
      const input = { coupleNames: req.body.coupleNames, city: req.body.city, quote: req.body.quote };
      res.status(201).json(await stories.submit(authedUser(req).userId, input));
    }),
  );
  r.post(
    '/stories/:id/withdraw',
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      res.json(await stories.withdraw(authedUser(req).userId, String(req.params.id)));
    }),
  );
  return r;
}

export function adminGrowthRouter(): Router {
  const r = Router();
  r.get(
    '/metrics',
    requirePermission('metrics.view'),
    validate({ query: metricsRangeSchema }),
    asyncHandler(async (req, res) => {
      noStore(res).json(await metrics.overview(req.query as { from?: Date; to?: Date }));
    }),
  );
  r.get(
    '/reports/relevance',
    requirePermission('metrics.view'),
    validate({ query: z.object({ days: z.coerce.number().int().min(7).max(365).default(90) }) }),
    asyncHandler(async (req, res) => {
      noStore(res).json(await feedback.relevanceReport((req.query as unknown as { days: number }).days));
    }),
  );
  r.get(
    '/members/:id/feedback',
    requirePermission('member.view_full'),
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      noStore(res).json(await feedback.memberInsight(String(req.params.id)));
    }),
  );

  r.get(
    '/stories',
    requirePermission('content.manage'),
    asyncHandler(async (req, res) => {
      noStore(res).json(await stories.adminList(z.string().max(20).optional().parse(req.query.status)));
    }),
  );
  r.post(
    '/stories/:id/decision',
    requirePermission('content.manage'),
    validate({ params: idParams, body: storyDecisionSchema }),
    asyncHandler(async (req, res) => {
      res.json(await stories.decide(req, String(req.params.id), req.body, actorOf(req)));
    }),
  );

  r.get(
    '/experiments',
    requirePermission('flags.manage'),
    asyncHandler(async (_req, res) => {
      res.json(await experiments.adminList());
    }),
  );
  r.put(
    '/experiments',
    requirePermission('flags.manage'),
    validate({ body: experimentSchema }),
    asyncHandler(async (req, res) => {
      res.json(await experiments.upsert(req, req.body, actorOf(req)));
    }),
  );
  r.delete(
    '/experiments/:key',
    requirePermission('flags.manage'),
    validate({ params: z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/) }) }),
    asyncHandler(async (req, res) => {
      res.json(await experiments.remove(req, String(req.params.key), actorOf(req)));
    }),
  );
  return r;
}
