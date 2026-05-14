import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { createClient as createClickHouseClient } from "@clickhouse/client";
import { ErpProvider } from "../generated/prisma/client";

type SheetDump = {
  headers: string[];
  records: Array<Record<string, unknown>>;
};

type ExtractedWorkbook = {
  sheets: Record<string, SheetDump>;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load local overrides first, then app defaults.
dotenv.config({ path: path.resolve(__dirname, "../.env.local"), quiet: true });
dotenv.config({ path: path.resolve(__dirname, "../../.env.local"), quiet: true });
dotenv.config({ path: path.resolve(__dirname, "../../../apps/api/.env"), quiet: true });

async function getPrisma() {
  const mod = await import("../src/client");
  return mod.prisma as typeof mod.prisma;
}

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function requiredArg(flag: string): string {
  const val = getArg(flag);
  if (!val) throw new Error(`Missing required argument: ${flag} <value>`);
  return val;
}

function toStringId(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeProviderForCh(provider: unknown): "xero" | "quickbooks" {
  const raw = String(provider ?? "").trim().toLowerCase();
  if (raw === "quickbooks" || raw === "qb") return "quickbooks";
  return "xero";
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const s = String(value).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseJournalNumber(value: unknown): number {
  const n = toNumber(value);
  if (n !== null) return Math.max(0, Math.floor(n));
  const s = String(value ?? "").trim();
  const m = s.match(/(\d+)\s*$/);
  if (!m) return 0;
  const parsed = Number(m[1]);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

function isLocalHost(host: string) {
  const h = host.toLowerCase();
  return h === "localhost" || h === "127.0.0.1";
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

function extractWorkbook(xlsxPath: string): ExtractedWorkbook {
  const extractorPath = path.resolve(__dirname, "extract_xlsx_json.py");
  if (!fs.existsSync(extractorPath)) {
    throw new Error(`Missing extractor script at ${extractorPath}`);
  }

  const res = spawnSync("python3", [extractorPath, xlsxPath], {
    encoding: "utf8",
    maxBuffer: 200 * 1024 * 1024,
  });

  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`XLSX extract failed (exit ${res.status}): ${res.stderr || res.stdout}`);
  }

  return JSON.parse(res.stdout) as ExtractedWorkbook;
}

function pickSheet(wb: ExtractedWorkbook, wanted: string) {
  return (
    wb.sheets[wanted] ??
    Object.entries(wb.sheets).find(([name]) => name.toLowerCase() === wanted.toLowerCase())?.[1] ??
    Object.entries(wb.sheets).find(([name]) => name.toLowerCase().startsWith(wanted.toLowerCase()))?.[1] ??
    null
  );
}

async function upsertUser(email: string) {
  const prisma = await getPrisma();
  const normalized = email.trim().toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email: normalized } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email: normalized,
      fullName: "Seeded Test Data",
      supabaseUserId: crypto.randomUUID(),
      isActive: true,
      isVerified: true,
    },
  });
}

async function createUniqueOrgSlug(base: string) {
  const prisma = await getPrisma();
  const slugify = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "workspace";

  const normalized = slugify(base);
  for (let i = 0; i < 8; i += 1) {
    const suffix = i === 0 ? "" : `-${Math.floor(Math.random() * 10000)}`;
    const candidate = `${normalized}${suffix}`;
    const exists = await prisma.organization.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });
    if (!exists) return candidate;
  }
  return `${normalized}-${Date.now().toString(36)}`;
}

async function upsertOrganization(params: { slug?: string; name: string; createdById: string }) {
  const prisma = await getPrisma();
  const slug = params.slug?.trim() || (await createUniqueOrgSlug(params.name));
  return prisma.organization.upsert({
    where: { slug },
    create: {
      slug,
      name: params.name,
      createdById: params.createdById,
    },
    update: {
      name: params.name,
    },
  });
}

async function ensureMembership(organizationId: string, userId: string) {
  const prisma = await getPrisma();
  return prisma.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId, userId } },
    create: {
      organizationId,
      userId,
      role: "ADMIN",
      canViewDashboard: true,
      canCreateDashboard: true,
      canShareDashboard: true,
    },
    update: {
      role: "ADMIN",
      canViewDashboard: true,
      canCreateDashboard: true,
      canShareDashboard: true,
      leftAt: null,
    },
  });
}

async function upsertConnection(params: {
  organizationId: string;
  provider: ErpProvider;
  externalOrganizationId: string;
  displayName: string;
  createdById: string;
}) {
  const { organizationId, provider, externalOrganizationId, displayName, createdById } = params;
  const prisma = await getPrisma();
  return prisma.erpConnection.upsert({
    where: {
      organizationId_provider_externalOrganizationId: {
        organizationId,
        provider,
        externalOrganizationId,
      },
    },
    create: {
      organizationId,
      provider,
      externalOrganizationId,
      displayName,
      accessTokenEncrypted: "N/A",
      refreshTokenEncrypted: null,
      tokenExpiresAt: null,
      status: "ACTIVE",
      createdById,
      metadata: {
        seeded: true,
        source: "excel",
        externalOrganizationId,
      },
    },
    update: {
      displayName,
      status: "ACTIVE",
      metadata: {
        seeded: true,
        source: "excel",
        externalOrganizationId,
      },
    },
  });
}

async function clickhouseColumns(client: ReturnType<typeof createClickHouseClient>, db: string, table: string) {
  const res = await client.query({
    query: `
      SELECT name
      FROM system.columns
      WHERE database = {db:String} AND table = {table:String}
      ORDER BY position ASC
    `,
    query_params: { db, table },
    format: "JSONEachRow",
  });
  const rows = (await res.json()) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function fillScope(rec: Record<string, unknown>, scope: Record<string, string>, allowedCols: Set<string>) {
  const out: Record<string, unknown> = { ...rec };
  for (const [key, val] of Object.entries(scope)) {
    if (!allowedCols.has(key)) continue;
    const existing = out[key];
    if (existing === null || existing === undefined || String(existing).trim() === "") {
      out[key] = val;
    }
  }
  return out;
}

function stripKeys(rec: Record<string, unknown>, toStrip: Set<string>) {
  if (toStrip.size === 0) return rec;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (toStrip.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function adaptRevenueByMonth(records: Array<Record<string, unknown>>, revenueCols: Set<string>) {
  // Ensure compatibility with newer schema that includes total_amount/invoice_count/updated_at.
  return records.map((rec) => {
    const out: Record<string, unknown> = { ...rec };
    if (revenueCols.has("total_amount") && out["total_amount"] == null) {
      out["total_amount"] = out["total_revenue"] ?? 0;
    }
    if (revenueCols.has("invoice_count") && out["invoice_count"] == null) {
      // Best-effort: unknown in this sheet; leave default 0. (We also backfill via invoice-derived calc below.)
      out["invoice_count"] = 0;
    }
    if (revenueCols.has("updated_at") && out["updated_at"] == null) {
      // ClickHouse DateTime requires "YYYY-MM-DD HH:MM:SS" — not ISO 8601 with milliseconds/Z.
      out["updated_at"] = new Date().toISOString().replace("T", " ").slice(0, 19);
    }
    return out;
  });
}

function deriveInvoiceCountByMonth(invoices: Array<Record<string, unknown>>) {
  const counts = new Map<string, number>();
  for (const rec of invoices) {
    const issuedAt = toStringId(rec["issued_at"]);
    const currency = toStringId(rec["currency"]) || "USD";
    if (!issuedAt) continue;
    const d = new Date(issuedAt);
    if (Number.isNaN(d.getTime())) continue;
    const month = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
    const key = `${month}::${currency}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function mergeInvoiceCountsIntoRevenue(
  revenue: Array<Record<string, unknown>>,
  counts: Map<string, number>,
  revenueCols: Set<string>,
) {
  if (!revenueCols.has("invoice_count")) return revenue;
  return revenue.map((rec) => {
    const month = toStringId(rec["month"]);
    const currency = toStringId(rec["currency"]) || "USD";
    const key = `${month.slice(0, 10)}::${currency}`;
    const cnt = counts.get(key);
    if (cnt === undefined) return rec;
    return { ...rec, invoice_count: cnt };
  });
}

function coerceDateOnly(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const s = String(value).trim();
  if (!s) return value;
  // Strip time component whether separated by T or a space (e.g. "2026-04-27 18:30:00")
  const match = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : s;
}

/**
 * Shift a date/datetime string forward by N months.
 * Returns the original value unchanged if it can't be parsed.
 */
function shiftDateByMonths(value: unknown, months: number): unknown {
  if (months === 0 || value === null || value === undefined) return value;
  const s = String(value).trim();
  if (!s) return value;
  const d = new Date(s);
  if (isNaN(d.getTime())) return value;
  d.setMonth(d.getMonth() + months);
  // For date-only inputs return date-only; for datetimes return ClickHouse-compatible "YYYY-MM-DD HH:MM:SS"
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return d.toISOString().slice(0, 10);
  }
  // ClickHouse DateTime expects no milliseconds or Z suffix
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function shiftDateFields(
  record: Record<string, unknown>,
  fields: string[],
  months: number,
): Record<string, unknown> {
  if (months === 0) return record;
  const out = { ...record };
  for (const f of fields) {
    if (f in out) out[f] = shiftDateByMonths(out[f], months);
  }
  return out;
}

function adaptJournalLines(records: Array<Record<string, unknown>>) {
  return records.map((rec) => ({
    ...rec,
    journal_number: parseJournalNumber(rec["journal_number"]),
  }));
}

async function insertJsonEachRow(args: {
  client: ReturnType<typeof createClickHouseClient>;
  db: string;
  table: string;
  records: Array<Record<string, unknown>>;
}) {
  const { client, db, table, records } = args;
  if (records.length === 0) return;
  await client.insert({
    table: `${db}.${table}`,
    values: records,
    format: "JSONEachRow",
  });
}

async function main() {
  const filePath = requiredArg("--file");
  const userEmail = requiredArg("--user-email");
  const orgName = getArg("--org-name") ?? "test data";
  const orgSlug = getArg("--org-slug");
  const dryRun = hasFlag("--dry-run");
  const allowRemote = hasFlag("--allow-remote");
  const shiftMonths = parseInt(getArg("--shift-months") ?? "0", 10) || 0;

  const absFilePath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(absFilePath)) throw new Error(`XLSX not found: ${absFilePath}`);

  const wb = extractWorkbook(absFilePath);

  const invoicesSheet = pickSheet(wb, "fact_accounting_invoices")?.records ?? [];
  const paymentsSheet = pickSheet(wb, "fact_accounting_payment_applica")?.records ?? [];
  const journalLinesSheet = pickSheet(wb, "fact_accounting_journal_lines")?.records ?? [];
  const accountsSheet = pickSheet(wb, "dim_accounting_accounts")?.records ?? [];
  const ragSheet = pickSheet(wb, "rag_context_invoices")?.records ?? [];
  const dimClientsSheet = pickSheet(wb, "dim_clients")?.records ?? [];
  const revenueSheet = pickSheet(wb, "revenue_by_month")?.records ?? [];

  const required = [
    ["fact_accounting_invoices", invoicesSheet],
    ["fact_accounting_payment_applications", paymentsSheet],
    ["fact_accounting_journal_lines", journalLinesSheet],
    ["dim_accounting_accounts", accountsSheet],
    ["rag_context_invoices", ragSheet],
    ["dim_clients", dimClientsSheet],
    ["revenue_by_month", revenueSheet],
  ] as const;

  const missing = required.filter(([, rows]) => rows.length === 0).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Missing/empty expected sheets in XLSX: ${missing.join(", ")}`);
  }

  if (dryRun) {
    const preview = {
      ok: true,
      dryRun: true,
      userEmail: userEmail.trim().toLowerCase(),
      orgName,
      orgSlug: orgSlug ?? null,
      // The real IDs are only created when not in dry-run mode.
      plannedIds: {
        tenant_id: "<organization.id (uuid)>",
        user_id: "<users.id (uuid)>",
        connection_id: "<erp_connections.id (uuid)>",
        provider: "xero",
        org_id: getArg("--external-org-id") ?? "<generated test_data_XXXXXXXX>",
        org_name: orgName,
      },
      workbook: {
        revenue_by_month: revenueSheet.length,
        fact_accounting_invoices: invoicesSheet.length,
        fact_accounting_payment_applications: paymentsSheet.length,
        fact_accounting_journal_lines: journalLinesSheet.length,
        dim_accounting_accounts: accountsSheet.length,
        rag_context_invoices: ragSheet.length,
        dim_clients: dimClientsSheet.length,
      },
      notes: [
        "Will ignore dim_clients._version (ClickHouse column is MATERIALIZED).",
        "Will coerce fact_accounting_journal_lines.journal_number to UInt64 (Excel contains alphanumeric values).",
        "Will backfill missing tenant_id/user_id/connection_id/provider/org_id/org_name columns during import.",
      ],
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(preview, null, 2));
    return;
  }

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set. Set it in packages/db/.env.local or apps/api/.env before running.");
  }
  if (!process.env.CLICKHOUSE_ANALYTICS_URL) {
    throw new Error("CLICKHOUSE_ANALYTICS_URL is not set. Set it in apps/api/.env before running.");
  }

  assertRemoteAllowed(process.env.DATABASE_URL, allowRemote, "Postgres");
  assertRemoteAllowed(process.env.CLICKHOUSE_ANALYTICS_URL, allowRemote, "ClickHouse");

  const user = await upsertUser(userEmail);
  const org = await upsertOrganization({ slug: orgSlug, name: orgName, createdById: user.id });
  await ensureMembership(org.id, user.id);

  const externalOrgId = getArg("--external-org-id") ?? `test_data_${crypto.randomUUID().slice(0, 8)}`;
  const conn = await upsertConnection({
    organizationId: org.id,
    provider: ErpProvider.XERO,
    externalOrganizationId: externalOrgId,
    displayName: orgName,
    createdById: user.id,
  });

  const providerCh = normalizeProviderForCh("xero");
  const scope = {
    tenant_id: org.id,
    user_id: user.id,
    connection_id: conn.id,
    provider: providerCh,
    org_id: externalOrgId,
    org_name: orgName,
  };

  const analyticsDb = process.env.CLICKHOUSE_ANALYTICS_DB || "analytics";
  const clickhouse = createClickHouseClient({
    url: process.env.CLICKHOUSE_ANALYTICS_URL,
    username: process.env.CLICKHOUSE_ANALYTICS_USER || "dbt_transformer",
    password: process.env.CLICKHOUSE_ANALYTICS_PASSWORD || "",
    database: analyticsDb,
  });

  const tableCols = {
    revenue_by_month: new Set(await clickhouseColumns(clickhouse, analyticsDb, "revenue_by_month")),
    fact_accounting_invoices: new Set(await clickhouseColumns(clickhouse, analyticsDb, "fact_accounting_invoices")),
    fact_accounting_payment_applications: new Set(
      await clickhouseColumns(clickhouse, analyticsDb, "fact_accounting_payment_applications"),
    ),
    fact_accounting_journal_lines: new Set(
      await clickhouseColumns(clickhouse, analyticsDb, "fact_accounting_journal_lines"),
    ),
    dim_accounting_accounts: new Set(await clickhouseColumns(clickhouse, analyticsDb, "dim_accounting_accounts")),
    rag_context_invoices: new Set(await clickhouseColumns(clickhouse, analyticsDb, "rag_context_invoices")),
    dim_clients: new Set(await clickhouseColumns(clickhouse, analyticsDb, "dim_clients")),
  } as const;

  // Normalize invoice_type to Xero's standard types so the agent's arFilter works correctly.
  // The arFilter accepts ACCREC (AR / customer invoices) and rejects ACCPAY (AP / supplier bills).
  // Any non-ACCPAY type that isn't already standard (accrec/ACCREC/empty) is treated as a
  // receivable invoice and normalized to ACCREC.
  const INVOICE_DATE_FIELDS = ["issued_at", "due_at", "paid_at", "updated_at", "synced_at"];
  const PAYMENT_DATE_FIELDS = ["payment_at", "updated_at", "synced_at"];
  const JOURNAL_DATE_FIELDS = ["transaction_date", "updated_at", "synced_at"];

  const normalizeInvoiceType = (raw: unknown): string => {
    const t = String(raw ?? "").trim().toUpperCase();
    if (t === "ACCPAY") return "ACCPAY"; // keep AP bills as-is (excluded by arFilter)
    if (t === "ACCREC" || t === "") return t; // already standard
    return "ACCREC"; // normalize EXPENSE, PAYROLL, TRAVEL, ASSET, etc. → ACCREC
  };
  const invoicesPrepared = invoicesSheet
    .map((r) => fillScope(r, scope, tableCols.fact_accounting_invoices))
    .map((r: Record<string, unknown>) =>
      "invoice_type" in r ? { ...r, invoice_type: normalizeInvoiceType(r["invoice_type"]) } : r,
    )
    .map((r: Record<string, unknown>) => shiftDateFields(r, INVOICE_DATE_FIELDS, shiftMonths));

  const paymentsPrepared = paymentsSheet
    .map((r) => fillScope(r, scope, tableCols.fact_accounting_payment_applications))
    .map((r: Record<string, unknown>) => shiftDateFields(r, PAYMENT_DATE_FIELDS, shiftMonths));
  const journalPrepared = adaptJournalLines(
    journalLinesSheet
      .map((r) => fillScope(r, scope, tableCols.fact_accounting_journal_lines))
      .map((r: Record<string, unknown>) => shiftDateFields(r, JOURNAL_DATE_FIELDS, shiftMonths)),
  );
  const accountsPrepared = accountsSheet.map((r) => fillScope(r, scope, tableCols.dim_accounting_accounts));
  const ragPrepared = ragSheet.map((r) => fillScope(r, scope, tableCols.rag_context_invoices));

  const clientsStrip = new Set<string>(["_version"]);
  const clientsPrepared = dimClientsSheet
    .map((r) => stripKeys(r, clientsStrip))
    .map((r) => ({
      ...r,
      first_invoice_date: coerceDateOnly(shiftDateByMonths(r["first_invoice_date"], shiftMonths)),
      last_invoice_date: coerceDateOnly(shiftDateByMonths(r["last_invoice_date"], shiftMonths)),
    }))
    .map((r) => fillScope(r, scope, tableCols.dim_clients));

  const revenueBase = revenueSheet
    .map((r) => ({ ...r, month: coerceDateOnly(shiftDateByMonths(r["month"], shiftMonths)) }))
    .map((r) => fillScope(r, scope, tableCols.revenue_by_month));
  let revenuePrepared = adaptRevenueByMonth(revenueBase, tableCols.revenue_by_month);
  revenuePrepared = mergeInvoiceCountsIntoRevenue(
    revenuePrepared,
    deriveInvoiceCountByMonth(invoicesPrepared),
    tableCols.revenue_by_month,
  );

  const summary = {
    ok: true,
    dryRun,
    user: { id: user.id, email: user.email },
    organization: { id: org.id, slug: org.slug, name: org.name },
    connection: { id: conn.id, provider: conn.provider, externalOrganizationId: conn.externalOrganizationId },
    clickhouse: { db: analyticsDb, url: process.env.CLICKHOUSE_ANALYTICS_URL },
    planned: {
      revenue_by_month: revenuePrepared.length,
      fact_accounting_invoices: invoicesPrepared.length,
      fact_accounting_payment_applications: paymentsPrepared.length,
      fact_accounting_journal_lines: journalPrepared.length,
      dim_accounting_accounts: accountsPrepared.length,
      rag_context_invoices: ragPrepared.length,
      dim_clients: clientsPrepared.length,
    },
  };

  await insertJsonEachRow({ client: clickhouse, db: analyticsDb, table: "fact_accounting_invoices", records: invoicesPrepared });
  await insertJsonEachRow({
    client: clickhouse,
    db: analyticsDb,
    table: "fact_accounting_payment_applications",
    records: paymentsPrepared,
  });
  await insertJsonEachRow({
    client: clickhouse,
    db: analyticsDb,
    table: "fact_accounting_journal_lines",
    records: journalPrepared,
  });
  await insertJsonEachRow({
    client: clickhouse,
    db: analyticsDb,
    table: "dim_accounting_accounts",
    records: accountsPrepared,
  });
  await insertJsonEachRow({
    client: clickhouse,
    db: analyticsDb,
    table: "dim_clients",
    records: clientsPrepared,
  });
  // rag_context_invoices is a ClickHouse View — inserts are not supported; skip it.
  await insertJsonEachRow({
    client: clickhouse,
    db: analyticsDb,
    table: "revenue_by_month",
    records: revenuePrepared,
  });

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ...summary, seeded: true }, null, 2));
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      const prisma = await getPrisma();
      await prisma.$disconnect();
    } catch {
      /* ignore */
    }
  });
