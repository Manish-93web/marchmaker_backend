# Running costs

Rough monthly figures in INR for a launch-size platform (about 2,000 members, 300 paying). They are planning estimates from public list prices, not quotes: check each vendor's current page before budgeting. Rates move; the *structure* of the cost is what matters.

## Fixed

| Item | Choice | About (INR/month) | Notes |
|---|---|---|---|
| API + worker containers | 2 small instances each | 4,000-8,000 | One API and one worker are enough to start; run two for rolling deploys |
| MongoDB | Managed replica set (Atlas M10 or equivalent) | 4,500-6,500 | Transactions need a replica set; do not use a free tier in production |
| Redis | Managed, 1 GB | 1,000-2,000 | Queues and shared rate limits |
| Object storage | S3-compatible, ~50 GB | 100-300 | Photos, identity images (deleted after review), invoices, attachments |
| Web hosting + CDN | Static hosting | 0-1,500 | Two static apps (web, admin) |
| Error tracking | Sentry team | 2,200 | Free tier works at first, with a lower event cap |
| Backups | Snapshot + offsite copy | 300-800 | See `scripts/backup.sh`; run the restore drill quarterly |
| Domain + TLS | | 100 | |

## Variable (per use)

| Item | Unit cost | Driver | Example at launch size |
|---|---|---|---|
| Razorpay | ~2% + GST per payment | Revenue | 300 x INR 999 = ~INR 6,000 |
| Email (Resend or SES) | ~INR 0.1-0.7 per email | Notifications | 40,000 emails = ~INR 2,000 |
| SMS OTP (MSG91) | ~INR 0.2-0.5 each | Sign-ups and logins | 6,000 OTPs = ~INR 2,500 (cheaper with `OTP_CHANNEL=whatsapp`) |
| WhatsApp (Meta) | Utility ~INR 0.1-0.8, authentication ~INR 0.3-0.4 per message | Premium notifications, OTP | 5,000 messages = ~INR 2,000 |
| Automated KYC | ~INR 20-60 per check | Verifications | 1,500 checks = ~INR 45,000 (largest variable cost) |
| Photo checks (Rekognition) | ~USD 0.001 per image per feature | Photo uploads | 6,000 photos = ~INR 1,000 |
| TURN relay (voice) | Bandwidth only; ~USD 0.1 per GB relayed | Voice calls | Most calls connect directly; budget INR 500 |
| Phone call bridge (Exotel) | ~INR 0.5-1 per minute | Only if phone bridge is used | |
| Astrology API | Per call, vendor specific | Premium readings | cached per introduction |
| Voice transcription / narrative rewrite | Per use | Optional features | Off unless enabled |

## Reading the table

- KYC dominates. Mock/manual-only review costs reviewer time instead; the automated path lets high-confidence results skip a person, which pays for itself above a few hundred verifications a month.
- Everything with a per-message cost respects member preferences and quiet hours, so switching a category off saves money as well as noise.
- The admin console shows delivery counts per channel (Notifications > Delivery log) to keep the variable lines honest.
- Circuit breakers stop retry storms against a failing vendor, which also stops runaway usage charges.

## Levers

1. Prefer WhatsApp OTP over SMS once templates are approved.
2. Raise the KYC auto-approve confidence only if reviewer cost is higher than the risk you accept.
3. Keep identity-image retention short (`retention.evidenceDays`); it lowers storage and exposure.
4. Digest emails (one a day at most) replace per-message emails.
