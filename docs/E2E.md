# Browser end-to-end tests

Playwright specs live in the **frontend** repo (`apps/e2e`). They drive a real browser against real code.

## What starts

`pnpm --filter @marchmaker/e2e test` starts, via the Playwright config:

1. **A throwaway API** (`apps/api/src/scripts/e2eServer.ts` in this repo): an in-memory MongoDB replica set, seeded legal documents and plans, one super admin with two-factor on, the mock payment provider, and three test-only helpers under `/__e2e` (ready, the staff credentials and authenticator secret, and the last email sent to an address). A small in-process relay turns domain events into notifications because no worker runs. The server refuses to start with `NODE_ENV=production`.
2. The web dev server (port 5173) and the admin dev server (5174), both proxying `/api` to the throwaway API.

Nothing touches real data or real providers.

## Specs

| Spec | Covers |
|---|---|
| `public.spec.ts` | headline, cookie choice remembered, pricing with GST, skip link, kind 404 |
| `member.spec.ts` | register, confirm by the emailed link, sign in, buy an introduction (mock payment), credit and invoice appear, receipt notification, sign out ends the session; wrong password message |
| `staff.spec.ts` | staff sign-in with password plus a real authenticator code, then Insights and Payments |

## Running

```bash
cd ../marchmaker_frontend
pnpm install
pnpm --filter @marchmaker/e2e exec playwright install chromium   # once
pnpm --filter @marchmaker/e2e test
```

Reports and traces for failures are in `apps/e2e/playwright-report` and `test-results`.

## What it has already caught

- Registration without a mobile number threw after validation, so nothing was sent and nothing was shown.
- The API run through `tsx` (the dev server and this one) compiled the email templates with the wrong JSX runtime, so no email was ever rendered.
- The API's own entry point used in-memory mail and SMS regardless of configuration.

## Adding a journey

Prefer journeys that cross the browser, API, database and a background effect (email, notification, payment). Keep each spec independent: create its own member with a unique email.

## Not covered (manual or future)

Real payment provider checkout, real SMS/KYC vendors, push notifications, voice calls and mobile browsers. These need sandboxes or devices; they are on the launch checklist as manual steps.
