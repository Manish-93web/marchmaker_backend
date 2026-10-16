# Load testing

Scripts live in `load/` and use [k6](https://k6.io). **They were written in Phase 16 but have not been executed** (k6 is not installed on the development machine and there is no staging environment yet). Run them against staging before launch and record the numbers here.

## Never against production

Load tests create sessions and rate-limit buckets and send webhooks. Use a staging stack with the **mock/sandbox** providers: payment test mode, mock SMS and email.

## Scripts

| Script | What it does | Pass criteria |
|---|---|---|
| `load/smoke.js` | 5 users, 1 minute, public endpoints and health | error rate < 1%, p95 < 400 ms |
| `load/auth-and-browse.js` | ramps to 50 signed-in members reading dashboard data | login p95 < 1.2 s (argon2id is deliberately slow), `me` p95 < 300 ms, introductions p95 < 600 ms, errors < 2% |
| `load/webhook-burst.js` | 50 signed payment webhooks per second for a minute, one in five a repeat of an earlier id, plus bad signatures | all acknowledged, bad signatures refused, no duplicate payments |

## Preparing

1. Create load-test members (for example with the seed tooling or by registering through the API), put their credentials in `load/users.json` (copy `users.example.json`). Use enough users that one account is not hit by every virtual user: the per-email login limiter (10 attempts per 15 minutes) will, correctly, refuse a hammered account.
2. The global limiter is 300 requests per minute per IP. A load generator behind one IP will hit it, so either run the generator from several IPs, or raise `limit` on staging only. Do not lower the production limit to make a test pass.
3. Point `BASE_URL` at staging and run:

```bash
k6 run -e BASE_URL=https://staging.example.com load/smoke.js
k6 run -e BASE_URL=https://staging.example.com -e USERS_FILE=load/users.json load/auth-and-browse.js
k6 run -e BASE_URL=https://staging.example.com -e WEBHOOK_SECRET=... load/webhook-burst.js
```

## What to watch while it runs

- API CPU (argon2id sign-ins are CPU heavy: scale on CPU), memory, event-loop lag.
- MongoDB: opcounters, queued operations, slow queries (add an index if a query shows a collection scan).
- Redis latency; Mongo connection pool saturation.
- The worker: outbox pending age must stay under a minute.

## Results

Record date, commit, instance sizes and the k6 summary here after each run.

| Date | Commit | Script | Result |
|---|---|---|---|
| (not yet run) | | | |
