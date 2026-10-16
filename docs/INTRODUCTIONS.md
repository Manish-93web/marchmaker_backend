# Introductions, credits and conversations

## State machine

`released -> viewed -> accepted_by_one -> mutually_accepted` (unlocked), or `declined` / `expired` from any open state. Terminal states never change.

| Event | What happens |
|---|---|
| Released (Phase 8) | Created from an approved suggestion with the reviewer's "why" text, shared-ground sentences and a 7 day expiry |
| Member opens it | `viewed`; their own `viewedAt` is recorded |
| Member accepts | Must have a credit. One credit is **held**, the first note is stored, state becomes `accepted_by_one` (or unlocks if the other already accepted) |
| Both accepted | In one transaction: both held credits are **consumed**, state `mutually_accepted`, a message thread opens |
| Member declines | State `declined`. Anyone holding a credit gets it back. The other member sees only the neutral ending |
| 7 days pass | `expired`; held credits returned |
| Block | Introduction ends (`closedReason: blocked`), held credits returned, thread closed, pair hidden from each other |

The other member's response is private until unlock: no "they said yes" nudge and no countdown pressure.

## Credit rules (immutable ledger)

Entry types: `grant`, `reserve`, `release`, `consume`, `expire`, `refund`, `adjust`. Each entry stores the balance after it. The user's `creditBalance` (available) and `creditsReserved` (held) are cached and updated in the same transaction as the ledger row. The ledger cannot be updated or deleted at the model layer.

- Accepting needs `creditBalance >= 1`; otherwise `402 NO_CREDITS` and the app shows the paywall.
- Business-event idempotency keys (`reserve:<intro>:<user>`) mean a retried transaction can never double-count.
- Purchases and subscription grants arrive in Phase 10. Until then credits come from the audited admin grant.

## Idempotency

`POST /introductions/:id/accept` requires an `Idempotency-Key` header. The first success is stored for 24 hours and replayed (with `Idempotent-Replay: true`) for any retry. The same key with a different body is `422`; a repeat while the first is still running is `409`. Failures are not stored, so a corrected retry works. State checks inside the transaction mean a refresh or a double tap with a *new* key still cannot reserve twice (`409`).

Concurrent accepts from both members conflict on the introduction document; the transaction retries and exactly one unlock happens, each member paying one credit.

## First notes and messages

- First note: 50 to 500 characters, no phone numbers, links, emails, spelled-out digits, chat handles or profanity (`firstNoteProblems`).
- Messages: text only, up to 1000 characters, same contact filter, 30 per minute per member. A `clientId` makes a retry return the original message.
- Contact details move only through **Share my contact details**, and only when both members have chosen to.

## Photos

Before unlock a member gets only the other person's heavily blurred preview (`blur` variant, 24 px wide). After unlock, `GET /introductions/:id/photos` returns short-lived (5 minute) links to the large variants and a watermark string containing the viewer's member mark, which the app overlays. Right-click and drag are disabled as a deterrent only.

## Reports

Severity comes from the category (`safety_threat` and `underage` are critical, which emits `safety.critical_report` for the on-call alert). The report keeps a frozen copy of the last 30 messages. Reporters see status only, never evidence. The moderation case workflow is Phase 12.

## Expiry and reminders

A job (every minute) expires lapsed introductions and sends the 48 h and 12 h reminders once each to members who have not yet responded. Markers are claimed atomically so two workers cannot send the same reminder.

## Data rights

Export includes a member's introductions summary, their own first notes and messages, reports made and credit history, never the other person's words. Erasure deletes the member's messages and notes, closes threads, ends open introductions, returns the other person's held credit and removes their blocks.
