-- Autonomous Chart Engine: dataset registry + versioned semantic models.
-- Replaces the hardcoded DatasetKind = 'ebpo' | 'gl' enum with data rows.

CREATE TABLE "datasets" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "physical_schema" JSONB,
    "introspected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "datasets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "dataset_semantic_models" (
    "id" UUID NOT NULL,
    "dataset_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "model" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "built_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dataset_semantic_models_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "datasets_organization_id_kind_key" ON "datasets"("organization_id", "kind");
CREATE INDEX "datasets_organization_id_idx" ON "datasets"("organization_id");

CREATE UNIQUE INDEX "dataset_semantic_models_dataset_id_version_key" ON "dataset_semantic_models"("dataset_id", "version");
CREATE INDEX "dataset_semantic_models_dataset_id_is_active_idx" ON "dataset_semantic_models"("dataset_id", "is_active");

ALTER TABLE "datasets" ADD CONSTRAINT "datasets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dataset_semantic_models" ADD CONSTRAINT "dataset_semantic_models_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "datasets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
