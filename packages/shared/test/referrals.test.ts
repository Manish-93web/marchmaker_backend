import { describe, expect, it } from 'vitest';
import { DEFAULT_REFERRAL_SETTINGS, MIN_CASH_PAISE, referralSettingsSchema, splitWithWallet, walletAdjustSchema } from '../src/referrals';

describe('splitWithWallet', () => {
  it('does nothing when the wallet is off or empty', () => {
    expect(splitWithWallet(49_900, 100_000, false)).toEqual({ walletPaise: 0, cashPaise: 49_900 });
    expect(splitWithWallet(49_900, 0, true)).toEqual({ walletPaise: 0, cashPaise: 49_900 });
  });
  it('uses the whole balance when it is less than the price', () => {
    expect(splitWithWallet(49_900, 30_000, true)).toEqual({ walletPaise: 30_000, cashPaise: 19_900 });
  });
  it('covers the price exactly when the balance is enough', () => {
    expect(splitWithWallet(49_900, 60_000, true)).toEqual({ walletPaise: 49_900, cashPaise: 0 });
    expect(splitWithWallet(49_900, 49_900, true)).toEqual({ walletPaise: 49_900, cashPaise: 0 });
  });
  it('never leaves the gateway with less than one rupee', () => {
    const s = splitWithWallet(49_900, 49_850, true);
    expect(s.cashPaise).toBe(MIN_CASH_PAISE);
    expect(s.walletPaise + s.cashPaise).toBe(49_900);
  });
  it('always adds up', () => {
    for (const bal of [1, 99, 100, 101, 49_799, 49_800, 49_801, 49_899, 49_900, 50_000]) {
      const s = splitWithWallet(49_900, bal, true);
      expect(s.walletPaise + s.cashPaise).toBe(49_900);
      expect(s.walletPaise).toBeLessThanOrEqual(bal);
      expect(s.cashPaise === 0 || s.cashPaise >= MIN_CASH_PAISE).toBe(true);
    }
  });
});

describe('settings and adjustments', () => {
  it('accepts the defaults and rejects nonsense', () => {
    expect(referralSettingsSchema.safeParse(DEFAULT_REFERRAL_SETTINGS).success).toBe(true);
    expect(referralSettingsSchema.safeParse({ ...DEFAULT_REFERRAL_SETTINGS, holdDays: 90 }).success).toBe(false);
    expect(referralSettingsSchema.safeParse({ ...DEFAULT_REFERRAL_SETTINGS, referrerRewardPaise: -1 }).success).toBe(false);
  });
  it('wants a reason and a non-zero amount for a wallet adjustment', () => {
    expect(walletAdjustSchema.safeParse({ amountPaise: 0, reason: 'Some reason' }).success).toBe(false);
    expect(walletAdjustSchema.safeParse({ amountPaise: -500, reason: 'abc' }).success).toBe(false);
    expect(walletAdjustSchema.safeParse({ amountPaise: -500, reason: 'Correcting a mistake' }).success).toBe(true);
  });
});
