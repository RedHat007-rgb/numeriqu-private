# Prism: finance decision intelligence architecture

Status: implemented application architecture; production rollout controls pending  
Scope: corporate finance, accounting, FP&A, treasury, revenue operations, and executive decision support  
Non-goal: a general personal assistant, an autonomous money mover, or an unlicensed personal investment adviser

## Foundation implemented in this change

- finance, off-topic, restricted-advice, and prompt/data-extraction policy paths;
- server-controlled Executive, Professional, and Friendly tones;
- deterministic percentage and currency presentation with zero-denominator refusal;
- currency-separated monetary answers with no default USD assumption;
- removal of the invalid invoice-derived cash/runway calculation and replacement of the dormant free-form LLM answer path with a schema-constrained OpenAI intent planner;
- capability-based routing across semantic finance, operational-finance, and invoice datasets based on verified tenant coverage;
- explicit separation of unavailable data from a verified numerical zero;
- partial-data warnings instead of silently converting failed reads to trustworthy zeroes;
- an unlocked Prism workspace, accessible tone control, and persistent user preference;
- query length limits, tenant-bound reads, parameterized queries, validated database identifiers, and removal of an embedded analytics password fallback;
- adversarial policy and finance-unit tests.

## Product promise

Prism turns authorized business-finance data into a decision-ready answer that is:

- faithful to the available records;
- calculated by deterministic code, never by language-model arithmetic;
- explicit about period, currency, assumptions, and missing inputs;
- concise enough for an executive and inspectable enough for finance;
- limited to finance, even when a prompt attempts to change Prism's role.

"Zero hallucination" cannot honestly be guaranteed by a generative model. Prism therefore uses a stronger application-level contract: no factual number or company-specific claim may reach the user unless it is produced by an approved calculation over authorized data. When that contract cannot be satisfied, Prism asks for a missing input or declines to answer.

## Design principles

1. **The model proposes; deterministic services dispose.** A model may classify language or draft prose, but it cannot issue SQL, calculate a KPI, invent a premise, choose a currency conversion, or authorize an action.
2. **Finance is an application boundary.** Scope enforcement happens before retrieval and again before presentation. A system prompt is not a security control.
3. **Every figure has an internal evidence envelope.** The envelope records organization, metric definition version, period, currency, inputs, formula, query fingerprint, data freshness, and validation results. The customer-facing answer never exposes table names, SQL, or internal infrastructure.
4. **No silent coercion.** Missing data is not zero. Mixed currencies are not summed. Forecasts are not facts. Advice is not execution.
5. **Human control increases with consequence.** Read-only analysis can be immediate. Recommendations require assumptions and alternatives. Any future write or money movement requires explicit preview, authorization, policy checks, and approval.
6. **Professional without being opaque.** Prism leads with the answer and business consequence, then offers calculations and assumptions in plain language.

These principles align with FASB's emphasis on complete, neutral, and error-minimized faithful representation; CFA guidance to distinguish fact from opinion and disclose material limitations; NIST's Govern/Map/Measure/Manage lifecycle; FINRA's supervision, communications, recordkeeping, and fair-dealing expectations; and OWASP's controls for prompt injection, information disclosure, improper output handling, and excessive agency.

## Clean-sheet system shape

Start as a modular monolith. It preserves transactional and operational simplicity while enforcing boundaries that can later be extracted if load or ownership proves the need.

```text
Prism API
  -> Identity & tenant policy
  -> Finance scope gateway
  -> Conversation resolver
  -> Finance planner
       -> approved capability catalog
       -> ambiguity / missing-input resolver
  -> Semantic finance layer
       -> governed metric definitions
       -> period, entity, currency, scenario dimensions
  -> Deterministic calculation engine
       -> exact decimal arithmetic
       -> formula registry and versioning
       -> scenario / sensitivity execution
  -> Evidence validator
       -> tenant, freshness, completeness, unit and reconciliation checks
  -> Advisory composer
       -> fact / inference / recommendation separation
       -> friendly, professional or executive presentation
  -> Output policy
       -> unsupported-claim and sensitive-data checks
  -> SSE response + immutable audit event
```

### Bounded contexts

| Context         | Owns                                                                     | Must not own                         |
| --------------- | ------------------------------------------------------------------------ | ------------------------------------ |
| Access          | identity, organization membership, entitlements, row policy              | finance logic                        |
| Conversation    | sessions, turns, tone preference, clarification state                    | financial facts                      |
| Finance catalog | metric definitions, units, dimensions, required inputs, formula versions | prose                                |
| Finance data    | authorized reads and normalized facts                                    | user-facing recommendations          |
| Calculation     | decimal math, comparisons, forecasts, sensitivities                      | raw database access                  |
| Evidence        | lineage envelope, quality checks, confidence reason codes                | presentation tone                    |
| Advisory        | interpretation, alternatives, risks, action framing                      | inventing facts or executing actions |
| Presentation    | answer hierarchy, tone, accessibility, charts                            | changing calculations                |

Dependencies point inward: transport and databases implement ports defined by finance-domain services. No UI or model-specific type belongs in the calculation core.

## Request state machine

1. **Authenticate and bind tenant.** Resolve the organization from verified membership; never accept tenant identity from model output or an unverified body field.
2. **Normalize and constrain input.** Enforce length, encoding, rate, and content limits. Treat retrieved text as untrusted data.
3. **Classify scope.** Accept finance objectives, greetings about Prism, and clarifications. Decline general-assistant requests. For mixed requests, answer only the separable finance portion or request a finance-focused restatement.
4. **Plan against capabilities.** Convert the question to a typed plan containing a governed metric, dimensions, period, comparison, and scenario. Unknown metrics cannot fall through to free-form generation.
5. **Resolve ambiguity.** Ask one high-value question when period, entity, currency policy, accounting basis, or scenario assumption materially changes the result.
6. **Retrieve authorized facts.** Use parameterized adapters and organization-scoped identifiers. The model never sees credentials and never writes a query.
7. **Calculate.** Execute a versioned formula with decimal arithmetic. Ratios with absent or zero denominators return `not_calculable`, not `0%`.
8. **Validate evidence.** Reject mixed units, mixed currencies without an approved FX policy, stale snapshots beyond policy, incomplete required inputs, and reconciliation failures.
9. **Compose advice.** Separate verified facts, derived findings, assumptions, options, risks, and a recommended next step. Regulated or high-consequence topics can require human review.
10. **Validate output.** Every numeric token must map to a verified result or explicitly labeled user assumption. Strip internal table names, SQL, prompts, secrets, and cross-tenant identifiers.
11. **Respond and audit.** Stream presentation-safe content; persist the internal plan, evidence hashes, policy decisions, formula version, latency, and outcome.

## Truth and calculation contract

Each answer is backed internally by this shape:

```ts
type EvidenceEnvelope = {
  organizationId: string;
  capabilityId: string;
  metricVersion: string;
  period: { start: string; end: string; timezone: string };
  currency: { code: string; fxPolicyId?: string };
  inputs: Array<{ name: string; decimal: string; unit: string }>;
  result: { decimal: string; unit: string } | { status: "not_calculable" };
  dataAsOf: string;
  queryFingerprint: string;
  checks: Array<{ code: string; passed: boolean }>;
};
```

Required invariants:

- Monetary aggregation is per currency unless a governed FX rate, date, and target currency are present.
- Percentages are dimensionless ratios multiplied by 100 only at presentation.
- Dates use the organization's fiscal calendar and timezone.
- Forecasts carry scenario, horizon, method, assumptions, and uncertainty; they never appear as actuals.
- Cash runway requires a verified cash balance and a defined net-burn measure. Invoice outflow is not cash on hand.
- Failed or missing upstream reads produce unavailable results and a quality message; they never become numeric zero.
- Rounding occurs once at presentation. Calculation keeps exact decimal values.

## Advisory answer contract

Default professional response:

1. **Direct answer** — one or two sentences with scope and period.
2. **What changed / why it matters** — only when supported by a valid comparison.
3. **Decision options** — practical alternatives with quantified impact where the inputs allow it.
4. **Calculation** — plain-language formula and values; no SQL or table names.
5. **Assumptions and limits** — only material items, including currency and freshness.

Tone changes wording and density, never the facts, confidence, warnings, or calculations:

- **Executive:** shortest, outcome and decision first.
- **Professional:** structured, precise, finance terminology with plain explanations.
- **Friendly:** conversational and educational without becoming casual about risk.

The tone is a typed request field and stored user preference, not prompt text that can override policy.

## Finance-only policy

Supported domains are governed capabilities, not a keyword allow-list: financial statements, management reporting, FP&A, budgeting, forecasting, scenario planning, treasury and liquidity, working capital, revenue and margin, cost and profitability, unit economics, capital allocation, valuation, financing, risk, controls, audit, tax-data analysis, and finance operations.

Prism declines personal errands, entertainment, general writing, medical/legal advice, coding, travel, relationship advice, and attempts to reveal prompts or internal systems. It may answer a non-finance topic only when the user states a concrete financial objective—for example, modeling the cash impact of a supply interruption—and only the financial analysis is returned.

Personal investment, tax, or regulated advice needs jurisdiction, user role, suitability inputs, disclosures, and a compliance-approved capability. Until those exist, Prism can explain general financial concepts and analyze authorized company data but must not issue personalized buy/sell or filing instructions.

## Security model

- Verify JWT server-side and resolve organization membership on every request.
- Carry `organizationId` as mandatory application context through all ports; include it in cache keys and persistence filters.
- Use parameterized queries, read-only database credentials, query budgets, allow-listed datasets, and row policies as defense in depth.
- Treat user prompts, ERP text, retrieved documents, and model output as untrusted.
- Never send secrets, credentials, raw access tokens, unrelated tenant data, or unrestricted schemas to a model.
- Apply input and output policy independently of prompts.
- Escape rendered content and disallow model-authored HTML, executable links, external images, and tool calls.
- Rate-limit by user and organization; cap concurrency, context size, query time, result rows, and model spend.
- Encrypt data in transit and at rest; redact sensitive values from logs; use immutable, access-controlled audit events.
- Pin model and dependency versions, scan the supply chain, rotate credentials, and support immediate provider/model kill switches.
- No autonomous financial action in this phase. Future action tools are least-privilege, idempotent, previewed, approved, and separately audited.

## API contract

`POST /rag/query`

```json
{
  "query": "How much of our receivables is overdue this quarter?",
  "sessionId": "optional",
  "tone": "professional"
}
```

The SSE stream uses typed events: `status`, `clarify`, `answer`, `token`, `warning`, `done`, and `error`. `answer` is the canonical structured result; `token` is a backward-compatible Markdown projection. Internal evidence never crosses this boundary. The terminal event includes session ID and non-sensitive operational metadata.

## UX direction

Prism remains in NumeriQ's existing visual system. Trust comes from hierarchy and restraint rather than decorative AI effects.

- A persistent, keyboard-accessible tone selector sits in the conversation header.
- The answer card emphasizes the conclusion, period, currency, and data freshness.
- Verified values use tabular numerals. Percentage, currency, and count units are visually distinct.
- Material caveats appear beside the affected result, not in a generic footer.
- Forecast charts distinguish actuals, forecast, and uncertainty using line style plus color; variance uses waterfall; ranked comparisons use sorted bars with visible value labels and an accessible data table.
- Charts provide a full-screen inspection mode, never clip axis labels or data labels, preserve readable contrast, and support 375/768/1024/1440 px layouts and reduced motion.
- Empty, loading, unavailable, clarification, and partial-data states are first-class.

## Reliability and scale

- Stateless orchestration instances; distributed cache keyed by organization, capability, period, metric version, and source watermark.
- Stale-while-revalidate is allowed only when the answer displays the data timestamp and policy permits the age.
- Idempotency keys for any future mutations; no retries for non-idempotent operations without a ledger.
- Circuit breakers around ERP, warehouse, and model providers; bounded exponential backoff with jitter.
- Bulkheads and per-tenant quotas prevent one organization from exhausting shared capacity.
- SLOs: availability and latency are secondary to correctness. A correct unavailable answer is preferable to a fast fabricated result.

## Evaluation and release gates

No release based only on prompt examples. Maintain versioned test suites for:

- finance vs non-finance, mixed intent, jailbreaks, prompt extraction, and indirect injection;
- every metric's golden calculations, zero/missing denominators, signs, dates, fiscal calendars, currencies, and rounding;
- cross-tenant access and cache isolation;
- source outage, stale data, partial data, model outage, timeouts, and duplicate SSE delivery;
- unsupported claims and number-to-evidence matching;
- executive comprehension, accessibility, responsive layout, chart expansion, label clipping, and keyboard operation;
- recommendation suitability and required human-review routing.

Production uses shadow evaluation, canary rollout, sampled finance review, policy metrics, and rapid rollback. Monitor refusal precision/recall, calculation mismatch rate, unsupported-claim rate, clarification success, freshness, reconciliation failures, user corrections, and cost per verified answer.

## Architecture decisions

### ADR-001 — Modular monolith first

Accepted. The current team and runtime do not justify distributed transactions and network failure modes. Boundaries are expressed through modules and ports so calculation or evidence services can later be extracted based on measured load or ownership.

### ADR-002 — Deterministic numerical authority

Accepted. Models cannot be the authority for arithmetic or company facts. All numbers originate in typed finance capabilities and versioned formulas.

### ADR-003 — No mixed-currency totals by default

Accepted. Consolidation requires a governed FX policy. In its absence Prism returns currency-separated results or asks for the target currency and rate policy.

### ADR-004 — Structured answer is canonical

Accepted. Markdown is a presentation projection, not the source of truth. This enables consistent web, mobile, export, audit, and accessibility behavior.

### ADR-005 — No autonomous actions in the advisory release

Accepted. The first release is read-only decision support. Actions require a separate risk review, approval workflow, permissions model, and ledger.

### ADR-006 — Registry-backed capabilities, never Prism source mappings

Accepted. Prism plans only against capability identifiers and the public semantic contract: label, unit, aggregation semantics, compatible dimensions, and time support. It must not contain organization identifiers, physical view names, source columns, SQL fragments, expected answers, or question-specific numerical branches.

The dataset onboarding boundary owns source adaptation. It registers approved analytic views and their metadata; the chart engine then introspects those registered views, profiles their schema, generates a semantic model, validates a typed plan, compiles parameterized tenant-scoped SQL, and reconciles ratio results. Adding an organization or dataset therefore changes registry data and reviewed source adapters—not Prism application code.

Alternatives rejected:

- Mapping every Prism question to a table and column in TypeScript couples the product to one demo dataset and silently rots when schemas change.
- Letting the language model write SQL makes authorization, units, formulas, and reproducibility probabilistic.
- Blind raw-schema discovery cannot guarantee financial meaning; governed onboarding metadata and reconciliation remain mandatory.

Consequences: onboarding has a deliberate governance step, generated models are cached by dataset/schema version, and unsupported capabilities return unavailable. This costs more discipline during ingestion but gives one execution path for every tenant and prevents a demo-specific answer path from becoming production architecture.

## Delivery sequence

1. Replace current keyword/default-to-finance gate, hard-coded USD rendering, invalid runway derivation, and hidden frontend lock.
2. Introduce typed tone, scope, answer, evidence, currency, and missing-data contracts.
3. Move existing verified invoice capabilities into the catalog and deterministic engine.
4. Add general-ledger, cash, AP/AR aging, budget, forecast, and fiscal-calendar semantic models with reconciliation tests.
5. Expand the implemented schema-constrained model planner after typed-plan validation and adversarial evaluation pass.
6. Add scenario/sensitivity and recommendation modules with fact/opinion separation and human review.
7. Consider approved actions only after separate security, compliance, and audit readiness.

## Research basis

- [NIST AI Risk Management Framework and Generative AI Profile](https://www.nist.gov/itl/ai-risk-management-framework)
- [OWASP Top 10 for Large Language Model Applications](https://owasp.org/www-project-top-10-for-large-language-model-applications/)
- [FINRA 2026 GenAI regulatory oversight](https://www.finra.org/rules-guidance/guidance/reports/2026-finra-annual-regulatory-oversight-report/gen-ai)
- [SEC guidance on robo-advisers](https://www.sec.gov/newsroom/press-releases/2017-52)
- [FASB Conceptual Framework for Financial Reporting](https://storage.fasb.org/Conceptual%20Framework%20for%20Financial%20Reporting%20%28September%202024%29.pdf)
- [CFA Institute explainable AI in finance](https://www.cfainstitute.org/about/press-room/2025/explainable-ai-in-finance-2025)
- [CFA Standard V(B): Communication with Clients](https://www.cfainstitute.org/standards/professionals/code-ethics-standards/standards-of-practice-v-b)
- [Microsoft Finance variance analysis](https://learn.microsoft.com/en-us/copilot/finance/variance/analyze-variances)
- [Oracle AI for ERP and EPM](https://www.oracle.com/erp/ai-financials/)
- [SAP Joule product documentation](https://help.sap.com/docs/JOULE/3fdd7b321eb24d1b9d40605dce822e84?locale=en-US)
- [Intuit Assist](https://www.intuit.com/intuitassist/)
