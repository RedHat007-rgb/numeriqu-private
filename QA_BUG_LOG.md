# EBPO Chart QA — Visual + PowerBI-Parity Bug Log

> ## ✅ ROOT-CAUSE FIXES APPLIED (2026-06-26) — Asyraf-2 re-test bugs, fixed at the root & re-verified in the browser
> Principle enforced: **calculate from the data that genuinely exists (even when it must be derived); refuse honestly only when the grain truly isn't there; never fabricate.** No hardcoding / per-question crutches.
>
> | # | Bug (Asyraf-2) | Root cause | Fix | Re-verified in browser |
> |---|---|---|---|---|
> | **A** | **Q12/Q15** SLA / utilization "by department" rendered identical bars (92.4% / 86.4% ×10) — fabrication | `canReplicateAcrossDim` broadcast a ratio's company average across an unrelated dimension (department has no operations grain). It only ever fired when NO real view existed → always fabrication. | Disabled the cross-dim replication (`canReplicateAcrossDim` → always false) in `chart-spec-ebpo.ts`; the request now hits the existing honest refusal that lists the real grains. | Q12 → *"SLA Compliance % isn't available broken down by Department … I can show it by Delivery Center, Region, Country, or Market Type, or over time."* Q15 same for utilization. **Regression check:** "SLA by region" still builds (NA 92.7 / APAC 92.5 / Europe 92.3 / ME 91.7 / LATAM 91.6 ✓). |
> | **B** | **Q14 FU** refusal leaked a wrong dataset description ("single year of general-ledger transactions and a trial balance") | `detectUnavailableData` appended a hardcoded GL tail to refusals that fire for BOTH datasets. | Made the tail dataset-aware in `agent.service.ts` (neutral close for EBPO). | Q14 FU → *"I can't compare against targets — there are no target or goal figures in this dataset. I left the chart unchanged."* No GL leak (`leaksGL:false`). |
> | **C** | **Q22/Q23/Q25** "largest client during the last 8 months" used the **all-time** leader (JP Morgan) instead of the windowed leader (AT&T) | `listTopClientsForScope` ranked over an all-time client view with no time filter. | Added a time-aware ranking source (`windowedView` → `v_ebpo_revenue_by_client_contract_monthly`) to the dataset profile; `listTopClientsForScope` now scopes to `spec.recentMonths` when set; `resolveSpecClientFilters` passes the window. (`dataset-profile.ts`, `agent.service.ts`) | Q25 now charts **AT&T** — bar geometry decodes to May $214K / Jun $890K / Jul $523K / Aug $349K = exact AT&T monthly revenue (axis grew $800K→$1.0M). |
> | **D** | **Q24** "revenue and **expenses** for top clients" falsely refused ("aren't tracked at the same level of detail") | Planner mapped "expenses"→`total_expenses` (= cost+payroll, company/monthly only; payroll has no client grain) → no shared view → refusal. | Deterministic normalization: when `total_expenses` is grouped by a categorical dim it can't support but `total_cost` can (client/BU/contract), substitute `total_cost` — the only client-attributable expense. (`agent.service.ts`) | Q24 now builds **"Revenue and Expenses — Top 10 Clients"** with Total Cost + Total Revenue per client. No refusal. |
> | **E** | **Q22 FU** "highlight the client with the highest cumulative revenue" → falsely claimed *"JP Morgan isn't present in this chart"* and highlighted nothing | The highlight resolver (edit path) used the global all-time #1 and matched it against the `name` column (which holds MONTHS in a by-client trend; clients are SERIES/columns). | Rewrote the resolver to rank clients by their **total within the chart's own data** (handles wide-pivot series and long rows; respects the window); routes a series match to `display.highlightSeries` (the field the multi-line renderer reads) instead of `highlightNames`. (`agent.service.ts`) | Q22 FU → *"Highlighted AT&T in the chart."* — AT&T line emphasized (stroke 3.4, opacity 1), other four dimmed to opacity 0.22. |
>
> Build: `nest build` clean (0 errors in `src/`); API restarted on :3000 from the fresh build for verification.
>
> ### Second pass (2026-06-26, same day)
> | Fix | Bug | Root cause | Change | Status |
> |---|---|---|---|---|
> | **H** | **Q16 FU** added the chart's CSAT average instead of the requested **SLA** benchmark line | `detectEbpoMeasureMentions` only matched "sla compliance" / "sla %"; bare **"SLA"** ("average SLA as a benchmark line") wasn't recognized → fell through to the chart's existing CSAT measure | Match bare `\bsla\b` in `detectEbpoMeasureMentions` (`agent.service.ts`) | ✅ Verified — now *"Added SLA Compliance % as a comparison series"* (correct measure; renders SLA, not CSAT) |
> | **K-axis** | **Q6 FU** 100%-stacked percent chart Y-axis ran 0–220% | percent-stacked YAxis auto-scaled to the summed per-series maxima instead of clamping to 100 | Added `domain=[0,100]` to the bar YAxis when normalized / stacked-percent (`DashboardPreview.tsx`) | ⚠️ Guard in place but not yet confirmed firing on the EBPO stacked-percent path (cosmetic; bars are correct at 100%). Needs the EBPO normalize edit to set `display.normalized`. |
>
> **Still open (mapped, not yet implemented):** Q1 FU cumulative double-counts the waterfall total (exclude `is_total` from the cumulative running-sum at `chart-spec-ebpo.ts:2388`); Q2 FU cumulative-GM on a scatter; Q21 FU "compare current vs last year" needs a YoY dual-series handler (the create-path year-grouping exists; the edit-path doesn't); Q8 SG&A / Q19 FU CSAT-by-dept / Q23 account-by-client fabrications come through the multi-step clarification chain — the compiler-level grain guard (`resolveEbpoView` requiring filter dims) is already correct, so the fix is to validate clarification OPTIONS against the catalog before offering them (`agent.service.ts` clarify path ~13860) and stop the two-chart builder from compiling a client-filtered account chart; Q10 heatmap all-zeros (value binding at month×account grain).


> ## ✅ ROOT-CAUSE FIXES APPLIED (2026-06-25) — all 4 Aakash-2 follow-up bugs fixed & re-verified in the browser
> No hardcoding / per-question crutches — general fixes at the root:
>
> | Bug | Root cause | Fix | Verified |
> |---|---|---|---|
> | **Q2 FU** value labels showed % not $ | 3 duplicated, too-narrow value/percent label regexes; "actual … values" with intervening words slipped through, and bare "contribution" forced % | New phrasing-robust `wantsValueLabelIntent`/`wantsPercentLabelIntent` helpers; `detectLabelModeEdit` checks value-intent first (`agent.service.ts`) | Pie now shows $35.9M/$25.7M/$23.7M/$23.4M/$22.8M ✅ |
> | **Q14 FU** revenue axis became "7000000.0%" | combo legacy branch forced chart-wide `valueFormat:'percent'` onto the `value` bar axis; `value` is the implicit primary (excluded from series inference) so the % overlay defined the left axis | combo legacy branch now re-adds implicit `value` as the left bar with its own ($) format and routes %-overlays to the right axis; `inferFormatFromKey` recognizes compound `*_value`; pareto left axis hard-set to currency (`DashboardPreview.tsx`) | Left axis $0–$140M, right axis 0–100% ✅ |
> | **Q18 FU** fabricated cost & revenue by dept (both = payroll) | LLM-SQL editor aliased one column (`total_payroll_usd`) as both `cost` and `revenue` at a grain neither exists | General fabrication guard in `verifySql`: reject edit SQL that aliases the same aggregate expression to ≥2 distinct measure names (`agent.service.ts`) | FU honestly declines; chart stays real Bonus by Dept ✅ |
> | **Q20 FU** avg-cost line invisible (off-scale) | reference line for a measure NOT on the chart was forced onto the primary axis (overtime $0–$100K) so a $1.8M line was off-screen | backend routes a foreign-measure reference to a secondary right axis with its own format; area/line renderer draws a right axis + flat reference Line scaled to the value (`agent.service.ts` + `DashboardPreview.tsx`) | Right axis $0–$2.1M, avg-cost line ~$1.82M visible ✅ |
>
> Regression check: Q17 (avg-cost line on a cost chart) correctly stays on the **left** axis (same metric) — unaffected.

**Date:** 2026-06-25
**Tester:** Claude (automated browser QA)
**Scope:** Sheets **Aakash-2** (25 Q + follow-ups) and **Asyraf-2** (25 Q + follow-ups), from `Questions for Testing (5).xlsx`
**Environment:** web `localhost:3001` (real Astra chat UI) → api `localhost:3000` → ClickHouse `analytics` (remote). Org = **Enterprise BPO Holdings** (`7375b5aa-…`). `AGENT_SPEC_MODE=1`, planner `gpt-5.4-mini`.
**Ground truth:** DAX measures computed on `EBPO_Financial_Dataset (3).xlsx` (the same source the `.pbix` is built on). Headline check values:
- Total Revenue = **131,560,315**
- Total Cost = **87,596,173.30**
- Gross Margin = **43,964,141.70** (GM% = 33.42%)
- Total Payroll = **111,990,068.20**
- AR Outstanding = **13,332,426.70** ; AP Outstanding = **6,367,486.30**
- DSO = **36.99** ; DPO = **26.53**
- Avg Utilization% = **86.41** ; SLA% = **92.36** ; CSAT% = **82.26**
- Cash Balance (MAX) = **9,824,716**

**Legend:** ✅ correct · ⚠️ minor (labels/axis/format) · ❌ wrong value / wrong chart / refusal-when-possible · 🚫 correctly refused (data inconsistency)

**Note:** No fixes applied — observation log only.

---

## Sheet: Aakash-2

### Q1 — bar: total revenue by client → FU: add gross margin
- **Main: ✅** Bar chart, 5 clients sorted desc. Rendered values match PowerBI exactly: JP Morgan $27.6M (27,556,449), AT&T $27.3M (27,301,868), Dell $26.1M (26,055,842), Walmart $25.6M (25,630,495), United Health Group $25.0M (25,015,661). Y-axis $0–$28M, title "Total Revenue by Client". No issues.
- **FU: ✅** (minor ⚠️) Grouped bar V2 with legend "Gross Margin" + "Total Revenue". GM values render $8.9M/$9.1M/$8.8M/$8.7M/$8.4M — match PowerBI (8.857M/9.137M/8.814M/8.750M/8.406M). ⚠️ Minor: chart title still reads "Total Revenue by Client" — not updated to reflect the added Gross Margin series.

### Q2 — pie: revenue contribution by business unit → FU: show actual values
- **Main: ✅** Pie, 5 business units. Rendered %: Telecom Support 27.3%, IT Helpdesk 19.5%, Banking BPO 18.0%, Customer Care 17.8%, Healthcare BPO 17.3% — match PowerBI (27.30/19.53/18.03/17.81/17.33). Footer "Telecom Support leads at 27%". Legend complete.
- **FU: ❌ BUG (silent no-op).** Request: "show actual revenue contribution values". Agent emitted "CHART V2 / updated chart" but the pie still shows **percent labels only** — no $ revenue values rendered. Underlying data (35.9M/25.7M/23.7M/23.4M/22.8M) correct but not surfaced. **Root cause:** `display.labelMode` remained `'percent'`; the value/both label mode was never applied despite `valueFormat:'currency'` being set. Edit claims success but render is identical to V1 (matches known follow-up silent-no-op pattern).

### Q3 — line: monthly revenue trend → FU: highlight highest/lowest
- **Main: ✅** Line, 48 points Jan 2022–Dec 2025, y-axis $0–$3.6M (peak $3.5M fits). Footer "48 points · 15.4% growth over period" (Jan22 2.91M → Dec25 3.36M = +15.4% ✓). Full series matches monthly GT.
- **FU: ✅** V2 set `highlightNames:['Aug 2024','Apr 2024']` = true max (3,542,721) and min (1,914,100). Markers render on chart; assistant confirms "Highlighted Aug 2024, Apr 2024".

### Q4 — stacked column: revenue by country [sheet: NOT possible] → FU: add last year
- **Main: 🚫 correct refusal.** "revenue by country isn't available in this dataset… not broken out geographically. I'd show revenue by business unit or client instead." No chart. Matches expected (data inconsistency — FactRevenue has no geography key).
- **FU: 🚫 correct refusal.** Context-aware: "can't add last year's revenue to that same chart"; correctly states payroll/operations have country but revenue does not. Both behave as expected.

### Q5 — donut: revenue by industry → FU: display data labels with actual values
- **Main: ✅** Donut, center total $131.6M (=131,560,315 ✓). Slice %: 20.9/20.8/19.8/19.5/19.0 = Banking/Telecom/Technology/Retail/Healthcare — match PowerBI. All 5 in legend.
- **FU: ✅** Set `labelMode:'value'`; renders $27.6M/$27.3M/$26.1M/$25.6M/$25.0M, all correct. **NOTE:** This worked, but Q2's near-identical FU ("show actual … values") did NOT — confirms Q2 value-label bug is phrasing-sensitive (planner only maps some phrasings to labelMode change).

### Q6 — area: revenue YTD trend → FU: show cumulative revenue
- **Main: ✅ values, ⚠️ window.** YTD-2025 cumulative renders correctly: Jul $18.0M, Aug $20.3M, Sep $22.4M, Oct $25.9M, Nov $28.2M, Dec $31.6M (= running YTD sum of 2025 monthly, verified). ⚠️ Default window = **"Last 6 months"** so only Jul–Dec 2025 shown; the Jan→Dec YTD ramp/reset isn't visible. Y-axis $0–$32M.
- **FU: ⚠️ debatable (honest no-op).** Agent: "already shows revenue YTD, which is cumulative revenue, so I left the chart unchanged." Honest (no false success claim), but YTD ≠ all-time cumulative: YTD resets each year (Dec 2025 = $31.6M) whereas a true running cumulative over full history would reach ~$131.6M. Interpretation gap, not a hard bug.

### Q7 — clustered bar: revenue by city → FU: rank clients by revenue
- **Main: 🚫 correct refusal.** "Total Revenue isn't available broken down by City … isn't tracked at that level." Revenue has no geography link (same inconsistency as Q4) — correct to refuse. No chart.
- **FU: ✅** Recovered well: built a new "Revenue by Client" bar sorted desc (JP Morgan $27.6M, AT&T $27.3M, Dell $26.1M, Walmart $25.6M, UHG $25.0M) — correct ranking & values.

### Q8 — waterfall: revenue growth by year → FU: add average reference line [sheet: ref line NOT possible in PBI waterfall]
- **Main: ⚠️ semantic mismatch.** Bars show each year's total revenue accumulating to ~$131.6M (2022 $33.6M, 2023 $34.3M, 2024 $32.0M, 2025 $31.6M — per-year values correct vs GT). But titled "Revenue **Growth** by Year" while showing **cumulative yearly revenue**, not YoY growth deltas (which would be +0.7M / −2.3M / −0.4M). Misleading for the stated intent.
- **FU: ✅ (value correct).** Added reference line "Total Revenue Average $32.9M" = 131,560,315/4 = 32.89M ✓. Note: our app renders a ref line on a waterfall even though the sheet says PowerBI cannot — positive divergence vs PowerBI.

### Q9 — scatter: revenue vs cost by client → FU: size bubble by cost
- **Main: ✅** Scatter, x "Total Revenue" ($0–$28M), y "Total Cost" ($0–$20M), 5 client points, legend complete. ⚠️ Points cluster/overlap in top-right (all 5 clients ~$25–28M rev / ~$16–19M cost) — inherent to data, not a defect.
- **FU: ✅** Switched to bubble chart, measures [total_revenue, total_cost, total_cost] = x/y/size — size-by-cost correct.

### Q10 — combo: monthly revenue + gross margin → FU: show YoY growth %
- **Main: ✅** Combo, 48 months, Total Revenue (bar) + Gross Margin (line) both left axis $0–$3.6M. Structure & ranges correct.
- **FU: ✅** Added "Revenue YoY Growth %" as right-axis % line (scale −60%→+60%, plausible for monthly YoY swings). Dual-axis correct. ⚠️ Minor: Gross Margin role flipped line→bar when the % line was added (cosmetic).

### Q11 — treemap: revenue by top clients → FU: show contribution %
- **Main: ✅** Treemap, 5 clients correct ($27.6M/$27.3M/$26.1M/$25.6M/$25.0M). ⚠️ Minor: a stray "$0" label renders (treemaps have no axis); "United Health…" label truncated.
- **FU: ✅** Added `company_share` transform; tiles show 20.9/20.8/19.8/19.5/19.0% — match PowerBI contributions. ⚠️ Minor: stray label now reads "0.0%".

### Q12 — bar: client rank changes by revenue → FU: highlight top 3
- **Main: ⚠️ misinterpretation.** Rendered plain revenue-by-client in $ (identical to Q1), titled "Client Rank Changes by Revenue". Shows no rank position (1–5) and no temporal "change" — the data has no period-over-period ranking. Values correct but intent ("rank changes") not represented; should have clarified/refused or shown rank deltas.
- **FU: ✅** Highlighted JP Morgan, AT&T, Dell = correct top 3 by revenue.

### Q13 — bar: revenue by region [sheet: NOT possible] → FU: size bubbles by revenue
- **Main: 🚫 correct refusal.** "revenue by region isn't available… operations by region exists, not revenue by geography."
- **FU: 🚫 correct refusal.** Context-aware; offers ops-by-region bubble alternative. Both as expected.

### Q14 — Pareto: cumulative revenue contribution → FU: identify 80/20 threshold
- **Main: ✅** Proper Pareto — descending revenue bars (left $0–$28M) + cumulative % line to 100% (right) + 80% dashed reference. 80% crossed at ~4th client (Walmart, cum 80.98%) per GT.
- **FU: ❌ BUG (axis-format corruption).** Adding the 80/20 threshold flipped `display.valueFormat` **currency→percent globally**. The percent formatter then hit the left (revenue) axis, rendering **"7000000.0%", "14000000.0%", "21000000.0%", "28000000.0%"** instead of $7M–$28M (value ×100 + "%"). Confirmed visually. **Root cause:** valueFormat applied chart-wide rather than per-series; the dollar/bar axis should keep currency while only the cumulative line is percent. (Matches the known "outputPercent / percent-blindspot" failure class.)

### Q15 — bar: total cost by client → FU: show base salary/benefits/bonus
- **Main: ✅** Cost by client $18.7M/$18.2M/$17.2M/$16.9M/$16.6M — match PowerBI (18.70/18.16/17.24/16.88/16.61M). Y-axis $0–$20M.
- **FU: ⚠️ correct outcome, weak message.** Did NOT fabricate payroll-by-client (payroll components aren't linked to client — correct to decline). But message was generic "I wasn't able to apply that change… could you rephrase (metric/dimension/…)" instead of explaining that base salary/benefits/bonus aren't available per client. Honest non-action, poor UX.

### Q16 — pie: payroll distribution by department → FU: display values
- **Main: ✅** Pie, 10 depts. %: 12.3/11.8/11.1/10.7/10.4/10.3/10.1/9.0/7.6/6.7 — match PowerBI (IT 12.29 … Operations 6.69). Legend complete.
- **FU: ✅** `labelMode:'value'`; renders $13.8M/$13.2M/$12.5M/$12.0M/$11.7M/$11.5M/$11.3M/$10.1M/$8.5M/$7.5M — match PowerBI payroll-by-dept.

### Q17 — line: monthly cost trend → FU: add average cost line
- **Main: ✅** Line, 48 months, y-axis $0–$2.4M, "8.0% growth over period". Full cost series.
- **FU: ✅** Added "Total Cost Average" reference line (left axis, ≈$1.8M = 87.6M/48 = 1.825M). ⚠️ Minor: label shows only the name, not the value (Q8's ref line showed "$32.9M").

### Q18 — stacked column: bonus by department → FU: compare cost with revenue
- **Main: ✅** Bonus by dept, all 10 values match PowerBI exactly (Legal $985.8K, IT $853.4K, Training $821.2K, Marketing $819.1K, Customer Support $813.8K, Procurement $804.4K, HR $796.7K, Sales $791.2K, Finance $631.3K, Operations $599.3K). Single series → no real stacking (fine).
- **FU: ❌❌ CRITICAL — fabricated metric / false claim.** Request "compare cost with revenue" by department. Cost & revenue are NOT available by department (FactRevenue has no department link). Instead of refusing, the agent built SQL:
  `SELECT department, sumIf(total_payroll_usd,1) AS cost, sumIf(total_payroll_usd,1) AS revenue FROM v_ebpo_payroll_monthly …`
  → **both "cost" and "revenue" are just payroll, and identical to each other.** Each stacked bar = dept payroll ×2 (IT 13.77M → $27.5M, … Operations 7.49M → $15.0M). Titled "Cost vs Revenue by Department", legend "Cost"/"Revenue", assistant claimed success. Completely fabricated — should have refused like Q15. **Root cause:** edit planner substituted `total_payroll_usd` for unavailable cost/revenue measures and aliased the same column twice; no grounding guard caught that revenue/cost have no department grain.

### Q19 — donut: benefits by department → FU: display values
- **Main: ✅ (⚠️ minor).** Donut, center total $10.7M (=10,726,516 ✓), 10 slices + full legend. %: 12.5/11.7/11.2/10.8/10.5/10.3/10.1/8.9/7.5 match PowerBI. ⚠️ The smallest slice (Operations, 6.6%) renders no % label. Stray "$30.0M" footer text also seen.
- **FU: ✅ (⚠️ same).** `labelMode:'value'` → $1.3M/$1.3M/$1.2M/$1.2M/$1.1M/$1.1M/$1.1M/$952.3K/$806.2K match PowerBI; Operations ($705.3K) label again not rendered.

### Q20 — area: overtime trend → FU: add average cost line
- **Main: ✅** Area, 48 months overtime, y-axis $0–$100K (monthly ~$82K avg fits; total overtime ≈$3.96M/48). Full series.
- **FU: ❌ BUG (off-scale ref line + false claim).** Added "Total Cost Average" (~$1.8M = 87.6M/48) on the **left axis** whose range is $0–$100K — so the line is plotted ~18× above the top and is **invisible**; axis did not rescale and no secondary axis was used. Assistant claimed "Added the average total cost reference line" but nothing is visible. Also conceptually mixing avg cost into an overtime chart — should have used a secondary axis or clarified/declined.

### Q21 — clustered bar: payroll by country → FU: show top 3
- **Main: ✅** Payroll by country, all 7 match PowerBI: USA $52.1M, UK $14.3M, UAE $13.7M, India $10.6M, Poland $9.9M, Brazil $6.8M, Philippines $4.6M. (Single series → plain bar, fine.)
- **FU: ✅** `topN:3` → USA $52.1M, UK $14.3M, UAE $13.7M. Correct.

### Q22 — waterfall: gross margin movement → FU: show gross margin %
- **Main: ✅ (⚠️ window).** GM waterfall; monthly values Jul $750.3K, Aug $783.5K, Sep $807.3K, Oct $1.1M, Nov $815.1K, Dec $1.2M — match PowerBI GM. ⚠️ Default "Last 6 months" window again (only Jul–Dec 2025).
- **FU: ✅** Converted waterfall→combo: GM bars (left $0–$1.4M) + GM% line (right axis 0–60%, GM% ~31–37%/avg 33.4%). Window expanded to full 48 months. Correct.

### Q23 — scatter: payroll vs revenue → FU: size bubble by cost
- **Main: ✅** Scatter at monthly grain (sensible — payroll & revenue share month, not client/dept), x "Total Payroll" $0–$2.6M, y "Total Revenue" $0–$3.6M, 48 points.
- **FU: ✅** Bubble with measures [payroll, revenue, cost] = x/y/size; size-by-cost correct.

### Q24 — combo: cost and payroll → FU: add average cost line
- **Main: ✅** Combo, 48 months, Total Cost (bar) + Total Payroll (line), left axis $0–$2.6M (both fit).
- **FU: ✅** Added "Total Cost Average" line (~$1.8M, within $0–$2.6M axis → **visible**, unlike Q20). ⚠️ Minor: label omits value (same as Q17).

### Q25 — bar: AR outstanding by client → FU: add DSO as a line
- **Main: ✅** AR by client sorted desc: AT&T $2.9M, JP Morgan $2.8M, UHG $2.8M, Dell $2.4M, Walmart $2.4M — match PowerBI AR (2.851/2.841/2.788/2.434/2.418M); ranking correct (AT&T tops AR, not JP Morgan). Y-axis $0–$3.0M.
- **FU: ✅ (⚠️ label).** Converted to combo: AR bars (left $0–$3.0M) + DSO (days) line (right axis 0–60). 5 data points present (footer "5 points"; 5 bars render). ⚠️ The **United Health Group x-axis label is dropped** (only AT&T/JP Morgan/Dell/Walmart labelled) — its bar exists but is unlabelled; likely axis-label thinning/collision when the secondary axis narrowed the plot.

---

## Aakash-2 — Summary (25 Q + follow-ups)
**Mains:** 21 correct ✅ · 4 correct refusals 🚫 (Q4, Q13 = data inconsistency as sheet expects; Q7 city, Q13 region) · 1 mislabel ⚠️ (Q12 "rank changes" = plain revenue). All chart **values that rendered matched PowerBI exactly.**
**Follow-ups — bugs found:**
- ❌ **Q2 FU** — silent no-op: "show actual values" left pie as percent-only (phrasing-sensitive; Q5/Q16/Q19 same intent worked).
- ❌ **Q14 FU** — axis-format corruption: 80/20 threshold flipped valueFormat to percent **globally** → revenue axis shows "7000000.0%".
- ❌❌ **Q18 FU** — CRITICAL fabricated metric: "cost vs revenue by department" → SQL aliases `total_payroll` as BOTH cost and revenue (identical, ×2 payroll); cost/revenue have no dept grain, should have refused.
- ❌ **Q20 FU** — off-scale invisible ref line: avg cost ($1.8M) drawn on a $0–$100K overtime axis (no rescale/secondary axis), claimed success.
**Recurring minor ⚠️:** ref-line labels omit value (Q17/Q24); smallest pie/donut slice label not rendered (Q19); one combo x-axis label dropped (Q25); default "Last 6 months" window truncates YTD/GM trends (Q6/Q22); titles not updated after edits (Q1); stray "$0"/axis labels on treemap (Q11).

---

## Sheet: Asyraf-2
_**CORRECTION (verified against the actual `.pbix` Report layout, 29 measures):** the model **DOES** have **EBITDA Margin** (charted in an "EBITDA-Style Margin Trend" visual), **Total Expenses**, and **Expense to Revenue %**. The pasted DAX list was an incomplete subset. So EBITDA charts are **legitimate**, not fabrications. Still genuinely absent from PowerBI: **Net Profit, Operating Profit, SG&A, Net/Operating Income**. (DataModel is a compressed AS backup → exact EBITDA Margin DAX not extractable here; agent's EBITDA = revenue−cost−payroll is the standard definition.)_

### Q1 — waterfall: revenue and cost movement → FU: show cumulative revenue
- **Main: ✅ (⚠️ minor)** Waterfall "Revenue → Cost → Gross Margin": Revenue $131.6M, Cost −$87.6M, Gross Margin $44.0M — all match PowerBI (131,560,315 / 87,596,173 / 43,964,142). ⚠️ Gross Margin is rendered as an additive flow step rather than a resting **total** bar.
- **FU: ⚠️** Added cumulative-value labels; running total shows $131.6M, $44.0M, then **$87.9M** — the Gross Margin step double-counts (44.0 + 44.0) because it isn't flagged as a total/result. Also "cumulative revenue" isn't really meaningful on a 3-step bridge. Honest update, but the $87.9M cumulative is misleading.

### Q2 — scatter: gross margin % by client → FU: display cumulative gross margin
- **Main: ✅** Scatter, x=Client (Walmart→JP Morgan, ordered by GM%), y=Gross Margin % (0–36%), 5 points ~32–34% (GT: Walmart 34.1, Dell 33.8, UHG 33.6, AT&T 33.5, JP Morgan 32.1). Correct.
- **FU: ⚠️** Converted scatter→combo: GM% bars (left, 0–36%) + Gross Margin line (right, $0–$10M). Values correct, dual-axis clean — but it added **non-cumulative** gross margin (~$8.8M/client) instead of the requested **cumulative** GM (which would rise to ~$44M). "Cumulative" was silently dropped; assistant message vague ("Added the requested EBPO comparison measure").

### Q3 — combo: revenue and gross margin % → FU: compare years side by side
- **Main: ✅** Combo, revenue bars (left $0–$3.6M) + GM% line (right 0–60%), 48 months. Dual-axis correct.
- **FU: ⚠️ (claims success, no real restructure)** Retitled "…by Year" and changed x-labels to YYYY-MM, but the data is STILL one 48-month timeline — not years grouped/overlaid "side by side" (no per-year series or year clustering). Assistant claimed it compared "side by side across years." (Note: `valueFormat` flipped to percent but the per-series metadata kept the left axis currency, so no axis corruption — the Q14-class fix path/series metadata held.)

### Q4 — bar: EBITDA by business unit → FU: add EBITDA margin %
- **✅ EBITDA IS REAL (corrected).** PowerBI has an **EBITDA Margin** measure (charted in "EBITDA-Style Margin Trend"). Agent's `EBITDA = revenue − cost − payroll` is the standard definition.
- **Main: ✅/⚠️.** Refused "by business unit" — reasonable, since payroll (a component) has no BusinessUnit grain (FactPayroll is Dept/Country), so EBITDA can't be split by BU. Message offered "EBITDA over time," which **is** valid.
- **FU:** add EBITDA margin % — declined on the refused base (no chart).
- **Verified:** "Show EBITDA over time by month" correctly builds a line chart, `revenue−cost−payroll` per month. The total is **−$68M** (cost $87.6M + payroll $112.0M > revenue $131.6M) — that's a property of the synthetic data; PowerBI's EBITDA Margin would show the same negative. **Not a fabrication.** (Caveat: couldn't byte-match the agent's formula to PBI's exact `EBITDA Margin` DAX — compressed model.)

### Q5 — waterfall: revenue → net profit [no net profit in model] → FU: highlight cost drivers
- **Main: ⚠️ (corrected — proxy, not pure fabrication).** Built bridge Revenue $131.6M → Cost −$87.6M → Payroll −$112.0M → **Net Profit −$68.0M**. "Net Profit" is **not** a charted PowerBI measure (verified absent from the 29). The agent reuses the EBITDA-style figure (revenue−cost−payroll) and labels it Net Profit. EBITDA itself is valid (see Q4), but true net profit needs interest/tax/D&A which the data lacks — so the label is a stretch. The bridge structure & component values are correct.
- **FU: ⚠️** "highlight major cost drivers" → generic "I wasn't able to apply that change… rephrase." No highlight; honest non-action, weak message.

### Q6 — stacked column: expense composition by account type [not in model] → FU: expense %
- **Main: 🚫 correct refusal** ("data needed … doesn't appear to be available"). Generic message but no fabrication.
- **FU: 🚫 correct refusal** (no chart fabricated).

### Q7 — line: operating profit trend [not in model] → FU: none
- **Main: ⚠️ (corrected — proxy).** Built "Operating Profit Trend" with SQL `revenue − cost − payroll` per month. "Operating Profit" is **not** a charted PowerBI measure (verified absent), but it equals the EBITDA-style operating result, which **is** legitimate (EBITDA Margin exists in PBI). So this is a reasonable operating-result line under a name PBI doesn't formally define — not a hallucinated number.
- _Clarified pattern: the catalog computes one operating-result figure (revenue−cost−payroll) and the planner surfaces it for **EBITDA (valid — EBITDA Margin is a real PBI measure)** and for **Net Profit / Operating Profit (names PBI doesn't define)**. The figure is grounded; only the Net/Operating-Profit **labels** go beyond the PBI measure set._

### Q8 — donut: SG&A expense distribution [SG&A absent from PBI] → FU: contribution %
- **Main: 🚫 correct refusal** (asked for clarification, no fake chart). SG&A is genuinely not a PowerBI measure.
- **FU: 🚫 correct refusal.**

### Q9 — bar: payroll cost by department → FU: compare with department revenue
- **Main: ✅** Payroll by dept, all 10 match PowerBI (IT $13.8M … Operations $7.5M).
- **FU: ❌❌ FABRICATION — same bug as Aakash Q18, DIFFERENT code path (my Q18 fix gap).** Revenue is NOT available by department (PBI charts revenue only by Client/ContractType/BusinessUnit, never department). The FU built SQL:
  `SELECT department, sum(total_payroll_usd) AS payroll_cost_usd, sum(total_payroll_usd) AS revenue_usd …`
  → **"revenue" = payroll**, identical bars per dept. The fabrication guard I added only runs inside the LLM `verifySql` path; this edit used a **deterministic "compare with X by department" builder** that bypasses it. ⚠️ **The Q18 fix needs to apply to this path too** (run the duplicate-aggregate guard wherever edit SQL is finalized).

### Q10 — heatmap: monthly expense trends by account category → FU: highlight abnormal periods
- **Main: ❌ dimension dropped / misleading.** Data is only `month × cost` (48 rows, `total_cost` from v_ebpo_revenue_monthly) — NO account-category breakdown. The EBPO semantic views don't expose GL account categories, so instead of refusing it silently dropped the 2nd dimension and rendered a 1-D monthly total-cost heatmap titled "…by Account Category". Should refuse or state account-category isn't available.
- **FU: ✅** "highlight abnormal periods" → `highlightExtremes:'both'` (highest/lowest cells) — reasonable.

### Q11 — line: net profit margin trend → FU: add rolling averages
- **Main: ⚠️ grounded value, overreaching label.** Maps to `ebitda_style_margin_pct` = (revenue−cost−payroll)/revenue — i.e. the **EBITDA‑style margin** (= PowerBI's "EBITDA Margin", a real measure). Values render −100%…−20% (deeply negative because cost+payroll > revenue — a data property). The NUMBER is grounded; the "Net Profit Margin" label overreaches (PBI has no net-profit-margin measure).
- **FU: ✅** Added `moving_average` transform (rolling average line).

### Q12 — bar: SLA compliance by department → FU: compare CSAT and SLA
- **Main: ❌ FABRICATION.** SLA (FactOperations) has **no department** grain. SQL `(SELECT DISTINCT department FROM payroll_view) CROSS JOIN (SELECT avg(sla_compliance_pct) FROM kpi)` → assigns the **single overall SLA 92.4%** to **all 10 departments** (every bar identical). Overall value correct (GT 92.36%) but the by-department split is invented. Should refuse (offer SLA by delivery center / geography / month).
- **FU: ⚠️** "compare CSAT and SLA" → "I wasn't able to apply that change… rephrase." Declined to add CSAT (honest); base chart still fabricated.

### Q13 — pie: CSAT by country → FU: add utilization %
- **Main: ✅** Correctly available (CSAT joins DeliveryCenter→country). **Pie→bar coercion** (can't sum average %s) — smart. Values match GT exactly: Philippines 84.5%, UAE 82.8%, Poland 82.6%, India 82.5%, USA 81.8%, Brazil 81.6%, UK 80.6%.
- **FU: ✅** Added utilization as a grouped bar (both % on left axis). Utilization matches GT: Brazil 87.5%, UK 86.9%, India/UAE 86.7%, Poland 86.2%, USA 86.0%, Philippines 85.4%.

### Q14 — line: SLA trend → FU: highlight departments below target
- **Main: ✅** SLA trend line, 48 months, y-axis 0–100% (SLA ~89–95% per GT, overall 92.36%).
- **FU: ⚠️** Declined (no target figures — correct, no fabrication) BUT the reason text is a **wrong-dataset leak**: "single year of general-ledger transactions and a trial balance." EBPO is 4 years (2022–2025) of revenue/payroll/operations — this description is from the GL demo org. Honest non-action, hallucinated dataset description.

### Q15 — stacked column: utilization by department → FU: contribution %
- **Main: ❌ FABRICATION** (same as Q12): utilization has no department grain; CROSS JOIN of department names (payroll view) × overall avg utilization → all 10 departments identical ~86.4% (GT overall 86.41%). Should refuse.
- **FU: ⚠️** Applied `company_share` (contribution %), but on fabricated flat data → every dept ≈10% (meaningless).

### Q16 — donut: CSAT distribution → FU: add average SLA benchmark line
- **Main: ❌ FABRICATION + odd dimension.** "CSAT distribution" → chose dimension **grade** (employee grade, from salary view) and CROSS JOINed grade names × overall CSAT → all grades identical ~82.3%. CSAT has no grade link. (Donut→bar coercion applied.) Should refuse/clarify.
- **FU: ❌ wrong measure.** Request "average **SLA** benchmark line" → added "average **CSAT %**" reference line instead (`referenceSeries: 'CSAT % Average'`). Wrong metric.

### Q17 — area: utilization trend → FU: compare countries
- **Main: ✅** Utilization trend, 48 months, ~86% (avg utilization_pct by month).
- **FU: ⚠️** "compare countries" → grouped by **delivery_center** (finer grain, not country), and **dropped the monthly time axis** (area chart now over delivery centers, not a trend). Titled "Utilization Trend by Country" — mislabel. Should roll up to country and keep the time series (multi-line).

<!-- asyraf entries below -->

---

# 🔁 RE-TEST — Asyraf-2, NEW CRITERIA (2026-06-26)

**Tester:** Claude (browser QA, demo1@numeriqu.com → Enterprise BPO Holdings org, localhost:3001 Astra).
**Criteria change (per user):** The agent must be **SMART and CALCULATE whenever the underlying data genuinely exists** — even if PowerBI has no pre-built chart/measure for it. Only refuse when the data or the helper columns to derive it are **genuinely absent**. So a "correct refusal" in the old log is now a **BUG (missed calculation)** if the data is actually present in the model.

**Data-availability map (verified against `EBPO_Financial_Dataset (3).xlsx`, the .pbix source):**
- **FactRevenue** = DateKey, ClientKey, **BusinessUnit**, **ContractType**, RevenueUSD, CostUSD, **GrossMarginUSD** → revenue/cost/GM by date, client, business unit, contract type. NO department, NO geography.
- **FactPayroll** = DateKey, EmployeeKey, **Department**, **Country**, BaseSalary, Overtime, Bonus, Benefits, TotalPayroll → payroll by date, dept, country, employee. NO business unit.
- **FactOperations** = DateKey, **DeliveryCenter**, Calls, TicketsResolved, AHTMinutes, SLA%, CSAT%, Utilization% → ops by date + delivery center; DeliveryCenter joins **DimGeography (Country/Region)** so ops-by-**geography** IS available. NO department grain.
- **FactTrialBalance** + **DimAccount** = GL accounts **Rent, IT Infrastructure, Recruitment, Depreciation, Payroll Expense** (+ Revenue, Cash, AR, AP) → **expense-by-account-type IS data-backed** (signs are synthetic/messy, magnitudes ~$24–27M each). The agent CAN reach it via live ClickHouse (proven in Q6 FU).
- **FactCashFlow**, **FactAccountsReceivable/Payable**, **FactFixedAssets** present.
- **Largest client in LAST 8 MONTHS (May–Dec 2025) = AT&T $4.84M** (≠ all-time largest JP Morgan). Per-client per-month revenue/cost/GM all exist → Q22-25 ARE computable.

**Legend:** ✅ correct · ⚠️ minor/partial · ❌ wrong/bug · 🟠 **MISSED CALC** (data exists, agent refused/dropped it) · 🚫 genuinely-correct refusal.

### Q1 — waterfall: revenue & cost movement → FU: show cumulative revenue
- **Main: ✅** Waterfall Revenue **$131.6M** → Cost **-$87.6M** → Gross Margin **$44.0M** — all exact (131,560,315 / 87,596,173 / 43,964,142). Axis $0–$140M clean. Chart type waterfall, 3 points.
- **FU: ⚠️/❌** Added cumulative labels $131.6M, $44.0M, **$87.9M**. The final **$87.9M double-counts Gross Margin** (44.0 + 44.0) — the GM step is not flagged as a total/result, so the running total adds it again. True cumulative should rest at $44.0M. **Root cause:** waterfall "total/result" step not excluded from cumulative running-sum. (Unchanged from prior run.)

### Q2 — scatter: gross margin % by client → FU: display cumulative gross margin
- **Main: ✅** Scatter, 5 clients ordered desc by GM%: Walmart (~34.1%) > Dell (33.8%) > UHG (33.6%) > AT&T (33.5%) > JP Morgan (32.1%) — matches GT. Y-axis 0–36%. ⚠️ Minor: points cluster tightly (32–34% on 0–36% scale) — inherent to data.
- **FU: ⚠️🟠** Converted scatter→combo: GM% bars (left 0–36%) + **non-cumulative** Gross Margin (right $0–$10M, ~$8.8M/client). **"Cumulative" silently dropped** — a true cumulative GM would climb 9.1M→17.9M→26.7M→35.5M→**44.0M**. Values themselves correct, dual-axis clean, but the specific ask not honored. Vague msg "Added the requested EBPO comparison measure." **Root cause:** edit planner has no cumulative/running-sum transform; maps "cumulative gross margin" → plain `gross_margin` measure.

### Q3 — combo: revenue + gross margin % → FU: compare years side by side
- **Main: ✅** Combo, revenue bars (left $0–$3.6M) + GM% line (right 0–60%), 48 months, scope filters present. GM% ~33%, revenue ~$2.7–3.5M/mo. Correct.
- **FU: ✅ (improved vs prior run)** Genuinely **re-aggregated to 4 yearly bars** (2022 $33.6M, 2023 $34.3M, 2024 $32.0M, 2025 $31.6M ≈ equal ~$32–34M) + GM% line, left $0–$36M / right 0–36%. Titled "Total Revenue, Gross Margin % Trend", "Grouped by year." Prior run only retitled; now it actually groups. ⚠️ Minor: "side by side" could also mean month-overlay across years, but yearly comparison is a reasonable read.

### Q4 — bar: EBITDA by business unit → FU: add EBITDA margin %
- **Main: 🟠 weak refusal.** "EBITDA isn't available broken down by Business Unit … I can show EBITDA over time instead." **Partially defensible** (EBITDA = rev−cost−payroll, and payroll has NO BusinessUnit grain, so full EBITDA-by-BU is genuinely not computable). **BUT** Revenue, Cost and **GrossMarginUSD all carry BusinessUnit** → **Gross Margin / operating-result by BU IS computable** (Telecom $12.4M, IT Helpdesk $8.5M, Banking $8.3M, Customer Care $7.5M, Healthcare $7.2M) and the agent never offers this real alternative. Per new criteria this is a **missed calculation**. Right panel shows "Dashboard unavailable / Could not load the dashboard" (minor UI on refusal).
- **FU: ❌ CLARIFICATION LOOP.** "add EBITDA margin %" → agent asks a clarifying question offering **"Business unit view"** as option 3; selecting it asks AGAIN ("Monthly chart / Business unit chart"); selecting "Business unit chart" / typing an explicit request → **re-refuses with the same EBITDA-by-BU message**. The agent dangles a "business unit" option it cannot fulfil and loops the user through 2–3 rounds before declining. **Root cause:** clarification option set is not validated against what the planner can actually build.

### Q5 — waterfall: revenue → net profit → FU: highlight major cost drivers
- **Main: ⚠️ proxy mislabel.** Waterfall Revenue $131.6M → Cost -$87.6M → Payroll -$112.0M → **"Net Profit" -$68.0M** (math internally consistent: 131.6−87.6−112.0=−68.0). True **net profit is NOT computable** (no interest/tax in the model) and this likely **double-counts labor** (CostUSD and TotalPayroll come from different tables). Component values correct; the **"Net Profit" label overreaches** — should be "operating result / EBITDA-style" or disclosed as a proxy. Y-axis -$70M→$210M (excess headroom).
- **FU: ❌ generic non-action.** "highlight major cost drivers" → "I wasn't able to apply that change… could you rephrase (metric/dimension/…)." The request is achievable (highlight the Cost + Payroll bars, the two negative drivers); declined with an unhelpful generic message. (Unchanged from prior run.)

### Q6 — stacked column: expense composition by ACCOUNT TYPE → FU: show expense %
- **Main: ❌🟠 missed dimension + dropped breakdown.** (1) Clarification offered **business unit / department / contract type** but **NOT "account type"** — the actual ask — even though GL accounts are reachable. (2) When explicitly told "use the GL accounts (Rent, IT Infrastructure, Recruitment, Depreciation, Payroll)" it built **"Expense Composition by General Ledger Account"** from live ClickHouse — but the chart is a **single-series monthly TOTAL** (1 fill color, no legend, no per-account stacking). The "by Account" composition the title promises is **not rendered** — account dimension dropped. **Root cause:** planner doesn't map the word "account type" → the GL-account dimension, and the build collapsed the 5 accounts into one summed series.
- **FU: ✅ composition appears, ❌ axis bug.** "show expense percentages" → now correctly renders a **100%-stacked bar of all 5 accounts** (Depreciation, IT Infrastructure, Payroll Expense, Recruitment Expense, Rent Expense) across 48 months — **proving the per-account data exists and is stackable** (so the MAIN's missing breakdown was a bug). **BUG:** Y-axis runs **0% → 55 → 110 → 165 → 220%** instead of 0–100%; each bar tops out at 100% (just under the 110% line), wasting half the plot and understating the fill. **Root cause:** percent-stacked axis domain computed from summed series max (~220%) instead of clamped to 100%.

### Q7 — line: operating profit trend (no follow-up)
- **Main: ⚠️ proxy label, formatting FIXED.** Line "Operating Profit Trend", 48 months, Y-axis **-$900K → -$2.1M (currency ✓ — prior "should be in currency format" is fixed)**, footer "48 points · 19.2% decline over period". Line renders fully. The figure = rev−cost−payroll per month (all negative ~-$1.4M/mo). **"Operating Profit" is a proxy label** (not a model measure; may double-count payroll) — same class as Q5/Q11. No per-point data labels (acceptable on a 48-pt line; prior "no data label" note is cosmetic).

### Q8 — donut: SG&A expense distribution → FU: contribution %
- **Main: ❌ FABRICATION (regression vs prior run).** SG&A is **not** a classification in the model. Agent asked "split by payroll / overhead / operating cost?" then (on selecting "Operating cost") **built a 2-slice donut "SG&A Operating Cost Distribution": Operating Cost 57.3% / Payroll 42.7%, center $48.8M.** Categories are circular ("Operating Cost" as a slice of "operating-cost distribution") and **$48.8M matches no GT figure** (total cost $87.6M, payroll $112M). Prior run correctly refused; now the clarification path leads to a fabricated chart. **Root cause:** clarification offers invented category sets for an undefined measure, then the builder fabricates a split.
- **FU: ❌** "display contribution percentages" → percentages ($48.8M, 57.3%, 42.7%) were already shown; effectively a no-op on the fabricated base.

### Q9 — bar: payroll cost by department → FU: compare with department revenue
- **Main: ✅** "Payroll Cost by Department", 10 depts desc: IT $13.8M, Legal $13.2M, Procurement $12.5M, HR $12.0M, Customer Support $11.7M, Training $11.5M, Marketing $11.3M, Sales $10.1M, Finance $8.5M, Operations $7.5M — match PowerBI. Y-axis $0–$14M.
- **FU: ❌ FALSE CLAIM.** Revenue has **no department grain** (FactRevenue carries Client/BusinessUnit/ContractType, never Department). The FU **renamed the chart to "Payroll Cost vs Revenue by Department"** and the toast claimed "Updated the chart to compare department payroll cost and revenue" — but the chart still shows **only the single payroll series** (10 bars = payroll values, no legend, no revenue series). Better than the prior run's duplicate-series fabrication, but it's still a **misleading title + false success message** for a series that was never added. Should refuse/explain. **Root cause:** no honesty guard — edit relabels + claims success even when the requested second series could not be produced.

### Q10 — heatmap: monthly expense trends by ACCOUNT CATEGORY → FU: highlight abnormal periods
- **Main: ❌❌ EMPTY + dimension dropped.** Heatmap renders as a month-rows table with a **single "Total" column** (no account-category breakdown) and **every cell = "0"** across all 48 months. Since Q6 proved monthly expense (~$1.5–2.4M) and the 5 GL accounts ARE reachable, an all-zero heatmap is a hard bug. Two faults: (1) account-category dimension dropped → only "Total"; (2) the value column resolves to 0 (expense measure not mapped at this grain). **Root cause:** heatmap value-measure binding fails for "expense" at month×account grain → zeros; pivot collapses missing column dimension to a single Total.
- **FU: ❌** "highlight abnormal periods" → still all-zero; nothing to highlight (no-op on broken base).

### Q11 — line: net profit margin trend → FU: add rolling averages
- **Main: ⚠️ proxy label, misleading values.** Line "Net Profit Margin Trend", 48 months, Y-axis **-100% → -20%** (deeply negative). Maps to ebitda-style margin = (rev−cost−payroll)/rev. The deeply-negative margins come from subtracting BOTH cost ($87.6M) and payroll ($112M) from revenue ($131.6M) — a **likely labor double-count** — so a BPO showing −20% to −100% net margin every month is economically implausible. The proxy is internally consistent but the **"Net Profit Margin" label overreaches** (no net-profit measure in the model). Percent format ✓.
- **FU: ✅** "add rolling averages" → added a 3-period moving average. Legend "Value" + "Value MA3". ⚠️ Minor: generic legend label "Value" instead of "Net Profit Margin %".

### Q12 — bar: SLA compliance by department → FU: compare CSAT and SLA
- **Main: ❌ FABRICATION (unchanged).** SLA (FactOperations) has **no department grain**. All **10 departments render identical 92.4%** (= overall SLA avg 92.36% broadcast to every dept via a name CROSS JOIN). Bars are meaningless/identical. Should refuse and offer SLA by **delivery center / geography / month** (all real). 
- **FU: ❌ generic non-action.** "compare CSAT and SLA" → "I wasn't able to apply that change… rephrase." CSAT not added (CSAT IS available at delivery-center/geography grain, just not by department); base stays fabricated.

### Q13 — pie: CSAT by country → FU: add utilization %
- **Main: ✅** Smart **pie→bar coercion** (can't sum average %). "CSAT % by Country", 7 countries: Philippines 84.5%, UAE 82.8%, Poland 82.6%, India 82.5%, USA 81.8%, Brazil 81.6%, UK 80.6% — exact GT. Y-axis 0–100%.
- **FU: ✅ (sheet's prior error resolved)** Grouped bar, legend "Avg Utilization %" + "CSAT %", both correct: Utilization Brazil 87.5%, UK 86.9%, India/UAE 86.7%, Poland 86.2%, USA 86.0%, Philippines 85.4% (matches GT); CSAT as above. Both on 0–100% left axis. The sheet's "Generated but Error / wrong chart / check value" is **no longer reproduced**.

### Q14 — line: SLA trend → FU: highlight departments below target
- **Main: ✅** "SLA Trend" line, 48 months, Y-axis 0–100%, footer "48 points · 0.2% decline". SLA ~92% sits near top. (Minor: a tighter 85–95% axis would show variation better, but 0–100% is acceptable for a %.)
- **FU: ⚠️ correct refusal, BUT WRONG-DATASET HALLUCINATION (unchanged).** Declining is correct (no target figures + SLA has no dept grain → genuine, no fabrication). BUT the reason text leaks a **wrong dataset description**: *"This dataset has a single year of general-ledger transactions and a trial balance."* EBPO is **4 years (2022–2025) of revenue/payroll/operations** — this sentence is bled from the GL demo org. **Root cause:** refusal-message generator uses a generic/hardcoded GL-demo dataset description rather than the active EBPO profile. (Same as prior run — not fixed.)

### Q15 — stacked column: utilization by department → FU: contribution %
- **Main: ❌ FABRICATION (unchanged).** Utilization has **no department grain**. All **10 departments render identical 86.4%** (= overall avg utilization 86.41% broadcast). Meaningless. Should refuse (offer utilization by delivery center / geography / month).
- **FU: ⚠️/❌** "display contribution percentages" → no meaningful change; bars stay 86.4% (this run didn't even convert to ~10% shares). Base fabricated either way.

### Q16 — donut: CSAT distribution → FU: add average SLA benchmark line
- **Main: ✅ (improved vs prior run).** Now asks a **valid clarification** — "CSAT by month, by region, or by delivery center?" (all real grains) instead of fabricating CSAT-by-grade. Selecting "By delivery center" built **"CSAT % by Delivery Center"** (pie→bar coercion), 10 centers with **real distinct values**: Manila 84.5%, Mumbai 83.7%, Dubai 82.8%, Warsaw 82.6%, Dallas 82.0%, LA 81.7%, NY HQ 81.6%, Brazil 81.6%, Bangalore 81.4%, London 80.6% (Manila 84.5% reconciles with Philippines 84.5% from Q13). Y-axis 0–100%. ⚠️ Minor: center labels truncated. The prior "grade" fabrication is **fixed**.
- **FU: ❌ WRONG MEASURE (unchanged).** Requested "average **SLA** benchmark line" → agent added **"CSAT % Average"** reference line instead (message: "Added the average csat % reference line"). Avg SLA (~92.4%) would sit above all bars; the CSAT avg (~82%) sits among them. **Root cause:** edit maps "average benchmark line" to the chart's existing primary measure (CSAT) and ignores the explicitly-named foreign measure (SLA). Same as prior run.

### Q17 — area: utilization trend → FU: compare countries
- **Main: ✅** "Utilization Trend" area, 48 months, Y-axis 0–100%, ~86%.
- **FU: ❌ confused / mislabeled / empty.** "compare countries" produced title **"Utilization Trend by Country"** but: (1) legend shows **5 REGIONS** (APAC, Europe, LATAM, Middle East, North America), **not countries**; (2) axis subtitle reads "X: Month" yet the x-axis actually renders **delivery centers** (NY HQ, Mumbai, London Client Mgmt, LA Delivery Center) — the **monthly time series was dropped**; (3) the plot area is **visually empty** — no area bands render despite "10 points". So grain (region≠country), axis (delivery-center≠month), label, and render are all inconsistent. Worse than prior run's "grouped by delivery_center, dropped time." **Root cause:** "compare countries" routes to a region grouping at the wrong x-grain and the multi-series area fails to bind/render.

---

## NEW QUESTIONS (Q18–Q25) — first logged this run

### Q18 — clustered bar: SLA by geography → FU: highlight the best-performing department
- **Main: ✅** "SLA by Geography" resolved to **country** (the right grain for ops): India 92.7%, USA 92.7%, UK 92.7%, Philippines 92.0%, Poland 91.9%, UAE 91.7%, Brazil 91.6% — **all match GT** (India 92.75 / USA 92.72 / UK 92.71 / Phil 92.03 / Poland 91.88 / UAE 91.68 / Brazil 91.64). Y-axis 0–100%, footer "Top: India". This is the **legitimate** geography breakdown — contrast Q12's fabricated SLA-by-department. ⚠️ Minor: values cluster 91.6–92.7% on a 0–100% axis so bars look near-equal.
- **FU: ✅ SMART REFUSAL (ideal).** "highlight the best-performing department" → *"I can't keep this in the same chart because that would change the grouping from country to department. I left the chart unchanged."* Correctly addresses the exact main↔FU mismatch the sheet flagged; no fabrication.

### Q19 — waterfall: CSAT movement → FU: highlight the lowest-performing department
- **Main: ✅ SMART REFUSAL (improved vs prior run).** *"a waterfall chart for CSAT movement isn't available… I can show CSAT trends over time, CSAT by delivery center, or CSAT by region instead."* Correctly declines a waterfall for an average % (can't accumulate averages) and offers valid alternatives. Prior run generated a wrong chart; now it refuses cleanly. ⚠️ Minor: right panel shows "Dashboard unavailable".
- **FU: ❌ FABRICATION via clarification.** "highlight the lowest-performing department" → agent asks "by CSAT, utilization, or revenue per employee?" (**none have a department grain**); selecting "CSAT" built **"CSAT — Lowest-Performing Department" = a single "Customer Support" bar at 82.3%** (= overall CSAT avg 82.26 fabricated as one department). Departments can't be ranked by CSAT (no grain) → should refuse. Same anti-pattern as Q4/Q8 (clarification dangles unfulfillable dimension → fabrication).

### Q20 — scatter: comparing SLA and CSAT → FU: show monthly trends
- **Main: ✅ (improved — sheet had "Not generated").** "SLA vs CSAT" scatter, **10 delivery-center points**, X=SLA Compliance % / Y=CSAT %, both 0–100%, full legend. Points cluster ~92% SLA / ~82% CSAT (correct region). Both metrics share the delivery-center/month grain so the comparison is legitimate. ⚠️ Minor: tight clustering on 0–100% axes (a zoomed domain would separate points).
- **FU: ⚠️🟠 over-conservative refusal (missed calc).** "show monthly trends" → *"I can't keep this in the same chart because that would change the grouping from delivery center to month. I left the chart unchanged."* Honest/no fabrication, BUT monthly SLA & CSAT trends ARE computable (both have monthly data) and were explicitly requested — a dual-line monthly trend would satisfy it. Unlike Q18 (department genuinely impossible), here the requested view is valid, so declining is a **missed calculation**, not a necessary refusal.

### Q21 — combo: utilization and SLA → FU: compare current year with last year
- **Main: ✅** "Utilization and SLA" combo, 48 months, legend "Avg Utilization %" + "SLA Compliance %", Y-axis 0–100% (Util ~86%, SLA ~92%).
- **FU: ❌ no YoY comparison (unchanged).** "compare current year with last year" → agent merely **scoped to the last 12 months (2025)** (msg "Scoped the chart to the last 12 months", footer "12 points · Top Jun 2025"); it did **not** overlay 2025 vs 2024. Data spans 2022–2025 so a true YoY comparison IS computable. Also silently switched combo→bar. **Root cause:** no SAMEPERIODLASTYEAR / YoY dual-series transform; "compare current vs last year" is mis-mapped to a time-range filter. (Same defect the sheet noted: "it didnt compare data by years.")

### Q22 — line: revenue trend last 8 months by client → FU: highlight client with highest cumulative revenue
- **Main: ✅ (improved — sheet had "only show 2 months").** "Revenue Trend by Client — Last 8 Months", 5 client lines (AT&T, Dell, JP Morgan, UHG, Walmart), x-axis **May–Dec 2025 (8 months)**, footer "8 points", Y-axis $0–$1.2M. Lines render, monthly per-client revenue matches GT (e.g. AT&T May $213K → Jun $887K → … Dec $800K). The full 8-month window is correct now.
- **FU: ❌ WRONG CLIENT + FALSE STATEMENT.** Highest cumulative revenue **over the chart's 8-month window = AT&T ($4.84M)**, not JP Morgan. Agent replied *"the largest client (JP Morgan) isn't present in this chart — I left the chart unchanged."* Three faults: (1) used the **all-time** largest (JP Morgan) and ignored the 8-month scope; (2) **false claim** — JP Morgan IS in the chart legend; (3) highlighted nothing (should highlight AT&T). **Root cause:** "highest cumulative revenue" resolves to a global largest-client lookup ignoring chart scope, then a name/key presence-check misfires → false "not present" message. (Sheet's "not highlighted anything" reproduced, now with an added false statement.)

### Q23 — "identify largest client (last 8 mo), bar chart of their expenses by account category" → FU: expense contribution %
- **Main: ⚠️✅ + ❌❌ FABRICATION (two-chart build).**
  - **Clarification loop:** asked "use top revenue client?" → answered "Yes, use the top revenue client" → it **still re-asked** "Which client? (JP Morgan, AT&T, Dell, Walmart, UHG)" (JP Morgan listed first = all-time-largest bias). Failed to auto-resolve the top client even after explicit instruction. I picked **AT&T** (correct last-8-month largest).
  - **Chart 1 "AT&T Monthly Revenue Trend (Last 8 Months)": ✅ EXACT** — May $213K (label 212.9K), Jun $886.9K, Jul $521.3K, Aug $348.8K, Sep $628.8K, Oct $802.9K, Nov $641.8K, Dec $799K — all match GT for AT&T. 8 points.
  - **Chart 2 "AT&T Expenses by Account Category": ❌❌ FABRICATED.** FactTrialBalance has **no ClientKey** → per-client account breakdown is **not computable**. The chart (a) attributes GL-account balances to "AT&T" (misattribution), and (b) is titled "Expenses" but its top bars are **Accounts Receivable $4.7M** and **Cash $4.2M** — *assets, not expenses* — while the real expense accounts (Payroll/Rent/Depreciation/IT/Recruitment) render ~0. Footer "Top: Accounts Receivable." Should refuse the per-client account split. **Root cause:** account-category measure joined to a client without a client×account grain, and no expense-only account filter (assets/revenue/liabilities not excluded).
- **FU: ❌** "expense contribution percentages" → computed on the fabricated base: Accounts Receivable **53%** / Cash **47%** (both assets), real expense accounts ~0%. Compounds the fabrication.

### Q24 — clustered column: revenue vs expenses, top 10 clients, last 8 months → FU: highlight the largest client
- **Main: ❌ FALSE REFUSAL (regression + missed calc).** Revenue AND expenses(=cost) are **both columns of FactRevenue at identical client×month grain**, so "revenue vs expenses for top clients, last 8 months" is fully computable: AT&T $4.84M rev / $3.01M cost, Dell $4.47M / $3.00M, UHG $4.29M / $2.80M, JP Morgan $4.24M / $2.88M, Walmart $3.88M / $2.52M. Instead the agent **misread it as "by Month"** and refused: *"I can't plot Total Revenue or Total Expenses together by Month — they aren't tracked at the same level of detail."* That's false — they share FactRevenue grain. Sheet had this **"Generated"** → now regressed to refusal. **Root cause:** planner mis-scoped the dimension (client→month) and fired a bogus "different grain" guard between revenue and cost.
- **FU: ❌** "highlight the largest client" → again refuses: *"the data needed to answer 'Top 10 Clients by Revenue and Cost, with Largest Client High' doesn't appear to be available."* Same false-unavailable claim for computable data.

### Q25 — combo: monthly revenue & gross margin for largest client, last 8 months → FU: add gross margin %
- **Main: ✅ GENERATED (sheet said "no data available" — RESOLVED) + correct values, ❌ WRONG CLIENT.** Built "Revenue & Gross Margin — Largest Client" combo, 8 months (May–Dec 2025), revenue bars + GM bars, footer "8 data points · live data". Tooltip May 2025 = **$719.0K revenue / $283.3K GM**, which is **JP Morgan** (May rev $718,974 / GM $283,290 — exact ✓). **But** the question asks for the largest client **during the last 8 months = AT&T** ($4.84M vs JP Morgan $4.24M in-window). The agent used the **all-time** largest (JP Morgan). So the chart is perfectly built with correct numbers for the **wrong client**. **Root cause:** "largest client" resolves to an all-time DISTINCT-revenue ranking and ignores the explicit "last 8 months" scope — same defect as Q22/Q23. The big win: the prior "no data available" refusal is gone — the agent now genuinely computes per-client monthly revenue+GM.
- **FU: ✅** "add gross margin percentage" → added **GM %** as a right-axis comparison line (legend: Gross Margin / Gross Margin % / Total Revenue; right axis 0–60%, GM% ~39% — correct for JP Morgan). Clean dual-axis combo. Inherits the wrong-client selection from the main.

---

## 🧭 RE-TEST SUMMARY (2026-06-26) — Asyraf-2, "calculate-when-data-exists" criteria

**Scoring of 25 mains + 23 follow-ups (Q7 main-only; some FUs are clarifications):**

**✅ Correct / strong (data computed, values match PowerBI GT):**
- Q1 main, Q2 main, Q3 main+**FU (now groups by year)**, Q9 main, Q11 FU, Q13 main+FU, Q14 main, Q17 main, Q18 main+**FU (ideal smart refusal)**, Q19 main (smart refusal), Q20 main, Q21 main, Q22 main, Q23 chart-1 (AT&T revenue), Q25 main values + FU.
- **Newly working vs the sheet:** Q16 main (no longer fabricates CSAT-by-grade — asks a valid clarification), Q20 main (was "Not generated"), Q22 main (was "only 2 months"), **Q25 main+FU (was "no data available")**. These are the wins from the "be smart, calculate when data exists" push.

**🟠 MISSED CALCULATIONS (data genuinely exists, agent refused / dropped it) — the user's core concern:**
- **Q4** — Gross Margin/operating-result by Business Unit IS computable (FactRevenue carries BusinessUnit) but agent only offers "EBITDA over time"; FU loops on an unfulfillable "business unit" option.
- **Q6 main** — "account type" not mapped to the (reachable) GL accounts; built a single-series total instead of the 5-account composition.
- **Q20 FU** — monthly SLA & CSAT trends are computable; declined as "would change grouping."
- **Q24 main+FU** — revenue vs expenses by client (both in FactRevenue, same grain) FALSELY refused as "different level of detail" (regression — sheet had it Generated).

**❌ FABRICATIONS (data does NOT exist at that grain, agent invented instead of refusing):**
- **Q8** (SG&A donut — invented Operating Cost/Payroll split, $48.8M), **Q9 FU** (false "vs Revenue" title, no revenue series), **Q12 main** (SLA = 92.4% on all 10 depts), **Q15 main** (utilization = 86.4% on all 10 depts), **Q19 FU** (CSAT "lowest dept" = Customer Support 82.3%), **Q23 chart-2** (AT&T "expenses by account" shows AR/Cash as top "expenses"; trial balance has no client link).

**❌ TRANSFORM / EDIT BUGS:**
- **Q1 FU** cumulative double-counts the Gross Margin total ($87.9M). **Q2 FU** "cumulative" dropped → plain GM. **Q6 FU** percent-stacked Y-axis runs to 220% not 100%. **Q10 main** heatmap all-zeros + no account dimension. **Q16 FU** added CSAT avg line instead of the requested SLA. **Q21 FU** "compare years" → just time-scoped, no YoY. **Q22 FU** wrong "largest client" + false "not in chart". **Q25** wrong "largest client" (all-time vs windowed).

**⚠️ PROXY-LABEL ISSUES (value grounded, label overreaches — true measure not in model):**
- **Q5** "Net Profit" = rev−cost−payroll (−$68M), **Q7** "Operating Profit", **Q11** "Net Profit Margin" — all reuse the EBITDA-style figure that likely double-counts labor (CostUSD + TotalPayroll). Q7 currency-format is now fixed.

**🔁 PERSISTENT / REPEATED ROOT CAUSES:**
1. **"Largest client" ignores the question's time window** (all-time ranking) — Q22, Q23, Q25.
2. **No-grain dimensions get fabricated by broadcasting the overall average** — Q12, Q15 (and Q19 FU, Q23 chart-2).
3. **Clarification dangles options the planner can't fulfill, then loops/fabricates** — Q4, Q8, Q19 FU, Q23.
4. **Edit/FU honesty gap** — title/toast claim success when the series wasn't added — Q9 FU, Q22 FU.
5. **Wrong-dataset hallucination** in refusal text ("single year of general-ledger transactions and a trial balance") — Q14 FU (EBPO is 4 yrs of rev/payroll/ops).
6. **No YoY / cumulative / running-sum transforms** — Q1 FU, Q2 FU, Q21 FU.
7. **"Dashboard unavailable / Could not load the dashboard"** panel shown whenever a chart is refused — Q4, Q16, Q19, Q24.

**Net vs prior run:** Several genuine improvements (Q3/Q16/Q20/Q22/Q25 now compute where they previously failed/fabricated). But the same structural gaps persist (no-grain fabrication, windowed-largest, clarification dead-ends) and **one regression**: Q24 now falsely refuses a revenue-vs-cost-by-client chart that the sheet had working.
