# Architecture Log

## 2026-05-04 - Step 1: Complete PostgreSQL schema foundation

### What was implemented
- Replaced `packages/db/prisma/schema.prisma` with a full organization-first data model covering:
  - Users + Supabase identity mapping + verification tokens + OTP
  - Organizations + memberships + invites + granular permission grants
  - ERP connections + sync schedules + sync jobs
  - Financial normalized tables + source traceability mappings
  - Dashboards + widgets + sharing
  - Organization-bound messaging with edit history and soft delete
  - RAG chat storage (separate tables)
  - Agent chat/request/run storage (separate tables)
- Added `docs/database-schema-numeriqu.md` with:
  - ER diagram (text)
  - table grouping and definitions
  - relationships and integrity rules
  - index strategy
  - multi-tenant isolation strategy

### Why
- Existing schema only partially covered tenants/connections/dashboard/chat and did not satisfy strict separation between messaging, RAG, and agent layers.
- The product requires production-grade org isolation and traceability across ERP-normalized finance data.
- Supabase/Resend auth responsibilities require app-owned verification storage.

### Tradeoffs
- Enforced broad explicitness in schema to reduce hidden coupling, at the cost of a larger initial model.
- Kept dashboard minimum chart count as application-level validation (to be enforced in service/API validation in next step) instead of adding DB trigger complexity at schema step.
- Kept role + capability flags + permission grant rows for both fast checks and future extensibility.

### Risks
- Migration generation/deployment is not yet executed in this step; schema compile and migration rollout must be validated against runtime DB in next step.
- Some invariants (example: DM participant cardinality=2, minimum 4 dashboard charts) are not DB-trigger-enforced yet and must be guaranteed in application validation/services.
- Existing code depending on prior model names may require service-layer updates after schema approval.

## 2026-05-04 - Auth hardening: Supabase session-only + Resend OTP

### What was implemented
- Added a dedicated NestJS auth module at `apps/api/src/modules/auth/` with:
  - `POST /auth/send-otp`
  - `POST /auth/verify-otp`
  - `POST /auth/resend-otp`
  - `POST /auth/logout`
- Implemented Redis-backed OTP storage (5-minute expiry), hashed OTP verification, resend throttling (`max 5/hour`), and brute-force protection.
- Implemented Resend email delivery for OTP with a clean HTML template.
- Implemented backend-only Supabase session issuance after OTP verification; frontend no longer calls Supabase SDK.
- Set HTTP-only cookies (`numeriqu_access_token`, `numeriqu_refresh_token`) on successful verification.
- Updated `SupabaseAuthGuard` to accept bearer token OR secure access token cookie.
- Replaced web login/signup with OTP-only flow (6-box OTP input, resend timer, error states), and removed frontend Supabase usage.

### Why
- Enforces a single auth authority in backend while keeping Supabase limited to token/session issuance.
- Aligns with requirement to avoid Supabase OTP/magic links and use Resend + Redis for verification.
- Reduces client-side auth complexity and secret exposure.

### Tradeoffs
- Session issuance uses backend deterministic service password per email to create Supabase sessions without frontend SDK.
- Middleware now checks cookie presence for route gating; strict token validity is still enforced by backend guard.
- Existing non-auth compile issues remain in legacy provisioning/schema-dependent areas and were not changed in this step.

### Risks
- Deterministic service-password strategy requires strong `SUPABASE_INTERNAL_AUTH_SECRET` rotation policy and incident playbook.
- Cookie-only route checks in Next middleware can allow stale-cookie redirects until backend call rejects unauthorized requests.
- Redis availability directly impacts OTP send/verify flow; production should add monitoring/alerts and fallback handling.

## 2026-05-04 - Layered v2 backend-first migration on modern schema

### What was implemented
- Added modern, layered backend modules in `apps/api/src/modules/`:
  - `org-context` for organization-aware request context provisioning
  - `auth` (OTP + session + `/auth/me` + provider connect endpoints)
  - `integrations` (connections/jobs/sync/delete on `erp_connections` + `sync_jobs`)
  - `analytics` (dashboard KPIs/charts computed from normalized financial tables)
  - `rag` (independent chat sessions/messages and SSE query route)
  - `agent` (independent chat sessions/messages, dashboard generation, metrics, SSE query route)
- Replaced `apps/api/src/app.module.ts` imports to use the layered v2 modules and removed legacy runtime wiring from the application root.
- Updated global error filter to enforce structured error contract:
  - `{ message, code, traceId }`
- Updated frontend API transport behavior for cookie-based auth and optional bearer token:
  - request APIs now include `credentials: include`
  - SSE transport supports cookie-backed auth when token is absent
- Regenerated Prisma client from the modern schema and validated:
  - `pnpm --filter @repo/db db:generate`
  - `pnpm --filter api build`
  - `pnpm --filter web check-types`

### Why
- The codebase had a modern schema but mostly legacy model usage (`tenant`, `connection`, `chatSession`, `insight`) causing compile/runtime mismatch.
- The layered architecture requirement demanded strict separation of auth, messaging/AI, and domain concerns with clear module boundaries.
- Backend-first migration was required before frontend API caller migration to avoid contract drift.

### Tradeoffs
- Implemented a clean v2 module path while constraining API build scope via `tsconfig.build.json` include list to avoid compiling legacy modules during migration.
- Preserved existing frontend contract shapes for compatibility while backing them with modern schema data.
- Kept RAG/Agent query logic deterministic and database-grounded in this pass to prioritize correctness/isolation over advanced LLM orchestration.

### Risks
- Legacy modules still exist in repository and can diverge if modified without migration policy; they are currently out of active build path.
- ERP provider OAuth orchestration endpoints are compatibility-focused in this pass and require full provider-specific hardening before broad production rollout.
- Further integration/E2E tests are needed for full cross-module scenarios (invites, permissions matrix, dashboard sharing in chat, agent-run observability).

## 2026-05-04 - Completion pass: organization/invites, dashboards, messaging

### What was implemented
- Added modern organization domain APIs:
  - `GET /organizations/current`
  - `GET /organizations/members`
  - `GET /organizations/invites`
  - `POST /organizations/invites`
  - `POST /organizations/invites/:id/resend`
  - `DELETE /organizations/invites/:id`
  - `POST /organizations/invites/accept`
  - `PATCH /organizations/members/:membershipId/permissions`
  - `DELETE /organizations/members/:membershipId/permissions/:permission`
- Implemented invite lifecycle against `organization_invites` with token hashing, expiry handling, accept/revoke/resend semantics, and Resend delivery.
- Added modern dashboard APIs with permission checks:
  - `GET /dashboards`
  - `GET /dashboards/:id`
  - `POST /dashboards` (enforces minimum 4 charts)
  - `PATCH /dashboards/:id/refresh`
  - `POST /dashboards/:id/share`
  - `DELETE /dashboards/:id/share/:userId`
- Added modern messaging APIs (org-bound, participant-bound, soft-delete/edit history):
  - `GET /messaging/conversations`
  - `POST /messaging/conversations/dm`
  - `POST /messaging/conversations/group`
  - `GET /messaging/conversations/:id/messages`
  - `POST /messaging/conversations/:id/messages`
  - `PATCH /messaging/messages/:id`
  - `DELETE /messaging/messages/:id`
- Hardened org-context service with reusable authorization guards:
  - membership check
  - admin check
  - granular permission check (`VIEW_DASHBOARD`, `CREATE_DASHBOARD`, `SHARE_DASHBOARD`)

### Why
- The modern schema already modeled these domains, but service/API layer coverage was incomplete.
- Product requirements explicitly require invite workflows, granular permissions, shareable dashboards, and organization-scoped messaging.
- Centralizing org permission assertions avoids drift and prevents accidental cross-organization access paths.

### Tradeoffs
- Current frontend surface continues to prioritize existing dashboard/intelligence routes; new organization/messaging routes are backend-complete first and can be consumed incrementally by UI.
- Invite email sending is strict (fails on downstream provider error) to avoid silent invite state drift.
- DM uniqueness is enforced via deterministic `dm_key` and schema unique constraint, trading flexibility for consistency.

### Risks
- End-to-end UX for invites/messaging requires frontend feature pages to fully expose the new APIs.
- Real-time messaging transport (WebSocket fanout) is not yet implemented in this pass; current APIs are REST-first with durable storage/audit semantics.
- Permission policy evolution (role templates, bulk grants) may require additional admin endpoints and migration-safe policy abstractions.

## 2026-05-04 - Frontend modernization pass: premium UX + modern-schema integration

### What was implemented
- Rebuilt landing page in `apps/web/app/page.tsx` into a premium finance narrative surface with:
  - strong above-the-fold value proposition
  - motion-backed hero (`ParticleHero`)
  - trust and workflow sections
  - explicit auth/session architecture messaging
- Added frontend API modules aligned with modern backend contracts:
  - `OrganizationApi` (`/organizations/*`)
  - `MessagingApi` (`/messaging/*`)
  - `DashboardsApi` (`/dashboards`)
- Extended frontend API types for organization, invites, members, conversations, messages, and dashboard summaries.
- Reworked API session handling in `useNumeriquApi`:
  - real auth state (`loading/authenticated/unauthenticated`)
  - shared session cache to avoid redundant `/auth/me` storms
  - proper sign-out cache invalidation
- Added production-facing internal pages:
  - `dashboard/messages` for organization chat flows
  - `dashboard/team` for members/invites/access posture
- Updated dashboard shell navigation and copy to reflect domain isolation and backend capabilities.
- Enhanced overview page with saved dashboard inventory from `/dashboards`.
- Hardened auth UX:
  - safer user-facing auth error mapping (no raw backend strings surfaced)
  - invite-token acceptance wired into signup (`/organizations/invites/accept`).
- Hardened integrations UI to avoid leaking raw sync error details to end users.

### Why
- Backend domains were implemented but not fully exposed in the modern frontend.
- Prior auth/session handling (`isAuthenticated = true`) could misrepresent session state and weaken UX reliability.
- CFO-oriented product quality required tighter hierarchy, clearer value communication, and safer failure messaging.

### Tradeoffs
- Messaging is currently REST-poll/read driven in UI (no WebSocket live fanout yet) to stay aligned with available backend contracts.
- Team page currently focuses on invite lifecycle and visibility; granular grant/revoke toggles remain an incremental enhancement.
- Session caching is in-memory client-side for responsiveness; browser refresh still revalidates with backend.

### Risks
- Real-time collaboration expectations may exceed current REST message refresh cadence until websocket transport is added.
- Invite acceptance depends on signup query token propagation and authenticated cookie state; atypical browser cookie/privacy settings can affect this flow.
- Full frontend E2E coverage for new team/messaging flows is still required before production rollout.

## 2026-05-05 - Correction: active RAG/Agent reads moved to ClickHouse Gold

### What was implemented
- Rewired `modules/rag` read path from Prisma financial tables to ClickHouse analytics Gold models:
  - Summary metrics now query `analytics.fact_accounting_invoices`
  - Context snippets now query `analytics.rag_context_invoices`
  - Postgres remains for session/chat persistence and organization scope lookup only.
- Rewired `modules/agent` metric read path from Prisma financial tables to ClickHouse analytics Gold models:
  - Venture summary from `analytics.fact_accounting_invoices`
  - Invoice status distribution from `analytics.fact_accounting_invoices`
  - Revenue by org and monthly trend from `analytics.revenue_by_month`
  - Postgres remains for session/chat/dashboard metadata and organization scope lookup only.
- Added scoped filtering strategy:
  - Resolve active organization connections from Postgres (`erp_connections`)
  - Filter ClickHouse reads by `connection_id` and `(tenant_id OR org_id)` parameters to enforce org boundary.
- Added safe ClickHouse query settings for memory/time bounds on new RAG/Agent reads.

### Why
- Product requirement is that AI answer generation and dashboard analytics read real transformed data from Bronze→Silver→Gold outputs in ClickHouse.
- Previous active implementation incorrectly read financial facts from Postgres normalized tables, creating architecture drift.
- This correction aligns runtime behavior with the dbt medallion contract in `packages/analytics`.

### Tradeoffs
- Scope filtering depends on active integration metadata from Postgres while all financial facts come from ClickHouse Gold.
- For robustness across historical data shapes, filters use both `connection_id` and `(tenant_id OR org_id)` where available.
- Agent dashboard generation logic remains template-based in this pass; only data reads were corrected.

### Risks
- If ClickHouse Gold rows are delayed relative to sync job completion, RAG/Agent may return fresh metadata but stale aggregates.
- If historical records have incomplete `tenant_id` and `org_id` tags, some data may be excluded until backfill consistency checks are run.
- Additional integration tests are needed to verify org isolation against ClickHouse datasets with multi-org/multi-provider overlap.

## 2026-05-05 - Org-scoping hardening + agent permission/audit enforcement

### What was implemented
- Added explicit organization context override support in `OrganizationContextService.ensureContext`:
  - accepts optional `organizationId`
  - validates user membership when supplied
  - rejects unauthorized org context with `FORBIDDEN` instead of silently defaulting.
- Wired RAG and Agent controllers to accept `x-organization-id` header for context resolution:
  - sessions/session/query/metrics/dashboard routes now support explicit org scope selection per request.
- Enforced `CREATE_DASHBOARD` permission in agent generation path:
  - agent now checks org permission before creating dashboards
  - users without permission receive a controlled stream error message.
- Added persisted agent execution audit trail using existing schema:
  - creates `agent_dashboard_requests` rows for every query
  - creates `agent_runs` rows and status transitions
  - writes `agent_run_events` for lifecycle milestones and failures.
- Added admin audit read API:
  - `GET /audit/events?limit=...`
  - aggregates organization audit-relevant events (agent runs/events, invites, permission grants, dashboard shares, message revisions, sync jobs)
  - admin-only access enforced.

### Why
- Multi-tenant correctness requires deterministic org selection for users with multiple memberships.
- Dashboard generation must respect admin-defined authorization (`CREATE_DASHBOARD`) in all code paths, including Agent.
- Production operations require auditable traces of autonomous agent actions and permission-sensitive activity.

### Tradeoffs
- Org selection is currently header-based (`x-organization-id`) for backend consistency; frontend org-switch UI wiring is a follow-up task.
- Audit API currently builds a consolidated feed from existing tables (no new immutable audit table introduced in this pass).
- Event fan-out is pull-based via API; real-time audit streaming is not part of this iteration.

### Risks
- Clients that do not send `x-organization-id` continue to use default membership context, which may not match user intent for multi-org workflows.
- Consolidated audit feed merges heterogeneous event sources; downstream consumers should key off `type` and `payload`.
- Additional authorization tests are needed for multi-org users switching contexts across all routes beyond RAG/Agent.

## 2026-05-05 - Permission model tightening + dashboard chart validation hardening

### What was implemented
- Added API-layer minimum chart cardinality validation for dashboard creation:
  - `CreateDashboardDto.charts` now uses `@ArrayMinSize(4)` in addition to service-level checks.
- Kept and strengthened dual permission model (flags + grant rows):
  - Grant endpoint now upserts `membership_permission_grants` **and** sets corresponding membership flag to `true`.
  - Revoke endpoint now removes grant rows and sets corresponding membership flag to `false` for non-admin memberships.
  - Admin memberships remain admin-authorized and are not downgraded by flag toggles.

### Why
- Minimum chart count is a core product invariant and should be enforced at request validation boundary plus service boundary.
- Maintaining both fast boolean flags and normalized grant rows enables low-latency checks today and extensible permission taxonomy tomorrow.

### Tradeoffs
- Revoke currently mutates membership flags for non-admin users; this provides predictable behavior but assumes the three dashboard capabilities are managed through these APIs.
- We intentionally keep service-level chart-count guard even with DTO validation to preserve defense-in-depth.

### Risks
- Existing clients that relied on sending fewer than 4 charts now fail earlier at DTO validation.
- Backfilling legacy permission data may be required if historical rows/flags are inconsistent.

## 2026-05-05 - SOLO account mode rollout (signup + backend restrictions + UI behavior)

### What was implemented
- Added SOLO-aware workspace provisioning:
  - `ensureContext` now accepts `preferredAccountType`
  - on first-time provisioning, organization is created with requested `accountType` (`SOLO` or `ORGANIZATION`).
- Updated OTP verify contract to accept optional `accountType` and proactively provision user context at verification time.
- Extended `/auth/me` response to include `tenant.accountType` so frontend can adapt workspace surfaces.
- Enforced solo-mode collaboration restrictions in backend:
  - messaging routes reject solo workspaces with `SOLO_RESTRICTION`
  - invite management routes reject solo workspaces with `SOLO_RESTRICTION`.
- Updated signup UX:
  - added account type selection (`Solo` vs `Organization`) before OTP send (disabled for invite-token flow where org context is pre-defined).
  - verification sends selected `accountType` to backend.
- Updated dashboard shell behavior:
  - solo accounts hide `Messages` and `Team & Access` navigation entries.
  - helper copy now reflects solo restrictions.

### Why
- Product requirement: solo users should have full personal analytics/AI/dashboard functionality without collaboration features (invites/messaging).
- Account type must be explicit at onboarding to avoid implicit defaults that mismatch user intent.

### Tradeoffs
- Solo restrictions are currently enforced at route-level service/controller checks rather than generalized policy middleware.
- Existing users without explicit account type choice keep default behavior unless reprovisioned/migrated.

### Risks
- Direct navigation to disabled solo routes can still occur by URL; backend rejects access, but frontend can add dedicated “not available in solo mode” route UX.
- Multi-org account-type transitions (solo <-> organization) are not part of this pass and need explicit migration rules.

## 2026-05-05 - Migration reset fix for foundation baseline

### What was implemented
- Fixed baseline migration conflict in `20260504215500_numeriqu_foundation_schema`:
  - Added pre-create cleanup for legacy incompatible tables:
    - `DROP TABLE IF EXISTS "sync_jobs" CASCADE;`
    - `DROP TABLE IF EXISTS "users" CASCADE;`
  - Updated foundation enum creation for account type parity with schema:
    - `AccountType` now includes `SOLO` and `ORGANIZATION`.

### Why
- `prisma migrate reset` failed with `P3018 / 42P07 relation "users" already exists` because older bootstrap migrations create legacy `users`/`sync_jobs` before the foundation migration recreates canonical versions.
- Cleanup makes reset deterministic across the mixed historical migration chain.

### Tradeoffs
- This is a historical migration edit (baseline hardening) rather than a new forward migration; suitable for non-production reset workflows and dev environments.

### Risks
- Teams with previously applied checksums on this migration may need to resolve migration history metadata in shared environments before applying updated files.

## 2026-05-05 - Signup resilience fix for existing-email user rows

### What was implemented
- Hardened user resolution in `OrganizationContextService.ensureContext`:
  - resolve by `supabaseUserId` first
  - fallback resolve by normalized `email`
  - if email row exists, relink it to current Supabase identity instead of creating duplicate
  - only create new user row when neither identifier exists.
- Added controlled conflict response (`USER_CONTEXT_FAILED`) when provisioning cannot safely resolve identity mapping.

### Why
- Signup OTP verification could fail with `Unique constraint failed on users.email` when a pre-existing user row existed by email but not by current `supabaseUserId`.
- The fix makes signup idempotent and safe for migrated/legacy data states.

### Tradeoffs
- On email match, we trust email ownership from verified OTP flow and relink `supabaseUserId` to the current identity.

### Risks
- If there is stale duplicated identity data with conflicting ownership semantics, manual admin reconciliation may still be required.

## 2026-05-05 - Frontend product polish pass (landing/auth/dashboard UX + live dashboard refresh)

### What was implemented
- Reworked frontend presentation layer for a calmer, finance-trust visual system:
  - tuned dark-theme tokens, surface treatments, and hero gradients in `/apps/web/app/globals.css` to reduce neon/glow noise and improve readability.
  - updated primary interaction styles (`Button`, `ErrorBanner`) for clearer hierarchy and calmer states.
- Rebuilt landing page narrative in `/apps/web/app/page.tsx`:
  - hero now focuses on CFO pain-to-value message.
  - added trust, problem→solution→outcome, workflow, value-stack, and final CTA sections.
  - replaced heavy visual framing with a subtle motion backdrop (`/apps/web/app/_components/landing/HeroBackdrop.tsx`).
- Rebuilt auth screens (`/apps/web/app/login/page.tsx`, `/apps/web/app/signup/page.tsx`):
  - improved OTP UX with paste support and clearer state messaging.
  - preserved backend contracts (`/auth/send-otp`, `/auth/verify-otp`, `/auth/resend-otp`) and invite acceptance flow.
  - kept account type selection behavior for non-invite signup and explicit SOLO/ORGANIZATION semantics.
- Refactored workspace shell in `/apps/web/app/dashboard/_components/DashboardShell.tsx`:
  - clearer navigation language, improved active/hover affordance, and added functional Settings entry.
- Added new settings route `/apps/web/app/dashboard/settings/page.tsx`:
  - wired to existing backend contracts (`/organizations/current`, session refresh) with loading/error handling.
- Improved overview saved-dashboard operations in `/apps/web/app/dashboard/_pages/OverviewPage.tsx`:
  - added explicit per-dashboard refresh action wired to `PATCH /dashboards/:id/refresh`.
  - added robust loading/error handling for saved dashboard listing and refresh outcomes.

### Why
- Previous UI density and glow-heavy presentation reduced trust and scanability for finance users.
- Auth and dashboard flows needed stronger clarity, clearer recovery states, and direct control over saved-dashboard refresh.
- Settings visibility reduces operator confusion about current identity/org context.

### Tradeoffs
- This pass is focused on high-leverage layout and interaction polish, not a full component-library rewrite.
- Admin/settings split is represented as existing Team + new Settings route to avoid inventing unsupported backend APIs.

### Risks
- Additional consistency refinement is still needed across less frequently used sub-pages (agent/rag/messaging visual parity).
- Motion is intentionally restrained; if stronger storytelling motion is desired, we should add measured section-level transitions with performance profiling.
