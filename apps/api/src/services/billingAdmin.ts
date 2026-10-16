import { z } from 'zod';
import { DEFAULT_PACKS, DEFAULT_PLANS, BILLING_INTERVALS } from '@marchmaker/shared';
import { conflict, notFound } from '../lib/errors';
import { Plan } from '../models/content';
import { User } from '../models/core';
import { Invoice, Payment, Subscription } from '../models/billing';
import { WebhookEvent } from '../models/verification';

const cursorFilter = (cursor?: string) => (cursor ? { _id: { $lt: cursor } } : {});

export const paymentQuery = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(['captured', 'failed', 'refunded', 'partially_refunded']).optional(),
  kind: z.enum(['pack', 'subscription']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export async function listPayments(q: z.infer<typeof paymentQuery>) {
  const filter: Record<string, unknown> = { ...cursorFilter(q.cursor) };
  if (q.status) filter.status = q.status;
  if (q.kind) filter.kind = q.kind;
  if (q.from || q.to) filter.createdAt = { ...(q.from && { $gte: q.from }), ...(q.to && { $lte: q.to }) };
  if (q.q) {
    const term = q.q.toLowerCase();
    if (term.startsWith('pay_') || term.startsWith('order_') || term.startsWith('sub_')) {
      filter.$or = [{ razorpayPaymentId: q.q }, { razorpayOrderId: q.q }, { razorpaySubscriptionId: q.q }];
    } else {
      const u = await User.findOne({ email: term }).select('_id').lean();
      filter.userId = u?._id ?? null;
    }
  }
  const rows = await Payment.find(filter).sort({ _id: -1 }).limit(q.limit + 1).lean();
  const page = rows.slice(0, q.limit);
  const users = await User.find({ _id: { $in: page.map((p) => p.userId) } }).select('email firstName').lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const invoices = await Invoice.find({ _id: { $in: page.map((p) => p.invoiceId).filter(Boolean) } }).select('number').lean();
  const invNo = new Map(invoices.map((i) => [String(i._id), i.number]));
  return {
    items: page.map((p) => ({
      id: String(p._id),
      at: p.capturedAt ?? p.createdAt,
      userId: String(p.userId),
      email: byId.get(String(p.userId))?.email ?? null,
      name: byId.get(String(p.userId))?.firstName ?? null,
      kind: p.kind,
      planCode: p.planCode ?? null,
      amountPaise: p.amountPaise,
      refundedPaise: p.refundedPaise,
      status: p.status,
      method: p.method ?? null,
      razorpayPaymentId: p.razorpayPaymentId,
      invoiceNumber: p.invoiceId ? (invNo.get(String(p.invoiceId)) ?? null) : null,
      refunds: p.refunds.map((r) => ({ amountPaise: r.amountPaise, reason: r.reason, at: r.at, creditsRevoked: r.creditsRevoked })),
    })),
    nextCursor: rows.length > q.limit ? String(page[page.length - 1]!._id) : null,
  };
}

export async function listSubscriptions(status?: string) {
  const rows = await Subscription.find(status ? { status: status as never } : {}).sort({ updatedAt: -1 }).limit(100).lean();
  const users = await User.find({ _id: { $in: rows.map((r) => r.userId) } }).select('email').lean();
  const email = new Map(users.map((u) => [String(u._id), u.email]));
  return {
    items: rows.map((s) => ({
      id: String(s._id),
      userId: String(s.userId),
      email: email.get(String(s.userId)) ?? null,
      planCode: s.planCode,
      interval: s.interval,
      status: s.status,
      currentPeriodEnd: s.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: s.cancelAtPeriodEnd,
      graceUntil: s.graceUntil ?? null,
      razorpaySubscriptionId: s.razorpaySubscriptionId,
    })),
  };
}

export async function listWebhooks(onlyFailed: boolean) {
  const rows = await WebhookEvent.find({ provider: 'razorpay', ...(onlyFailed && { processedAt: { $exists: false } }) })
    .sort({ _id: -1 })
    .limit(100)
    .lean();
  return {
    items: rows.map((w) => ({
      id: String(w._id),
      eventId: w.eventId,
      event: (w.payload as { event?: string } | undefined)?.event ?? null,
      receivedAt: w.createdAt,
      processedAt: w.processedAt ?? null,
      attempts: w.attempts,
      error: w.error ?? null,
    })),
  };
}

export const planPatchSchema = z.object({
  name: z.string().trim().min(2).max(60).optional(),
  tagline: z.string().trim().max(160).optional(),
  credits: z.number().int().min(0).max(100).optional(),
  fairUseCap: z.number().int().min(0).max(100).optional(),
  features: z.array(z.string().trim().min(1).max(160)).max(12).optional(),
  highlight: z.boolean().optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(100).optional(),
  /** Whole paise, GST inclusive. */
  prices: z.record(z.enum(BILLING_INTERVALS), z.number().int().min(0).max(50_000_000)).optional(),
});

export async function listPlans() {
  const rows = await Plan.find().sort({ sortOrder: 1 }).lean();
  if (rows.length) {
    return rows.map((p) => ({
      code: p.code,
      kind: p.kind,
      name: p.name,
      tagline: p.tagline ?? '',
      prices: p.prices ?? {},
      credits: p.credits,
      fairUseCap: p.fairUseCap ?? null,
      features: p.features,
      highlight: p.highlight,
      active: p.active,
      sortOrder: p.sortOrder,
    }));
  }
  return [...DEFAULT_PLANS, ...DEFAULT_PACKS].map((p) => ({ ...p, tagline: p.tagline, fairUseCap: p.fairUseCap ?? null, active: true }));
}

/** Price changes apply to new checkouts only; existing subscribers keep the plan they bought (D-044). */
export async function updatePlan(code: string, patch: z.infer<typeof planPatchSchema>) {
  const seed = [...DEFAULT_PLANS, ...DEFAULT_PACKS].find((p) => p.code === code);
  const exists = await Plan.exists({ code });
  if (!exists && !seed) throw notFound();
  const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  await Plan.updateOne(
    { code },
    {
      $set: set,
      $setOnInsert: seed
        ? { kind: seed.kind, name: seed.name, tagline: seed.tagline, prices: seed.prices, credits: seed.credits, features: seed.features, sortOrder: seed.sortOrder, ...set }
        : {},
    },
    { upsert: true },
  );
  return (await listPlans()).find((p) => p.code === code);
}

export const planCreateSchema = planPatchSchema.extend({
  code: z.string().regex(/^[a-z][a-z0-9_]{1,19}$/, 'Use lowercase letters, digits and underscores'),
  kind: z.enum(['pack', 'subscription']),
  name: z.string().trim().min(2).max(60),
  credits: z.number().int().min(0).max(100),
  prices: z.partialRecord(z.enum(BILLING_INTERVALS), z.number().int().min(0).max(50_000_000)),
});

/** New plans start inactive so the price can be checked before anyone can buy; archive = active:false. */
export async function createPlan(input: z.infer<typeof planCreateSchema>) {
  const seed = [...DEFAULT_PLANS, ...DEFAULT_PACKS].some((p) => p.code === input.code);
  if (seed || (await Plan.exists({ code: input.code }))) throw conflict('A plan with that code already exists');
  await Plan.create({ ...input, features: input.features ?? [], active: input.active ?? false, sortOrder: input.sortOrder ?? 50 });
  return (await listPlans()).find((p) => p.code === input.code);
}

const escapeRegex = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, (c) => '\\' + c);

export const invoiceQuery = z.object({
  q: z.string().trim().max(40).optional(),
  kind: z.enum(['invoice', 'credit_note']).optional(),
  cursor: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export async function listInvoices(q: z.infer<typeof invoiceQuery>) {
  const rows = await Invoice.find({
    ...cursorFilter(q.cursor),
    ...(q.kind ? { kind: q.kind } : {}),
    ...(q.q ? { number: { $regex: '^' + escapeRegex(q.q), $options: 'i' } } : {}),
  })
    .sort({ _id: -1 })
    .limit(q.limit + 1)
    .lean();
  const page = rows.slice(0, q.limit);
  return {
    items: page.map((i) => ({ id: String(i._id), number: i.number, kind: i.kind, userId: String(i.userId), issuedAt: i.issuedAt, totalPaise: i.tax?.totalPaise ?? 0 })),
    nextCursor: rows.length > q.limit ? String(page[page.length - 1]?._id) : null,
  };
}
