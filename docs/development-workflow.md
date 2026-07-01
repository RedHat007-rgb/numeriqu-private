# Development Workflow

This document defines the expected way to run, validate, and evolve the Numeriqu codebase.

## 1. Local environment

The workspace depends on several external systems. Review `.env.example` before running the stack.

Core dependencies:

- Supabase Auth
- Postgres connection strings for Prisma
- Redis
- ClickHouse
- Resend
- one LLM provider: Ollama, OpenAI, or Gemini
- provider credentials for QuickBooks and Xero when integration work is being tested

## 2. Standard commands

From the repository root:

- `pnpm install`: install workspace dependencies
- `pnpm dev`: run development tasks via Turborepo
- `pnpm build`: build the workspace
- `pnpm lint`: run lint checks
- `pnpm check-types`: run TypeScript checks

Useful scoped commands:

- `pnpm --filter web dev`
- `pnpm --filter api dev`
- `pnpm --filter @repo/db db:generate`
- `pnpm --filter @repo/db db:migrate`

API-specific validation:

- `pnpm --filter api test`
- `pnpm --filter api test:e2e`
- `pnpm --filter api qa`
- `pnpm --filter api qa:browser`

## 3. Working model

When making changes, keep these design rules in mind:

- preserve organization isolation in every backend read/write path
- keep transactional state in Postgres and analytical facts in ClickHouse
- treat auth as backend-owned even though Supabase provides identity primitives
- prefer extending existing modules over creating parallel architectural paths
- update documentation when the architecture or developer workflow changes

## 4. Change areas and expected caution

### High-risk areas

- organization context resolution
- auth/session issuance
- integration sync orchestration
- agent and RAG data grounding
- schema and migration changes

### Medium-risk areas

- dashboard metadata flows
- sharing and permissions
- messaging persistence and edit history
- frontend API transport and auth state management

### Lower-risk areas

- isolated presentational UI work
- documentation updates
- non-runtime analysis artifacts

## 5. Suggested delivery checklist

Before merging a meaningful change:

1. confirm the target module and data boundary are correct
2. validate tenant and permission implications
3. run the narrowest relevant checks first
4. run broader workspace validation when the change crosses app/package boundaries
5. update architecture or onboarding docs if the change affects how developers understand the system

## 6. Testing expectations

There is no single test command that proves the whole system. Use the validation strategy that matches the change:

- frontend rendering/state change: web typecheck, lint, and targeted manual verification
- backend contract change: API tests plus route-level verification
- agent change: grounding/parity/browser validation where relevant
- schema or data flow change: Prisma/dbt validation plus representative query checks

For the agent subsystem specifically, the repo already includes targeted QA utilities and architecture notes. Use them instead of relying only on superficial smoke testing.

## 7. Documentation maintenance

The repository previously contained several starter-template README files. The expectation going forward should be:

- root `README.md` explains the product and points to the right docs
- app/package READMEs explain real responsibilities and local commands
- `docs/` contains cross-cutting engineering documentation
- architecture changes are logged in `docs/architecture-log.md`

## 8. New developer expectations

A new engineer should be able to answer these questions within their first hour:

- what each app/package is responsible for
- where auth, analytics, and AI boundaries live
- how to boot the repo locally
- how organization scoping works
- which commands to run before shipping a change

If the documentation no longer supports that outcome, it should be treated as stale and updated as part of normal engineering work.
