# Agent Module — Architecture & Decision Record

_Last updated 2026-06-16. Purpose: so nobody has to re-derive how this works. If you're
asking "where are we lagging?" — read this first._

## TL;DR

The agent turns a natural-language finance question into chart(s) + a brief. It is in a
**healthy transitional state**: a clean **catalog-first** planner serves ~100% of normal
traffic, while a large **legacy deterministic planner** is kept as a fallback. The pain
is *not* correctness (it's solid) — it's the **size/coupling** of `agent.service.ts`.

## Files (the module was decomposed from one god-file)

| File | Role |
|---|---|
| `agent.service.ts` | behavior (planning, editing, SQL exec, brief) — still the bulk |
| `agent-prompts.ts` | the 8 LLM system prompts + 2 structured-output JSON schemas |
| `agent.types.ts` | 22 domain types |
| `agent-widget-catalog.ts` | `VALID_WIDGETS` — legacy widget vocabulary (pure data) |
| `chart-spec.ts` / `chart-spec-ebpo.ts` | the **catalog/compiler** (the good architecture) |

## Request flow (`query()` generator)

```
query()
 ├─ EDIT intent  → generatePlan (LEGACY, for tool plan) ‖ generateEditPlan  → plan
 └─ CREATE intent
      └─ generateSmartPlan  (PRIMARY)
           ├─ AGENT_SPEC_MODE=1 → generateSpecPlan → chart-spec catalog   [served=spec]
           ├─ EBPO org         → buildEbpoScorecardPlan / spec            [served=ebpo-scorecard]
           └─ else             → LLM writes ClickHouse SQL                [served=llm]
      ↓ if generateSmartPlan returns no_data AND AGENT_LEGACY_FALLBACK≠0
      └─ generatePlan (LEGACY vocab/metricData)                           [served=legacy]
      ↓ if generateSmartPlan unavailable (LLM offline/failed)
      └─ generatePlan (LEGACY) — graceful degradation
 → composeDeterministicBrief (NOT an LLM call — synthesis is deterministic)
```

## Flags

- **`AGENT_SPEC_MODE=1`** (set in `.env`) — enables the spec/catalog-first planner. Already on.

(The earlier `AGENT_LEGACY_FALLBACK` / `AGENT_OFFLINE_HONEST_ERROR` flags were removed once
their honest behaviors became the default — see below.)

## Plan cache (latency + cost + offline resilience)

`generateSpecPlan` caches `{org-type, normalized question} → catalog spec` (`specPlanCache`,
30-min TTL). On a hit it **replays the spec through the deterministic compiler** — skipping
the LLM but **re-running ClickHouse** (so data is always fresh) — logged as `served=spec-cache`.
Because the cache-check sits *before* the LLM ping, previously-seen questions are answered
**correctly while the LLM is down**, for GL and EBPO alike. This is the "correct degraded
mode" that makes deleting the legacy planner viable. Proven: 2 identical questions → 1 LLM call.

## Observability

Grep server logs for `[planner] served=` — values: `spec` | `spec-cache` | `ebpo-scorecard` | `llm` | `legacy` | `offline-error`.
Every `served=legacy` line = a question only the legacy path could answer (the Phase-2
burn-down signal). Validation harness: `scripts/test-ebpo-questions.ts` (`--file`, env
`HARNESS_TENANT`/`HARNESS_ORG`); legacy-rescue probe: `scripts/phase2-legacy-probe.ts`.

## The legacy planner — why it still exists (DECISION RECORD)

`metricData` + `generatePlan` + `selectWidgetsForQuery` (+ `VALID_WIDGETS`) is the
pre-catalog, hardcoded `(metric × grouping)` SQL builder. It has **three roles**:

1. **Create `no_data` fallback** — **VALIDATED REDUNDANT**: 0 rescues across 52 questions
   (incl. the documented legacy-only cases: class breakdown, dept scatter). The catalog
   now covers these.
2. **Per-edit tool plan** (`query()` ~8214) — runs on every edit; output feeds tools + brief.
3. **LLM-offline graceful degradation** (`query()` ~8380) — when the LLM is unreachable,
   this is the only thing that still produces output.

**UPDATE (2026-06-16): all three roles retired; `generatePlan` deleted (−981 lines).**
- Role 1 (no_data rescue): removed — always surface honest `no_data` (validated 0/52 redundant).
- Role 3 (offline): removed — always honest "temporarily unavailable"; the **plan cache**
  (runs before the LLM ping) serves previously-seen questions correctly during an outage.
- Role 2 (per-edit tool plan): the edit path now derives tools via `deriveToolsFromWidgets`
  from the existing dashboard, so it no longer calls the legacy planner.

**What remains, and why it was NOT deleted:** `metricData`, `selectWidgetsForQuery`, and
`VALID_WIDGETS` are still referenced by **live, non-legacy** code:
- `VALID_WIDGETS` → `generateEditPlan` / `applyDashboardEdit` (chart-type validation — it's
  the shared widget *vocabulary*, not legacy logic).
- `metricData` → `buildChartTurnWidgetSnapshots` (chart-turn history).
- `selectWidgetsForQuery` → `queryAwareFallbackWidgets` (a separate live fallback).

So the original "6k-line deletable legacy" premise was partly wrong: much of it is shared
infrastructure. Fully removing `metricData`/`VALID_WIDGETS` now requires reworking those live
features — a separate, test-gated task, not a delete.

> ⚠️ Verification gap: the edit path's new tool-derivation lives in the `query()` generator,
> which the test harness does NOT exercise (it tests `generateEditPlan` in isolation). The
> edit *diff* is verified; the edit *brief's data* is not. Run one real edit in staging to confirm.

## Dataset grounding boundary (2026-06 — the robustness fix)

`dataset-profile.ts` is the single boundary between "which org" and "which data". Every
request resolves a `DatasetProfile` (EBPO vs GL) via `getDatasetProfile(scope)`; that profile
owns where clients/years come from and which tables are legal. Three layers stop GL/demo data
(`dim_clients`, `sample_gl_dump`, GL invoices) from ever reaching an EBPO answer — the root of
the "Apex Ventures / BlueOak shown for EBPO" class of bug:

1. **Runtime guard** in `executeDynamicSqlChecked`: a chart query referencing a table outside
   its profile THROWS in dev/test and returns an honest refusal in prod (`checkGrounding`).
2. **Profile-routed resolvers**: `resolveClientFilter`, `listTopClientsForScope` (the one
   client-list source), and `dataYearCount` read their table from the profile, not a hardcode.
3. **GL-pipeline firewalls**: the GL `metricData` builder, `executeTools` (GL tools), and
   `getDataContext` early-return for EBPO — EBPO is served only by the spec compiler.

QA gates: `npm run qa` (grounding tests + PowerBI value parity). Full e2e: `npm run qa:browser`
(drives the real /agent/query endpoint per question). See `dataset-profile.spec.ts`,
`scripts/powerbi-parity.ts`, `scripts/ebpo-browser-run.ts`.

## Prioritized roadmap

1. **Grow catalog coverage** (`chart-spec*.ts`) — every added measure/dimension shrinks
   the reasons the `llm`/`legacy` paths ever fire. Highest ongoing ROI.
2. **Continue safe decomposition** of `agent.service.ts` (more constant/type/pure-helper
   extractions) — pure velocity, low risk.
3. **(Deliberate project) retire the legacy**: decide offline-resilience → rework edit
   path → delete `metricData`/`VALID_WIDGETS`. Gated on roles 2 & 3, not on correctness.

## What is NOT a problem (despite how it feels)

Question-handling quality. On 52 live questions across GL + EBPO: ~100% happy-path served
by the catalog, hallucination-free, with honest refusals for impossible asks. The lag is
maintainability/size, addressed by (1) and (2) above — not by risky rewrites.
