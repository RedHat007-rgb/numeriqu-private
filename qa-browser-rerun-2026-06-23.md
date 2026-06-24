# Browser QA Re-run (post-architecture-fixes) — 2026-06-23

Method: real Astra browser UI (localhost:3001), EBPO org, each question = new chat →
main → immediate follow-up in the SAME chat. Values cross-checked vs the EBPO workbook /
PowerBI DAX. Dataset facts confirmed from `EBPO_Financial_Dataset (2).xlsx`:
- `FactRevenue` has ONLY DateKey/ClientKey/BusinessUnit/ContractType (NO geography key).
  → revenue/cost/gross-margin BY country/region/city/delivery-center is genuinely
  impossible in the model (PowerBI can't do it either) → refusal is CORRECT.
- Geography exists on Payroll (Country), GL (Country), Operations (DeliveryCenter→DimGeography),
  Employee (Country), FixedAssets (DeliveryCenter). → payroll/GL/ops/headcount/assets BY
  country/region/DC MUST work.

## Aakash-2 (Q1–Q7 run so far)

| Q | Main | Follow-up | Verdict |
|---|------|-----------|---------|
| 1 | bar revenue by client | + gross margin | ✅ EXACT: JP Morgan $27.6M, AT&T $27.3M, Dell $26.1M, Walmart $25.6M, United Health $25.0M (matches workbook) |
| 2 | pie revenue by business unit | actual values | ✅ CORRECT (verified: Telecom Support genuinely leads $35.9M=27.3%; legend is alphabetical, values descending — they don't pair by DOM position; caption is right). FU correctly switched %→absolute. [my earlier "caption bug" was a misread] |
| 3 | line monthly revenue | highlight high/low | ✅ line 48mo $0–$3.6M (≈$131.6M total); FU applied high/low (markers subtle, recheck) |
| 4 | stacked col revenue by country | + last year | ✅ correct refusal (revenue has no geo — matches PowerBI) |
| 5 | donut revenue by industry | data labels | ✅ Banking 20.9%…Telecom 19.0%, total $131.6M; FU value labels correct |
| 6 | area revenue YTD trend | cumulative revenue | ❌ "No data is available for ytd" — empty (0 points). Defaulted to **Last 6 months** scope; data ends Dec 2025 but "now"=2026 → last-6-mo window is empty. RELATIVE-WINDOW NOT ANCHORED TO DATA MAX DATE. FU also empty. |
| 7 | clustered bar revenue by city | rank clients by revenue | ⚠️ main refusal correct (no city for revenue) but SUGGESTS "revenue by country/region/delivery center" which contradicts Q4 (those don't exist for total revenue). FU ✅ correct "Top Clients by Revenue" (JP Morgan $27.6M…). |

## Bugs found (Aakash-2)
1. **Relative-window not anchored to data max date** (Q6): "YTD"/"Last 6 months" → empty because
   `requestedMonthBounds` used real "now" (2026) past the data (ends Dec 2025). High impact — any
   relative-window ask. **FIXED**: `applyRequestedRangeToRows` now anchors bounds to the data's max
   date (agent.service.ts). tsc clean.
2. **Refusal suggestion inconsistency** (Q7 vs Q4, minor): suggests revenue-by-geo the model can't do.

NON-BUG (corrected): Q2 caption — Telecom Support DOES lead at 27.3%; my earlier flag was a DOM-order
misread. Lesson: legend order ≠ value order; verify against ClickHouse, not DOM text position.

REVENUE-BY-COUNTRY (your GL observation): GL DOES have Country, but the GL "Revenue" account totals
$29.6M (USA $8.7M, India $5.9M, Philippines $3.8M, Brazil $3.0M, UAE/Poland/UK ~$2.7M each) — NOT
the $131.6M of PowerBI's Total Revenue (=FactRevenue, which has no geography). Exposing GL-revenue-by-
country would mismatch every other revenue chart. DECISION NEEDED: keep refusing (matches PowerBI
Total Revenue) OR add a distinct "GL Revenue by Country" measure (won't tie to $131.6M).

## What's working (proves the architecture fixes held)
- Client grounding EXACT (JP Morgan $27.6M, not Apex/BlueOak) — the master bug stays fixed.
- Pie/donut/bar/line values match PowerBI; %↔absolute and data-label follow-ups work.
- Geography refusals for revenue are correct per the real model.

| 6 (rerun) | area revenue YTD | cumulative | ✅ FIXED — Jul–Dec 2025, YTD $18.0M→$31.6M (Dec≈full-year). Window-anchoring fix verified. |
| 8 | waterfall revenue growth by year | avg reference line | main ✅ ($33.6/34.3/32.0/31.6M = $131.6M); FU ⚠️ avg ref line not rendered on waterfall (possible gap) |
| 9 | scatter revenue vs cost by client | size bubble by cost | main ✅ (x=rev,y=cost, 5 clients); FU ⚠️ "uniform size — no size measure" (sizing by cost which is already the y-axis; type mislabeled bubble) — minor edge |

## Aakash-2 verdict (Q1–9)
Architecture is SOLID: client grounding exact (JP Morgan $27.6M), values match PowerBI, most
charts + follow-ups correct. Real bug found & FIXED: relative-window anchoring (Q6). Minor gaps:
avg-reference-line on waterfall (Q8 FU), size-by-already-plotted-measure (Q9 FU), refusal-suggestion
wording (Q7). NO wrong-client-universe failures (the master bug stays dead).

## Aakash-2 failing questions (4,6,7,13,25) — root-caused + fixed 2026-06-23

| Q | Ask | Before | Now | Root cause / fix |
|---|-----|--------|-----|------------------|
| 4 | revenue by country (+last year) | refused | ✅ FIXED, exact | FactRevenue has no geo, but `allocated_revenue` (=$131.6M, carries region/country) was unmapped. Mapped `total_revenue→allocated_revenue_usd` on v_ebpo_delivery_center_efficiency_monthly. Renders USA $39.1M, India $26.3M, Poland $13.7M, UK $13.6M, Philippines $13.4M, Brazil $12.9M, UAE $12.7M (=$131.6M) — exact. |
| 13 | revenue by region | refused | ✅ FIXED, exact | same fix. APAC $39.6M, N.America $39.1M, Europe $27.2M, LATAM $12.9M, Middle East $12.7M (=$131.6M). |
| 7 | revenue by city (+rank clients) | refused | ⚠️ correct refuse | the delivery-center view has region/country/delivery_center but NO **city** column. Refusal now correctly suggests country/delivery-center (which work). City needs a data-layer column (DimGeography.City). FU "rank clients" ✅ (JP Morgan $27.6M…). |
| 6 | revenue YTD (+cumulative) | empty "no data" | ✅ main FIXED | window anchored to wall-clock (2026) past data (Dec 2025). Now anchors to data max → YTD Jul–Dec 2025 $18.0M→$31.6M. ⚠️ FU "cumulative revenue" still shows MONTHLY values labeled cumulative — cumulative transform not applied (open). |
| 25 | AR outstanding by client (+DSO line) | FU failed (rephrase) | ✅ FIXED | main AR by client (AT&T $2.9M… =$13.3M total, matches). FU now builds proper COMBO: AR bars (left $) + DSO line (right days), dual-axis. Resolved by the dual-axis combo fix. |

### Net: 4 of 5 fixed (Q4, Q13, Q6-main, Q25). Remaining: Q6-FU cumulative transform; Q7 city (data-layer column).
### Key fix this round: revenue-by-geography now routes to allocated_revenue (ties exactly to $131.6M Total Revenue).

## Remaining to run: rest of Aakash-2, Pranjal-2, Asyraf-2, Velan-2.
