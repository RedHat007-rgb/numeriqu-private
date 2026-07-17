# Numeriqu

Numeriqu is an organization-first finance analytics and AI platform delivered as a `pnpm` + Turborepo monorepo. The system combines a Next.js product surface, a NestJS API, a Prisma-managed transactional store, and a ClickHouse + dbt analytics layer for dashboards and AI grounding.

## Repository at a glance

- `apps/web`: customer-facing frontend for auth, dashboards, messaging, team management, and AI workspaces
- `apps/api`: backend API for auth, organization context, integrations, analytics, dashboards, messaging, RAG, and agent orchestration
- `apps/docs`: documentation app shell; currently not the primary source of engineering documentation
- `packages/db`: Prisma schema, generated client, migrations, and seed/import utilities
- `packages/analytics`: dbt transformation layer for provider data modeled into shared finance marts
- `packages/ui`: shared UI primitives and marketing/product components
- `packages/eslint-config`, `packages/typescript-config`: workspace-wide engineering standards

## Start here

The engineering documentation lives in [docs/README.md](/Users/basanireddy/Desktop/test-1234/docs/README.md).

Recommended reading order for a new developer:

1. [docs/developer-onboarding.md](/Users/basanireddy/Desktop/test-1234/docs/developer-onboarding.md)
2. [docs/repository-structure.md](/Users/basanireddy/Desktop/test-1234/docs/repository-structure.md)
3. [docs/architecture.md](/Users/basanireddy/Desktop/test-1234/docs/architecture.md)
4. [docs/development-workflow.md](/Users/basanireddy/Desktop/test-1234/docs/development-workflow.md)
5. [docs/database-schema-numeriqu.md](/Users/basanireddy/Desktop/test-1234/docs/database-schema-numeriqu.md)
6. [docs/architecture-log.md](/Users/basanireddy/Desktop/test-1234/docs/architecture-log.md)
7. [docs/signal-platform/README.md](/Users/basanireddy/Desktop/test-1234/docs/signal-platform/README.md)

## Local development

1. Copy environment variables: `cp .env.example .env`
2. Install dependencies: `pnpm install`
3. Choose an LLM provider:
   - `ollama`: local runtime via `OLLAMA_URL` + `OLLAMA_MODEL`
   - `openai`: set `LLM_PROVIDER=openai` and provide `OPENAI_API_KEY`
   - `gemini`: set `LLM_PROVIDER=gemini` and provide `GEMINI_API_KEY`
4. Start the workspace: `pnpm dev`

## Common commands

- `pnpm dev`: run local development servers through Turborepo
- `pnpm build`: build all workspace packages/apps
- `pnpm lint`: run lint tasks across the monorepo
- `pnpm check-types`: run TypeScript validation across the monorepo

## Default local URLs

- Web: `http://localhost:3001`
- API: `http://localhost:3000`
