# Notifications

## Pipeline

```
domain event --(outbox)--> worker --> dispatchEvent --> Notification (in-app row)
                                                   \--> Delivery rows per channel
                                                         email | push | whatsapp
```

1. Services write a domain event to the transactional outbox (same transaction as the state change).
2. The worker relays it to BullMQ. Every event type in `NOTIFICATION_SPECS` has a consumer that calls `dispatchEvent`. More than one consumer may exist per event (billing renders the invoice PDF, notifications tells the member).
3. `dispatchEvent` finds the recipients, writes one in-app `Notification` (unique on user + type + source, so a retried event never duplicates), decides channels, writes a `Delivery` row for every channel (including `skipped`, with the reason) and sends what is due.
4. `sendDueDeliveries` runs every minute: it sends deliveries whose quiet hours ended and retries failures (2, 4, 8 minutes; four attempts).

## Who hears about what

The catalog lives in `packages/shared/src/notifications.ts`: category, whether it is critical, which channels apply, a stable source id and the copy. Copy is neutral by construction: no names, no scores, no message text, and nothing about whether the other person said yes before unlock (D-039). A test checks the copy for forbidden patterns.

`introduction.accepted_by_one` is **deliberately not notified**.

## Channel rules

| Channel | Needs |
|---|---|
| In-app | always (unless the category is switched off; safety/verification/critical are forced on) |
| Email | an email address; for product updates also the `marketing_email` consent |
| WhatsApp | `whatsapp` consent, a verified phone, Premium or Concierge plan, provider configured; approved template `mm_notification` with two variables |
| Push | at least one registered browser, provider configured (VAPID) |

Quiet hours (default 22:00 to 08:00 India time, editable) hold email, WhatsApp and push until they end. In-app is immediate. **Critical** messages (payment failed, plan lapsed, verification rejected, safety) are never held and cannot be fully switched off.

## Email

Rendered with React Email (`renderNotice`), HTML + plain text. Non-critical mail carries a signed one-click unsubscribe link (`/unsubscribe?t=…`, HMAC over user and category) and `List-Unsubscribe` / `List-Unsubscribe-Post` headers. Unsubscribing turns off email for that category only.

## Live updates

`GET /notifications/stream` is server-sent events backed by a MongoDB change stream on the notifications collection, filtered to the caller. It emits `ready` and `notify` with the unread count. Up to three streams per member; the client falls back to a 60 second poll of `/notifications/unread-count`.

## Providers

| | Mock | Real |
|---|---|---|
| Email | `MemoryMailer` | SMTP (Resend or any SMTP relay) |
| WhatsApp | `MemoryWhatsApp` | Meta Cloud API, template messages only |
| Push | `MemoryPush` | `web-push` with VAPID keys |

Production refuses mock WhatsApp and push. Generate VAPID keys with `npx web-push generate-vapid-keys`.

## Operations

- On-call: `safety.critical_report` emails `ONCALL_EMAIL` (falls back to `SUPPORT_EMAIL`) immediately; the handler throws on failure so the queue retries.
- A failed delivery never blocks the others, and never fails the event.
- SMS is used only for OTP; it is not a notification channel.
