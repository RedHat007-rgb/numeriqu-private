/**
 * Remove the EBPO sample dataset from a SINGLE organization, without touching any
 * other org's data or the old GL sample data (sample_gl_dump / sample_trial_balance).
 *
 * Yesterday's seed (seed-ebpo-clickhouse.ts) defaulted to org-slug
 * "sample-company-2024" — the SAME org the demo users (demo1-5) already use for the
 * GL sample data. That mixed two datasets into one org. This script undoes only the
 * EBPO part of that: it deletes the EBPO rows from ClickHouse for that org's scope
 * and detaches the EBPO ERP connection in Postgres. The EBPO data is then re-seeded
 * cleanly into its OWN new org via seed-ebpo-clickhouse.ts (see README at bottom).
 *
 * SAFE BY DEFAULT: prints what it WOULD delete and exits. Pass --confirm to execute.
 *
 * Usage:
 *   pnpm --filter @repo/db exec tsx scripts/cleanup-ebpo-from-org.ts \
 *     --org-slug sample-company-2024 --external-org-id ebpo_sample_company \
 *     --allow-remote                         # dry-run preview
 *   ... add --confirm                        # actually delete
 *
 * Flags:
 *   --org-slug <slug>           Org to clean (default: sample-company-2024)
 *   --external-org-id <id>      EBPO external org id used at seed time (default: ebpo_sample_company)
 *   --allow-remote              Required to touch a non-localhost DB
 *   --confirm                   Actually perform the deletes (otherwise dry-run)
 *   --keep-connection           Delete ClickHouse rows but LEAVE the ERP connection row
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient as createClickHouseClient } from "@clickhouse/client";
import dotenv from "dotenv";
import { ErpProvider } from "../generated/prisma/client";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../.env.local"), quiet: true });
dotenv.config({ path: path.resolve(__dirname, "../../.env.local"), quiet: true });
dotenv.config({ path: path.resolve(__dirname, "../../../apps/api/.env"), quiet: true });

// The EBPO star-schema tables written by seed-ebpo-clickhouse.ts. Keep in sync with
// that script's tableSpecs. (Views v_ebpo_* derive from these and need no wipe.)
const EBPO_TABLES = [
  "ebpo_dim_date",
  "ebpo_dim_geography",
  "ebpo_dim_department",
  "ebpo_dim_business_unit",
  "ebpo_dim_account",
  "ebpo_dim_client",
  "ebpo_dim_vendor",
  "ebpo_dim_employee",
  "ebpo_fact_payroll",
  "ebpo_fact_revenue",
  "ebpo_fact_general_ledger",
  "ebpo_fact_trial_balance",
  "ebpo_fact_accounts_receivable",
  "ebpo_fact_accounts_payable",
  "ebpo_fact_operations",
  "ebpo_fact_cash_flow",
  "ebpo_fact_fixed_assets",
];

async function getPrisma() {
  const mod = await import("../src/client");
  return mod.prisma as typeof mod.prisma;
}

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function isLocalHost(host: string) {
  const normalized = host.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1";
}

function assertRemoteAllowed(url: string | undefined, allowRemote: boolean, label: string) {
  if (!url) throw new Error(`${label} URL is missing from env.`);
  const parsed = new URL(url);
  if (!isLocalHost(parsed.hostname) && !allowRemote) {
    throw new Error(
      `Refusing to connect to non-local ${label} host (${parsed.hostname}). Re-run with --allow-remote if this is intentional.`,
    );
  }
}

async function countRows(
  client: ReturnType<typeof createClickHouseClient>,
  db: string,
  table: string,
  tenantId: string,
  orgId: string,
): Promise<number> {
  const result = await client.query({
    query: `SELECT count() AS row_count FROM ${db}.${table} WHERE tenant_id = {tenantId:String} AND org_id = {orgId:String}`,
    query_params: { tenantId, orgId },
    format: "JSONEachRow",
  });
  const rows = (await result.json()) as Array<{ row_count: string | number }>;
  return Number(rows[0]?.row_count ?? 0);
}

async function deleteRows(
  client: ReturnType<typeof createClickHouseClient>,
  db: string,
  table: string,
  tenantId: string,
  orgId: string,
): Promise<void> {
  await client.command({
    query: `ALTER TABLE ${db}.${table} DELETE WHERE tenant_id = {tenantId:String} AND org_id = {orgId:String} SETTINGS mutations_sync = 1`,
    query_params: { tenantId, orgId },
  });
}

async function main() {
  const orgSlug = getArg("--org-slug") ?? "sample-company-2024";
  const externalOrgId = getArg("--external-org-id") ?? "ebpo_sample_company";
  const confirm = hasFlag("--confirm");
  const allowRemote = hasFlag("--allow-remote");
  const keepConnection = hasFlag("--keep-connection");

  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set.");
  if (!process.env.CLICKHOUSE_ANALYTICS_URL) throw new Error("CLICKHOUSE_ANALYTICS_URL is not set.");
  assertRemoteAllowed(process.env.DATABASE_URL, allowRemote, "Postgres");
  assertRemoteAllowed(process.env.CLICKHOUSE_ANALYTICS_URL, allowRemote, "ClickHouse");

  const prisma = await getPrisma();
  const org = await prisma.organization.findUnique({
    where: { slug: orgSlug },
    select: { id: true, slug: true, name: true },
  });
  if (!org) throw new Error(`Organization not found for slug "${orgSlug}".`);

  // ClickHouse rows are scoped by tenant_id = Postgres org.id, org_id = externalOrgId.
  const tenantId = org.id;
  const analyticsDb = process.env.CLICKHOUSE_ANALYTICS_DB || "analytics";
  const clickhouse = createClickHouseClient({
    url: process.env.CLICKHOUSE_ANALYTICS_URL,
    username: process.env.CLICKHOUSE_ANALYTICS_USER || "dbt_transformer",
    password: process.env.CLICKHOUSE_ANALYTICS_PASSWORD || "",
    database: analyticsDb,
  });

  // Locate the EBPO ERP connection (so we can report / detach it).
  const connection = await prisma.erpConnection.findUnique({
    where: {
      organizationId_provider_externalOrganizationId: {
        organizationId: org.id,
        provider: ErpProvider.XERO,
        externalOrganizationId: externalOrgId,
      },
    },
    select: { id: true, displayName: true },
  });

  // Tally what would be removed.
  const before: Record<string, number> = {};
  let total = 0;
  for (const table of EBPO_TABLES) {
    const n = await countRows(clickhouse, analyticsDb, table, tenantId, externalOrgId);
    before[table] = n;
    total += n;
  }

  console.log(
    JSON.stringify(
      {
        mode: confirm ? "DELETE" : "DRY_RUN",
        org: { id: org.id, slug: org.slug, name: org.name },
        clickhouse: { db: analyticsDb, externalOrgId, tenantId },
        ebpoRowsByTable: before,
        ebpoRowsTotal: total,
        erpConnection: connection
          ? { id: connection.id, displayName: connection.displayName, willDetach: !keepConnection }
          : null,
      },
      null,
      2,
    ),
  );

  if (!confirm) {
    console.log("\nDRY RUN — nothing deleted. Re-run with --confirm to execute.");
    return;
  }

  // 1) Delete EBPO ClickHouse rows for this org scope.
  const after: Record<string, number> = {};
  for (const table of EBPO_TABLES) {
    await deleteRows(clickhouse, analyticsDb, table, tenantId, externalOrgId);
    after[table] = await countRows(clickhouse, analyticsDb, table, tenantId, externalOrgId);
  }

  // 2) Detach the EBPO ERP connection from this org (Postgres), unless asked to keep it.
  let detached = false;
  if (connection && !keepConnection) {
    await prisma.erpConnection.delete({ where: { id: connection.id } });
    detached = true;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        deleted: true,
        remainingEbpoRowsByTable: after,
        remainingEbpoRowsTotal: Object.values(after).reduce((a, b) => a + b, 0),
        erpConnectionDetached: detached,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      const prisma = await getPrisma();
      await prisma.$disconnect();
    } catch {
      // ignore disconnect errors
    }
  });
