# Marchmaker — backend

Express + MongoDB API, BullMQ worker and shared domain package. Frontend lives in `../marchmaker_frontend`.

## Run locally

```bash
corepack enable && corepack prepare pnpm@9.15.9 --activate
pnpm install
cp .env.example apps/api/.env && cp .env.example apps/worker/.env
docker compose up -d            # mongo (replica set), redis, minio, mailpit
pnpm --filter @marchmaker/shared build
pnpm --filter @marchmaker/api dev      # http://localhost:4000/healthz
pnpm --filter @marchmaker/worker dev   # in a second terminal
```

## Quality gates

```bash
pnpm lint && pnpm typecheck && pnpm test
```

Tests use `mongodb-memory-server`; no Docker needed for them.

## Before launch

`docs/LAUNCH_CHECKLIST.md` (what a person must confirm), `docs/RUNBOOK.md` (operations and incidents), `docs/SECURITY_REVIEW.md` (ASVS L2 self-assessment), `docs/LOAD_TESTING.md`, `docs/E2E.md`, `docs/ACCESSIBILITY.md`.

## Layout

- `apps/api` — REST API (`/api/v1`)
- `apps/worker` — outbox relay + BullMQ consumers
- `packages/shared` — Zod schemas, enums, RBAC, state machines, GST/money helpers
- `packages/email` — React Email templates
- `docs/` — ARCHITECTURE, DECISIONS (more arrive per phase)

`_legacy_prototype/` holds the earlier prototype and is git-ignored.
