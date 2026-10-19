import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Document, Font, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer';

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

/** Bump when the layout changes; stored PDFs from an older version are redrawn on the next download. */
export const PDF_DESIGN = 2;

// ---------------------------------------------------------------- fonts
// Inter ships the rupee sign, which the built-in PDF fonts do not. The files live in apps/api/assets/fonts and are
// found from either the source tree (src/lib) or the bundled build (dist).
const FONT_DIRS = [new URL('../../assets/fonts/', import.meta.url), new URL('../assets/fonts/', import.meta.url)];
const fontDir = FONT_DIRS.find((d) => existsSync(fileURLToPath(new URL('Inter_400Regular.ttf', d)))) ?? FONT_DIRS[0]!;
const face = (file: string) => fileURLToPath(new URL(file, fontDir));
Font.register({
  family: 'Inter',
  fonts: [
    { src: face('Inter_400Regular.ttf'), fontWeight: 400 },
    { src: face('Inter_500Medium.ttf'), fontWeight: 500 },
    { src: face('Inter_600SemiBold.ttf'), fontWeight: 600 },
    { src: face('Inter_700Bold.ttf'), fontWeight: 700 },
  ],
});
Font.registerHyphenationCallback((word) => [word]);

// ---------------------------------------------------------------- amount in words (Indian numbering)
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function below1000(n: number): string {
  const parts: string[] = [];
  if (n >= 100) parts.push(`${ONES[Math.floor(n / 100)]} Hundred`);
  const r = n % 100;
  if (r) parts.push(r < 20 ? ONES[r]! : `${TENS[Math.floor(r / 10)]}${r % 10 ? `-${ONES[r % 10]}` : ''}`);
  return parts.join(' ');
}

/** 249900 paise -> "Two Thousand Four Hundred Ninety-Nine Rupees Only" (crore / lakh / thousand grouping). */
export function amountInWords(paise: number): string {
  const total = Math.max(0, Math.round(paise));
  const rupees = Math.floor(total / 100);
  const ps = total % 100;
  const groups: [number, string][] = [
    [Math.floor(rupees / 10_000_000), 'Crore'],
    [Math.floor(rupees / 100_000) % 100, 'Lakh'],
    [Math.floor(rupees / 1000) % 100, 'Thousand'],
  ];
  const words = groups.filter(([n]) => n > 0).map(([n, name]) => `${below1000(n)} ${name}`);
  if (rupees % 1000) words.push(below1000(rupees % 1000));
  const rupeeText = words.length ? words.join(' ') : 'Zero';
  const base = `${rupeeText} ${rupees === 1 ? 'Rupee' : 'Rupees'}`;
  return ps ? `${base} and ${below1000(ps)} Paise Only` : `${base} Only`;
}

// ---------------------------------------------------------------- design
const PLUM = '#3B1632';
const AMBER = '#F2A33A';
const CORAL = '#E2725B';
const INK = '#1E1A1D';
const MUTED = '#6B6068';
const LINE = '#EADFE6';
const TINT = '#F8F1F5';

type PdfStyle = (typeof s)[keyof typeof s];

const s = StyleSheet.create({
  page: { fontFamily: 'Inter', fontSize: 9.5, color: INK, paddingBottom: 70 },
  band: { backgroundColor: PLUM, paddingHorizontal: 40, paddingTop: 34, paddingBottom: 46, flexDirection: 'row', justifyContent: 'space-between' },
  brand: { fontSize: 19, fontWeight: 700, color: '#FFFFFF' },
  bandMuted: { fontSize: 8.5, color: '#D9C3D3', marginTop: 3, lineHeight: 1.4 },
  titleWrap: { alignItems: 'flex-end' },
  docTitle: { fontSize: 10, fontWeight: 700, letterSpacing: 2.5, color: AMBER },
  docNumber: { fontSize: 15, fontWeight: 600, color: '#FFFFFF', marginTop: 5 },
  strip: { flexDirection: 'row', height: 4 },
  body: { paddingHorizontal: 40 },
  cards: { flexDirection: 'row', gap: 10, marginTop: -26 },
  card: { flex: 1, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: LINE, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 12 },
  cardHot: { flex: 1.2, backgroundColor: '#FFF6E8', borderWidth: 1, borderColor: '#F6D9A8', borderRadius: 8, paddingVertical: 10, paddingHorizontal: 12 },
  label: { fontSize: 7, fontWeight: 600, letterSpacing: 1.2, color: MUTED, textTransform: 'uppercase' },
  value: { fontSize: 10.5, fontWeight: 600, marginTop: 4 },
  valueBig: { fontSize: 14, fontWeight: 700, marginTop: 3, color: PLUM },
  parties: { flexDirection: 'row', gap: 24, marginTop: 22 },
  party: { flex: 1 },
  partyName: { fontSize: 12, fontWeight: 600, marginTop: 5 },
  partyLine: { color: MUTED, marginTop: 2, lineHeight: 1.4 },
  table: { marginTop: 24 },
  thead: { flexDirection: 'row', backgroundColor: TINT, borderRadius: 6, paddingVertical: 8, paddingHorizontal: 12 },
  th: { fontSize: 7.5, fontWeight: 600, letterSpacing: 1, color: PLUM, textTransform: 'uppercase' },
  tr: { flexDirection: 'row', paddingVertical: 11, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: LINE },
  cIdx: { width: 26, color: MUTED },
  cDesc: { flex: 1, fontWeight: 500 },
  cSac: { width: 70, color: MUTED },
  cDescWeight: { fontWeight: 500 },
  cAmt: { width: 100, textAlign: 'right', fontWeight: 500 },
  totals: { marginTop: 14, alignSelf: 'flex-end', width: 250 },
  trow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, paddingHorizontal: 12 },
  tlabel: { color: MUTED },
  grand: { marginTop: 8, backgroundColor: PLUM, borderRadius: 8, paddingVertical: 12, paddingHorizontal: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  grandLabel: { color: '#EBDDE6', fontSize: 9, fontWeight: 500 },
  grandValue: { color: '#FFFFFF', fontSize: 15, fontWeight: 700 },
  words: { marginTop: 18, borderLeftWidth: 3, borderLeftColor: AMBER, backgroundColor: TINT, borderRadius: 4, paddingVertical: 9, paddingHorizontal: 12 },
  wordsText: { marginTop: 3, fontSize: 10, fontWeight: 500 },
  note: { marginTop: 18, fontSize: 8.5, color: MUTED, lineHeight: 1.5 },
  footer: { position: 'absolute', left: 40, right: 40, bottom: 22 },
  footRule: { borderTopWidth: 1, borderTopColor: LINE, paddingTop: 9, flexDirection: 'row', justifyContent: 'space-between' },
  footText: { fontSize: 7.5, color: MUTED },
  footBrand: { fontSize: 7.5, fontWeight: 600, color: PLUM },
});

/** Always two decimals and Indian digit grouping, so a column of amounts lines up (₹2,117.80, ₹2,499.00). */
export const formatMoney = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Money({ paise, style }: { paise?: number | null; style?: PdfStyle }) {
  return <Text style={style}>{formatMoney(paise ?? 0)}</Text>;
}

function TotalRow({ label, paise }: { label: string; paise?: number | null }) {
  if (paise === undefined || paise === null) return null;
  return (
    <View style={s.trow}>
      <Text style={s.tlabel}>{label}</Text>
      <Money paise={paise} style={s.cDescWeight} />
    </View>
  );
}

const fmtDate = (d: Date) => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** An A4 GST tax invoice or credit note. Money is formatted from integer paise. */
export function InvoiceDocument({ v }: { v: InvoiceView }) {
  const rate = v.tax.ratePercent ?? 0;
  const credit = v.kind === 'credit_note';
  const accent = credit ? CORAL : AMBER;
  const total = v.tax.totalPaise ?? 0;
  return (
    <Document title={v.number} author={v.seller.name ?? 'Marchmaker'} subject={credit ? 'Credit note' : 'Tax invoice'}>
      <Page size="A4" style={s.page}>
        <View style={s.band}>
          <View style={{ maxWidth: 300 }}>
            <Text style={s.brand}>{v.seller.name ?? 'Marchmaker'}</Text>
            {v.seller.address ? <Text style={s.bandMuted}>{v.seller.address}</Text> : null}
            <Text style={s.bandMuted}>GSTIN {v.seller.gstin ?? '-'}</Text>
          </View>
          <View style={s.titleWrap}>
            <Text style={[s.docTitle, { color: accent }]}>{credit ? 'CREDIT NOTE' : 'TAX INVOICE'}</Text>
            <Text style={s.docNumber}>{v.number}</Text>
          </View>
        </View>
        <View style={s.strip}>
          <View style={{ flex: 1, backgroundColor: AMBER }} />
          <View style={{ flex: 1, backgroundColor: CORAL }} />
        </View>

        <View style={s.body}>
          <View style={s.cards}>
            <View style={s.card}>
              <Text style={s.label}>Date issued</Text>
              <Text style={s.value}>{fmtDate(v.issuedAt)}</Text>
            </View>
            <View style={s.card}>
              <Text style={s.label}>Place of supply</Text>
              <Text style={s.value}>{v.placeOfSupply ?? '-'}</Text>
            </View>
            <View style={s.cardHot}>
              <Text style={s.label}>{credit ? 'Credited' : 'Total amount'}</Text>
              <Money paise={total} style={s.valueBig} />
            </View>
          </View>

          <View style={s.parties}>
            <View style={s.party}>
              <Text style={s.label}>Billed to</Text>
              <Text style={s.partyName}>{v.buyer.name || v.buyer.email || 'Member'}</Text>
              {v.buyer.name && v.buyer.email ? <Text style={s.partyLine}>{v.buyer.email}</Text> : null}
              {v.buyer.gstin ? <Text style={s.partyLine}>GSTIN {v.buyer.gstin}</Text> : null}
            </View>
            <View style={s.party}>
              <Text style={s.label}>{credit ? 'Against invoice' : 'Supplied by'}</Text>
              <Text style={s.partyName}>{credit ? (v.relatesToNumber ?? '-') : (v.seller.name ?? 'Marchmaker')}</Text>
              {!credit && v.seller.gstin ? <Text style={s.partyLine}>GSTIN {v.seller.gstin}</Text> : null}
            </View>
          </View>

          <View style={s.table}>
            <View style={s.thead}>
              <Text style={[s.th, s.cIdx]}>#</Text>
              <Text style={[s.th, { flex: 1 }]}>Description</Text>
              <Text style={[s.th, { width: 70 }]}>SAC</Text>
              <Text style={[s.th, { width: 100, textAlign: 'right' }]}>Taxable value</Text>
            </View>
            {v.lineItems.map((l, i) => (
              <View key={i} style={s.tr} wrap={false}>
                <Text style={s.cIdx}>{i + 1}</Text>
                <Text style={s.cDesc}>{l.description ?? ''}</Text>
                <Text style={s.cSac}>{l.sac ?? '-'}</Text>
                <Money paise={l.taxablePaise} style={s.cAmt} />
              </View>
            ))}
          </View>

          <View style={s.totals} wrap={false}>
            <TotalRow label="Taxable value" paise={v.tax.taxablePaise} />
            {(v.tax.igstPaise ?? 0) > 0 ? (
              <TotalRow label={`IGST @ ${rate}%`} paise={v.tax.igstPaise} />
            ) : (
              <>
                <TotalRow label={`CGST @ ${rate / 2}%`} paise={v.tax.cgstPaise} />
                <TotalRow label={`SGST @ ${rate / 2}%`} paise={v.tax.sgstPaise} />
              </>
            )}
            <View style={s.grand}>
              <Text style={s.grandLabel}>Total (inclusive of GST)</Text>
              <Money paise={total} style={s.grandValue} />
            </View>
          </View>

          <View style={s.words} wrap={false}>
            <Text style={s.label}>Amount in words</Text>
            <Text style={s.wordsText}>{amountInWords(total)}</Text>
          </View>

          <Text style={s.note}>
            {credit
              ? 'This credit note adjusts the invoice named above.'
              : 'Thank you for choosing Marchmaker. Questions about this invoice? Write to us from the Support page in your account and quote the invoice number.'}
          </Text>
        </View>

        <View style={s.footer} fixed>
          <View style={s.footRule}>
            <Text style={s.footText}>This is a computer-generated document and needs no signature.</Text>
            <Text style={s.footBrand} render={({ pageNumber, totalPages }) => `${v.number}  ·  Page ${pageNumber} of ${totalPages}`} />
          </View>
        </View>
      </Page>
    </Document>
  );
}

export function renderInvoicePdf(v: InvoiceView): Promise<Buffer> {
  return renderToBuffer(<InvoiceDocument v={v} />);
}
