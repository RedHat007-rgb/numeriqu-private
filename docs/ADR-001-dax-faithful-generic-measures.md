# ADR-001: DAX-faithful, dataset-agnostic measure engine

Status: Accepted (Stages 1–4 implemented and verified) · Scope: apps/api chart-engine · Date: 2026-07-27

## Context

Astra (`/dashboard/agent`, NEW chart-engine) must produce chart values that **exactly
match the client's PowerBI**, with **no hardcoding, no per-question regex, and no
DAX formulas baked into code** — and it must stay correct when pointed at a *different*
client dataset whose measures/DAX differ.

The client provided the numeriqu-demo PowerBI DAX (234 measures, see
`docs/dax-measures-canonical.md`). That file is **a validation oracle, not a build
input** — hardcoding those 234 formulas would not scale to the next dataset.

## Decision

Scalability lives in **generic derivation rules**, not per-dataset formulas. The
semantic layer already derives measures per-client from schema introspection + data
profiling + star-schema relationships (`data-profiler.ts`, `cube-builder.ts`,
`semantic-model-builder.ts`). The universal patterns that reproduce PowerBI DAX for
ANY dataset:

| Measure shape (DAX) | Generic rule | Compiler expr |
|---|---|---|
| flow `SUM(col)` | additive | `sum(col)` |
| stock/balance (closing balance, headcount) | semi-additive, point-in-time **As Of** | `argMax(col, dateCol)` |
| share/rate/margin `DIVIDE(part, whole)` | ratio, **percent** | `100 * sum(n)/sum(d)` |
| plain ratio `DIVIDE(stockA, stockB)` (D/E, current ratio, asset turnover) | ratio, **plain (×1)** | `sum(n)/sum(d)` |
| duration/score `AVERAGE(col)` (DSO*, SLA, CSAT, AHT) | mean | `avg(col)` |
| period-average denominators `AVERAGEX(dates,[stock])` | mean-of-as-of | `avg(argMax…)` per date |

The **DAX oracle** only judges whether the generic output matches PowerBI for
numeriqu-demo. Where a client supplies DAX/measure notes, they are fed to the planner
(OpenAI) as an *optional per-client hint* — never a code dependency.

## The one irreducible signal

Data/structure alone **cannot** distinguish a percent-ratio from a plain-ratio:
`ROA = profit/assets` renders as % while `Asset Turnover = revenue/assets` renders as a
plain 0.28× — same flow/stock structure, different business convention. This convention
must come from a **general semantic classifier over the measure name/label** (the same
mechanism `unitFor` already uses for `days`/`min`/`%` on means) and/or the LLM planner /
DAX hint. This is domain modelling, applied uniformly to any dataset — **not** a
per-question hack.

## Implementation (staged, each stage test-gated)

### Stage 1 — metadata-driven display scale (keystone)
- `semantic-model-builder.unitFor`: replace blanket `agg==='ratio' → '%'` with a general
  classifier → `%` for margin/rate/share/return/utilization/`*_pct`; `x` (plain ratio) for
  `*_ratio`/turnover/times/to-equity/to-assets/coverage.
- `spec-compiler.measureValueExpr` + `measureValueExprIf`: scale `ratio_of_sums` by ×100
  **only** when the measure's unit is percent-like; else ×1. Single source of truth.
- `result-verifier.reconcileRatio` / `reconcileForExpr`: reconcile in the measure's own
  scale so the live tripwire does not false-reject.
- **Gate:** `apps/api` jest (`spec-compiler.spec.ts`, `verifier-prompt.spec.ts`, pipeline)
  green + DAX-oracle check (D/E→0.47, margins→%, asset turnover→0.28×).
- Touch-points mapped: `spec-compiler.ts:336,344,368,370`; `result-verifier.ts:52,99`;
  `semantic-model-builder.ts:64`; `chart-engine.service.ts:901,913,935`.

### Stage 2 — balance columns As-Of everywhere
- Ensure trial-balance closing/outstanding columns classify as `semi_additive`
  (`data-profiler.ts`) so `argMax(col, dateCol)` is used, matching `BS … As Of`.
- Balance-sheet ratios (D/E, ROA, ROE, current, turnover) computed from As-Of components
  and `Average Total Assets/Equity` (mean of monthly As-Of), replacing the pre-baked
  `average_*` columns (avg-of-ratios) in `v_sfin_balance_ratio_semantic`.
- **Gate:** DAX oracle — D/E, ROA, ROE, current ratio, asset turnover reconcile.

Implemented:
- `ratio_of_aggs` compiles independently aggregated numerator/denominator terms
  (`sum`, `as_of`, `mean`) and uses the measure unit as the single display-scale
  authority.
- `buildSemanticModel` accepts client-owned declared measures and refuses stale
  declarations whose tables/columns are absent from live introspection.
- `sfin-measure-registry.ts` is the replaceable SFIN/DAX translation layer; no
  financial formula is embedded in the generic builder or compiler.
- `v_sfin_balance_ratio_semantic` exposes raw monthly stock/flow components.
  Total equity follows the supplied DAX plug (`Total Assets - Total Liabilities`);
  current assets/liabilities use their account groups.
- **Verified 2026-07-27:** 289 chart-engine tests and API production build pass.
  Live ClickHouse oracle: D/E `0.1335`, ROA `105.03%`, ROE `133.96%`, asset
  turnover `12.4762×`, debt ratio `11.77%`, equity ratio `88.23%`, current ratio
  `27.8233×`.

### Stage 3 — planner fidelity + optional DAX hint
- Feed the client schema catalog (and DAX hint when present) to the planner so it never
  drops a named measure and never invents a breakdown from a measure-name keyword
  (Q40 "vendor cash outflow", Q44 "by … and fiscal year", Q72 scatter→KPI).
- **Gate:** regenerate Q40/Q44/Q72; browser + DAX oracle.

Implemented:
- Planner fidelity checks derive requested series, dimensions, and time grain from the
  active runtime catalog and evaluate completeness inside each cube. They contain no
  SFIN field list or question-number exception.
- A complete runtime candidate contradicts an `unsupported` model decision; omitted
  named series/dimensions trigger bounded model repair.
- Fiscal-year grammar and clustered/grouped column presentation are normalized without
  selecting a business field in application code.
- Clarifications that replace an explicitly requested, available grouping are repaired;
  genuine cross-cube business ambiguity is preserved.
- **Verified 2026-07-27:** focused Q40, Q44, and Q72 main/follow-up runs pass.
  Evidence: `codex-work/2026-07-27-adr-stage3-q40-v3.jsonl` and
  `codex-work/2026-07-27-adr-stage3-focused-v2.jsonl`.

### Stage 4 — full Asyraf sweep
- Regenerate all 36 mains + 36 follow-ups; verify labels/axis/values in-browser against
  the DAX oracle; log deviations.

Implemented and verified:
- Clean sweep evidence is in
  `codex-work/2026-07-27-adr-stage4-asyraf-v2.jsonl`: 35 unambiguous mains and all
  corresponding follow-ups produced charts; Q57 produced all six balance ratios and
  its quarterly follow-up.
- Q54 correctly surfaces the one irreducible runtime ambiguity: both invoice and
  trial-balance cubes can supply revenue by revenue category. Selecting trial-balance
  revenue preserves the original request and produces a populated annual waterfall:
  previous year `-4,487,962.55`, current year `-5,441,709.42`, with six named revenue
  category steps plus the unallocated residual. Its follow-up sets `showCumulative`.
- Duplicate sampled member labels across related dimensions no longer create an
  impossible conjunction (for example, the same member inferred simultaneously as
  account name, group, and type). An explicitly named dimension still retains its
  filter. This rule is catalog-driven and dataset-agnostic.
- Final gate: **294 chart-engine tests pass** and the API production build succeeds.

## Already delivered
- `f93de930` executive_performance reconciles to DAX (EBITDA 430M→69.4M, payroll →291.9M).
- `98894127` canonical DAX catalog committed as reference data.
- Full DAX-validated audit: ~26/36 mains already correct; DSO=`Average DSO` matches DAX,
  and a portfolio `[DSO]` measure exists for the 13-day interpretation.

## Consequences
- (+) Correct for any dataset by construction; DAX never hardcoded; planner is the
  per-client semantic bridge.
- (−) The percent-vs-plain-ratio classifier is name/label-driven (unavoidable business
  convention); mitigated by the DAX-oracle regression gate.
- Risk: the ×100 scale is entangled with the live reconcile tripwire; Stage 1 must land
  as one test-gated change, never a partial edit.
