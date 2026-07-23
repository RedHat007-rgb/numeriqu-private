# Prism Benchmark Implementation Plan

## Overview

Build Prism into a trustworthy financial decision workspace while preserving the
existing deterministic calculation engine. Each phase must pass its success gate
before dependent work is considered complete.

## Phase Summary

1. Critical trust and usability fixes
2. Architecture boundaries and typed contracts
3. Decision-workspace UI modernization
4. AI policy, evaluation, and model gateway
5. Performance and distributed caching
6. Scale, workers, and workload isolation
7. Developer experience and delivery safety
8. Proactive finance innovation

## Phase 1: Critical trust and usability fixes

### Tasks

- [x] Enforce tenant predicates on every Prism analytics query
- [x] Add bounded/cancellable streaming requests
- [x] Repair mobile composition and accessibility fundamentals
- [x] Emit and render a structured, customer-safe evidence summary
- [x] Add CI quality gates

### Success Criteria

No unscoped Prism read; no indefinitely running interactive request; readable at
390px; accessible composer and controls; verified answers show freshness and
validation state; deployment cannot precede checks.

## Phase 2: Architecture boundaries and typed contracts

- [x] Extract policy, planning, calculation, evidence, and presentation ports
- [x] Remove global model-fetch interception from Prism
- [x] Version semantic, model, prompt, and policy contracts
- [x] Isolate Prism ownership from the legacy agent runtime

## Phase 3: Decision-workspace UI modernization

- [x] Structured answer canvas, KPI cards, charts, evidence, and actions
- [x] Responsive conversation drawer and mobile executive view
- [x] Complete loading, empty, partial, error, and success states
- [x] Accessible chart inspection and data-table alternatives

## Phase 4: AI policy, evaluation, and model gateway

- [x] Layered finance/risk classification and output validation
- [x] Typed provider gateway with budgets, retries, and data classification
- [x] Versioned golden, adversarial, multilingual, and regression evaluations
- [x] Human review boundary for consequential actions

## Phase 5: Performance and distributed caching

- [x] Distributed cache with source-watermark invalidation and single-flight
- [x] Precomputed semantic catalogs and deterministic fast paths
- [x] Latency and availability SLOs with trace-based profiling

## Phase 6: Scale, workers, and workload isolation

- [x] Durable job and outbox architecture
- [x] Separate briefing worker integrated with existing ingestion and board-pack services
- [x] Backpressure, bulkheads, and noisy-neighbor tests
- [x] ClickHouse/Postgres recovery runbook and rollout gates

## Phase 7: Developer experience and delivery safety

- [x] Keep generated artifacts excluded and consolidate Prism QA tooling
- [x] Reuse local infrastructure and seeded golden tenants
- [x] Version contracts, ADRs, ownership boundaries, and CI validation
- [x] Document staged rollout and recovery requirements

## Phase 8: Proactive finance innovation

- [x] CFO briefings and continuous signal opportunities
- [x] Scenario/sensitivity workspace
- [x] Evidence-linked board packs and collaborative review
- [x] Governed action previews and approval ledger
