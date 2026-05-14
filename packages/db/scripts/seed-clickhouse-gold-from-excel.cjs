/* eslint-disable no-console */
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const dotenv = require("dotenv");
const { createClient: createClickHouseClient } = require("@clickhouse/client");

// Load local overrides first, then app defaults.
dotenv.config({ path: path.resolve(__dirname, "../.env.local"), quiet: true });
dotenv.config({ path: path.resolve(__dirname, "../../.env.local"), quiet: true });
dotenv.config({ path: path.resolve(__dirname, "../../../apps/api/.env"), quiet: true });

function getArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function requiredArg(flag) {
  const val = getArg(flag);
  if (!val) throw new Error(`Missing required argument: ${flag} <value>`);
  return val;
}

function toStringId(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function toNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const s = String(value).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseJournalNumber(value) {
  const n = toNumber(value);
  if (n !== null) return Math.max(0, Math.floor(n));
  const s = String(value ?? "").trim();
  const m = s.match(/(\d+)\s*$/);
  if (!m) return 0;
  const parsed = Number(m[1]);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

function normalizeProviderForCh(provider) {
  const raw = String(provider ?? "").trim().toLowerCase();
  if (raw === "quickbooks" || raw === "qb") return "quickbooks";
  return "xero";
}

function isLocalHost(host) {
  const h = host.toLowerCase();
  return h === "localhost" || h === "127.0.0.1";
}

function assertRemoteAllowed(url, allowRemote, label) {
  if (!url) throw new Error(`${label} URL is missing from env.`);
  const parsed = new URL(url);
  if (!isLocalHost(parsed.hostname) && !allowRemote) {
    throw new Error(
      `Refusing to connect to non-local ${label} host (${parsed.hostname}). Re-run with --allow-remote if this is intentional.`,
    );
  }
}

function extractWorkbook(xlsxPath) {
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

  return JSON.parse(res.stdout);
}

function pickSheet(wb, wanted) {
  return (
    wb.sheets[wanted] ??
    Object.entries(wb.sheets).find(([name]) => name.toLowerCase() === wanted.toLowerCase())?.[1] ??
    Object.entries(wb.sheets).find(([name]) => name.toLowerCase().startsWith(wanted.toLowerCase()))?.[1] ??
    null
  );
}

function getPrisma() {
  // Use compiled JS to avoid TypeScript runners (tsx is blocked in this sandbox).
  // `dist/client.js` exports a singleton `prisma` configured via DATABASE_URL.
  return require("../dist/client.js").prisma;
}

async function upsertUser(email) {
  const prisma = getPrisma();
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

async function createUniqueOrgSlug(base) {
  const prisma = getPrisma();
  const slugify = (value) =>
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

async function upsertOrganization({ slug, name, createdById }) {
  const prisma = getPrisma();
  const resolvedSlug = (slug?.trim() || (await createUniqueOrgSlug(name))).slice(0, 64);
  return prisma.organization.upsert({
    where: { slug: resolvedSlug },
    create: { slug: resolvedSlug, name, createdById },
    update: { name },
  });
}

async function ensureMembership(organizationId, userId) {
  const prisma = getPrisma();
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

async function upsertConnection({ organizationId, externalOrganizationId, displayName, createdById }) {
  const prisma = getPrisma();
  return prisma.erpConnection.upsert({
    where: {
      organizationId_provider_externalOrganizationId: {
        organizationId,
        provider: "XERO",
        externalOrganizationId,
      },
    },
    create: {
      organizationId,
      provider: "XERO",
      externalOrganizationId,
      displayName,
      accessTokenEncrypted: "N/A",
      refreshTokenEncrypted: null,
      tokenExpiresAt: null,
      status: "ACTIVE",
      createdById,
      metadata: { seeded: true, source: "excel", externalOrganizationId },
    },
    update: {
      displayName,
      status: "ACTIVE",
      metadata: { seeded: true, source: "excel", externalOrganizationId },
    },
  });
}

async function clickhouseColumns(client, db, table) {
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
  const rows = await res.json();
  return rows.map((r) => r.name);
}

async function clickhouseEngine(client, db, table) {
  const res = await client.query({
    query: `
      SELECT engine
      FROM system.tables
      WHERE database = {db:String} AND name = {table:String}
      LIMIT 1
    `,
    query_params: { db, table },
    format: "JSONEachRow",
  });
  const rows = await res.json();
  return String(rows?.[0]?.engine ?? "");
}

function fillScope(rec, scope, allowedCols) {
  const out = { ...rec };
  for (const [key, val] of Object.entries(scope)) {
    if (!allowedCols.has(key)) continue;
    const existing = out[key];
    if (existing === null || existing === undefined || String(existing).trim() === "") {
      out[key] = val;
    }
  }
  return out;
}

function stripKeys(rec, toStrip) {
  const out = {};
  for (const [k, v] of Object.entries(rec)) {
    if (toStrip.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function adaptRevenueByMonth(records, revenueCols) {
  return records.map((rec) => {
    const out = { ...rec };
    if (revenueCols.has("total_amount") && out.total_amount == null) {
      out.total_amount = out.total_revenue ?? 0;
    }
    if (revenueCols.has("invoice_count") && out.invoice_count == null) {
      out.invoice_count = 0;
    }
    if (revenueCols.has("updated_at") && out.updated_at == null) {
      // ClickHouse DateTime JSON parser does not accept fractional seconds / trailing Z on all clusters.
      out.updated_at = new Date().toISOString().slice(0, 19).replace("T", " ");
    }
    return out;
  });
}

function deriveInvoiceCountByMonth(invoices) {
  const counts = new Map();
  for (const rec of invoices) {
    const issuedAt = toStringId(rec.issued_at);
    const currency = toStringId(rec.currency) || "USD";
    if (!issuedAt) continue;
    const d = new Date(issuedAt);
    if (Number.isNaN(d.getTime())) continue;
    const month = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
    const key = `${month}::${currency}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function mergeInvoiceCountsIntoRevenue(revenue, counts, revenueCols) {
  if (!revenueCols.has("invoice_count")) return revenue;
  return revenue.map((rec) => {
    const month = toStringId(rec.month);
    const currency = toStringId(rec.currency) || "USD";
    const key = `${month.slice(0, 10)}::${currency}`;
    const cnt = counts.get(key);
    if (cnt === undefined) return rec;
    return { ...rec, invoice_count: cnt };
  });
}

function coerceDateOnly(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return value;
    // Excel-exported datetimes arrive as ISO strings like "2024-01-05T00:00:00"
    return s.includes("T") ? s.split("T")[0] : s;
  }
  const s = String(value).trim();
  if (!s) return value;
  return s.includes("T") ? s.split("T")[0] : s;
}

function adaptJournalLines(records) {
  return records.map((rec) => ({
    ...rec,
    journal_number: parseJournalNumber(rec.journal_number),
  }));
}

function stableUuidFromString(input) {
  const s = String(input ?? "");
  const hash = crypto.createHash("md5").update(s).digest("hex"); // 32 hex chars
  // Format as UUID v4-like string. Set version nibble to '4' and variant to 'a'.
  const hex = hash.split("");
  hex[12] = "4";
  hex[16] = "a";
  const h = hex.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function insertJsonEachRow({ client, db, table, records }) {
  if (!records || records.length === 0) return;
  await client.insert({
    table: `${db}.${table}`,
    values: records,
    format: "JSONEachRow",
  });
}

async function countByScope(client, db, table, scope) {
  const res = await client.query({
    query: `
      SELECT count() AS c
      FROM ${db}.${table}
      WHERE tenant_id = {tenantId:String} AND org_id = {orgId:String}
    `,
    query_params: { tenantId: scope.tenant_id, orgId: scope.org_id },
    format: "JSONEachRow",
  });
  const rows = await res.json();
  return Number(rows?.[0]?.c ?? 0);
}

async function deleteByScope(client, db, table, scope) {
  // NOTE: ClickHouse mutations are async; we follow up with a mutation wait to avoid racing inserts.
  await client.command({
    query: `
      ALTER TABLE ${db}.${table}
      DELETE WHERE tenant_id = {tenantId:String} AND org_id = {orgId:String}
    `,
    query_params: { tenantId: scope.tenant_id, orgId: scope.org_id },
  });
}

async function waitForMutations(client, db, timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await client.query({
      query: `
        SELECT count() AS c
        FROM system.mutations
        WHERE database = {db:String}
          AND is_done = 0
      `,
      query_params: { db },
      format: "JSONEachRow",
    });
    const rows = await res.json();
    const pending = Number(rows?.[0]?.c ?? 0);
    if (pending === 0) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Timed out waiting for ClickHouse mutations in db=${db}`);
}

async function main() {
  const filePath = requiredArg("--file");
  const userEmail = requiredArg("--user-email");
  const orgName = getArg("--org-name") ?? "test data";
  const orgSlug = getArg("--org-slug");
  const dryRun = hasFlag("--dry-run");
  const allowRemote = hasFlag("--allow-remote");

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
  ];

  const missing = required.filter(([, rows]) => rows.length === 0).map(([name]) => name);
  if (missing.length > 0) throw new Error(`Missing/empty expected sheets in XLSX: ${missing.join(", ")}`);

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          dryRun: true,
          userEmail: userEmail.trim().toLowerCase(),
          orgName,
          orgSlug: orgSlug ?? null,
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
        },
        null,
        2,
      ),
    );
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
    externalOrganizationId: externalOrgId,
    displayName: orgName,
    createdById: user.id,
  });

  const scope = {
    tenant_id: org.id,
    user_id: user.id,
    connection_id: conn.id,
    provider: normalizeProviderForCh("xero"),
    org_id: externalOrgId,
    org_name: orgName,
  };
  const resetScope = hasFlag("--reset-scope");
  const deactivateOtherConns = hasFlag("--deactivate-other-conns");
  const onlyTable = getArg("--only-table");

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
  };
  const ragEngine = await clickhouseEngine(clickhouse, analyticsDb, "rag_context_invoices");

  if (deactivateOtherConns) {
    const prisma = getPrisma();
    await prisma.erpConnection.updateMany({
      where: {
        organizationId: org.id,
        status: "ACTIVE",
        NOT: { id: conn.id },
      },
      data: { status: "DISCONNECTED" },
    });
  }

  if (resetScope) {
    const deletable = [
      "fact_accounting_invoices",
      "fact_accounting_payment_applications",
      "fact_accounting_journal_lines",
      "dim_accounting_accounts",
      "dim_clients",
      "revenue_by_month",
    ];
    for (const t of deletable) {
      await deleteByScope(clickhouse, analyticsDb, t, scope);
    }
    // We cannot reliably wait on system.mutations with the dbt_transformer user on all clusters.
    // Deletions are async; new inserts should land in newer parts and not be affected.
  }

  const invoicesPrepared = invoicesSheet.map((r) => {
    const filled = fillScope(r, scope, tableCols.fact_accounting_invoices);
    // Ensure invoice_id is UUID-like so `rag_context_invoices` view (typed as UUID on some clusters) does not break.
    const key = toStringId(filled.invoice_external_id || filled.invoice_number || filled.invoice_id || "");
    return { ...filled, invoice_id: stableUuidFromString(key) };
  });
  const paymentsPrepared = paymentsSheet.map((r) => fillScope(r, scope, tableCols.fact_accounting_payment_applications));
  const journalPrepared = adaptJournalLines(
    journalLinesSheet.map((r) => fillScope(r, scope, tableCols.fact_accounting_journal_lines)),
  );
  const accountsPrepared = accountsSheet.map((r) => fillScope(r, scope, tableCols.dim_accounting_accounts));
  const ragPrepared = ragSheet.map((r) => fillScope(r, scope, tableCols.rag_context_invoices));

  const clientsPrepared = dimClientsSheet
    .map((r) => stripKeys(r, new Set(["_version"])))
    .map((r) => ({
      ...r,
      first_invoice_date: coerceDateOnly(r.first_invoice_date),
      last_invoice_date: coerceDateOnly(r.last_invoice_date),
    }))
    .map((r) => fillScope(r, scope, tableCols.dim_clients));

  let revenuePrepared = adaptRevenueByMonth(
    revenueSheet
      .map((r) => ({ ...r, month: coerceDateOnly(r.month) }))
      .map((r) => fillScope(r, scope, tableCols.revenue_by_month)),
    tableCols.revenue_by_month,
  );
  revenuePrepared = mergeInvoiceCountsIntoRevenue(
    revenuePrepared,
    deriveInvoiceCountByMonth(invoicesPrepared),
    tableCols.revenue_by_month,
  );

  const summary = {
    ok: true,
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

  const should = (name) => !onlyTable || String(onlyTable).toLowerCase() === String(name).toLowerCase();

  if (should("fact_accounting_invoices")) {
    await insertJsonEachRow({ client: clickhouse, db: analyticsDb, table: "fact_accounting_invoices", records: invoicesPrepared });
  }
  if (should("fact_accounting_payment_applications")) {
    await insertJsonEachRow({
      client: clickhouse,
      db: analyticsDb,
      table: "fact_accounting_payment_applications",
      records: paymentsPrepared,
    });
  }
  if (should("fact_accounting_journal_lines")) {
    await insertJsonEachRow({ client: clickhouse, db: analyticsDb, table: "fact_accounting_journal_lines", records: journalPrepared });
  }
  if (should("dim_accounting_accounts")) {
    await insertJsonEachRow({ client: clickhouse, db: analyticsDb, table: "dim_accounting_accounts", records: accountsPrepared });
  }
  if (should("dim_clients")) {
    await insertJsonEachRow({ client: clickhouse, db: analyticsDb, table: "dim_clients", records: clientsPrepared });
  }
  if (should("rag_context_invoices")) {
    if (ragEngine.toLowerCase() === "view") {
      // `rag_context_invoices` is a view in dbt deployments; it derives from `fact_accounting_invoices`.
      // We intentionally do not insert into it.
    } else {
      await insertJsonEachRow({ client: clickhouse, db: analyticsDb, table: "rag_context_invoices", records: ragPrepared });
    }
  }
  if (should("revenue_by_month")) {
    await insertJsonEachRow({ client: clickhouse, db: analyticsDb, table: "revenue_by_month", records: revenuePrepared });
  }

  const verified = {
    revenue_by_month: await countByScope(clickhouse, analyticsDb, "revenue_by_month", scope),
    fact_accounting_invoices: await countByScope(clickhouse, analyticsDb, "fact_accounting_invoices", scope),
    fact_accounting_payment_applications: await countByScope(
      clickhouse,
      analyticsDb,
      "fact_accounting_payment_applications",
      scope,
    ),
    fact_accounting_journal_lines: await countByScope(clickhouse, analyticsDb, "fact_accounting_journal_lines", scope),
    dim_accounting_accounts: await countByScope(clickhouse, analyticsDb, "dim_accounting_accounts", scope),
    rag_context_invoices: await countByScope(clickhouse, analyticsDb, "rag_context_invoices", scope),
    dim_clients: await countByScope(clickhouse, analyticsDb, "dim_clients", scope),
  };

  console.log(
    JSON.stringify(
      {
        ...summary,
        seeded: true,
        rag_context_invoices_engine: ragEngine,
        scope: { tenant_id: scope.tenant_id, org_id: scope.org_id, connection_id: scope.connection_id, user_id: scope.user_id },
        verified,
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
      const prisma = getPrisma();
      await prisma.$disconnect();
    } catch {
      // ignore
    }
  });
