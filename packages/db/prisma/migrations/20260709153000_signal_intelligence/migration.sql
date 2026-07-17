-- Signal intelligence schema

CREATE TABLE "signal_metrics" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "metric_key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "unit" TEXT,
    "description" TEXT,
    "default_thresholds" JSONB,
    "supported_dimensions" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signal_metrics_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "signal_rules" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "signal_metric_id" UUID NOT NULL,
    "signal_type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "threshold" JSONB,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signal_rules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "signals" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "source_key" TEXT NOT NULL,
    "signal_metric_id" UUID NOT NULL,
    "signal_type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "impact_amount" NUMERIC(18,2) NOT NULL DEFAULT 0,
    "confidence_score" NUMERIC(6,4) NOT NULL DEFAULT 0,
    "entity_scope" JSONB NOT NULL,
    "time_window" JSONB NOT NULL,
    "comparison_window" JSONB NOT NULL,
    "assigned_to_user_id" UUID,
    "acknowledged_at" TIMESTAMP(3),
    "dismissed_at" TIMESTAMP(3),
    "dismissed_reason" TEXT,
    "evidence_computed_at" TIMESTAMP(3),
    "last_refreshed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "signal_evidence" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "signal_id" UUID NOT NULL,
    "evidence_type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signal_evidence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "signal_comments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "signal_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signal_comments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "signal_watchlists" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signal_watchlists_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "signal_watchlist_items" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "watchlist_id" UUID NOT NULL,
    "metric_key" TEXT NOT NULL,
    "entity_id" UUID,
    "entity_label" TEXT,
    "threshold_type" TEXT NOT NULL,
    "threshold_value" NUMERIC(18,4) NOT NULL,
    "severity" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signal_watchlist_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "signal_board_packs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "signal_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "export_format" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_by_id" UUID NOT NULL,
    "dashboard_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signal_board_packs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "signal_metrics_organization_id_metric_key_key" ON "signal_metrics"("organization_id", "metric_key");
CREATE INDEX "signal_metrics_organization_id_is_active_idx" ON "signal_metrics"("organization_id", "is_active");

CREATE UNIQUE INDEX "signal_rules_id_key" ON "signal_rules"("id");
CREATE UNIQUE INDEX "signal_rules_organization_id_signal_metric_id_signal_type_key" ON "signal_rules"("organization_id", "signal_metric_id", "signal_type");
CREATE INDEX "signal_rules_organization_id_signal_metric_id_idx" ON "signal_rules"("organization_id", "signal_metric_id");
CREATE INDEX "signal_rules_organization_id_signal_type_severity_idx" ON "signal_rules"("organization_id", "signal_type", "severity");

CREATE UNIQUE INDEX "signals_source_key_key" ON "signals"("source_key");
CREATE INDEX "signals_organization_id_status_severity_created_at_idx" ON "signals"("organization_id", "status", "severity", "created_at");
CREATE INDEX "signals_organization_id_signal_metric_id_created_at_idx" ON "signals"("organization_id", "signal_metric_id", "created_at");
CREATE INDEX "signals_organization_id_assigned_to_user_id_idx" ON "signals"("organization_id", "assigned_to_user_id");

CREATE INDEX "signal_evidence_organization_id_signal_id_sort_order_idx" ON "signal_evidence"("organization_id", "signal_id", "sort_order");

CREATE INDEX "signal_comments_organization_id_signal_id_created_at_idx" ON "signal_comments"("organization_id", "signal_id", "created_at");

CREATE UNIQUE INDEX "signal_watchlists_organization_id_name_key" ON "signal_watchlists"("organization_id", "name");
CREATE INDEX "signal_watchlists_organization_id_owner_id_idx" ON "signal_watchlists"("organization_id", "owner_id");

CREATE INDEX "signal_watchlist_items_organization_id_watchlist_id_idx" ON "signal_watchlist_items"("organization_id", "watchlist_id");
CREATE INDEX "signal_watchlist_items_organization_id_metric_key_idx" ON "signal_watchlist_items"("organization_id", "metric_key");

CREATE INDEX "signal_board_packs_organization_id_signal_id_created_at_idx" ON "signal_board_packs"("organization_id", "signal_id", "created_at");

ALTER TABLE "signal_metrics" ADD CONSTRAINT "signal_metrics_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "signal_rules" ADD CONSTRAINT "signal_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "signal_rules" ADD CONSTRAINT "signal_rules_signal_metric_id_fkey" FOREIGN KEY ("signal_metric_id") REFERENCES "signal_metrics"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "signals" ADD CONSTRAINT "signals_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "signals" ADD CONSTRAINT "signals_signal_metric_id_fkey" FOREIGN KEY ("signal_metric_id") REFERENCES "signal_metrics"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "signals" ADD CONSTRAINT "signals_assigned_to_user_id_fkey" FOREIGN KEY ("assigned_to_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "signal_evidence" ADD CONSTRAINT "signal_evidence_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "signal_evidence" ADD CONSTRAINT "signal_evidence_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "signals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "signal_comments" ADD CONSTRAINT "signal_comments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "signal_comments" ADD CONSTRAINT "signal_comments_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "signals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "signal_comments" ADD CONSTRAINT "signal_comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "signal_watchlists" ADD CONSTRAINT "signal_watchlists_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "signal_watchlists" ADD CONSTRAINT "signal_watchlists_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "signal_watchlist_items" ADD CONSTRAINT "signal_watchlist_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "signal_watchlist_items" ADD CONSTRAINT "signal_watchlist_items_watchlist_id_fkey" FOREIGN KEY ("watchlist_id") REFERENCES "signal_watchlists"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "signal_board_packs" ADD CONSTRAINT "signal_board_packs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "signal_board_packs" ADD CONSTRAINT "signal_board_packs_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "signals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "signal_board_packs" ADD CONSTRAINT "signal_board_packs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
