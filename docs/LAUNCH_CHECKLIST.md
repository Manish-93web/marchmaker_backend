# Launch checklist

Work through this in order. Each line is something a person confirms, with a name and a date. Nothing here is automatic.

## 1. Accounts, contracts and approvals (long lead time: start now)

- [ ] Company registered; GST registration; seller GSTIN, address and state set in `GST_SELLER_*` (invoices are legally issued under these).
- [ ] Razorpay live account approved for subscriptions and orders; plans and any coupon **offers** created; live key, secret and **webhook secret** set; webhook URL `https://<api>/api/v1/webhooks/razorpay` added with events `payment.*`, `order.paid`, `subscription.*`, `refund.*`.
- [ ] SMS: MSG91 (or equivalent) account, DLT sender id and the OTP **template approved**; `MSG91_AUTH_KEY` and `MSG91_OTP_TEMPLATE_ID` set. Send a real OTP to a real phone.
- [ ] Email: sending domain with SPF, DKIM and DMARC; `EMAIL_FROM` and `SUPPORT_EMAIL` mailboxes monitored; send each template to a real inbox (verification, notices, invoice, unsubscribe link).
- [ ] WhatsApp (if used): business account, `mm_notification` template approved (two variables), consent wording reviewed.
- [ ] KYC vendor contracted; sandbox then live; **map the vendor's payloads** to `KycSession` / `KycResult` (see `docs/KYC.md`) and verify the webhook signature scheme with the vendor; test an accept, a reject and a "needs review".
- [ ] Voice calls (if used): Exotel account, virtual number, `CALLS_WEBHOOK_SECRET`; a signing relay in front of Exotel callbacks (see `docs/EXTRAS.md`).
- [ ] Astrology (if used): licensed provider contract and `ASTROLOGY_*`; flag stays off until verified.
- [ ] Legal documents reviewed by counsel: Terms, Privacy, Cookie, Refund, Community Guidelines, **Grievance Officer** named with real contact details (DPDP).
- [ ] Accountant has confirmed: GST treatment of wallet-funded packs (D-066), credit notes, place-of-supply default (D-043), SAC code.
- [ ] Data Protection: records of processing, retention periods approved (`docs/DATA_RETENTION.md`), breach procedure agreed (`docs/RUNBOOK.md`).

## 2. Infrastructure

- [ ] MongoDB **replica set** (transactions are required) with continuous backup; database users per service; no public access.
- [ ] Redis (managed, persistent); `REDIS_URL` set (production refuses to start without it).
- [ ] Object storage: three buckets (photos, identity, documents), identity bucket with **separate credentials**, no public listing, versioning on, lifecycle rules.
- [ ] TLS at the edge, HSTS, HTTP to HTTPS redirect; `APP_URL`, `ADMIN_URL`, `CORS_ORIGINS` are https.
- [ ] Admin app on a separate origin, ideally behind IP allow-listing or a zero-trust gateway.
- [ ] WAF / rate limiting at the edge; request size limit at the proxy.
- [ ] Secrets in a secret manager. **New** `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `FIELD_ENCRYPTION_KEY` (32 bytes) generated for production; `FIELD_ENCRYPTION_KEY` held in KMS with a documented rotation plan. The development defaults are refused at start-up.
- [ ] Database user for the API cannot update or delete `auditlogs` (the code enforces immutability; the database should too).
- [ ] Logging to a central store with retention; alerts from `docs/RUNBOOK.md` configured and tested by causing each one.
- [ ] Backups: nightly `scripts/backup.sh` running, restore drill done once **and timed**, result written in the runbook.
- [ ] Production environment started once with `NODE_ENV=production`: the start-up guard passes.

## 3. Application

- [ ] `pnpm lint`, `typecheck`, `test`, `build` green in both repos; `pnpm audit --prod` has no high or critical findings.
- [ ] End-to-end suite green against a staging stack (`docs/E2E.md`).
- [ ] Load test on staging meets its thresholds (`docs/LOAD_TESTING.md`); results kept.
- [ ] Seed run on production: legal documents, plans, assessment banks, feature flags (all optional ones **off**), first super admin with two-factor **and recovery codes stored safely**.
- [ ] Plans and prices confirmed in the console; a real ₹1 test payment, a refund and the credit note, an invoice PDF opened.
- [ ] Subscription test: start, renew (use a short test plan), fail a renewal (grace, then lapse), cancel.
- [ ] Notification test: introduction released → in-app, email, push; quiet hours hold; unsubscribe link works.
- [ ] A full member journey done by a person on a real phone: sign up, verify email and phone, profile, assessments, photos, ID verification, review, introduction, accept, unlock, message, report, block, delete account (and the export).
- [ ] Staff journey: review a profile, a photo, a verification, a match; moderate a report; answer a ticket; refund a payment.
- [ ] Accessibility: automated checks green; manual pass with a screen reader (NVDA or VoiceOver) and keyboard-only on sign-up, an introduction, billing (`docs/ACCESSIBILITY.md`).
- [ ] Mobile pass on a low-end Android over a slow connection.

## 4. People and process

- [ ] At least two super admins, each with their own recovery codes; an access review of every role.
- [ ] Matchmakers, verifiers, moderators and support trained on `docs/ADMIN.md`, `docs/MATCHING.md`, `docs/SAFETY.md`; review SLAs agreed; on-call rota for critical safety reports.
- [ ] Grievance officer and support inbox staffed; response targets published (7 days grievance, 24 h support).
- [ ] Penetration test done by an independent party; findings fixed or accepted in writing.
- [ ] Incident drill: simulate a payment webhook outage and a suspected breach using the runbook.
- [ ] Status page / member communication plan ready.

## 5. Go-live

- [ ] Invite-only soft launch first (small cohort), feature flags off for optional features.
- [ ] Watch Insights daily for the first two weeks: funnel drop-offs, review times, payment failures, tickets.
- [ ] Open registration only after the soft-launch review meeting.
- [ ] Turn on optional features one at a time, each with its own mini-checklist from `docs/EXTRAS.md`.
