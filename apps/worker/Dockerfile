# Build context is the repo root: docker build -f apps/worker/Dockerfile .
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/config/package.json packages/config/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --filter @marchmaker/worker...

FROM deps AS build
COPY packages/shared packages/shared
COPY packages/config packages/config
COPY apps/api apps/api
COPY apps/worker apps/worker
RUN pnpm --filter @marchmaker/shared build && pnpm --filter @marchmaker/worker build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=build /repo/apps/worker/dist ./dist
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/worker/node_modules ./apps/worker/node_modules
USER app
CMD ["node", "dist/index.js"]
