# EBPO Verification Blindspot

## What Was Going Wrong

For the EBPO Data-2 chart work, we repeatedly marked fixes as "done" after:

- catalog/spec compilation succeeded
- SQL returned rows
- chart type looked plausible in logs

That was not enough.

The testing team validates the rendered chart, labels, units, series retention, and whether the outcome matches the Power BI intent. Our prior loop mostly validated the data layer, not the final browser truth.

## The Blindspot

The old validation path could miss all of these:

- a requested second metric replacing the first chart instead of being added
- a `line` or `bar` request drifting into `combo`
- `%` measures rendering as `$`
- data-label follow-ups becoming silent no-ops
- bubble size being ignored even though `z` data existed
- heatmap follow-ups saying "highlight highest/lowest" but rendering no visible emphasis
- waterfall subtotals rendering as ordinary deltas

In other words: `rows > 0` is necessary, but not sufficient.

## New Rule

Nothing should be called fixed for EBPO unless it passes all applicable layers:

1. Compiler correctness
2. SQL/data verification
3. Edit-plan verification
4. Render-intent verification
5. Browser truth check for flagged charts

## Evidence Required Per Fix

- Unit/spec regression for the exact failure family
- Harness result showing the create/follow-up path stayed correct
- Browser confirmation for renderer-sensitive issues

## Reference Questions

- `Questions Testing (6).xlsx` is currently a zero-byte file and cannot be used.
- The executable reference set is `apps/api/scripts/ebpo-data2-questions.json`.
- These questions are reference examples, not phrases to hard-code. Fixes must handle
  the underlying intent family: requested measures, dimensions, chart type, units,
  labels, follow-up preservation, and render semantics.

## Architecture Checked

The current path was checked across:

1. Natural-language measure and dimension detection
2. EBPO semantic catalog and deterministic spec-to-SQL compiler
3. Multi-measure view selection and derived-ratio handling
4. Follow-up edit planning and original-series preservation
5. SQL execution against the live EBPO ClickHouse scope
6. Frontend rendering for bars, combos, waterfall, scatter/bubble, heatmap/matrix,
   labels, reference lines, percentages, and totals
7. Harness verdict logic for type mismatch, suspicious values, missing dimensions,
   replaced series, dropped series, and incomplete dashboard edits

The main architectural weakness was not only the LLM. Several deterministic paths
were too broad or too narrow, and the renderer ignored some valid display metadata.
The fixes therefore span the planner, catalog/spec edits, SQL construction, tests,
and frontend renderer.

## Fixes Implemented

### Chart Intent and Series Preservation

- Opening and closing balance by account over time preserves the requested
  `line`, `bar`, or `area` family instead of becoming a generic combo.
- Comparison follow-ups extend the existing chart instead of replacing its original
  measures.
- Payroll by country can add average monthly salary without deleting payroll.
- Operations scatter charts use delivery-center grain instead of an accidental
  client grain.
- Average handling time versus CSAT and utilization versus SLA now create valid
  scatter charts and can become bubbles when a size measure is requested.
- Utilization versus employee count can now add payroll cost as bubble size through
  a verified cross-view allocation by country and employee share.

### Financial Measure Semantics

- Gross margin percentage no longer silently adds gross-margin dollars.
- Precomputed/derived ratios no longer pull raw numerator and denominator measures
  into the visible chart.
- Fixed ratio families include payroll-to-revenue, cost-to-income, FCF margin,
  operating-cash-flow-to-revenue, AR/AP ratios, payment rate, cost per employee,
  depreciation percentage, and net-book-value percentage.
- Overall/average reference-line requests target the current measure rather than
  becoming an unrelated comparison series.

### Labels and Rendering

- Pure data-label follow-ups are recognized as display edits.
- Single-series bars can show a separate requested label series.
- Waterfalls preserve the bridge and can show gross-margin percentage labels.
- Waterfall totals/subtotals render as totals rather than ordinary deltas.
- Bubble charts use real x/y labels and normalize `z` over its own range so bubble
  sizes visibly differ.
- Heatmap percentage summaries use averages, not sums.
- Missing heatmap cells render blank instead of misleading `0.0%`.
- Highest/lowest heatmap or matrix cells receive visible extreme highlighting.
- Forced labels work on longer bar, line, area, and combo charts.
- A frontend `box_plot` renderer was added with whiskers, quartile boxes, median
  markers, and currency labels.

## Regression Tests

The focused suite now covers:

- data-label toggles
- matrix highest/lowest highlighting
- opening/closing balance chart-family preservation
- waterfall percentage labels
- gross-margin dollar/percentage disambiguation
- single-series label overlays
- average/reference lines
- payroll plus average salary
- operations scatter grain and measure selection
- derived-ratio series suppression
- EBPO salary quartile box-plot planning
- payroll-sized utilization/employee-count bubbles

Latest focused result:

```text
explicit-charts.spec.ts: 35 passed, 0 failed
chart-spec-ebpo.spec.ts + explicit-charts.spec.ts: 72 passed, 0 failed
```

Source type-checks also pass with `apps/api/tsconfig.build.json` and the web
application TypeScript configuration. The broader API `tsconfig.json` still reports
pre-existing import/type errors in standalone scripts, so it is not used as evidence
that the application source failed.

## Live Verification Results

A complete live run was executed over all 100 Data-2 reference questions and their
follow-ups using the real agent methods and live ClickHouse SQL.

Before the latest Q24/Q96 edits:

```text
CREATE: 99 OK, 1 NO_DATA
FOLLOW-UP: 95 OK, 4 REFUSED, 1 SKIPPED_NO_CREATE
```

Confirmed live fixes include:

- Q1 opening/closing balance chart preservation
- Q18 payroll plus average monthly salary
- Q29 revenue plus gross margin without unwanted percentage leakage
- Q31/Q83/Q87/Q90/Q93 gross-margin percentage series correctness
- Q35 waterfall gross-margin percentage labels
- Q41 single-series revenue labels
- Q45 overall gross-margin-percentage reference line
- Q56-Q65 operations create/follow-up paths, except Q59's missing target
- Q85 and Q97 derived-ratio follow-ups without raw component leakage
- Q96 payroll-sized utilization versus employee-count bubble

Targeted Q96 live rerun:

```text
CREATE=OK/catalog/scatter
FOLLOW-UP=OK/catalog/bubble
```

Targeted Q24 live rerun after fixing both routing and follow-up preservation:

```text
CREATE=OK/catalog/box_plot (10 department rows)
FOLLOW-UP=OK/catalog/box_plot (10 department rows)
create/follow-up columns=min,q1,median,q3,max,value,employee_count
showDataLabels=false -> true
```

Single-measure waterfalls are also now accepted by the semantic spec compiler.
Targeted live runs confirmed operating-cash-flow movement and net movement by
account create as `catalog/waterfall` rather than falling to free LLM SQL.

## Remaining Honest Gaps

### Q59 SLA Target Highlight

The heatmap creates correctly. The follow-up asks for months below the target SLA,
but no target/goal SLA field exists in the EBPO dataset. The refusal is currently
honest. A business-approved target field or explicit threshold is required.

### Q79 Invalid Follow-Up

The reference follow-up is only `"c"`. The agent correctly refuses because there is
no actionable chart edit. This is a malformed reference row, not a chart failure.

### Q99 Current Ratio KPI - Live Verified

Current ratio still cannot be calculated because current-liability data is
unavailable. The edit no longer refuses the whole request: it preserves the six
existing scorecard measures, adds Gross Margin %, Cost per Employee, Revenue per
Employee, and Free Cash Flow Margin, and reports that only Current Ratio was
skipped. KPI compilation now supports independently verified provider views and
emits `label`, `value`, and per-row `format` fields for correct mixed-unit rendering.

The deterministic regression and live harness both pass. The create returns six
cards and the follow-up returns ten cards: the original six plus Gross Margin %,
Cost per Employee, Revenue per Employee, and Free Cash Flow Margin. Current Ratio
is omitted and explicitly disclosed as unavailable.

### Q100 Dashboard Completeness - Live Verified

The EBPO semantic extension now creates exactly four monthly catalog-backed widgets:
Liquidity, Profitability, Employee Efficiency, and Cash Conversion. Creation is
atomic: if any requested section cannot be verified, the planner returns no-data
instead of a partial dashboard. The follow-up adds per-series monthly-average
indicators to all four widgets atomically.

## Verification Still Required

- Perform browser screenshots for renderer-sensitive charts.
- Compare chart values, labels, axes, series roles, and visual intent directly with
  the supplied Power BI report.

The Power BI visual match is **not yet fully verified**, so the overall EBPO task
must not be described as completely fixed.

## Continuation Log - 2026-06-22

### Root Causes Fixed

- The generic unsupported-feature gate now permits salary-distribution box plots
  only when the organization has the rich EBPO employee dataset. Other datasets
  still receive an honest unsupported response.
- The valid `buildEbpoSemanticPlan()` quartile implementation was dead code: no
  production planner called it. EBPO box-plot intents now route through this
  semantic extension before the free-SQL planner.
- The median-marker follow-up was misclassified as a request for a second metric,
  replacing the quartile SQL with `value/median_value`. It is now a display-only
  edit that preserves the original SQL, spec, type, and all quartile fields.
- The frontend now hides numeric median labels initially and reveals them when the
  follow-up sets `showDataLabels=true`; the median line remains part of the box plot.
- Bar-chart label overlays no longer participate in y-axis domain calculation. This
  fixes the browser issue where adding average-salary labels to an employee-count
  chart crushed the actual bars to the baseline.
- Sparse breakdown bar charts, such as Country x Delivery Center, render as stacked
  breakdown columns so the visible bars keep usable width instead of becoming
  grouped 1-2px slivers.
- The spec compiler now supports single-measure waterfall charts over a dimension,
  while multi-measure financial bridges remain on their subtotal-aware path.

### Where To Continue

1. Run browser visual checks for Q24, Q35, Q75, Q99, and Q100.
2. Compare values, units, labels, axes, and series roles directly with Power BI.

### Continuation Log - 2026-06-22 09:14 IST

#### Overtime / Payroll Ratio Fix

- Root cause: the overtime follow-up was being routed through the generic combo-measure path, which treated "as a percentage of total payroll" like a raw comparison series and substituted `Total Payroll` instead of creating a derived percentage.
- Fix: added a derived EBPO measure for `overtime_to_payroll_pct`, exposed it in the payroll catalog, and taught both the spec-combo planner and the legacy edit planner to prefer `Overtime / Payroll %` over raw payroll when the follow-up asks for a percentage.
- Verification:
  - Focused regression tests now cover the new ratio measure and the follow-up selection.
  - Live targeted harness for EBPO question `id=53` (`Create a column chart showing overtime cost by department.` / `In the same chart, add overtime as a percentage of total payroll.`) returned `CREATE=OK/catalog/bar/10r` and `FU=OK/catalog/10r`.
- Remaining work: Power BI visual parity still needs browser-by-browser confirmation for the flagged charts, but this specific overtime follow-up is now routing to the correct ratio instead of payroll.

## Full Regression - 2026-06-22

The complete 100-question reference suite was rerun after the root fixes:

```text
CREATE: 100 OK
FOLLOW-UP: 96 OK, 1 SERIES_DROPPED, 3 REFUSED
```

The one dropped-series result was Q35 and one refusal was Q75. Both were then fixed
and rerun live:

```text
Q35 CREATE=OK/catalog/waterfall, FOLLOW-UP=OK/catalog/waterfall
Q75 CREATE=OK/catalog/bar, FOLLOW-UP=OK/catalog/combo
```

Therefore the effective post-fix outcome is:

```text
CREATE: 100/100 valid
FOLLOW-UP: 98/100 valid
EXPECTED REFUSALS: Q59 (no target SLA field), Q79 (follow-up is only "c")
```

Additional live proof:

- Q35 retains `value` and `is_total`, and adds `Gross Margin % Label` without
  replacing the financial bridge.
- Q75 calculates asset intensity as net book value divided by calls handled after
  independently aggregating and joining both datasets by delivery center. Its
  follow-up preserves asset intensity and adds CSAT on a percent axis.
- Q99 returns 6 cards on create and 10 cards after the partial-fulfillment edit.
- Q100 creates 4 widgets and its follow-up modifies all 4 widgets; the first chart
  preserves all four liquidity series and adds four monthly-average series.

## Continuation Log - 2026-06-22 10:24 IST

### Asset Share and Treemap Color Root Fixes

- Checked the screenshots for `Asset Cost Share by Asset Type` and confirmed the
  follow-up `add net book value share by asset type` was wrong: it rendered raw
  currency bars (`$339.3K`, `$243.4K`, etc.) instead of comparing share
  percentages. The deterministic edit path now computes each measure as its own
  percentage of total using `sum(...) OVER ()`, labels the y-axis `% share`, and
  formats both `Asset Cost` and `Net Book Value` as percent series.
- Fixed the compiler break at `agent.service.ts:17251`. Root cause was a stale
  half-removed legacy asset branch that opened an `if` block and never closed it
  after the new normalized-share branch was moved earlier in the method.
- Checked the screenshots for `Net Book Value by Delivery Center and Asset Type`
  with follow-up `color the treemap by depreciation percentage`. The planner text
  claimed the color metric was added, but the frontend treemap had no color-metric
  contract and still used rotating category colors. The edit path now emits
  `value = net_book_value` for rectangle size and `depreciation_pct` for color;
  the renderer now uses `display.colorMetric` with a low-to-high legend and
  percent tooltip values.
- Added regression coverage for both exact failure families in
  `explicit-charts.spec.ts`: asset share follow-ups must be percent-normalized,
  and fixed-asset treemap color follow-ups must preserve net-book-value sizing
  while adding `depreciation_pct` only as the color channel.
- Verification run:
  - `pnpm --dir apps/api test -- chart-spec-ebpo.spec.ts explicit-charts.spec.ts --runInBand` -> 77/77 passing.
  - API source-only TypeScript diagnostics -> 0.
  - `pnpm --dir apps/web exec tsc --noEmit` -> passed.

Remaining caveat: these two root fixes are regression-verified in code, but the
final Power BI pixel/value parity still needs browser comparison against the
published Power BI report before the whole EBPO suite can be called fully closed.

## Continuation Log - 2026-06-22 10:35 IST

### Depreciation Bar Label Overlay Fix

- Checked the screenshot for `Delivery Centers by Depreciation %` with follow-up
  `add net book value labels`. The V2 card claimed labels were added, but the
  rendered bar chart still showed only depreciation-percent bars and no visible
  net-book-value labels.
- Root cause: the edit planner did create a label-only SQL column, but the simple
  bar-label display contract did not persist the label unit, and the frontend
  custom `LabelList` renderer assumed Recharts would always pass `payload`.
  In this chart path, that assumption can produce a silent no-label render even
  though the backend says the edit succeeded.
- Fix: simple EBPO bar label overlays now persist `labelFormat` from the requested
  metric, so `Net Book Value Label` renders as currency while the main
  depreciation bars remain percent values. The frontend label renderer now falls
  back to the row index when `payload` is missing and positions labels from the
  actual bar geometry for both vertical and horizontal bars.
- Regression coverage added for the exact family:
  `Delivery Centers by Depreciation %` + `add net book value labels` must keep
  chart type `bar`, keep `valueFormat: percent`, add
  `labelSeries: Net Book Value Label`, and set `labelFormat: currency`.
- Verification run:
  - `pnpm --dir apps/api test -- explicit-charts.spec.ts --runInBand` -> 39/39 passing.
  - `pnpm --dir apps/api test -- chart-spec-ebpo.spec.ts explicit-charts.spec.ts --runInBand` -> 78/78 passing.
  - API source-only TypeScript diagnostics -> 0.
  - `pnpm --dir apps/web exec tsc --noEmit` -> passed.
