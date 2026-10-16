# Security review (OWASP ASVS 4.0.3, Level 2)

Self-assessment performed in Phase 16 against the code and tests in this repository. "Evidence" names the test or file that demonstrates the control. **This is not a penetration test.** An independent test is on the launch checklist and should be done before taking real members.

Status: **Met** (implemented and tested), **Partly** (implemented, with a stated gap), **Operational** (depends on how it is deployed), **Not applicable**.

## V2 Authentication

| ASVS | Control | Status | Evidence / note |
|---|---|---|---|
| 2.1.1, 2.1.7, 2.1.8 | 12+ character passwords, breached/weak refused, strength meter | Met | `passwordSchema`, `PasswordStrength`; auth tests |
| 2.1.9 | No composition rules that cap length | Met | max 128, no forced symbols |
| 2.2.1 | Anti-automation on login | Met | per-IP limiter, per-email attempt limiter (Redis-shared), progressive lockout; `hardening.test.ts` (shared limiter, fallback) |
| 2.2.3 | Notifies on security-relevant events | Partly | recovery-code use emails the staff member; password change emails; new-device alerts not built |
| 2.3 | Authenticator lifecycle | Met | recovery codes are 10, single use, keyed hashes, regenerated only with a fresh code |
| 2.5.1-2.5.4 | Recovery does not reveal accounts | Met | identical responses; `auth.test.ts` |
| 2.7 | Out-of-band (OTP) | Met | HMAC-hashed, 5 min, 5 tries, single use |
| 2.8 | Time-based OTP | Met | 30 s steps; **one-time use enforced** (`recentCodes`), tested with replay |
| 2.9 | Cryptographic verifiers | Met | argon2id; TOTP secrets encrypted at rest |
| 2.10 | Service credentials | Operational | all in environment/secret manager, never in code; production guard refuses development defaults |

## V3 Session management

| 3.2.1-3.2.4 | Session generation | Met | opaque 48-byte refresh token (SHA-256 at rest), 15 min JWT, rotation per use |
| 3.3 | Termination | Met | logout, logout-all, idle (staff 30 min) and absolute (staff 8 h) limits |
| 3.4 | Cookies | Met | httpOnly, Secure (enforced in production), SameSite=Lax; CSRF double-submit + Origin check |
| 3.5 | Token-based sessions | Met | reuse of a rotated refresh token revokes the family |
| 3.7 | Defences against session abuse | Met | re-authentication for sensitive staff actions via TOTP session |

## V4 Access control

| 4.1 | General | Met | permission checks server-side on every admin route; roles stored in DB; `super_admin` explicit |
| 4.1.3 | Least privilege | Met | per-permission routes, tested for 403 across roles in each phase |
| 4.2 | Operation-level (IDOR) | Met | every member route scopes by session user (introductions, tickets, invoices, notifications); tests assert a second member gets 404 |
| 4.3 | Admin interfaces | Met | TOTP-verified session required |

## V5 Validation, sanitisation

| 5.1 | Input validation | Met | Zod on every route body, query and params |
| 5.1.5 | Injection | Met | mongo-sanitize middleware, no string-built queries, regexes escaped; `hardening.test.ts` operator-injection test |
| 5.2 | Sanitisation / output | Met | React escapes; guides parsed to data (no raw HTML); email templates escape |
| 5.3 | Output encoding | Met | JSON only; CSP `default-src 'none'` on the API |
| 5.5 | Deserialisation | Met | JSON only; third-party responses validated (`chartSchema`, KYC, payments) |

## V6 Cryptography

| 6.1 | Data classification | Met | `docs/DATA_RETENTION.md` |
| 6.2 | Algorithms | Met | AES-256-GCM field encryption, HMAC-SHA256, argon2id; no custom crypto |
| 6.4 | Secret management | Partly | `FIELD_ENCRYPTION_KEY` and JWT secrets from environment; **move to a managed KMS and rotate** (launch checklist) |

## V7 Error handling and logging

| 7.1 | Log content | Met | pino redaction of credentials/PII; messages and numbers are never logged (voice, chat) |
| 7.2-7.3 | Log integrity | Partly | append-only audit log enforced in code; **add a database role without update/delete on `auditlogs`** at deployment |
| 7.4 | Error handling | Met | generic client errors, request id returned; no stack traces (`hardening.test.ts`) |

## V8 Data protection

| 8.1 | General | Met | PII minimisation, retention purge jobs, data export and erasure |
| 8.2 | Client-side | Met | no tokens in localStorage; cache-control `no-store` on private responses; service worker caches nothing but an offline page |
| 8.3 | Sensitive private data | Met | identity evidence in a separate bucket with separate credentials, signed 5-minute links, audited views; private photos blurred until unlock |

## V9 Communication

| 9.1 | TLS | Operational | terminate TLS at the edge; HSTS sent; `COOKIE_SECURE` and https origins enforced in production |
| 9.2 | Server communication | Met | provider calls over HTTPS with timeouts; webhooks verified by HMAC over raw bytes |

## V10 Malicious code / V11 Business logic

| 10.3 | Dependencies | Met | `pnpm audit --prod` clean at this phase; CI audits on every build; lockfile committed |
| 11.1 | Business logic limits | Met | idempotency keys, atomic state transitions, per-member caps (credits, calls/day, referrals), two-person rules (matching, appeals, escalations) |
| 11.1.4 | Anti-automation | Met | rate limits on registration, OTP, contact, appeals, analytics, search |

## V12 Files, V13 API, V14 Configuration

| 12.1-12.5 | File handling | Met | uploads by signed PUT with declared type and exact length; server re-checks size and type; images re-encoded (sharp) |
| 13.1-13.2 | API | Met | typed, versioned `/api/v1`, OpenAPI (non-prod), JSON content types |
| 13.2.3 | CSRF | Met | double-submit + Origin check; bearer clients exempt |
| 14.1 | Build | Met | CI: lint, typecheck, tests, audit; reproducible lockfile |
| 14.2 | Dependencies | Met | pinned major versions; audit gate |
| 14.4 | Headers | Met | helmet: CSP, HSTS, frame deny, no-referrer, nosniff, Permissions-Policy; `hardening.test.ts` |
| 14.5 | Request validation | Met | 100 KB body limit (413), JSON only |

## Production start-up guard

`loadEnv` refuses to start in production with: development JWT/encryption/webhook secrets, mock email/SMS/storage/KYC/payments/calls/astrology/WhatsApp/push providers, missing Redis, non-https URLs or origins, or insecure cookies (all tested in `hardening.test.ts`).

## Findings from this review (fixed in Phase 16)

1. **Authenticator codes could be replayed** within their validity window. Fixed: accepted codes are remembered and refused for 3 minutes; tested including the enrolment code.
2. **Rate limits were per process.** Fixed: Redis-backed login/OTP limiters and global limiter with a per-process fallback if Redis fails.
3. **No recovery path for lost authenticators** other than a super admin reset. Fixed: recovery codes.
4. **The API server's own entry point used in-memory mail and SMS adapters** regardless of configuration, so a real deployment would have sent nothing. Fixed: `createMailer` / `createSms` from the environment.
5. **Dev server rendered no emails** (the email package's JSX was compiled with the wrong runtime when run through `tsx`). Fixed in the API tsconfig; found by the browser end-to-end test.
6. **Registration without a mobile number failed silently in the browser** (found by the end-to-end test). Fixed with a regression test.
7. **Production could start on development defaults** for the encryption key and several secrets. Fixed by the start-up guard above.

## Dependency advisories accepted for now

| Advisory | Where | Why accepted, and the mitigation |
|---|---|---|
| React Router 6: open redirect via backslash in `<Link>` / `useNavigate` (GHSA-wrjc-x8rr-h8h6) and constructor injection in SSR hydration (moderate) | both frontends | Fixed only in v7. Navigation targets are in-app paths from our own code or our own API; `safeInternalPath` refuses anything that could be read as another site, with tests. The SSR advisory concerns data-router hydration, which we do not use (the pre-render is a custom string render of public pages). **Upgrade to React Router 7 after launch** and remove the helper's advisory note. `pnpm audit` is gated at high severity so these moderate items do not fail CI. |

## Open items before launch

- Independent penetration test, including the identity-evidence and payment flows.
- KMS-managed field-encryption key with a rotation procedure (the code already supports a single key; add key versioning before the first rotation).
- Database user without update/delete on `auditlogs`.
- Real SMS (DLT template approval), KYC vendor and astrology provider contracts; their webhooks verified against vendor sandboxes.
- WAF / DDoS protection at the edge and request-size limits at the proxy.
