import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Env } from '../config/env';

export interface ProviderSubscription {
  id: string;
  status: string;
  planId: string;
  currentStart?: number; // epoch seconds
  currentEnd?: number;
  paidCount?: number;
  shortUrl?: string;
}

export interface ProviderPayment {
  id: string;
  orderId?: string;
  subscriptionId?: string;
  status: string; // captured, failed, authorized, refunded...
  amount: number;
  method?: string;
  /** Card id or UPI address, if the gateway reports one. */
  instrument?: string;
}

export interface WebhookEvent {
  eventId: string;
  event: string;
  payload: Record<string, unknown>;
}

export interface PaymentProvider {
  readonly name: 'mock' | 'razorpay';
  readonly keyId: string;
  createOrder(i: { amountPaise: number; receipt: string; notes: Record<string, string> }): Promise<{ id: string }>;
  createPlan(i: { name: string; amountPaise: number; interval: 'monthly' | 'quarterly' | 'annual' }): Promise<{ id: string }>;
  createSubscription(i: {
    planId: string;
    totalCount: number;
    notes: Record<string, string>;
    offerId?: string;
  }): Promise<ProviderSubscription>;
  getSubscription(id: string): Promise<ProviderSubscription>;
  updateSubscription(id: string, i: { planId: string; when: 'now' | 'cycle_end' }): Promise<ProviderSubscription>;
  cancelSubscription(id: string, atCycleEnd: boolean): Promise<ProviderSubscription>;
  /** Stops charging from now; the member keeps what they already paid for. */
  pauseSubscription(id: string): Promise<ProviderSubscription>;
  resumeSubscription(id: string): Promise<ProviderSubscription>;
  fetchOrderPayments(orderId: string): Promise<ProviderPayment[]>;
  refund(paymentId: string, amountPaise: number): Promise<{ id: string; status: string }>;
  /** Webhook: valid signature gives the parsed event, otherwise null. */
  verifyWebhook(raw: Buffer, headers: Record<string, string | undefined>): WebhookEvent | null;
  /** Checkout callback signature. Only used to show "confirming"; never to grant anything. */
  verifyCheckout(i: { orderId?: string; subscriptionId?: string; paymentId: string; signature: string }): boolean;
}

const hmac = (secret: string, data: string | Buffer) => createHmac('sha256', secret).update(data).digest('hex');
const safe = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function signWebhookBody(secret: string, body: string): string {
  return hmac(secret, body);
}

function parseWebhook(raw: Buffer, headers: Record<string, string | undefined>, secret: string): WebhookEvent | null {
  const sig = headers['x-razorpay-signature'];
  if (!sig || !safe(hmac(secret, raw), sig.trim())) return null;
  try {
    const body = JSON.parse(raw.toString('utf8')) as { event?: string; payload?: Record<string, unknown> };
    if (!body.event || !body.payload) return null;
    // Razorpay sends a unique event id header; fall back to a body hash so replays still dedupe.
    const eventId = headers['x-razorpay-event-id'] ?? `h_${hmac('event-id', raw).slice(0, 40)}`;
    return { eventId, event: body.event, payload: body.payload };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ mock

/** In-memory provider for development and tests. Mirrors Razorpay's states closely enough to exercise the flows. */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock' as const;
  readonly keyId = 'mock_key';
  readonly subscriptions = new Map<string, ProviderSubscription>();
  readonly orderPayments = new Map<string, ProviderPayment[]>();
  readonly plans = new Map<string, { name: string; amountPaise: number; interval: string }>();
  readonly refunds: { paymentId: string; amountPaise: number }[] = [];
  failNext: string | null = null;
  private n = 0;

  constructor(private readonly secret: string) {}

  private id(prefix: string) {
    return `${prefix}_${++this.n}${randomBytes(3).toString('hex')}`;
  }
  private guard() {
    if (this.failNext) {
      const m = this.failNext;
      this.failNext = null;
      throw new Error(m);
    }
  }

  async createOrder() {
    this.guard();
    const id = this.id('order');
    this.orderPayments.set(id, []);
    return { id };
  }
  async createPlan(i: { name: string; amountPaise: number; interval: 'monthly' | 'quarterly' | 'annual' }) {
    this.guard();
    const id = this.id('plan');
    this.plans.set(id, i);
    return { id };
  }
  async createSubscription(i: { planId: string }) {
    this.guard();
    const id = this.id('sub');
    const sub: ProviderSubscription = { id, status: 'created', planId: i.planId, shortUrl: `https://pay.mock.invalid/${id}` };
    this.subscriptions.set(id, sub);
    return sub;
  }
  async getSubscription(id: string) {
    this.guard();
    const s = this.subscriptions.get(id);
    if (!s) throw new Error('subscription not found');
    return s;
  }
  async updateSubscription(id: string, i: { planId: string; when: 'now' | 'cycle_end' }) {
    this.guard();
    const s = await this.getSubscription(id);
    if (i.when === 'now') s.planId = i.planId;
    return s;
  }
  async cancelSubscription(id: string, atCycleEnd: boolean) {
    this.guard();
    const s = await this.getSubscription(id);
    if (!atCycleEnd) s.status = 'cancelled';
    return s;
  }
  async pauseSubscription(id: string) {
    this.guard();
    const s = await this.getSubscription(id);
    s.status = 'paused';
    return s;
  }
  async resumeSubscription(id: string) {
    this.guard();
    const s = await this.getSubscription(id);
    s.status = 'active';
    return s;
  }
  async fetchOrderPayments(orderId: string) {
    this.guard();
    return this.orderPayments.get(orderId) ?? [];
  }
  async refund(paymentId: string, amountPaise: number) {
    this.guard();
    this.refunds.push({ paymentId, amountPaise });
    return { id: this.id('rfnd'), status: 'processed' };
  }
  verifyWebhook(raw: Buffer, headers: Record<string, string | undefined>) {
    return parseWebhook(raw, headers, this.secret);
  }
  verifyCheckout(i: { orderId?: string; subscriptionId?: string; paymentId: string; signature: string }) {
    const data = i.orderId ? `${i.orderId}|${i.paymentId}` : `${i.paymentId}|${i.subscriptionId}`;
    return safe(hmac(this.secret, data), i.signature);
  }

  // ---- test and development helpers
  /** Produces a signed webhook request exactly as the provider would send it. */
  webhook(event: string, payload: Record<string, unknown>, eventId = this.id('evt')) {
    const body = JSON.stringify({ entity: 'event', event, payload });
    return { body, headers: { 'x-razorpay-signature': hmac(this.secret, body), 'x-razorpay-event-id': eventId, 'content-type': 'application/json' } };
  }
  paymentEntity(p: Partial<ProviderPayment> & { id: string; amount: number }, notes: Record<string, string> = {}) {
    return { entity: { entity: 'payment', status: 'captured', currency: 'INR', method: 'upi', notes, order_id: p.orderId, subscription_id: p.subscriptionId, ...p } };
  }
  subscriptionEntity(s: ProviderSubscription, notes: Record<string, string> = {}) {
    return {
      entity: {
        entity: 'subscription',
        id: s.id,
        status: s.status,
        plan_id: s.planId,
        current_start: s.currentStart,
        current_end: s.currentEnd,
        paid_count: s.paidCount ?? 0,
        short_url: s.shortUrl,
        notes,
      },
    };
  }
  checkoutSignature(i: { orderId?: string; subscriptionId?: string; paymentId: string }) {
    const data = i.orderId ? `${i.orderId}|${i.paymentId}` : `${i.paymentId}|${i.subscriptionId}`;
    return hmac(this.secret, data);
  }
}

// ------------------------------------------------------------------ razorpay

const PERIODS: Record<'monthly' | 'quarterly' | 'annual', { period: string; interval: number }> = {
  monthly: { period: 'monthly', interval: 1 },
  quarterly: { period: 'monthly', interval: 3 },
  annual: { period: 'yearly', interval: 1 },
};

/** Razorpay REST adapter (Orders, Plans, Subscriptions, Refunds). Needs real keys; not exercised by the test suite. */
export class RazorpayProvider implements PaymentProvider {
  readonly name = 'razorpay' as const;
  constructor(
    readonly keyId: string,
    private readonly keySecret: string,
    private readonly webhookSecret: string,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`https://api.razorpay.com/v1${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`razorpay ${method} ${path} returned ${res.status}`);
    return (await res.json()) as T;
  }

  private toSub(r: {
    id: string;
    status: string;
    plan_id: string;
    current_start?: number;
    current_end?: number;
    paid_count?: number;
    short_url?: string;
  }): ProviderSubscription {
    return {
      id: r.id,
      status: r.status,
      planId: r.plan_id,
      currentStart: r.current_start,
      currentEnd: r.current_end,
      paidCount: r.paid_count,
      shortUrl: r.short_url,
    };
  }

  async createOrder(i: { amountPaise: number; receipt: string; notes: Record<string, string> }) {
    const r = await this.call<{ id: string }>('POST', '/orders', {
      amount: i.amountPaise,
      currency: 'INR',
      receipt: i.receipt,
      notes: i.notes,
    });
    return { id: r.id };
  }
  async createPlan(i: { name: string; amountPaise: number; interval: 'monthly' | 'quarterly' | 'annual' }) {
    const p = PERIODS[i.interval];
    const r = await this.call<{ id: string }>('POST', '/plans', {
      period: p.period,
      interval: p.interval,
      item: { name: i.name, amount: i.amountPaise, currency: 'INR' },
    });
    return { id: r.id };
  }
  async createSubscription(i: { planId: string; totalCount: number; notes: Record<string, string>; offerId?: string }) {
    const r = await this.call<Parameters<RazorpayProvider['toSub']>[0]>('POST', '/subscriptions', {
      plan_id: i.planId,
      total_count: i.totalCount,
      customer_notify: 1,
      notes: i.notes,
      ...(i.offerId && { offer_id: i.offerId }),
    });
    return this.toSub(r);
  }
  async getSubscription(id: string) {
    return this.toSub(await this.call('GET', `/subscriptions/${id}`));
  }
  async updateSubscription(id: string, i: { planId: string; when: 'now' | 'cycle_end' }) {
    return this.toSub(await this.call('PATCH', `/subscriptions/${id}`, { plan_id: i.planId, schedule_change_at: i.when }));
  }
  async cancelSubscription(id: string, atCycleEnd: boolean) {
    return this.toSub(await this.call('POST', `/subscriptions/${id}/cancel`, { cancel_at_cycle_end: atCycleEnd ? 1 : 0 }));
  }
  async pauseSubscription(id: string) {
    return this.toSub(await this.call('POST', `/subscriptions/${id}/pause`, { pause_at: 'now' }));
  }
  async resumeSubscription(id: string) {
    return this.toSub(await this.call('POST', `/subscriptions/${id}/resume`, { resume_at: 'now' }));
  }
  async fetchOrderPayments(orderId: string) {
    const r = await this.call<{ items: { id: string; order_id?: string; status: string; amount: number; method?: string; card_id?: string; vpa?: string }[] }>(
      'GET',
      `/orders/${orderId}/payments`,
    );
    return r.items.map((p) => ({ id: p.id, orderId: p.order_id, status: p.status, amount: p.amount, method: p.method, instrument: p.card_id ?? p.vpa }));
  }
  async refund(paymentId: string, amountPaise: number) {
    const r = await this.call<{ id: string; status: string }>('POST', `/payments/${paymentId}/refund`, { amount: amountPaise });
    return { id: r.id, status: r.status };
  }
  verifyWebhook(raw: Buffer, headers: Record<string, string | undefined>) {
    return parseWebhook(raw, headers, this.webhookSecret);
  }
  verifyCheckout(i: { orderId?: string; subscriptionId?: string; paymentId: string; signature: string }) {
    const data = i.orderId ? `${i.orderId}|${i.paymentId}` : `${i.paymentId}|${i.subscriptionId}`;
    return safe(hmac(this.keySecret, data), i.signature);
  }
}

export function createPaymentProvider(env: Env): PaymentProvider | null {
  if (env.PAYMENTS_PROVIDER === 'mock') return new MockPaymentProvider(env.RAZORPAY_WEBHOOK_SECRET);
  if (env.PAYMENTS_PROVIDER === 'razorpay' && env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) {
    return new RazorpayProvider(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET, env.RAZORPAY_WEBHOOK_SECRET);
  }
  return null;
}
