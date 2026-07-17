# Catalog and Watchlists API

## Metric APIs

### GET /api/v1/metrics

Returns all supported metrics for the current organization and data profile.

### GET /api/v1/metrics/:metricId

Returns:

- metric key
- display name
- unit
- provider mappings
- supported dimensions
- default thresholds
- default comparisons

## Rule APIs

### GET /api/v1/signal-rules

### POST /api/v1/signal-rules

### PATCH /api/v1/signal-rules/:ruleId

Rules should be editable so finance ops can tune noise over time.

## Watchlist APIs

### GET /api/v1/watchlists

### POST /api/v1/watchlists

### PATCH /api/v1/watchlists/:watchlistId

### DELETE /api/v1/watchlists/:watchlistId

Watchlist item examples:

- metric threshold
- entity threshold
- variance threshold
- vendor or customer threshold

## Board pack APIs

### GET /api/v1/board-packs

### GET /api/v1/board-packs/:boardPackId

### POST /api/v1/board-packs

### POST /api/v1/board-packs/:boardPackId/versions

### GET /api/v1/board-packs/:boardPackId/export

## Shared contract rules

- all payloads are organization scoped
- all entity-sensitive payloads must include scope metadata
- exports must reference the source investigation or signal
- list endpoints must be cursor paginated
