# EBPO Chart Prompt Audit Feedback

## Executive Result

- Reference dashboard checked: `file:///Users/basanireddy/Downloads/new%20dataset%20dashboard.html`
- Full live prompt audit checked all 100 supplied prompts against the EBPO ClickHouse-backed planner.
- Latest full audit result before final patch: 98 pass, 1 expected gap, 1 fail.
- Only failing prompt rerun after fix: `rev-10` passed with 144 waterfall rows.
- Effective final result: 99 pass, 1 expected unsupported chart gap, 0 unresolved failed prompts.
- No hardcoded backend numbers were added. Fixes use tenant/org-scoped semantic SQL over live `v_ebpo_*` views.

## Screenshot Evidence

- Executive Summary: `/private/tmp/chart-audit-screenshots/p1-executive-summary.png`
- Revenue & P&L: `/private/tmp/chart-audit-screenshots/p2-revenue-p-l.png`
- Cash Flow & Liquidity: `/private/tmp/chart-audit-screenshots/p3-cash-flow-liquidity.png`
- AR/AP & Working Capital: `/private/tmp/chart-audit-screenshots/p5-ar-ap-working-capital.png`
- Payroll & Headcount: `/private/tmp/chart-audit-screenshots/p6-payroll-headcount.png`
- Render audit JSON: `/private/tmp/chart-audit-screenshots/audit-summary.json`

Render summary: the reference dashboard loaded with 0 console errors. Screenshots were regenerated from the actual local HTML using Chromium against the `file://` URL.

## Prompt Coverage

| Area | Prompt Count | Result |
| --- | ---: | --- |
| Revenue / P&L | 20 | 20 passed |
| Cash / GL movement | 10 | 10 passed |
| Receivables | 5 | 5 passed |
| Payables | 5 | 5 passed |
| Payroll / Headcount | 15 | 14 passed, 1 expected gap |
| Operations | 10 | 10 passed |
| Fixed Assets | 10 | 10 passed |
| CFO / Cross-domain | 25 | 25 passed |

Expected gap: `pay-09` asks for a box plot. The current chart vocabulary/frontend does not support a true `box_plot`, so the correct behavior is no-data/unsupported rather than faking a bar chart.

## Final Failed Prompt Rerun

| ID | Prompt | Previous Issue | Fix | Rerun Result |
| --- | --- | --- | --- | --- |
| `rev-10` | Create a waterfall chart showing revenue, cost, and gross margin by month. | LLM SQL casted formatted month labels back to dates and self-repair returned no data. | Added deterministic EBPO semantic SQL over `v_ebpo_revenue_monthly` producing ordered `name,value` waterfall rows. | Passed: `waterfall`, 144 rows, type/data verified. |

Evidence file after targeted rerun: `/Users/basanireddy/Desktop/test-1234/prompt-audit-results/ebpo-prompt-audit.json`

## Root Causes Fixed

- Explicit chart parsing now preserves user-requested chart types including `combo`, `donut`, `heat map`, `pareto`, `ranked bar`, `clustered bar`, `stacked column`, and plain `column chart`.
- EBPO SQL-backed waterfall and margin charts no longer get replaced by legacy sample-GL/P&L fallback widgets.
- Semantic EBPO views now expose missing monthly/business-unit/client/contract/payroll/asset/efficiency shapes needed by the prompt suite.
- Stacked bars can render long-form SQL results with `name`, `series`, and `value`, so the backend does not need hardcoded pivot columns for categories like asset type.
- Deterministic EBPO routes were added only where LLM SQL generation was unstable: AR Pareto, operations scatter/combo, current ratio, asset intensity, asset stacked NBV, business-unit revenue/payroll/margin, and monthly revenue/cost/gross-margin waterfall.

## Important Notes

- The reference dashboard is a visual reference with 25 rendered panels; it is not itself a complete set of all 100 requested charts.
- The live audit validates prompt generation by executing generated SQL and checking chart type plus returned data.
- `CFO scorecard` is treated as a KPI-style chart.
- The final `dashboard showing monthly liquidity, profitability, employee efficiency, and cash conversion metrics` is a multi-widget dashboard request, not a single chart-type request.

## Commands Run

- Full live audit: `pnpm --dir apps/api exec tsx scripts/audit-ebpo-prompt-suite.ts`
- Failed prompt rerun only: `pnpm --dir apps/api exec tsx scripts/audit-ebpo-prompt-suite.ts rev-10`
- Reference screenshot capture: bundled Chromium/Playwright against `file:///Users/basanireddy/Downloads/new%20dataset%20dashboard.html`

## Implementation References

- EBPO deterministic SQL routes: `/Users/basanireddy/Desktop/test-1234/apps/api/src/modules/agent/agent.service.ts`
- Long-form stacked-bar rendering: `/Users/basanireddy/Desktop/test-1234/apps/web/app/dashboard/_components/DashboardPreview.tsx`
- Prompt audit harness: `/Users/basanireddy/Desktop/test-1234/apps/api/scripts/audit-ebpo-prompt-suite.ts`
- Exhaustive prompt type suite: `/Users/basanireddy/Desktop/test-1234/apps/api/src/modules/agent/chart-prompt-suite.spec.ts`
- Semantic ClickHouse views: `/Users/basanireddy/Desktop/test-1234/packages/db/scripts/seed-ebpo-clickhouse.ts`
