# Runtime and Operations

## Recommended deployment shape

Use a modular monolith first, not many microservices.

Reason:

- the domain is tightly related
- the repository already has a modular NestJS structure
- shared org scope and dashboards already exist
- early service splitting would add avoidable operational overhead

## Suggested modules

- `apps/api/src/signal-intelligence`
- `apps/api/src/signal-intelligence/catalog`
- `apps/api/src/signal-intelligence/detection`
- `apps/api/src/signal-intelligence/investigations`
- `apps/api/src/signal-intelligence/narrative`
- `apps/api/src/signal-intelligence/board-packs`

## Background jobs

Use async workers for:

- detection
- enrichment
- narrative generation
- digest generation
- board pack assembly

All workers must be idempotent.

## Resilience requirements

- Retry transient warehouse failures with backoff
- Use dead-letter queues for failed signal jobs
- Allow partial degradation if narrative generation fails
- Return “evidence available, narrative pending” instead of a hard failure

## Audit requirements

Log:

- signal creation
- dismissal
- assignment
- comment creation
- board pack export
- watchlist changes

Every audit event should include actor, organization, entity scope, action, and correlation id.

## Observability requirements

Track:

- detection job duration
- signal volume by type
- false positive rate
- investigation completion time
- narrative generation latency
- export generation latency
- alert delivery success rate

## Caching strategy

- short-lived inbox summary cache
- per-signal evidence cache
- per-metric detection cache
- export cache

Invalidate on sync completion, metric recomputation, and rule changes.
