# Data retention

Retention is enforced by scheduled jobs in `apps/worker`, not by policy text alone.

| Data | Kept for | Enforced by |
|---|---|---|
| Account, profile, preferences, assessments | While the account exists; erased 14 days after a deletion request | `purgeDueAccounts` (worker sweep, every 10 min) |
| Deletion grace period | 14 days; the member can restore by signing in | `account.scheduleDeletion` / `restoreAccount` |
| Data export files | 7 days, then expired link; file removed on purge | `buildExport`; `DataRequest.expiresAt` |
| Sessions | Until expiry (30 days members, 8 h staff) or revocation; TTL index removes expired rows | Mongo TTL on `sessions.expiresAt` |
| OTP codes and link tokens | 5 min / 24 h / 30 min; TTL index removes them | Mongo TTL on `expiresAt` |
| Consent history | Kept after deletion as pseudonymous evidence (userId only, no profile data) | Not purged |
| Audit logs | Kept; append-only. Review period to be set by counsel | Model-level write block |
| Identity document images | `EVIDENCE_RETENTION_DAYS` (default 30) after a verification decision; immediately on account erasure | `purgeExpiredEvidence` (worker sweep) and the account purge hook |
| Payment and invoice records | As required by tax law (Phase 10) | Not purged on account deletion |

Phases add their own `registerPurgeHook` / `registerExportCollector` so every new store is covered by deletion and export from day one.

## Added in Phase 14

| Data | Kept | Why |
|---|---|---|
| Analytics events (consent only) | 400 days, then deleted automatically | Year-on-year comparison without keeping browsing history for long |
| Active-day rows | 800 days, then deleted automatically | Retention cohorts |
| Introduction check-in feedback | While the account exists; erased with it | Improves introductions; never shown to the other member |
| Success stories | Until withdrawn | Public only with both people's consent |

