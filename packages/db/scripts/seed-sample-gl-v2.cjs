/* eslint-disable no-console */
/**
 * Seed GL-based sample data into ClickHouse for the "Sample Company 2024" demo org.
 *
 * Creates two dedicated tables:
 *   analytics.sample_gl_dump        — every GL transaction (from gl_dump_2024 sheet)
 *   analytics.sample_trial_balance  — account-level net balances (from trial_balance_2024 sheet)
 *
 * Both are scoped by tenant_id + org_id so multiple demo users are isolated.
 *
 * Usage:
 *   node seed-sample-gl-v2.cjs \
 *     --file        "/Users/you/Downloads/Sample Data - 1Y.xlsx" \
 *     --user-email  you@example.com \
 *     --org-name    "Sample Company 2024"          (optional, default shown) \
 *     --org-slug    sample-company-2024            (optional) \
 *     --ext-org-id  sample_gl_2024                 (optional) \
 *     --wipe                                       (delete existing rows first)
 */

const { spawnSync } = require("node:child_process");
const crypto        = require("node:crypto");
const path          = require("node:path");

const dotenv = require("dotenv");
const { createClient: ch } = require("@clickhouse/client");

dotenv.config({ path: path.resolve(__dirname, "../.env.local"),          quiet: true });
dotenv.config({ path: path.resolve(__dirname, "../../.env.local"),       quiet: true });
dotenv.config({ path: path.resolve(__dirname, "../../../apps/api/.env"), quiet: true });

// ─── CLI helpers ──────────────────────────────────────────────────────────────

function arg(flag)      { const i = process.argv.indexOf(flag); return i === -1 ? undefined : process.argv[i + 1]; }
function flag(f)        { return process.argv.includes(f); }
function req(f)         { const v = arg(f); if (!v) throw new Error(`Missing: ${f} <value>`); return v; }

// ─── Prisma ──────────────────────────────────────────────────────────────────

function prisma() { return require("../dist/client.js").prisma; }

async function upsertUser(email) {
  const db = prisma();
  const e  = email.trim().toLowerCase();
  return (await db.user.findUnique({ where: { email: e } })) ??
    db.user.create({ data: { email: e, fullName: "Sample Data", supabaseUserId: crypto.randomUUID(), isActive: true, isVerified: true } });
}

async function upsertOrg({ slug, name, createdById }) {
  const db = prisma();
  return db.organization.upsert({
    where:  { slug },
    create: { slug, name, createdById },
    update: { name },
  });
}

async function ensureMembership(organizationId, userId) {
  const db = prisma();
  return db.organizationMembership.upsert({
    where:  { organizationId_userId: { organizationId, userId } },
    create: { organizationId, userId, role: "ADMIN", canViewDashboard: true, canCreateDashboard: true, canShareDashboard: true },
    update: { role: "ADMIN", canViewDashboard: true, canCreateDashboard: true, canShareDashboard: true, leftAt: null },
  });
}

async function upsertConnection({ organizationId, externalOrganizationId, displayName, createdById }) {
  const db = prisma();
  return db.erpConnection.upsert({
    where:  { organizationId_provider_externalOrganizationId: { organizationId, provider: "XERO", externalOrganizationId } },
    create: {
      organizationId, provider: "XERO", externalOrganizationId, displayName,
      accessTokenEncrypted: "N/A", status: "ACTIVE", createdById,
      metadata: { seeded: true, source: "sample_gl_v2", orgName: displayName },
    },
    update: {
      displayName, status: "ACTIVE",
      metadata: { seeded: true, source: "sample_gl_v2", orgName: displayName },
    },
  });
}

// ─── ClickHouse ───────────────────────────────────────────────────────────────

function makeClient() {
  return ch({
    url:      process.env.CLICKHOUSE_ANALYTICS_URL  || process.env.CLICKHOUSE_URL  || "http://localhost:8123",
    username: process.env.CLICKHOUSE_ANALYTICS_USER || process.env.CLICKHOUSE_USER || "default",
    password: process.env.CLICKHOUSE_ANALYTICS_PASSWORD || process.env.CLICKHOUSE_PASSWORD || "",
  });
}

async function run(client, query) {
  const r = await client.query({ query });
  await r.text();
}

async function ensureSchema(client, db) {
  await run(client, `CREATE DATABASE IF NOT EXISTS ${db}`);

  // GL transactions table
  await run(client, `
    CREATE TABLE IF NOT EXISTS ${db}.sample_gl_dump (
      tenant_id        String,
      org_id           String,
      date             Nullable(Date),
      transaction_id   String       DEFAULT '',
      journal_type     String       DEFAULT '',
      account_number   String       DEFAULT '',
      account_name     String       DEFAULT '',
      account_type     String       DEFAULT '',
      vendor_customer  String       DEFAULT '',
      description      String       DEFAULT '',
      debit            Decimal(18,4) DEFAULT 0,
      credit           Decimal(18,4) DEFAULT 0,
      running_balance  Decimal(18,4) DEFAULT 0,
      department       String       DEFAULT '',
      class            String       DEFAULT '',
      inserted_at      DateTime     DEFAULT now()
    ) ENGINE = ReplacingMergeTree()
    ORDER BY (tenant_id, org_id, transaction_id, account_number)
  `);

  // Trial balance table
  await run(client, `
    CREATE TABLE IF NOT EXISTS ${db}.sample_trial_balance (
      tenant_id      String,
      org_id         String,
      account_number String       DEFAULT '',
      account_name   String       DEFAULT '',
      account_type   String       DEFAULT '',
      debit          Decimal(18,4) DEFAULT 0,
      credit         Decimal(18,4) DEFAULT 0,
      net_balance    Decimal(18,4) DEFAULT 0,
      inserted_at    DateTime     DEFAULT now()
    ) ENGINE = ReplacingMergeTree()
    ORDER BY (tenant_id, org_id, account_number)
  `);

  console.log(`✅ Schema ready: ${db}.sample_gl_dump + ${db}.sample_trial_balance`);
}

async function wipeScope(client, db, tenantId, orgId) {
  for (const tbl of ["sample_gl_dump", "sample_trial_balance"]) {
    await client.command({
      query: `ALTER TABLE ${db}.${tbl} DELETE WHERE tenant_id={t:String} AND org_id={o:String}`,
      query_params: { t: tenantId, o: orgId },
    });
  }
  console.log("🗑️  Wiped existing rows");
}

async function insert(client, db, table, rows) {
  if (!rows.length) return;
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    await client.insert({ table: `${db}.${table}`, values: rows.slice(i, i + BATCH), format: "JSONEachRow" });
  }
}

// ─── Excel extraction ─────────────────────────────────────────────────────────

function extractExcel(filePath) {
  const extractor = path.resolve(__dirname, "extract_xlsx_json.py");
  const res = spawnSync("python3", [extractor, filePath], { encoding: "utf8", maxBuffer: 100 * 1024 * 1024 });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`Excel extract failed: ${res.stderr || res.stdout}`);
  return JSON.parse(res.stdout);
}

// ─── Data helpers ─────────────────────────────────────────────────────────────

function str(v)  { return v == null ? "" : String(v).trim(); }
function num(v)  { const n = Number(v); return isFinite(n) ? n : 0; }
function dateStr(v) {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.valueOf())) return null;
  return d.toISOString().slice(0, 10); // Date-only: YYYY-MM-DD
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const filePath  = req("--file");
  const userEmail = req("--user-email");
  const orgName   = arg("--org-name")   ?? "Sample Company 2024";
  const orgSlug   = (arg("--org-slug")  ?? orgName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")).slice(0, 48) || "sample-company";
  const extOrgId  = arg("--ext-org-id") ?? "sample_gl_2024";
  const doWipe    = flag("--wipe");
  const db        = (process.env.CLICKHOUSE_ANALYTICS_DB || "analytics").trim();

  console.log(`\n📂 File:    ${filePath}`);
  console.log(`🏢 Org:     ${orgName}  (slug: ${orgSlug}, ext_org_id: ${extOrgId})`);
  console.log(`📧 User:    ${userEmail}`);
  console.log(`🗄️  CH DB:   ${db}`);

  // 1. Extract Excel
  console.log("\n⏳ Reading Excel...");
  const wb = extractExcel(filePath);
  const glSheet = wb.sheets["gl_dump_2024"]        || wb.sheets[Object.keys(wb.sheets).find(n => n.toLowerCase().includes("gl"))];
  const tbSheet = wb.sheets["trial_balance_2024"]  || wb.sheets[Object.keys(wb.sheets).find(n => n.toLowerCase().includes("trial"))];

  if (!glSheet) throw new Error("Cannot find gl_dump sheet in Excel");
  if (!tbSheet) throw new Error("Cannot find trial_balance sheet in Excel");

  console.log(`📋 gl_dump:       ${glSheet.records.length} rows`);
  console.log(`📋 trial_balance: ${tbSheet.records.length} rows`);

  // 2. Prisma: upsert user/org/connection
  console.log("\n⏳ Setting up Postgres records...");
  const user = await upsertUser(userEmail);
  const org  = await upsertOrg({ slug: orgSlug, name: orgName, createdById: user.id });
  await ensureMembership(org.id, user.id);
  const conn = await upsertConnection({ organizationId: org.id, externalOrganizationId: extOrgId, displayName: orgName, createdById: user.id });
  console.log(`✅ tenant_id=${org.id}  conn_id=${conn.id}`);

  const tenantId = org.id;

  // 3. Map GL rows
  const glRows = glSheet.records.map((rec, i) => ({
    tenant_id:       tenantId,
    org_id:          extOrgId,
    date:            dateStr(rec["Date"]),
    transaction_id:  str(rec["Transaction ID"]) || `ROW-${i + 1}`,
    journal_type:    str(rec["Journal Type"]),
    account_number:  str(rec["Account Number"]).replace(/\.0$/, ""),
    account_name:    str(rec["Account Name"]),
    account_type:    str(rec["Account Type"]),
    vendor_customer: str(rec["Vendor/Customer"]),
    description:     str(rec["Description"]),
    debit:           num(rec["Debit"]),
    credit:          num(rec["Credit"]),
    running_balance: num(rec["Running Balance"]),
    department:      str(rec["Department"]),
    class:           str(rec["Class"]),
  })).filter(r => r.date); // skip rows with no date

  // 4. Map trial balance rows
  const tbRows = tbSheet.records.map(rec => ({
    tenant_id:      tenantId,
    org_id:         extOrgId,
    account_number: str(rec["Account Number"]).replace(/\.0$/, ""),
    account_name:   str(rec["Account Name"]),
    account_type:   str(rec["Account Type"]),
    debit:          num(rec["Debit"]),
    credit:         num(rec["Credit"]),
    net_balance:    num(rec["Net Balance"]),
  }));

  console.log(`📝 GL rows mapped:       ${glRows.length}`);
  console.log(`📝 Trial balance rows:   ${tbRows.length}`);

  // 5. ClickHouse: schema + insert
  console.log("\n⏳ Connecting to ClickHouse...");
  const client = makeClient();
  await ensureSchema(client, db);

  if (doWipe) await wipeScope(client, db, tenantId, extOrgId);

  process.stdout.write("⏳ Inserting GL rows...");
  await insert(client, db, "sample_gl_dump", glRows);
  console.log(` ✅ ${glRows.length} rows`);

  process.stdout.write("⏳ Inserting trial balance rows...");
  await insert(client, db, "sample_trial_balance", tbRows);
  console.log(` ✅ ${tbRows.length} rows`);

  // Quick sanity check
  const check = await client.query({
    query: `SELECT account_type, ABS(round(sum(net_balance))) as total FROM ${db}.sample_trial_balance WHERE tenant_id={t:String} AND org_id={o:String} GROUP BY account_type ORDER BY total DESC`,
    query_params: { t: tenantId, o: extOrgId },
    format: "JSONEachRow",
  });
  const checkRows = await check.json();
  console.log("\n📊 Trial balance summary (by account type):");
  checkRows.forEach(r => console.log(`   ${r.account_type.padEnd(28)} $${Number(r.total).toLocaleString()}`));

  console.log(`\n🔑 Login: ${userEmail}`);
  console.log(`🏢 Org:   ${orgName}  (ext_org_id: ${extOrgId})`);
  console.log(`\n🎉 Done! Now run the API and the dashboard will use GL-based queries for this org.\n`);

  process.exit(0);
}

main().catch(err => { console.error("\n❌", err.message || err); process.exit(1); });
