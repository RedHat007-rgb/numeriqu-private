# EBPO Chart QA — Visual + PowerBI-Parity Bug Log

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
_Note: model has NO EBITDA / operating profit / net profit / SG&A / expense-by-account-type measures (per DAX ground truth). Those questions should refuse._

<!-- asyraf entries below -->
