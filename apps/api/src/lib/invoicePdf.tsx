import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer';
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

const s = StyleSheet.create({
  page: { padding: 50, fontSize: 10, fontFamily: 'Helvetica', color: '#1E1A1D' },
  brand: { fontSize: 20, fontFamily: 'Helvetica-Bold', color: '#4A1D3F' },
  muted: { fontSize: 9, color: '#555555', marginTop: 2 },
  title: { fontSize: 16, marginTop: 18, marginBottom: 6 },
  block: { marginTop: 12 },
  heading: { fontSize: 11, fontFamily: 'Helvetica-Bold', marginBottom: 4 },
  rule: { borderBottomWidth: 1, borderBottomColor: '#999999', marginVertical: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between', marginVertical: 2 },
  total: { fontSize: 12, fontFamily: 'Helvetica-Bold' },
  footer: { marginTop: 36, fontSize: 8, color: '#555555' },
});

function Row({ label, paise, bold }: { label: string; paise?: number | null; bold?: boolean }) {
  if (paise === undefined || paise === null) return null;
  return (
    <View style={s.row}>
      <Text style={bold ? s.total : undefined}>{label}</Text>
      <Text style={bold ? s.total : undefined}>{formatInr(paise)}</Text>
    </View>
  );
}

/** A plain A4 GST tax invoice or credit note. Money is formatted from integer paise. */
export function InvoiceDocument({ v }: { v: InvoiceView }) {
  const rate = v.tax.ratePercent ?? 0;
  return (
    <Document title={v.number} author={v.seller.name ?? 'Marchmaker'}>
      <Page size="A4" style={s.page}>
        <Text style={s.brand}>{v.seller.name ?? 'Marchmaker'}</Text>
        {v.seller.address ? <Text style={s.muted}>{v.seller.address}</Text> : null}
        <Text style={s.muted}>GSTIN: {v.seller.gstin ?? '-'}</Text>

        <Text style={s.title}>{v.kind === 'credit_note' ? 'Credit note' : 'Tax invoice'}</Text>
        <Text>Number: {v.number}</Text>
        <Text>Date: {v.issuedAt.toISOString().slice(0, 10)}</Text>
        {v.relatesToNumber ? <Text>Against invoice: {v.relatesToNumber}</Text> : null}

        <View style={s.block}>
          <Text style={s.heading}>Billed to</Text>
          <Text>{v.buyer.name || v.buyer.email || 'Member'}</Text>
          {v.buyer.gstin ? <Text>GSTIN: {v.buyer.gstin}</Text> : null}
          {v.placeOfSupply ? <Text>Place of supply: {v.placeOfSupply}</Text> : null}
        </View>

        <View style={s.block}>
          <Text style={s.heading}>Items</Text>
          <View style={s.rule} />
          {v.lineItems.map((l, i) => (
            <Row key={i} label={`${l.description ?? ''}${l.sac ? ` (SAC ${l.sac})` : ''}`} paise={l.taxablePaise} />
          ))}
        </View>

        <View style={s.block}>
          <Row label="Taxable value" paise={v.tax.taxablePaise} />
          {(v.tax.igstPaise ?? 0) > 0 ? (
            <Row label={`IGST @ ${rate}%`} paise={v.tax.igstPaise} />
          ) : (
            <>
              <Row label={`CGST @ ${rate / 2}%`} paise={v.tax.cgstPaise} />
              <Row label={`SGST @ ${rate / 2}%`} paise={v.tax.sgstPaise} />
            </>
          )}
          <View style={s.rule} />
          <Row label="Total (inclusive of GST)" paise={v.tax.totalPaise} bold />
        </View>

        <Text style={s.footer}>This is a computer generated document and needs no signature.</Text>
      </Page>
    </Document>
  );
}

export function renderInvoicePdf(v: InvoiceView): Promise<Buffer> {
  return renderToBuffer(<InvoiceDocument v={v} />);
}
