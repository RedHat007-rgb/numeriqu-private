# Prism Benchmark Audit

Audit date: 2026-07-22  
Perspective: customer, CFO, product, design, engineering, security, operations,
and investor diligence.

The original experience was visually polished but not yet trustworthy enough to
become a financial system of decision. The principal weakness was not the model;
it was the absence of a single typed truth contract from tenant-scoped data to
calculation, evidence, presentation, and action. The implementation in this
change addresses the release-critical items below. Production controls that need
infrastructure credentials or operator coordination remain explicit rollout
requirements rather than being represented as active.

| Severity | Current state / finding | Why it is a problem | Impact | Recommended solution | Alternative solutions | Complexity | Expected ROI | Priority | Resolution |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Critical | Some legacy analytics reads relied on upstream identifiers without an application tenant predicate. | A missed filter can become cross-tenant disclosure. | Existential security and trust risk. | Mandatory organization scope in every adapter plus warehouse row policy. | Separate database per tenant; schema per tenant. | High | Very high | P0 | Application scoping complete; row-policy rollout is operator-gated. |
| Critical | Model planning and provider routing were coupled to global fetch interception. | Behavior was implicit, difficult to test, and vulnerable to unrelated provider changes. | Reliability and security regressions. | Typed provider gateway with schema-constrained output, budget, retry, timeout, and data class. | Provider SDK abstraction; dedicated model proxy. | Medium | Very high | P0 | Complete. |
| Critical | Missing values could be coerced into zero and stored ratios could be formatted as percentage points incorrectly. | A zero and an unavailable value mean different business outcomes; `0.425` must display as `42.5%`. | Wrong executive decisions. | Unit-aware presenter, exact normalization once, output validator, regression evaluations. | Format entirely in semantic layer. | Medium | Very high | P0 | Complete and tested. |
| Critical | Consequential requests did not have a durable human-review boundary. | Advice and action require different authority. | Regulatory, financial, and operational risk. | Read-only policy gate plus preview-only action proposals and append-only approval events; proposer cannot approve. | External workflow engine. | High | Very high | P0 | Complete in code; no autonomous execution exists. |
| High | Markdown was the practical answer contract. | Web, mobile, export, accessibility, and audit could disagree. | Inconsistent experiences and fragile clients. | Versioned structured answer envelope with Markdown as compatibility projection. | GraphQL union; JSON:API resource model. | Medium | High | P1 | Complete. |
| High | Charts did not have a guaranteed accessible alternative or unit-safe axis behavior. | Labels can clip and unlike units on one axis mislead. | Low comprehension and accessibility failure. | Full-screen inspection, generous margins, unit-aware labels/tooltips, mixed-unit table fallback, accessible data table. | Dual axes after semantic compatibility review. | Medium | High | P1 | Complete; browser verification is part of release gates. |
| High | Long-running work shared the interactive request lifecycle. | Expensive briefings and exports can exhaust API capacity. | Latency spikes and noisy-neighbor failures. | Durable job ledger, transactional outbox, skip-locked worker claims, idempotency, and separate worker process. | Managed queue service; BullMQ. | High | High | P1 | Core and briefing worker complete; production replicas require deployment. |
| High | Process-local caching could return inconsistent performance across replicas. | Scale-out loses cache efficiency and stampede control. | Higher latency and provider cost. | Redis cache keyed by tenant, capability, period, semantic version, and source watermark with single-flight and bounded fallback. | CDN for public data; database materialized cache. | Medium | High | P1 | Complete. |
| High | Finance-domain, prompt-extraction, and regulated-advice behavior was example-driven. | Prompt changes can silently reopen unsafe paths. | Hallucination and policy regression. | Versioned multilingual, adversarial, unit, and consequential-action evaluation suites in CI. | External evaluation platform in addition to repository tests. | Medium | High | P1 | Complete; shadow production evaluations remain rollout work. |
| High | Interactive traffic lacked explicit workload isolation. | One organization can monopolize shared compute. | Poor availability at scale. | Global and per-organization bulkheads with configuration and health telemetry. | Token bucket in API gateway; dedicated enterprise pools. | Medium | High | P1 | Complete. |
| Medium | The answer UI lacked an immediate path from insight to a quantified what-if. | Users had to restate values and risk transcription errors. | Lower decision velocity. | Verified baseline scenario modeler using exact decimal compounding and clearly labeled user assumptions. | Spreadsheet export; notebook integration. | Medium | High | P2 | Complete. |
| Medium | Proactive finance intelligence was separated from the Prism entry state. | Users had to know what question to ask. | Lower engagement and missed risks. | Tenant-scoped verified signal suggestions and durable CFO briefing generation. | Scheduled email only; static dashboard alerts. | Medium | High | P2 | Complete using the existing signal evidence system. |
| Medium | Operational metrics lacked request-level trace correlation. | Failures were slower to diagnose and aggregate logs were ambiguous. | Longer recovery time. | OpenTelemetry request spans plus non-sensitive request IDs, latency, cache, and workload snapshots. | Vendor-specific tracing SDK. | Low | High | P2 | Complete at instrumentation boundary; exporter configuration is operational. |
| Medium | Mobile conversation history consumed permanent width and charts were optimized for desktop. | Core interaction became cramped below tablet width. | Poor mobile completion and accessibility. | Off-canvas history, responsive answer cards, touch-sized controls, chart expansion, and scroll-safe tables. | Separate native mobile application. | Medium | Medium | P2 | Complete. |
| Medium | Delivery checks did not explicitly validate Prism contracts or Prisma schema. | A passing application build could still ship a policy or migration regression. | Avoidable deployment failures. | Dedicated Prism QA command, schema validation, complete tests, type checks, and builds in CI. | Contract service in a separate repository. | Low | High | P2 | Complete. |
| Medium | The legacy agent and Prism still coexist in large modules. | Ownership remains harder to understand and Jest inherits legacy open handles. | Slower onboarding and noisy tests. | Continue extracting shared finance catalog adapters and remove legacy lifecycle coupling after parity. | Immediate rewrite. | High | Medium | P3 | Prism boundary is isolated; legacy retirement remains deliberate follow-up. |
| Low | Some third-party packages report deprecations or peer-range warnings. | They increase future upgrade friction even when current tests pass. | Developer experience and maintenance cost. | Track dependency upgrades with visual and semantic regression gates. | Freeze versions indefinitely. | Medium | Medium | P3 | Recorded; not silently upgraded in this change. |

## UX findings by state

- Loading now explains the stage and remains cancellable; it does not imply a
  calculation has completed.
- Empty state now offers verified tenant opportunities when available and
  finance-domain examples otherwise.
- Partial and unavailable states never render a numeric zero.
- Success leads with KPI cards, then the chart/table, evidence, scenario, and
  decision actions.
- Chart expansion is a real dialog with Escape close, keyboard focus, a larger
  plotting area, unit-aware labels, and the exact table below it.
- Mobile history is a dialog drawer rather than a permanently compressed column.

## Investor conclusion

Prism's defensible layer is the governed path between authorized finance data
and an inspectable decision—not a generic chat prompt. The implemented design
can scale horizontally and can evolve into separate services when measured load
or ownership requires it. The largest remaining business risks are operational:
warehouse row-policy rollout, worker capacity planning, recovery exercises,
production evaluation sampling, and dependency lifecycle management.
