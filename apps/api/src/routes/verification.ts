import express, { Router } from 'express';
import { z } from 'zod';
import { decisionSchema, evidenceUploadSchema, verificationSubmitSchema } from '@marchmaker/shared';
import type { AppContext } from '../context';
import { asyncHandler } from '../middleware/asyncHandler';
import { authedUser, requireAuth, requirePermission } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { WebhookEvent } from '../models/verification';
import { emit } from '../lib/audit';
import * as member from '../services/verification';
import * as review from '../services/verificationReview';

const idParams = z.object({ id: z.string().regex(/^[a-f\d]{24}$/i) });

/** Member endpoints. Mounted at /verification behind requireAuth. */
export function verificationRouter(ctx: AppContext): Router {
  const r = Router();
  r.use(requireAuth);

  r.get(
    '/status',
    asyncHandler(async (req, res) => {
      res.set('Cache-Control', 'no-store').json(await member.getStatus(ctx, authedUser(req).userId));
    }),
  );
  r.post(
    '/upload-url',
    validate({ body: evidenceUploadSchema }),
    asyncHandler(async (req, res) => {
      res.status(201).json(await member.createEvidenceUpload(ctx, authedUser(req).userId, req.body));
    }),
  );
  r.post(
    '/submit',
    validate({ body: verificationSubmitSchema }),
    asyncHandler(async (req, res) => {
      res.json(await member.submitManual(ctx, authedUser(req).userId, req.body));
    }),
  );
  r.post(
    '/kyc/session',
    asyncHandler(async (req, res) => {
      res.status(201).json(await member.startKyc(ctx, authedUser(req).userId));
    }),
  );
  return r;
}

/** Staff endpoints. Mounted at /admin/verification. Evidence access needs a TOTP-verified session. */
export function adminVerificationRouter(ctx: AppContext): Router {
  const r = Router();

  r.get(
    '/',
    requirePermission('verification.view_evidence'),
    asyncHandler(async (req, res) => {
      const status = z.enum(['pending', 'in_review', 'all']).catch('all').parse(req.query.status);
      res.set('Cache-Control', 'no-store').json({ items: await review.queue(status) });
    }),
  );
  r.get(
    '/:id',
    requirePermission('verification.view_evidence'),
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      const a = authedUser(req);
      res.set('Cache-Control', 'no-store').json(await review.detail(ctx, req, String(req.params.id), a.userId, a.roles));
    }),
  );
  r.post(
    '/:id/decision',
    requirePermission('verification.decide'),
    validate({ params: idParams, body: decisionSchema }),
    asyncHandler(async (req, res) => {
      const a = authedUser(req);
      res.json(await review.decide(ctx, req, String(req.params.id), a.userId, a.roles, req.body));
    }),
  );
  return r;
}

/**
 * Provider callbacks. Mounted before the JSON parser so the signature is checked against the
 * exact bytes received. The event is stored first and processed asynchronously.
 */
export function kycWebhookRouter(ctx: AppContext): Router {
  const r = Router();
  r.post(
    '/kyc',
    express.raw({ type: '*/*', limit: '256kb' }),
    asyncHandler(async (req, res) => {
      if (!ctx.kyc) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not configured', requestId: String(req.id) } });
        return;
      }
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
      ) as Record<string, string | undefined>;
      const event = ctx.kyc.verifyWebhook(raw, headers);
      if (!event) {
        res.status(401).json({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature', requestId: String(req.id) } });
        return;
      }
      try {
        await WebhookEvent.create({
          provider: ctx.kyc.name,
          eventId: event.eventId,
          payload: event,
          signatureValid: true,
        });
        await emit('kyc.result_received', { eventId: event.eventId });
      } catch (err) {
        // Duplicate delivery: already stored, acknowledge so the provider stops retrying.
        if ((err as { code?: number }).code !== 11000) throw err;
      }
      res.status(200).json({ received: true });
    }),
  );
  return r;
}
