import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from './errors';
import type { PaymentProvider, ProviderPayment, ProviderSubscription, WebhookEvent } from './payments';

/**
 * Stripe adapter. Members pay on Stripe's hosted Checkout page, so card details never touch this system. Stripe's events
 * are translated into the shapes the billing service already understands (it was written around Razorpay's events), and
 * every call is pinned to one API version so the shapes stay the same.
 *
 * Money is in paise throughout (Stripe's smallest INR unit). A subscription is identified here by a reference we create
 * ourselves (`ref`), stored in the subscription's metadata, because Stripe only creates the subscription once the member
 * has paid on the Checkout page.
 */
const STRIPE_VERSION = '2024-06-20';
const PERIOD = { monthly: { interval: 'month', count: 1 }, quarterly: { interval: 'month', count: 3 }, annual: { interval: 'year', count: 1 } } as const;
const TOLERANCE_SEC = 300;

type Params = Record<string, unknown>;

/** Stripe takes nested form fields: a[b][0][c]=1. An empty string unsets a field. */
export function formEncode(params: Params): string {
  const out = new URLSearchParams();
  const add = (key: string, v: unknown): void => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => add(`${key}[${i}]`, x));
    else if (typeof v === 'object') for (const [k, x] of Object.entries(v as Params)) add(`${key}[${k}]`, x);
    else out.append(key, String(v));
  };
  for (const [k, v] of Object.entries(params)) add(k, v);
  return out.toString();
}

interface StripeSub {
  id: string;
  status: string;
  customer?: string;
  metadata?: Record<string, string>;
  pause_collection?: unknown;
  cancel_at_period_end?: boolean;
  current_period_start?: number;
  current_period_end?: number;
  items?: { data: { id: string; current_period_start?: number; current_period_end?: number; price?: { id: string } }[] };
}
interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown>; previous_attributes?: Record<string, unknown> };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string' ? (v as { id: string }).id : undefined);

/** Stripe's subscription status, in the words the billing service uses. */
function stateOf(s: StripeSub): string {
  if (s.pause_collection) return 'paused';
  switch (s.status) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
      return 'pending';
    case 'unpaid':
      return 'halted';
    case 'canceled':
      return 'cancelled';
    case 'incomplete_expired':
      return 'expired';
    default:
      return 'created';
  }
}

const periodOf = (s: StripeSub) => ({
  start: s.current_period_start ?? s.items?.data?.[0]?.current_period_start,
  end: s.current_period_end ?? s.items?.data?.[0]?.current_period_end,
});

export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe' as const;

  constructor(
    private readonly secretKey: string,
    /** Stripe's publishable key, if you want it sent to the browser. Hosted Checkout does not need it. */
    readonly keyId: string,
    private readonly webhookSecret: string,
    private readonly appUrl: string,
  ) {}

  // ------------------------------------------------------------ plumbing

  private async call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Params = {}): Promise<T> {
    const query = method === 'GET' && Object.keys(params).length ? `?${formEncode(params)}` : '';
    const res = await fetch(`https://api.stripe.com/v1${path}${query}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Stripe-Version': STRIPE_VERSION,
        ...(method === 'POST' && { 'Content-Type': 'application/x-www-form-urlencoded' }),
      },
      body: method === 'POST' ? formEncode(params) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const e = ((await res.json().catch(() => ({}))) as { error?: { type?: string; code?: string; message?: string } }).error ?? {};
      // 401 means the secret key is wrong; the Stripe message says which object it could not find or why it refused.
      throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'We could not complete that with our payment provider. Please try again in a moment.', {
        provider: 'stripe',
        status: res.status,
        request: `${method} ${path}`,
        code: e.code,
        detail: e.message?.slice(0, 200),
      });
    }
    return (await res.json()) as T;
  }

  private returnUrl(query: string) {
    return `${this.appUrl.replace(/\/$/, '')}/billing?${query}`;
  }

  private async findSub(ref: string): Promise<StripeSub | null> {
    const safeRef = ref.replace(/[^A-Za-z0-9_-]/g, '');
    const r = await this.call<{ data: StripeSub[] }>('GET', '/subscriptions/search', { query: `metadata['ref']:'${safeRef}'`, limit: 1 });
    return r.data[0] ?? null;
  }

  private async toSub(ref: string, s: StripeSub | null, withPortal = false): Promise<ProviderSubscription> {
    if (!s) return { id: ref, status: 'created', planId: '' }; // the member has not finished paying yet
    const p = periodOf(s);
    let shortUrl: string | undefined;
    if (withPortal && s.customer && stateOf(s) !== 'cancelled') {
      // The page where the member updates their card. It needs the Customer portal switched on in the Stripe dashboard.
      shortUrl = await this.call<{ url: string }>('POST', '/billing_portal/sessions', { customer: s.customer, return_url: this.returnUrl('portal=return') })
        .then((r) => r.url)
        .catch(() => undefined);
    }
    return { id: ref, status: stateOf(s), planId: s.items?.data?.[0]?.price?.id ?? '', currentStart: p.start, currentEnd: p.end, shortUrl };
  }

  // ------------------------------------------------------------ one-off packs

  async createOrder(i: { amountPaise: number; receipt: string; notes: Record<string, string>; description?: string }) {
    const s = await this.call<{ id: string; url: string }>('POST', '/checkout/sessions', {
      mode: 'payment',
      success_url: this.returnUrl('checkout=success&order={CHECKOUT_SESSION_ID}'),
      cancel_url: this.returnUrl('checkout=cancelled'),
      client_reference_id: i.receipt,
      metadata: { ...i.notes, receipt: i.receipt },
      payment_intent_data: { metadata: i.notes },
      line_items: [{ quantity: 1, price_data: { currency: 'inr', unit_amount: i.amountPaise, product_data: { name: i.description ?? 'Marchmaker introduction credits' } } }],
    });
    return { id: s.id, checkoutUrl: s.url };
  }

  async fetchOrderPayments(orderId: string): Promise<ProviderPayment[]> {
    const s = await this.call<{ payment_status: string; amount_total: number; payment_intent?: string | { id: string; status?: string; last_payment_error?: unknown } }>('GET', `/checkout/sessions/${orderId}`, {
      expand: ['payment_intent'],
    });
    const pi = typeof s.payment_intent === 'object' ? s.payment_intent : undefined;
    const id = str(s.payment_intent) ?? orderId;
    if (s.payment_status === 'paid') return [{ id, orderId, status: 'captured', amount: s.amount_total, method: 'card' }];
    if (pi?.last_payment_error) return [{ id, orderId, status: 'failed', amount: s.amount_total, method: 'card' }];
    return [];
  }

  async refund(paymentId: string, amountPaise: number) {
    const r = await this.call<{ id: string; status: string }>('POST', '/refunds', { payment_intent: paymentId, amount: amountPaise });
    return { id: r.id, status: r.status === 'succeeded' ? 'processed' : r.status };
  }

  // ------------------------------------------------------------ subscriptions

  async createPlan(i: { name: string; amountPaise: number; interval: 'monthly' | 'quarterly' | 'annual' }) {
    const p = PERIOD[i.interval];
    const r = await this.call<{ id: string }>('POST', '/prices', {
      currency: 'inr',
      unit_amount: i.amountPaise,
      recurring: { interval: p.interval, interval_count: p.count },
      product_data: { name: i.name },
    });
    return { id: r.id };
  }

  async createSubscription(i: { planId: string; totalCount: number; notes: Record<string, string>; offerId?: string }): Promise<ProviderSubscription> {
    const ref = `sub_ref_${randomBytes(12).toString('hex')}`;
    const meta = { ...i.notes, ref };
    const s = await this.call<{ id: string; url: string }>('POST', '/checkout/sessions', {
      mode: 'subscription',
      success_url: this.returnUrl(`checkout=success&sub=${ref}`),
      cancel_url: this.returnUrl('checkout=cancelled'),
      client_reference_id: ref,
      metadata: meta,
      subscription_data: { metadata: meta },
      line_items: [{ price: i.planId, quantity: 1 }],
      // A coupon created in Stripe can be stored on the plan's offer id.
      ...(i.offerId && { discounts: [{ coupon: i.offerId }] }),
    });
    return { id: ref, status: 'created', planId: i.planId, shortUrl: s.url };
  }

  async getSubscription(ref: string) {
    return this.toSub(ref, await this.findSub(ref), true);
  }

  async updateSubscription(ref: string, i: { planId: string; when: 'now' | 'cycle_end' }) {
    const s = await this.findSub(ref);
    const item = s?.items?.data?.[0];
    if (!s || !item) throw new AppError(409, 'NO_SUBSCRIPTION', 'We could not find that subscription at our payment provider');
    // The period already paid for is not charged again. The new price applies from the next renewal for a later
    // change, and with the difference added to the next invoice for an upgrade; the app itself decides when the
    // member's access and credits change.
    const updated = await this.call<StripeSub>('POST', `/subscriptions/${s.id}`, {
      items: [{ id: item.id, price: i.planId }],
      proration_behavior: i.when === 'now' ? 'create_prorations' : 'none',
    });
    return this.toSub(ref, updated);
  }

  async cancelSubscription(ref: string, atCycleEnd: boolean) {
    const s = await this.findSub(ref);
    if (!s) throw new AppError(409, 'NO_SUBSCRIPTION', 'We could not find that subscription at our payment provider');
    const updated = atCycleEnd
      ? await this.call<StripeSub>('POST', `/subscriptions/${s.id}`, { cancel_at_period_end: true })
      : await this.call<StripeSub>('DELETE', `/subscriptions/${s.id}`);
    return this.toSub(ref, updated);
  }

  async pauseSubscription(ref: string) {
    const s = await this.findSub(ref);
    if (!s) throw new AppError(409, 'NO_SUBSCRIPTION', 'We could not find that subscription at our payment provider');
    return this.toSub(ref, await this.call<StripeSub>('POST', `/subscriptions/${s.id}`, { pause_collection: { behavior: 'void' } }));
  }

  async resumeSubscription(ref: string) {
    const s = await this.findSub(ref);
    if (!s) throw new AppError(409, 'NO_SUBSCRIPTION', 'We could not find that subscription at our payment provider');
    return this.toSub(ref, await this.call<StripeSub>('POST', `/subscriptions/${s.id}`, { pause_collection: '' }));
  }

  // ------------------------------------------------------------ webhooks

  /** Checks Stripe's signature (a timestamp plus an HMAC of "timestamp.body"), then translates the event. */
  async verifyWebhook(raw: Buffer, headers: Record<string, string | undefined>): Promise<WebhookEvent | null> {
    const header = headers['stripe-signature'];
    if (!header || !this.webhookSecret) return null;
    const parts = header.split(',').map((p) => p.trim().split('='));
    const t = parts.find(([k]) => k === 't')?.[1];
    const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v ?? '');
    if (!t || sigs.length === 0 || Math.abs(Date.now() / 1000 - Number(t)) > TOLERANCE_SEC) return null;
    const want = Buffer.from(createHmac('sha256', this.webhookSecret).update(`${t}.${raw.toString('utf8')}`).digest('hex'));
    const ok = sigs.some((s) => s.length === want.length && timingSafeEqual(Buffer.from(s), want));
    if (!ok) return null;
    let ev: StripeEvent;
    try {
      ev = JSON.parse(raw.toString('utf8')) as StripeEvent;
    } catch {
      return null;
    }
    if (!ev.id || !ev.type || !ev.data?.object) return null;
    return this.translate(ev);
  }

  private async translate(ev: StripeEvent): Promise<WebhookEvent> {
    const o = ev.data.object;
    const done = (event: string, payload: Record<string, unknown>): WebhookEvent => ({ eventId: ev.id, event, payload });
    const ignored = done('stripe.ignored', { type: ev.type });
    const meta = (o.metadata ?? {}) as Record<string, string>;

    switch (ev.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        if (o.mode === 'payment') {
          if (o.payment_status !== 'paid') return ignored;
          return done('payment.captured', {
            payment: { entity: { id: str(o.payment_intent) ?? String(o.id), amount: Number(o.amount_total), status: 'captured', order_id: String(o.id), method: 'card', notes: meta } },
          });
        }
        if (o.mode === 'subscription') {
          const ref = meta.ref ?? str(o.client_reference_id);
          return ref ? done('subscription.authenticated', { subscription: { entity: { id: ref, status: 'authenticated', notes: meta } } }) : ignored;
        }
        return ignored;
      }
      case 'checkout.session.async_payment_failed':
        return done('payment.failed', {
          payment: { entity: { id: str(o.payment_intent) ?? String(o.id), amount: Number(o.amount_total ?? 0), status: 'failed', order_id: String(o.id), error_code: 'payment_failed', notes: meta } },
        });

      case 'invoice.paid': {
        const reason = String(o.billing_reason ?? '');
        if (reason !== 'subscription_create' && reason !== 'subscription_cycle') return ignored; // upgrades and manual invoices are not new cycles
        const subId = str(o.subscription);
        if (!subId || !Number(o.amount_paid)) return ignored;
        // Read the invoice and subscription back through the pinned API version, so their shapes are the ones we expect.
        const invoice = await this.call<{ id: string; amount_paid: number; payment_intent?: string | { id: string }; charge?: string }>('GET', `/invoices/${String(o.id)}`);
        const sub = await this.call<StripeSub>('GET', `/subscriptions/${subId}`);
        const ref = sub.metadata?.ref;
        if (!ref) return ignored;
        const p = periodOf(sub);
        return done('subscription.charged', {
          subscription: { entity: { id: ref, status: 'active', plan_id: sub.items?.data?.[0]?.price?.id, current_start: p.start, current_end: p.end, notes: sub.metadata } },
          payment: { entity: { id: str(invoice.payment_intent) ?? invoice.charge ?? invoice.id, amount: invoice.amount_paid, status: 'captured', subscription_id: ref, method: 'card' } },
        });
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = o as unknown as StripeSub;
        const ref = sub.metadata?.ref;
        if (!ref) return ignored;
        const p = periodOf(sub);
        const status = ev.type === 'customer.subscription.deleted' ? 'cancelled' : stateOf(sub);
        return done(`subscription.${status === 'cancelled' ? 'cancelled' : 'updated'}`, {
          subscription: { entity: { id: ref, status, plan_id: sub.items?.data?.[0]?.price?.id, current_start: p.start, current_end: p.end, notes: sub.metadata } },
        });
      }

      case 'charge.refunded': {
        const pi = str(o.payment_intent);
        if (!pi) return ignored;
        const list = await this.call<{ data: { id: string; amount: number; status: string }[] }>('GET', '/refunds', { payment_intent: pi, limit: 1 });
        const r = list.data[0];
        if (!r || r.status !== 'succeeded') return ignored;
        return done('refund.processed', { refund: { entity: { id: r.id, payment_id: pi, amount: r.amount, status: 'processed' } } });
      }
      default:
        return ignored;
    }
  }

  /** A hosted Checkout return carries no signed proof, so none is checked: the server asks Stripe what was paid. */
  verifyCheckout() {
    return true;
  }
}
