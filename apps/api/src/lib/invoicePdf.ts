import PDFDocument from 'pdfkit';
import { formatInr } from '@marchmaker/shared';

export interface InvoiceView {
  number: string;
  kind: 'invoice' | 'credit_note';
  issuedAt: Date;
  seller: { name?: string | null; gstin?: string | null; address?: string | null; stateCode?: string | null };
  buyer: { name?: string | null; gstin?: string | null; stateCode?: string | null; email?: string | null };
  placeOfSupply?: string | null;
  lineItems: { description?: string | null; sac?: string | null; taxablePaise?: number | null }[];
  tax: {
    ratePercent?: number | null;
    taxablePaise?: number | null;
    cgstPaise?: number | null;
    sgstPaise?: number | null;
    igstPaise?: number | null;
    totalPaise?: number | null;
  };
  relatesToNumber?: string;
}

/** A plain A4 tax invoice. Money is formatted from integer paise. */
export function renderInvoicePdf(v: InvoiceView): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: v.number, Author: v.seller.name ?? 'Marchmaker' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const title = v.kind === 'credit_note' ? 'Credit note' : 'Tax invoice';
    doc.fontSize(20).text(v.seller.name ?? 'Marchmaker');
    doc.fontSize(9).fillColor('#555').text(v.seller.address ?? '').text(`GSTIN: ${v.seller.gstin ?? '-'}`);
    doc.moveDown().fillColor('#000').fontSize(16).text(title);
    doc.fontSize(10).text(`Number: ${v.number}`).text(`Date: ${v.issuedAt.toISOString().slice(0, 10)}`);
    if (v.relatesToNumber) doc.text(`Against invoice: ${v.relatesToNumber}`);
    doc.moveDown();
    doc.fontSize(11).text('Billed to');
    doc.fontSize(10).text(v.buyer.name || v.buyer.email || 'Member');
    if (v.buyer.gstin) doc.text(`GSTIN: ${v.buyer.gstin}`);
    if (v.placeOfSupply) doc.text(`Place of supply: ${v.placeOfSupply}`);
    doc.moveDown();

    const line = (label: string, paise?: number | null) => {
      if (paise === undefined || paise === null) return;
      doc.text(label, 50, doc.y, { continued: true, width: 330 }).text(formatInr(paise), { align: 'right' });
    };
    doc.fontSize(11).text('Items');
    doc.moveTo(50, doc.y + 2).lineTo(545, doc.y + 2).stroke('#999');
    doc.moveDown(0.5).fontSize(10);
    for (const l of v.lineItems) line(`${l.description ?? ''}${l.sac ? ` (SAC ${l.sac})` : ''}`, l.taxablePaise);
    doc.moveDown();
    const rate = v.tax.ratePercent ?? 0;
    line('Taxable value', v.tax.taxablePaise);
    if ((v.tax.igstPaise ?? 0) > 0) line(`IGST @ ${rate}%`, v.tax.igstPaise);
    else {
      line(`CGST @ ${rate / 2}%`, v.tax.cgstPaise);
      line(`SGST @ ${rate / 2}%`, v.tax.sgstPaise);
    }
    doc.moveDown(0.5).fontSize(12);
    line('Total (inclusive of GST)', v.tax.totalPaise);
    doc.moveDown(2).fontSize(8).fillColor('#555').text('This is a computer generated document and needs no signature.');
    doc.end();
  });
}
