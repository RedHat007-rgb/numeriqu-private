# Investigations AP

## POST /api/v1/investigations

Create or reuse an investigation for a signal.

```json
{
  "signalId": "uuid"
}
```

## GET /api/v1/investigations/:investigationId

Returns:

- signal summary
- narrative
- evidence sections
- transaction samples
- driver breakdown
- action suggestions
- comments
- permissions

## POST /api/v1/investigations/:investigationId/comments

```json
{
  "content": "Margin drop appears concentrated in higher freight costs."
}
```

## POST /api/v1/investigations/:investigationId/recompute

Triggers evidence refresh.

## POST /api/v1/investigations/:investigationId/export-board-pack

```json
{
  "title": "Q3 Finance Risk Review",
  "audience": "board"
}
```

## Streaming and long jobs

- use SSE for progress when available
- fall back to polling
- return a job id for enrichment and export jobs

## Investigation permissions

- The user must be allowed to see the linked signal.
- Comment visibility must match investigation scope.
- Export requires explicit permission.
