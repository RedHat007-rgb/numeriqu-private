# API Contracts

## Contract principles

- Contract first
- Versioned endpoints
- Paginated list responses
- Permission-aware payloads
- Structured evidence
- No raw SQL in the client

## Common response envelope

```json
{
  "data": {},
  "meta": {
    "requestId": "uuid",
    "organizationId": "uuid",
    "nextCursor": null
  }
}
```

## API families

- [Signals API](./signals-api.md)
- [Investigations API](./investigations-api.md)
- [Catalog and watchlists API](./catalog-and-watchlists-api.md)

## Error contract

```json
{
  "error": {
    "code": "SIGNAL_NOT_FOUND",
    "message": "The signal could not be found.",
    "details": [],
    "requestId": "uuid"
  }
}
```

## Common error codes

- `SIGNAL_NOT_FOUND`
- `INTEGRATION_SCOPE_DENIED`
- `EVIDENCE_NOT_READY`
- `METRIC_UNAVAILABLE`
- `INVESTIGATION_LOCKED`
- `EXPORT_FAILED`
- `PERMISSION_DENIED`
