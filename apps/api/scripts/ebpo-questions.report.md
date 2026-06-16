# EBPO 100-question test — 2026-06-16T08:02:21.631Z

Ran 100 questions (id 1–100) against EBPO org, production-like (no AGENT_SPEC_MODE).

## CREATE outcomes
```
{
  "OK": 98,
  "NO_DATA": 1,
  "SUSPECT_VALUE": 1
}
```
OK source split: `{"catalog":86,"llm":12}`

## FOLLOW-UP outcomes
```
{
  "OK": 97,
  "SKIPPED_NO_CREATE": 1,
  "REFUSED": 2
}
```
OK source split: `{"llm":38,"catalog":59}`

## Problems (4)

| # | reqType | CREATE | type/src | FU | note |
|---|---|---|---|---|---|
| 24 | box_plot | NO_DATA | -/- | SKIPPED_NO_CREATE | Sorry, a box plot of salary distribution by department is not available in this  |
| 27 | line | SUSPECT_VALUE | line/catalog | OK |  |
| 59 | heatmap | OK | heatmap/catalog | REFUSED | I can't compare against targets — there are no target or goal figures in this da |
| 79 | bar | OK | bar/catalog | REFUSED | I can’t determine a valid chart edit from the request "c". If you want a column  |
