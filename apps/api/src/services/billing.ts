import mongoose, { type ClientSession, type Types } from 'mongoose';
import {
  DEFAULT_PACKS,
  DEFAULT_PLANS,
  GRACE_DAYS,
  MIN_CASH_PAISE,
  SUBSCRIPTION_STATES,
  addDays,
  isUpgrade,
  prorateUpgradeCredits,
  splitWithWallet,
  type BillingInterval,
  type PlanCode,
  type SubscriptionState,
} from '@marchmaker/shared';
import { withTransaction } from '../db/connection';
import type { AppContext } from '../context';
import { audit } from '../lib/audit';
import { AppError, badRequest, conflict, notFound } from '../lib/errors';
import type { PaymentProvider, WebhookEvent as ProviderEvent } from '../lib/payments';
import { Plan } from '../models/content';
import { Outbox, User } from '../models/core';
import { CreditLot, Order, Payment, Subscription } from '../models/billing';
import { WebhookEvent } from '../models/verification';
import * as coupons from './coupons';
import * as credits from './credits';
import * as invoicing from './invoicing';
import * as referrals from './referrals';
import * as wallet from './wallet';

const MONTHS: Record<BillingInterval, number> = { monthly: 1, quarterly: 3, annual: 12 };
const TOTAL_COUNT: Record<BillingInterval, number> = { monthly: 120, quarterly: 40, annual: 10 };
const TERMINAL: SubscriptionState[] = ['cancelled', 'completed', 'expired'];
const LIVE: SubscriptionState[] = ['created', 'authenticated', 'active', 'pending', 'halted'];

const addMonths = (d: Date, n: number) => {
  const x = new Date(d);
  x.setUTCMonth(x.getUTCMonth() + n);
  return x;
};
const isDup = (err: unknown) => (err as { code?: number }).code === 11000;

function needProvider(ctx: AppContext): PaymentProvider {
  if (!ctx.payments) throw new AppError(503, 'PAYMENTS_UNAVAILABLE', 'Payments are not available right now. Please try again shortly.');
  return ctx.payments;
}

// ------------------------------------------------------------------ catalog

interface CatalogEntry {
  code: string;
  kind: 'subscription' | 'pack';
  name: string;
  prices: Partial<Record<BillingInterval, number>>;
  credits: number;
}

export async function catalogEntry(code: string): Promise<CatalogEntry> {
  const row = await Plan.findOne({ code, active: true }).lean();
  if (row) {
    return {
      code,
      kind: row.kind as 'subscription' | 'pack',
      name: row.name,
      prices: (row.prices ?? {}) as CatalogEntry['prices'],
      credits: row.credits ?? 0,
    };
  }
  const d = [...DEFAULT_PLANS, ...DEFAULT_PACKS].find((p) => p.code === code);
  if (!d) throw notFound('That plan is not available');
  return { code, kind: d.kind, name: d.name, prices: d.prices as CatalogEntry['prices'], credits: d.credits };
}

/** The provider plan for a (plan, interval, price). Re-created when an admin changes the price. */
async function providerPlanId(provider: PaymentProvider, entry: CatalogEntry, interval: BillingInterval): Promise<string> {
  const amount = entry.prices[interval];
  if (!amount) throw badRequest('That billing period is not offered for this plan');
  const row = await Plan.findOne({ code: entry.code }).lean();
  const known = (row?.razorpayPlanIds as Record<string, { id: string; amount: number } | undefined> | undefined)?.[interval];
  if (known && typeof known === 'object' && known.amount === amount) return known.id;
  const created = await provider.createPlan({ name: `${entry.name} (${interval})`, amountPaise: amount, interval });
  const seed = [...DEFAULT_PLANS, ...DEFAULT_PACKS].find((p) => p.code === entry.code);
  await Plan.updateOne(
    { code: entry.code },
    {
      $set: { [`razorpayPlanIds.${interval}`]: { id: created.id, amount } },
      $setOnInsert: {
        kind: entry.kind,
        name: entry.name,
        prices: entry.prices,
        credits: entry.credits,
        features: seed?.features ?? [],
        sortOrder: seed?.sortOrder ?? 0,
      },
    },
    { upsert: true },
  );
  return created.id;
}

// ------------------------------------------------------------------ checkout

export async function startSubscription(
  ctx: AppContext,
  userId: string,
  input: { planCode: PlanCode; interval: BillingInterval; couponCode?: string },
) {
  const provider = needProvider(ctx);
  const entry = await catalogEntry(input.planCode);
  if (entry.kind !== 'subscription') throw badRequest('That is not a subscription plan');
  const price = entry.prices[input.interval];
  if (!price) throw badRequest('That billing period is not offered for this plan');

  const existing = await Subscription.findOne({ userId, status: { $in: LIVE } });
  if (existing && existing.status !== 'created') {
    throw conflict('You already have a subscription. You can change your plan from the billing page.');
  }

  let offerId: string | undefined;
  if (input.couponCode) {
    const { coupon } = await coupons.validate(input.couponCode, userId, input.planCode, price);
    if (!coupon.razorpayOfferId) {
      throw new AppError(422, 'COUPON_INVALID', 'That code works on introduction packs, not on subscriptions');
    }
    offerId = coupon.razorpayOfferId;
  }

  const planId = await providerPlanId(provider, entry, input.interval);
  const sub = await provider.createSubscription({
    planId,
    totalCount: TOTAL_COUNT[input.interval],
    notes: { userId, planCode: input.planCode, interval: input.interval },
    offerId,
  });
  // A checkout that was never completed is replaced by this one.
  if (existing) await Subscription.updateOne({ _id: existing._id }, { $set: { status: 'expired' } });
  await Subscription.create({
    userId,
    planCode: input.planCode,
    interval: input.interval,
    razorpaySubscriptionId: sub.id,
    razorpayPlanId: planId,
    status: 'created',
    shortUrl: sub.shortUrl,
    couponCode: input.couponCode,
  });
  return { kind: 'subscription' as const, keyId: provider.keyId, subscriptionId: sub.id, shortUrl: sub.shortUrl ?? null };
}

export async function startPackOrder(
  ctx: AppContext,
  userId: string,
  input: { packCode: string; couponCode?: string; useWallet?: boolean },
) {
  const provider = needProvider(ctx);
  const pack = await catalogEntry(input.packCode);
  if (pack.kind !== 'pack') throw badRequest('That is not an introduction pack');
  const list = pack.prices.monthly;
  if (!list) throw badRequest('That pack is not available');

  let discount = 0;
  let couponId: Types.ObjectId | undefined;
  if (input.couponCode) {
    const v = await coupons.validate(input.couponCode, userId, input.packCode, list);
    // A paid order cannot be for less than one rupee.
    discount = Math.min(v.discountPaise, list - MIN_CASH_PAISE);
    couponId = v.coupon._id;
  }
  const amount = list - discount;
  const me = await User.findById(userId).select('walletBalancePaise').lean();
  const split = splitWithWallet(amount, me?.walletBalancePaise ?? 0, input.useWallet === true);

  const orderId = new mongoose.Types.ObjectId();
  // Reserve the coupon first, against the id the order will have; give it back if anything below fails.
  if (couponId) await coupons.reserve(couponId, userId, orderId, discount);
  try {
    const common = {
      _id: orderId,
      userId,
      packCode: input.packCode,
      credits: pack.credits,
      listPricePaise: list,
      discountPaise: discount,
      walletPaise: split.walletPaise,
      amountPaise: split.cashPaise,
      couponCode: input.couponCode,
      couponId,
    };

    // The wallet covers everything: no gateway, no invoice (nothing was paid in cash).
    if (split.cashPaise === 0) {
      await withTransaction(async (session) => {
        await Order.create([{ ...common, razorpayOrderId: `wallet_${orderId}`, status: 'paid', paidAt: new Date() }], { session });
        await wallet.spend(userId, split.walletPaise, orderId, session);
        await credits.grant(userId, pack.credits, `Purchased ${pack.credits} introduction${pack.credits > 1 ? 's' : ''} with wallet`, session, undefined, `pack:wallet_${orderId}`, {
          source: 'pack',
        });
        await relay(session, 'order.paid', { userId, orderId: String(orderId), credits: pack.credits });
      });
      await coupons.confirm(orderId);
      return {
        kind: 'pack' as const,
        paid: true,
        keyId: provider.keyId,
        orderId: `wallet_${orderId}`,
        amountPaise: 0,
        walletPaise: split.walletPaise,
        listPricePaise: list,
        discountPaise: discount,
        credits: pack.credits,
      };
    }

    const receipt = `pk_${userId.slice(-8)}_${Date.now().toString(36)}`;
    const po = await provider.createOrder({ amountPaise: split.cashPaise, receipt, notes: { userId, packCode: input.packCode } });
    await withTransaction(async (session) => {
      await Order.create([{ ...common, razorpayOrderId: po.id, receipt }], { session });
      if (split.walletPaise > 0) await wallet.spend(userId, split.walletPaise, orderId, session);
    });
    return {
      kind: 'pack' as const,
      paid: false,
      keyId: provider.keyId,
      orderId: po.id,
      amountPaise: split.cashPaise,
      walletPaise: split.walletPaise,
      listPricePaise: list,
      discountPaise: discount,
      credits: pack.credits,
    };
  } catch (err) {
    await coupons.release(orderId);
    throw err;
  }
}

export async function checkCoupon(userId: string, code: string, target: string) {
  const entry = await catalogEntry(target);
  const base = entry.kind === 'pack' ? entry.prices.monthly : Math.min(...(Object.values(entry.prices) as number[]));
  if (!base) throw badRequest('That item is not available');
  const v = await coupons.validate(code, userId, target, base);
  if (entry.kind === 'subscription') {
    if (!v.coupon.razorpayOfferId) throw new AppError(422, 'COUPON_INVALID', 'That code works on introduction packs, not on subscriptions');
    return { applies: true, discountPaise: null, note: 'The discount is applied by our payment partner at checkout.' };
  }
  const discount = Math.min(v.discountPaise, base - 100);
  return { applies: true, discountPaise: discount, finalPaise: base - discount, note: null };
}

// ------------------------------------------------------------------ fulfilment

interface NormalPayment {
  paymentId: string;
  orderId?: string;
  amount: number;
  method?: string;
}

async function relay(session: ClientSession, eventType: string, payload: Record<string, unknown>) {
  await Outbox.create([{ eventType, payload }], { session });
}

/** Marks an order paid exactly once and grants its credits, whichever of webhook/confirm/reconcile gets here first. */
export async function fulfilPackOrder(ctx: AppContext, p: NormalPayment): Promise<'paid' | 'duplicate' | 'unknown' | 'mismatch'> {
  if (!p.orderId) return 'unknown';
  const order = await Order.findOne({ razorpayOrderId: p.orderId });
  if (!order) return 'unknown';
  if (order.status === 'paid') return 'duplicate';
  const mismatch = p.amount !== order.amountPaise;
  try {
    const result = await withTransaction(async (session) => {
      const flipped = await Order.findOneAndUpdate(
        { _id: order._id, status: { $ne: 'paid' } },
        { $set: { status: 'paid', paidAt: new Date(), ...(mismatch && { flags: ['amount_mismatch'] }) } },
        { session },
      );
      if (!flipped) return 'duplicate' as const;
      const [pay] = await Payment.create(
        [
          {
            userId: order.userId,
            razorpayPaymentId: p.paymentId,
            razorpayOrderId: p.orderId,
            kind: 'pack',
            planCode: order.packCode,
            amountPaise: p.amount,
            status: 'captured',
            method: p.method,
            capturedAt: new Date(),
            creditsGranted: mismatch ? 0 : order.credits,
          },
        ],
        { session },
      );
      if (mismatch) {
        await relay(session, 'billing.needs_review', { orderId: String(order._id), reason: 'amount_mismatch', paymentId: p.paymentId });
        return 'mismatch' as const;
      }
      await credits.grant(order.userId, order.credits, `Purchased ${order.credits} introduction${order.credits > 1 ? 's' : ''}`, session, undefined, `pack:${p.paymentId}`, {
        source: 'pack',
        type: 'grant',
      });
      const inv = await invoicing.issue(
        { ctx, userId: order.userId, paymentId: pay!._id, amountPaise: p.amount, description: `${order.credits} introduction credit${order.credits > 1 ? 's' : ''}` },
        session,
      );
      await Payment.updateOne({ _id: pay!._id }, { $set: { invoiceId: inv._id } }, { session });
      await Order.updateOne({ _id: order._id }, { $set: { invoiceId: inv._id } }, { session });
      await relay(session, 'invoice.created', { invoiceId: String(inv._id), userId: String(order.userId) });
      await relay(session, 'order.paid', { userId: String(order.userId), orderId: String(order._id), credits: order.credits });
      return 'paid' as const;
    });
    if (result === 'paid') {
      await coupons.confirm(order._id);
      await referrals.onPayment(order.userId, p.paymentId, p.amount).catch((err) => ctx.log.warn({ err }, 'referral qualification failed'));
    }
    return result;
  } catch (err) {
    if (isDup(err)) return 'duplicate';
    throw err;
  }
}

interface SubEntity {
  id: string;
  status?: string;
  plan_id?: string;
  current_start?: number;
  current_end?: number;
  short_url?: string;
  notes?: Record<string, string>;
}
interface PayEntity {
  id: string;
  amount: number;
  status?: string;
  order_id?: string;
  subscription_id?: string;
  method?: string;
  error_code?: string;
  notes?: Record<string, string>;
}

async function findOrCreateSub(e: SubEntity) {
  const found = await Subscription.findOne({ razorpaySubscriptionId: e.id });
  if (found) return found;
  const n = e.notes ?? {};
  if (!n.userId || !n.planCode || !n.interval) return null;
  try {
    return await Subscription.create({
      userId: n.userId,
      planCode: n.planCode,
      interval: n.interval as BillingInterval,
      razorpaySubscriptionId: e.id,
      razorpayPlanId: e.plan_id,
      status: 'created',
    });
  } catch (err) {
    if (isDup(err)) return Subscription.findOne({ razorpaySubscriptionId: e.id });
    throw err;
  }
}

const toDate = (s?: number) => (s ? new Date(s * 1000) : undefined);

/** A recurring (or first) subscription payment: records it, extends the period, grants credits, issues the invoice. */
export async function handleSubscriptionCharge(ctx: AppContext, se: SubEntity, pe: PayEntity): Promise<'paid' | 'duplicate' | 'unknown'> {
  if (await Payment.exists({ razorpayPaymentId: pe.id })) return 'duplicate';
  const sub = await findOrCreateSub(se);
  if (!sub) return 'unknown';
  const entry = await catalogEntry(sub.planCode);
  const interval = sub.interval as BillingInterval;
  const start = toDate(se.current_start) ?? new Date();
  const end = toDate(se.current_end) ?? addMonths(start, MONTHS[interval]);
  try {
    await withTransaction(async (session) => {
      const [pay] = await Payment.create(
        [
          {
            userId: sub.userId,
            razorpayPaymentId: pe.id,
            razorpaySubscriptionId: se.id,
            razorpayOrderId: pe.order_id,
            kind: 'subscription',
            planCode: sub.planCode,
            interval,
            amountPaise: pe.amount,
            status: 'captured',
            method: pe.method,
            capturedAt: new Date(),
            creditsGranted: entry.credits,
          },
        ],
        { session },
      );
      const fresh = await Subscription.findById(sub._id).session(session);
      if (!fresh) return;
      // A scheduled downgrade takes effect with the first charge of the new cycle.
      const pc = fresh.pendingChange;
      if (pc?.planCode && pc.at && pc.at.getTime() <= start.getTime() + 86_400_000) {
        fresh.planCode = pc.planCode;
        fresh.interval = (pc.interval ?? fresh.interval) as BillingInterval;
        fresh.pendingChange = undefined;
      }
      if (!TERMINAL.includes(fresh.status)) fresh.status = 'active';
      // Never move the period backwards when events arrive out of order.
      if (!fresh.currentPeriodEnd || end.getTime() >= fresh.currentPeriodEnd.getTime()) {
        fresh.currentPeriodStart = start;
        fresh.currentPeriodEnd = end;
      }
      fresh.graceUntil = undefined;
      await fresh.save({ session });

      const planNow = await catalogEntry(fresh.planCode);
      await User.updateOne(
        { _id: fresh.userId },
        { $set: { 'plan.planCode': fresh.planCode, 'plan.status': 'active', 'plan.currentPeriodEnd': fresh.currentPeriodEnd } },
        { session },
      );
      if (entry.credits > 0) {
        // Credits roll over once: they last through the following cycle, then lapse.
        const expiresAt = addMonths(end, MONTHS[interval]);
        await credits.grant(fresh.userId, entry.credits, `${entry.name} credits`, session, undefined, `sub:${pe.id}`, {
          source: 'subscription',
          expiresAt,
        });
      }
      const inv = await invoicing.issue(
        { ctx, userId: fresh.userId, paymentId: pay!._id, amountPaise: pe.amount, description: `${planNow.name} subscription (${interval})` },
        session,
      );
      await Payment.updateOne({ _id: pay!._id }, { $set: { invoiceId: inv._id } }, { session });
      await relay(session, 'invoice.created', { invoiceId: String(inv._id), userId: String(fresh.userId) });
      await relay(session, 'subscription.charged', { userId: String(fresh.userId), planCode: fresh.planCode, interval });
    });
    await referrals.onPayment(sub.userId, pe.id, pe.amount).catch((err) => ctx.log.warn({ err }, 'referral qualification failed'));
    return 'paid';
  } catch (err) {
    if (isDup(err)) return 'duplicate';
    throw err;
  }
}

/** Applies a provider status to our row. Terminal states are sticky; unknown states are ignored. */
export async function applySubscriptionState(se: SubEntity): Promise<void> {
  const sub = await findOrCreateSub(se);
  if (!sub) return;
  const next = se.status as SubscriptionState | undefined;
  if (!next || !(SUBSCRIPTION_STATES as readonly string[]).includes(next)) {
    // e.g. paused: keep our status, still learn the short url
    if (se.short_url) await Subscription.updateOne({ _id: sub._id }, { $set: { shortUrl: se.short_url } });
    return;
  }
  if (TERMINAL.includes(sub.status)) return;
  const set: Record<string, unknown> = { status: next, lastSyncedAt: new Date() };
  const end = toDate(se.current_end);
  if (end && (!sub.currentPeriodEnd || end.getTime() >= sub.currentPeriodEnd.getTime())) {
    set.currentPeriodEnd = end;
    set.currentPeriodStart = toDate(se.current_start) ?? sub.currentPeriodStart;
  }
  if (se.short_url) set.shortUrl = se.short_url;
  const unset: Record<string, 1> = {};
  const userSet: Record<string, unknown> = {};

  if (next === 'halted') {
    set.graceUntil = addDays(new Date(), GRACE_DAYS);
    userSet['plan.status'] = 'grace';
  } else if (next === 'active') {
    unset.graceUntil = 1;
    userSet['plan.status'] = 'active';
  } else if (TERMINAL.includes(next)) {
    userSet['plan.status'] = 'cancelled';
    set.cancelAtPeriodEnd = false;
  }
  await Subscription.updateOne({ _id: sub._id, status: sub.status }, { $set: set, ...(Object.keys(unset).length && { $unset: unset }) });
  if (Object.keys(userSet).length) {
    await User.updateOne({ _id: sub.userId, 'plan.planCode': sub.planCode as PlanCode }, { $set: userSet });
  }
  if (next === 'halted' && sub.status !== 'halted') {
    await Outbox.create({
      eventType: 'billing.payment_failed',
      payload: { userId: String(sub.userId), planCode: sub.planCode, graceDays: GRACE_DAYS, updateUrl: se.short_url ?? sub.shortUrl },
    });
  }
}

/** Records a refund once, from either our own refund call or the provider telling us about one. */
async function recordRefund(
  ctx: AppContext,
  paymentDocId: Types.ObjectId,
  r: { id: string; amountPaise: number; reason?: string; actorId?: string; status?: string },
) {
  return withTransaction(async (session) => {
    const pay = await Payment.findById(paymentDocId).session(session);
    if (!pay) throw notFound();
    if (pay.refunds.some((x) => x.razorpayRefundId === r.id)) return { duplicate: true as const };
    const remaining = pay.amountPaise - pay.refundedPaise;
    const amt = Math.min(r.amountPaise, remaining);
    if (amt <= 0) return { duplicate: true as const };
    const refunded = pay.refundedPaise + amt;
    const note = await invoicing.issue(
      { ctx, userId: pay.userId, paymentId: pay._id, amountPaise: amt, description: 'Refund', kind: 'credit_note', relatesTo: pay.invoiceId ?? undefined },
      session,
    );
    // Credits come back in proportion to the money, so a part refund revokes a part of the grant.
    const revokedBefore = pay.refunds.reduce((s, x) => s + (x.creditsRevoked ?? 0), 0);
    const target = Math.round((pay.creditsGranted * refunded) / pay.amountPaise);
    const toRevoke = Math.max(0, target - revokedBefore);
    const revoked = toRevoke
      ? await credits.revoke(pay.userId, toRevoke, 'Credits returned with a refund', `refund:${pay._id}:${r.id}`, session)
      : 0;
    pay.refunds.push({
      razorpayRefundId: r.id,
      amountPaise: amt,
      reason: r.reason,
      status: r.status ?? 'processed',
      by: r.actorId as unknown as Types.ObjectId,
      at: new Date(),
      creditNoteId: note._id,
      creditsRevoked: revoked,
    });
    pay.refundedPaise = refunded;
    pay.status = refunded >= pay.amountPaise ? 'refunded' : 'partially_refunded';
    await pay.save({ session });
    await relay(session, 'invoice.created', { invoiceId: String(note._id), userId: String(pay.userId) });
    await relay(session, 'payment.refunded', { userId: String(pay.userId), amountPaise: amt, refundId: r.id });
    return { duplicate: false as const, creditNoteNumber: note.number, creditsRevoked: revoked, refundedPaise: refunded };
  });
}

export async function refundPayment(
  ctx: AppContext,
  actor: { userId: string; roles: string[] },
  paymentId: string,
  input: { amountPaise?: number; reason: string },
  req?: Parameters<typeof audit>[0],
) {
  const provider = needProvider(ctx);
  const pay = await Payment.findById(paymentId);
  if (!pay) throw notFound();
  if (!['captured', 'partially_refunded'].includes(pay.status)) throw conflict('This payment cannot be refunded');
  const remaining = pay.amountPaise - pay.refundedPaise;
  const amount = input.amountPaise ?? remaining;
  if (amount > remaining) throw badRequest(`At most ${remaining} paise can still be refunded`);
  const pr = await provider.refund(pay.razorpayPaymentId, amount);
  const out = await recordRefund(ctx, pay._id, { id: pr.id, amountPaise: amount, reason: input.reason, actorId: actor.userId, status: pr.status });
  await audit(req, {
    action: 'payment.refunded',
    actorId: actor.userId,
    actorRoles: actor.roles,
    subjectType: 'payment',
    subjectId: paymentId,
    after: { amountPaise: amount, reason: input.reason },
  });
  return out;
}

// ------------------------------------------------------------------ webhooks

const asRecord = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined);
const entityOf = <T>(payload: Record<string, unknown>, key: string): T | undefined =>
  asRecord(asRecord(payload[key])?.entity) as T | undefined;

export async function processEvent(ctx: AppContext, ev: Pick<ProviderEvent, 'event' | 'payload'>): Promise<void> {
  const pay = entityOf<PayEntity>(ev.payload, 'payment');
  const sub = entityOf<SubEntity>(ev.payload, 'subscription');
  switch (ev.event) {
    case 'payment.captured':
    case 'order.paid':
      if (pay?.order_id) {
        await fulfilPackOrder(ctx, { paymentId: pay.id, orderId: pay.order_id, amount: pay.amount, method: pay.method });
      }
      return;
    case 'payment.failed':
      if (pay?.order_id) {
        const order = await Order.findOne({ razorpayOrderId: pay.order_id }).select('userId').lean();
        if (order) {
          await Payment.updateOne(
            { razorpayPaymentId: pay.id },
            { $setOnInsert: { userId: order.userId, razorpayOrderId: pay.order_id, kind: 'pack', amountPaise: pay.amount, status: 'failed', errorCode: pay.error_code, method: pay.method } },
            { upsert: true },
          );
        }
      }
      return;
    case 'subscription.charged':
      if (sub && pay) await handleSubscriptionCharge(ctx, sub, pay);
      return;
    case 'subscription.authenticated':
    case 'subscription.activated':
    case 'subscription.pending':
    case 'subscription.halted':
    case 'subscription.cancelled':
    case 'subscription.completed':
    case 'subscription.expired':
    case 'subscription.updated':
    case 'subscription.paused':
    case 'subscription.resumed':
      if (sub) await applySubscriptionState(sub);
      return;
    case 'refund.processed':
    case 'refund.created': {
      const rf = entityOf<{ id: string; payment_id: string; amount: number; status?: string }>(ev.payload, 'refund');
      if (!rf) return;
      const p = await Payment.findOne({ razorpayPaymentId: rf.payment_id });
      if (p) await recordRefund(ctx, p._id, { id: rf.id, amountPaise: rf.amount, reason: 'Refunded from the payment dashboard', status: rf.status });
      return;
    }
    default:
      return;
  }
}

/** Stores first, then processes. A failure leaves the row for the retry sweep. */
export async function receiveWebhook(ctx: AppContext, ev: ProviderEvent): Promise<'stored' | 'duplicate'> {
  try {
    await WebhookEvent.create({ provider: 'razorpay', eventId: ev.eventId, payload: ev, signatureValid: true });
  } catch (err) {
    if (isDup(err)) return 'duplicate';
    throw err;
  }
  await processStored(ctx, ev.eventId);
  return 'stored';
}

export async function processStored(ctx: AppContext, eventId: string): Promise<boolean> {
  const row = await WebhookEvent.findOneAndUpdate(
    { provider: 'razorpay', eventId, processedAt: { $exists: false } },
    { $inc: { attempts: 1 } },
    { new: true },
  );
  if (!row) return true;
  try {
    await processEvent(ctx, row.payload as ProviderEvent);
    await WebhookEvent.updateOne({ _id: row._id }, { $set: { processedAt: new Date() }, $unset: { error: 1 } });
    return true;
  } catch (err) {
    ctx.log.error({ err, eventId }, 'billing webhook processing failed');
    await WebhookEvent.updateOne({ _id: row._id }, { $set: { error: String((err as Error).message).slice(0, 300) } });
    return false;
  }
}

// ------------------------------------------------------------------ confirm and reconcile

export async function reconcileOrder(ctx: AppContext, orderId: string): Promise<'paid' | 'pending'> {
  const provider = needProvider(ctx);
  const payments = await provider.fetchOrderPayments(orderId);
  const captured = payments.find((p) => p.status === 'captured');
  if (!captured) return 'pending';
  await fulfilPackOrder(ctx, { paymentId: captured.id, orderId, amount: captured.amount, method: captured.method });
  return 'paid';
}

export async function syncSubscription(ctx: AppContext, razorpaySubscriptionId: string) {
  const s = await needProvider(ctx).getSubscription(razorpaySubscriptionId);
  await applySubscriptionState({
    id: s.id,
    status: s.status,
    plan_id: s.planId,
    current_start: s.currentStart,
    current_end: s.currentEnd,
    short_url: s.shortUrl,
  });
}

/**
 * The checkout callback is only a hint. We verify its signature, then ask the provider what really
 * happened; credits are granted from that, never from the browser's claim.
 */
export async function confirmCheckout(
  ctx: AppContext,
  userId: string,
  input: { orderId?: string; subscriptionId?: string; paymentId: string; signature: string },
) {
  const provider = needProvider(ctx);
  if (!provider.verifyCheckout(input)) throw badRequest('We could not verify that payment');
  if (input.orderId) {
    const o = await Order.findOne({ razorpayOrderId: input.orderId, userId });
    if (!o) throw notFound();
    if (o.status === 'paid') return { status: 'paid' as const };
    return { status: await reconcileOrder(ctx, input.orderId) };
  }
  if (input.subscriptionId) {
    const s = await Subscription.findOne({ razorpaySubscriptionId: input.subscriptionId, userId });
    if (!s) throw notFound();
    await syncSubscription(ctx, input.subscriptionId);
    const after = await Subscription.findById(s._id).lean();
    const paid = await Payment.exists({ razorpaySubscriptionId: input.subscriptionId, status: { $in: ['captured', 'partially_refunded', 'refunded'] } });
    return { status: after?.status === 'active' && paid ? ('paid' as const) : ('pending' as const) };
  }
  throw badRequest('Nothing to confirm');
}

/** Every 15 minutes: pending orders and subscriptions are asked about, stuck webhooks retried, stale orders closed. */
export async function reconcile(ctx: AppContext, now = new Date()) {
  if (!ctx.payments) return { orders: 0, subscriptions: 0, retried: 0 };
  const tenMin = new Date(now.getTime() - 10 * 60_000);
  const day = new Date(now.getTime() - 24 * 3_600_000);
  let orders = 0;
  for (const o of await Order.find({ status: 'created', createdAt: { $lte: tenMin } }).limit(200)) {
    try {
      const r = await reconcileOrder(ctx, o.razorpayOrderId);
      if (r === 'paid') orders++;
      else if (o.createdAt < day) {
        await Order.updateOne({ _id: o._id, status: 'created' }, { $set: { status: 'expired' } });
        await coupons.release(o._id);
        if (o.walletPaise > 0) {
          await withTransaction((session) => wallet.release(o.userId, o.walletPaise, o._id, session));
        }
      }
    } catch (err) {
      ctx.log.warn({ err, orderId: o.razorpayOrderId }, 'order reconcile failed');
    }
  }
  let subscriptions = 0;
  for (const s of await Subscription.find({ status: { $in: ['created', 'authenticated', 'pending', 'halted'] }, createdAt: { $lte: tenMin } }).limit(200)) {
    try {
      await syncSubscription(ctx, s.razorpaySubscriptionId);
      subscriptions++;
    } catch (err) {
      ctx.log.warn({ err, sub: s.razorpaySubscriptionId }, 'subscription reconcile failed');
    }
  }
  let retried = 0;
  const stuck = await WebhookEvent.find({
    provider: 'razorpay',
    processedAt: { $exists: false },
    attempts: { $lt: 10 },
    updatedAt: { $lte: new Date(now.getTime() - 60_000) },
  }).limit(100);
  for (const e of stuck) if (await processStored(ctx, e.eventId)) retried++;
  return { orders, subscriptions, retried };
}

/** Ends access whose grace window or paid period has passed, and lapses expired credits. */
export async function lapseAccess(now = new Date()) {
  let downgraded = 0;
  const due = await Subscription.find({
    $or: [
      { status: 'halted', graceUntil: { $lte: now } },
      { status: { $in: TERMINAL }, currentPeriodEnd: { $lte: now } },
    ],
  }).limit(500);
  for (const s of due) {
    const r = await User.updateOne(
      { _id: s.userId, 'plan.planCode': s.planCode as PlanCode },
      { $set: { 'plan.planCode': 'free', 'plan.status': 'lapsed' } },
    );
    if (r.modifiedCount) {
      downgraded++;
      await Outbox.create({ eventType: 'subscription.lapsed', payload: { userId: String(s.userId), planCode: s.planCode } });
    }
  }
  const expired = await credits.expireDueLots(now);
  return { downgraded, expired };
}

// ------------------------------------------------------------------ plan changes

async function liveSub(userId: string) {
  const s = await Subscription.findOne({ userId, status: { $in: ['active', 'pending'] } }).sort({ createdAt: -1 });
  if (!s) throw new AppError(409, 'NO_SUBSCRIPTION', 'You do not have an active subscription');
  return s;
}

export async function changePlan(ctx: AppContext, userId: string, input: { planCode: PlanCode; interval: BillingInterval }) {
  const provider = needProvider(ctx);
  const sub = await liveSub(userId);
  if (sub.planCode === input.planCode && sub.interval === input.interval) throw badRequest('That is already your plan');
  const target = await catalogEntry(input.planCode);
  if (target.kind !== 'subscription') throw badRequest('That is not a subscription plan');
  const planId = await providerPlanId(provider, target, input.interval);
  const upgrade = isUpgrade(sub.planCode, input.planCode);

  if (!upgrade) {
    // Downgrades and same-tier period changes wait for the end of the paid cycle.
    await provider.updateSubscription(sub.razorpaySubscriptionId, { planId, when: 'cycle_end' });
    sub.pendingChange = { planCode: input.planCode, interval: input.interval, at: sub.currentPeriodEnd ?? new Date() };
    await sub.save();
    return { effective: 'cycle_end' as const, at: sub.currentPeriodEnd ?? null, extraCredits: 0 };
  }

  await provider.updateSubscription(sub.razorpaySubscriptionId, { planId, when: 'now' });
  const old = await catalogEntry(sub.planCode);
  const extra =
    sub.currentPeriodStart && sub.currentPeriodEnd
      ? prorateUpgradeCredits(old.credits, target.credits, sub.currentPeriodStart, sub.currentPeriodEnd, new Date())
      : Math.max(0, target.credits - old.credits);
  await withTransaction(async (session) => {
    sub.planCode = input.planCode;
    sub.interval = input.interval;
    sub.pendingChange = undefined;
    sub.razorpayPlanId = planId;
    await sub.save({ session });
    await User.updateOne({ _id: userId }, { $set: { 'plan.planCode': input.planCode } }, { session });
    if (extra > 0) {
      const exp = sub.currentPeriodEnd ? addMonths(sub.currentPeriodEnd, MONTHS[input.interval]) : undefined;
      await credits.grant(userId, extra, `Upgrade to ${target.name}`, session, undefined, `upgrade:${sub.razorpaySubscriptionId}:${input.planCode}:${sub.currentPeriodStart?.getTime() ?? 0}`, {
        source: 'subscription',
        expiresAt: exp,
      });
    }
  });
  return { effective: 'now' as const, at: null, extraCredits: extra };
}

export async function cancelAtPeriodEnd(ctx: AppContext, userId: string) {
  const sub = await liveSub(userId);
  await needProvider(ctx).cancelSubscription(sub.razorpaySubscriptionId, true);
  sub.cancelAtPeriodEnd = true;
  await sub.save();
  return { endsAt: sub.currentPeriodEnd ?? null };
}

/** The provider-hosted page where the member can update their card or UPI mandate. */
export async function paymentMethodUrl(ctx: AppContext, userId: string) {
  const sub = await Subscription.findOne({ userId, status: { $in: ['active', 'pending', 'halted', 'authenticated'] } }).sort({ createdAt: -1 });
  if (!sub) throw new AppError(409, 'NO_SUBSCRIPTION', 'You do not have a subscription');
  try {
    await syncSubscription(ctx, sub.razorpaySubscriptionId);
  } catch {
    // the stored link is still the best we have
  }
  const fresh = await Subscription.findById(sub._id).select('shortUrl').lean();
  return { url: fresh?.shortUrl ?? null };
}

// ------------------------------------------------------------------ read models

export async function summary(ctx: AppContext, userId: string) {
  const user = await User.findById(userId).select('plan creditBalance creditsReserved billing walletBalancePaise').lean();
  if (!user) throw notFound();
  const sub = await Subscription.findOne({ userId, status: { $in: [...LIVE, 'cancelled'] } }).sort({ createdAt: -1 }).lean();
  const soon = await CreditLot.find({
    userId,
    remaining: { $gt: 0 },
    expiresAt: { $gt: new Date(), $lte: addDays(new Date(), 45) },
  })
    .sort({ expiresAt: 1 })
    .limit(5)
    .lean();
  const live = sub && sub.status !== 'created' ? sub : null;
  return {
    plan: {
      code: user.plan?.planCode ?? 'free',
      status: user.plan?.status ?? 'none',
      currentPeriodEnd: user.plan?.currentPeriodEnd ?? null,
    },
    subscription: live
      ? {
          planCode: live.planCode,
          interval: live.interval,
          status: live.status,
          currentPeriodEnd: live.currentPeriodEnd ?? null,
          cancelAtPeriodEnd: live.cancelAtPeriodEnd,
          graceUntil: live.graceUntil ?? null,
          pendingChange: live.pendingChange?.planCode ? live.pendingChange : null,
        }
      : null,
    credits: {
      available: user.creditBalance ?? 0,
      held: user.creditsReserved ?? 0,
      expiring: soon.map((l) => ({ amount: l.remaining, expiresAt: l.expiresAt })),
    },
    billingProfile: {
      legalName: user.billing?.legalName ?? '',
      gstin: user.billing?.gstin ?? '',
      stateCode: user.billing?.stateCode ?? '',
    },
    wallet: { balancePaise: user.walletBalancePaise ?? 0 },
    paymentsEnabled: Boolean(ctx.payments),
    mock: ctx.payments?.name === 'mock',
  };
}

export async function paymentHistory(userId: string) {
  const rows = await Payment.find({ userId, status: { $ne: 'failed' } }).sort({ createdAt: -1 }).limit(100).lean();
  return rows.map((p) => ({
    id: String(p._id),
    at: p.capturedAt ?? p.createdAt,
    kind: p.kind,
    planCode: p.planCode,
    amountPaise: p.amountPaise,
    refundedPaise: p.refundedPaise,
    status: p.status,
    invoiceId: p.invoiceId ? String(p.invoiceId) : null,
  }));
}

export async function saveBillingProfile(userId: string, p: { legalName?: string; gstin?: string; stateCode?: string }) {
  const set: Record<string, unknown> = {
    'billing.legalName': p.legalName ?? null,
    'billing.gstin': p.gstin ?? null,
    'billing.stateCode': p.gstin ? p.gstin.slice(0, 2) : (p.stateCode ?? null),
  };
  await User.updateOne({ _id: userId }, { $set: set });
  return { ok: true };
}
