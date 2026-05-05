/*
  Warnings:

  - You are about to drop the `connections` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `insights` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `tenants` table. If the table is not empty, all the data it contains will be lost.

*/

-- Drop every inbound FK that references the three tables being removed.
-- Using IF EXISTS so this migration is safe to re-run on any environment.

-- sync_jobs → connections  (created in 20260331102229_init)
ALTER TABLE "sync_jobs" DROP CONSTRAINT IF EXISTS "sync_jobs_connection_id_fkey";

-- sync_jobs → tenants  (created in 20260331102229_init)
ALTER TABLE "sync_jobs" DROP CONSTRAINT IF EXISTS "sync_jobs_tenant_id_fkey";

-- connections → tenants  (created in 20260331102229_init)
ALTER TABLE "connections" DROP CONSTRAINT IF EXISTS "connections_tenant_id_fkey";

-- insights → tenants  (created in 20260414083051_init_agentic_schema)
ALTER TABLE "insights" DROP CONSTRAINT IF EXISTS "insights_tenant_id_fkey";

-- DropTable
DROP TABLE "connections";

-- DropTable
DROP TABLE "insights";

-- DropTable
DROP TABLE "tenants";
