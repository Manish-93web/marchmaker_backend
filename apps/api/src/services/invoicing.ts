import type { ClientSession, Types } from 'mongoose';
import { GST_STATES, financialYear, gstFromInclusive } from '@marchmaker/shared';
import type { AppContext } from '../context';
import { renderInvoicePdf, type InvoiceView } from '../lib/invoicePdf';
import { notFound } from '../lib/errors';
import { User } from '../models/core';
import { Invoice, InvoiceCounter } from '../models/billing';

const pad = (n: number) => String(n).padStart(6, '0');

/** Sequential per financial year and per document kind. Inside a transaction, so an abort leaves no gap. */
async function nextNumber(kind: 'invoice' | 'credit_note', at: Date, session: ClientSession) {
  const fy = financialYear(at);
  const prefix = kind === 'invoice' ? 'INV' : 'CN';
  const c = await InvoiceCounter.findOneAndUpdate(
    { key: `${prefix}:${fy}` },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, session },
  );
  return { fy, number: `${prefix}/${fy}/${pad(c.seq)}` };
}

export interface IssueInput {
  ctx: AppContext;
  userId: Types.ObjectId | string;
  paymentId: Types.ObjectId | string;
  amountPaise: number;
  description: string;
  kind?: 'invoice' | 'credit_note';
  relatesTo?: Types.ObjectId | string;
  at?: Date;
}

/**
 * Creates the tax document for a GST-inclusive amount. Intra-state supplies split into CGST+SGST,
 * inter-state into IGST. A member with no state on file is treated as intra-state (D-043).
 */
export async function issue(i: IssueInput, session: ClientSession) {
  const { env } = i.ctx;
  const at = i.at ?? new Date();
  const user = await User.findById(i.userId).select('firstName lastName email billing').session(session);
  const gstin = user?.billing?.gstin ?? undefined;
  const buyerState = (gstin ? gstin.slice(0, 2) : user?.billing?.stateCode) ?? env.GST_SELLER_STATE_CODE;
  const intra = buyerState === env.GST_SELLER_STATE_CODE;
  const tax = gstFromInclusive(i.amountPaise, env.GST_RATE_PERCENT, intra);
  const kind = i.kind ?? 'invoice';
  const { fy, number } = await nextNumber(kind, at, session);

  const [doc] = await Invoice.create(
    [
      {
        number,
        kind,
        financialYear: fy,
        userId: i.userId,
        paymentId: i.paymentId,
        relatesTo: i.relatesTo,
        lineItems: [{ description: i.description, sac: env.GST_SAC_CODE, taxablePaise: tax.taxablePaise }],
        tax: { ratePercent: env.GST_RATE_PERCENT, ...tax },
        buyer: {
          name: user?.billing?.legalName || [user?.firstName].filter(Boolean).join(' '),
          gstin,
          stateCode: buyerState,
          email: user?.email,
        },
        seller: {
          name: env.GST_SELLER_NAME,
          gstin: env.GST_SELLER_GSTIN,
          stateCode: env.GST_SELLER_STATE_CODE,
          address: env.GST_SELLER_ADDRESS,
        },
        placeOfSupply: GST_STATES[buyerState] ?? GST_STATES[env.GST_SELLER_STATE_CODE],
        issuedAt: at,
      },
    ],
    { session },
  );
  return doc!;
}

/** Renders the PDF once and stores it in the documents bucket. Safe to call again. */
export async function ensurePdf(ctx: AppContext, invoiceId: string): Promise<string> {
  const inv = await Invoice.findById(invoiceId);
  if (!inv) throw notFound();
  if (inv.pdfKey) return inv.pdfKey;
  const related = inv.relatesTo ? await Invoice.findById(inv.relatesTo).select('number').lean() : null;
  const view: InvoiceView = {
    number: inv.number,
    kind: inv.kind as 'invoice' | 'credit_note',
    issuedAt: inv.issuedAt,
    seller: inv.seller ?? {},
    buyer: inv.buyer ?? {},
    placeOfSupply: inv.placeOfSupply,
    lineItems: inv.lineItems,
    tax: inv.tax ?? {},
    relatesToNumber: related?.number,
  };
  const pdf = await renderInvoicePdf(view);
  const key = `invoices/${inv.userId}/${inv.number.replace(/\//g, '-')}.pdf`;
  await ctx.storage.put('documents', key, pdf, 'application/pdf');
  await Invoice.updateOne({ _id: inv._id }, { $set: { pdfKey: key } });
  return key;
}

export async function downloadUrl(ctx: AppContext, userId: string, invoiceId: string): Promise<string> {
  const inv = await Invoice.findOne({ _id: invoiceId, userId }).select('_id');
  if (!inv) throw notFound();
  const key = await ensurePdf(ctx, invoiceId);
  return ctx.storage.presignGet('documents', key, 300);
}

export async function listFor(userId: string) {
  const rows = await Invoice.find({ userId }).sort({ issuedAt: -1 }).limit(100).lean();
  return rows.map((r) => ({
    id: String(r._id),
    number: r.number,
    kind: r.kind,
    issuedAt: r.issuedAt,
    description: r.lineItems?.[0]?.description ?? '',
    totalPaise: r.tax?.totalPaise ?? 0,
  }));
}
