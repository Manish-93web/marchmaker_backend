# Gap analysis against the master build prompt

Checked after Phase 16 against `MERN_Matrimony_Build_Prompt.md`, section by section, using the code, tests and docs in both repos. **Done** items are omitted; everything listed is **Partial** (built, but not as specified or incomplete), **Pending** (not built), or **Unverified** (built but only tested against mocks). IDs are for tracking.

Priority: **P0** blocks launch · **P1** should be done before or soon after launch · **P2** nice to have.

## A. Pending: specified but not built

| ID | Spec | Gap | Pri |
|---|---|---|---|
| A1 | M19 | WhatsApp: no inbound webhook (GET verify, delivery/read status, **STOP opt-out keyword**); no template registry (`whatsappTemplates`); no WhatsApp **OTP** channel; no `whatsappOptIns` record (consent only) | P0 if WhatsApp is used |
| A2 | M15 | **Resend/email webhooks** (delivered, bounced, complained), `emailEvents`, **suppression list** | P0 |
| A3 | M15 | Dedicated **React Email templates** for each event (only a generic notice and verify-email exist; copy is data-driven, not separately designed templates); **message digest** email | P1 |
| A4 | M12 | Support: **attachments**, **CSAT rating**, **live SSE updates**, "awaiting member / awaiting team" status split, **one-click escalation of a ticket into a moderation case** | P1 |
| A5 | M11 | Report **screenshot evidence** upload; critical reports alert by **WhatsApp** (email only today); a dedicated **safety centre** page with resources and helpline (a Safety marketing page and tips exist) | P1 |
| A6 | M16 | **Field-level encryption** only covers phone and date of birth; ID document number, income band and health/disability notes are not separately encrypted; least-privilege DB users and KMS are documented, not provisioned | P0 |
| A7 | M2 | **Change phone** with re-verification (email change exists); data export is JSON only, **no photos zip** | P1 |
| A8 | M9 | Photo checks: **face-present check** not implemented (NSFW adapter and duplicate hash exist, NSFW provider is a no-op until configured) | P1 |
| A9 | S8 | Feedback loop: feedback **on thread close**, the **"did you meet?" milestone**, feeding feedback into **matching weights** (only member-visible suggestions and a staff view exist), admin **relevance report per matchmaker/dimension/time** | P1 |
| A10 | M13 / §4 | Referral wallet: **max % of order** payable from wallet (any amount up to the price today), **device-fingerprint** and **payment-method** checks, **velocity limits**, QR share, wallet usable on subscriptions (packs only by decision D-064) | P1 |
| A11 | §11 | Admin screens missing: **jobs / dead-letter viewer with retry**, **data requests approval**, **legal document versions editor**, FAQ CMS, **notification template preview, WhatsApp templates, delivery logs**, **introductions monitor** (stuck/expiring), reports **Kanban**, **wallet/credit ledger views**, invoices list, saved member filters, retention-days setting | P1 (jobs/DLQ and data requests: P0) |
| A12 | §11 | Plans editor can edit seeded plans only; no **create/archive plan**; no admin view of **reconciliation status** beyond "Reconcile now" | P1 |
| A13 | §2 | **Sentry** (web, api, worker) and **PostHog** are not integrated. Replaced by first-party consent-gated analytics (GROWTH.md). No error tracking in production | P0 (Sentry) / P2 (PostHog) |
| A14 | §15 | **migrate-mongo** migrations; **seed of 40 realistic demo members** with photos, suggestions and introductions in every state; real **deploy steps** in CI (staging on main, production on tag are placeholders) | P1 |
| A15 | §15 | Docs: **COSTS.md** (monthly estimate at 1k/10k/100k); NOTIFICATIONS.md lacks the **event × channel × can-disable × template matrix** required by §13 | P1 |
| A16 | §14 | Tests: the **full E2E journey** (verification, admin approval, match review, accept, pay, unlock, message, feedback) — only 3 specs; **visual checks at 360/768/1280**; axe runs in jsdom, not in Playwright; **80% coverage on the domain** is not measured or enforced | P1 |
| A17 | S1 | Astrology: **no in-house Guna Milan / Manglik engine**; relies on a licensed provider (decision D-077); visibility control is per-introduction consent only | P2 |
| A18 | C1 | E-guides: **guideProgress** (resume position, per-member progress), playback speed UI (native controls only) | P2 |
| A19 | C2 | PWA: **update-available toast**; not built with vite-plugin-pwa/Workbox (hand-written minimal service worker, by decision D-079) | P2 |
| A20 | §12 | Shared UI kit (`packages/ui`) has only 11 primitives; **Select, Combobox, Dialog/Sheet, Tabs, Accordion, Tooltip, Avatar, Stat tile, Timeline, PricingCard, AudioPlayer, ConfirmDialog, NotificationBell, CommandPalette** are implemented inside the apps, not the library or Storybook | P2 |
| A21 | §12 | Custom **line-art SVG illustrations** for empty states and onboarding; testimonials carousel and animated marigold mesh on the landing page (verify visually) | P2 |
| A22 | §2 | **Hindi strings**: i18n structure is ready and voice typing supports Hi-IN, but there is no Hindi translation | P1 |

## B. Partial: built differently from the spec

| ID | Spec | What was built instead | Decision |
|---|---|---|---|
| B1 | C3 voice calls | **Masked phone calls bridged by a telephony provider** (Exotel), not WebRTC with TURN; no in-call report/mute controls | D-075 (confirm this is acceptable; WebRTC would be a rebuild) |
| B2 | §4 invoices | **pdfkit** instead of `@react-pdf/renderer` | D-048 |
| B3 | §2 charts | **Hand-drawn SVG/CSS** instead of Recharts | none; fine for current charts |
| B4 | §2 UI | Custom components with Tailwind + Radix-style patterns, **not shadcn/ui** | none |
| B5 | §10 | **Own circuit breaker** (used for KYC) instead of `opossum`; breaker not applied to WhatsApp/email/payments calls (they have timeouts and retries) | none |
| B6 | §4 billing | Spec endpoints differ in name (`/billing/subscribe` vs `/billing/subscriptions`); **pause** subscription not offered | D-049 |
| B7 | M6/M7 | Queue sorted by plan priority and waiting time, per-matchmaker capacity and SLA exist; SLA **timers/breach alerts** are surfaced on dashboards, not pushed | none |
| B8 | §2 | `zod-to-openapi` covers a **subset** of routes (auth, account, content, billing entries); later phases' routes are not all documented | none |
| B9 | M17 | Vendor-neutral **REST adapter + mock**; no HyperVerge/IDfy/Digio mapping; no DigiLocker/Aadhaar offline XML | KYC.md |
| B10 | M18 | Liveness depends on the same adapter result; manual fallback exists; no vendor SDK embedding in the web app | KYC.md |
| B11 | §2 SMS | MSG91 adapter written for DLT templates but never run against a live account | SECURITY_REVIEW.md |
| B12 | §3 | Admin "impersonate view" is read-only and audited (matches spec); **Messages tab** appears only through moderation reports (matches) — but no **Credits/Wallet/Payments tabs** on the member detail page beyond a summary | A11 |
| B13 | §12 | Pricing toggle, comparison table and credit guarantee exist; **"Most chosen" badge** exists; **testimonials** come from admin-managed stories | none |
| B14 | §8 collections | Names differ (`creditLedger`, `orders`...) and some are combined: no `whatsappOptIns`, `whatsappTemplates`, `emailEvents`, `guideProgress`; calls are `callLogs` not `callSessions`; astrology is `astroProfiles`/`astroReports` | A1, A2, A18 |

## C. Unverified: built, tested only against mocks or on paper

| ID | Item | Needs |
|---|---|---|
| C1 | Razorpay live checkout, subscriptions, webhooks, refunds | live/test-mode account; end-to-end test with real signatures |
| C2 | SMS OTP (MSG91/DLT), email delivery, WhatsApp, web push (VAPID) | accounts and approved templates |
| C3 | KYC vendor, telephony (Exotel), astrology provider | contracts; vendor sandbox payloads |
| C4 | Dockerfiles and `docker-compose.yml` | Docker was never available on the development machine |
| C5 | k6 load scripts, `backup.sh`, `restore-drill.sh` | k6, Mongo tools and a staging stack; time the restore |
| C6 | Redis-backed limiter and BullMQ against a real Redis | the code paths are unit-tested with fakes; the Mongo/Redis stack was never run together |
| C7 | Lighthouse ≥ 90 on mobile for public pages | not measured |
| C8 | Contrast and screen-reader behaviour | manual pass (ACCESSIBILITY.md) |
| C9 | Independent security review | penetration test |

## D. Suggested order

1. **P0 before any real member:** A2 email webhooks + suppression, A6 field encryption + KMS, A13 Sentry, A11 jobs/DLQ viewer and data-request approval, A1 (if WhatsApp is in the launch scope), then all of C (accounts, vendor mapping, staging runs).
2. **P1 for the first month:** A3, A4, A5, A7, A8, A9, A10, A11 (rest), A12, A14, A15, A16, A22.
3. **P2:** A17–A21, B1 if WebRTC is a hard requirement.
