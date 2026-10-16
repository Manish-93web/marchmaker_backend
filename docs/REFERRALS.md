# Referrals and wallet

## Flow

1. Every member has a referral code (set at sign-up). The invite link is `/register?ref=CODE`; the web app keeps the code until sign-up completes.
2. Sign-up with a valid code records a `Referral` (`attributed`). The invited member's network hash and phone hash are compared with the inviter's; a match adds a **flag** instead of blocking the sign-up.
3. The invited member's **first cash purchase** at or above the minimum (default ₹499) moves it to `qualified` and starts the hold (default 7 days). Later purchases change nothing. Wallet-only purchases never qualify, so wallet money cannot recycle itself into new rewards.
4. The sweep releases rewards when the hold ends, after re-checking:
   - the qualifying payment is still captured and not refunded, otherwise `rejected: purchase_refunded`;
   - both members are active (`ineligible` otherwise);
   - the invited member passed ID verification (waits up to 60 days, then `not_verified`);
   - the inviter is under the cap (default 20 rewards), otherwise `cap_reached`;
   - no flags. Flagged referrals go to `review` for a person.
5. Payout is one transaction: the referral flips to `rewarded` atomically, both wallets are credited (default ₹200 inviter, ₹100 friend) with idempotency keys, and `referral.rewarded` notifications are queued. Running the sweep twice never pays twice.

A reviewer (`wallet.adjust`) can approve or reject a flagged referral with a note; they cannot decide one they are part of. Settings (`settings.manage`) are editable in the console and audited; amounts are snapshotted when a referral qualifies.

Members see only a first name and a friendly state (`Joined`, `First purchase made`, `Rewarded`). They never see flags or why something was not paid.

## Wallet

`User.walletBalancePaise` is a cache of the **immutable** `WalletLedger` (`reward`, `spend`, `release`, `adjust`). A debit only matches when the balance covers it, so it cannot go negative, even with simultaneous purchases.

- **Packs only.** A member can pay for a pack partly or fully from the wallet (`useWallet`). Subscriptions are billed by the provider, so the wallet does not apply (D-064).
- The split keeps the gateway amount at zero or at least ₹1 (`splitWithWallet`).
- **Partly wallet:** the order's `amountPaise` is the cash due; the gateway order is for that amount; the invoice is for the cash actually paid. The wallet portion is reserved when the order is created and **returned** if the order expires unpaid.
- **Fully wallet:** no gateway order, no payment, no invoice (no cash was received); credits are granted at once.
- Admin adjustments (positive or negative) need a reason, are audited and cannot take a wallet below zero.

## Operational notes

- Wallet credit is promotional, not money: it is not withdrawable and not refunded in cash.
- Refunding the cash part of an order does not return wallet money automatically; support does that with an adjustment and a reason.
