import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { referralDecisionSchema, referralSettingsSchema, walletAdjustSchema, type Role } from '@marchmaker/shared';
import { withTransaction } from '../db/connection';
import type { AppContext } from '../context';
import { audit } from '../lib/audit';
import { asyncHandler } from '../middleware/asyncHandler';
import { authedUser, requirePermission } from '../middleware/auth';
import { validate } from '../middleware/validate';
import * as referrals from '../services/referrals';
import * as wallet from '../services/wallet';

export const REFERRAL_PREFIXES = ['/referrals', '/wallet'];

const id24 = z.string().regex(/^[a-f\d]{24}$/i);
const idParams = z.object({ id: id24 });
const noStore = (res: Response) => res.set('Cache-Control', 'no-store');
const actorOf = (req: Request) => {
  const a = authedUser(req);
  return { userId: a.userId, roles: a.roles as Role[] };
};

export function referralsRouter(ctx: AppContext): Router {
  const r = Router();
  r.get(
    '/referrals',
    asyncHandler(async (req, res) => {
      noStore(res).json(await referrals.memberView(ctx, authedUser(req).userId));
    }),
  );
  r.get(
    '/wallet',
    asyncHandler(async (req, res) => {
      const userId = authedUser(req).userId;
      const view = await referrals.memberView(ctx, userId);
      noStore(res).json({ balancePaise: view.wallet.balancePaise, entries: await wallet.ledgerFor(userId) });
    }),
  );
  return r;
}

export function adminReferralsRouter(): Router {
  const r = Router();
  r.get(
    '/referrals',
    requirePermission('wallet.adjust'),
    asyncHandler(async (req, res) => {
      noStore(res).json(await referrals.adminList(z.string().max(20).optional().parse(req.query.status)));
    }),
  );
  r.post(
    '/referrals/:id/decision',
    requirePermission('wallet.adjust'),
    validate({ params: idParams, body: referralDecisionSchema }),
    asyncHandler(async (req, res) => {
      res.json(await referrals.decide(req, String(req.params.id), req.body, actorOf(req)));
    }),
  );
  r.get(
    '/referral-settings',
    requirePermission('settings.manage'),
    asyncHandler(async (_req, res) => {
      res.json(await referrals.getSettings());
    }),
  );
  r.put(
    '/referral-settings',
    requirePermission('settings.manage'),
    validate({ body: referralSettingsSchema }),
    asyncHandler(async (req, res) => {
      res.json(await referrals.saveSettings(req, req.body, actorOf(req)));
    }),
  );
  r.post(
    '/members/:id/wallet',
    requirePermission('wallet.adjust'),
    validate({ params: idParams, body: walletAdjustSchema }),
    asyncHandler(async (req, res) => {
      const a = actorOf(req);
      const out = await withTransaction((session) =>
        wallet.adjust(String(req.params.id), req.body.amountPaise, req.body.reason, a.userId, session),
      );
      await audit(req, {
        action: 'wallet.adjusted',
        actorId: a.userId,
        actorRoles: a.roles,
        subjectType: 'user',
        subjectId: String(req.params.id),
        after: { amountPaise: req.body.amountPaise, reason: req.body.reason },
      });
      res.status(201).json(out);
    }),
  );
  return r;
}
