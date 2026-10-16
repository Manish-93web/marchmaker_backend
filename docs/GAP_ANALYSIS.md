# Gap analysis against the master build prompt

First written after Phase 16 by checking `MERN_Matrimony_Build_Prompt.md` section by section. The `gap-closure` branch then worked through every Pending (A) and Partial (B) item. This file now records what was done, what was deliberately left, and what still needs things only the owner can provide (accounts, vendors, a staging stack).

## A. Pending items: closed

| ID | What changed |
|---|---|
| A1 | WhatsApp inbound webhook (GET verify, POST with Meta HMAC), delivery and read receipts, **STOP/START opt-out** words, `whatsappTemplates` registry (send only when approved), `whatsappOptIns`, **WhatsApp OTP** channel (`OTP_CHANNEL`), template and opt-in admin screens |
| A2 | Resend webhook (Svix signature, de-duplicated), `emailEvents`, **suppression list** keyed by hash, honoured by the mailer, admin screen to review and remove |
| A3 | Named email templates per event family (introductions, payments, verification, support and safety, digest) and a once-a-day **message digest** (count only, opt-in) |
| A4 | Support attachments, one-time **CSAT** rating and summary, **live updates** (signal-only stream), statuses `open / awaiting_member / awaiting_team / resolved / closed`, **escalate a ticket to a moderation report** |
| A5 | Report **screenshots** (private, audited when viewed), **WhatsApp paging** for critical reports, in-app **safety centre** with India helplines |
| A6 | Key ring with versions, **KMS unwrap**, blind-index key, rotation script, least-privilege MongoDB users script. Income band and health notes were already encrypted; the ID number is **intentionally never stored** (last four characters only) |
| A7 | **Change phone** with a code sent to the new number; data export is now a **zip with the member's own photos** |
| A8 | **Face-present** and explicit-content checks through an adapter (mock and AWS Rekognition); no face flags the reviewer, never auto-rejects |
| A9 | Feedback on **ending a conversation**, the **"did you meet?"** question at three weeks, **bounded weight nudges** (30 ratings, 0.05 cap, can be switched off) and an admin **relevance report** per matchmaker and signal |
| A10 | Wallet **max % of an order**, same-device, same-payment-instrument and sign-up **velocity** flags, **QR** share. Wallet on subscriptions stays out by decision D-064 (subscription amounts belong to the payment provider) |
| A11 | Admin: **jobs and dead-letter viewer with retry**, **data request approval**, **legal version editor**, **FAQ CMS**, notification **catalog and email preview**, **WhatsApp templates**, **delivery log**, suppression list, **introductions monitor**, **reports board**, member **finance / ledgers / safety / tickets / feedback** tabs, **invoices list** with audited download, **saved member filters**, **retention** and data-request settings |
| A12 | **Create** plans and packs (start switched off; archive = switch off), reconciliation **status** (last run, what is pending) |
| A13 | **Sentry** in the API, worker and both browser apps with personal-field scrubbing. PostHog is not used, by decision (first-party, consent-gated analytics) |
| A14 | **migrate-mongo** migrations and a `sync-indexes` release step, **40-member demo seed** with photos, suggestions and introductions in every state, a **real deploy workflow** (build and push images, migrate, roll out through the host's hook, wait for health) |
| A15 | `docs/COSTS.md`; the **event x channel x can-disable x template matrix** in `docs/NOTIFICATIONS.md`, generated from the catalog and checked by a test |
| A16 | **Full journey** E2E (staff approvals, matching, payment, unlock, conversation, feedback), **axe in Playwright** on public, member and admin screens, **360 / 768 / 1280** layout checks (no sideways scroll, one-line header) with screenshots, **coverage enforced** (lines and statements at least 80%, measured 87.9% and 82.7%) |
| A17 | The astrology contract carries **manglik** and a **Guna Milan verdict**; both appear in the chart and match panels. An in-house ephemeris engine is still not built (the spec allows a provider; D-077) |
| A18 | **guideProgress** (resume position, speed, completed) on any device |
| A19 | **Update-available toast** (the new service worker waits until the member refreshes) |
| A20 | Radix **Dialog, Sheet, ConfirmDialog, Tabs, Accordion, Select, Tooltip, Avatar** plus **Combobox, StatTile, Timeline, PricingCard, AudioPlayer, NotificationBell, CommandPalette**, with stories and tests; the apps use the shared Dialog, Tabs and CommandPalette |
| A21 | Hand-drawn SVG hero, step and shield art, a default empty-state picture, an accessible **testimonial carousel**, the existing animated mesh background |
| A22 | **Hindi** for every web namespace with a language switcher; a test fails if a Hindi key is missing or loses a placeholder. Notification text, legal documents and assessment questions written by the server are still English |

## B. Partial items: closed

| ID | What changed |
|---|---|
| B1 | **In-app WebRTC voice calls** (server-relayed signalling, short-lived TURN credentials, mute, end, report, timer). The masked phone bridge remains as a fallback |
| B2 | Invoices render with **@react-pdf/renderer** |
| B3 | Admin charts use **Recharts** with a text alternative |
| B4 | Radix-based shared primitives in `packages/ui` (not shadcn/ui; equivalent behaviour, no copy-paste components) |
| B5 | **opossum** circuit breakers on email, SMS, WhatsApp, push, payments, telephony, astrology and KYC; circuit state is shown in the admin console |
| B6 | Spec-named billing endpoints (`/billing/subscriptions`, `.../change`, `.../cancel`, `/orders`, `/coupons/validate`, `/summary`) alongside the original ones, and **pause / resume** subscriptions |
| B7 | SLA breach **alerts are pushed** (email, optional WhatsApp, digest) |
| B8 | The OpenAPI document is **generated from the mounted routes** and their validation schemas |
| B9 | **Declarative HyperVerge, IDfy and Digio presets**, correctable with `KYC_MAPPING_JSON`. Written from documentation, **not run against live accounts**. DigiLocker / Aadhaar offline XML is not built |
| B10 | Hosted-vendor redirect flow in the web app with polling when the member returns. Embedding a vendor's SDK is not done |
| B11 | MSG91 adapter unchanged; still never run live (see C2) |
| B12 | Member-detail Finance, Ledgers, Safety, Tickets and Feedback tabs |
| B13 | No change needed |
| B14 | `emailEvents`, `whatsappOptIns`, `whatsappTemplates`, `guideProgress` added. Calls stay `callLogs` and astrology `astroProfiles` / `astroReports` (names differ from the spec's, behaviour matches) |

## C. Still unverified: needs accounts, vendors or a staging stack

These cannot be completed on a development machine. Each needs something from the owner; nothing here has been run against the real thing.

| ID | Item | Needs |
|---|---|---|
| C1 | Razorpay live checkout, subscriptions (including pause and resume), webhooks, refunds | test-mode account and real signatures |
| C2 | MSG91 SMS (DLT), Resend, WhatsApp (templates approved by Meta), web push (VAPID), their webhooks | accounts and approved templates |
| C3 | KYC vendors (presets unverified), Exotel, the astrology provider, AWS Rekognition, KMS rotation | contracts and sandbox payloads |
| C4 | Dockerfiles, `docker-compose.yml`, the deploy workflow | Docker, a registry and a host with a redeploy hook |
| C5 | k6 load scripts, `backup.sh`, `restore-drill.sh` | k6, Mongo tools, a staging stack; time the restore |
| C6 | Redis-backed limiter and BullMQ together with Mongo | a running stack |
| C7 | Lighthouse of at least 90 on mobile for public pages | a Lighthouse run on the deployed site |
| C8 | Screen-reader and contrast review | a manual pass (ACCESSIBILITY.md); axe is automated and passes |
| C9 | Independent security review | a penetration test |
| C10 | TURN relay for voice under real NATs | a coturn server with `RTC_TURN_*` set |
| C11 | Hindi quality | a native speaker's review of the translations |

## D. Left out on purpose

- PostHog (first-party analytics instead).
- Wallet payment on subscriptions (D-064).
- shadcn/ui as a dependency (Radix primitives directly).
- A built-in ephemeris for kundli (a licensed provider is used).

## E. Second audit (after closure) against the same prompt

Re-read the full prompt and checked it against the code: every `/api/v1` route (generated from the router), the notification catalog, admin screens, UI kit, docs and infrastructure files. Items A, B and C above stand. This pass found the following that were not listed before.

### Pending

| ID | Spec | Gap | Pri |
|---|---|---|---|
| E1 | M15 / §13 | **Email events missing from the catalog and the matrix:** welcome, subscription renewed / cancelled / expiring, legal-document update, first note received, "report received" acknowledgement to the reporter, account deletion scheduled. (Verify, OTP-fallback, export-ready and deletion-completed are sent outside the catalog.) "Introduction accepted" is excluded on purpose (D-039) but the spec lists it | P1 |
| E2 | §11.3 | Member detail has no **Introductions**, **Messages** (moderator-only, audited) or **Audit** tab. Reports, support, credits, wallet, payments, notes exist | P1 |

### Partial

| ID | Spec | What exists | Pri |
|---|---|---|---|
| E3 | §9 | Same behaviour, **different path names**: `/auth/forgot-password` and `/auth/reset-password` (spec `/auth/password/...`), `/feedback/introductions` (spec `/introductions/:id/feedback`), `/support/tickets/:id/reply` and `/rating` (spec `/messages` and `/rate`), `/billing/invoices/:id/download` (spec `/pdf`), `/notifications/read-all` and `/:id/read` (spec `/read`), `/notifications/push` (spec `/push/subscribe`), `/guide-progress/:slug`, `/astrology/details` and `/introductions/:id/astrology`. No separate `/wallet/ledger` | P2 |
| E4 | §2 / OpenAPI | The generated document omits the Resend, WhatsApp and call webhooks (they are mounted outside the versioned router) | P2 |
| E5 | §12 | Light/dark/system theme is saved **per browser**, not per member account | P2 |
| E6 | M9 | Revealed photos have a watermark and dragging is disabled; **right-click is not blocked** (spec asks, as a deterrent only) | P2 |
| E7 | §12 components | Slider/RangeSlider, Stepper, IntroductionCard, BlurredPhoto, PhotoUploader, CameraCapture, Toast, DataTable, ConsentBanner and Banner variants are in the apps, not the shared library or Storybook | P2 |
| E8 | §2 | Spec names `vite-plugin-pwa` (Workbox) and `vite-ssg` / `vite-plugin-prerender`; a hand-written service worker and a custom prerender script are used (D-079) | P2 |
| E9 | §8 | Several collection names differ from the spec (`reports` doubles as moderation cases, tickets and ticket messages are `tickets` / `ticketmessages`, `callLogs`, `astroProfiles`) | P2 |
| E10 | S7 / §16 | No PostHog funnels or `POSTHOG_KEY`; replaced by first-party analytics and an admin Insights page (decision recorded) | P2 |

### How far this pass went

Checked directly: routes, notification catalog, admin member tabs, UI kit contents, docs list, CSP nonce, admin session limits, Mailpit in compose, Mermaid diagram. **Not re-run line by line:** every sentence of M3 to M12 behaviour (profile conflict dialog, review safeguards, moderation actions and so on); those were verified by their phase tests earlier. If a specific section matters most, name it and it can be audited in depth.
