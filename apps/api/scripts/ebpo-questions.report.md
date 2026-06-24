# EBPO 100-question test — 2026-06-22T10:32:35.648Z

Ran 20 questions (id 1–20) against EBPO org. AGENT_SPEC_MODE=1 (resolved from env at runtime — NOTE: .env sets this, so the spec-first planner is active unless you explicitly unset it).

## CREATE outcomes
```
{
  "OK": 19,
  "NO_DATA": 1
}
```
OK source split: `{"catalog":19}`

## FOLLOW-UP outcomes
```
{
  "OK": 19,
  "SKIPPED_NO_CREATE": 1
}
```
OK source split: `{"catalog":17,"llm":2}`

## Problems (1)

| # | reqType | CREATE | type/src | FU | note |
|---|---|---|---|---|---|
| 17 | stacked_bar | NO_DATA | -/- | SKIPPED_NO_CREATE | I can't break "Revenue (allocated)" down by month and business_unit — no EBPO vi |
