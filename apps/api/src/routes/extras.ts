import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { birthDetailsSchema, callOptInSchema, guideAudioRequestSchema, guideInputSchema, type Role } from '@marchmaker/shared';
import type { AppContext } from '../context';
import { requireFlag } from '../lib/flags';
import { asyncHandler } from '../middleware/asyncHandler';
import { authedUser, requirePermission } from '../middleware/auth';
import { validate } from '../middleware/validate';
import * as astrology from '../services/astrology';
import * as guides from '../services/guides';
import * as voice from '../services/voice';

export const EXTRAS_PREFIXES = ['/astrology', '/guide-progress'];

const id24 = z.string().regex(/^[a-f\d]{24}$/i);
const idParams = z.object({ id: id24 });
const slugParams = z.object({ slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(80) });
const noStore = (res: Response) => res.set('Cache-Control', 'no-store');
const actorOf = (req: Request) => {
  const a = authedUser(req);
  return { userId: a.userId, roles: a.roles as Role[] };
};

/** Guides are readable by visitors (free) and members (premium); entitlement is checked inside. */
export function publicExtrasRouter(ctx: AppContext): Router {
  const r = Router();
  r.get(
    '/guides/:slug',
    requireFlag('e_guides'),
    validate({ params: slugParams }),
    asyncHandler(async (req, res) => {
      res.set('Cache-Control', 'private, no-cache').json(await guides.read(String(req.params.slug), req.auth?.userId));
    }),
  );
  r.get(
    '/guides/:slug/audio',
    requireFlag('e_guides'),
    validate({ params: slugParams }),
    asyncHandler(async (req, res) => {
      noStore(res).json(await guides.audioUrl(ctx, String(req.params.slug), req.auth?.userId));
    }),
  );
  return r;
}

/** Voice calls and astrology, behind their feature flags. The v1 router guards these with requireAuth. */
export function extrasRouter(ctx: AppContext): Router {
  const r = Router();

  // ----- guide progress (resume position and playback speed)
  r.get(
    '/guide-progress/:slug',
    requireFlag('e_guides'),
    validate({ params: slugParams }),
    asyncHandler(async (req, res) => {
      noStore(res).json(await guides.getProgress(authedUser(req).userId, String(req.params.slug)));
    }),
  );
  r.put(
    '/guide-progress/:slug',
    requireFlag('e_guides'),
    validate({ params: slugParams, body: guides.guideProgressSchema }),
    asyncHandler(async (req, res) => {
      res.json(await guides.saveProgress(authedUser(req).userId, String(req.params.slug), req.body));
    }),
  );

  // ----- voice calls (per introduction)
  r.post(
    '/introductions/:id/voice/opt-in',
    requireFlag('voice_calls'),
    validate({ params: idParams, body: callOptInSchema }),
    asyncHandler(async (req, res) => {
      res.json(await voice.setOptIn(String(req.params.id), authedUser(req).userId, req.body.open));
    }),
  );
  r.post(
    '/introductions/:id/voice/call',
    requireFlag('voice_calls'),
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      res.status(202).json(await voice.startCall(ctx, String(req.params.id), authedUser(req).userId));
    }),
  );
  r.get(
    '/introductions/:id/voice/history',
    requireFlag('voice_calls'),
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      noStore(res).json(await voice.history(String(req.params.id), authedUser(req).userId));
    }),
  );

  // ----- astrology
  r.get(
    '/astrology',
    requireFlag('astrology'),
    asyncHandler(async (req, res) => {
      noStore(res).json(await astrology.status(ctx, authedUser(req).userId));
    }),
  );
  r.put(
    '/astrology/details',
    requireFlag('astrology'),
    validate({ body: birthDetailsSchema.extend({ shareWithMatches: z.boolean().default(false) }) }),
    asyncHandler(async (req, res) => {
      const { shareWithMatches, ...birth } = req.body;
      res.json(await astrology.saveDetails(ctx, authedUser(req).userId, birth, shareWithMatches));
    }),
  );
  r.delete(
    '/astrology',
    asyncHandler(async (req, res) => {
      // Deleting is always allowed, even if the feature has since been switched off.
      res.json(await astrology.erase(authedUser(req).userId));
    }),
  );
  r.get(
    '/astrology/report',
    requireFlag('astrology'),
    asyncHandler(async (req, res) => {
      noStore(res).json(await astrology.myReport(ctx, authedUser(req).userId));
    }),
  );
  r.get(
    '/introductions/:id/astrology',
    requireFlag('astrology'),
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      noStore(res).json(await astrology.matchReport(ctx, String(req.params.id), authedUser(req).userId));
    }),
  );
  return r;
}

/** Telephony status callbacks. Raw body so the signature covers the exact bytes. */
export function callsWebhookRouter(ctx: AppContext): Router {
  const r = Router();
  r.post(
    '/calls',
    express.raw({ type: '*/*', limit: '64kb' }),
    asyncHandler(async (req, res) => {
      if (!ctx.calls) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not configured', requestId: String(req.id) } });
        return;
      }
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
      ) as Record<string, string | undefined>;
      const event = ctx.calls.verifyWebhook(raw, headers);
      if (!event) {
        res.status(401).json({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature', requestId: String(req.id) } });
        return;
      }
      await voice.applyEvent(event);
      res.status(200).json({ received: true });
    }),
  );
  return r;
}

export function adminExtrasRouter(ctx: AppContext): Router {
  const r = Router();
  r.get(
    '/guides',
    requirePermission('content.manage'),
    asyncHandler(async (_req, res) => {
      noStore(res).json(await guides.adminList());
    }),
  );
  r.put(
    '/guides',
    requirePermission('content.manage'),
    validate({ body: guideInputSchema }),
    asyncHandler(async (req, res) => {
      res.json(await guides.upsert(req, req.body, actorOf(req)));
    }),
  );
  r.post(
    '/guides/:slug/audio',
    requirePermission('content.manage'),
    validate({ params: slugParams, body: guideAudioRequestSchema }),
    asyncHandler(async (req, res) => {
      res.status(201).json(await guides.requestAudioUpload(ctx, String(req.params.slug), req.body));
    }),
  );
  r.post(
    '/guides/:slug/audio/confirm',
    requirePermission('content.manage'),
    validate({ params: slugParams, body: z.object({ key: z.string().max(200), seconds: z.number().int().min(5).max(7200) }) }),
    asyncHandler(async (req, res) => {
      res.json(await guides.confirmAudio(ctx, req, String(req.params.slug), req.body.key, req.body.seconds, actorOf(req)));
    }),
  );
  return r;
}
