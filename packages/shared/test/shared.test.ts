import { describe, expect, it } from 'vitest';
import {
  ageOn,
  DEFAULT_PLANS,
  financialYear,
  formatInr,
  gstFromInclusive,
  introductionMachine,
  invoiceNumber,
  journeyMachine,
  permissionsForRoles,
  registerSchema,
  savingsPercent,
  subscriptionMachine,
  trackerFor,
} from '../src';

describe('state machines', () => {
  it('allows the happy introduction path and blocks reversal', () => {
    expect(introductionMachine.canTransition('released', 'viewed')).toBe(true);
    expect(introductionMachine.canTransition('accepted_by_one', 'mutually_accepted')).toBe(true);
    expect(() => introductionMachine.assertTransition('declined', 'accepted_by_one')).toThrow();
    expect(introductionMachine.next('mutually_accepted')).toEqual([]);
  });
  it('journey: changes requested loops back to submitted', () => {
    expect(journeyMachine.canTransition('profile_submitted', 'profile_changes_requested')).toBe(true);
    expect(journeyMachine.canTransition('profile_changes_requested', 'profile_submitted')).toBe(true);
    expect(journeyMachine.canTransition('registered', 'verified')).toBe(false);
  });
  it('subscription: halted can recover, cancelled is final', () => {
    expect(subscriptionMachine.canTransition('halted', 'active')).toBe(true);
    expect(subscriptionMachine.canTransition('cancelled', 'active')).toBe(false);
  });
  it('tracker says who the member is waiting on', () => {
    expect(trackerFor('profile_submitted').waitingOn).toBe('team');
    expect(trackerFor('profile_in_progress').waitingOn).toBe('you');
  });
});

describe('money and invoicing', () => {
  it('splits intra-state GST into CGST+SGST', () => {
    const b = gstFromInclusive(118000, 18, true);
    expect(b.taxablePaise).toBe(100000);
    expect(b.cgstPaise + b.sgstPaise).toBe(18000);
    expect(b.igstPaise).toBe(0);
  });
  it('uses IGST for inter-state and keeps every paise', () => {
    const b = gstFromInclusive(99900, 18, false);
    expect(b.igstPaise).toBe(b.totalTaxPaise);
    expect(b.taxablePaise + b.igstPaise).toBe(99900);
  });
  it('computes Indian financial year and invoice numbers', () => {
    expect(financialYear(new Date('2026-03-31T00:00:00Z'))).toBe('2025-26');
    expect(financialYear(new Date('2026-04-01T00:00:00Z'))).toBe('2026-27');
    expect(invoiceNumber(new Date('2026-08-01T00:00:00Z'), 123)).toBe('INV/2026-27/000123');
  });
  it('formats rupees with lakh grouping and hides .00 for whole rupees', () => {
    expect(formatInr(249_900)).toBe('₹2,499');
    expect(formatInr(12_345_600)).toBe('₹1,23,456');
    expect(formatInr(99_950)).toBe('₹999.50');
  });
});

describe('rbac', () => {
  it('unions permissions across roles', () => {
    const p = permissionsForRoles(['verifier', 'finance']);
    expect(p).toContain('verification.view_evidence');
    expect(p).toContain('payment.refund');
    expect(p).not.toContain('roles.manage');
  });
});

describe('registration age gate', () => {
  const base = { email: 'A@Example.com', password: 'Abcdefgh12', firstName: 'Asha', acceptTerms: true as const };
  const yearsAgo = (y: number) => {
    const n = new Date();
    return new Date(Date.UTC(n.getUTCFullYear() - y, 0, 1));
  };
  it('enforces 18+ for women and 21+ for men', () => {
    expect(registerSchema.safeParse({ ...base, gender: 'woman', dob: yearsAgo(19) }).success).toBe(true);
    expect(registerSchema.safeParse({ ...base, gender: 'woman', dob: yearsAgo(17) }).success).toBe(false);
    expect(registerSchema.safeParse({ ...base, gender: 'man', dob: yearsAgo(20) }).success).toBe(false);
    expect(registerSchema.safeParse({ ...base, gender: 'man', dob: yearsAgo(22) }).success).toBe(true);
  });
  it('lowercases email and computes age', () => {
    const r = registerSchema.parse({ ...base, gender: 'man', dob: new Date('1990-01-01') });
    expect(r.email).toBe('a@example.com');
    expect(ageOn(new Date('1990-06-15'), new Date('2026-06-14'))).toBe(35);
  });
  it('accepts phone-only sign-up but needs at least one complete path', () => {
    const common = { firstName: 'Ravi', gender: 'man' as const, dob: yearsAgo(30), acceptTerms: true as const };
    expect(registerSchema.safeParse({ ...common, phone: '+919876543210' }).success).toBe(true);
    expect(registerSchema.safeParse({ ...common }).success).toBe(false);
    expect(registerSchema.safeParse({ ...common, email: 'a@b.co' }).success).toBe(false);
    expect(registerSchema.safeParse({ ...common, phone: '12345' }).success).toBe(false);
  });
});

describe('default plans', () => {
  it('matches the product price list and discounts', () => {
    const essential = DEFAULT_PLANS.find((p) => p.code === 'essential')!;
    expect(essential.prices.monthly).toBe(99_900);
    expect(savingsPercent(essential, 'quarterly')).toBe(10);
    expect(savingsPercent(essential, 'annual')).toBe(25);
    expect(DEFAULT_PLANS.find((p) => p.code === 'premium')?.credits).toBe(5);
    expect(DEFAULT_PLANS.find((p) => p.code === 'concierge')?.prices.quarterly).toBe(799_900);
    for (const p of DEFAULT_PLANS) for (const v of Object.values(p.prices)) expect(Number.isInteger(v)).toBe(true);
  });
});

describe('profile completion', () => {
  it('requires the mandatory fields per step and a 50 character bio', async () => {
    const { isStepComplete } = await import('../src');
    expect(isStepComplete('basics', { firstName: 'A', heightCm: 165 })).toBe(false);
    expect(isStepComplete('basics', { firstName: 'A', heightCm: 165, maritalStatus: 'never_married' })).toBe(true);
    expect(isStepComplete('about', { bio: 'short' })).toBe(false);
    expect(isStepComplete('about', { bio: 'x'.repeat(50) })).toBe(true);
    expect(isStepComplete('photos', {}, 0)).toBe(false);
    expect(isStepComplete('photos', {}, 1)).toBe(true);
  });
});

describe('reopening an approved profile', () => {
  it('is allowed from approved, but not from later states', () => {
    expect(journeyMachine.canTransition('profile_approved', 'profile_changes_requested')).toBe(true);
    expect(journeyMachine.canTransition('matching_active', 'profile_changes_requested')).toBe(false);
  });
});
