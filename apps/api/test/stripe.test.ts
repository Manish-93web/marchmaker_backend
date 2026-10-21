import { createHmac } from 'node:crypto';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { loadEnv } from '../src/config/env';
import { buildContext } from '../src/context';
import { createLogger } from '../src/lib/logger';
import { MemoryMailer } from '../src/lib/mailer';
import { hashPassword } from '../src/lib/passwords';
import { StripeProvider, formEncode } from '../src/lib/stripe';
import { MemorySms } from '../src/lib/sms';
import { MemoryStorage } from '../src/lib/storage';
import { Invoice, Order, Payment, Subscription } from '../src/models/billing';
import { User } from '../src/models/core';

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
afterEach(() => vi.unstubAllGlobals());

const WHSEC = 'whsec_test_secret';

/** Stands in for api.stripe.com: answers by method and path, and remembers what it was asked. */
function stubStripe(routes: Record<string, (body: URLSearchParams, url: URL) => unknown>) {
  const calls: { method: string; path: string; body: URLSearchParams; headers: Record<string, string> }[] = [];
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    calls.push({ method, path: url.pathname.replace('/v1', ''), body, headers: init?.headers as Record<string, string> });
    const key = `${method} ${url.pathname.replace('/v1', '')}`;
    const handler = routes[key];
    if (!handler) return new Response(JSON.stringify({ error: { message: `no stub for ${key}` } }), { status: 404 });
    return new Response(JSON.stringify(handler(body, url)), { status: 200 });
  });
  return calls;
}

function signed(body: object, secret = WHSEC, ts = Math.floor(Date.now() / 1000)) {
  const raw = JSON.stringify(body);
  const sig = createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
  return { raw, headers: { 'stripe-signature': `t=${ts},v1=${sig}`, 'content-type': 'application/json' } };
}

function setup() {
  const env = loadEnv({
    NODE_ENV: 'test',
    PAYMENTS_PROVIDER: 'stripe',
    STRIPE_SECRET_KEY: 'sk_test_unit',
    STRIPE_WEBHOOK_SECRET: WHSEC,
    APP_URL: 'https://app.example.com',
  } as unknown as NodeJS.ProcessEnv);
  const log = createLogger('silent');
  const ctx = buildContext({ env, log, mailer: new MemoryMailer(), sms: new MemorySms() }, { storage: new MemoryStorage() });
  return { app: createApp({ env, log, isReady: () => true, ctx }), ctx };
}
type T = ReturnType<typeof setup>;

async function member(t: T) {
  const email = `stripe${Math.random().toString(36).slice(2, 8)}@example.com`;
  const u = await User.create({
    email,
    passwordHash: await hashPassword('Sup3rSecretPass'),
    firstName: 'Meera',
    gender: 'woman',
    dobEnc: t.ctx.crypto.encrypt('1995-01-01'),
    dobYear: 1995,
    roles: ['member'],
    emailVerifiedAt: new Date(),
    journeyState: 'matching_active',
  });
  const agent = request.agent(t.app);
  const login = await agent.post('/api/v1/auth/login').send({ email, password: 'Sup3rSecretPass' }).expect(200);
  const csrf = ((login.headers['set-cookie'] as unknown as string[]) ?? []).find((c) => c.startsWith('mm_csrf='))!.split(';')[0]!.slice('mm_csrf='.length);
  return { id: String(u._id), post: (url: string) => agent.post(`/api/v1${url}`).set('x-csrf-token', csrf) };
}

describe('Stripe requests', () => {
  it('encodes nested fields the way Stripe expects', () => {
    expect(decodeURIComponent(formEncode({ mode: 'payment', line_items: [{ quantity: 1, price_data: { currency: 'inr' } }], pause_collection: '', skip: undefined }))).toBe(
      'mode=payment&line_items[0][quantity]=1&line_items[0][price_data][currency]=inr&pause_collection=',
    );
  });

  it('opens a hosted Checkout page for a pack, in rupees, with the return addresses', async () => {
    const calls = stubStripe({ 'POST /checkout/sessions': () => ({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }) });
    const p = new StripeProvider('sk_test_unit', '', WHSEC, 'https://app.example.com/');
    const o = await p.createOrder({ amountPaise: 129_900, receipt: 'pk_1', notes: { userId: 'u1', packCode: 'pack_3' }, description: '3 introduction credits' });
    expect(o).toEqual({ id: 'cs_test_1', checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    const c = calls[0]!;
    expect(c.headers.Authorization).toBe('Bearer sk_test_unit');
    expect(c.headers['Stripe-Version']).toBeTruthy();
    expect(c.body.get('mode')).toBe('payment');
    expect(c.body.get('line_items[0][price_data][currency]')).toBe('inr');
    expect(c.body.get('line_items[0][price_data][unit_amount]')).toBe('129900');
    expect(c.body.get('success_url')).toBe('https://app.example.com/billing?checkout=success&order={CHECKOUT_SESSION_ID}');
    expect(c.body.get('metadata[userId]')).toBe('u1');
  });

  it('turns Stripe failures into a clear 502 that carries Stripe\'s reason', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { code: 'api_key_invalid', message: 'Invalid API Key provided' } }), { status: 401 }));
    const p = new StripeProvider('sk_test_wrong', '', WHSEC, 'https://app.example.com');
    await expect(p.createPlan({ name: 'Premium', amountPaise: 249_900, interval: 'monthly' })).rejects.toMatchObject({
      status: 502,
      code: 'PAYMENT_PROVIDER_ERROR',
      details: { provider: 'stripe', status: 401, code: 'api_key_invalid' },
    });
  });
});

describe('Stripe webhooks', () => {
  const p = new StripeProvider('sk_test_unit', '', WHSEC, 'https://app.example.com');
  const paid = { id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_test_1', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_1', amount_total: 129_900, metadata: { userId: 'u1' } } } };

  it('accepts a correctly signed event and translates it', async () => {
    const w = signed(paid);
    const ev = await p.verifyWebhook(Buffer.from(w.raw), w.headers);
    expect(ev).toMatchObject({ eventId: 'evt_1', event: 'payment.captured' });
    expect((ev!.payload as { payment: { entity: Record<string, unknown> } }).payment.entity).toMatchObject({ id: 'pi_1', order_id: 'cs_test_1', amount: 129_900, status: 'captured' });
  });

  it('refuses a wrong secret, a tampered body, a missing signature and an old timestamp', async () => {
    const good = signed(paid);
    expect(await p.verifyWebhook(Buffer.from(good.raw), {})).toBeNull();
    expect(await p.verifyWebhook(Buffer.from(good.raw), signed(paid, 'whsec_other').headers)).toBeNull();
    expect(await p.verifyWebhook(Buffer.from(good.raw.replace('129900', '1')), good.headers)).toBeNull();
    const old = signed(paid, WHSEC, Math.floor(Date.now() / 1000) - 3600);
    expect(await p.verifyWebhook(Buffer.from(old.raw), old.headers)).toBeNull();
  });

  it('acknowledges events it has no use for without acting on them', async () => {
    const w = signed({ id: 'evt_9', type: 'customer.created', data: { object: { id: 'cus_1' } } });
    expect(await p.verifyWebhook(Buffer.from(w.raw), w.headers)).toMatchObject({ event: 'stripe.ignored' });
  });
});

describe('Stripe purchases end to end', () => {
  it('sends the member to Checkout for a pack, grants credits once when Stripe says it is paid, and ignores a replay', async () => {
    const t = setup();
    const m = await member(t);
    stubStripe({ 'POST /checkout/sessions': () => ({ id: 'cs_test_pack', url: 'https://checkout.stripe.com/c/pay/cs_test_pack' }) });
    const res = await m.post('/billing/packs/order').send({ packCode: 'pack_3' }).expect(201);
    expect(res.body.checkoutUrl).toBe('https://checkout.stripe.com/c/pay/cs_test_pack');
    expect(res.body.orderId).toBe('cs_test_pack');
    expect(await Order.countDocuments({ razorpayOrderId: 'cs_test_pack' })).toBe(1);

    const evt = { id: 'evt_pack', type: 'checkout.session.completed', data: { object: { id: 'cs_test_pack', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_pack', amount_total: res.body.amountPaise, metadata: {} } } };
    const w = signed(evt);
    await request(t.app).post('/api/v1/webhooks/stripe').set(w.headers).send(w.raw).expect(200);
    await request(t.app).post('/api/v1/webhooks/stripe').set(w.headers).send(w.raw).expect(200); // delivered twice
    expect((await User.findById(m.id))!.creditBalance).toBe(3);
    expect(await Payment.countDocuments({})).toBe(1);
    expect(await Invoice.countDocuments({})).toBe(1);

    const bad = signed(evt, 'whsec_nope');
    await request(t.app).post('/api/v1/webhooks/stripe').set(bad.headers).send(bad.raw).expect(401);
  });

  it('confirms a returning member by asking Stripe, never by trusting the browser', async () => {
    const t = setup();
    const m = await member(t);
    stubStripe({ 'POST /checkout/sessions': () => ({ id: 'cs_test_ret', url: 'https://checkout.stripe.com/x' }) });
    const res = await m.post('/billing/packs/order').send({ packCode: 'pack_1' }).expect(201);

    stubStripe({ 'GET /checkout/sessions/cs_test_ret': () => ({ payment_status: 'unpaid', amount_total: res.body.amountPaise, payment_intent: null }) });
    expect((await m.post('/billing/confirm').send({ orderId: 'cs_test_ret', paymentId: 'x', signature: 'x' }).expect(200)).body.status).toBe('pending');
    expect((await User.findById(m.id))!.creditBalance).toBe(0);

    stubStripe({ 'GET /checkout/sessions/cs_test_ret': () => ({ payment_status: 'paid', amount_total: res.body.amountPaise, payment_intent: 'pi_ret' }) });
    expect((await m.post('/billing/confirm').send({ orderId: 'cs_test_ret', paymentId: 'x', signature: 'x' }).expect(200)).body.status).toBe('paid');
    expect((await User.findById(m.id))!.creditBalance).toBe(1);
  });

  it('starts a subscription on Checkout and activates it, with credits and an invoice, when the first invoice is paid', async () => {
    const t = setup();
    const m = await member(t);
    // A plan id saved earlier by another gateway (here the mock, with no gateway recorded) must never be sent to Stripe.
    await mongoose.connection.collection('plans').insertOne({ code: 'premium', kind: 'subscription', name: 'Premium', prices: { monthly: 249_900 }, credits: 4, razorpayPlanIds: { monthly: { id: 'plan_13d826b', amount: 249_900 } } });
    const calls = stubStripe({
      'POST /prices': () => ({ id: 'price_premium_m' }),
      'POST /checkout/sessions': () => ({ id: 'cs_test_sub', url: 'https://checkout.stripe.com/c/pay/cs_test_sub' }),
    });
    const res = await m.post('/billing/subscribe').send({ planCode: 'premium', interval: 'monthly' }).expect(201);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /prices', 'POST /checkout/sessions']);
    expect(calls[1]!.body.get('line_items[0][price]')).toBe('price_premium_m');
    expect(res.body.checkoutUrl).toBe('https://checkout.stripe.com/c/pay/cs_test_sub');
    const ref = res.body.subscriptionId as string;
    expect(ref).toMatch(/^sub_ref_/);
    expect((await Subscription.findOne({ razorpaySubscriptionId: ref }))!.status).toBe('created');

    const now = Math.floor(Date.now() / 1000);
    stubStripe({
      'GET /invoices/in_1': () => ({ id: 'in_1', amount_paid: 249_900, payment_intent: 'pi_sub1' }),
      'GET /subscriptions/sub_123': () => ({
        id: 'sub_123',
        status: 'active',
        metadata: { ref, userId: m.id, planCode: 'premium', interval: 'monthly' },
        current_period_start: now,
        current_period_end: now + 30 * 86_400,
        items: { data: [{ id: 'si_1', price: { id: 'price_premium_m' } }] },
      }),
    });
    const evt = { id: 'evt_inv1', type: 'invoice.paid', data: { object: { id: 'in_1', billing_reason: 'subscription_create', subscription: 'sub_123', amount_paid: 249_900 } } };
    const w = signed(evt);
    await request(t.app).post('/api/v1/webhooks/stripe').set(w.headers).send(w.raw).expect(200);

    const sub = await Subscription.findOne({ razorpaySubscriptionId: ref });
    expect(sub?.status).toBe('active');
    expect(sub?.currentPeriodEnd).toBeTruthy();
    expect((await User.findById(m.id))!.creditBalance).toBeGreaterThan(0);
    expect(await Payment.countDocuments({ razorpayPaymentId: 'pi_sub1', kind: 'subscription' })).toBe(1);
    expect(await Invoice.countDocuments({})).toBe(1);

    // An invoice that is only an upgrade adjustment is not a new cycle.
    const adj = signed({ id: 'evt_adj', type: 'invoice.paid', data: { object: { id: 'in_2', billing_reason: 'subscription_update', subscription: 'sub_123', amount_paid: 5000 } } });
    await request(t.app).post('/api/v1/webhooks/stripe').set(adj.headers).send(adj.raw).expect(200);
    expect(await Payment.countDocuments({ kind: 'subscription' })).toBe(1);
  });
});
