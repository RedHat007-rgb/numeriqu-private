# Numeriqu Backend Schema (Step 1)

## Scope
This document defines the PostgreSQL data model for:
1. Users + verification
2. Organizations + memberships
3. ERP connections
4. Financial normalized schema
5. Dashboards
6. Permissions
7. Messaging system
8. RAG chat system
9. Agent system

Supabase is used for identity/session/JWT only (`users.supabase_user_id`).
Resend-driven OTP/token verification is stored in application tables (`verification_tokens`, `otp_codes`, `organization_invites`).

## ER Diagram (Text)

### Identity & Organizations
- `users (1) -> (N) organization_memberships`
- `organizations (1) -> (N) organization_memberships`
- `organization_memberships (1) -> (N) membership_permission_grants`
- `users (1) -> (N) verification_tokens`
- `users (1) -> (N) otp_codes`
- `organizations (1) -> (N) organization_invites`

### ERP & Financial Normalization
- `organizations (1) -> (N) erp_connections`
- `erp_connections (1) -> (N) sync_schedules`
- `erp_connections (1) -> (N) sync_jobs`
- `organizations (1) -> (N) financial_accounts`
- `organizations (1) -> (N) financial_counterparties`
- `organizations (1) -> (N) financial_invoices`
- `financial_invoices (1) -> (N) financial_invoice_lines`
- `organizations (1) -> (N) financial_journal_entries`
- `financial_journal_entries (1) -> (N) financial_journal_entry_lines`
- `organizations (1) -> (N) financial_metric_snapshots`
- `organizations (1) -> (N) financial_source_mappings`

### Dashboards & Permissions
- `organizations (1) -> (N) dashboards`
- `dashboards (1) -> (N) dashboard_widgets`
- `dashboards (1) -> (N) dashboard_shares`
- `organization_memberships (1) -> (N) membership_permission_grants`

### Messaging (Separated from AI)
- `organizations (1) -> (N) conversations`
- `conversations (1) -> (N) conversation_participants`
- `conversations (1) -> (N) messages`
- `messages (1) -> (N) message_revisions`
- `messages (1) -> (N) message_dashboard_references`

### RAG Layer (Separate Storage)
- `organizations (1) -> (N) rag_chat_sessions`
- `rag_chat_sessions (1) -> (N) rag_chat_messages`
- `rag_chat_messages (1) -> (N) rag_citations`

### Agent Layer (Separate Storage)
- `organizations (1) -> (N) agent_chat_sessions`
- `agent_chat_sessions (1) -> (N) agent_chat_messages`
- `organizations (1) -> (N) agent_dashboard_requests`
- `agent_dashboard_requests (1) -> (N) agent_runs`
- `agent_runs (1) -> (N) agent_run_events`

## Table Definitions (By Domain)

### 1) Users + Verification
- `users`: app user profile keyed to Supabase identity.
- `verification_tokens`: hashed verification tokens for signup/login verification.
- `otp_codes`: hashed OTP records with expiry and one-time usage marker.

### 2) Organizations + Memberships
- `organizations`: tenant root.
- `organization_memberships`: user-to-organization membership and role (`ADMIN`, `USER`) plus dashboard capability flags.
- `membership_permission_grants`: explicit granular permission rows (`VIEW_DASHBOARD`, `CREATE_DASHBOARD`, `SHARE_DASHBOARD`).
- `organization_invites`: invite flow, hashed token, status lifecycle.

### 3) ERP Connections
- `erp_connections`: multiple QuickBooks/Xero org links per organization.
- `sync_schedules`: scheduled sync metadata.
- `sync_jobs`: manual/scheduled job runs and operational outcomes.

### 4) Financial Normalized Schema
- `financial_accounts`: normalized chart of accounts.
- `financial_counterparties`: normalized customer/vendor entities.
- `financial_invoices`: normalized invoices (AR/AP-like types via `invoice_type`).
- `financial_invoice_lines`: normalized invoice lines.
- `financial_journal_entries`: normalized journal entry headers.
- `financial_journal_entry_lines`: normalized journal entry lines.
- `financial_metric_snapshots`: precomputed metrics for dashboard query efficiency.
- `financial_source_mappings`: source-to-normalized traceability map.

### 5) Dashboards
- `dashboards`: ownership + persisted config + permissions + `last_synced_at`.
- `dashboard_widgets`: chart/query configuration per dashboard.
- `dashboard_shares`: per-user share records.

### 6) Permissions
- `organization_memberships` capability flags for quick permission checks.
- `membership_permission_grants` for explicit extensible grants.

### 7) Messaging System
- `conversations`: organization-bounded DM/GROUP container.
- `conversation_participants`: membership of users in each conversation.
- `messages`: soft-delete capable message body (`deleted_at` only, no hard delete).
- `message_revisions`: edit history for auditability.
- `message_dashboard_references`: dashboard sharing links in chat.

### 8) RAG Chat System
- `rag_chat_sessions`
- `rag_chat_messages`
- `rag_citations`

### 9) Agent System
- `agent_chat_sessions`
- `agent_chat_messages`
- `agent_dashboard_requests`
- `agent_runs`
- `agent_run_events`

## Relationship & Integrity Rules
- Every organization-scoped table includes `organization_id`.
- Foreign keys use `ON DELETE CASCADE` for tenant-owned aggregates where safe.
- Soft delete is used for messages/invoices/dashboards where audit continuity is required.
- `financial_source_mappings` enforces provider traceability through `(connection_id, source_entity_type, source_record_id)` uniqueness.

## Index Strategy
- Multi-tenant query path indexes on `organization_id` for all org-scoped tables.
- Membership/access indexes:
  - `organization_memberships (organization_id, role)`
  - `conversation_participants (organization_id, user_id)`
  - `dashboard_shares (organization_id, shared_with_user_id)`
- ERP/sync indexes:
  - `erp_connections (organization_id, provider)`
  - `sync_jobs (organization_id, status, created_at)`
  - `sync_schedules (organization_id, is_active)` and `(next_run_at)`
- Financial query indexes:
  - invoices by status/date/due date
  - journal entries by entry date
  - metric snapshots by `(organization_id, as_of_date)`
  - source mapping lookup by normalized record and source key
- AI layers:
  - RAG and Agent message time-series indexes by `(session_id, created_at)`
  - request/run operational indexes by `(organization_id, status, created_at)`

## Multi-tenant Isolation Strategy
1. **Schema-level rule:** every domain table under organization scope carries `organization_id`.
2. **Join discipline:** all repository queries must include `organization_id` predicate at root and joins.
3. **Permission gate:** user access resolved from `organization_memberships` (and participant/share tables for messaging/dashboard records).
4. **Layer boundary:** messaging tables, RAG tables, and agent tables are physically separate and do not share session/message tables.
5. **Operational policy:** no cross-organization aggregate queries in transactional services.
6. **Auditability:** soft-delete + revision tables retain evidence for governance and incident review.
