# Numeriqu (monorepo)

Org-first finance analytics + AI workspace.

## What’s in this repo

- `apps/web`: Next.js UI (dashboards, agent, messaging, team/access)
- `apps/api`: NestJS API (auth, org context, integrations, analytics, RAG, agent)
- `packages/db`: Prisma schema + client for the transactional store (Postgres / Supabase Postgres)
- `packages/analytics`: dbt models for ClickHouse Medallion (Bronze/Silver/Gold)
- `packages/ui`: shared UI components

## Architecture

- Diagrams + key flows: `docs/architecture.md`
- Schema overview: `docs/database-schema-numeriqu.md`
- Decision log: `docs/architecture-log.md`
- Cost categorisation (Admin/Marketing/etc): `docs/cost-classification.md`

## Local dev

1. `cp .env.example .env` (fill required values)
2. `pnpm install`
3. Choose your LLM path:
   - Ollama: keep `LLM_PROVIDER=ollama`
   - OpenAI: set `LLM_PROVIDER=openai`, set `OPENAI_API_KEY`, and run the backend normally
4. `pnpm dev`

The app still speaks Ollama-shaped requests internally, but OpenAI mode is translated directly at the backend fetch boundary, so Ollama stays untouched.

## Local URLs

- Web: `http://localhost:3001`
- API: `http://localhost:3000`
