import type { AppContext } from '../context';
import { Invoice } from '../models/billing';
import { User } from '../models/core';
import { sendNotice } from '../services/notify';
import { ensurePdf } from '../services/invoicing';

export { reconcile, lapseAccess } from '../services/billing';

/** Renders the invoice PDF into the documents bucket and tells the member it is ready. Safe to re-run. */
export async function handleInvoiceCreated(ctx: AppContext, invoiceId: string): Promise<void> {
  const inv = await Invoice.findById(invoiceId);
  if (!inv) return;
  await ensurePdf(ctx, invoiceId);
  const claimed = await Invoice.findOneAndUpdate({ _id: invoiceId, emailedAt: { $exists: false } }, { $set: { emailedAt: new Date() } });
  if (!claimed) return;
  const user = await User.findById(inv.userId).select('email firstName').lean();
  if (!user?.email) return;
  const isNote = inv.kind === 'credit_note';
  await sendNotice(ctx, user.email, {
    subject: isNote ? `Your credit note ${inv.number}` : `Your invoice ${inv.number}`,
    preview: isNote ? 'A credit note for your refund is ready' : 'Your tax invoice is ready',
    heading: isNote ? 'Your credit note is ready' : 'Your invoice is ready',
    paragraphs: [
      `Hello ${user.firstName ?? 'there'}, your ${isNote ? 'credit note' : 'tax invoice'} ${inv.number} is ready.`,
      `You can download it any time from Billing in your account (${ctx.env.APP_URL}/billing).`,
    ],
  });
}
