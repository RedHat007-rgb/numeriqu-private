# Signals API

## GET /api/v1/signals

Query parameters:

- `status`
- `severity`
- `metricId`
- `entityId`
- `from`
- `to`
- `cursor`
- `limit`

Response item:

```json
{
  "id": "uuid",
  "title": "Margin dropped in Acme UK",
  "signalType": "MARGIN_VARIANCE",
  "severity": "high",
  "impactAmount": 128430,
  "confidenceScore": 0.91,
  "status": "new",
  "metric": {
    "id": "uuid",
    "key": "gross_margin"
  },
  "entityScope": [
    {
      "entityId": "uuid",
      "entityName": "Acme UK"
    }
  ],
  "timeWindow": {
    "start": "2026-06-01",
    "end": "2026-06-30"
  },
  "comparisonWindow": {
    "start": "2026-05-01",
    "end": "2026-05-31"
  },
  "updatedAt": "2026-07-09T10:00:00Z"
}
```

## GET /api/v1/signals/:signalId

Returns:

- signal metadata
- evidence summary
- investigation status
- next actions
- comments
- audit references

## POST /api/v1/signals/:signalId/acknowledge

```json
{
  "note": "Investigating with finance ops"
}
```

## POST /api/v1/signals/:signalId/dismiss

```json
{
  "reason": "Expected seasonal drop"
}
```

## POST /api/v1/signals/:signalId/assign

```json
{
  "assignedToUserId": "uuid"
}
```

## Signal permissions

- Admins can see all organization-scoped signals.
- Members can only see entity-scoped signals they are allowed to access.
- Assignment and dismissal should be audit logged.
