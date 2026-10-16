# Security

Working checklist against OWASP ASVS Level 2. Status is updated each phase; the full audit is Phase 16.

## Implemented (through Phase 2)

| Area | Control |
|---|---|
| Passwords | argon2id (19 MiB, t=2, p=1); dummy-hash verification for unknown emails to flatten timing |
| Sessions | httpOnly + Secure + SameSite=Lax cookies; access JWT 15 min; opaque refresh token stored as SHA-256; rotation on every use; reuse of a rotated token revokes the whole family; atomic claim prevents concurrent double-rotation |
| CSRF | Double-submit token for cookie-authenticated writes; Origin allow-list check; bearer clients exempt |
| Brute force | Per-IP limiter, per-email attempt limiter, progressive account lockout (5 failures, doubling up to 60 min) |
| Enumeration | Register, forgot-password, resend and OTP request return identical responses whether or not the account exists |
| OTP | HMAC-hashed, 5 min expiry, 5 attempts, 60 s resend cooldown, single use |
| Tokens | Email verify 24 h, password reset 30 min; both single use and stored hashed |
| Staff | TOTP mandatory; sessions 8 h absolute and 30 min idle; staff cannot use phone-code login; permission checks require an MFA session |
| Data at rest | AES-256-GCM field encryption for phone and date of birth, blind index for phone lookup |
| Logging | pino with redaction of credentials and PII keys; request IDs on every response |
| Transport headers | CSP (nonce), HSTS, frame deny, no-referrer, Permissions-Policy, hpp, mongo-sanitize, body size limits |
| Audit | Append-only audit log (model-level update/delete blocked) |
| Age and consent | 18+/21+ gate, granular consents with document version, forced re-acceptance on material legal changes |

## Identity evidence (Phase 6)

| Control | Detail |
|---|---|
| Separation | Identity images live in their own bucket with separate credentials, never mixed with profile photos |
| Upload | Pre-signed PUT with the declared content type and exact length signed; object existence and size re-checked server-side |
| Access | Only `verification.view_evidence` holders with a TOTP-verified session; links expire in 5 minutes |
| Audit | Every evidence view and every decision is written to the append-only audit log with actor and items |
| Minimisation | Last four characters only; unmasked Aadhaar not accepted; images deleted after the retention window |
| Webhooks | HMAC over the raw body, constant-time compare, stored once by event id, result re-fetched from the provider |
| Concurrency | Decisions use a status-filtered atomic update so two verifiers cannot both decide |

## Added in Phase 16

| Area | Control |
|---|---|
| Staff 2FA | Ten single-use recovery codes (keyed hashes, shown once, regenerated only with a fresh authenticator code); authenticator codes are single-use (replay refused for 3 minutes); super-admin reset that ends sessions and emails the person |
| Rate limits | Login, OTP and global limits are shared across instances through Redis, with a per-process fallback if Redis fails |
| Start-up guard | Production refuses development secrets, mock providers, in-memory storage, missing Redis, non-https URLs and insecure cookies |
| Review | Full ASVS L2 self-assessment with evidence and findings: `SECURITY_REVIEW.md` |

## Known gaps (tracked, owners in LAUNCH_CHECKLIST.md)

- Independent penetration test not yet done.
- `FIELD_ENCRYPTION_KEY` comes from the environment; move to a managed KMS with key versioning before the first rotation.
- Audit log immutability is enforced in code; add a database user without update/delete on `auditlogs` at deployment.
- New-device sign-in alerts for members are not built.
- Vendor-specific KYC, SMS template, telephony and astrology integrations are verified only against mocks.
