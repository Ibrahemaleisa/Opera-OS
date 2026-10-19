# syntax=docker/dockerfile:1.7
# Multi-stage build. Targets:
#   app    — Next.js standalone server (web + server actions + API routes)
#   tools  — full toolchain image for the background worker, migrations and seeding
ARG NODE_VERSION=22-bookworm-slim

FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# placeholder URLs: nothing connects to a database during the build
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build MIGRATION_DATABASE_URL=postgresql://build:build@localhost:5432/build
RUN pnpm prisma generate && pnpm build

FROM base AS tools
ENV NODE_ENV=production
COPY --from=build /app /app
CMD ["pnpm", "worker"]

FROM node:${NODE_VERSION} AS app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN groupadd --system --gid 1001 operra && useradd --system --uid 1001 --gid operra operra && mkdir -p /app/storage && chown operra:operra /app/storage
COPY --from=build --chown=operra:operra /app/.next/standalone ./
COPY --from=build --chown=operra:operra /app/.next/static ./.next/static
COPY --from=build --chown=operra:operra /app/public ./public
USER operra
EXPOSE 3000
CMD ["node", "server.js"]
