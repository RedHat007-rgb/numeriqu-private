# Browser QA Findings — 2026-06-22

## Scope

- Tested only the four subsheets shown in the image:
  - `Aakash-2`
  - `Pranjal-2`
  - `Asyraf-2`
  - `Velan-2`
- Ran the app locally in the browser:
  - Web: `http://localhost:3001`
  - API: `http://localhost:3000`
- Test method:
  - Signed into the local browser UI with the built-in demo account
  - Sent every main question and follow-up through the real Astra browser page
  - Did not use JSON harness or batch test execution against the backend directly
  - Read the resulting browser session payloads after each UI interaction
  - Cross-checked expected semantics against:
    - `/Users/basanireddy/Downloads/EBPO_Financial_Dataset (2).xlsx`
    - `/Users/basanireddy/Downloads/NEW DATASET DATA.pbix`
    - The DAX measure list provided

## Executive Summary

- All `100` questions across the four requested tabs were executed through the browser.
- The biggest issue is not a single chart bug. The biggest issue is that the agent is often not grounded to the EBPO dataset / PBIX semantic model.
- The strongest proof:
  - EBPO top revenue clients from the workbook are:
    - `JP Morgan` `27,556,449`
    - `AT&T` `27,301,868`
    - `Dell` `26,055,842`
    - `Walmart` `25,630,495`
    - `United Health Group` `25,015,661`
  - But the browser agent repeatedly asks me to choose from:
    - `BlueOak Distributors`
    - `Meridian Retail Group`
    - `Apex Ventures Ltd`
    - `TechCorp Solutions`
  - In some sessions it even assumes `Apex Ventures Ltd` is the “largest client.”
  - Those names do not match the EBPO workbook / PBIX client model used for your test set.
- Because of that mismatch, many questions fail in one of these ways:
  - asks unnecessary clarification for something the model should already know from EBPO
  - refuses a chart that should be supported by the listed DAX measures / PBIX pages
  - answers using the wrong business entity universe
  - loses the original chart context on the follow-up
  - replaces the original chart instead of updating the same chart

## PBIX / Model Cross-Check

- PBIX report pages found in the file:
  - `Overview`
  - `Revenue Trends`
  - `Cash Flow & Liquidity`
  - `AR vs AP`
  - `Payroll & Headcount Costs`
  - `Expenses`
- The PBIX layout also contains the measures from your DAX list, including:
  - `AP Outstanding`
  - `AR Outstanding`
  - `Cash Balance`
  - `Gross Margin`
  - `Gross Margin %`
  - `DPO`
  - `DSO`
  - `Operating CF`
  - `Investing CF`
  - `Financing CF`
  - `Free Cash Flow`
  - `Total Revenue`
  - `Total Cost`
  - `Total Payroll`
  - `SLA Compliance %`
  - `CSAT %`
- So a large portion of the refusals are not explainable by the PBIX model being conceptually missing those measures.

## Sheet Summary

| Sheet | Main question worked | Main question wrong / not generated | Follow-up worked | Follow-up wrong / not generated |
|---|---:|---:|---:|---:|
| `Aakash-2` | `21` | `4` | `20` | `5` |
| `Pranjal-2` | `1` | `24` | `2` | `23` |
| `Asyraf-2` | `7` | `18` | `7` | `18` |
| `Velan-2` | `6` | `19` | `5` | `20` |

## Root Causes

### 1. Wrong dataset / wrong semantic grounding

- This is the main failure.
- Questions that depend on “largest client,” client rankings, client cost, or client-level trends frequently operate on a non-EBPO client list.
- This invalidates most of `Pranjal-2` and several later questions in `Asyraf-2`.

### 2. Geography is missing or not wired where the tests expect it

- The app repeatedly says geography / country / region is unavailable.
- That breaks many prompts involving:
  - `country`
  - `region`
  - `geography`
- This affects:
  - `Aakash-2 Q4`
  - `Aakash-2 Q13`
  - `Asyraf-2 Q13`
  - `Asyraf-2 Q18`
  - `Velan-2 Q3`
  - `Velan-2 Q4`
  - `Velan-2 Q25`

### 3. Follow-up editing is unreliable

- Common bad behavior:
  - asks a fresh clarification instead of modifying the same chart
  - switches to a different metric
  - builds a new chart unrelated to the original ask
  - refuses to apply the change even when the base chart exists

### 4. DAX-measure-backed questions still refuse

- The app refuses several prompts that should be answerable from the listed DAX / PBIX model:
  - `Cash Balance`
  - `AR Outstanding`
  - `AP Outstanding`
  - `Operating CF`
  - `Financing CF`
  - `Free Cash Flow`
  - `Gross Margin`
  - `Gross Margin %`
- That suggests semantic routing / agent grounding problems, not only missing raw fields.

## Detailed Findings By Sheet

## `Aakash-2`

### What went right

- Strongest passes:
  - `Q1` revenue by client + gross margin comparison
  - `Q2` revenue by business unit + actual values
  - `Q3` monthly revenue trend + high/low markers
  - `Q5` revenue by industry + actual labels
  - `Q8` yearly revenue waterfall + average line
- These matched workbook aggregates correctly.

### What went wrong

1. `Q4` revenue by country
   - Main refusal is understandable if revenue-country linkage is missing.
   - Follow-up is wrong because it asks an unrelated time-window clarification instead of staying on the country limitation.

2. `Q6` revenue YTD trend
   - Follow-up says “show cumulative revenue in the same chart.”
   - App replaced the original YTD view instead of adding cumulative revenue alongside it.

3. `Q9` revenue vs cost by client
   - Clean rerun still fails.
   - Main turn asks for unnecessary clarification:
     - `Top clients`
     - `Specific clients`
     - `All clients`
   - Follow-up then refuses the bubble chart.

4. `Q12` client rank changes by revenue
   - Main chart is only a static ranking, not rank change over time.
   - Follow-up incorrectly collapses intent instead of highlighting within the same chart.

5. `Q15` total cost by client
   - Clean rerun still fails.
   - Main turn claims clients do not have cost in the dataset.
   - That is inconsistent with the EBPO revenue fact, which has `CostUSD`.
   - Follow-up drifts to an unrelated payload:
     - `Payroll Mix by Month`

6. `Q25` AR outstanding by client
   - Main chart builds correctly.
   - Follow-up fails with a generic “rephrase” response instead of adding `DSO` as a line.

## `Pranjal-2`

### Main pattern

- This sheet is almost completely broken by wrong client grounding.
- The sheet assumes the system can determine “largest client” from EBPO data.
- Instead, the app repeatedly asks me to choose from the wrong client set:
  - `BlueOak Distributors`
  - `Meridian Retail Group`
  - `Apex Ventures Ltd`
  - `TechCorp Solutions`

### Clear examples

1. `Q1` MoM revenue changes for the largest client over last 8 months
   - App refuses and names `Apex Ventures Ltd`.
   - That client does not belong to the EBPO workbook used for testing.

2. `Q2` expense breakdown for largest client by department
   - This is one of the only main charts that builds.
   - But because the largest client resolution is already suspect, the result cannot be trusted as EBPO-correct.

3. `Q3`, `Q8`, `Q10`, `Q11`, `Q12`, `Q13`, `Q16`, `Q19`, `Q23`
   - App asks for client choice instead of resolving largest client directly.
   - That is wrong for this test set.

4. `Q4`, `Q5`, `Q15`, `Q17`, `Q24`, `Q25`
   - App asks clarifications that change the meaning of the question instead of using the existing request context.

5. `Q18`, `Q20`, `Q21`
   - Refuses metrics or ranking logic that should be derivable if the model were grounded to the right revenue data.

6. `Q22` decomposition tree
   - App says decomposition trees are unsupported.
   - Follow-up then creates a different chart (`Expenses by Department and Account Category`) instead of editing the requested artifact.

### Bottom line for `Pranjal-2`

- This sheet is not trustworthy.
- The failure is primarily semantic-model grounding, not just individual chart syntax.

## `Asyraf-2`

### Main pattern

- Mixed behavior.
- Some finance questions build.
- Operations / KPI questions (`SLA`, `CSAT`, `utilization`) mostly fail or claim the metric is unavailable, even though those measures are present in your DAX list.

### Passes / partial passes

- `Q1` revenue and cost waterfall
- `Q5` revenue to net profit waterfall
- `Q6` expense composition by account type
- `Q7` operating profit trend
- `Q8` SG&A distribution
- `Q9` payroll cost by department
- `Q10` monthly expense trends by account category

### Wrong behavior

1. `Q2` gross margin % by client
   - App says this is unavailable.
   - That conflicts with the presence of `Gross Margin` and `Gross Margin %` in the PBIX model.

2. `Q3` revenue and gross margin percentage
   - Refused entirely.
   - This should be one of the more natural PBIX-supported combinations.

3. `Q4` EBITDA by business unit
   - Refused as unavailable.
   - If EBITDA is not modeled, this is understandable, but the report should still note the limitation clearly.

4. `Q11` net profit margin trend
   - Refused.

5. `Q12`, `Q14`, `Q15`, `Q16`, `Q17`, `Q18`, `Q19`, `Q20`, `Q21`
   - `SLA`, `CSAT`, and `utilization` handling is weak and often contradictory.
   - The app frequently says the metric is unavailable or asks unrelated follow-up clarifications.

6. `Q13` CSAT by country
   - App falls back to generic geography-unavailable logic.

7. `Q22` to `Q25`
   - Client / largest-client logic starts drifting back into the same wrong client-universe problem seen in `Pranjal-2`.
   - `Q25` again names `Apex Ventures Ltd`, which is not an EBPO client in the test workbook.

### Special note

- `Q16` follow-up returned:
  - `Analysis is temporarily unavailable — the AI service could not be reached.`
- This is an infrastructure/runtime error, not just a charting issue.

## `Velan-2`

### Main pattern

- This sheet should map well to PBIX pages like `AR vs AP` and `Cash Flow & Liquidity`.
- Instead, many directly relevant prompts are refused.

### Stronger passes

- `Q7` changes in assets
- `Q8` DSO by client
- `Q11` cash flow components
- `Q17` cash flow movement waterfall
- `Q21` revenue versus cost
- `Q24` gross margin contribution

### Important failures

1. `Q1` AP outstanding by vendor
   - Refused as unavailable.
   - This is concerning because `AP Outstanding` is explicitly in the DAX list.

2. `Q2` cash balance trend
   - Refused as unavailable.
   - `Cash Balance` is explicitly in the DAX list.

3. `Q3` assets by country
   - Main turn says geography is unavailable.
   - Follow-up unexpectedly builds `AR vs AP Comparison`, which does not preserve the original chart intent.

4. `Q5` AR trend
   - Refused as unavailable.
   - `AR Outstanding` exists in the DAX list, so this should be explainable from the model if the semantic path is correct.

5. `Q6` AP trend
   - Main turn says `No data matches that breakdown.`
   - Follow-up builds `Top Clients by Receivables`, which is unrelated to AP trend.

6. `Q9` DPO and AP outstanding
   - Refused even though `DPO` and `AP Outstanding` are both in the provided measures.

7. `Q10`, `Q12`, `Q13`, `Q14`, `Q15`, `Q16`, `Q18`, `Q19`
   - Many cash-flow prompts are refused despite the PBIX/DAX model exposing:
     - `Operating CF`
     - `Investing CF`
     - `Financing CF`
     - `Free Cash Flow`

8. `Q20`, `Q22`, `Q23`, `Q25`
   - Gross-margin and geography questions still show the same semantic inconsistency as earlier sheets.

## Overall Conclusion

- The local app is not reliably querying the EBPO dataset behind the PBIX/workbook used for these tests.
- `Aakash-2` is the only sheet with a decent pass rate, and even there the follow-up editing layer is unreliable.
- `Pranjal-2` is mostly invalid because “largest client” resolution uses a non-EBPO client universe.
- `Asyraf-2` exposes poor support for KPI/operations questions even though the model lists those measures.
- `Velan-2` exposes the clearest contradiction between the DAX list and actual browser behavior, especially around:
  - `AP Outstanding`
  - `AR Outstanding`
  - `Cash Balance`
  - `DPO`
  - `Cash flow` measures

## Recommended Fix Areas

1. Verify the browser agent is attached to the EBPO semantic model, not a different demo dataset.
2. Audit the client-dimension grounding used for “largest client,” “top client,” and client trend prompts.
3. Audit metric-to-measure routing for:
   - `Gross Margin %`
   - `AR/AP`
   - `Cash Balance`
   - `DPO/DSO`
   - cash-flow measures
4. Fix follow-up editing behavior so “in the same chart” truly updates the existing artifact rather than:
   - asking a fresh clarification
   - switching metrics
   - creating a different chart
   - failing with generic rephrase prompts

## Evidence Files

- Main browser run results:
  - `/private/tmp/qa_browser_results_clean.json`
- Clean reruns for contaminated `Aakash-2` questions:
  - `/private/tmp/qa_aakash_reruns_results.json`
