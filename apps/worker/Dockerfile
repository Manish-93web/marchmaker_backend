# Build context is the repo root: docker build -f apps/worker/Dockerfile .
FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /repo

FROM base AS build
ENV MONGOMS_DISABLE_POSTINSTALL=1
COPY .npmrc pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/config/package.json packages/config/
COPY packages/shared/package.json packages/shared/
COPY packages/email/package.json packages/email/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps/api apps/api
COPY apps/worker apps/worker
# The worker runs the API's job code, so it uses the API's production packages. Its own build bundles only the
# workspace packages (the API source, shared, email) and leaves every third-party package to node_modules.
RUN pnpm --filter @marchmaker/shared build \
 && pnpm --filter @marchmaker/worker build \
 && pnpm --filter @marchmaker/api --prod deploy /deploy

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=build /deploy/node_modules ./node_modules
COPY --from=build /repo/apps/worker/dist ./dist
# Invoice PDFs are drawn by the worker and embed these fonts.
COPY --from=build /repo/apps/api/assets ./assets
USER app
CMD ["node", "dist/index.js"]
