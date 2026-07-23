CREATE TYPE "PrismJobType" AS ENUM ('ANALYSIS', 'EXPORT', 'BRIEFING');
CREATE TYPE "PrismJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');
CREATE TYPE "PrismActionStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED', 'CANCELLED');
CREATE TYPE "PrismApprovalDecision" AS ENUM ('APPROVED', 'REJECTED');

CREATE TABLE "prism_jobs" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "type" "PrismJobType" NOT NULL,
  "status" "PrismJobStatus" NOT NULL DEFAULT 'QUEUED',
  "idempotency_key" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "result" JSONB,
  "error_code" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "prism_jobs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "prism_outbox_events" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "aggregate_type" TEXT NOT NULL,
  "aggregate_id" UUID NOT NULL,
  "topic" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "published_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "prism_outbox_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "prism_jobs_organization_id_idempotency_key_key" ON "prism_jobs"("organization_id", "idempotency_key");
CREATE INDEX "prism_jobs_status_available_at_created_at_idx" ON "prism_jobs"("status", "available_at", "created_at");
CREATE INDEX "prism_jobs_organization_id_user_id_created_at_idx" ON "prism_jobs"("organization_id", "user_id", "created_at");
CREATE INDEX "prism_outbox_events_published_at_available_at_created_at_idx" ON "prism_outbox_events"("published_at", "available_at", "created_at");
CREATE INDEX "prism_outbox_events_organization_id_created_at_idx" ON "prism_outbox_events"("organization_id", "created_at");

ALTER TABLE "prism_jobs" ADD CONSTRAINT "prism_jobs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "prism_outbox_events" ADD CONSTRAINT "prism_outbox_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "prism_action_proposals" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "created_by_id" UUID NOT NULL,
  "source_request_id" TEXT NOT NULL,
  "action_type" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "preview" JSONB NOT NULL,
  "risk_level" TEXT NOT NULL,
  "status" "PrismActionStatus" NOT NULL DEFAULT 'PROPOSED',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "prism_action_proposals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "prism_approval_events" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "proposal_id" UUID NOT NULL,
  "decided_by_id" UUID NOT NULL,
  "decision" "PrismApprovalDecision" NOT NULL,
  "rationale" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "prism_approval_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "prism_action_proposals_organization_id_source_request_id_key" ON "prism_action_proposals"("organization_id", "source_request_id");
CREATE INDEX "prism_action_proposals_organization_id_status_created_at_idx" ON "prism_action_proposals"("organization_id", "status", "created_at");
CREATE UNIQUE INDEX "prism_approval_events_proposal_id_decided_by_id_key" ON "prism_approval_events"("proposal_id", "decided_by_id");
CREATE INDEX "prism_approval_events_organization_id_created_at_idx" ON "prism_approval_events"("organization_id", "created_at");

ALTER TABLE "prism_action_proposals" ADD CONSTRAINT "prism_action_proposals_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "prism_approval_events" ADD CONSTRAINT "prism_approval_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "prism_approval_events" ADD CONSTRAINT "prism_approval_events_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "prism_action_proposals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
