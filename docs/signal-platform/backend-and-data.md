# Backend and Data Architecture

## Architecture goal

Build a scalable, metadata-driven finance intelligence system that detects signals, enriches them with evidence, and exposes them through permissioned APIs without hardcoded logic in the UI.

## Design principles

- Organization scoped
- Entity scoped
- Auditable
- Async for heavy work
- Gold-layer reads only
- Reusable across metrics and providers

## Service boundaries

- Signal Catalog Service
- Signal Detection Service
- Investigation Service
- Narrative Service
- Board Pack Service
- Notification Service
- Permissions Service

## Processing model

1. Gold-layer facts update.
2. Detection job scans supported metrics.
3. Signal record is created.
4. Investigation enrichment computes evidence.
5. Narrative is generated.
6. Frontend consumes structured payloads.

## Data model families

- metrics and dimensions
- signal rules and signals
- evidence and investigations
- comments and assignments
- watchlists and alerts
- board packs and versions

## Query strategy

- Use ClickHouse for analytic reads
- Query by metric, time window, entity scope, and comparison window
- Keep raw SQL out of controllers
- Keep response payloads normalized for the frontend

## Reliability and observability

- idempotent jobs
- retries with backoff
- dead-letter handling
- audit trail for every state change
- latency and false-positive metrics

## Related detail docs

- [Runtime and operations](./runtime-and-ops.md)
- [Data model](./data-model.md)
