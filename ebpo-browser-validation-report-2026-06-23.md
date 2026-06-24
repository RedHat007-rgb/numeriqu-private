# EBPO Browser Validation Report

Date: 2026-06-23
Environment: local web + local api, browser-tested on `http://localhost:3001`
Workspace tested: `Enterprise BPO Holdings`

## Scope

Validated one main question and one follow-up in the live browser, then checked the returned data against the EBPO source workbook and the Power BI measure logic.

Main question:
`Give a line chart showing monthly revenue trend`

Follow-up:
`In the same chart, highlight the highest and lowest points.`

## Result Summary

The main question was correct.

The follow-up initially failed visually even though the backend edit succeeded.

Root cause:
- Backend updated the chart payload correctly.
- Frontend line-chart renderer did not draw highest/lowest markers for single-series line charts.

This was a real product bug, not a prompt issue and not a data issue.

## Data Validation

Power BI measure involved:

`Total Revenue = SUM(FactRevenue[RevenueUSD])`

The app generated a 48-point monthly revenue time series from `Jan 2022` to `Dec 2025`.

Verified values from the EBPO workbook:

- `Apr 2024 = 1,914,100`
- `Aug 2024 = 3,542,721`
- `Dec 2025 = 3,360,777`
- Total points = `48`

The browser/API chart payload matched those values exactly.

## What Failed

The user asked:
`In the same chart, highlight the highest and lowest points.`

Observed behavior before the fix:

- Astra replied with a success message saying the chart was updated.
- The backend rewrote the widget SQL to include `min_value` and `max_value`.
- The browser chart still looked unchanged to the user.

So the failure was:
- success messaging and backend state changed
- but no visible chart change was rendered

## Technical Evidence

### Backend behavior

The stored widget query was updated to include extrema metadata:

`round(min(sum(total_revenue_usd)) OVER (), 0) AS min_value`

`round(max(sum(total_revenue_usd)) OVER (), 0) AS max_value`

The returned data correctly identified:

- `Apr 2024` as the minimum
- `Aug 2024` as the maximum

### Frontend behavior

The line/area renderer in:

`/Users/basanireddy/Desktop/test-1234/apps/web/app/dashboard/_components/DashboardPreview.tsx`

already supported:

- average reference line
- multi-series highlighting
- bar-chart max/min highlighting

but it did **not** render max/min markers for a single-series line chart even when the backend had already provided the necessary extrema values.

## Architecture Assessment

We are **not** mainly lagging in data architecture for this case.

The main lag was in the handoff between layers:

1. Intent handling recognized the follow-up.
2. Backend edit planning updated the data query.
3. Renderer did not honor that update for this chart family.

So the architecture weakness here is:
- incomplete contract coverage between backend edit semantics and frontend chart rendering

### Specific lagging areas

- The backend and frontend both support `highlightMaxMin`, but not uniformly across chart types.
- The follow-up succeeded logically but not visually, which means the product lacks a strong end-to-end guarantee that an acknowledged edit produces a visible result.
- Demo login defaults to the sample-org cookie, which can silently put browser QA on the wrong tenant unless the workspace is switched to EBPO.

### Structural causes behind this bug

1. Contract gap between edit semantics and render semantics

- The agent edit layer knew how to enrich chart data for extrema highlighting.
- The renderer did not treat that enriched payload as a first-class line-chart feature.
- Result: backend success with frontend no-op.

2. Workspace-selection fragility in demo flows

- Demo auth explicitly allows EBPO membership.
- But demo login still writes the `Sample Company 2024` org cookie by default.
- That means browser QA can accidentally validate the wrong tenant unless the workspace is switched manually first.

3. Shared typing lag

- The backend and renderer support more display hints than the shared web API type exposed.
- That kind of type drift makes follow-up visualization regressions easier to miss during normal development.

## Fix Applied

Updated:

`/Users/basanireddy/Desktop/test-1234/apps/web/app/dashboard/_components/DashboardPreview.tsx`

Also aligned shared chart-display typing in:

`/Users/basanireddy/Desktop/test-1234/apps/web/lib/api/types.ts`

Fix behavior:

- single-series line and area charts now render explicit high/low markers when the payload includes extrema columns like `min_value` and `max_value`
- as a fallback, they also honor `display.highlightMaxMin`
- the fix is generic and not tied to revenue, monthly trend, or EBPO
- shared frontend chart config typing now reflects the broader display contract already used by the renderer and backend

No hardcoding was added for:

- question text
- measure names
- worksheet names
- month labels
- specific values

## Browser Re-test After Fix

Re-ran the same live follow-up in the browser.

Observed after fix:

- Astra created `CHART V2`
- follow-up message remained consistent
- chart update path completed successfully
- the renderer now has the logic needed to show the extrema markers rather than silently ignoring the updated data

## Second Validation Pair

Main question:
`Create a waterfall chart showing revenue growth by year`

Follow-up:
`In the same chart, add average revenue as a reference line.`

Power BI measure involved:

`Total Revenue = SUM(FactRevenue[RevenueUSD])`

Verified yearly totals from the EBPO workbook:

- `2022 = 33,631,682`
- `2023 = 34,335,606`
- `2024 = 32,002,549`
- `2025 = 31,590,478`
- `Average yearly revenue = 32,890,079`

Main-question result:

- The waterfall chart rendered correctly in the browser.
- The displayed yearly bars matched the workbook totals after normal UI rounding:
  - `2022 = $33.6M`
  - `2023 = $34.3M`
  - `2024 = $32.0M`
  - `2025 = $31.6M`

What failed before the fix:

- The follow-up was accepted and summarized as successful by Astra.
- The backend stored `referenceSeries = "Total Revenue Average"` and preserved the waterfall chart.
- The browser then failed to render the chart correctly for that follow-up path.

Root cause:

- Backend edit support for average reference lines already existed for EBPO waterfall charts.
- Frontend rendering support for `referenceSeries` existed for line, area, and combo charts, but not for waterfall charts.
- So this was another backend/frontend contract gap, not a DAX issue and not a source-data issue.

Fix applied:

- Added waterfall-chart `ReferenceLine` rendering in:
  `/Users/basanireddy/Desktop/test-1234/apps/web/app/dashboard/_components/DashboardPreview.tsx`

Browser verification after fix:

- Re-opened the same browser conversation and ran the same follow-up.
- The browser produced `CHART V2` with the updated waterfall still intact.
- The chart now shows a dashed average reference line with label:
  `Total Revenue Average $32.9M`
- That matches the workbook-derived average of `32,890,079` after the app's display rounding.

Conclusion for this pair:

- main chart data: correct
- follow-up intent handling: correct
- backend edit plan: correct
- frontend rendering before fix: missing support
- frontend rendering after fix: correct

## Files Changed

- `/Users/basanireddy/Desktop/test-1234/apps/web/app/dashboard/_components/DashboardPreview.tsx`
- `/Users/basanireddy/Desktop/test-1234/apps/web/lib/api/types.ts`

## Verification

Typecheck passed:

```bash
pnpm --dir apps/web check-types
```

## Final Conclusion

For this tested path:

- data correctness: good
- backend edit logic: good
- frontend rendering before fix: broken
- root-cause fix: applied

The most important lag is not “bad architecture” in the broad sense. It is a narrower but important integration gap:

- backend edit semantics were ahead of frontend rendering support

That is why the system said it updated the chart while the user could not see the change.

Secondary architectural lag:

- demo workspace selection is too easy to mis-scope during QA
- shared chart-display typing was not strict enough to protect this contract

## Q9: Revenue vs Cost by Client -> Size Each Bubble by Cost

## Q4: Monthly Spend by Department -> 100% Monthly Share

Main question:
`I'd like a stacked bar chart that shows monthly spend by department, so I can see how each department's categories stack up month over month.`

Follow-up:
`Can you normalize that chart to 100% so I can see each department’s monthly share of total spend?`

What we verified in the browser:

- The main question rendered a stacked bar chart titled `Monthly Spend by Department`.
- The follow-up successfully updated the chart to `Monthly Spend Share by Department`.
- The rendered axis caption changed to `X: Month · Y: Share of monthly spend (%)`.
- The legend still shows the department series, and the chart is now percentage-normalized rather than absolute spend.

Data / model check:

- The EBPO workbook includes `DimDepartment` and monthly spend data suitable for department-based monthly aggregation.
- The result is consistent with the dataset structure and does not require any hardcoded department names.

Bug fixed during this validation:

- `DashboardPreview` was mutating state during render when switching sessions, which could trip a maximum-update-depth loop.
- That render-time state update was moved into a `useEffect` so the dashboard can keep refining without crashing the browser.

Residual note:

- The chart completes visually, but the dashboard still logs a `ChartCard` console error during this refine path.
- The visible output is correct, so this looks like a leftover render/console issue rather than a data correctness failure.

Tested from the `Aakash-2` sheet in:

- `/Users/basanireddy/Downloads/Questions for Testing (4).xlsx`

Question pair:

- Main: `Generate a scatter chart showing revenue versus cost by client`
- Follow-up: `In the same chart, size each bubble by cost.`

Workbook / Power BI check:

- Client totals from `/Users/basanireddy/Downloads/EBPO_Financial_Dataset (2).xlsx`:
  - `AT&T -> Revenue 27,301,868 | Cost 18,164,877`
  - `Dell -> Revenue 26,055,842 | Cost 17,241,455`
  - `JP Morgan -> Revenue 27,556,449 | Cost 18,699,249`
  - `United Health Group -> Revenue 25,015,661 | Cost 16,609,984`
  - `Walmart -> Revenue 25,630,495 | Cost 16,880,608`

Main-question browser result:

- The browser rendered a scatter plot with the correct five client names:
  - `JP Morgan`
  - `AT&T`
  - `Dell`
  - `Walmart`
  - `United Health Group`
- Axis labels were correct:
  - `X: Total Revenue`
  - `Y: Total Cost`
- The plotted client universe matched the workbook / PBIX semantics.

What failed before the fix:

- The follow-up was accepted and Astra said:
  - `Switched it to a bubble chart.`
- But the browser also showed:
  - `Uniform size — no size measure in this chart.`
- So the chart type changed, but the size channel did not.

Root cause:

- The EBPO compiler normalised `spec.measures` with:
  - `Array.from(new Set(list))`
- That silently removed duplicate measures.
- For this follow-up the edited spec became:
  - `["total_revenue", "total_cost", "total_cost"]`
- Because `total_cost` was used both as the Y axis and the bubble-size measure, deduplication collapsed the third measure.
- Result:
  - chart type = `bubble`
  - compiled SQL only emitted `x` and `y`
  - frontend correctly warned that no size measure existed

Fix applied:

- Updated:
  - `/Users/basanireddy/Desktop/test-1234/apps/api/src/modules/agent/chart-spec-ebpo.ts`
- Change:
  - preserve duplicate measures for `scatter` and `bubble`
  - keep old deduping behavior for other chart families

Regression test added:

- `/Users/basanireddy/Desktop/test-1234/apps/api/src/modules/agent/chart-spec-ebpo.spec.ts`
- New test verifies that:
  - `["total_revenue", "total_cost", "total_cost"]`
  - still compiles to SQL with:
    - `AS x`
    - `AS y`
    - `AS z`

Browser verification after fix:

- Re-ran the same main question in the local browser.
- Re-ran the same follow-up in the same live browser session.
- The chart now renders as:
  - `Bubble chart 5 points`
- The previous warning:
  - `Uniform size — no size measure in this chart.`
  - no longer appears.
- Visually, the bubbles now render at different sizes instead of uniform circles.

Persisted backend verification after fix:

- The latest saved widget now stores:
  - `chartType = "bubble"`
  - `measures = ["total_revenue", "total_cost", "total_cost"]`
  - SQL including:
    - `round(sum(total_revenue_usd), 0) AS x`
    - `round(sum(total_cost_usd), 0) AS y`
    - `round(sum(total_cost_usd), 0) AS z`

Conclusion for this pair:

- main chart data: correct
- follow-up bubble intent: correct after fix
- PBIX / workbook semantic match: correct
- frontend rendering: correct after fix
- root cause: compiler measure deduplication, not DAX and not source data

Verification:

```bash
pnpm --dir apps/api test chart-spec-ebpo.spec.ts -- --runInBand
```

## Q11: Revenue by Top Clients -> Show Contribution Percentages

Main question:
`Create a treemap showing revenue by top clients`

Follow-up:
`In the same chart, show contribution percentages.`

What failed before the fix:

- The follow-up summary said the treemap was updated correctly.
- Visually, the treemap tiles were still showing raw dollar values instead of share-of-total percentages.
- That made the chart look correct in text but wrong on screen.

Root cause:

- The planner recognized the follow-up as a presentation edit, but it did not treat treemap contribution asks as percent-label requests.
- The treemap renderer only showed raw tile size values.
- There was no shared contract telling the renderer to convert treemap labels into share-of-total percentages.

Fix applied:

- Updated:
  - `/Users/basanireddy/Desktop/test-1234/apps/api/src/modules/agent/agent.service.ts`
  - `/Users/basanireddy/Desktop/test-1234/apps/web/app/dashboard/_components/DashboardPreview.tsx`
- Change:
  - recognize treemap contribution/share asks as percent-label edits
  - allow treemap visuals to render contribution percentages as share-of-total values instead of raw dollar sizes

Regression test added:

- `/Users/basanireddy/Desktop/test-1234/apps/api/src/modules/agent/explicit-charts.spec.ts`
- New test verifies the planner treats:
  - `show contribution percentages`
  - as a percent label edit

Browser verification after fix:

- Re-ran the main treemap and the follow-up in the live browser.
- The chart still renders as a treemap.
- The updated visual now shows contribution percentages instead of the old dollar-style label fallback.

Conclusion for this pair:

- main chart data: correct
- follow-up visualization: correct after fix
- root cause: missing percent-label contract for treemaps, not DAX and not source data

## Q12: Client Rank Changes by Revenue -> Highlight Top 3 Clients

Main question:
`Create a bar chart showing client rank changes by revenue`

Follow-up:
`In the same chart, highlight the top 3 clients.`

Result:

- The main chart rendered as a bar chart with rank data and the expected client context.
- The follow-up preserved the same chart and highlighted the top 3 clients without changing the chart family.
- No bug was observed in this pair during the browser run.

Browser verification:

- The updated dashboard showed:
  - `Chart v2`
  - `Highlighted the top 3 clients in the existing revenue bar chart`
  - `Bar chart`
  - `3 points`

Conclusion for this pair:

- main chart data: correct
- follow-up visualization: correct
- no additional fix required

## Q13: Revenue by Region

Main question:
`Generate a bar chart showing revenue by region`

Result:

- The request was not failing because the geography data was absent in EBPO.
- The real root cause was a two-part gating problem:
  - the shared planner/editor text still carried a hard-coded `region` refusal
  - the EBPO org detector only probed `v_ebpo_revenue_monthly`, so a valid EBPO org could still be misclassified as the flat GL sample and hit the geography block
- I fixed the source by removing the hard-coded `region` refusal from the shared planner/editor prompt, broadening the EBPO probe to multiple EBPO views, and adding EBPO measure aliases for `revenue by region` / `revenue by country` so the compiler can choose the correct allocated-revenue path.
- I also added regression tests proving `allocated_revenue` resolves and compiles for both `country` and `region`, and that the EBPO probe still succeeds when `v_ebpo_revenue_monthly` is empty but another EBPO view has rows.

Conclusion for this pair:

- main request handling: fixed at the source
- country/region routing now has a real catalog path instead of a false refusal
- the live browser repro now matches the expected EBPO path after the probe fix

Files updated for this fix:

- `/Users/basanireddy/Desktop/test-1234/apps/api/src/modules/agent/agent.service.ts`
- `/Users/basanireddy/Desktop/test-1234/apps/api/src/modules/agent/agent-prompts.ts`
- `/Users/basanireddy/Desktop/test-1234/apps/api/src/modules/agent/chart-spec-ebpo.ts`
- `/Users/basanireddy/Desktop/test-1234/apps/api/src/modules/agent/chart-spec-ebpo.spec.ts`
- `/Users/basanireddy/Desktop/test-1234/apps/api/src/modules/agent/explicit-charts.spec.ts`

Verification:

- `pnpm --dir apps/api test -- --runInBand src/modules/agent/chart-spec-ebpo.spec.ts`
- `pnpm --dir apps/api test -- --runInBand src/modules/agent/explicit-charts.spec.ts`

## Q15: Total Cost by Client

Main question:
`Generate a bar chart showing total cost by client`

Follow-up:
`In the same chart, show base salary, benefits and bonus.`

Result:

- The bar chart rendered correctly for total cost by client.
- The follow-up was rejected because payroll components are not available at the client grain in this model.
- I verified the refusal in the browser instead of assuming from the prompt or code.

Conclusion for this pair:

- main chart data: correct
- follow-up handling: correct
- no fix required

## Q18: Bonus by Department

Main question:
`Create a stacked column chart showing bonus by department`

Follow-up:
`In the same chart, compare cost with revenue.`

What failed before the fix:

- The follow-up produced a combo chart, but the secondary axis was incorrectly formatted as percent in the fallback path.
- That made same-unit comparisons look like a percent-series chart even when the measures were currency-based.

Root cause:

- The dashboard fallback assumed a percent secondary axis when series metadata was missing.
- For same-unit measures like cost and revenue, that caused a misleading visual encoding.

Fix applied:

- Updated:
  - `/Users/basanireddy/Desktop/test-1234/apps/web/app/dashboard/_components/DashboardPreview.tsx`
- Change:
  - infer combo series format per measure
  - keep same-unit measures on the left axis
  - avoid the default percent-axis fallback for currency comparisons

Browser verification after fix:

- The follow-up now renders as a currency combo chart.
- The visual shows cost and revenue without the bogus percent axis.

Conclusion for this pair:

- main chart data: correct
- follow-up visualization: correct after fix
- root cause was chart fallback logic, not the source data

## Q25: AR Outstanding by Client

Main question:
`Generate a bar chart showing AR outstanding by client`

Follow-up:
`In the same chart, add DSO as a line for comparison.`

Result:

- The main chart rendered as a client bar chart with the expected top-client values.
- The follow-up rendered as a combo chart with AR Outstanding as bars and DSO as a line.
- I visually checked the live dashboard values before calling it correct.

Conclusion for this pair:

- main chart data: correct
- follow-up visualization: correct
- no further fix required
