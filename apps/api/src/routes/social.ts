import rateLimit from 'express-rate-limit';
import { Router } from 'express';
import { z } from 'zod';
import { acceptSchema, blockSchema, declineSchema, messageSchema, reportSchema } from '@marchmaker/shared';
import type { AppContext } from '../context';
import { asyncHandler } from '../middleware/asyncHandler';
import { authedUser } from '../middleware/auth';
import { idempotent } from '../middleware/idempotency';
import { validate } from '../middleware/validate';
import * as credits from '../services/credits';
import * as intros from '../services/introductions';
import * as messaging from '../services/messaging';
import * as safety from '../services/safety';

const idParams = z.object({ id: z.string().regex(/^[a-f\d]{24}$/i) });

/**
 * Introductions, messaging, blocking, reporting and the member's credit ledger. The v1 router
 * guards SOCIAL_PREFIXES with requireAuth, so unknown paths still answer 404 rather than 401.
 */
export function socialRouter(ctx: AppContext): Router {
  const r = Router();

  // ----- introductions
  r.get(
    '/introductions',
    asyncHandler(async (req, res) => {
      res.set('Cache-Control', 'no-store').json({ items: await intros.list(ctx, authedUser(req).userId) });
    }),
  );
  r.get(
    '/introductions/:id',
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      res.set('Cache-Control', 'no-store').json(await intros.open(ctx, String(req.params.id), authedUser(req).userId));
    }),
  );
  r.post(
    '/introductions/:id/accept',
    validate({ params: idParams, body: acceptSchema }),
    idempotent('accept'),
    asyncHandler(async (req, res) => {
      res.json(await intros.accept(ctx, String(req.params.id), authedUser(req).userId, req.body.firstNote));
    }),
  );
  r.post(
    '/introductions/:id/decline',
    validate({ params: idParams, body: declineSchema }),
    idempotent('decline', { required: false }),
    asyncHandler(async (req, res) => {
      res.json(await intros.decline(ctx, String(req.params.id), authedUser(req).userId, req.body));
    }),
  );
  r.post(
    '/introductions/:id/share-contact',
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      res.json(await intros.shareContact(ctx, String(req.params.id), authedUser(req).userId));
    }),
  );
  r.get(
    '/introductions/:id/contact',
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      res.set('Cache-Control', 'no-store').json(await intros.contactDetails(ctx, String(req.params.id), authedUser(req).userId));
    }),
  );
  r.get(
    '/introductions/:id/photos',
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      res.set('Cache-Control', 'no-store').json(await intros.revealedPhotos(ctx, String(req.params.id), authedUser(req).userId));
    }),
  );

  // ----- messages (text only; contact details need an explicit mutual share)
  const sendLimiter = rateLimit({
    windowMs: 60_000,
    limit: ctx.env.NODE_ENV === 'test' ? 10_000 : 30,
    keyGenerator: (req) => req.auth?.userId ?? 'anon',
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    validate: { keyGeneratorIpFallback: false },
    handler: (req, res) => {
      res.status(429).json({
        error: { code: 'RATE_LIMITED', message: 'You are sending messages very quickly. Please slow down.', requestId: String(req.id) },
      });
    },
  });
  r.get(
    '/threads',
    asyncHandler(async (req, res) => {
      res.set('Cache-Control', 'no-store').json({ items: await messaging.listThreads(authedUser(req).userId) });
    }),
  );
  r.get(
    '/threads/:id/messages',
    validate({ params: idParams, query: z.object({ before: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }) }),
    asyncHandler(async (req, res) => {
      const q = req.query as unknown as { before?: string; limit: number };
      res.set('Cache-Control', 'no-store').json(await messaging.messages(String(req.params.id), authedUser(req).userId, q.before, q.limit));
    }),
  );
  r.post(
    '/threads/:id/messages',
    sendLimiter,
    validate({ params: idParams, body: messageSchema.extend({ clientId: z.string().max(60).optional() }) }),
    asyncHandler(async (req, res) => {
      res.status(201).json(await messaging.send(String(req.params.id), authedUser(req).userId, req.body.body, req.body.clientId));
    }),
  );
  r.post(
    '/threads/:id/read',
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      await messaging.markRead(String(req.params.id), authedUser(req).userId);
      res.json({ ok: true });
    }),
  );

  // ----- safety
  r.post(
    '/blocks',
    validate({ body: blockSchema }),
    asyncHandler(async (req, res) => {
      res.status(201).json(await safety.block(authedUser(req).userId, req.body));
    }),
  );
  r.get(
    '/blocks',
    asyncHandler(async (req, res) => {
      res.json({ items: await safety.listBlocks(authedUser(req).userId) });
    }),
  );
  r.delete(
    '/blocks/:userId',
    validate({ params: z.object({ userId: z.string().regex(/^[a-f\d]{24}$/i) }) }),
    asyncHandler(async (req, res) => {
      res.json(await safety.unblock(authedUser(req).userId, String(req.params.userId)));
    }),
  );
  r.post(
    '/reports',
    validate({ body: reportSchema }),
    asyncHandler(async (req, res) => {
      res.status(201).json(await safety.report(authedUser(req).userId, req.body));
    }),
  );
  r.get(
    '/reports/mine',
    asyncHandler(async (req, res) => {
      res.json({ items: await safety.myReports(authedUser(req).userId) });
    }),
  );

  // ----- credits (purchases and subscriptions arrive in Phase 10)
  r.get(
    '/billing/credits/ledger',
    asyncHandler(async (req, res) => {
      res.set('Cache-Control', 'no-store').json({ items: await credits.ledgerFor(authedUser(req).userId) });
    }),
  );
  return r;
}

export const SOCIAL_PREFIXES = ['/introductions', '/threads', '/blocks', '/reports', '/billing'];
