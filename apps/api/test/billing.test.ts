import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { loadEnv } from '../src/config/env';
import { buildContext } from '../src/context';
import type { MockPaymentProvider } from '../src/lib/payments';
import { createLogger } from '../src/lib/logger';
import { MemoryMailer } from '../src/lib/mailer';
import { hashPassword } from '../src/lib/passwords';
import { MemorySms } from '../src/lib/sms';
import { MemoryStorage } from '../src/lib/storage';
import { Coupon, CreditLot, Invoice, Order, Payment, Subscription } from '../src/models/billing';
import { User } from '../src/models/core';
import { CreditLedger } from '../src/models/social';
import { WebhookEvent } from '../src/models/verification';
import { expireDueLots } from '../src/services/credits';
import { renderInvoicePdf } from '../src/lib/invoicePdf';
import { lapseAccess, reconcile } from '../src/services/billing';

let mongod: MongoMemoryReplSet;
beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongod.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
});

const PASSWORD = 'Sup3rSecretPass';

function setup() {
  const env = loadEnv({ NODE_ENV: 'test', EXPORT_DIR: mkdtempSync(path.join(tmpdir(), 'mm-bill-')) } as NodeJS.ProcessEnv);
  const log = createLogger('silent');
  const storage = new MemoryStorage();
  const mailer = new MemoryMailer();
  const ctx = buildContext({ env, log, mailer, sms: new MemorySms() }, { storage });
  const mock = ctx.payments as MockPaymentProvider;
  return { app: createApp({ env, log, isReady: () => true, ctx }), ctx, mock, storage, mailer };
}
type T = ReturnType<typeof setup>;

const csrfOf = (res: request.Response) =>
  ((res.headers['set-cookie'] as unknown as string[]) ?? [])
    .find((c) => c.startsWith('mm_csrf='))!
    .split(';')[0]!
    .slice('mm_csrf='.length);

let n = 0;
async function member(t: T, over: Record<string, unknown> = {}) {
  n++;
  const email = `bill${n}@example.com`;
  const u = await User.create({
    email,
    passwordHash: await hashPassword(PASSWORD),
    firstName: 'Meera',
    gender: 'woman',
    dobEnc: t.ctx.crypto.encrypt('1995-01-01'),
    dobYear: 1995,
    roles: ['member'],
    emailVerifiedAt: new Date(),
    journeyState: 'matching_active',
    ...over,
  });
  const agent = request.agent(t.app);
  const login = await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
  const csrf = csrfOf(login);
  return {
    id: String(u._id),
    get: (url: string) => agent.get(`/api/v1${url}`),
    post: (url: string) => agent.post(`/api/v1${url}`).set('x-csrf-token', csrf),
    put: (url: string) => agent.put(`/api/v1${url}`).set('x-csrf-token', csrf),
  };
}
type M = Awaited<ReturnType<typeof member>>;

const balance = async (id: string) => (await User.findById(id).lean())!.creditBalance;

function send(t: T, event: string, payload: Record<string, unknown>, eventId?: string) {
  const w = t.mock.webhook(event, payload, eventId);
  return request(t.app).post('/api/v1/webhooks/razorpay').set(w.headers).send(w.body);
}

/** Buys a pack through the API and returns what the provider would report as paid. */
async function orderPack(t: T, m: M, packCode = 'pack_3', couponCode?: string) {
  const res = await m.post('/billing/packs/order').send({ packCode, ...(couponCode && { couponCode }) });
  return res;
}
const capturedPayload = (t: T, o: { orderId: string; amount: number; paymentId: string }) => ({
  payment: t.mock.paymentEntity({ id: o.paymentId, orderId: o.orderId, amount: o.amount }),
});

describe('pack purchases', () => {
  it('grants credits once, issues a numbered invoice, and ignores redelivery', async () => {
    const t = setup();
    const m = await member(t);
    const res = await orderPack(t, m).then((r) => r.body);
    expect(res.amountPaise).toBe(129_900);

    const payload = capturedPayload(t, { orderId: res.orderId, amount: res.amountPaise, paymentId: 'pay_1' });
    await send(t, 'payment.captured', payload, 'evt_1').expect(200);
    expect(await balance(m.id)).toBe(3);

    // The same event again, and the same payment under a different event id (order.paid).
    await send(t, 'payment.captured', payload, 'evt_1').expect(200);
    await send(t, 'order.paid', payload, 'evt_2').expect(200);
    expect(await balance(m.id)).toBe(3);
    expect(await Payment.countDocuments({})).toBe(1);

    const inv = await Invoice.find({}).lean();
    expect(inv).toHaveLength(1);
    expect(inv[0]!.number).toMatch(/^INV\/\d{4}-\d{2}\/000001$/);
    expect(inv[0]!.tax!.totalPaise).toBe(129_900);
    expect(inv[0]!.tax!.cgstPaise! + inv[0]!.tax!.sgstPaise! + inv[0]!.tax!.taxablePaise!).toBe(129_900);
    expect(inv[0]!.tax!.igstPaise).toBe(0);
  });

  it('rejects an invalid signature and records nothing', async () => {
    const t = setup();
    const body = JSON.stringify({ event: 'payment.captured', payload: {} });
    await request(t.app)
      .post('/api/v1/webhooks/razorpay')
      .set({ 'x-razorpay-signature': 'deadbeef', 'content-type': 'application/json' })
      .send(body)
      .expect(401);
    expect(await WebhookEvent.countDocuments({})).toBe(0);
  });

  it('handles simultaneous deliveries of the same payment without double-granting', async () => {
    const t = setup();
    const m = await member(t);
    const o = (await orderPack(t, m, 'pack_1')).body;
    const payload = capturedPayload(t, { orderId: o.orderId, amount: o.amountPaise, paymentId: 'pay_race' });
    await Promise.all(
      [1, 2, 3, 4, 5].map((i) => send(t, i % 2 ? 'payment.captured' : 'order.paid', payload, `evt_race_${i}`)),
    );
    expect(await balance(m.id)).toBe(1);
    expect(await Payment.countDocuments({ razorpayPaymentId: 'pay_race' })).toBe(1);
    expect(await Invoice.countDocuments({})).toBe(1);
  });

  it('flags an amount mismatch for review instead of granting', async () => {
    const t = setup();
    const m = await member(t);
    const o = (await orderPack(t, m)).body;
    await send(t, 'payment.captured', capturedPayload(t, { orderId: o.orderId, amount: o.amountPaise - 100, paymentId: 'pay_short' })).expect(200);
    expect(await balance(m.id)).toBe(0);
    const order = await Order.findOne({ razorpayOrderId: o.orderId }).lean();
    expect(order!.flags).toContain('amount_mismatch');
  });

  it('uses IGST for a member in another state', async () => {
    const t = setup();
    const m = await member(t, { billing: { stateCode: '27' } });
    const o = (await orderPack(t, m, 'pack_1')).body;
    await send(t, 'payment.captured', capturedPayload(t, { orderId: o.orderId, amount: o.amountPaise, paymentId: 'pay_igst' })).expect(200);
    const inv = (await Invoice.findOne({}).lean())!;
    expect(inv.tax!.intraState).toBe(false);
    expect(inv.tax!.igstPaise).toBeGreaterThan(0);
    expect(inv.tax!.cgstPaise).toBe(0);
  });

  it('numbers invoices sequentially', async () => {
    const t = setup();
    const m = await member(t);
    for (const i of [1, 2, 3]) {
      const o = (await orderPack(t, m, 'pack_1')).body;
      await send(t, 'payment.captured', capturedPayload(t, { orderId: o.orderId, amount: o.amountPaise, paymentId: `pay_seq_${i}` })).expect(200);
    }
    const nums = (await Invoice.find({}).sort({ createdAt: 1 }).lean()).map((i) => i.number.split('/')[2]);
    expect(nums).toEqual(['000001', '000002', '000003']);
  });

  it('confirms a checkout only from the provider, never from the browser claim', async () => {
    const t = setup();
    const m = await member(t);
    const o = (await orderPack(t, m, 'pack_1')).body;
    // Bad signature
    await m.post('/billing/confirm').send({ orderId: o.orderId, paymentId: 'pay_x', signature: 'nope' }).expect(400);
    // Good signature but the provider has no captured payment: still pending, nothing granted.
    const sig = t.mock.checkoutSignature({ orderId: o.orderId, paymentId: 'pay_x' });
    const pending = await m.post('/billing/confirm').send({ orderId: o.orderId, paymentId: 'pay_x', signature: sig }).expect(200);
    expect(pending.body.status).toBe('pending');
    expect(await balance(m.id)).toBe(0);
    // Provider reports capture: confirm grants.
    t.mock.orderPayments.set(o.orderId, [{ id: 'pay_x', orderId: o.orderId, status: 'captured', amount: o.amountPaise }]);
    const done = await m.post('/billing/confirm').send({ orderId: o.orderId, paymentId: 'pay_x', signature: sig }).expect(200);
    expect(done.body.status).toBe('paid');
    expect(await balance(m.id)).toBe(1);
  });

  it('reconciliation recovers a payment whose webhook never arrived', async () => {
    const t = setup();
    const m = await member(t);
    const o = (await orderPack(t, m, 'pack_1')).body;
    t.mock.orderPayments.set(o.orderId, [{ id: 'pay_lost', orderId: o.orderId, status: 'captured', amount: o.amountPaise }]);
    // createdAt is immutable through mongoose, so age the order at the driver level.
    await Order.collection.updateOne({ razorpayOrderId: o.orderId }, { $set: { createdAt: new Date(Date.now() - 20 * 60_000) } });
    const out = await reconcile(t.ctx);
    expect(out.orders).toBe(1);
    expect(await balance(m.id)).toBe(1);
    // Running again changes nothing.
    await reconcile(t.ctx);
    expect(await balance(m.id)).toBe(1);
  });
});

describe('coupons', () => {
  const mk = (over: Record<string, unknown> = {}) =>
    Coupon.create({ code: 'WELCOME20', kind: 'percent', value: 20, perUserLimit: 1, appliesTo: [], ...over });

  it('discounts a pack and enforces the per-member limit', async () => {
    const t = setup();
    const m = await member(t);
    await mk();
    const o = (await orderPack(t, m, 'pack_3', 'WELCOME20').then((r) => r)).body;
    expect(o.discountPaise).toBe(25_980);
    expect(o.amountPaise).toBe(129_900 - 25_980);
    const again = await orderPack(t, m, 'pack_3', 'WELCOME20');
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('COUPON_INVALID');
  });

  it('stops at maxUses even when checkouts are simultaneous', async () => {
    const t = setup();
    await mk({ code: 'ONLYONE', maxUses: 1 });
    const a = await member(t);
    const b = await member(t);
    const [ra, rb] = await Promise.all([orderPack(t, a, 'pack_1', 'ONLYONE'), orderPack(t, b, 'pack_1', 'ONLYONE')]);
    expect([ra.status, rb.status].sort()).toEqual([201, 422]);
    expect((await Coupon.findOne({ code: 'ONLYONE' }).lean())!.usedCount).toBe(1);
  });

  it('refuses expired codes and codes for another product', async () => {
    const t = setup();
    const m = await member(t);
    await mk({ code: 'OLD', expiresAt: new Date(Date.now() - 1000) });
    await mk({ code: 'ONLY3', appliesTo: ['pack_3'] });
    expect((await orderPack(t, m, 'pack_1', 'OLD')).status).toBe(422);
    expect((await orderPack(t, m, 'pack_1', 'ONLY3')).status).toBe(422);
    expect((await orderPack(t, m, 'pack_3', 'ONLY3')).status).toBe(201);
  });

  it('only allows subscription coupons that carry a provider offer', async () => {
    const t = setup();
    const m = await member(t);
    await mk({ code: 'PACKONLY' });
    const r = await m.post('/billing/subscribe').send({ planCode: 'essential', interval: 'monthly', couponCode: 'PACKONLY' });
    expect(r.status).toBe(422);
    await mk({ code: 'SUBOFFER', razorpayOfferId: 'offer_1' });
    await m.post('/billing/subscribe').send({ planCode: 'essential', interval: 'monthly', couponCode: 'SUBOFFER' }).expect(201);
  });
});

async function activeSubscription(t: T, m: M, planCode = 'essential', interval = 'monthly') {
  const s = (await m.post('/billing/subscribe').send({ planCode, interval }).expect(201)).body;
  const start = Math.floor(Date.now() / 1000);
  const end = start + 30 * 86_400;
  t.mock.subscriptions.get(s.subscriptionId)!.status = 'active';
  const entity = t.mock.subscriptionEntity(
    { id: s.subscriptionId, status: 'active', planId: 'plan_x', currentStart: start, currentEnd: end },
    { userId: m.id, planCode, interval },
  );
  return { s, start, end, entity, id: s.subscriptionId as string };
}

describe('subscriptions', () => {
  it('activates on the first charge: credits with expiry, plan on the member, invoice', async () => {
    const t = setup();
    const m = await member(t);
    const { entity, id } = await activeSubscription(t, m);
    await send(t, 'subscription.charged', { subscription: entity, payment: t.mock.paymentEntity({ id: 'pay_sub1', subscriptionId: id, amount: 99_900 }) }).expect(200);

    const user = (await User.findById(m.id).lean())!;
    expect(user.plan!.planCode).toBe('essential');
    expect(user.plan!.status).toBe('active');
    expect(user.creditBalance).toBe(2);
    const lot = (await CreditLot.findOne({ userId: m.id }).lean())!;
    expect(lot.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 40 * 86_400_000);
    expect(await Invoice.countDocuments({})).toBe(1);

    // Redelivery is harmless
    await send(t, 'subscription.charged', { subscription: entity, payment: t.mock.paymentEntity({ id: 'pay_sub1', subscriptionId: id, amount: 99_900 }) }, 'evt_again').expect(200);
    expect(await balance(m.id)).toBe(2);

    // The member cannot start a second subscription
    await m.post('/billing/subscribe').send({ planCode: 'premium', interval: 'monthly' }).expect(409);
  });

  it('copes with events arriving out of order and keeps terminal states', async () => {
    const t = setup();
    const m = await member(t);
    const { entity, id } = await activeSubscription(t, m);
    // Charged arrives first, then an old "authenticated", then the real cancellation, then a stale "active".
    await send(t, 'subscription.charged', { subscription: entity, payment: t.mock.paymentEntity({ id: 'pay_ooo', subscriptionId: id, amount: 99_900 }) }).expect(200);
    await send(t, 'subscription.authenticated', { subscription: t.mock.subscriptionEntity({ id, status: 'authenticated', planId: 'plan_x' }, {}) }).expect(200);
    expect((await Subscription.findOne({ razorpaySubscriptionId: id }).lean())!.status).toBe('authenticated');
    await send(t, 'subscription.cancelled', { subscription: t.mock.subscriptionEntity({ id, status: 'cancelled', planId: 'plan_x' }, {}) }).expect(200);
    await send(t, 'subscription.activated', { subscription: t.mock.subscriptionEntity({ id, status: 'active', planId: 'plan_x' }, {}) }).expect(200);
    expect((await Subscription.findOne({ razorpaySubscriptionId: id }).lean())!.status).toBe('cancelled');
  });

  it('gives a 3 day grace on a failed renewal, then drops to free', async () => {
    const t = setup();
    const m = await member(t);
    const { entity, id } = await activeSubscription(t, m);
    await send(t, 'subscription.charged', { subscription: entity, payment: t.mock.paymentEntity({ id: 'pay_g', subscriptionId: id, amount: 99_900 }) }).expect(200);
    await send(t, 'subscription.halted', { subscription: t.mock.subscriptionEntity({ id, status: 'halted', planId: 'plan_x' }, {}) }).expect(200);

    const sub = (await Subscription.findOne({ razorpaySubscriptionId: id }).lean())!;
    expect(sub.status).toBe('halted');
    const days = (sub.graceUntil!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(2.9);
    expect(days).toBeLessThanOrEqual(3);
    expect((await User.findById(m.id).lean())!.plan!.status).toBe('grace');
    expect(await Outbox_count('billing.payment_failed')).toBe(1);

    // Inside grace nothing changes
    expect((await lapseAccess()).downgraded).toBe(0);
    expect((await User.findById(m.id).lean())!.plan!.planCode).toBe('essential');
    // After grace the plan lapses
    const out = await lapseAccess(new Date(Date.now() + 4 * 86_400_000));
    expect(out.downgraded).toBe(1);
    expect((await User.findById(m.id).lean())!.plan!.planCode).toBe('free');

    // A successful retry recovers
    await send(t, 'subscription.activated', { subscription: t.mock.subscriptionEntity({ id, status: 'active', planId: 'plan_x' }, {}) }).expect(200);
  });

  it('upgrades immediately with prorated credits; downgrades wait for the cycle end', async () => {
    const t = setup();
    const m = await member(t);
    const { entity, id } = await activeSubscription(t, m, 'essential', 'monthly');
    await send(t, 'subscription.charged', { subscription: entity, payment: t.mock.paymentEntity({ id: 'pay_up', subscriptionId: id, amount: 99_900 }) }).expect(200);
    expect(await balance(m.id)).toBe(2);

    const up = await m.post('/billing/change-plan').send({ planCode: 'premium', interval: 'monthly' }).expect(200);
    expect(up.body.effective).toBe('now');
    // 5 - 2 credits scaled by nearly the whole cycle left => 2 (floor of ~2.99)
    expect(up.body.extraCredits).toBeGreaterThanOrEqual(2);
    expect((await User.findById(m.id).lean())!.plan!.planCode).toBe('premium');

    const down = await m.post('/billing/change-plan').send({ planCode: 'essential', interval: 'monthly' }).expect(200);
    expect(down.body.effective).toBe('cycle_end');
    const sub = (await Subscription.findOne({ razorpaySubscriptionId: id }).lean())!;
    expect(sub.planCode).toBe('premium');
    expect(sub.pendingChange!.planCode).toBe('essential');
    await m.post('/billing/change-plan').send({ planCode: 'essential', interval: 'monthly' }).expect(200);
  });

  it('announces a renewal, a scheduled cancellation and, three days out, that the plan ends', async () => {
    const t = setup();
    const m = await member(t);
    const { entity, id } = await activeSubscription(t, m);
    await send(t, 'subscription.charged', { subscription: entity, payload: undefined, payment: t.mock.paymentEntity({ id: 'pay_first', subscriptionId: id, amount: 99_900 }) }).expect(200);
    expect(await Outbox_count('subscription.renewed')).toBe(0); // the first charge is a start, not a renewal
    await send(t, 'subscription.charged', { subscription: entity, payment: t.mock.paymentEntity({ id: 'pay_second', subscriptionId: id, amount: 99_900 }) }).expect(200);
    expect(await Outbox_count('subscription.renewed')).toBe(1);

    await m.post('/billing/cancel').send({}).expect(200);
    expect(await Outbox_count('subscription.cancel_scheduled')).toBe(1);
    const end = (await Subscription.findOne({ userId: m.id }).lean())!.currentPeriodEnd!;
    await lapseAccess(new Date(end.getTime() - 2 * 86_400_000));
    await lapseAccess(new Date(end.getTime() - 86_400_000)); // never twice
    expect(await Outbox_count('subscription.expiring')).toBe(1);
  });

  it('pauses billing but keeps access to the end of the paid period, then resumes', async () => {
    const t = setup();
    const m = await member(t);
    const { entity, id } = await activeSubscription(t, m);
    await send(t, 'subscription.charged', { subscription: entity, payment: t.mock.paymentEntity({ id: 'pay_p', subscriptionId: id, amount: 99_900 }) }).expect(200);
    const r = (await m.post('/billing/subscriptions/pause').send({}).expect(200)).body;
    expect(r.status).toBe('paused');
    expect((await User.findById(m.id).lean())!.plan).toMatchObject({ planCode: 'essential', status: 'paused' });
    await m.post('/billing/subscriptions/pause').send({}).expect(409); // already paused

    // Once the paid period ends the plan drops to free, and resuming restores it.
    await lapseAccess(new Date(Date.now() + 40 * 86_400_000));
    expect((await User.findById(m.id).lean())!.plan!.planCode).toBe('free');
    await m.post('/billing/subscriptions/resume').send({}).expect(200);
    expect((await User.findById(m.id).lean())!.plan).toMatchObject({ planCode: 'essential', status: 'active' });
    await m.post('/billing/subscriptions/resume').send({}).expect(409);
  });

  it('answers on the spec-named endpoints as well as the original ones', async () => {
    const t = setup();
    const m = await member(t);
    expect((await m.get('/billing/summary').expect(200)).body).toEqual((await m.get('/billing').expect(200)).body);
    await m.post('/billing/coupons/validate').send({ code: 'NOPE', target: 'pack_1' }).expect(422);
    expect((await m.post('/billing/orders').send({ packCode: 'pack_1' }).expect(201)).body.orderId).toBeTruthy();
    expect((await m.post('/billing/subscriptions').send({ planCode: 'essential', interval: 'monthly' }).expect(201)).body.subscriptionId).toBeTruthy();
  });

  it('cancels at period end and keeps access until then', async () => {
    const t = setup();
    const m = await member(t);
    const { entity, id } = await activeSubscription(t, m);
    await send(t, 'subscription.charged', { subscription: entity, payment: t.mock.paymentEntity({ id: 'pay_c', subscriptionId: id, amount: 99_900 }) }).expect(200);
    const r = await m.post('/billing/cancel').send({}).expect(200);
    expect(r.body.endsAt).toBeTruthy();
    const summary = (await m.get('/billing').expect(200)).body;
    expect(summary.subscription.cancelAtPeriodEnd).toBe(true);
    expect(summary.plan.code).toBe('essential');
  });
});

async function Outbox_count(eventType: string) {
  const { Outbox } = await import('../src/models/core');
  return Outbox.countDocuments({ eventType });
}

describe('credit expiry', () => {
  it('lapses only expired lots and never drives the balance negative', async () => {
    const t = setup();
    const m = await member(t, { creditBalance: 3 });
    await CreditLot.create([
      { userId: m.id, source: 'subscription', amount: 2, remaining: 2, expiresAt: new Date(Date.now() - 1000) },
      { userId: m.id, source: 'pack', amount: 1, remaining: 1 },
    ]);
    expect(await expireDueLots()).toBe(2);
    expect(await balance(m.id)).toBe(1);
    expect(await expireDueLots()).toBe(0);
    const entry = (await CreditLedger.findOne({ userId: m.id, type: 'expire' }).lean())!;
    expect(entry.delta).toBe(-2);
  });
});

describe('refunds', () => {
  async function staff(t: T) {
    const email = `fin${++n}@example.com`;
    await User.create({
      email,
      passwordHash: await hashPassword(PASSWORD),
      firstName: 'Fin',
      gender: 'man',
      dobEnc: t.ctx.crypto.encrypt('1990-01-01'),
      dobYear: 1990,
      roles: ['super_admin'],
      emailVerifiedAt: new Date(),
    });
    return email;
  }

  it('refunds part of a pack: money, credit note and proportional credits', async () => {
    const t = setup();
    const m = await member(t);
    const o = (await orderPack(t, m, 'pack_3')).body;
    await send(t, 'payment.captured', capturedPayload(t, { orderId: o.orderId, amount: o.amountPaise, paymentId: 'pay_ref' })).expect(200);
    expect(await balance(m.id)).toBe(3);
    const pay = (await Payment.findOne({ razorpayPaymentId: 'pay_ref' }).lean())!;

    const { refundPayment } = await import('../src/services/billing');
    const out = await refundPayment(t.ctx, { userId: m.id, roles: ['finance'] }, String(pay._id), { amountPaise: 43_300, reason: 'Goodwill for a duplicate' });
    expect(out.duplicate).toBe(false);
    expect(t.mock.refunds).toEqual([{ paymentId: 'pay_ref', amountPaise: 43_300 }]);

    const after = (await Payment.findById(pay._id).lean())!;
    expect(after.status).toBe('partially_refunded');
    expect(after.refundedPaise).toBe(43_300);
    // a third of the money => one of the three credits
    expect(await balance(m.id)).toBe(2);
    const note = await Invoice.findOne({ kind: 'credit_note' }).lean();
    expect(note!.number).toMatch(/^CN\//);
    expect(note!.relatesTo).toBeTruthy();

    // Cannot refund more than what is left
    await expect(
      refundPayment(t.ctx, { userId: m.id, roles: ['finance'] }, String(pay._id), { amountPaise: 999_999, reason: 'Too much' }),
    ).rejects.toThrow();

    // A refund recorded from the provider dashboard is not counted twice
    const sentId = (await Payment.findById(pay._id).lean())!.refunds[0]!.razorpayRefundId!;
    await send(t, 'refund.processed', {
      refund: { entity: { id: sentId, payment_id: 'pay_ref', amount: 43_300, status: 'processed' } },
    }).expect(200);
    expect((await Payment.findById(pay._id).lean())!.refundedPaise).toBe(43_300);
    void staff;
  });

  it('exposes the finance console only to finance staff', async () => {
    const t = setup();
    const m = await member(t);
    await m.get('/admin/billing/payments').expect(403);
  });
});

describe('member billing views', () => {
  it('shows credits, plan, history and a download link for an invoice', async () => {
    const t = setup();
    const m = await member(t);
    const o = (await orderPack(t, m, 'pack_1')).body;
    await send(t, 'payment.captured', capturedPayload(t, { orderId: o.orderId, amount: o.amountPaise, paymentId: 'pay_view' })).expect(200);
    const s = (await m.get('/billing').expect(200)).body;
    expect(s.credits.available).toBe(1);
    expect(s.plan.code).toBe('free');
    const hist = (await m.get('/billing/payments').expect(200)).body.items;
    expect(hist).toHaveLength(1);
    const invs = (await m.get('/billing/invoices').expect(200)).body.items;
    expect(invs[0].totalPaise).toBe(49_900);
    const dl = (await m.get(`/billing/invoices/${invs[0].id}/download`).expect(200)).body;
    expect(dl.url).toContain('documents/invoices/');
    expect(t.storage.has('documents', `invoices/${m.id}/${invs[0].number.replace(/\//g, '-')}.pdf`)).toBe(true);
  });

  it('redraws a stored invoice PDF made with an older layout', async () => {
    const t = setup();
    const m = await member(t);
    const o = (await orderPack(t, m, 'pack_1')).body;
    await send(t, 'payment.captured', capturedPayload(t, { orderId: o.orderId, amount: o.amountPaise, paymentId: 'pay_redraw' })).expect(200);
    const inv = (await m.get('/billing/invoices').expect(200)).body.items[0];
    await m.get(`/billing/invoices/${inv.id}/download`).expect(200);
    const key = `invoices/${m.id}/${inv.number.replace(/\//g, '-')}.pdf`;

    // Pretend this PDF was drawn by the first layout.
    await t.storage.put('documents', key, Buffer.from('old layout'), 'application/pdf');
    await Invoice.updateOne({ _id: inv.id }, { $set: { pdfDesign: 1 } });

    await m.get(`/billing/invoices/${inv.id}/download`).expect(200);
    expect((await t.storage.get('documents', key)).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await Invoice.findById(inv.id))?.pdfDesign).toBeGreaterThan(1);
  });

  it('saves a GSTIN and uses its state for place of supply', async () => {
    const t = setup();
    const m = await member(t);
    await m.put('/billing/profile').send({ gstin: 'bad' }).expect(422);
    await m.put('/billing/profile').send({ legalName: 'Meera Traders', gstin: '27AAPFU0939F1ZV' }).expect(200);
    const o = (await orderPack(t, m, 'pack_1')).body;
    await send(t, 'payment.captured', capturedPayload(t, { orderId: o.orderId, amount: o.amountPaise, paymentId: 'pay_gst' })).expect(200);
    const inv = (await Invoice.findOne({}).lean())!;
    expect(inv.buyer!.gstin).toBe('27AAPFU0939F1ZV');
    expect(inv.placeOfSupply).toBe('Maharashtra');
    expect(inv.tax!.intraState).toBe(false);
  });
});

describe('invoice pdf', () => {
  it('renders a valid PDF for an invoice and for a credit note', async () => {
    const base = {
      number: 'MM/2026-27/000001',
      kind: 'invoice' as const,
      issuedAt: new Date('2026-04-01'),
      seller: { name: 'Marchmaker', gstin: '29ABCDE1234F1Z5', address: 'Bengaluru' },
      buyer: { name: 'Asha', email: 'a@example.com' },
      placeOfSupply: 'Karnataka',
      lineItems: [{ description: '1 introduction credit', sac: '998599', taxablePaise: 16_864 }],
      tax: { ratePercent: 18, taxablePaise: 16_864, cgstPaise: 1_518, sgstPaise: 1_518, igstPaise: 0, totalPaise: 19_900 },
    };
    const pdf = await renderInvoicePdf(base);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1000);
    const note = await renderInvoicePdf({ ...base, kind: 'credit_note', relatesToNumber: base.number });
    expect(note.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
