# Signal Intelligence Platform

This folder designs the full Numeriqu feature for finance signal detection, investigation, collaboration, and board-pack generation.

## Product goal

Help finance teams detect what changed, understand why, and turn it into action with evidence they can trust.

## Design principles

- No hardcoded company-specific logic
- No hardcoded metric names in UI behavior
- No one-off chart templates that only work for a single use case
- Everything is metadata-driven, permission-aware, and auditable
- Every signal must lead to an investigation or a dismissal with reason

## What is included

- [Product and UX design](./product-and-ux.md)
- [Backend and data architecture](./backend-and-data.md)
- [API contracts](./api-contracts.md)

## Existing system fit

This feature extends the current Numeriqu platform:

- `apps/api/src/metrics`
- `apps/api/src/agent`
- `apps/api/src/modules/dashboard`
- `apps/api/src/modules/audit`
- `apps/web/app/dashboard`
- `packages/db/prisma/schema.prisma`

The feature is designed to reuse the existing organization scoping, permissions, dashboards, audit trails, and ClickHouse gold-layer reads.
