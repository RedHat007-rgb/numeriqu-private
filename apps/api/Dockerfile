# ── Stage 1: Builder ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy workspace manifests first (for layer caching)
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json ./
COPY packages/db/package.json ./packages/db/
COPY packages/db/prisma ./packages/db/prisma/
COPY packages/db/generated ./packages/db/generated/
COPY apps/api/package.json ./apps/api/

# Install ALL dependencies (including dev) for build
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/db ./packages/db/
COPY apps/api ./apps/api/

# Generate Prisma client & build NestJS
WORKDIR /app/apps/api
RUN pnpm run build

# ── Stage 2: Production runner ────────────────────────────────────────────────
FROM node:20-alpine AS runner

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy workspace manifests
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json ./
COPY packages/db/package.json ./packages/db/
COPY apps/api/package.json ./apps/api/

# Install PRODUCTION-only deps
RUN pnpm install --frozen-lockfile --prod

# Copy built output and generated Prisma client
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/packages/db/generated ./packages/db/generated
COPY --from=builder /app/packages/db/prisma ./packages/db/prisma

WORKDIR /app/apps/api

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "dist/main"]
