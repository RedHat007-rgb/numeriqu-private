# Repository Structure

This document explains how the monorepo is organized and what each major directory is responsible for.

## Top-level layout

```text
apps/
packages/
docs/
scripts/
exports/
transformations/
```

The monorepo is managed with `pnpm` workspaces and Turborepo. Workspace membership is declared in `pnpm-workspace.yaml`, and task orchestration is defined in `turbo.json`.

## `apps/`

### `apps/web`

The main customer-facing application built with Next.js App Router.

Primary responsibilities:

- authentication entry points
- dashboard experience
- integrations management
- team and messaging surfaces
- RAG and agent workspaces
- product landing experience

Notable areas:

- `app/`: route tree and page composition
- `app/dashboard/`: authenticated product workspace
- `components/`: shared product/marketing components
- `lib/api/`: typed frontend API client wrappers

### `apps/api`

The main backend service built with NestJS.

Primary responsibilities:

- authentication and session orchestration
- organization context resolution
- permission enforcement
- integration orchestration
- analytics and dashboard APIs
- messaging APIs
- RAG and agent runtime endpoints
- audit and health endpoints

Notable areas:

- `src/app.module.ts`: application composition root
- `src/modules/`: modern domain modules
- `src/integrations/`: provider and sync orchestration concerns
- `src/common/`: shared guards, filters, decorators, and infrastructure helpers
- `scripts/`: validation, repro, audit, and QA utilities

### `apps/docs`

A documentation app shell that still resembles a starter project. It should not be treated as the canonical engineering documentation source unless it is intentionally brought up to date.

## `packages/`

### `packages/db`

Transactional data package.

Responsibilities:

- Prisma schema and migrations
- generated client
- seed/import/cleanup scripts
- database-centric utilities shared by apps

Key paths:

- `prisma/schema.prisma`
- `prisma/migrations/`
- `scripts/`
- `src/client.ts`

### `packages/analytics`

Analytics transformation package built with dbt.

Responsibilities:

- provider-specific staging models
- normalized Gold-layer marts
- finance-ready views for dashboards and AI grounding

Key paths:

- `models/staging/`
- `models/marts/`
- `dbt_project.yml`
- `profiles.yml`

### `packages/ui`

Shared UI component package used across product and marketing surfaces.

### `packages/eslint-config` and `packages/typescript-config`

Workspace-level standards packages that keep linting and compiler behavior consistent across apps.

## `docs/`

The authoritative engineering documentation directory.

Use this folder for:

- onboarding guides
- architecture docs
- repository maps
- workflow/runbook documentation
- decision and change logs

Avoid storing long-lived engineering knowledge only in ad hoc notes outside this directory.

## `scripts/`

Workspace-level scripts that do not belong to a single app/package. At present this is lightweight compared with the richer script inventory under `apps/api/scripts` and `packages/db/scripts`.

## `exports/` and `transformations/`

Reference and data-oriented assets used for demos, transformations, and validation work. These are useful for testing and analysis, but they are not the primary application runtime code.
