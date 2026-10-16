# Operations runbook

Who to call, what to check and how to recover. Keep this printed or somewhere that does not depend on the platform being up.

## Service map

| Piece | Role | Health |
|---|---|---|
| `api` | REST API | `GET /healthz` (process), `GET /readyz` (database connected, not shutting down) |
| `worker` | outbox relay, queues, sweeps (reconcile payments, release matches and rewards, notifications, retention) | logs `relay`, dead-letter queue depth |
| MongoDB (replica set) | system of record; transactions are required | Atlas or `rs.status()` |
| Redis | shared rate limits, BullMQ | `PING`; rate limits fall back to per-process if it is down |
| Object storage | photos, identity evidence (separate bucket and credentials), documents (invoices, guide audio) | provider status |
| Razorpay, Exotel, MSG91, email relay, KYC vendor | external | each provider's status page |

## Alerts to configure

- API 5xx rate above 2% for 5 minutes; p95 latency above 1 s.
- `readyz` failing for 2 minutes.
- Worker: outbox pending older than 10 minutes; dead-letter queue not empty; sweep errors.
- Payments: webhook rows unprocessed after 15 minutes (console: Payments, Payment webhooks); `billing.needs_review` events.
- Support: tickets or reports overdue (Insights shows both).
- A critical safety report emails `ONCALL_EMAIL` immediately.
- Disk, memory and Mongo replication lag as per the platform defaults.

## Incident basics

1. Declare it: one person leads, one person writes a timeline (UTC) as it happens.
2. Stabilise first (roll back, switch a feature flag off, scale up), diagnose second.
3. Feature flags are the fastest lever: Feature flags in the console turn off voice calls, astrology and e-guides without a deploy.
4. Communicate: status message for members if sign-in, payments or messaging are affected.
5. After: written review within 5 working days, with actions and owners. No blame.

### Common situations

| Symptom | Likely cause | First move |
|---|---|---|
| Members say a payment went through but nothing happened | webhook not delivered or failing | Console: Payment webhooks (filter unprocessed) then Replay; or "Reconcile now". Processing is idempotent, so a replay cannot double-grant |
| Emails or OTPs not arriving | relay or provider down | check the mail/SMS provider; OTP and verification emails are sent inline, notifications by the worker (`sendDueDeliveries` retries with backoff) |
| Sign-in failing for everyone | Redis or database | rate limiters fall back to memory; check Mongo first |
| Introductions not appearing | worker down | the outbox keeps events; restart the worker and they flow |
| A staff member lost their phone | no authenticator | they use a recovery code; if none left, a super admin resets their sign-in (Team) and they enrol again |
| Suspected account takeover | credential stuffing | members: Settings, sign out everywhere; staff: revoke sessions in Team; check audit log |

## Data breach (DPDP)

Treat any suspected unauthorised access to personal data as a breach until shown otherwise.

1. Contain: revoke sessions (`revokeAllSessions`), rotate secrets, disable the affected feature, preserve logs and the audit trail (do not delete anything).
2. Assess: what data, whose, how many, what harm is possible. The audit log and access logs are the evidence.
3. Notify: the Data Protection Board and each affected member **without delay**, in the form and within the time set by the DPDP Act and Rules in force. **Confirm the exact obligations and deadlines with counsel; do not rely on this page for them.** Prepare the member message in plain language: what happened, what data, what we have done, what they should do, how to reach the grievance officer (see the Grievance Officer page).
4. Fix, then record the incident and the corrective actions.

## Backups and restore

- **Cloud backup:** Atlas continuous backup with point-in-time restore (set a 7 day window at least).
- **Second copy:** `scripts/backup.sh` nightly (logical dump, optionally encrypted with `age`, uploaded to a bucket in a different account and region; a lifecycle rule expires copies after 35 days).
- **Targets:** recovery point objective 24 hours from the nightly copy (minutes with point-in-time); recovery time objective 4 hours. Measure it in the drill below and update these numbers with the real result.
- **Drill:** at least quarterly, run `scripts/restore-drill.sh` into an empty scratch database and record the time and checks. A backup that has not been restored is not a backup.
- The private `age` key is held offline by two named people; losing both means the encrypted copies are unreadable.
- Object storage: enable versioning and a 30 day noncurrent-version retention on all three buckets.

## Restoring one member's data

Rare and sensitive. Restore into a scratch database, copy the specific documents with a reviewed script, and record who did it and why in the audit log. Never restore over live data to fix one account.

## Releases

1. CI green on the commit (lint, typecheck, tests, audit; the end-to-end suite on the release candidate).
2. Deploy to staging, run `load/smoke.js`, click through a sign-up and a purchase with the payment provider in test mode.
3. Production: deploy `api` and `worker` together (they share the outbox schema). Roll out one instance first and watch `readyz` and 5xx.
4. Rollback is a redeploy of the previous image; database changes are additive so the old code keeps working (indexes are built in the background).

## Routine duties

| When | What |
|---|---|
| Daily | glance at Insights backlogs (reviews, reports, tickets); dead-letter queue empty |
| Weekly | read the audit log for unusual staff activity; check payment reconciliation counts |
| Monthly | review feature flags and experiments; rotate nothing unless due; check dependency audit |
| Quarterly | restore drill; access review (who has which role); review this runbook |
| Annually | penetration test; review retention periods; review the ASVS table |
