# Chart Testing Fixes — Status & Review (2026-06-11)

Source of truth for failures: `Questions for Testing.xlsx` (Aakash + Velan, 100 Qs).
Dataset: old `sample_gl_2024` (ClickHouse `analytics.sample_gl_dump` + `sample_trial_balance`).
LLM: OpenAI `gpt-5.4-mini` via in-process fetch interceptor.

## What is DONE (all 7 layers implemented + validated)

| Layer | Scope | Who | Status |
|-------|-------|-----|--------|
| **D** | Follow-up "same output" | me | ✅ done + proven |
| **B** | Data correctness | me | ✅ done + proven |
| **A** | Render polish | Codex | ✅ done |
| **C** | Chart-type routing | Codex | ✅ done + verified e2e |
| **E** | Refuse impossible/unsupported | Codex | ✅ done + verified e2e |
| **F** | Matrix totals/conditional fmt | Codex | ✅ done |
| **G** | Multi-widget dashboards | Codex | ✅ done + verified e2e |

### Layer D — follow-up edits (mine)
- Deterministic transforms wrap the chart's existing SQL (no LLM hallucination): normalize-to-100%, company/reference average line, N-month moving average, second-axis combo (spend/count/avg-txn/credits).
- Refuses clearly when data can't satisfy: YoY / prior-year (single year only), invoices (no invoice data).
- Frontend honors render hints: % axis, flat `ReferenceLine`, dashed paired MA lines, adaptive combo secondary axis.
- Proof: `apps/api/scripts/layerD-edit-repro.ts` — 3 transforms apply, 3 impossible asks refuse.

### Layer B — data correctness (mine)
- **B2 vendor cap:** raised `LIMIT 8→40` (matrix/treemap/heatmap), `8→15` (line), `buildExpensePivot maxColumns 8→40`. Now shows all 24 vendors (verified).
- **B3 count vs amount:** "transaction count/volume" now emits a `countIf()` pivot, not `sum(spend)`.
- **B1 (3-month):** not reproducible on current code/data — `parseTimeRange` returns null → all 12 months. Was stale feedback.
- **B4 (0.00 balances):** already correct — uses `sample_trial_balance` with non-zero `net_balance`.

### Layer A — render polish (Codex)
- Data labels on compact single + multi-series bar/line/area.
- Per-category bar colors for categorical bars (guarded by `barLooksTimeSeries` so monthly bars stay uniform).
- Treemap labels: lower threshold + hover titles for readability.
- Normalized charts: % axis/tooltips; cleaner pie/donut % labels.

### Layer C — chart-type routing (Codex)
- Explicit chart types preserved (heatmap, matrix, treemap, pareto, waterfall, scatter, donut, ranked/clustered/stacked bar).
- Verified e2e: Aakash Q13/Q34 → `heatmap`; Velan Q8 / Aakash Q49 → `matrix` (matrix↔heatmap confusion fixed).

### Layer E — refuse impossible/unsupported (Codex + mine)
- Gated with clear message: sunburst/tree-ring, sparklines, decomposition tree, box/violin, dropdown/slicer/drilldown, animation/play-axis, budget variance (no budget data).
- Verified e2e: budget → `BUDGET_DATA_REQUIRED`; sunburst → `CHART_TYPE_UNSUPPORTED`.

### Layer F — matrix features (Codex)
- Edit hints persisted: `showTotals`, `conditionalThreshold`, `conditionalColor`.
- Renderer (preview + saved page) draws row/col totals and green cells ≥ threshold.

### Layer G — dashboards (Codex)
- Deterministic multi-widget CFO/executive composition (no longer collapses to a single chart).
- Verified e2e: CFO prompt → 6 widgets (KPI, balance sheet, P&L waterfall, net income, expense, revenue).

## Validation (re-run by me, all PASS)
- `pnpm --dir apps/web check-types` → pass
- `pnpm --dir apps/api build` → pass
- `pnpm --dir apps/api test -- explicit-charts.spec.ts chart-prompt-suite.spec.ts` → **108 passed**

## Follow-ups — ALL DONE (2026-06-11)
1. **Budget gate phrasing** ✅ — reworded to a clear refusal: "This dataset has no budget or plan data, so I can't compute budget variance — only actuals are available." (still offers actuals-only / wait-for-upload options).
2. **Matrix "variance column"** (Velan Q21-f / Q48-f) ✅ — added a `variance` follow-up transform: time-ordered charts get a period-over-period `$ change` column (frame-based prev-row diff); single-period snapshots (trial-balance matrices) **refuse clearly** ("no previous period to compare"). Verified both paths in layerD-edit-repro.ts.
3. **Power BI parity — company-average** ✅ — found + fixed a real bug: the "company-wide average" line averaged only the FIRST series (e.g. Admin = 31,215) instead of the company total. Now averages each row's total across all series = **108,937** (avg of monthly totals), matching Power BI's "average of monthly spend". Vendor spend (=SUM debit / "Total Debits"), transaction count (B3), and balances (trial_balance net_balance) already match the .pbix field definitions. Exact DAX for margin % measures isn't extractable (DataModel is compressed) — reconstructed from data.

Re-validated after these: 108 tests pass, API build pass, typecheck clean.

## Generalization test (fresh prompts NOT in the test set) — `scripts/fresh-e2e-repro.ts`
Ran 8 brand-new questions, each with a follow-up, through the real create→follow-up flow. Found + fixed two gaps:
- **Vocab-widget follow-ups silently no-op'd** — charts persisted as metric/grouping (no SQL) couldn't be transformed. Fixes: (1) month×department charts now created SQL-backed (wide pivot) so they're editable; (2) `backfillVocabSql` synthesizes + shape-verifies SQL for remaining vocab widgets at edit time so both the deterministic transforms and the SQL editor can rewrite them; (3) broadened the normalize regex ("percentage of **the** total", "as a % of").
- **"3D / rotating" charts not gated** — added to the unsupported gate (now refuses, like sunburst/animate).

Result: 7/8 fresh cases correct (normalize, reference line, moving avg, second-axis, pie→values, YoY refusal, 3D refusal). Remaining: per-department month-over-month **variance on a heatmap** (multi-series) safely no-ops instead of breaking — documented edge limitation (single-series variance only).

## Files changed (uncommitted)
- `apps/api/src/modules/agent/agent.service.ts` (D, B, C, E, F, G backend)
- `apps/web/app/dashboard/_components/DashboardPreview.tsx` (A, D, F render)
- `apps/web/app/dashboard/_pages/DashboardsPage.tsx` (A, F saved-page render)
- `apps/api/src/modules/agent/explicit-charts.spec.ts` (regression tests, 108 pass)
- Repro harnesses: `apps/api/scripts/{layerD-edit-repro,layerB-create-repro,layerCEG-repro}.ts`
- Nothing committed; no branch created.
