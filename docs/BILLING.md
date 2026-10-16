# Subscriptions, packs, invoices

## Flows

**Pack (one-off).** `POST /billing/packs/order` creates a provider order for the (coupon-adjusted) amount and a local `Order`. After checkout, the *webhook* (`payment.captured` / `order.paid`) grants credits. The browser callback calls `POST /billing/confirm`, which verifies the signature and then **asks the provider** what happened; credits are only ever granted from provider data.

**Subscription.** `POST /billing/subscribe` creates (or reuses) a provider plan for the (plan, interval, price), then a provider subscription, and returns what Razorpay Checkout needs. The first `subscription.charged` activates the plan, records the payment, grants that cycle's credits and issues the invoice. Every renewal repeats this.

## Idempotency and ordering

- Webhooks are verified (HMAC over the exact bytes), **stored first** (`webhookevents`, unique on provider + event id) and then processed; duplicates return 200 without work.
- The same payment can arrive as `payment.captured`, `order.paid`, `subscription.charged` and via reconciliation. The real guards are: `Order.status` flipped atomically, `Payment.razorpayPaymentId` unique, and ledger idempotency keys (`pack:<paymentId>`, `sub:<paymentId>`). Concurrent deliveries therefore grant once.
- Subscription states: terminal states (`cancelled`, `completed`, `expired`) are sticky; the billing period never moves backwards; an unknown state is ignored.
- A pack payment whose amount differs from the order is recorded, **not** granted, and flagged `amount_mismatch` plus a `billing.needs_review` event.

## Dunning

`subscription.halted` sets `graceUntil = now + 3 days`, marks the plan `grace` and emits `billing.payment_failed` (with the provider's update link). The member keeps access during grace. The sweep `lapseAccess` moves the plan to `free` (status `lapsed`) once grace has passed, or once a cancelled/completed subscription's paid period has ended. A successful retry (`activated`/`charged`) clears the grace.

## Credits

Credits live in **lots** (`creditlots`): subscription lots expire at the end of the cycle *after* the one they were granted in (roll over once), pack and admin lots never expire. Spending draws the soonest-expiring lot first. `expireDueLots` writes an immutable `expire` ledger entry and never takes the balance below zero. Refunds revoke credits in proportion to the money returned (`refund` ledger entry).

## Plan changes

| Change | Effect |
|---|---|
| Upgrade | Immediate. Extra credits = (new − old credits) × share of the cycle left, rounded down. |
| Downgrade / period change | Scheduled at cycle end (`pendingChange`); applied by the first charge of the new cycle. |
| Cancel | At period end only. Access continues until `currentPeriodEnd`. |

## Invoices

Sequential per financial year and kind (`INV/2026-27/000001`, `CN/2026-27/000001`); the counter increment is inside the same transaction as the payment, so a failure leaves no gap. Amounts are GST-inclusive; `gstFromInclusive` splits CGST+SGST (same state) or IGST. PDFs are rendered by the worker (`invoice.created`) into the `documents` bucket and served through 5-minute signed links. A refund issues a credit note linked to the invoice.

## Reconciliation

Every sweep (10 minutes): orders pending > 10 min are looked up with the provider (paid ones are fulfilled, ones older than 24 h are expired and their coupon use returned); non-final subscriptions are re-read; unprocessed webhooks (< 10 attempts) are retried. Admins can replay a webhook and trigger a reconciliation run from the console.

## Known limits

- A missed `subscription.charged` cannot be rebuilt from a subscription read alone (the payment details are not in it). Replay it from the provider dashboard or the admin replay.
- A mock provider is available for development and tests (`PAYMENTS_PROVIDER=mock`, refused in production). `POST /billing/dev/mock-pay` completes a mock checkout and is not mounted in production.
