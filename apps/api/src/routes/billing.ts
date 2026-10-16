import express, { Router } from 'express';
import { z } from 'zod';
import {
  billingProfileSchema,
  changePlanSchema,
  couponInputSchema,
  packOrderSchema,
  refundSchema,
  subscribeSchema,
} from '@marchmaker/shared';
import type { AppContext } from '../context';
import { audit } from '../lib/audit';
import { AppError } from '../lib/errors';
import { asyncHandler } from '../middleware/asyncHandler';
import { authedUser, requirePermission } from '../middleware/auth';
import { validate } from '../middleware/validate';
import type { MockPaymentProvider } from '../lib/payments';
import { Payment } from '../models/billing';
import { WebhookEvent } from '../models/verification';
import * as admin from '../services/billingAdmin';
import * as billing from '../services/billing';
import * as coupons from '../services/coupons';
import * as invoicing from '../services/invoicing';
import { ledgerFor } from '../services/credits';

export const BILLING_PREFIXES = ['/billing'];

const id24 = z.string().regex(/^[a-f\d]{24}$/i);
const idParams = z.object({ id: id24 });

const confirmSchema = z
  .object({
    orderId: z.string().max(60).optional(),
    subscriptionId: z.string().max(60).optional(),
    paymentId: z.string().max(60),
    signature: z.string().max(200),
  })
  .refine((v) => Boolean(v.orderId) !== Boolean(v.subscriptionId), { message: 'Send an order or a subscription' });

const couponCheckSchema = z.object({ code: z.string().trim().toUpperCase().max(24), target: z.string().max(30) });

/** Member billing. The v1 router guards BILLING_PREFIXES with requireAuth. */
export function billingRouter(ctx: AppContext): Router {
  const r = Router();
  const noStore = (res: express.Response) => res.set('Cache-Control', 'no-store');

  r.get(
    '/billing',
    asyncHandler(async (req, res) => {
      noStore(res).json(await billing.summary(ctx, authedUser(req).userId));
    }),
  );
  r.get(
    '/billing/payments',
    asyncHandler(async (req, res) => {
      noStore(res).json({ items: await billing.paymentHistory(authedUser(req).userId) });
    }),
  );
  r.get(
    '/billing/invoices',
    asyncHandler(async (req, res) => {
      noStore(res).json({ items: await invoicing.listFor(authedUser(req).userId) });
    }),
  );
  r.get(
    '/billing/invoices/:id/download',
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      noStore(res).json({ url: await invoicing.downloadUrl(ctx, authedUser(req).userId, String(req.params.id)) });
    }),
  );
  r.get(
    '/billing/credits',
    asyncHandler(async (req, res) => {
      noStore(res).json({ items: await ledgerFor(authedUser(req).userId) });
    }),
  );
  r.put(
    '/billing/profile',
    validate({ body: billingProfileSchema }),
    asyncHandler(async (req, res) => {
      res.json(await billing.saveBillingProfile(authedUser(req).userId, req.body));
    }),
  );
  r.post(
    '/billing/coupon/check',
    validate({ body: couponCheckSchema }),
    asyncHandler(async (req, res) => {
      res.json(await billing.checkCoupon(authedUser(req).userId, req.body.code, req.body.target));
    }),
  );
  r.post(
    '/billing/subscribe',
    validate({ body: subscribeSchema }),
    asyncHandler(async (req, res) => {
      res.status(201).json(await billing.startSubscription(ctx, authedUser(req).userId, req.body));
    }),
  );
  r.post(
    '/billing/packs/order',
    validate({ body: packOrderSchema }),
    asyncHandler(async (req, res) => {
      res.status(201).json(await billing.startPackOrder(ctx, authedUser(req).userId, req.body));
    }),
  );
  r.post(
    '/billing/confirm',
    validate({ body: confirmSchema }),
    asyncHandler(async (req, res) => {
      noStore(res).json(await billing.confirmCheckout(ctx, authedUser(req).userId, req.body));
    }),
  );
  r.post(
    '/billing/change-plan',
    validate({ body: changePlanSchema }),
    asyncHandler(async (req, res) => {
      res.json(await billing.changePlan(ctx, authedUser(req).userId, req.body));
    }),
  );
  r.post(
    '/billing/cancel',
    asyncHandler(async (req, res) => {
      res.json(await billing.cancelAtPeriodEnd(ctx, authedUser(req).userId));
    }),
  );
  r.get(
    '/billing/payment-method',
    asyncHandler(async (req, res) => {
      noStore(res).json(await billing.paymentMethodUrl(ctx, authedUser(req).userId));
    }),
  );

  // Development only: completes a mock checkout the way the provider's webhook would.
  if (ctx.env.NODE_ENV !== 'production') {
    r.post(
      '/billing/dev/mock-pay',
      validate({ body: z.object({ orderId: z.string().max(60).optional(), subscriptionId: z.string().max(60).optional() }) }),
      asyncHandler(async (req, res) => {
        const p = ctx.payments;
        if (!p || p.name !== 'mock') throw new AppError(404, 'NOT_FOUND', 'Not available');
        const mock = p as MockPaymentProvider;
        const paymentId = `pay_mock_${Date.now().toString(36)}`;
        if (req.body.orderId) {
          const { Order } = await import('../models/billing');
          const o = await Order.findOne({ razorpayOrderId: req.body.orderId, userId: authedUser(req).userId });
          if (!o) throw new AppError(404, 'NOT_FOUND', 'Order not found');
          const list = mock.orderPayments.get(o.razorpayOrderId) ?? [];
          list.push({ id: paymentId, orderId: o.razorpayOrderId, status: 'captured', amount: o.amountPaise, method: 'upi' });
          mock.orderPayments.set(o.razorpayOrderId, list);
          await billing.reconcileOrder(ctx, o.razorpayOrderId);
        } else if (req.body.subscriptionId) {
          const { Subscription } = await import('../models/billing');
          const s = await Subscription.findOne({ razorpaySubscriptionId: req.body.subscriptionId, userId: authedUser(req).userId });
          if (!s) throw new AppError(404, 'NOT_FOUND', 'Subscription not found');
          const plan = await billing.catalogEntry(s.planCode);
          const months = { monthly: 1, quarterly: 3, annual: 12 }[s.interval as 'monthly'];
          const start = Math.floor(Date.now() / 1000);
          const end = start + months * 30 * 86_400;
          await billing.handleSubscriptionCharge(
            ctx,
            { id: s.razorpaySubscriptionId, status: 'active', current_start: start, current_end: end },
            { id: paymentId, amount: plan.prices[s.interval as 'monthly'] ?? 0, method: 'upi' },
          );
        }
        res.json({ ok: true });
      }),
    );
  }
  return r;
}

/** Provider callbacks. Mounted before the JSON parser: the signature covers the exact bytes received. */
export function paymentsWebhookRouter(ctx: AppContext): Router {
  const r = Router();
  r.post(
    '/razorpay',
    express.raw({ type: '*/*', limit: '512kb' }),
    asyncHandler(async (req, res) => {
      if (!ctx.payments) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not configured', requestId: String(req.id) } });
        return;
      }
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
      ) as Record<string, string | undefined>;
      const event = ctx.payments.verifyWebhook(raw, headers);
      if (!event) {
        res.status(401).json({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature', requestId: String(req.id) } });
        return;
      }
      await billing.receiveWebhook(ctx, event);
      res.status(200).json({ received: true });
    }),
  );
  return r;
}

/** Finance and plan administration. Each route states the permission it needs. */
export function adminBillingRouter(ctx: AppContext): Router {
  const r = Router();
  const actor = (req: express.Request) => {
    const a = authedUser(req);
    return { userId: a.userId, roles: a.roles as string[] };
  };

  r.get(
    '/payments',
    requirePermission('payment.view'),
    validate({ query: admin.paymentQuery }),
    asyncHandler(async (req, res) => {
      res.set('Cache-Control', 'no-store').json(await admin.listPayments(req.query as never));
    }),
  );
  r.post(
    '/payments/:id/refund',
    requirePermission('payment.refund'),
    validate({ params: idParams, body: refundSchema }),
    asyncHandler(async (req, res) => {
      res.json(await billing.refundPayment(ctx, actor(req), String(req.params.id), req.body, req));
    }),
  );
  r.get(
    '/subscriptions',
    requirePermission('payment.view'),
    asyncHandler(async (req, res) => {
      const status = z.string().max(20).optional().parse(req.query.status);
      res.set('Cache-Control', 'no-store').json(await admin.listSubscriptions(status));
    }),
  );
  r.get(
    '/webhooks',
    requirePermission('payment.view'),
    asyncHandler(async (req, res) => {
      res.set('Cache-Control', 'no-store').json(await admin.listWebhooks(req.query.failed === 'true'));
    }),
  );
  r.post(
    '/webhooks/:id/replay',
    requirePermission('payment.refund'),
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      const row = await WebhookEvent.findById(String(req.params.id));
      if (!row) throw new AppError(404, 'NOT_FOUND', 'We could not find that');
      // Re-opens the row; processing is idempotent so a replay can never double-grant.
      await WebhookEvent.updateOne({ _id: row._id }, { $unset: { processedAt: 1 } });
      const ok = await billing.processStored(ctx, row.eventId);
      const a = actor(req);
      await audit(req, { action: 'billing.webhook_replayed', actorId: a.userId, actorRoles: a.roles, subjectType: 'webhook', subjectId: row.eventId });
      res.json({ processed: ok });
    }),
  );
  r.post(
    '/reconcile',
    requirePermission('payment.refund'),
    asyncHandler(async (_req, res) => {
      res.json(await billing.reconcile(ctx));
    }),
  );

  r.get(
    '/coupons',
    requirePermission('coupon.manage'),
    asyncHandler(async (_req, res) => {
      res.json({ items: await coupons.list() });
    }),
  );
  r.post(
    '/coupons',
    requirePermission('coupon.manage'),
    validate({ body: couponInputSchema }),
    asyncHandler(async (req, res) => {
      const a = actor(req);
      const c = await coupons.create(req.body, a.userId);
      await audit(req, { action: 'coupon.created', actorId: a.userId, actorRoles: a.roles, subjectType: 'coupon', subjectId: c.id, after: c });
      res.status(201).json(c);
    }),
  );
  r.patch(
    '/coupons/:id',
    requirePermission('coupon.manage'),
    validate({ params: idParams, body: z.object({ active: z.boolean().optional(), expiresAt: z.coerce.date().nullable().optional(), maxUses: z.number().int().min(1).optional(), description: z.string().max(200).optional() }) }),
    asyncHandler(async (req, res) => {
      const a = actor(req);
      const c = await coupons.update(String(req.params.id), req.body);
      await audit(req, { action: 'coupon.updated', actorId: a.userId, actorRoles: a.roles, subjectType: 'coupon', subjectId: c.id, after: req.body });
      res.json(c);
    }),
  );

  r.get(
    '/plans',
    requirePermission('plan.manage'),
    asyncHandler(async (_req, res) => {
      res.json({ items: await admin.listPlans() });
    }),
  );
  r.put(
    '/plans/:code',
    requirePermission('plan.manage'),
    validate({ params: z.object({ code: z.string().regex(/^[a-z0-9_]{2,20}$/) }), body: admin.planPatchSchema }),
    asyncHandler(async (req, res) => {
      const a = actor(req);
      const out = await admin.updatePlan(String(req.params.code), req.body);
      await audit(req, { action: 'plan.updated', actorId: a.userId, actorRoles: a.roles, subjectType: 'plan', subjectId: String(req.params.code), after: req.body });
      res.json(out);
    }),
  );
  // payments by id for support deep links
  r.get(
    '/payments/:id',
    requirePermission('payment.view'),
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      const p = await Payment.findById(String(req.params.id)).lean();
      if (!p) throw new AppError(404, 'NOT_FOUND', 'We could not find that');
      res.set('Cache-Control', 'no-store').json({ id: String(p._id), status: p.status, amountPaise: p.amountPaise, refundedPaise: p.refundedPaise });
    }),
  );
  return r;
}
