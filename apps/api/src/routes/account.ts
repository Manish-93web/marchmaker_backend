import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import {
  accountPatchSchema,
  changeContactSchema,
  consentSchema,
  deleteAccountSchema,
  notificationPrefsSchema,
} from '@marchmaker/shared';

import { z } from 'zod';
import type { AppContext } from '../context';
import { audit } from '../lib/audit';
import { badRequest, notFound } from '../lib/errors';
import { hmac, safeEqual } from '../lib/secrets';
import { asyncHandler } from '../middleware/asyncHandler';
import { authedUser, requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { DataRequest } from '../models/auth';
import * as account from '../services/account';
import { buildMe } from '../services/auth';

export function exportLinkSig(secret: string, id: string, exp: number): string {
  return hmac(secret, `export:${id}:${exp}`);
}

export function accountRouter(ctx: AppContext): Router {
  const r = Router();

  // Signed download link (emailed); no session needed, the signature is the credential.
  r.get(
    '/exports/:id/download',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      const exp = Number(req.query.exp);
      const sig = String(req.query.sig ?? '');
      if (!Number.isFinite(exp) || exp < Date.now() || !safeEqual(sig, exportLinkSig(ctx.env.JWT_REFRESH_SECRET, id, exp))) {
        throw badRequest('This download link is invalid or has expired');
      }
      const dr = await DataRequest.findOne({ _id: id, kind: 'export', status: 'ready' });
      if (!dr?.resultKey) throw notFound('This export is no longer available');
      const file = path.resolve(ctx.env.EXPORT_DIR, path.basename(dr.resultKey));
      if (!existsSync(file)) throw notFound('This export is no longer available');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="marchmaker-data-export.json"');
      res.setHeader('Cache-Control', 'no-store');
      createReadStream(file).pipe(res);
    }),
  );

  r.use(requireAuth);

  r.patch(
    '/',
    validate({ body: accountPatchSchema }),
    asyncHandler(async (req, res) => {
      const a = authedUser(req);
      await account.patchAccount(ctx, a.userId, req.body, a.sessionId);
      res.json(await buildMe(ctx, a.userId, a.sessionId, a.mfa));
    }),
  );

  r.post(
    '/contact/email',
    validate({ body: changeContactSchema.extend({ password: z.string().max(128).default('') }) }),
    asyncHandler(async (req, res) => {
      if (req.body.kind !== 'email') throw badRequest('Use the code flow to change your phone number');
      await account.requestEmailChange(ctx, authedUser(req).userId, req.body.value, req.body.password);
      res.status(202).json({ accepted: true });
    }),
  );

  r.post(
    '/pause',
    asyncHandler(async (req, res) => {
      await account.pauseAccount(authedUser(req).userId);
      res.json({ paused: true });
    }),
  );
  r.post(
    '/resume',
    asyncHandler(async (req, res) => {
      await account.resumeAccount(authedUser(req).userId);
      res.json({ paused: false });
    }),
  );

  r.post(
    '/delete',
    validate({ body: deleteAccountSchema }),
    asyncHandler(async (req, res) => {
      const a = authedUser(req);
      const out = await account.scheduleDeletion(ctx, a.userId, req.body, a.sessionId);
      res.json({ scheduled: true, purgeAt: out.purgeAt });
    }),
  );
  r.post(
    '/restore',
    asyncHandler(async (req, res) => {
      await account.restoreAccount(authedUser(req).userId);
      res.json({ restored: true });
    }),
  );

  r.post(
    '/export',
    asyncHandler(async (req, res) => {
      const out = await account.requestExport(authedUser(req).userId);
      res.status(202).json(out);
    }),
  );
  r.get(
    '/data-requests',
    asyncHandler(async (req, res) => {
      res.json({ items: await account.listDataRequests(authedUser(req).userId) });
    }),
  );

  r.get(
    '/notification-preferences',
    asyncHandler(async (req, res) => {
      res.json(await account.getNotificationPrefs(authedUser(req).userId));
    }),
  );
  r.put(
    '/notification-preferences',
    validate({ body: notificationPrefsSchema }),
    asyncHandler(async (req, res) => {
      res.json(await account.setNotificationPrefs(authedUser(req).userId, req.body));
    }),
  );

  r.get(
    '/consents',
    asyncHandler(async (req, res) => {
      res.json({ items: await account.consentHistory(authedUser(req).userId) });
    }),
  );
  r.post(
    '/consents',
    validate({ body: consentSchema }),
    asyncHandler(async (req, res) => {
      const a = authedUser(req);
      await account.setConsent(a.userId, req.body.purpose, req.body.granted, {
        ip: req.ip,
        userAgent: req.get('user-agent') ?? undefined,
      });
      await audit(req, {
        action: 'consent.changed',
        actorId: a.userId,
        subjectType: 'user',
        subjectId: a.userId,
        after: req.body,
      });
      res.status(201).json({ recorded: true });
    }),
  );

  return r;
}
