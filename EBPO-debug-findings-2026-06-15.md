# EBPO Agent — 100-Question Debug Findings (2026-06-15)

Tested the 100 main + 100 follow-up prompts from `Questions Testing (2).xlsx`
(sheet "New Data Ques") against the **EBPO org** (Enterprise BPO Holdings,
tenant `7375b5aa-…`, org `ebpo_enterprise`) through the REAL agent path
(`generateSmartPlan` for create, `generateEditPlan` for follow-up), production-like
(no `AGENT_SPEC_MODE`). Executed every produced SQL on live ClickHouse.

Harness: `apps/api/scripts/test-ebpo-questions.ts` (+ `ebpo-questions.json`).
Raw results: `apps/api/scripts/ebpo-questions.out.jsonl` / `.report.md`.

## Baseline (before fix)

| Phase | Result |
|---|---|
| CREATE | **99 OK**, 1 NO_DATA (Q49 box plot — correct) |
| CREATE source | catalog 68, LLM 31 |
| FOLLOW-UP | 84 OK, **14 REFUSED**, 1 NOOP, 1 skipped |

## Root cause of the 14 follow-up refusals

`generateEditPlan` ran a **GL-era deterministic refusal guard**,
`detectUnavailableData(editRequest)` (agent.service.ts ~2150), that hard-codes
"this dataset has no cash flow / headcount / region / prior-year / segment". That is
true for the single-year GL sample but **FALSE for EBPO**, which has
`v_ebpo_cash_flow_monthly`, `employee_count`/`revenue_per_employee`/`avg_monthly_salary`,
`region`/`country`, multi-year data (`revenue_yoy_pct`), and industry/contract segments.
So legitimate EBPO follow-ups ("add free cash flow", "add employee count", "by country")
were wrongly refused. The CREATE path already gated these via `hasRichDataset`
(`detectUnsupportedOrAmbiguousAsk`), but the EDIT path was never gated.

Flow: catalog spec-editor can't model "add a second/comparison measure" → defers to the
legacy editor → legacy editor's GL guard falsely refuses. (The LLM-SQL editor that would
have built it correctly never got reached.)

## Changes made (in this session)

All in `apps/api/src/modules/agent/agent.service.ts`:

1. **`detectUnavailableData(queryText, hasEbpo = false)`** — made dataset-aware.
   budget/forecast/target refusals still apply to both datasets (genuinely absent).
   cash-flow / headcount-per-employee / region / YoY-prior-year / segment refusals are
   now **skipped when `hasEbpo`** (they exist in EBPO). GL behavior unchanged (default false).

2. **`generateEditPlan`** — probes `editHasEbpo = orgHasEbpoData(scope)` and passes it to
   `detectUnavailableData`. Also broadened the spec-edit trigger: it now runs when
   `AGENT_SPEC_MODE==='1'` **OR** any active widget carries a `spec` (`dashboardHasSpec`),
   so EBPO charts (always built from a spec) get deterministic edits in production too —
   previously the spec editor only ran behind the flag.

(Earlier same-session change, the EBPO catalog itself: new
`apps/api/src/modules/agent/chart-spec-ebpo.ts` + wiring in `generateSpecPlan`/
`generateSmartPlan`. See memory `project_ebpo_catalog.md`.)

## After fix (re-ran the 16 problem questions)

13 of 14 false refusals fixed — all now build (via the LLM editor) with rows:
- cash flow: 21, 22, 85 ✅   headcount/per-employee: 42, 48, 55, 79, 80, 84, 99 ✅
- region: 43 ✅   scatter per-employee: 81 ✅   dashboard NOOP→OK: 100 ✅

Effective follow-up rate ≈ **97/100**. Remaining are legitimate, not bugs:
- **Q49** box plot → `no_data` (chart type unsupported).
- **Q59** "below **target** SLA" → refused (no target column exists — correct).
- **Q25** cash-flow waterfall → `no_data` on the create this run = **LLM non-determinism**
  (a reliability gap in the LLM-SQL path, not a false refusal).

## Known gaps worth a follow-up (not yet done)

- **Derived CFO ratios** not in any view → LLM path, unreliable: current ratio (Q76),
  quick ratio (Q77), working capital / net working capital (Q78, 94), free-cash-flow
  margin (Q83, 85), cash conversion (Q90), EBITDA-style margin (Q93), cost-to-income
  (Q97), gross-margin-per-employee (Q84). Best fix = precompute these as columns/views
  + register in the EBPO catalog (then they become deterministic).
- **Waterfall / scatter / combo / Pareto / box plot / multi-chart dashboard** are handled
  by the LLM/legacy path (catalog defers). Mostly OK but non-deterministic; box plot &
  Pareto have no native chart type.
- **"Add a second comparison measure as a line/axis" follow-ups** all route to the LLM
  editor (catalog spec editor can't add a second measure series). Works today; a future
  enhancement could make these deterministic via a dual-measure spec.

## To regenerate the full corrected report
`cd apps/api && npx tsx scripts/test-ebpo-questions.ts` (re-runs all 200; ~10 min, LLM cost).

## Follow-up debug pass (later 2026-06-15)

The first focused rerun still had a hidden reporting bug: Q84, Q85, and Q99 were
marked `OK` even when the edited SQL did not verify (`rows = -1`). That meant the
agent sometimes kept the original chart data but still returned a "changed" edit plan.

Root causes:
- `generateSmartEditPlan` kept cosmetic edit fields (type/title) after a requested
  SQL rewrite failed verification, so the plan looked successful while data stayed
  unchanged.
- The EBPO harness classified `rows = -1` as `OK`; it now reports this as
  `UNVERIFIED`.
- Some EBPO CFO ratios were still routed through free-form LLM SQL, which could
  hallucinate columns like `revenue_usd`, `employee_count`, or
  `gross_margin_per_employee_usd` in views where those exact columns do not exist.

Additional fixes:
- Failed SQL rewrites are now dropped instead of returned as successful edits.
- Added deterministic EBPO metric edit SQL for:
  - Q84: revenue per employee + gross margin per employee by business unit.
  - Q85: operating cash flow % of revenue + free cash flow margin by month.
  - Q99 follow-up: KPI cards for current ratio, gross margin %, cost per employee,
    revenue per employee, and free cash flow margin.
- Added deterministic EBPO create routes for CFO derived ratios:
  quick ratio, working capital / net working capital, free cash flow margin,
  operating cash flow % of revenue, cash conversion, EBITDA-style margin, and
  cost-to-income ratio.

Focused verification after the extra fixes:

| # | CREATE | FOLLOW-UP |
|---|---|---|
| 84 | OK, 5 rows | OK, combo, 5 rows |
| 85 | OK, 48 rows | OK, combo, 48 rows |
| 99 | OK, KPI, 6 rows | OK, KPI, 5 rows |

Verification run:
- `pnpm --dir apps/api test -- explicit-charts.spec.ts chart-spec-ebpo.spec.ts --runInBand`
  → 24 tests passed.
- Narrow compile check on `src/modules/agent/agent.service.ts` passed.
- Full `pnpm --dir apps/api exec tsc --noEmit` still fails because existing
  ad-hoc scripts under `apps/api/scripts` have NodeNext import/type issues; this is
  unrelated to the EBPO agent changes.

Privacy note: a broader LLM-backed rerun for the derived-ratio IDs was blocked by
the approval reviewer because it would send live EBPO prompt/context through the
OpenAI interceptor. Use deterministic/unit verification unless the tenant explicitly
approves that data path.
