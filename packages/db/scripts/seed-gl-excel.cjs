/* eslint-disable no-console */
/**
 * Ingest a GL-dump Excel file into fact_accounting_journal_lines.
 *
 * Expected GL sheet columns (case-insensitive):
 *   Date, Transaction ID, Journal Type, Account Number, Account Name,
 *   Vendor/Customer, Description, Debit, Credit, Department, Class
 *
 * Optional trial-balance sheet for account enrichment:
 *   Account Number, Account Name, Account Type
 *
 * Usage:
 *   node seed-gl-excel.cjs \
 *     --file         "/path/to/Sample Data - 1Y (1).xlsx" \
 *     --user-email   admin@example.com \
 *     --org-name     "Sample Company 2024" \
 *     --org-slug     sample-company-2024        (optional)
 *     --ext-org-id   sample_gl_2024             (optional)
 *     --gl-sheet     gl_dump_2024               (optional, auto-detected)
 *     --tb-sheet     trial_balance_2024         (optional, auto-detected)
 *     --wipe                                    (delete existing rows first)
 */

const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const path   = require("node:path");

const dotenv = require("dotenv");
const { createClient: createClickHouseClient } = require("@clickhouse/client");

dotenv.config({ path: path.resolve(__dirname, "../.env.local"),          quiet: true });
dotenv.config({ path: path.resolve(__dirname, "../../.env.local"),       quiet: true });
dotenv.config({ path: path.resolve(__dirname, "../../../apps/api/.env"), quiet: true });

// ─── CLI ─────────────────────────────────────────────────────────────────────

function getArg(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}
function hasFlag(f) { return process.argv.includes(f); }
function required(flag) {
  const v = getArg(flag);
  if (!v) throw new Error(`Missing required argument: ${flag} <value>`);
  return v;
}

// ─── Prisma ──────────────────────────────────────────────────────────────────

function getPrisma() { return require("../dist/client.js").prisma; }

async function upsertUser(email) {
  const prisma = getPrisma();
  const norm = email.trim().toLowerCase();
  const ex = await prisma.user.findUnique({ where: { email: norm } });
  if (ex) return ex;
  return prisma.user.create({
    data: { email: norm, fullName: "GL Seed User", supabaseUserId: crypto.randomUUID(), isActive: true, isVerified: true },
  });
}

async function upsertOrg({ slug, name, createdById }) {
  const prisma = getPrisma();
  return prisma.organization.upsert({
    where:  { slug },
    create: { slug, name, createdById },
    update: { name },
  });
}

async function ensureMembership(organizationId, userId) {
  const prisma = getPrisma();
  return prisma.organizationMembership.upsert({
    where:  { organizationId_userId: { organizationId, userId } },
    create: { organizationId, userId, role: "ADMIN", canViewDashboard: true, canCreateDashboard: true, canShareDashboard: true },
    update: { role: "ADMIN", canViewDashboard: true, canCreateDashboard: true, canShareDashboard: true, leftAt: null },
  });
}

async function upsertConnection({ organizationId, externalOrganizationId, displayName, createdById }) {
  const prisma = getPrisma();
  return prisma.erpConnection.upsert({
    where:  { organizationId_provider_externalOrganizationId: { organizationId, provider: "XERO", externalOrganizationId } },
    create: { organizationId, provider: "XERO", externalOrganizationId, displayName, accessTokenEncrypted: "N/A", refreshTokenEncrypted: null, tokenExpiresAt: null, status: "ACTIVE", createdById, metadata: { seeded: true, source: "gl_excel" } },
    update: { displayName, status: "ACTIVE", metadata: { seeded: true, source: "gl_excel" } },
  });
}

// ─── ClickHouse ───────────────────────────────────────────────────────────────

function makeClickhouse() {
  return createClickHouseClient({
    url:      process.env.CLICKHOUSE_ANALYTICS_URL  || process.env.CLICKHOUSE_URL  || "http://localhost:8123",
    username: process.env.CLICKHOUSE_ANALYTICS_USER || process.env.CLICKHOUSE_USER || "default",
    password: process.env.CLICKHOUSE_ANALYTICS_PASSWORD || process.env.CLICKHOUSE_PASSWORD || "",
  });
}

async function ensureSchema(ch, db) {
  const run = async (q) => { const r = await ch.query({ query: q }); await r.text(); };
  await run(`CREATE DATABASE IF NOT EXISTS ${db}`);
  await run(`
    CREATE TABLE IF NOT EXISTS ${db}.fact_accounting_journal_lines (
      journal_id     String,
      line_id        String,
      tenant_id      String        DEFAULT '',
      user_id        String        DEFAULT '',
      connection_id  String        DEFAULT '',
      provider       String        DEFAULT '',
      org_id         String        DEFAULT '',
      org_name       String        DEFAULT '',
      source_type    String        DEFAULT '',
      source_id      String        DEFAULT '',
      journal_number UInt64        DEFAULT 0,
      journal_date   Nullable(DateTime),
      account_id     String        DEFAULT '',
      account_code   String        DEFAULT '',
      account_name   String        DEFAULT '',
      line_amount    Decimal(18,4) DEFAULT 0,
      description    String        DEFAULT '',
      department     String        DEFAULT '',
      class_name     String        DEFAULT '',
      vendor_name    String        DEFAULT '',
      vendor_id      String        DEFAULT '',
      debit_amount   Decimal(18,4) DEFAULT 0,
      credit_amount  Decimal(18,4) DEFAULT 0,
      updated_at     DateTime      DEFAULT now(),
      synced_at      DateTime      DEFAULT now()
    ) ENGINE = ReplacingMergeTree()
    ORDER BY (tenant_id, org_id, journal_id, line_id)
  `);
  for (const [col, type] of [
    ["department",    "String        DEFAULT ''"],
    ["class_name",    "String        DEFAULT ''"],
    ["vendor_name",   "String        DEFAULT ''"],
    ["vendor_id",     "String        DEFAULT ''"],
    ["debit_amount",  "Decimal(18,4) DEFAULT 0"],
    ["credit_amount", "Decimal(18,4) DEFAULT 0"],
  ]) {
    await run(`ALTER TABLE ${db}.fact_accounting_journal_lines ADD COLUMN IF NOT EXISTS ${col} ${type}`).catch(() => {});
  }
}

async function deleteByScope(ch, db, scope) {
  await ch.command({ query: `ALTER TABLE ${db}.fact_accounting_journal_lines DELETE WHERE tenant_id={t:String} AND org_id={o:String}`, query_params: { t: scope.tenant_id, o: scope.org_id } });
  // Wait for mutation — ignore permission errors on system.mutations (restricted users)
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const r = await ch.query({ query: `SELECT count() AS c FROM system.mutations WHERE database={db:String} AND is_done=0`, query_params: { db }, format: "JSONEachRow" });
      if (Number((await r.json())?.[0]?.c ?? 0) === 0) break;
    } catch { break; /* no permission to check — just proceed */ }
    await new Promise(r => setTimeout(r, 1500));
  }
}

async function insertBatch(ch, db, rows) {
  if (!rows.length) return;
  await ch.insert({ table: `${db}.fact_accounting_journal_lines`, values: rows, format: "JSONEachRow" });
}

// ─── Excel extraction (via Python/openpyxl) ───────────────────────────────────

function extractExcel(filePath) {
  const extractor = path.resolve(__dirname, "extract_xlsx_json.py");
  const res = spawnSync("python3", [extractor, filePath], { encoding: "utf8", maxBuffer: 100 * 1024 * 1024 });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`Excel extract failed: ${res.stderr || res.stdout}`);
  return JSON.parse(res.stdout);
}

function autoDetect(wb, keywords) {
  for (const kw of keywords) {
    const found = Object.keys(wb.sheets).find(n => n.toLowerCase().includes(kw.toLowerCase()));
    if (found) return found;
  }
  return Object.keys(wb.sheets)[0] ?? null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function str(v) { return v === null || v === undefined ? "" : String(v).trim(); }

function num(v) {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

function toDateStr(v) {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.valueOf())) return null;
  return d.toISOString().replace("T", " ").substring(0, 19);
}

// Find a field value case-insensitively from a record object
function field(rec, ...keys) {
  const lower = Object.fromEntries(Object.entries(rec).map(([k, v]) => [k.toLowerCase().replace(/[\s/\-_]+/g, "_"), v]));
  for (const k of keys) {
    const nk = k.toLowerCase().replace(/[\s/\-_]+/g, "_");
    if (nk in lower && lower[nk] !== null && lower[nk] !== undefined) return lower[nk];
  }
  return null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const filePath  = required("--file");
  const userEmail = required("--user-email");
  const orgName   = getArg("--org-name")   ?? path.basename(filePath, path.extname(filePath));
  const orgSlug   = (getArg("--org-slug")  ?? orgName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")).slice(0, 48) || "workspace";
  const extOrgId  = getArg("--ext-org-id") ?? orgSlug.replace(/-/g, "_");
  const wipe      = hasFlag("--wipe");
  const db        = (process.env.CLICKHOUSE_ANALYTICS_DB || process.env.CLICKHOUSE_DB || "analytics").trim();

  console.log(`\n📂 File:     ${filePath}`);
  console.log(`🏢 Org:      ${orgName}  (slug: ${orgSlug}, ext_org_id: ${extOrgId})`);
  console.log(`📧 User:     ${userEmail}`);
  console.log(`🗄️  DB:       ${db}`);
  if (wipe) console.log("⚠️  --wipe enabled — existing rows will be deleted first");

  // ── 1. Extract Excel ──────────────────────────────────────────────────────
  console.log("\n⏳ Extracting Excel...");
  const wb = extractExcel(filePath);

  const glSheetName = getArg("--gl-sheet") ?? autoDetect(wb, ["gl_dump", "gl", "journal", "transactions", "ledger", "general"]);
  const tbSheetName = getArg("--tb-sheet") ?? autoDetect(wb, ["trial_balance", "trial balance", "tb", "chart_of_accounts"]);

  if (!glSheetName || !wb.sheets[glSheetName]) throw new Error(`GL sheet not found. Sheets available: ${Object.keys(wb.sheets).join(", ")}`);
  console.log(`📋 GL sheet:  "${glSheetName}"  (${wb.sheets[glSheetName].records.length} rows)`);
  if (tbSheetName) console.log(`📋 TB sheet:  "${tbSheetName}"  (${wb.sheets[tbSheetName]?.records.length ?? 0} rows)`);

  // Build trial-balance lookup: accountCode → accountName
  const tbMap = new Map();
  if (tbSheetName && wb.sheets[tbSheetName]) {
    for (const rec of wb.sheets[tbSheetName].records) {
      const code = str(field(rec, "Account Number", "account_no", "account_code")).replace(/\.0$/, "");
      const name = str(field(rec, "Account Name", "account_name", "name"));
      if (code) tbMap.set(code, name);
    }
    console.log(`📊 TB loaded: ${tbMap.size} accounts`);
  }

  // ── 2. Map GL rows ────────────────────────────────────────────────────────
  const now  = new Date().toISOString().replace("T", " ").substring(0, 19);
  const rows = [];
  let skipped = 0;

  for (let i = 0; i < wb.sheets[glSheetName].records.length; i++) {
    const rec = wb.sheets[glSheetName].records[i];

    const dateStr = toDateStr(field(rec, "Date", "Transaction Date", "Journal Date", "Accounting Date", "Posting Date"));
    if (!dateStr) { skipped++; continue; }

    const txnId   = str(field(rec, "Transaction ID", "Txn ID", "ID", "Reference", "Transaction Ref") || `ROW-${i + 1}`);
    const jType   = str(field(rec, "Journal Type", "Type", "Entry Type", "Category"));
    const acctNo  = str(field(rec, "Account Number", "Account No", "Account Code", "Acct No")).replace(/\.0$/, "");
    const acctNameRaw = str(field(rec, "Account Name", "Account", "Acct Name"));
    const acctName = acctNameRaw || tbMap.get(acctNo) || "";
    const vendor  = str(field(rec, "Vendor/Customer", "Vendor", "Customer", "Payee", "Supplier"));
    const desc    = str(field(rec, "Description", "Memo", "Narration", "Details"));
    const dept    = str(field(rec, "Department", "Dept", "Cost Centre"));
    const cls     = str(field(rec, "Class", "Class Name", "Category"));
    const debit   = num(field(rec, "Debit"));
    const credit  = num(field(rec, "Credit"));

    // Positive for debits, negative for credits (standard GL convention)
    const lineAmount = debit > 0 ? debit : credit > 0 ? -credit : 0;

    // Deterministic IDs for idempotent inserts
    const journalId = `${extOrgId}__${txnId}`;
    const lineId    = `${journalId}__${i}`;
    const jNumMatch = txnId.match(/(\d+)$/);
    const jNum      = jNumMatch ? parseInt(jNumMatch[1], 10) : i + 1;

    rows.push({
      journal_id:     journalId,
      line_id:        lineId,
      tenant_id:      "",        // filled after Prisma setup
      user_id:        "",
      connection_id:  "",
      provider:       "xero",
      org_id:         extOrgId,
      org_name:       orgName,
      source_type:    jType,
      source_id:      txnId,
      journal_number: jNum,
      journal_date:   dateStr,
      account_id:     acctNo,
      account_code:   acctNo,
      account_name:   acctName,
      line_amount:    lineAmount,
      description:    desc,
      department:     dept,
      class_name:     cls,
      vendor_name:    vendor,
      vendor_id:      "",
      debit_amount:   debit,
      credit_amount:  credit,
      updated_at:     now,
      synced_at:      now,
    });
  }

  console.log(`📝 Mapped ${rows.length} GL lines  (${skipped} rows skipped — no date)`);
  if (rows.length === 0) throw new Error("No rows to insert — check the GL sheet column names");

  // ── 3. Prisma: user / org / connection ────────────────────────────────────
  console.log("\n⏳ Setting up Postgres records...");
  const user = await upsertUser(userEmail);
  const org  = await upsertOrg({ slug: orgSlug, name: orgName, createdById: user.id });
  await ensureMembership(org.id, user.id);
  const conn = await upsertConnection({ organizationId: org.id, externalOrganizationId: extOrgId, displayName: orgName, createdById: user.id });
  console.log(`✅ Prisma:  org_id=${org.id}  conn_id=${conn.id}  user_id=${user.id}`);

  // Patch scope into every row
  for (const row of rows) {
    row.tenant_id     = org.id;
    row.user_id       = user.id;
    row.connection_id = conn.id;
  }

  // ── 4. ClickHouse: schema + insert ───────────────────────────────────────
  console.log("\n⏳ Connecting to ClickHouse...");
  const ch = makeClickhouse();
  await ensureSchema(ch, db);

  if (wipe) {
    console.log("🗑️  Deleting existing rows...");
    await deleteByScope(ch, db, { tenant_id: org.id, org_id: extOrgId });
  }

  const BATCH = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    await insertBatch(ch, db, rows.slice(i, i + BATCH));
    inserted += Math.min(BATCH, rows.length - i);
    process.stdout.write(`\r   Inserted ${inserted}/${rows.length} rows...`);
  }
  console.log(`\n✅ Inserted ${inserted} rows into ${db}.fact_accounting_journal_lines`);

  // ── 5. Stats ──────────────────────────────────────────────────────────────
  const depts   = [...new Set(rows.map(r => r.department).filter(Boolean))];
  const classes = [...new Set(rows.map(r => r.class_name).filter(Boolean))];
  const vendors = [...new Set(rows.map(r => r.vendor_name).filter(Boolean))];
  const totalDebit  = rows.reduce((s, r) => s + r.debit_amount,  0);
  const totalCredit = rows.reduce((s, r) => s + r.credit_amount, 0);
  const fmt = v => `$${Math.round(v).toLocaleString()}`;

  console.log(`\n📊 Data summary:`);
  console.log(`   Departments : ${depts.join(", ") || "(none)"}`);
  console.log(`   Classes     : ${classes.join(", ") || "(none)"}`);
  console.log(`   Vendors     : ${vendors.length} unique  (${vendors.slice(0, 6).join(", ")}${vendors.length > 6 ? "..." : ""})`);
  console.log(`   Total debits  : ${fmt(totalDebit)}`);
  console.log(`   Total credits : ${fmt(totalCredit)}`);
  console.log(`\n🔑 Login: ${userEmail}`);
  console.log(`   Org:    ${orgName}  (ext_org_id: ${extOrgId})`);
  console.log(`\n🎉 Done!\n`);

  process.exit(0);
}

main().catch(err => { console.error("\n❌", err.message); process.exit(1); });
