-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('SOLO', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "OrganizationRole" AS ENUM ('ADMIN', 'USER');

-- CreateEnum
CREATE TYPE "PermissionCode" AS ENUM ('VIEW_DASHBOARD', 'CREATE_DASHBOARD', 'SHARE_DASHBOARD');

-- CreateEnum
CREATE TYPE "ErpProvider" AS ENUM ('QUICKBOOKS', 'XERO');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('ACTIVE', 'DISCONNECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "SyncTriggerType" AS ENUM ('MANUAL', 'SCHEDULED');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'PARTIAL');

-- CreateEnum
CREATE TYPE "InviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "VerificationPurpose" AS ENUM ('SIGNUP_VERIFICATION', 'LOGIN_VERIFICATION');

-- CreateEnum
CREATE TYPE "ConversationType" AS ENUM ('DM', 'GROUP');

-- CreateEnum
CREATE TYPE "RagMessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AgentRequestStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED');

-- Cleanup legacy tables from earlier bootstrap migrations.
-- The pre-foundation chain created `users` and `sync_jobs` with incompatible
-- column types. We drop them here so the foundation schema can recreate the
-- canonical versions deterministically during migrate reset.
DROP TABLE IF EXISTS "sync_jobs" CASCADE;
DROP TABLE IF EXISTS "users" CASCADE;

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "supabase_user_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "full_name" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "purpose" "VerificationPurpose" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_codes" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "email" TEXT NOT NULL,
    "otp_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "account_type" "AccountType" NOT NULL DEFAULT 'ORGANIZATION',
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_memberships" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "OrganizationRole" NOT NULL,
    "can_view_dashboard" BOOLEAN NOT NULL DEFAULT false,
    "can_create_dashboard" BOOLEAN NOT NULL DEFAULT false,
    "can_share_dashboard" BOOLEAN NOT NULL DEFAULT false,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMP(3),

    CONSTRAINT "organization_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership_permission_grants" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "permission" "PermissionCode" NOT NULL,
    "granted_by_id" UUID NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_permission_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_invites" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "invited_by_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "OrganizationRole" NOT NULL DEFAULT 'USER',
    "can_view_dashboard" BOOLEAN NOT NULL DEFAULT false,
    "can_create_dashboard" BOOLEAN NOT NULL DEFAULT false,
    "can_share_dashboard" BOOLEAN NOT NULL DEFAULT false,
    "token_hash" TEXT NOT NULL,
    "status" "InviteStatus" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "erp_connections" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "provider" "ErpProvider" NOT NULL,
    "external_organization_id" TEXT NOT NULL,
    "display_name" TEXT,
    "access_token_encrypted" TEXT NOT NULL,
    "refresh_token_encrypted" TEXT,
    "token_expires_at" TIMESTAMP(3),
    "status" "ConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by_id" UUID NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "erp_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_schedules" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "cron_expression" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_run_at" TIMESTAMP(3),
    "next_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_jobs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "trigger_type" "SyncTriggerType" NOT NULL,
    "status" "SyncStatus" NOT NULL,
    "requested_by_id" UUID,
    "records_read" INTEGER NOT NULL DEFAULT 0,
    "records_written" INTEGER NOT NULL DEFAULT 0,
    "error_code" TEXT,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_accounts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "account_code" TEXT NOT NULL,
    "account_name" TEXT NOT NULL,
    "account_type" TEXT NOT NULL,
    "currency_code" CHAR(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "financial_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_counterparties" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "external_counterparty_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "financial_counterparties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_invoices" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "counterparty_id" UUID,
    "invoice_number" TEXT NOT NULL,
    "invoice_type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "issue_date" DATE NOT NULL,
    "due_date" DATE,
    "subtotal_amount" DECIMAL(18,2) NOT NULL,
    "tax_amount" DECIMAL(18,2) NOT NULL,
    "total_amount" DECIMAL(18,2) NOT NULL,
    "amount_paid" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "amount_due" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "source_updated_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "financial_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_invoice_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "account_id" UUID,
    "line_number" INTEGER NOT NULL,
    "description" TEXT,
    "quantity" DECIMAL(18,4),
    "unit_price" DECIMAL(18,4),
    "line_amount" DECIMAL(18,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_journal_entries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "entry_number" TEXT NOT NULL,
    "entry_date" DATE NOT NULL,
    "memo" TEXT,
    "currency_code" CHAR(3) NOT NULL,
    "source_updated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "financial_journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_journal_entry_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "journal_entry_id" UUID NOT NULL,
    "account_id" UUID,
    "line_number" INTEGER NOT NULL,
    "description" TEXT,
    "debit_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "credit_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_journal_entry_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_metric_snapshots" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID,
    "metric_key" TEXT NOT NULL,
    "as_of_date" DATE NOT NULL,
    "metric_value" DECIMAL(24,6) NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_metric_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_source_mappings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "normalized_table" TEXT NOT NULL,
    "normalized_id" UUID NOT NULL,
    "source_entity_type" TEXT NOT NULL,
    "source_record_id" TEXT NOT NULL,
    "source_payload_hash" TEXT,
    "last_seen_sync_job_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "financial_source_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboards" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "config" JSONB NOT NULL,
    "permissions" JSONB NOT NULL,
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "dashboards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_widgets" (
    "id" UUID NOT NULL,
    "dashboard_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "chart_type" TEXT NOT NULL,
    "query_config" JSONB NOT NULL,
    "chart_config" JSONB NOT NULL,
    "display_order" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dashboard_widgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_shares" (
    "id" UUID NOT NULL,
    "dashboard_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "shared_with_user_id" UUID NOT NULL,
    "shared_by_user_id" UUID NOT NULL,
    "can_edit" BOOLEAN NOT NULL DEFAULT false,
    "shared_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "dashboard_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "type" "ConversationType" NOT NULL,
    "dm_key" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_participants" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMP(3),

    CONSTRAINT "conversation_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "edited_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_revisions" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "editor_id" UUID NOT NULL,
    "previous_content" TEXT NOT NULL,
    "edited_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_dashboard_references" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "dashboard_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_dashboard_references_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rag_chat_sessions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "rag_chat_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rag_chat_messages" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "role" "RagMessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "context_snapshot" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rag_chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rag_citations" (
    "id" UUID NOT NULL,
    "rag_message_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "excerpt" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rag_citations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_chat_sessions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "agent_chat_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_chat_messages" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_dashboard_requests" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "agent_session_id" UUID,
    "prompt" TEXT NOT NULL,
    "status" "AgentRequestStatus" NOT NULL DEFAULT 'QUEUED',
    "generated_dashboard_id" UUID,
    "error_code" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "agent_dashboard_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'QUEUED',
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "latency_ms" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_run_events" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_run_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_supabase_user_id_key" ON "users"("supabase_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "verification_tokens_email_purpose_idx" ON "verification_tokens"("email", "purpose");

-- CreateIndex
CREATE INDEX "verification_tokens_user_id_purpose_idx" ON "verification_tokens"("user_id", "purpose");

-- CreateIndex
CREATE INDEX "verification_tokens_expires_at_idx" ON "verification_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "verification_tokens_purpose_token_hash_key" ON "verification_tokens"("purpose", "token_hash");

-- CreateIndex
CREATE INDEX "otp_codes_email_idx" ON "otp_codes"("email");

-- CreateIndex
CREATE INDEX "otp_codes_expires_at_idx" ON "otp_codes"("expires_at");

-- CreateIndex
CREATE INDEX "otp_codes_user_id_idx" ON "otp_codes"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "organizations_created_by_id_idx" ON "organizations"("created_by_id");

-- CreateIndex
CREATE INDEX "organization_memberships_user_id_idx" ON "organization_memberships"("user_id");

-- CreateIndex
CREATE INDEX "organization_memberships_organization_id_role_idx" ON "organization_memberships"("organization_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "organization_memberships_organization_id_user_id_key" ON "organization_memberships"("organization_id", "user_id");

-- CreateIndex
CREATE INDEX "membership_permission_grants_organization_id_permission_idx" ON "membership_permission_grants"("organization_id", "permission");

-- CreateIndex
CREATE UNIQUE INDEX "membership_permission_grants_membership_id_permission_key" ON "membership_permission_grants"("membership_id", "permission");

-- CreateIndex
CREATE INDEX "organization_invites_email_idx" ON "organization_invites"("email");

-- CreateIndex
CREATE INDEX "organization_invites_expires_at_idx" ON "organization_invites"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "organization_invites_organization_id_email_status_key" ON "organization_invites"("organization_id", "email", "status");

-- CreateIndex
CREATE INDEX "erp_connections_organization_id_provider_idx" ON "erp_connections"("organization_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "erp_connections_organization_id_provider_external_organizat_key" ON "erp_connections"("organization_id", "provider", "external_organization_id");

-- CreateIndex
CREATE INDEX "sync_schedules_organization_id_is_active_idx" ON "sync_schedules"("organization_id", "is_active");

-- CreateIndex
CREATE INDEX "sync_schedules_next_run_at_idx" ON "sync_schedules"("next_run_at");

-- CreateIndex
CREATE UNIQUE INDEX "sync_schedules_connection_id_key" ON "sync_schedules"("connection_id");

-- CreateIndex
CREATE INDEX "sync_jobs_organization_id_status_created_at_idx" ON "sync_jobs"("organization_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "sync_jobs_connection_id_created_at_idx" ON "sync_jobs"("connection_id", "created_at");

-- CreateIndex
CREATE INDEX "financial_accounts_organization_id_account_type_idx" ON "financial_accounts"("organization_id", "account_type");

-- CreateIndex
CREATE UNIQUE INDEX "financial_accounts_organization_id_connection_id_account_co_key" ON "financial_accounts"("organization_id", "connection_id", "account_code");

-- CreateIndex
CREATE INDEX "financial_counterparties_organization_id_type_idx" ON "financial_counterparties"("organization_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "financial_counterparties_organization_id_connection_id_exte_key" ON "financial_counterparties"("organization_id", "connection_id", "external_counterparty_id");

-- CreateIndex
CREATE INDEX "financial_invoices_organization_id_issue_date_idx" ON "financial_invoices"("organization_id", "issue_date");

-- CreateIndex
CREATE INDEX "financial_invoices_organization_id_status_idx" ON "financial_invoices"("organization_id", "status");

-- CreateIndex
CREATE INDEX "financial_invoices_organization_id_due_date_idx" ON "financial_invoices"("organization_id", "due_date");

-- CreateIndex
CREATE UNIQUE INDEX "financial_invoices_organization_id_connection_id_invoice_nu_key" ON "financial_invoices"("organization_id", "connection_id", "invoice_number");

-- CreateIndex
CREATE INDEX "financial_invoice_lines_organization_id_account_id_idx" ON "financial_invoice_lines"("organization_id", "account_id");

-- CreateIndex
CREATE UNIQUE INDEX "financial_invoice_lines_invoice_id_line_number_key" ON "financial_invoice_lines"("invoice_id", "line_number");

-- CreateIndex
CREATE INDEX "financial_journal_entries_organization_id_entry_date_idx" ON "financial_journal_entries"("organization_id", "entry_date");

-- CreateIndex
CREATE UNIQUE INDEX "financial_journal_entries_organization_id_connection_id_ent_key" ON "financial_journal_entries"("organization_id", "connection_id", "entry_number");

-- CreateIndex
CREATE INDEX "financial_journal_entry_lines_organization_id_account_id_idx" ON "financial_journal_entry_lines"("organization_id", "account_id");

-- CreateIndex
CREATE UNIQUE INDEX "financial_journal_entry_lines_journal_entry_id_line_number_key" ON "financial_journal_entry_lines"("journal_entry_id", "line_number");

-- CreateIndex
CREATE INDEX "financial_metric_snapshots_organization_id_as_of_date_idx" ON "financial_metric_snapshots"("organization_id", "as_of_date");

-- CreateIndex
CREATE UNIQUE INDEX "financial_metric_snapshots_organization_id_metric_key_as_of_key" ON "financial_metric_snapshots"("organization_id", "metric_key", "as_of_date");

-- CreateIndex
CREATE INDEX "financial_source_mappings_organization_id_normalized_table__idx" ON "financial_source_mappings"("organization_id", "normalized_table", "normalized_id");

-- CreateIndex
CREATE UNIQUE INDEX "financial_source_mappings_connection_id_source_entity_type__key" ON "financial_source_mappings"("connection_id", "source_entity_type", "source_record_id");

-- CreateIndex
CREATE INDEX "dashboards_organization_id_owner_id_idx" ON "dashboards"("organization_id", "owner_id");

-- CreateIndex
CREATE INDEX "dashboards_organization_id_created_at_idx" ON "dashboards"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "dashboard_widgets_organization_id_dashboard_id_idx" ON "dashboard_widgets"("organization_id", "dashboard_id");

-- CreateIndex
CREATE UNIQUE INDEX "dashboard_widgets_dashboard_id_display_order_key" ON "dashboard_widgets"("dashboard_id", "display_order");

-- CreateIndex
CREATE INDEX "dashboard_shares_organization_id_shared_with_user_id_idx" ON "dashboard_shares"("organization_id", "shared_with_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "dashboard_shares_dashboard_id_shared_with_user_id_key" ON "dashboard_shares"("dashboard_id", "shared_with_user_id");

-- CreateIndex
CREATE INDEX "conversations_organization_id_type_idx" ON "conversations"("organization_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_organization_id_dm_key_key" ON "conversations"("organization_id", "dm_key");

-- CreateIndex
CREATE INDEX "conversation_participants_organization_id_user_id_idx" ON "conversation_participants"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_participants_conversation_id_user_id_key" ON "conversation_participants"("conversation_id", "user_id");

-- CreateIndex
CREATE INDEX "messages_conversation_id_created_at_idx" ON "messages"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "messages_organization_id_sender_id_idx" ON "messages"("organization_id", "sender_id");

-- CreateIndex
CREATE INDEX "message_revisions_message_id_edited_at_idx" ON "message_revisions"("message_id", "edited_at");

-- CreateIndex
CREATE INDEX "message_revisions_organization_id_edited_at_idx" ON "message_revisions"("organization_id", "edited_at");

-- CreateIndex
CREATE INDEX "message_dashboard_references_organization_id_dashboard_id_idx" ON "message_dashboard_references"("organization_id", "dashboard_id");

-- CreateIndex
CREATE UNIQUE INDEX "message_dashboard_references_message_id_dashboard_id_key" ON "message_dashboard_references"("message_id", "dashboard_id");

-- CreateIndex
CREATE INDEX "rag_chat_sessions_organization_id_user_id_created_at_idx" ON "rag_chat_sessions"("organization_id", "user_id", "created_at");

-- CreateIndex
CREATE INDEX "rag_chat_messages_session_id_created_at_idx" ON "rag_chat_messages"("session_id", "created_at");

-- CreateIndex
CREATE INDEX "rag_chat_messages_organization_id_created_at_idx" ON "rag_chat_messages"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "rag_citations_organization_id_source_type_source_id_idx" ON "rag_citations"("organization_id", "source_type", "source_id");

-- CreateIndex
CREATE INDEX "agent_chat_sessions_organization_id_user_id_created_at_idx" ON "agent_chat_sessions"("organization_id", "user_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_chat_messages_session_id_created_at_idx" ON "agent_chat_messages"("session_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_chat_messages_organization_id_created_at_idx" ON "agent_chat_messages"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_dashboard_requests_organization_id_status_created_at_idx" ON "agent_dashboard_requests"("organization_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "agent_dashboard_requests_requested_by_id_created_at_idx" ON "agent_dashboard_requests"("requested_by_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_runs_organization_id_status_created_at_idx" ON "agent_runs"("organization_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "agent_runs_request_id_created_at_idx" ON "agent_runs"("request_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_run_events_run_id_created_at_idx" ON "agent_run_events"("run_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_run_events_organization_id_created_at_idx" ON "agent_run_events"("organization_id", "created_at");

-- AddForeignKey
ALTER TABLE "verification_tokens" ADD CONSTRAINT "verification_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otp_codes" ADD CONSTRAINT "otp_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_permission_grants" ADD CONSTRAINT "membership_permission_grants_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_permission_grants" ADD CONSTRAINT "membership_permission_grants_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "organization_memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_permission_grants" ADD CONSTRAINT "membership_permission_grants_granted_by_id_fkey" FOREIGN KEY ("granted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_invites" ADD CONSTRAINT "organization_invites_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_invites" ADD CONSTRAINT "organization_invites_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "erp_connections" ADD CONSTRAINT "erp_connections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "erp_connections" ADD CONSTRAINT "erp_connections_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_schedules" ADD CONSTRAINT "sync_schedules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_schedules" ADD CONSTRAINT "sync_schedules_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "erp_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "erp_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_accounts" ADD CONSTRAINT "financial_accounts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_accounts" ADD CONSTRAINT "financial_accounts_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "erp_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_counterparties" ADD CONSTRAINT "financial_counterparties_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_counterparties" ADD CONSTRAINT "financial_counterparties_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "erp_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_invoices" ADD CONSTRAINT "financial_invoices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_invoices" ADD CONSTRAINT "financial_invoices_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "erp_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_invoices" ADD CONSTRAINT "financial_invoices_counterparty_id_fkey" FOREIGN KEY ("counterparty_id") REFERENCES "financial_counterparties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_invoice_lines" ADD CONSTRAINT "financial_invoice_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_invoice_lines" ADD CONSTRAINT "financial_invoice_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "financial_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_invoice_lines" ADD CONSTRAINT "financial_invoice_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "financial_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_journal_entries" ADD CONSTRAINT "financial_journal_entries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_journal_entries" ADD CONSTRAINT "financial_journal_entries_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "erp_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_journal_entry_lines" ADD CONSTRAINT "financial_journal_entry_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_journal_entry_lines" ADD CONSTRAINT "financial_journal_entry_lines_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "financial_journal_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_journal_entry_lines" ADD CONSTRAINT "financial_journal_entry_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "financial_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_metric_snapshots" ADD CONSTRAINT "financial_metric_snapshots_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_metric_snapshots" ADD CONSTRAINT "financial_metric_snapshots_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "erp_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_source_mappings" ADD CONSTRAINT "financial_source_mappings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_source_mappings" ADD CONSTRAINT "financial_source_mappings_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "erp_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_source_mappings" ADD CONSTRAINT "financial_source_mappings_last_seen_sync_job_id_fkey" FOREIGN KEY ("last_seen_sync_job_id") REFERENCES "sync_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_dashboard_id_fkey" FOREIGN KEY ("dashboard_id") REFERENCES "dashboards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboard_shares" ADD CONSTRAINT "dashboard_shares_dashboard_id_fkey" FOREIGN KEY ("dashboard_id") REFERENCES "dashboards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboard_shares" ADD CONSTRAINT "dashboard_shares_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboard_shares" ADD CONSTRAINT "dashboard_shares_shared_with_user_id_fkey" FOREIGN KEY ("shared_with_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboard_shares" ADD CONSTRAINT "dashboard_shares_shared_by_user_id_fkey" FOREIGN KEY ("shared_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_revisions" ADD CONSTRAINT "message_revisions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_revisions" ADD CONSTRAINT "message_revisions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_revisions" ADD CONSTRAINT "message_revisions_editor_id_fkey" FOREIGN KEY ("editor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_dashboard_references" ADD CONSTRAINT "message_dashboard_references_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_dashboard_references" ADD CONSTRAINT "message_dashboard_references_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_dashboard_references" ADD CONSTRAINT "message_dashboard_references_dashboard_id_fkey" FOREIGN KEY ("dashboard_id") REFERENCES "dashboards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_chat_sessions" ADD CONSTRAINT "rag_chat_sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_chat_sessions" ADD CONSTRAINT "rag_chat_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_chat_messages" ADD CONSTRAINT "rag_chat_messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "rag_chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_chat_messages" ADD CONSTRAINT "rag_chat_messages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_citations" ADD CONSTRAINT "rag_citations_rag_message_id_fkey" FOREIGN KEY ("rag_message_id") REFERENCES "rag_chat_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_citations" ADD CONSTRAINT "rag_citations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_chat_sessions" ADD CONSTRAINT "agent_chat_sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_chat_sessions" ADD CONSTRAINT "agent_chat_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_chat_messages" ADD CONSTRAINT "agent_chat_messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "agent_chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_chat_messages" ADD CONSTRAINT "agent_chat_messages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_dashboard_requests" ADD CONSTRAINT "agent_dashboard_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_dashboard_requests" ADD CONSTRAINT "agent_dashboard_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_dashboard_requests" ADD CONSTRAINT "agent_dashboard_requests_agent_session_id_fkey" FOREIGN KEY ("agent_session_id") REFERENCES "agent_chat_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_dashboard_requests" ADD CONSTRAINT "agent_dashboard_requests_generated_dashboard_id_fkey" FOREIGN KEY ("generated_dashboard_id") REFERENCES "dashboards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "agent_dashboard_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
