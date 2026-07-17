# Numeriqu Platform — Architecture & Scalability Audit

**Author:** Senior Architecture Review
**Date:** 2026-07-13
**Scope:** API (NestJS), Web (Next.js), DB (Prisma/Postgres + ClickHouse analytics), the AI agent, and the Signal Intelligence module.
**Question asked:** *"Is this architecture scalable to 100 clients, or is it hardcoded per-client? Where exactly is it hardcoded? Can we run the whole thing on OpenAI accurately?"*
**Method:** Read-only audit. No code changed. Evidence is cited as `file:line`.

---

## 0. TL;DR — the honest verdict

**It is not "hardcoded shit." It is a half-finished migration.** You have already built the *correct* scalable pattern twice — the `chart-spec-ebpo.ts` semantic catalog and the `signal_*` Prisma schema. The pain is that a **legacy monolith you haven't retired yet** sits next to them and still carries most of the traffic.

Two things are true at once:

- ✅ **Adding a new *client* does NOT require code changes.** Clients are scoped dynamically by `tenant_id` / `org_id`. Every hardcoded client name (JP Morgan, Walmart, AT&T, Apex, BlueOak) is in **comments only** — zero appear in logic branches. Your core fear is *largely unfounded on the data-tenancy axis.*
- ❌ **Adding a new *question type*, a new *dataset shape*, or a new *signal* DOES require code changes** — and that code lives in a 28,154-line file. This is the real liability.

**Overall grade: C+ (Conditional).** Strong bones (tenancy, two good sub-systems), dragged down by one monolith, one broken OpenAI path, and a handful of single-tenant leaks in the prompt and the frontend.

---

## 1. What "scale to 100 clients" actually means here

You confirmed the growth is on **both** axes. They have very different risk profiles:

| Axis | What grows | Code change needed today? | Verdict |
|---|---|---|---|
| **A. Customer organizations** (100 companies log in, upload their own GL/ERP, get their own dashboards) | `Organization` + `ErpConnection` rows, ClickHouse rows tagged by tenant | **No** — auto-provisioned, dynamically scoped | ✅ Scales |
| **B. Clients-within-a-dataset** (one org whose data has 100 client rows, e.g. EBPO's JP Morgan/Walmart) | Rows in `v_ebpo_revenue_by_client` | **No** — resolved live from data | ✅ Scales |
| **C. Dataset *shapes*** (a new customer vertical with a different schema / different metrics) | New tables, new measures, new question phrasings | **Yes** — code fork across ~6 files | ❌ Does not scale |

The trap is that everyone *says* "100 clients" (axis A/B, which are fine) while the real cost is axis **C** — every genuinely new kind of customer today is a code-and-deploy exercise.

---

## 2. Architecture scorecard

| Layer | Grade | One-line verdict |
|---|---|---|
| **Org-level multi-tenancy** | **A−** | First-class `Organization` model, dynamic scoping, verified membership. Solid. |
| **Semantic layer — `chart-spec-ebpo.ts`** | **A−** | Config-driven catalog + SQL compiler. *This is your target pattern.* |
| **Signal Intelligence — DB schema** | **A** | Textbook multi-tenant, rule/threshold tables per org. |
| **Signal Intelligence — logic** | **C−** | Thresholds & signal types hardcoded in TS; the rule tables are written but **never read**. |
| **LLM model/provider config** | **A−** | One env-driven source of truth. Clean. |
| **LLM prompt *content*** | **D+** | One sample company's schema **and dollar figures** baked into the system prompt — a correctness landmine. |
| **Legacy agent core — `metricData()`** | **D−** | A ~6,000-line God method; ~376 regex phrase-matchers; scattered SQL literals. The monolith. |
| **Frontend composition** | **C** | Data flow is tenant-agnostic (good), but Power BI URL, dashboard card catalog, and glossary are compiled-in per-client. |
| **Tenant isolation (security)** | **B−** | Enforced, but by a regex SQL validator only — no DB row-level security applied. |
| **Dead code / hygiene** | **C** | An entire duplicate agent stack (`src/agent/`) is orphaned; a couple of infra literals. |

---

## 3. Findings by layer (with evidence)

### 3.1 ✅ Org-level tenancy — the part that works

- First-class tenant model: `packages/db/prisma/schema.prisma:166` `model Organization`, `:219` `OrganizationMembership`, `:281` `ErpConnection`.
- Runtime scope derived **server-side from verified membership**, never from user input: `agent.service.ts:26185` `getOrgScope`, `:26200` `tenantId = organizationId`; non-admins forced to a single `org_id` (`:26217`).
- Every analytics query binds tenant as **parameters**, not string interpolation: `chart-spec-ebpo.ts:1613`
  `SCOPE_WHERE = 'tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})'`.
- New orgs auto-provision on first login (`org-context.service.ts:151`). Forged `x-organization-id` rejected `FORBIDDEN` (`org-context.service.ts:188`).

**No code change to onboard customer #101 *of an existing shape*.**

### 3.2 ✅ The semantic layer you got right — `chart-spec-ebpo.ts`

This is the model everything else should converge on.

- Closed, declarative catalog: `EBPO_MEASURES` (`:128`, 33 measures), `EBPO_DIMENSIONS` (`:1091`), `EBPO_VIEWS` (`:1116`).
- A compiler turns catalog → SQL: `valueExprFor()` (`:1761`), `resolveEbpoView()` (`:1842`).
- The planner prompt is **generated from the catalog** (`ebpoCatalogPromptText()`, `:3078`) — so the LLM "structurally cannot hallucinate columns or tables."
- Adding a measure/dimension is **data entry**, documented at `chart-spec-ebpo.ts:11-24`: add to `EBPO_MEASURES`, map the column in each exposing `EBPO_VIEWS`, add to `EBPO_DIMENSIONS`. *No prompt surgery.*

### 3.3 ❌ The monolith — `agent.service.ts` (28,154 lines)

This single file is the center of gravity of the scalability problem.

- **`metricData()` is a ~6,000-line God method** (`:1236`–`~7319`) holding **169 `metric===` branches × 161 `grouping===` branches**, each hand-writing inline SQL. At least **9 methods exceed 750 lines** (`metricData` ~6,083; `buildEbpoMetricEdit` ~2,044; `query` ~1,797; `selectWidgetsForQuery` ~1,129).
- **~376 regex `.test()` calls run directly against raw user-question text** — the "we wrote code for every phrasing" smell. Examples:
  - `:222` actuals-only detection; `:289` headcount/attrition intent; `:506` YoY phrasings; `:7993` top/bottom-client phrasings; `:8804` `use client A:` parsing.
  - `preRouteQuery()` (`:26413`–`27172`) alone has **44** such branches.
- **Scattered SQL identifiers** (not centralized): `v_fact_accounting_invoices_latest` ×42, `v_dim_clients_latest` ×25, legacy demo table `sample_gl_dump` ×~35 (including a fully hardcoded `FROM analytics.sample_gl_dump` at `:27634`). Column literals: `client_name` ×208, `total_amount` ×175. A schema rename = find-replace across dozens of literals.
- **Two genuine dataset-specific hardcodes** (break on a differently-shaped dataset):
  - `:19182` refusal text hardcodes *"this dataset only covers a single year (2024)"* while the guard `if (years < 2)` is dynamic — wrong message for any other single-year dataset.
  - `:27631-27633` hardcodes the demo's chart of accounts: `sumIf(... department='Admin') ... ='Operations') ... ='Sales')`; account→category `LIKE '%marketing%'` at `:6736`/`:7186`.

Every new question type accretes here as one more regex + one more `metric===` branch. This grows with *question variety*, forever.

### 3.4 ⚠️ Signal Intelligence — right schema, hardcoded brain

**Schema (grade A):** `packages/db/prisma/schema.prisma:836-876` — `SignalMetric` / `SignalRule` / `Signal` all carry `organizationId`, thresholds live as `threshold Json` / `defaultThresholds Json`, `@@unique([organizationId, metricKey])`. This is exactly how a configurable rules engine should be modeled.

**Logic (grade C−):** the schema is decorative — the brain is hardcoded.

- **The rule tables are written but never read.** `signal_rules` is upserted (`signal-intelligence.service.ts:348`) but grep finds **no read** of it anywhere. `defaultThresholds:{auto:true}` (`:337`) and `supportedDimensions:{auto:true}` (`:338`) are placeholder literals. Detection thresholds are 100% inline magic numbers:
  - revenue `deltaPct <= -0.3 ? 'CRITICAL'` (`:553`); cash `runwayMonths <= 1 ? 'CRITICAL'`, `confidence 0.93` (`:611-615`); margin `<=15 ? 'CRITICAL'` (`:703`); payroll `>=80 ? 'CRITICAL'` (`:747`); utilization (`:783`).
- **Adding a signal type = code change in ~6 places:** a new `computeXSignals` method, `composeFallbackSignals` wiring (`:1120`), the `SignalType` union (`signal-intelligence.types.ts:9-16`), `isAllowedSignalType` (`:1191`), `isAllowedMetricKey` (`:1219`), `DEFAULT_SIGNAL_METRICS` (`:70`), and the LLM enum arrays (`:946-955`).
- ✅ **Adding a client requires no code** — everything is `organizationId`-scoped and auto-seeded via `ensureSignals` → `seedDefaults` (`:310-388`).

### 3.5 🐛 The OpenAI accuracy problem (two root causes)

You said the priority is *"do the whole thing with OpenAI and it should be accurate."* Two concrete blockers stand between you and that:

**(a) The OpenAI signal path appears broken.** `discoverSignalsWithOpenAi` (`signal-intelligence.service.ts:806`) is *gated* on `provider === 'openai'` (`:816`) but then POSTs to the **Ollama** `/api/chat` endpoint with an Ollama-shaped body and **no `Authorization` header** (`:819-823`). The default provider is Ollama `llama3:latest` anyway (`common/llm/llm-config.ts:23`), so in practice signals **silently fall back to the hardcoded threshold functions** and never touch OpenAI. Gemini has no discovery path at all.

**(b) The prompt states one client's numbers as ground truth for everyone.** `agent-prompts.ts` (`ANALYTICS_SCHEMA_CONTEXT`, ~`:588`+) bakes the EBPO sample company's entire schema **and hardcoded dollar facts** into the system prompt — e.g. *"Company payroll (~$112M) EXCEEDS cost of revenue (~$88M)"* (`:618-623`), plus `$716K`/`~$8` (`:905`) and `~$374`/`~$716` (`:1258`). The instant a different client's data loads, the model will confidently assert *the wrong client's numbers.* This is the single biggest threat to "accurate with OpenAI."

**The good news:** the LLM *plumbing* is production-grade. Model IDs are one env-driven constant (`llm-config.ts:11` `DEFAULT_OPENAI_MODEL='gpt-5.4-mini'`, overridable via `OPENAI_MODEL`); every service resolves through `resolveLlmRuntimeConfig(...)`; provider translation is centralized in one fetch interceptor (`main.ts:29` + `common/llm/llm-fetch-interceptor.ts`). Switching to OpenAI is a config + prompt-templating job, not a rewrite.

### 3.6 ⚠️ Frontend — data scales, composition doesn't

- ✅ The API layer (`lib/api/*.ts`, `useNumeriquApi.ts`) is fully tenant-agnostic — all data fetched by auth/org token, no client names or metric literals.
- ❌ **Hardcoded single-tenant Power BI report** compiled into the sidebar for *every* user: `DashboardShell.tsx:42` `const POWER_BI_URL = "https://app.powerbi.com/view?r=..."`. The most blatant per-client blocker.
- ❌ **Fixed 25-card dashboard catalog + layout**, not per-client configurable: `overviewDashboardConfig.ts:53-340` (`OVERVIEW_CARD_DEFINITIONS`), positions hardcoded in `getRecommendedOverviewPlacements()` (`:346-388`). Titles are industry-locked ("Global Delivery Footprint", "Delivery Center Scorecard").
- ❌ **Industry-locked glossary** — `glossary.ts:48-66` defines terms as "outsourcing contract" etc.

### 3.7 ⚠️ Tenant isolation — enforced, but fragile boundary

- LLM-generated SQL passes `validateDynamicSql` (`dynamic-sql.ts:125`): requires both scope placeholders, requires one `org_id` predicate per table (`enforceEveryTableScoped`, `:71`), forbids comments/multi-statement/mutations/system tables/table functions, forces `LIMIT`.
- **Gap:** this **regex/text validator is the only live boundary.** `SECURITY_SQL_HARDENING.md` states ClickHouse row-level security is "recommended … NOT auto-applied." A real comment-based bypass was already found and fixed — proof that a regex-only boundary is fragile. At 100 tenants, a single validator regression = a cross-tenant data breach.
- Two inconsistent dataset-detection heuristics coexist: `orgHasEbpoData` (data probe, `agent.service.ts:12071`) vs `isEbpoOrg`/`isSampleGLOrg` (metadata string-sniff, `financial-data.service.ts:45`). They can disagree and route an org to the wrong dataset.

### 3.8 🧹 Dead code & config hygiene

- **Entire duplicate agent stack is orphaned:** `apps/api/src/agent/` (controller, service, tool executor, its own `AGENT_CFO_PROMPT`) is imported **nowhere** — `app.module.ts:12,36` wires only `modules/agent`. Delete it; it misleads maintainers and carries its own hardcoded prompt.
- **`DatasetProfile` is a hardcoded 2-way enum**, not a registry: `dataset-profile.ts:21` `type DatasetKind = 'ebpo' | 'gl'`, `:85` `resolveDatasetProfile = kind === 'ebpo' ? EBPO_PROFILE : GL_PROFILE`. No third dataset is even representable; the `ebpo ? … : gl` fork is threaded through ~15 call sites.
- **Config:** `apps/api/.env` is **gitignored and untracked** (✓ no committed secret), but points at a real ClickHouse IP over **plaintext HTTP** (`CLICKHOUSE_URL="http://35.168.16.162:8123"`) — transport-security item, not a leak. DB name defaults to literal `'analytics'` in ~10 files when env unset (soft hardcode, overridable).

---

## 4. Hardcoding hotspot index (quick reference)

| # | Hotspot | Location | Blocker? | Fix theme |
|---|---|---|---|---|
| 1 | 6,000-line `metricData` God method, 169×161 branches | `agent.service.ts:1236` | 🔴 Yes | Migrate to catalog compiler |
| 2 | ~376 regex phrase-matchers on user text | `agent.service.ts` (`:222`, `:289`, `:506`, `preRouteQuery :26413`) | 🔴 Yes | LLM intent → structured spec |
| 3 | Dataset facts ($112M/$88M…) in system prompt | `agent-prompts.ts:618-623, 905, 1258` | 🔴 Yes (accuracy) | Template schema+facts per tenant |
| 4 | OpenAI signal path calls Ollama endpoint, no auth | `signal-intelligence.service.ts:816-823` | 🔴 Yes (accuracy) | Fix provider routing |
| 5 | Signal thresholds hardcoded; rule tables never read | `signal-intelligence.service.ts:546-787, 348` | 🟠 Partial | Read `signal_rules.threshold` |
| 6 | Hardcoded Power BI URL for all tenants | `DashboardShell.tsx:42` | 🟠 Partial | Per-org config |
| 7 | Fixed dashboard card catalog + layout | `overviewDashboardConfig.ts:53-388` | 🟠 Partial | Server-driven per tenant |
| 8 | `DatasetKind` hardcoded binary + ~15 forks | `dataset-profile.ts:21,85` | 🟠 Partial | DB/config dataset registry |
| 9 | Scattered CH view/column literals | `agent.service.ts` (`sample_gl_dump` ×35 etc.) | 🟠 Partial | Centralize in catalog |
| 10 | Isolation rests on regex validator only | `dynamic-sql.ts:125` | 🟠 Risk | Apply CH row policies |
| 11 | Orphaned duplicate agent stack | `apps/api/src/agent/*` | 🟢 Cleanup | Delete |
| 12 | Two inconsistent dataset detectors | `agent.service.ts:12071` vs `financial-data.service.ts:45` | 🟢 Cleanup | Unify resolver |

---

## 5. Target architecture (where this is already heading)

The fix is not a rewrite — it is **finishing the migration you started.** Converge everything onto the two patterns you already proved.

```
                        BEFORE (today)                          AFTER (target)
   ┌─────────────────────────────────┐        ┌──────────────────────────────────────┐
   │ agent.service.ts (28k lines)     │        │ Thin orchestrator                      │
   │  ├─ metricData() 6k-line God fn  │        │  └─ LLM: question → ChartSpec (intent) │
   │  ├─ 376 regex phrase routers     │  ───▶  │                                        │
   │  ├─ inline SQL literals          │        │ ChartSpec compiler (per dataset)       │
   │  └─ ebpo ? … : gl forks ×15      │        │  └─ catalog: MEASURES/DIMENSIONS/VIEWS │
   ├─────────────────────────────────┤        ├──────────────────────────────────────┤
   │ chart-spec-ebpo.ts  ✅ catalog   │        │ Dataset REGISTRY (DB/config, N kinds)  │
   │ DatasetKind = 'ebpo' | 'gl'      │        │  └─ profile per ErpConnection          │
   ├─────────────────────────────────┤        ├──────────────────────────────────────┤
   │ signals: DB schema ✅ / logic ❌  │        │ signals: rules read from signal_rules  │
   │ prompt: one client's $ facts     │        │ prompt: schema+facts templated per org │
   └─────────────────────────────────┘        └──────────────────────────────────────┘
```

**Principles to enforce going forward:**
1. **Catalog, not code.** New metric/dimension/signal = a row or a catalog entry, never a new branch.
2. **One resolver per concern.** One dataset resolver, one tenant-scope injector, one LLM provider gateway.
3. **The prompt is generated, never authored per client.** Schema and facts come from the catalog + live data, templated per tenant.
4. **Isolation belongs in the database.** The app validator is defense-in-depth on top of CH row policies, not instead of them.

---

## 6. Prioritized remediation roadmap

### P0 — accuracy & safety (do first; these block "accurate on OpenAI")
1. **Fix the OpenAI provider routing** in signals — call the OpenAI endpoint with auth when `provider==='openai'`, or route all providers through the existing `llm-fetch-interceptor`. Add a health check that fails loudly instead of silently falling back to Ollama. *(`signal-intelligence.service.ts:806-823`)*
2. **De-hardcode dataset facts from the system prompt.** Generate the schema block and any numeric anchors per-tenant from the catalog + a live query; never assert one client's dollars as global truth. *(`agent-prompts.ts:588-1258`)*
3. **Apply ClickHouse row-level security** keyed on a server-set tenant setting, so isolation is DB-enforced, not regex-only. *(`SECURITY_SQL_HARDENING.md`)*

### P1 — kill the monolith's growth (stops "code per question")
4. **Freeze `metricData()`** — no new `metric===`/`grouping===` branches. Route new question types through the `chart-spec-ebpo` catalog compiler instead.
5. **Migrate the highest-traffic question types** off `metricData` onto the catalog, then delete the corresponding legacy branches. Track % of queries served by catalog vs legacy as the migration KPI.
6. **Make signal rules data-driven** — read `signal_rules.threshold` / `SignalMetric.defaultThresholds` instead of inline magic numbers; expose a rules-edit endpoint so ops/clients configure thresholds without a deploy. *(`signal-intelligence.service.ts:546-787`)*

### P2 — de-couple presentation & datasets (enables new client shapes)
7. **Promote `DatasetProfile` to a registry** — a `Dataset` table (or `ErpConnection.metadata`-referenced config) so a new dataset shape is a config row, not a `DatasetKind` enum edit + 15 forks. Unify the two detection heuristics into it. *(`dataset-profile.ts`, `financial-data.service.ts:45`)*
8. **Make the frontend composition tenant-scoped** — move `POWER_BI_URL` to per-org config, serve the dashboard card catalog + glossary from the backend per tenant. *(`DashboardShell.tsx:42`, `overviewDashboardConfig.ts`, `glossary.ts`)*
9. **Delete the orphaned `apps/api/src/agent/` stack.**

### Definition of done (the test for "scalable")
> A new customer with a **new data shape** can be onboarded by inserting config rows and loading data — **zero TypeScript changes, zero redeploy** — and the agent answers their questions accurately on OpenAI using only their own numbers.

---

## 7. What you should NOT do

- **Don't rewrite from scratch.** The bones are good; `chart-spec-ebpo.ts` and the signal schema prove the team knows the right pattern.
- **Don't panic about client names in the code** — they're comments. Client onboarding already scales.
- **Don't add "one more regex" to `metricData`.** Every branch added there is debt you'll pay to migrate later.

---

*Appendix: evidence gathered read-only across `apps/api/src/modules/agent/*`, `apps/api/src/modules/signal-intelligence/*`, `apps/api/src/agent/*`, `apps/api/src/common/llm/*`, `apps/web/app/dashboard/*`, `apps/web/lib/*`, and `packages/db/prisma/schema.prisma`. No files were modified.*
