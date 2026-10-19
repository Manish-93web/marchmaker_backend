# Build context is the repo root: docker build -f apps/api/Dockerfile .
FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /repo

FROM base AS build
# The test database downloader is a dev tool; there is no reason to fetch it while building an image.
ENV MONGOMS_DISABLE_POSTINSTALL=1
# Dependencies first, from the lockfile, so this layer is reused until a package.json changes.
COPY .npmrc pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/config/package.json packages/config/
COPY packages/shared/package.json packages/shared/
COPY packages/email/package.json packages/email/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps/api apps/api
# The shared and email packages are bundled into the build. `deploy` then writes the production node_modules.
RUN pnpm --filter @marchmaker/shared build \
 && pnpm --filter @marchmaker/api build \
 && pnpm --filter @marchmaker/api --prod deploy /deploy

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=build /deploy/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/migrations ./migrations
COPY --from=build /repo/apps/api/migrate-mongo-config.cjs ./migrate-mongo-config.cjs
# Invoice PDFs embed these fonts (the rupee sign is not in the built-in PDF fonts).
COPY --from=build /repo/apps/api/assets ./assets
USER app
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT:-4000}/healthz || exit 1
# Release step (before rolling out new containers):
#   node node_modules/migrate-mongo/bin/migrate-mongo.js up -f migrate-mongo-config.cjs && node dist/scripts/syncIndexes.js
CMD ["node", "dist/server.js"]
