# Prism Benchmark Progress

## Status: Phases 1–8 implemented; production rollout pending

## Quick Reference

- Research: `docs/prism/RESEARCH.md`
- Architecture: `docs/prism/architecture.md`
- Implementation: `docs/prism/IMPLEMENTATION.md`
- Audit: `docs/prism/AUDIT.md`

## Phase Progress

### Phase 1: Critical trust and usability fixes

**Status:** Completed

#### Decisions Made

- Preserve the deterministic finance engine.
- Enforce application-layer tenant predicates immediately; database policies
  remain an additional mandatory production control.
- Use typed evidence summaries rather than fabricated confidence scores.
- Bound interactive streams and expose cancellation in the UI.
- Route organizations by detected, tenant-scoped finance capabilities rather
  than brittle organization IDs or registry presence alone.
- Fail deployment unless the complete finance-semantic suite, type checks, and
  production builds pass.

#### Blockers

- Database row-policy activation requires coordinated ClickHouse operator
  configuration; application-level scoping can be completed in code.
- Jest's third-party/runtime handles do not terminate naturally after the suite;
  CI uses `--forceExit` after all assertions complete while the leak is isolated.

### Phases 2–8

**Status:** Application implementation completed

- Added versioned planning, policy, semantic, evidence, and answer contracts.
- Replaced Prism's implicit model interception with a typed provider gateway.
- Added structured KPI, chart, full-screen inspection, exact data table, and
  responsive scenario experiences.
- Added multilingual/adversarial policy evaluations and unit/output validators.
- Added Redis/source-watermark caching, single-flight, workload bulkheads,
  OpenTelemetry spans, and runtime SLO snapshots.
- Added durable jobs, transactional outbox records, skip-locked briefing worker,
  idempotent submission, and stable failure codes.
- Added proactive verified opportunities, exact-decimal scenario calculations,
  and preview-only action proposals with a four-eyes approval ledger.
- Added dedicated Prism QA and database-contract CI gates.
- Passed 28 API suites / 642 tests, Prisma schema validation, workspace type
  checks, API build, and production web build.
- Verified the live monthly revenue chart in the production build at 1440×1000
  and 390×844, including full-screen expansion, responsive tick density,
  currency tooltips, borders, and the exact accessible data table.

#### Production rollout requirements

- Apply the new PostgreSQL migration through the normal release process.
- Deploy and supervise independent Prism worker replicas.
- Configure Redis and the OpenTelemetry exporter.
- Run warehouse row-policy canaries, recovery exercises, load tests, and sampled
  finance review before broad enablement.

## Session Log

### 2026-07-22

- Completed benchmark audit and live desktop/mobile validation.
- Began Phase 1 implementation.
- Added tenant predicates to every legacy Prism query.
- Added deterministic semantic-cube routing, verified evidence summaries,
  cancellation, bounded analysis time, DTO validation, and responsive history.
- Corrected governed gross-margin and cost-per-employee semantics and removed
  fabricated cross-grain ratios.
- Verified a live demo answer in-browser: all-time revenue `$131.56M`, sourced
  from the tenant-scoped governed cube and rendered without horizontal overflow.
- Verified desktop at 1440×1000 and mobile at 390×844, including the off-canvas
  conversation drawer.
- Passed API build, web type-check, and all 614 API/finance-semantic tests.
