import { describe, expect, it } from 'vitest';
import { amountInWords, formatMoney, renderInvoicePdf } from '../src/lib/invoicePdf';

describe('invoice PDF', () => {
  it('writes amounts in words with Indian grouping', () => {
    expect(amountInWords(249900)).toBe('Two Thousand Four Hundred Ninety-Nine Rupees Only');
    expect(amountInWords(100)).toBe('One Rupee Only');
    expect(amountInWords(0)).toBe('Zero Rupees Only');
    expect(amountInWords(12_345_678_00)).toBe('One Crore Twenty-Three Lakh Forty-Five Thousand Six Hundred Seventy-Eight Rupees Only');
    expect(amountInWords(150_050)).toBe('One Thousand Five Hundred Rupees and Fifty Paise Only');
  });

  it('formats money with two decimals and lakh grouping', () => {
    expect(formatMoney(249900)).toBe('₹2,499.00');
    expect(formatMoney(211780)).toBe('₹2,117.80');
    expect(formatMoney(123456789)).toBe('₹12,34,567.89');
  });

  it('renders a real PDF for an invoice and a credit note', async () => {
    const base = {
      issuedAt: new Date('2026-10-19'),
      seller: { name: 'Marchmaker Matrimonial Services Pvt Ltd', gstin: '29AAAAA0000A1Z5', address: 'Bengaluru, Karnataka, India' },
      buyer: { name: 'Manish' },
      placeOfSupply: 'Karnataka',
      lineItems: [{ description: 'Premium subscription (monthly)', sac: '999799', taxablePaise: 211780 }],
      tax: { ratePercent: 18, taxablePaise: 211780, cgstPaise: 19060, sgstPaise: 19060, totalPaise: 249900 },
    };
    const inv = await renderInvoicePdf({ ...base, number: 'INV/2026-27/000001', kind: 'invoice' });
    const cn = await renderInvoicePdf({ ...base, number: 'CN/2026-27/000001', kind: 'credit_note', relatesToNumber: 'INV/2026-27/000001' });
    for (const b of [inv, cn]) expect(b.subarray(0, 5).toString()).toBe('%PDF-');
    expect(inv.length).toBeGreaterThan(20_000); // the embedded font is included
  });
});
