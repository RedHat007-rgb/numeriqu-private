# Numeriqu Architecture (Diagrams + Flow)

This doc is the “flow chart” companion to `docs/architecture-log.md` and `docs/database-schema-numeriqu.md`.

## 1) System / Container view

```mermaid
flowchart LR
  user["User"] --> web["apps/web (Next.js)"]

  web --> api["apps/api (NestJS)"]

  subgraph Transactional["Transactional boundary (Postgres)"]
    pg["Postgres (Supabase Postgres)"]
    redis["Redis (OTP + rate limits)"]
  end

  subgraph Analytics["Analytics boundary (ClickHouse + dbt)"]
    ch_raw["ClickHouse (raw/provider tables)"]
    dbt["packages/analytics (dbt)"]
    ch_gold["ClickHouse (analytics.* Gold models)"]
    ch_raw --> dbt --> ch_gold
  end

  subgraph Identity["Identity + delivery"]
    supa["Supabase Auth (JWT/session)"]
    resend["Resend (OTP email)"]
  end

  subgraph AI["AI runtime"]
    ollama["Ollama (LLM)"]
  end

  api --> pg
  api --> redis
  api --> ch_gold
  api --> supa
  api --> resend
  api --> ollama

  api --> qb["QuickBooks API"]
  api --> xero["Xero API"]
  api --> airbyte["Airbyte API (optional)"]
  qb --> ch_raw
  xero --> ch_raw
  airbyte --> ch_raw
```

What this enables:
- Postgres stays the source of truth for auth/org/messaging/dashboard metadata + audit trails.
- ClickHouse + dbt becomes the “facts engine” for dashboards + RAG/Agent reads (Gold models).
- Agent/RAG are tool-driven (query ClickHouse) and write only metadata back to Postgres.

## 2) Auth flow (Resend OTP → Supabase session)

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant W as apps/web
  participant A as apps/api
  participant R as Redis
  participant E as Resend
  participant S as Supabase Auth

  U->>W: Enter email (and account type)
  W->>A: POST /auth/send-otp
  A->>R: Store hashed OTP (TTL) + throttles
  A->>E: Send OTP email
  E-->>U: OTP delivered

  U->>W: Enter OTP
  W->>A: POST /auth/verify-otp
  A->>R: Verify OTP + burn token
  A->>S: Create/sign-in session (server-side)
  A-->>W: Set HTTP-only cookies (access/refresh)
  W-->>U: Redirect to dashboard
```

Notes:
- Client never talks to Supabase directly; the API issues/refreshes sessions and sets HTTP-only cookies.
- `SUPABASE_INTERNAL_AUTH_SECRET` is security-critical (used to derive deterministic service passwords) — treat it like a production secret with rotation.

## 3) Data pipeline flow (providers → ClickHouse → dbt → Gold)

```mermaid
flowchart LR
  qb["QuickBooks"] --> ingest["Ingestion (API worker / Airbyte)"]
  xero["Xero"] --> ingest
  ingest --> bronze["ClickHouse Bronze (raw)"]
  bronze --> silver["dbt Silver (staging/*)"]
  silver --> gold["dbt Gold (marts/*)"]

  gold --> api["apps/api analytics + rag + agent"]
  api --> web["apps/web dashboards + AI"]
```

Operational “gotchas” to plan for:
- Freshness SLAs: define what “data is live” means (sync cadence + dbt run cadence + lag budgets).
- Backfills: re-running dbt models for historical fixes should be safe + auditable per connection.
- Multi-tenant isolation: ClickHouse queries should always filter by `connection_id` and/or `org_id` scope.

## 4) Agent dashboard generation flow (charts “generation”)

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant W as apps/web (Agent UI)
  participant A as apps/api (Agent module)
  participant C as ClickHouse (Gold)
  participant O as Ollama (Planner)
  participant P as Postgres (Prisma)

  U->>W: Ask question (e.g. "top clients overdue")
  W->>A: POST /agent/query (SSE)
  A->>P: Create session + request/run (audit)
  A->>C: Build live data context (fast preflight)
  A->>O: Planner prompt (constrained chart vocabulary)
  O-->>A: Plan: tools + widget specs
  A->>C: Execute tools in parallel
  C-->>A: Results
  A->>P: Create dashboard + widgets (metadata)
  A-->>W: Stream: phases, tool previews, dashboard created
```

Why this is a “modern” pattern:
- The LLM is constrained (fixed widget vocabulary + allowed tools).
- Planning is separated from execution (tool calls are deterministic).
- Writes are auditable (request/run/event trail), and permissions can block dashboard creation.

## 5) Suggested improvements (roadmap)

If you want your architecture to match what top startups ship *in production*, these are the highest leverage next steps:

1. **Observability + incident readiness**
   - OpenTelemetry tracing (API → DB/ClickHouse/Redis/Resend/Ollama), dashboards + alerts, structured logs with `traceId`.
2. **Background jobs for ingestion and heavy work**
   - Queue + workers (BullMQ/Temporal/etc.) for provider sync, dbt runs, and “refresh dashboard” work (instead of request-thread execution).
3. **Data freshness contracts**
   - Per-connection last-sync + last-dbt-run timestamps, and UI messaging that reflects reality (avoid “live” when stale).
4. **Multi-org UX + strict context propagation**
   - First-class org switch in UI; always send `x-organization-id`; consider “active org” cookie and server validation.
5. **Hardening LLM ops**
   - Timeouts + retries + circuit breakers for Ollama, plus fallbacks that are user-visible (“degraded mode”).
6. **Test coverage where it matters**
   - E2E for auth + invite flows, and integration tests for org isolation in ClickHouse queries.
