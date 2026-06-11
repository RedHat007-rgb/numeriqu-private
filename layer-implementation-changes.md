# Layer Implementation Changes

Date: 2026-06-11

## Summary

Implemented the remaining dashboard and renderer layers for the old/sample accounting dataset, with emphasis on CFO/executive dashboard composition, matrix enhancement edits, old-dataset routing, and visual rendering correctness.

## Backend Changes

### CFO / Executive Dashboard Composition

- Added deterministic multi-widget CFO dashboard routing for prompts asking for executive summaries, CFO dashboards, financial position, operating performance, profitability, liquidity, balance sheet, P&L, and net income.
- Prevented broad executive prompts from collapsing into a single balance-sheet or P&L widget.
- CFO dashboard now includes:
  - Executive KPI cards
  - Balance sheet position
  - P&L waterfall
  - Net income trend
  - Top expense accounts
  - Revenue by account

Files changed:

- `apps/api/src/modules/agent/agent.service.ts`

### Widget Vocabulary Fixes

- Registered missing supported widget types:
  - `kpi/summary/overview`
  - `gauge/financial_health/summary`
- Added vendor transaction count widgets:
  - `vendor_count/vendor`
  - `vendor_count/month_vendor`

Files changed:

- `apps/api/src/modules/agent/agent.service.ts`

### Old Dataset Routing Fixes

- Routed vendor transaction-count prompts to count-based widgets instead of spend widgets.
- Added `vendor_count/month_vendor` handling for monthly vendor activity.
- Updated vendor transaction handlers to prefer `sample_gl_dump.vendor_customer` and fall back safely.
- Updated expense pivot handlers to read old/sample GL fields correctly:
  - Department × vendor
  - Month × vendor
  - Month × class
  - Department × class

Files changed:

- `apps/api/src/modules/agent/agent.service.ts`

### Unsupported Feature Handling

- Added clear refusal/clarification for unsupported chart or interactive asks instead of silently generating wrong/no-op charts.
- Unsupported examples now handled:
  - Box/violin charts
  - Decomposition tree
  - Sunburst/tree-ring
  - Sparklines
  - Animation/play axis
  - Dropdown filters, slicers, drilldown, click-to-filter

Files changed:

- `apps/api/src/modules/agent/agent.service.ts`

### Matrix Edit Enhancements

- Added deterministic edit handling for matrix/heatmap follow-ups such as:
  - “Add row totals”
  - “Add column totals”
  - “Highlight cells above $10k in green”
- Persists display hints into `queryConfig.display`:
  - `showTotals`
  - `conditionalThreshold`
  - `conditionalColor`

Files changed:

- `apps/api/src/modules/agent/agent.service.ts`

## Frontend Changes

### Chart Formatting

- Improved percentage/currency inference.
- Normalized charts now show percent axes/tooltips instead of currency.
- Pie and donut labels now render percentage values more cleanly.
- Donut tooltip now includes total context.
- Matrix and heatmap values now use metric-aware formatting.

Files changed:

- `apps/web/app/dashboard/_components/DashboardPreview.tsx`
- `apps/web/app/dashboard/_pages/DashboardsPage.tsx`

### Multi-Series Readability

- Added labels for compact multi-series line/area charts.
- Added labels for compact non-stacked multi-series bar charts.
- Increased visible series cap for expanded line charts.
- Improved treemap readability with lower label thresholds and hover titles.

Files changed:

- `apps/web/app/dashboard/_components/DashboardPreview.tsx`
- `apps/web/app/dashboard/_pages/DashboardsPage.tsx`

### Matrix Conditional Formatting

- Matrix/heatmap renderers now honor persisted conditional display hints.
- Cells at or above the configured threshold can render green.
- Implemented in both:
  - Live dashboard preview
  - Saved dashboard page / zoom renderer

Files changed:

- `apps/web/app/dashboard/_components/DashboardPreview.tsx`
- `apps/web/app/dashboard/_pages/DashboardsPage.tsx`

## Tests Added

- Added regression test for unsupported feature gates.
- Added regression test for unsupported edit refusal.
- Added regression test for full CFO dashboard composition.
- Added regression test for matrix totals + threshold highlighting edit hints.

Files changed:

- `apps/api/src/modules/agent/explicit-charts.spec.ts`

## Validation Run

The following commands passed:

```bash
pnpm --dir apps/api test -- explicit-charts.spec.ts chart-prompt-suite.spec.ts --runInBand
pnpm --dir apps/web check-types
pnpm --dir apps/api build
```

Validation results:

- API targeted tests: 108 passed
- Web typecheck: passed
- API build: passed

## Notes

- Existing unrelated/uncommitted workspace changes remain in the repo, including files under `packages/db`, `apps/api/scripts`, and prompt audit artifacts.
- No git commit or branch was created.
