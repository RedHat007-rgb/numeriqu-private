# Data Model

## Core tables

- `signal_metrics`
- `signal_dimensions`
- `signal_rules`
- `signals`
- `signal_observations`
- `signal_evidence`
- `investigations`
- `investigation_comments`
- `investigation_assignments`
- `watchlists`
- `watchlist_items`
- `alerts`
- `alert_deliveries`
- `board_packs`
- `board_pack_versions`
- `board_pack_sections`

## Key design rule

Store metadata references, not free-text labels, as the canonical source of truth.

That keeps the system:

- provider independent
- UI reusable
- audit friendly
- localization ready

## Signal shape

Suggested fields:

- `id`
- `organizationId`
- `tenantId`
- `metricId`
- `signalType`
- `severity`
- `impactAmount`
- `confidenceScore`
- `status`
- `entityScope`
- `timeWindow`
- `comparisonWindow`
- `createdAt`
- `updatedAt`

## Evidence shape

Suggested fields:

- `id`
- `signalId`
- `evidenceType`
- `sourceTable`
- `queryDefinition`
- `payload`
- `sortOrder`
- `createdAt`

## Investigation shape

Suggested fields:

- `id`
- `signalId`
- `status`
- `ownerId`
- `resolutionNote`
- `lastEnrichedAt`
- `boardPackId`
- `createdAt`
- `updatedAt`

## Board pack shape

Suggested fields:

- `id`
- `organizationId`
- `title`
- `audience`
- `version`
- `sourceInvestigationId`
- `exportFormat`
- `createdAt`

## Query strategy

- Use ClickHouse for signal computation and evidence reads
- Support paging for evidence rows
- Support metric and entity scoping
- Support current vs prior period comparisons

## Schema rules

- Every row should be organization scoped
- Every entity-sensitive row should include scope metadata
- Every export should reference the source investigation or signal
- Every state change should be auditable
