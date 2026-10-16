import { Router, type Request } from 'express';
import { z } from 'zod';
import { LEGAL_TYPES, type LegalType, type Role } from '@marchmaker/shared';
import type { AppContext } from '../context';
import { asyncHandler } from '../middleware/asyncHandler';
import { authedUser, requirePermission } from '../middleware/auth';
import { validate } from '../middleware/validate';
import * as svc from '../services/adminContent';

const id24 = z.string().regex(/^[a-f\d]{24}$/i);
const actorOf = (req: Request) => {
  const a = authedUser(req);
  return { userId: a.userId, roles: a.roles as Role[] };
};

/** Public FAQ list (published entries only). */
export function publicFaqRouter(): Router {
  const r = Router();
  r.get(
    '/faqs',
    asyncHandler(async (_req, res) => {
      res.set('Cache-Control', 'public, max-age=300').json(await svc.publicFaqs());
    }),
  );
  return r;
}

/** Legal versions, FAQ CMS, introductions monitor, saved filters and member-detail tabs. */
export function adminContentRouter(_ctx: AppContext): Router {
  const r = Router();

  // ----- legal documents
  r.get('/legal', requirePermission('legal.manage'), asyncHandler(async (_req, res) => res.json(await svc.listLegal())));
  r.get(
    '/legal/:type/:version',
    requirePermission('legal.manage'),
    validate({ params: z.object({ type: z.enum(LEGAL_TYPES as unknown as [LegalType, ...LegalType[]]), version: z.string().max(10) }) }),
    asyncHandler(async (req, res) => res.json(await svc.legalVersion(req.params.type as LegalType, String(req.params.version)))),
  );
  r.post(
    '/legal',
    requirePermission('legal.manage'),
    validate({ body: svc.legalVersionSchema }),
    asyncHandler(async (req, res) => res.status(201).json(await svc.publishLegal(req, req.body, actorOf(req)))),
  );

  // ----- FAQ
  r.get('/faqs', requirePermission('content.manage'), asyncHandler(async (_req, res) => res.json(await svc.adminFaqs())));
  r.post(
    '/faqs',
    requirePermission('content.manage'),
    validate({ body: svc.faqSchema }),
    asyncHandler(async (req, res) => res.status(201).json(await svc.saveFaq(req, null, req.body, actorOf(req)))),
  );
  r.put(
    '/faqs/:id',
    requirePermission('content.manage'),
    validate({ params: z.object({ id: id24 }), body: svc.faqSchema }),
    asyncHandler(async (req, res) => res.json(await svc.saveFaq(req, String(req.params.id), req.body, actorOf(req)))),
  );
  r.delete(
    '/faqs/:id',
    requirePermission('content.manage'),
    validate({ params: z.object({ id: id24 }) }),
    asyncHandler(async (req, res) => res.json(await svc.deleteFaq(req, String(req.params.id), actorOf(req)))),
  );

  // ----- introductions monitor
  r.get(
    '/introductions',
    requirePermission('introduction.view'),
    validate({ query: z.object({ state: z.string().max(30).optional(), attention: z.enum(['true', 'false']).optional() }) }),
    asyncHandler(async (req, res) => {
      const q = req.query as { state?: string; attention?: string };
      res.set('Cache-Control', 'no-store').json(await svc.introductionsMonitor({ state: q.state, attention: q.attention === 'true' }));
    }),
  );

  // ----- saved filters (own only)
  r.get('/saved-filters', requirePermission('member.search'), asyncHandler(async (req, res) => res.json(await svc.listFilters(actorOf(req).userId))));
  r.post(
    '/saved-filters',
    requirePermission('member.search'),
    validate({ body: svc.savedFilterSchema }),
    asyncHandler(async (req, res) => res.status(201).json(await svc.saveFilter(actorOf(req).userId, req.body))),
  );
  r.delete(
    '/saved-filters/:id',
    requirePermission('member.search'),
    validate({ params: z.object({ id: id24 }) }),
    asyncHandler(async (req, res) => res.json(await svc.deleteFilter(actorOf(req).userId, String(req.params.id)))),
  );

  // ----- member-detail tabs
  const memberParam = validate({ params: z.object({ id: id24 }) });
  r.get('/members/:id/finance', requirePermission('payment.view'), memberParam, asyncHandler(async (req, res) => res.set('Cache-Control', 'no-store').json(await svc.memberFinance(String(req.params.id)))));
  r.get('/members/:id/ledgers', requirePermission('payment.view'), memberParam, asyncHandler(async (req, res) => res.set('Cache-Control', 'no-store').json(await svc.memberLedgers(String(req.params.id)))));
  r.get('/members/:id/safety', requirePermission('moderation.view'), memberParam, asyncHandler(async (req, res) => res.set('Cache-Control', 'no-store').json(await svc.memberSafety(String(req.params.id)))));
  r.get('/members/:id/tickets', requirePermission('support.view'), memberParam, asyncHandler(async (req, res) => res.set('Cache-Control', 'no-store').json(await svc.memberTickets(String(req.params.id)))));

  r.get('/members/:id/introductions', requirePermission('introduction.view'), memberParam, asyncHandler(async (req, res) => res.set('Cache-Control', 'no-store').json(await svc.memberIntroductions(String(req.params.id)))));
  r.get('/members/:id/messages', requirePermission('messages.view_reported'), memberParam, asyncHandler(async (req, res) => res.set('Cache-Control', 'no-store').json(await svc.memberMessages(req, String(req.params.id), actorOf(req)))));

  return r;
}
