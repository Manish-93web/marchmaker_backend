import type { Request } from 'express';
import { Types } from 'mongoose';
import { LEGAL_TYPES, type LegalType, type Role } from '@marchmaker/shared';
import { z } from 'zod';
import { audit } from '../lib/audit';
import { AppError, conflict, notFound } from '../lib/errors';
import { LegalDocument } from '../models/auth';
import { Faq, SavedFilter } from '../models/cms';
import { Payment, Subscription } from '../models/billing';
import { Introduction } from '../models/matching';
import { User } from '../models/core';
import { Report, CreditLedger } from '../models/social';
import { Ticket } from '../models/safety';
import { WalletLedger } from '../models/referrals';
import { Invoice } from '../models/billing';

interface Actor {
  userId: string;
  roles: Role[];
}
const sid = (v: unknown) => String(v);

// ------------------------------------------------------------------ legal documents

export const legalVersionSchema = z.object({
  type: z.enum(LEGAL_TYPES as unknown as [LegalType, ...LegalType[]]),
  title: z.string().trim().min(3).max(140),
  markdown: z.string().trim().min(50).max(200_000),
  /** A material change makes every member accept the new version before continuing. */
  material: z.boolean().default(true),
  effectiveDate: z.coerce.date().optional(),
});

export async function listLegal() {
  const rows = await LegalDocument.find().sort({ type: 1, effectiveDate: -1 }).select('-markdown').lean();
  const grouped: Record<string, { version: string; title: string; effectiveDate: Date; material: boolean; live: boolean }[]> = {};
  const now = new Date();
  for (const r of rows) {
    (grouped[r.type] ??= []).push({ version: r.version, title: r.title, effectiveDate: r.effectiveDate, material: r.material, live: false });
  }
  for (const list of Object.values(grouped)) {
    const live = list.find((d) => d.effectiveDate <= now);
    if (live) live.live = true;
  }
  return { items: Object.entries(grouped).map(([type, versions]) => ({ type, versions })) };
}

export async function legalVersion(type: LegalType, version: string) {
  const d = await LegalDocument.findOne({ type, version }).lean();
  if (!d) throw notFound();
  return { type: d.type, version: d.version, title: d.title, markdown: d.markdown, effectiveDate: d.effectiveDate, material: d.material };
}

/**
 * Published versions are never edited: a change is a new version. The default is to take effect now; a
 * later date gives members notice. Material changes send everyone back through acceptance.
 */
export async function publishLegal(req: Request, input: z.infer<typeof legalVersionSchema>, actor: Actor) {
  const count = await LegalDocument.countDocuments({ type: input.type });
  const version = `v${count + 1}`;
  const effectiveDate = input.effectiveDate ?? new Date();
  if (effectiveDate.getTime() < Date.now() - 60_000) throw new AppError(422, 'VALIDATION_ERROR', 'The effective date cannot be in the past');
  await LegalDocument.create({ ...input, version, effectiveDate, publishedBy: actor.userId });
  await audit(req, {
    action: 'legal.version_published',
    actorId: actor.userId,
    actorRoles: actor.roles,
    subjectType: 'legal',
    subjectId: `${input.type}:${version}`,
    after: { material: input.material, effectiveDate },
  });
  return { type: input.type, version, effectiveDate };
}

// ------------------------------------------------------------------ FAQ

export const faqSchema = z.object({
  question: z.string().trim().min(5).max(240),
  answer: z.string().trim().min(5).max(4000),
  category: z.string().trim().max(40).optional(),
  sortOrder: z.number().int().min(0).max(1000).default(0),
  published: z.boolean().default(false),
});

const presentFaq = (f: { _id: unknown; question: string; answer: string; category?: string | null; sortOrder: number; published: boolean }) => ({
  id: sid(f._id),
  question: f.question,
  answer: f.answer,
  category: f.category ?? null,
  sortOrder: f.sortOrder,
  published: f.published,
});

export async function publicFaqs() {
  const rows = await Faq.find({ published: true }).sort({ sortOrder: 1, createdAt: 1 }).limit(200).lean();
  return { items: rows.map((f) => ({ question: f.question, answer: f.answer, category: f.category ?? null })) };
}
export async function adminFaqs() {
  return { items: (await Faq.find().sort({ sortOrder: 1, createdAt: 1 }).limit(300).lean()).map(presentFaq) };
}
export async function saveFaq(req: Request, id: string | null, input: z.infer<typeof faqSchema>, actor: Actor) {
  const f = id ? await Faq.findByIdAndUpdate(id, { $set: { ...input, updatedBy: actor.userId } }, { returnDocument: 'after' }) : await Faq.create({ ...input, updatedBy: actor.userId });
  if (!f) throw notFound();
  await audit(req, { action: id ? 'faq.updated' : 'faq.created', actorId: actor.userId, actorRoles: actor.roles, subjectType: 'faq', subjectId: sid(f._id) });
  return presentFaq(f);
}
export async function deleteFaq(req: Request, id: string, actor: Actor) {
  const r = await Faq.deleteOne({ _id: id });
  if (!r.deletedCount) throw notFound();
  await audit(req, { action: 'faq.deleted', actorId: actor.userId, actorRoles: actor.roles, subjectType: 'faq', subjectId: id });
  return { deleted: true };
}

// ------------------------------------------------------------------ introductions monitor

export async function introductionsMonitor(filter: { state?: string; attention?: boolean }) {
  const now = Date.now();
  const q: Record<string, unknown> = {};
  if (filter.state && filter.state !== 'all') q.state = filter.state;
  else q.state = { $in: ['released', 'viewed', 'accepted_by_one'] };
  const rows = await Introduction.find(q).sort({ expiresAt: 1 }).limit(300).lean();
  const users = await User.find({ _id: { $in: rows.flatMap((r) => r.members.map((m) => m.userId)) } }).select('firstName').lean();
  const names = new Map(users.map((u) => [sid(u._id), u.firstName]));
  const items = rows.map((r) => {
    const hoursLeft = Math.round(((r.expiresAt.getTime() - now) / 3_600_000) * 10) / 10;
    const notViewed = r.state === 'released' && now - r.releasedAt.getTime() > 48 * 3_600_000;
    const closing = ['released', 'viewed', 'accepted_by_one'].includes(r.state) && hoursLeft < 24;
    return {
      id: sid(r._id),
      state: r.state,
      releasedAt: r.releasedAt,
      expiresAt: r.expiresAt,
      hoursLeft,
      members: r.members.map((m) => ({ id: sid(m.userId), name: names.get(sid(m.userId)) ?? 'Member', status: m.status })),
      attention: notViewed ? 'not_viewed_for_48h' : closing ? 'closing_within_24h' : null,
    };
  });
  return { items: filter.attention ? items.filter((i) => i.attention) : items };
}

// ------------------------------------------------------------------ saved filters

export const savedFilterSchema = z.object({ name: z.string().trim().min(2).max(60), query: z.record(z.string().max(40), z.union([z.string().max(100), z.number(), z.boolean()])) });

export async function listFilters(userId: string) {
  const rows = await SavedFilter.find({ userId, scope: 'members' }).sort({ name: 1 }).lean();
  return { items: rows.map((f) => ({ id: sid(f._id), name: f.name, query: f.query })) };
}
export async function saveFilter(userId: string, input: z.infer<typeof savedFilterSchema>) {
  if ((await SavedFilter.countDocuments({ userId })) >= 20) throw conflict('You can keep up to 20 saved filters');
  try {
    const f = await SavedFilter.create({ userId, name: input.name, query: input.query });
    return { id: sid(f._id), name: f.name, query: f.query };
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw conflict('You already have a filter with that name');
    throw err;
  }
}
export async function deleteFilter(userId: string, id: string) {
  if (!(await SavedFilter.deleteOne({ _id: id, userId })).deletedCount) throw notFound();
  return { deleted: true };
}

// ------------------------------------------------------------------ member detail tabs

export async function memberFinance(userId: string) {
  const [payments, subscription, invoices] = await Promise.all([
    Payment.find({ userId }).sort({ createdAt: -1 }).limit(25).lean(),
    Subscription.findOne({ userId, status: { $ne: 'expired' } }).sort({ createdAt: -1 }).lean(),
    Invoice.find({ userId }).sort({ issuedAt: -1 }).limit(25).select('number kind issuedAt tax.totalPaise').lean(),
  ]);
  return {
    subscription: subscription
      ? { planCode: subscription.planCode, interval: subscription.interval, status: subscription.status, currentPeriodEnd: subscription.currentPeriodEnd ?? null, cancelAtPeriodEnd: subscription.cancelAtPeriodEnd }
      : null,
    payments: payments.map((p) => ({ id: sid(p._id), at: p.capturedAt ?? p.createdAt, kind: p.kind, planCode: p.planCode ?? null, amountPaise: p.amountPaise, refundedPaise: p.refundedPaise, status: p.status })),
    invoices: invoices.map((i) => ({ id: sid(i._id), number: i.number, kind: i.kind, at: i.issuedAt, totalPaise: i.tax?.totalPaise ?? 0 })),
  };
}

export async function memberLedgers(userId: string) {
  const [credits, wallet, user] = await Promise.all([
    CreditLedger.find({ userId }).sort({ createdAt: -1 }).limit(50).lean(),
    WalletLedger.find({ userId }).sort({ _id: -1 }).limit(50).lean(),
    User.findById(userId).select('creditBalance creditsReserved walletBalancePaise').lean(),
  ]);
  return {
    balances: { credits: user?.creditBalance ?? 0, held: user?.creditsReserved ?? 0, walletPaise: user?.walletBalancePaise ?? 0 },
    credits: credits.map((c) => ({ id: sid(c._id), type: c.type, delta: c.delta, held: c.heldDelta, balanceAfter: c.balanceAfter, reason: c.reason ?? null, at: c.createdAt })),
    wallet: wallet.map((w) => ({ id: sid(w._id), type: w.type, deltaPaise: w.deltaPaise, balanceAfterPaise: w.balanceAfterPaise, reason: w.reason ?? null, at: w.createdAt })),
  };
}

export async function memberSafety(userId: string) {
  const oid = new Types.ObjectId(userId);
  const [against, made] = await Promise.all([
    Report.find({ reportedId: oid }).sort({ createdAt: -1 }).limit(25).select('category severity status createdAt').lean(),
    Report.find({ reporterId: oid }).sort({ createdAt: -1 }).limit(25).select('category severity status createdAt').lean(),
  ]);
  const row = (r: { _id: unknown; category: string; severity: string; status: string; createdAt: Date }) => ({ id: sid(r._id), category: r.category, severity: r.severity, status: r.status, at: r.createdAt });
  return { against: against.map(row), made: made.map(row) };
}

export async function memberTickets(userId: string) {
  const rows = await Ticket.find({ userId }).sort({ lastMessageAt: -1 }).limit(25).lean();
  return { items: rows.map((t) => ({ id: sid(t._id), number: t.number, subject: t.subject, category: t.category, status: t.status, at: t.lastMessageAt })) };
}
