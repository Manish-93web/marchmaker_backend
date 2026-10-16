import { z } from 'zod';

export const WALLET_ENTRY_TYPES = ['reward', 'spend', 'release', 'adjust'] as const;
export type WalletEntryType = (typeof WALLET_ENTRY_TYPES)[number];

export const REFERRAL_STATUSES = ['attributed', 'qualified', 'review', 'rewarded', 'rejected'] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

export const referralSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Wallet credit for the member who invited, in paise. */
  referrerRewardPaise: z.number().int().min(0).max(1_000_000),
  /** Wallet credit for the member who joined, in paise. */
  refereeRewardPaise: z.number().int().min(0).max(1_000_000),
  /** The first purchase must be at least this much (GST inclusive, paise). */
  minPurchasePaise: z.number().int().min(0).max(10_000_000),
  /** Days after the purchase before rewards are released, so a refund cancels them. */
  holdDays: z.number().int().min(0).max(60),
  /** Most rewards one member can earn. */
  maxRewardsPerReferrer: z.number().int().min(1).max(500),
  /** The invited member must have passed ID verification before rewards release. */
  requireVerifiedReferee: z.boolean(),
  /** The most of one order the wallet may pay for, as a percentage. */
  walletMaxPercent: z.number().int().min(10).max(100),
  /** Sign-ups credited to one inviter in a day before the rest go to a person for review. */
  maxReferralsPerDay: z.number().int().min(1).max(100),
});
export type ReferralSettings = z.infer<typeof referralSettingsSchema>;

export const DEFAULT_REFERRAL_SETTINGS: ReferralSettings = {
  enabled: true,
  referrerRewardPaise: 20_000,
  refereeRewardPaise: 10_000,
  minPurchasePaise: 49_900,
  holdDays: 7,
  maxRewardsPerReferrer: 20,
  requireVerifiedReferee: true,
  walletMaxPercent: 100,
  maxReferralsPerDay: 5,
};

/** Signals that send a referral to a person instead of paying out automatically. */
export const REFERRAL_FLAGS = ['same_network', 'same_phone', 'same_name_pattern', 'same_device', 'same_instrument', 'velocity'] as const;
export type ReferralFlag = (typeof REFERRAL_FLAGS)[number];

/** Gateways cannot take less than one rupee. */
export const MIN_CASH_PAISE = 100;

export interface WalletSplit {
  walletPaise: number;
  cashPaise: number;
}

/**
 * How much of a purchase the wallet pays. The remainder goes to the payment gateway, which cannot
 * take less than MIN_CASH_PAISE: if the wallet would leave a smaller amount, it pays a little less.
 */
export function splitWithWallet(amountPaise: number, walletBalancePaise: number, useWallet: boolean, maxPercent = 100): WalletSplit {
  if (!useWallet || walletBalancePaise <= 0 || amountPaise <= 0) return { walletPaise: 0, cashPaise: amountPaise };
  let wallet = Math.min(walletBalancePaise, amountPaise, Math.floor((amountPaise * Math.min(100, Math.max(0, maxPercent))) / 100));
  const cash = amountPaise - wallet;
  if (cash > 0 && cash < MIN_CASH_PAISE) wallet = Math.max(0, amountPaise - MIN_CASH_PAISE);
  return { walletPaise: wallet, cashPaise: amountPaise - wallet };
}

export const walletAdjustSchema = z.object({
  /** Positive adds, negative removes. */
  amountPaise: z
    .number()
    .int()
    .refine((n) => n !== 0, 'Enter an amount')
    .refine((n) => Math.abs(n) <= 1_000_000, 'That is more than one adjustment can be'),
  reason: z.string().trim().min(5).max(300),
});

export const referralDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  note: z.string().trim().min(5).max(500),
});

export const packOrderWalletSchema = z.object({ useWallet: z.boolean().optional() });
