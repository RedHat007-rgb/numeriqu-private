/*
  Warnings:

  - You are about to drop the `connections` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `insights` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `tenants` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "connections" DROP CONSTRAINT "connections_tenant_id_fkey";

-- DropForeignKey (sync_jobs → connections must be removed before connections is dropped)
ALTER TABLE "sync_jobs" DROP CONSTRAINT IF EXISTS "sync_jobs_connection_id_fkey";

-- DropForeignKey
ALTER TABLE "insights" DROP CONSTRAINT "insights_tenant_id_fkey";

-- DropTable
DROP TABLE "connections";

-- DropTable
DROP TABLE "insights";

-- DropTable
DROP TABLE "tenants";
