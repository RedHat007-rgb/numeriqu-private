# Target Architecture — Autonomous Chart Intelligence

**Author:** Backend / Software Architecture
**Date:** 2026-07-13
**Status:** Approved design → phased execution
**Supersedes the hardcoded path documented in** [`ARCHITECTURE_AUDIT.md`](ARCHITECTURE_AUDIT.md)

---

## 1. Goal (in the owner's words)

> "AI needs to generate charts, not hardcoded logic. It should NOT depend on DAX queries — different clients have different queries. The AI must be independent: it calculates everything itself and makes the chart. And it must be accurate."

**Two goals that fight each other, and how we reconcile them:**

| Goal | Naive approach | Why it fails | What we do instead |
|---|---|---|---|
| Independent / no hardcoding | Let the LLM write raw SQL freely per question | Hallucinated columns, avg-of-ratios, cross-tenant leaks — every wrong-number bug returns | AI **derives its own semantic model** per client from the schema + data |
| Accurate | Hardcode a DAX-parity catalog | Doesn't scale — new clients have no DAX and a different schema | DAX kept **only as a hidden regression oracle**, never a runtime dependency |

**Decision (approved):**
1. **Auto-derived semantic layer** — the AI introspects each client's schema and profiles their data at onboarding, then *builds its own* metric/dimension/grain model. No hand-written catalog. No runtime DAX.
2. **DAX as test oracle only** — the 27 EBPO DAX values become a hidden regression test that gates rollout; runtime never reads them.

**The one-sentence principle:**
> The AI is fully independent because it *derives* its own understanding of each client's data — not because it guesses. Grounding is **machine-generated per client**, not hand-coded and not absent.

---

## 2. Why "pure freeform AI" is rejected

This is the crux, so it's worth stating plainly. The existing system's accuracy came from *grounding*, and the git/memory history proves it:

- revenue-per-employee showed **$102.7K vs true $9.7K** (10.6× wrong) — caused by avg-of-a-ratio; fixed by computing `SUM(numerator)/SUM(headcount)`.
- gross-margin %, payroll/revenue %, collection-rate — all wrong as **avg-of-ratios**; fixed by `DIVIDE(SUM, SUM)`.
- LLM SQL hallucinated columns and leaked across tenants until a validator was added.

A "let the AI compute whatever" design re-opens **all** of these. So the new engine keeps the *discipline* (aggregation semantics, tenant scoping, verification) but **derives it automatically** instead of hardcoding it. Independence and accuracy are not in conflict once grounding is machine-generated.

---

## 3. Target pipeline (request lifecycle)

```
 ONBOARDING (once per client, refreshable)          QUERY TIME (per question)
 ─────────────────────────────────────────          ─────────────────────────────────────
                                                     NL question + org scope
 ClickHouse schema                                            │
        │                                                     ▼
        ▼                                            ┌──────────────────────┐
 ① SchemaIntrospector  ──►  PhysicalSchema           │ ④ ChartPlanner (LLM) │
        │                    (tables, cols, types)   │  question + model     │
        ▼                                            │  → ChartSpec (intent) │
 ② DataProfiler ──► ColumnProfiles                   └───────────┬──────────┘
        │            (cardinality, min/max,                      │  ChartSpec
        │             null%, sample values,                      ▼
        │             is-additive/ratio/stock)       ┌──────────────────────┐
        ▼                                            │ ⑤ SpecCompiler (det.) │  NO LLM
 ③ SemanticModeler (LLM + rules)                     │  ChartSpec + model    │
        │  → SemanticModel                           │  → parameterized SQL  │
        │    entities / measures(agg semantics) /    └───────────┬──────────┘
        │    dimensions / time grains / fact grain               │ SQL (tenant-scoped)
        ▼                                                         ▼
 ⑥ DatasetSemanticModel (persisted per org) ◄────────  ⑦ Executor + ResultVerifier
                                                          run → recompute/reconcile →
                                                          refuse on mismatch → chart
```

**Left side runs at onboarding** (and on-demand refresh). **Right side runs per question.** The planner is LLM; the compiler is deterministic; the verifier is the safety net.

---

## 4. Components & contracts

### ① SchemaIntrospector  (new, deterministic)
Reads ClickHouse `system.columns` / `system.tables` for the org's dataset. Emits:
```ts
interface PhysicalSchema {
  datasetId: string;
  tables: Array<{
    name: string;
    columns: Array<{ name: string; type: string; nullable: boolean }>;
    rowCountEstimate: number;
  }>;
  // inferred relationships (shared keys) for joins
  relationships: Array<{ from: string; to: string; on: string }>;
}
```
No AI. Pure catalog read. This is what makes it client-agnostic — it discovers, it doesn't assume.

### ② DataProfiler  (new, deterministic)
Samples each column to classify it. **This is where accuracy is born.** For each numeric column it decides the *aggregation semantics* from data shape + name signals:
```ts
type AggSemantics =
  | 'additive'      // flows: revenue, cost → SUM
  | 'semi_additive' // stocks: cash balance, headcount → last/max over time
  | 'ratio'         // %, rates → DIVIDE(SUM numerator, SUM denominator), NEVER avg-of-ratio
  | 'count_distinct';
interface ColumnProfile {
  table: string; column: string;
  distinctCount: number; nullFraction: number;
  min?: number; max?: number; sampleValues: unknown[];
  agg: AggSemantics;
  // for ratios: the discovered numerator/denominator columns
  ratioComponents?: { numerator: string; denominator: string };
}
```
The avg-of-ratios class of bugs is prevented **structurally**: any column classified `ratio` can only ever be compiled as `SUM/SUM`.

### ③ SemanticModeler  (new, LLM-assisted + deterministic rules)
Turns `PhysicalSchema` + `ColumnProfile[]` into the client's own semantic model. LLM proposes labels/entities/groupings; deterministic rules lock down aggregation semantics and grain.
```ts
interface SemanticModel {
  datasetId: string;
  version: number;
  entities: Array<{ key: string; label: string; nameColumn: string; table: string }>;
  measures: Array<{
    key: string; label: string; unit: string;
    expr: MeasureExpr;      // derived from AggSemantics — the accuracy contract
    sourceTable: string;
  }>;
  dimensions: Array<{ key: string; label: string; column: string; table: string }>;
  timeGrains: { column: string; grains: ('day'|'month'|'quarter'|'year')[] };
  factGrain: string;        // what one row means — drives correct aggregation
}
```
Persisted (⑥) as `DatasetSemanticModel` (new Prisma model, org-scoped). **Reviewable/overridable, never hand-authored from scratch.**

### ④ ChartPlanner  (LLM — generalize existing ChartSpec planner)
NL question + `SemanticModel` → `ChartSpec`. **The prompt is generated from the model** (like today's `ebpoCatalogPromptText()`), so it is per-client and carries **zero hardcoded schema or dollar facts**. Kills the ~376 regex phrase-matchers and the `metricData` God method — intent mapping is the model's job, not `text.includes()`.

### ⑤ SpecCompiler  (deterministic — generalize `chart-spec-ebpo` compiler)
`ChartSpec` + `SemanticModel` → parameterized, tenant-scoped SQL. No LLM, no hallucination surface. Reuses the proven `SCOPE_WHERE = tenant_id = {..} AND org_id IN ({..})` binding.

### ⑦ Executor + ResultVerifier  (grounding safety net — the "self-verify")
Runs the SQL, then reconciles: recompute headline figures, verify tenant scoping (validator **+ ClickHouse row policies**), refuse honestly on mismatch instead of charting a wrong number. This is the layered verification pass.

### Dataset Registry (replaces the `'ebpo' | 'gl'` enum)
`dataset-profile.ts`'s hardcoded binary becomes a **DB-backed registry**: each `ErpConnection` references a `Dataset` → its `PhysicalSchema` + `SemanticModel`. Adding dataset shape #3…#N is a **row**, not a code fork.

---

## 5. New data model (Prisma, org-scoped)

```prisma
model Dataset {
  id             String   @id @default(uuid()) @db.Uuid
  organizationId String   @db.Uuid
  kind           String            // free label, NOT an enum: "ebpo", "gl", "acme_erp"…
  physicalSchema Json              // PhysicalSchema snapshot
  introspectedAt DateTime?
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  semanticModels DatasetSemanticModel[]
  @@unique([organizationId, kind])
}

model DatasetSemanticModel {
  id         String   @id @default(uuid()) @db.Uuid
  datasetId  String   @db.Uuid
  version    Int
  model      Json              // SemanticModel
  isActive   Boolean  @default(true)
  builtBy    String            // "auto" | "auto+review"
  createdAt  DateTime @default(now())
  dataset    Dataset  @relation(fields: [datasetId], references: [id], onDelete: Cascade)
  @@unique([datasetId, version])
}
```
Mirrors the pattern you already got right in `signal_metrics`/`signal_rules`: **config as data, scoped by org.**

---

## 6. Migration strategy — Strangler Fig (no big-bang rewrite)

We do **not** rewrite `agent.service.ts` in place. We build the new engine beside it and starve the old one.

```
   Request ──► EngineRouter (per-org feature flag)
                 ├─► NEW: Introspect→Model→Plan→Compile→Verify   (default OFF, EBPO first)
                 └─► OLD: agent.service.metricData() + regex      (fallback, deleted at the end)
```

- New engine is **off by default**; enabled per-org via flag.
- EBPO turned on first and gated by the **DAX oracle** + known browser values.
- Track **% of queries served by new engine** as the migration KPI.
- Legacy code (`metricData`, regex routers, EBPO catalog constants, dead `src/agent/`, prompt $-facts) is deleted **only after** the new engine proves parity.

---

## 7. Phased plan & live status

Legend: ✅ built + unit-test-proven · 🟡 partially built (deterministic parts done; live parts pending) · ⬜ not started. "Live-verifiable only" = can only be *proven* against a running stack + ClickHouse + browser.

| Phase | Deliverable | Status (2026-07-13) | Notes |
|---|---|---|---|
| **0. Foundations** | `EngineRouter` + per-org flag; `Dataset`/`DatasetSemanticModel` models; DAX oracle; telemetry | 🟡→mostly ✅ | `engine-router.ts` ✅ unit-tested. Prisma models ✅ (schema validates, client generated) + hand-written migration `20260713000000_chart_engine_datasets` ✅ — **`prisma migrate deploy` against your DB still pending**. Static DAX oracle ✅ (`dax-oracle.spec.ts`); live numeric parity = `scripts/powerbi-parity.ts` (needs CH). |
| **1. Introspection + Profiling** | `SchemaIntrospector` + `DataProfiler` (`AggSemantics`) | ✅ (deterministic) + 🟡 (live) | `data-profiler.ts` classifier ✅. `schema-introspector.ts` SQL + parse + relationships ✅. `chart-engine.service.ts` runs it live + persists — **written & typechecked, live-unrun.** |
| **2. Semantic Modeler** | Model builder → persisted model | ✅ (deterministic) + 🟡 (LLM) | `semantic-model-builder.ts` ✅ (exprs derived from semantics; refuses to average unresolved ratios). Persistence in `chart-engine.service.ts` ✅ typechecked. **LLM label refinement ⬜** (needs live LLM). |
| **3. Model-driven compiler** | `SemanticModel`-driven SQL compiler | ✅ | `spec-compiler.ts` ✅ — ratio→SUM/SUM, stock→argMax, tenant params, honest refusals. Proven end-to-end in `pipeline.spec.ts`. |
| **4. Model-driven planner prompt** | Prompt generated from model; remove hardcoded $ figures | 🟡 | `prompt-generator.ts` ✅ built+tested (asserts NO `$`-figures leak in). **Wiring the planner LLM call + deleting the `$112M/$88M` block from `agent-prompts.ts` ⬜** (done at cutover; needs live LLM to verify intent quality). |
| **5. Verify + isolation** | `ResultVerifier` + **ClickHouse row-level security** | 🟡 | `result-verifier.ts` ✅ (reconcile additive/ratio, scope check) unit-tested. **CH row policies ⬜** (operator action on live CH). |
| **6. EBPO cutover** | Route EBPO through new engine | ⬜ | Gated by DAX oracle + browser values. Live-verifiable only. |
| **7. Delete legacy** | Remove `metricData`, regex routers, EBPO constants, dead `src/agent/`, `DatasetKind` enum | ⬜ | Only after Phase 6 parity proven. |

**What is proven right now (45 passing unit tests, `apps/api/src/modules/chart-engine/*.spec.ts`):** the full deterministic backbone — raw column stats → profiled semantics → auto-derived model → correct, tenant-scoped SQL — on a schema the engine has never seen, with **no hardcoded catalog and no DAX**; the ResultVerifier; the model-driven prompt generator (with a test that fails if any `$`-figure leaks in); and a **static DAX oracle** proving the derived EBPO ratios match PowerBI's numerator/denominator exactly. The whole API compiles (0 `src` type errors) with the engine registered and **off by default** — existing behaviour is byte-for-byte unchanged.

**What remains is deliberately live-gated** and cannot be honestly marked done without the running stack: the LLM planner/label calls, ClickHouse row policies, the EBPO cutover + numeric DAX parity, and deleting the 28k-line legacy. Each is built to a clean seam; none is faked.

### Live validation (2026-07-13)

Run against the real Supabase Postgres + ClickHouse analytics DB:

- **Migration deployed** — `prisma migrate deploy` applied `20260713000000_chart_engine_datasets`; `migrate status` → "up to date". Additive only; demo account unaffected.
- **Live introspection proven** — `scripts/chart-engine-introspect.ts` (imports the real `src/` engine) introspected `v_ebpo_cfo_ratios_monthly`, auto-derived a 13-measure model, and the three checked DAX ratios (gross margin, payroll/revenue, cost/income) resolved to the **exact PowerBI `SUM/SUM`**; stocks (`cash_balance`, `ar/ap_outstanding`) → `argMax`; flows → `sum`.
- **3 real classifier bugs found live + fixed + regression-tested**: `year` was becoming a SUM measure; `gross_margin_usd` (a $ amount) was wrongly skipped as a ratio; `fcf_margin_pct`/`ebitda_style_margin_pct` were **silently mis-wired to gross-margin's components** (the worst kind — a wrong number). All three now correct; 48 unit tests green.
- **Persistence proven** — the derived model was written to `datasets` + `dataset_semantic_models` (org `enterprise-bpo`, v1 active) and read back intact.
- **Known limitation (not a bug):** precomputed metrics with no raw components in the view (`utilization_pct`, `sla_compliance_pct`, `csat_pct`, `dso_days`, `dpo_days`, `fcf_margin_pct`, `operating_cf_to_revenue_pct`, `ebitda_style_margin_pct`) are **honestly skipped** rather than averaged. Exposing them safely needs weighted-average / duration handling in the modeler — a tracked refinement, deliberately not faked with an avg-of-ratios.

---

## 8. Definition of done

> A brand-new client with a **schema we've never seen** can be onboarded by (a) pointing us at their data and (b) running introspection — **zero TypeScript changes, zero redeploy, no DAX** — and the AI answers their questions accurately, on OpenAI, using only their own numbers. The EBPO DAX oracle stays green throughout as proof the derivation is correct.

---

## 9. Accuracy guardrails carried forward (non-negotiable)

These lessons from the audit/memory are **encoded in the derivation**, not hardcoded per client:
1. Ratios → `DIVIDE(SUM, SUM)`, never avg-of-ratios (enforced by `AggSemantics: 'ratio'`).
2. Stocks (cash, headcount) → last/max over time, never SUM across months.
3. Every query tenant-scoped by parameters **and** DB row policy.
4. The planner may only reference measures/dimensions that exist in the derived model (no hallucination surface).
5. Headline figures reconciled before charting; honest refusal over a wrong number.
