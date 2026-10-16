import rateLimit from 'express-rate-limit';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  appealDecisionSchema,
  appealSchema,
  cannedReplySchema,
  caseActionSchema,
  ticketCreateSchema,
  ticketReplySchema,
  ticketUpdateSchema,
  type Role,
} from '@marchmaker/shared';
import type { AppContext } from '../context';
import { asyncHandler } from '../middleware/asyncHandler';
import { authedUser, requirePermission } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { User } from '../models/core';
import * as moderation from '../services/moderation';
import * as support from '../services/support';

export const SUPPORT_PREFIXES = ['/support'];

const id24 = z.string().regex(/^[a-f\d]{24}$/i);
const idParams = z.object({ id: id24 });

const actorOf = (req: Request) => {
  const a = authedUser(req);
  return { userId: a.userId, roles: a.roles as Role[], permissions: a.permissions as readonly string[] };
};

/** Member help: tickets and messages from the safety team. Guarded by requireAuth in the v1 router. */
export function supportRouter(ctx: AppContext): Router {
  const r = Router();
  const noStore = (res: Response) => res.set('Cache-Control', 'no-store');

  r.get(
    '/support/tickets',
    asyncHandler(async (req, res) => {
      noStore(res).json(await support.listMine(authedUser(req).userId));
    }),
  );
  r.post(
    '/support/tickets',
    validate({ body: ticketCreateSchema }),
    asyncHandler(async (req, res) => {
      const u = authedUser(req);
      const user = await User.findById(u.userId).select('email firstName').lean();
      const t = await support.create(ctx, {
        userId: u.userId,
        email: user?.email ?? `member-${u.userId}@no-email.invalid`,
        name: user?.firstName,
        ...req.body,
      });
      res.status(201).json(t);
    }),
  );
  r.get(
    '/support/tickets/:id',
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      noStore(res).json(await support.getMine(authedUser(req).userId, String(req.params.id)));
    }),
  );
  r.post(
    '/support/tickets/:id/reply',
    validate({ params: idParams, body: ticketReplySchema }),
    asyncHandler(async (req, res) => {
      res.status(201).json(await support.replyMine(authedUser(req).userId, String(req.params.id), req.body.body));
    }),
  );
  r.post(
    '/support/tickets/:id/close',
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      res.json(await support.closeMine(authedUser(req).userId, String(req.params.id)));
    }),
  );
  r.get(
    '/support/warnings',
    asyncHandler(async (req, res) => {
      noStore(res).json({ items: await moderation.warningsFor(authedUser(req).userId) });
    }),
  );
  return r;
}

/** Appeals are public because a suspended member cannot sign in. */
export function appealsRouter(ctx: AppContext): Router {
  const r = Router();
  const limiter = rateLimit({
    windowMs: 60 * 60_000,
    limit: ctx.env.NODE_ENV === 'test' ? 1000 : 3,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please try again later.', requestId: req.id } });
    },
  });
  r.post(
    '/appeals',
    limiter,
    validate({ body: appealSchema }),
    asyncHandler(async (req, res) => {
      if (req.body.website) {
        res.status(202).json({ received: true });
        return;
      }
      res.status(202).json(await moderation.submitAppeal(ctx, req.body.email, req.body.message));
    }),
  );
  return r;
}

/** Moderation, support inbox and appeals for staff. */
export function adminSafetyRouter(ctx: AppContext): Router {
  const r = Router();
  const noStore = (res: Response) => res.set('Cache-Control', 'no-store');

  // ----- moderation
  r.get(
    '/moderation',
    requirePermission('moderation.view'),
    asyncHandler(async (req, res) => {
      const q = z
        .object({ status: z.string().max(20).optional(), severity: z.enum(['low', 'medium', 'high', 'critical']).optional(), mine: z.enum(['true']).optional() })
        .parse(req.query);
      noStore(res).json(await moderation.queue({ status: q.status, severity: q.severity, mine: q.mine ? authedUser(req).userId : undefined }));
    }),
  );
  r.get(
    '/moderation/:id',
    requirePermission('moderation.view'),
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      noStore(res).json(await moderation.detail(ctx, req, String(req.params.id), actorOf(req)));
    }),
  );
  r.post(
    '/moderation/:id/claim',
    requirePermission('moderation.act'),
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      res.json(await moderation.claim(req, String(req.params.id), actorOf(req)));
    }),
  );
  r.post(
    '/moderation/:id/action',
    requirePermission('moderation.act'),
    validate({ params: idParams, body: caseActionSchema }),
    asyncHandler(async (req, res) => {
      res.json(await moderation.act(ctx, req, String(req.params.id), req.body, actorOf(req)));
    }),
  );

  // ----- appeals
  r.get(
    '/appeals',
    requirePermission('moderation.view'),
    asyncHandler(async (req, res) => {
      noStore(res).json(await moderation.listAppeals(z.string().max(20).optional().parse(req.query.status)));
    }),
  );
  r.post(
    '/appeals/:id/decision',
    requirePermission('moderation.act'),
    validate({ params: idParams, body: appealDecisionSchema }),
    asyncHandler(async (req, res) => {
      res.json(await moderation.decideAppeal(ctx, req, String(req.params.id), req.body, actorOf(req)));
    }),
  );

  // ----- support
  r.get(
    '/support/tickets',
    requirePermission('support.view'),
    asyncHandler(async (req, res) => {
      const q = z
        .object({
          status: z.string().max(20).optional(),
          assignee: z.enum(['me', 'unassigned']).optional(),
          overdue: z.enum(['true']).optional(),
          q: z.string().max(100).optional(),
          category: z.string().max(20).optional(),
        })
        .parse(req.query);
      noStore(res).json(await support.listStaff(actorOf(req), { ...q, overdue: Boolean(q.overdue) }));
    }),
  );
  r.get(
    '/support/tickets/:id',
    requirePermission('support.view'),
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      noStore(res).json(await support.getStaff(String(req.params.id)));
    }),
  );
  r.post(
    '/support/tickets/:id/reply',
    requirePermission('support.reply'),
    validate({ params: idParams, body: ticketReplySchema }),
    asyncHandler(async (req, res) => {
      res.status(201).json(await support.replyStaff(ctx, req, String(req.params.id), req.body.body, actorOf(req)));
    }),
  );
  r.post(
    '/support/tickets/:id/note',
    requirePermission('support.reply'),
    validate({ params: idParams, body: ticketReplySchema }),
    asyncHandler(async (req, res) => {
      res.status(201).json(await support.addNote(req, String(req.params.id), req.body.body, actorOf(req)));
    }),
  );
  r.patch(
    '/support/tickets/:id',
    requirePermission('support.reply'),
    validate({ params: idParams, body: ticketUpdateSchema }),
    asyncHandler(async (req, res) => {
      res.json(await support.update(req, String(req.params.id), req.body, actorOf(req)));
    }),
  );
  r.get(
    '/support/canned',
    requirePermission('support.view'),
    asyncHandler(async (_req, res) => {
      res.json(await support.listCanned());
    }),
  );
  r.post(
    '/support/canned',
    requirePermission('support.reply'),
    validate({ body: cannedReplySchema }),
    asyncHandler(async (req, res) => {
      res.status(201).json(await support.createCanned(req.body, actorOf(req)));
    }),
  );
  r.delete(
    '/support/canned/:id',
    requirePermission('support.reply'),
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      res.json(await support.deleteCanned(String(req.params.id)));
    }),
  );
  return r;
}
