# Identity verification, KYC and liveness

## Flows

**Manual (always available)**

1. Member uploads ID front, ID back and a selfie directly to the private `identity` bucket (pre-signed PUT; declared type and exact size are signed in).
2. `POST /verification/submit` checks each object exists with the declared size, records document type and the last four characters only, and moves the journey to `verification_pending`.
3. A verifier opens the case (every evidence link issued is audited with the exact items shown), completes the checklist and approves, rejects with a reason, or asks for specific items again.
4. Approval moves the member to `verified` and then `matching_active`. Raw images are deleted `EVIDENCE_RETENTION_DAYS` (default 30) after the decision.

**Automated (feature flag `kyc_automated` + a configured provider)**

1. `POST /verification/kyc/session` creates a provider session and returns the hosted URL.
2. The provider calls `POST /api/v1/webhooks/kyc`. The raw body is checked against `X-KYC-Signature` (HMAC-SHA256 with `KYC_WEBHOOK_SECRET`), stored once (unique `provider + eventId`), then processed by the worker.
3. The worker **re-fetches the result from the provider**; the callback body is never trusted.
4. `evaluateKycResult` (in `@marchmaker/shared`) decides:
   - approve: status completed, liveness passed, name, date of birth and face match, confidence at or above 0.90;
   - wait: provider still pending;
   - manual review: anything else, with a reason. **Automation never rejects.**
5. A poller re-checks sessions whose callback is late. After six failed provider calls the case goes to manual review with reason `provider_error`, so a vendor outage cannot leave a member stuck. A circuit breaker avoids hammering a failing provider.

The member always sees an honest "pending" or "a person is reviewing" state, and can switch to manual upload at any time.

## Provider adapter contract

`KycProvider` (`apps/api/src/lib/kyc.ts`): `createSession`, `getResult`, `verifyWebhook`.

- `mock`: in-memory, for development and tests.
- `rest`: a generic HTTPS adapter for a vendor or an in-house gateway:
  - `POST {KYC_BASE_URL}/sessions` with `{ referenceId, firstName, callbackUrl }` returns `{ sessionId, redirectUrl }`
  - `GET {KYC_BASE_URL}/sessions/{id}` returns `KycResult`: `{ status, confidence, nameMatch, dobMatch, faceMatch, livenessPassed, docType?, docLast4? }`
  - Webhook body `{ eventId, sessionId }`, header `X-KYC-Signature: hex(HMAC_SHA256(secret, rawBody))`

**Not done:** mapping to a specific vendor (HyperVerge, IDfy, Digio). Each has its own API and webhook format, and needs the vendor's sandbox credentials. Add a `KycProvider` subclass that translates to the contract above.

## Data kept

| Item | Stored | Retention |
|---|---|---|
| ID and selfie images | `identity` bucket, separate credentials, server-side encryption | Deleted `EVIDENCE_RETENTION_DAYS` after a decision; deleted immediately on account erasure |
| Document type and last four characters | Verification record | With the record |
| Decision, reviewer id, checklist | Verification record + audit log | Audit log is append-only |
| Full document number | Never collected | n/a |

Aadhaar must be uploaded masked; the unmasked type is not accepted.
