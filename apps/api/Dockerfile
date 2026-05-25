# ── Stage 1: Builder ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy workspace manifests (for layer caching)
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json ./
COPY packages/db/package.json ./packages/db/
COPY packages/db/prisma ./packages/db/prisma/
COPY apps/api/package.json ./apps/api/

# Install all dependencies
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/db ./packages/db/
COPY apps/api ./apps/api/

# 1. Generate Prisma client
RUN cd /app/packages/db && DIRECT_URL=postgresql://dummy:dummy@localhost:5432/dummy npx prisma generate --schema=prisma/schema.prisma

# 2. Build @repo/db (compiles src/index.ts → dist/index.js so API can import it)
RUN cd /app/packages/db && npx tsc -b

# 3. Build NestJS API
WORKDIR /app/apps/api
RUN pnpm run build

# ── Stage 2: Production runner ────────────────────────────────────────────────
FROM node:20-alpine AS runner

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json ./
COPY packages/db/package.json ./packages/db/
COPY packages/db/prisma ./packages/db/prisma/
COPY apps/api/package.json ./apps/api/

# Install production deps only
RUN pnpm install --frozen-lockfile --prod

# Generate Prisma client in runner image
RUN cd /app/packages/db && DIRECT_URL=postgresql://dummy:dummy@localhost:5432/dummy npx prisma generate --schema=prisma/schema.prisma

# Copy built outputs from builder
COPY --from=builder /app/packages/db/dist ./packages/db/dist
COPY --from=builder /app/apps/api/dist ./apps/api/dist

WORKDIR /app/apps/api

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "dist/main"]
