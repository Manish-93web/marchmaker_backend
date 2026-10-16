/** Money is always integer paise. */
export type Paise = number;

export function assertPaise(n: number): asserts n is Paise {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Invalid paise amount: ${n}`);
}

export const rupeesToPaise = (r: number): Paise => Math.round(r * 100);

export function formatInr(paise: Paise): string {
  // Whole rupees read better on price cards; paise are shown only when present.
  const whole = paise % 100 === 0;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(paise / 100);
}

export interface GstBreakup {
  taxablePaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
  totalTaxPaise: Paise;
  totalPaise: Paise;
  intraState: boolean;
}

/**
 * Splits a GST-inclusive amount into taxable value + tax.
 * Intra-state => CGST + SGST (half each, remainder goes to SGST); inter-state => IGST.
 */
export function gstFromInclusive(inclusivePaise: Paise, ratePercent: number, intraState: boolean): GstBreakup {
  assertPaise(inclusivePaise);
  const taxable = Math.round((inclusivePaise * 100) / (100 + ratePercent));
  const tax = inclusivePaise - taxable;
  if (intraState) {
    const cgst = Math.floor(tax / 2);
    return {
      taxablePaise: taxable,
      cgstPaise: cgst,
      sgstPaise: tax - cgst,
      igstPaise: 0,
      totalTaxPaise: tax,
      totalPaise: inclusivePaise,
      intraState,
    };
  }
  return {
    taxablePaise: taxable,
    cgstPaise: 0,
    sgstPaise: 0,
    igstPaise: tax,
    totalTaxPaise: tax,
    totalPaise: inclusivePaise,
    intraState,
  };
}

/** Indian financial year label, e.g. 2026-04-01 -> "2026-27". */
export function financialYear(date: Date): string {
  const y = date.getUTCFullYear();
  const startYear = date.getUTCMonth() >= 3 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

export function invoiceNumber(date: Date, seq: number): string {
  return `INV/${financialYear(date)}/${String(seq).padStart(6, '0')}`;
}
