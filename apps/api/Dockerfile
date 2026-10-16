# Build context is the repo root: docker build -f apps/api/Dockerfile .
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/config/package.json packages/config/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @marchmaker/api...

FROM deps AS build
COPY packages/shared packages/shared
COPY packages/config packages/config
COPY apps/api apps/api
RUN pnpm --filter @marchmaker/shared build && pnpm --filter @marchmaker/api build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/migrations ./migrations
COPY --from=build /repo/apps/api/migrate-mongo-config.cjs ./migrate-mongo-config.cjs
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/api/node_modules ./apps/api/node_modules
USER app
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:4000/healthz || exit 1
# Release step (before rolling out new containers):
#   node node_modules/migrate-mongo/bin/migrate-mongo.js up -f migrate-mongo-config.cjs && node dist/scripts/syncIndexes.js
CMD ["node", "dist/server.js"]
