/**
 * seed-star-schema-clickhouse.ts — GENERIC, workbook-driven onboarding for a
 * normalized finance STAR SCHEMA (Dim* + Fact* sheets). This is the "add a
 * dataset without touching the backend" path from docs/TARGET_ARCHITECTURE.md:
 *
 *   xlsx  ──►  raw tenant-stamped Fact/Dim tables  ──►  monthly analytic CUBES
 *             (columns typed by sampling the data)        (joins + GL pivoted by
 *                                                          the account taxonomy
 *                                                          READ FROM THE DATA)
 *
 * The autonomous chart engine then introspects those cubes and auto-derives its
 * SemanticModel — no per-dataset TypeScript. The cubes carry raw ratio/average
 * COMPONENTS (e.g. `<metric>` = SUM, `<metric>_wt` = COUNT) so the engine's
 * `ratio`/`mean` measures compile to SUM/SUM — never avg-of-ratios.
 *
 * What generalizes: any workbook whose facts join to dims via `<Dim>Key`
 * columns and whose GL carries AccountType / CostCategory / RevenueCategory
 * (the standard finance star schema in the DAX workbook). Column names/types are
 * discovered by sampling; the GL account taxonomy is enumerated from the data,
 * not hardcoded. A cube is skipped (not faked) when its fact table is absent.
 *
 * Usage:
 *   cd packages/db
 *   npx tsx scripts/seed-star-schema-clickhouse.ts \
 *     --file "/path/EBPO Dataset (Manipulated).xlsx" \
 *     --org-slug numeriqu-demo --org-name "Numeriqu Demo" \
 *     --external-org-id numeriqu_demo --table-prefix sfin --allow-remote
 *   # Inspect without writing:            add --dry-run
 *   # Rebuild cubes only (no re-ingest):  add --views-only  (needs --table-prefix)
 *
 * After seeding, register the cubes with the engine + persist the model:
 *   cd apps/api && ORG_ID=<org-uuid> KIND=<prefix> PERSIST=1 \
 *     npx tsx scripts/chart-engine-introspect.ts 'v_<prefix>_%'
 * (or POST /chart-engine/introspect with { kind, cubeViews }), then add the org
 * to CHART_ENGINE_NEW_ORGS.
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient as createClickHouseClient } from '@clickhouse/client';
import dotenv from 'dotenv';
import { ErpProvider } from '../generated/prisma/client';

type WorkbookDump = {
  sheets: Record<string, { headers: string[]; records: Array<Record<string, unknown>> }>;
};
type Scope = {
  tenant_id: string;
  user_id: string;
  connection_id: string;
  provider: string;
  org_id: string;
  org_name: string;
};
type ColumnKind = 'string' | 'uint' | 'float' | 'date';
type ColumnSpec = { source: string; name: string; kind: ColumnKind; nullable: boolean };
type TableSpec = { sheet: string; table: string; columns: ColumnSpec[]; orderBy: string };
type CHClient = ReturnType<typeof createClickHouseClient>;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env.local'), quiet: true });
dotenv.config({ path: path.resolve(__dirname, '../../.env.local'), quiet: true });
dotenv.config({ path: path.resolve(__dirname, '../../../apps/api/.env'), quiet: true });

const SOURCE_TAG = 'star_schema_dataset';

// ── args ─────────────────────────────────────────────────────────────────────
const getArg = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
};
const hasFlag = (flag: string) => process.argv.includes(flag);
const requiredArg = (flag: string) => {
  const v = getArg(flag);
  if (!v) throw new Error(`Missing required argument: ${flag} <value>`);
  return v;
};
const isLocalHost = (h: string) => h.toLowerCase() === 'localhost' || h.toLowerCase() === '127.0.0.1';
function assertRemoteAllowed(url: string | undefined, allowRemote: boolean, label: string) {
  if (!url) throw new Error(`${label} URL is missing from env.`);
  if (!isLocalHost(new URL(url).hostname) && !allowRemote) {
    throw new Error(`Refusing non-local ${label} (${new URL(url).hostname}). Pass --allow-remote if intentional.`);
  }
}

// ── naming / typing ────────────────────────────────────────────────────────────
/** "PLAmountUSD" → "pl_amount_usd", "DateKey" → "date_key", "SLACompliancePct" → "sla_compliance_pct". */
function snake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})?/;
const KEY_NAME_RE = /(key|_id|id|number|no)$/i;

/** Infer a column's storage kind by sampling non-empty values. Pure data-driven. */
function inferKind(header: string, records: Array<Record<string, unknown>>): ColumnKind {
  const vals: unknown[] = [];
  for (const r of records) {
    const v = r[header];
    if (v !== null && v !== undefined && v !== '') vals.push(v);
    if (vals.length >= 500) break;
  }
  if (!vals.length) return KEY_NAME_RE.test(header) ? 'uint' : 'string';
  const asStr = (v: unknown) => String(v).trim();
  const allDate = vals.every((v) => DATE_RE.test(asStr(v)));
  if (allDate && !/key$/i.test(header)) return 'date';
  const allNum = vals.every((v) => Number.isFinite(Number(v)));
  if (allNum) {
    const allInt = vals.every((v) => Number.isInteger(Number(v)) || /^\d+(\.0+)?$/.test(asStr(v)));
    const nonNeg = vals.every((v) => Number(v) >= 0);
    if (KEY_NAME_RE.test(header) && allInt && nonNeg) return 'uint';
    return 'float';
  }
  return 'string';
}
const isBlank = (v: unknown) => v === null || v === undefined || v === '';
const ddlFor = (k: ColumnKind, nullable = false) => {
  const base = k === 'string' ? 'String' : k === 'uint' ? 'UInt64' : k === 'float' ? 'Float64' : 'Date';
  return nullable ? `Nullable(${base})` : base;
};

function toUInt(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}
function toFloat(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function toText(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim();
}
function toDateOnly(v: unknown): string {
  const t = toText(v);
  const m = t.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1]!;
  const c = t.match(/^(\d{4})(\d{2})(\d{2})/);
  if (c) return `${c[1]}-${c[2]}-${c[3]}`;
  const d = new Date(t);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : '1970-01-01';
}
const coerce = (v: unknown, column: ColumnSpec) => {
  if (column.nullable && isBlank(v)) return null;
  return column.kind === 'uint'
    ? toUInt(v)
    : column.kind === 'float'
      ? toFloat(v)
      : column.kind === 'date'
        ? toDateOnly(v)
        : toText(v);
};

// ── workbook → table specs (fully generic) ─────────────────────────────────────
function extractWorkbook(xlsxPath: string): WorkbookDump {
  const extractorPath = path.resolve(__dirname, 'extract_xlsx_json.py');
  const python = process.env.PYTHON || 'python3';
  const result = spawnSync(python, [extractorPath, xlsxPath], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`XLSX extract failed (${result.status}): ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout) as WorkbookDump;
}

function buildTableSpecs(workbook: WorkbookDump, prefix: string): TableSpec[] {
  const specs: TableSpec[] = [];
  for (const [sheet, { headers, records }] of Object.entries(workbook.sheets)) {
    if (!headers?.length) continue;
    const columns: ColumnSpec[] = headers.map((h) => ({
      source: h,
      name: snake(h),
      kind: inferKind(h, records),
      nullable: records.some((record) => isBlank(record[h])),
    }));
    const names = new Set(columns.map((c) => c.name));
    const orderBy = names.has('date_key') ? 'date_key' : columns[0]!.name;
    specs.push({ sheet, table: `${prefix}_${snake(sheet)}`, columns, orderBy });
  }
  return specs;
}

function prepareRows(spec: TableSpec, records: Array<Record<string, unknown>>, scope: Scope) {
  return records.map((record) => {
    const out: Record<string, unknown> = {
      tenant_id: scope.tenant_id,
      user_id: scope.user_id,
      connection_id: scope.connection_id,
      provider: scope.provider,
      org_id: scope.org_id,
      org_name: scope.org_name,
      source_dataset: SOURCE_TAG,
    };
    for (const c of spec.columns) out[c.name] = coerce(record[c.source], c);
    return out;
  });
}

function rawTableDdl(db: string, spec: TableSpec): string {
  const cols = spec.columns.map((c) => `  ${c.name} ${ddlFor(c.kind, c.nullable)}`).join(',\n');
  return `CREATE TABLE IF NOT EXISTS ${db}.${spec.table} (
  tenant_id String,
  user_id String DEFAULT '',
  connection_id String DEFAULT '',
  provider LowCardinality(String) DEFAULT '',
  org_id String,
  org_name String DEFAULT '',
  source_dataset LowCardinality(String) DEFAULT '${SOURCE_TAG}',
${cols},
  loaded_at DateTime DEFAULT now()
) ENGINE = MergeTree() ORDER BY (tenant_id, org_id, ${spec.orderBy})`;
}

// ── Prisma provisioning ─────────────────────────────────────────────────────────
async function getPrisma() {
  const mod = await import('../src/client');
  return mod.prisma as typeof mod.prisma;
}
async function upsertUser(email: string) {
  const prisma = await getPrisma();
  const normalized = email.trim().toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email: normalized } });
  if (existing) return existing;
  return prisma.user.create({
    data: { email: normalized, fullName: 'Demo User', supabaseUserId: crypto.randomUUID(), isActive: true, isVerified: true },
  });
}
async function upsertOrganization(p: { slug: string; name: string; createdById: string }) {
  const prisma = await getPrisma();
  return prisma.organization.upsert({
    where: { slug: p.slug },
    create: { slug: p.slug, name: p.name, createdById: p.createdById },
    update: { name: p.name },
  });
}
async function ensureMembership(organizationId: string, userId: string) {
  const prisma = await getPrisma();
  return prisma.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId, userId } },
    create: { organizationId, userId, role: 'ADMIN', canViewDashboard: true, canCreateDashboard: true, canShareDashboard: true },
    update: { role: 'ADMIN', canViewDashboard: true, canCreateDashboard: true, canShareDashboard: true, leftAt: null },
  });
}
/**
 * Register the org's cube views in the Dataset registry so the chart engine's
 * getCubes() routes to them (and opts the org into `mean` measures). This is the
 * "registry-driven cube discovery" the engine reads at query time — stored on
 * Dataset.physicalSchema.cubeViews. Purely additive per (org, kind).
 */
async function registerDataset(organizationId: string, kind: string, cubeViews: string[]) {
  const prisma = await getPrisma();
  const physicalSchema = { datasetId: `${organizationId}:${kind}`, cubeViews, registeredBy: 'seed-star-schema' };
  return prisma.dataset.upsert({
    where: { organizationId_kind: { organizationId, kind } },
    create: { organizationId, kind, physicalSchema, introspectedAt: new Date() },
    update: { physicalSchema, introspectedAt: new Date() },
  });
}

async function findOrganizationBySlug(slug: string) {
  const prisma = await getPrisma();
  const org = await prisma.organization.findUnique({ where: { slug } });
  if (!org) throw new Error(`Organization not found for slug: ${slug}`);
  return org;
}

async function upsertConnection(p: { organizationId: string; externalOrganizationId: string; displayName: string; createdById: string }) {
  const prisma = await getPrisma();
  return prisma.erpConnection.upsert({
    where: {
      organizationId_provider_externalOrganizationId: {
        organizationId: p.organizationId,
        provider: ErpProvider.XERO,
        externalOrganizationId: p.externalOrganizationId,
      },
    },
    create: {
      organizationId: p.organizationId,
      provider: ErpProvider.XERO,
      externalOrganizationId: p.externalOrganizationId,
      displayName: p.displayName,
      accessTokenEncrypted: 'N/A',
      status: 'ACTIVE',
      createdById: p.createdById,
      metadata: { seeded: true, source: SOURCE_TAG },
    },
    update: { displayName: p.displayName, status: 'ACTIVE', metadata: { seeded: true, source: SOURCE_TAG } },
  });
}

// ── ClickHouse helpers ──────────────────────────────────────────────────────────
async function run(client: CHClient, query: string) {
  const r = await client.query({ query });
  await r.text();
}
async function insertRows(client: CHClient, db: string, table: string, rows: Array<Record<string, unknown>>) {
  const batch = 5000;
  for (let i = 0; i < rows.length; i += batch) {
    await client.insert({ table: `${db}.${table}`, values: rows.slice(i, i + batch), format: 'JSONEachRow' });
  }
}
async function wipeScope(client: CHClient, db: string, table: string, scope: Scope) {
  await client.command({
    query: `ALTER TABLE ${db}.${table} DELETE WHERE tenant_id = {t:String} AND org_id = {o:String} SETTINGS mutations_sync = 1`,
    query_params: { t: scope.tenant_id, o: scope.org_id },
  });
}
async function distinctValues(client: CHClient, db: string, table: string, column: string): Promise<string[]> {
  const r = await client.query({
    query: `SELECT DISTINCT ${column} AS v FROM ${db}.${table} WHERE ${column} != '' ORDER BY v`,
    format: 'JSONEachRow',
  });
  return ((await r.json()) as Array<{ v: string }>).map((x) => x.v).filter(Boolean);
}
const sqlStr = (s: string) => `'${s.replace(/'/g, "\\'")}'`;

// ── cube generation ─────────────────────────────────────────────────────────────
/**
 * Canonical names for the standard P&L account types (the DAX waterfall). Any
 * account type NOT in this map still gets a generic `<snake>_usd` column, so the
 * mapping is a convenience for clean names, not a gate on which data appears.
 */
const ACCOUNT_TYPE_CANONICAL: Record<string, string> = {
  Revenue: 'total_revenue_usd',
  'Direct Cost (COS)': 'total_cogs_usd',
  'SG&A': 'total_sga_usd',
  'Finance Cost': 'finance_cost_usd',
  Tax: 'tax_expense_usd',
};
const P_AND_L_TYPES = new Set(Object.keys(ACCOUNT_TYPE_CANONICAL));

/** period_date/year/quarter/month derived from a date column, for the GROUP BY. */
function calendarSelect(dateCol: string): string {
  return (
    `toStartOfMonth(${dateCol}) AS period_date, toYear(${dateCol}) AS year, ` +
    `toQuarter(${dateCol}) AS quarter, toMonth(${dateCol}) AS month`
  );
}
const CAL_GROUP = 'toStartOfMonth';

/**
 * The P&L cube: FactGeneralLedger pivoted by the account taxonomy read from the
 * data, plus the standard derived waterfall ($ + margin components). Time-only
 * grain (month). Margin `*_pct` columns exist so the engine emits ratio measures
 * (it recomputes them as SUM/SUM from the $ components — the stored value is
 * informational only).
 */
function plCubeDdl(
  db: string,
  prefix: string,
  gl: string,
  dateCol: string,
  tax: { accountType: string[]; costCategory: string[]; revenueCategory: string[] },
): string {
  // De-dup aliases defensively: two raw taxonomy values could snake to the same
  // name (or a category could collide with a canonical account-type name), which
  // ClickHouse rejects. First-writer wins; later collisions get a numeric suffix.
  const seen = new Set<string>();
  const uniq = (base: string) => {
    let a = base;
    for (let i = 2; seen.has(a); i++) a = `${base}_${i}`;
    seen.add(a);
    return a;
  };
  const inner: string[] = [`tenant_id, org_id, any(org_name) AS org_name`, calendarSelect(dateCol)];
  // Account-type pivot (canonical names where known, generic snake otherwise).
  for (const t of tax.accountType) {
    const name = uniq(ACCOUNT_TYPE_CANONICAL[t] ?? `${snake(t)}_usd`);
    inner.push(`sumIf(pl_amount_usd, account_type = ${sqlStr(t)}) AS ${name}`);
  }
  // Cost-/revenue-category pivots — namespaced (cc_/rc_) so they can never
  // collide with the canonical account-type columns above.
  for (const c of tax.costCategory) inner.push(`sumIf(pl_amount_usd, cost_category = ${sqlStr(c)}) AS ${uniq(`cc_${snake(c)}_usd`)}`);
  for (const r of tax.revenueCategory) inner.push(`sumIf(pl_amount_usd, revenue_category = ${sqlStr(r)}) AS ${uniq(`rc_${snake(r)}_usd`)}`);

  const has = (t: string) => tax.accountType.includes(t);
  const dna = tax.costCategory.find((c) => /depreciat/i.test(c));
  const dnaCol = dna ? `cc_${snake(dna)}_usd` : null;

  // Derived P&L waterfall — only when the required components are present.
  const outer: string[] = ['*'];
  if (has('Revenue') && has('Direct Cost (COS)')) outer.push('(total_revenue_usd - total_cogs_usd) AS gross_profit_usd');
  if (has('Direct Cost (COS)') && has('SG&A')) outer.push('(total_cogs_usd + total_sga_usd) AS total_operating_cost_usd');
  if (has('Revenue') && has('Direct Cost (COS)') && has('SG&A'))
    outer.push('(total_revenue_usd - total_cogs_usd - total_sga_usd) AS operating_profit_usd');
  if (has('Revenue') && has('Direct Cost (COS)') && has('SG&A') && has('Finance Cost'))
    outer.push('(total_revenue_usd - total_cogs_usd - total_sga_usd - finance_cost_usd) AS profit_before_tax_usd');
  if (has('Revenue') && has('Direct Cost (COS)') && has('SG&A') && has('Finance Cost') && has('Tax'))
    outer.push('(total_revenue_usd - total_cogs_usd - total_sga_usd - finance_cost_usd - tax_expense_usd) AS net_profit_usd');
  if (has('Revenue') && has('Direct Cost (COS)') && has('SG&A'))
    outer.push(`(total_revenue_usd - total_cogs_usd - total_sga_usd${dnaCol ? ` + ${dnaCol}` : ''}) AS ebitda_usd`);
  // Informational margin columns (engine recomputes as SUM/SUM from components).
  if (has('Revenue') && has('Direct Cost (COS)'))
    outer.push('round(100 * (total_revenue_usd - total_cogs_usd) / nullIf(total_revenue_usd, 0), 4) AS gross_margin_pct');
  if (has('Revenue') && has('Direct Cost (COS)') && has('SG&A'))
    outer.push('round(100 * (total_revenue_usd - total_cogs_usd - total_sga_usd) / nullIf(total_revenue_usd, 0), 4) AS operating_margin_pct');

  return `CREATE VIEW ${db}.v_${prefix}_pl_monthly AS
SELECT ${outer.join(', ')}
FROM (
  SELECT ${inner.join(', ')}
  FROM ${db}.${gl}
  GROUP BY tenant_id, org_id, ${CAL_GROUP}(${dateCol}), toYear(${dateCol}), toQuarter(${dateCol}), toMonth(${dateCol})
)`;
}

/** A revenue-by-<dimension> cube: FactRevenue joined to one dimension. */
function revenueByDimDdl(
  db: string,
  prefix: string,
  viewSuffix: string,
  factTable: string,
  factDateCol: string,
  join: { dimTable: string; factKey: string; dimKey: string; selects: Array<{ expr: string; alias: string }> },
): string {
  const dimCols = join.selects.map((s) => `d.${s.expr} AS ${s.alias}`).join(', ');
  const groupDims = join.selects.map((s) => `d.${s.expr}`).join(', ');
  return `CREATE VIEW ${db}.v_${prefix}_revenue_by_${viewSuffix}_monthly AS
SELECT f.tenant_id AS tenant_id, f.org_id AS org_id, any(f.org_name) AS org_name,
  ${calendarSelect(`f.${factDateCol}`)},
  ${dimCols},
  sum(f.revenue_usd) AS total_revenue_usd,
  sum(f.billable_hours) AS billable_hours
FROM ${db}.${factTable} f
LEFT JOIN ${db}.${join.dimTable} d
  ON d.tenant_id = f.tenant_id AND d.org_id = f.org_id AND d.${join.dimKey} = f.${join.factKey}
GROUP BY f.tenant_id, f.org_id, ${CAL_GROUP}(f.${factDateCol}), toYear(f.${factDateCol}), toQuarter(f.${factDateCol}), toMonth(f.${factDateCol}), ${groupDims}`;
}

/**
 * Build all cube DDLs that apply to the tables actually present. `tables` is the
 * set of raw table names (already prefixed). Returns { name, ddl } pairs.
 */
async function buildCubeDdls(
  client: CHClient,
  db: string,
  prefix: string,
  tables: Set<string>,
): Promise<Array<{ name: string; ddl: string }>> {
  const out: Array<{ name: string; ddl: string }> = [];
  const t = (base: string) => `${prefix}_${base}`;
  const gl = t('fact_general_ledger');
  const rev = t('fact_revenue');
  const ops = t('fact_operations');
  const ar = t('fact_accounts_receivable');
  const ap = t('fact_accounts_payable');
  const cf = t('fact_cash_flow');
  const pay = t('fact_payroll');

  // P&L cube (taxonomy enumerated from the data).
  if (tables.has(gl)) {
    const [accountType, costCategory, revenueCategory] = await Promise.all([
      distinctValues(client, db, gl, 'account_type'),
      distinctValues(client, db, gl, 'cost_category'),
      distinctValues(client, db, gl, 'revenue_category'),
    ]);
    out.push({ name: `v_${prefix}_pl_monthly`, ddl: plCubeDdl(db, prefix, gl, 'posting_date', { accountType, costCategory, revenueCategory }) });
  }

  // Revenue-by-dimension cubes (FactRevenue must exist; each dim optional).
  if (tables.has(rev)) {
    const dimJobs: Array<{ suffix: string; dimBase: string; factKey: string; dimKey: string; selects: Array<{ expr: string; alias: string }> }> = [
      { suffix: 'client', dimBase: 'dim_client', factKey: 'client_key', dimKey: 'client_key', selects: [{ expr: 'client_name', alias: 'client_name' }, { expr: 'industry', alias: 'industry' }] },
      { suffix: 'business_unit', dimBase: 'dim_business_unit', factKey: 'business_unit_key', dimKey: 'business_unit_key', selects: [{ expr: 'business_unit_name', alias: 'business_unit' }] },
      { suffix: 'geography', dimBase: 'dim_geography', factKey: 'geography_key', dimKey: 'geography_key', selects: [{ expr: 'region', alias: 'region' }, { expr: 'country', alias: 'country' }, { expr: 'delivery_center', alias: 'delivery_center' }] },
      { suffix: 'department', dimBase: 'dim_department', factKey: 'department_key', dimKey: 'department_key', selects: [{ expr: 'department_name', alias: 'department' }] },
    ];
    for (const j of dimJobs) {
      if (!tables.has(t(j.dimBase))) continue;
      out.push({
        name: `v_${prefix}_revenue_by_${j.suffix}_monthly`,
        ddl: revenueByDimDdl(db, prefix, j.suffix, rev, 'posting_date', { dimTable: t(j.dimBase), factKey: j.factKey, dimKey: j.dimKey, selects: j.selects }),
      });
    }
  }

  // Operations cube: additive volumes + weighted-mean components for the averages.
  if (tables.has(ops)) {
    const AVG = ['occupancy_pct', 'utilization_pct', 'sla_compliance_pct', 'qa_score_pct', 'csat_pct', 'nps'];
    const avgCols = AVG.map(
      (m) => `sum(${m}) AS ${m}, count() AS ${m}_wt`,
    ).join(',\n    ');
    out.push({
      name: `v_${prefix}_operations_monthly`,
      ddl: `CREATE VIEW ${db}.v_${prefix}_operations_monthly AS
SELECT tenant_id, org_id, any(org_name) AS org_name, ${calendarSelect('posting_date')},
    sum(calls_handled) AS calls_handled,
    sum(tickets_resolved) AS tickets_resolved,
    sum(paid_hours) AS paid_hours,
    sum(productive_hours) AS productive_hours,
    sum(billable_hours) AS billable_hours,
    sum(training_hours) AS training_hours,
    sum(overtime_hours) AS overtime_hours,
    ${avgCols}
FROM ${db}.${ops}
GROUP BY tenant_id, org_id, ${CAL_GROUP}(posting_date), toYear(posting_date), toQuarter(posting_date), toMonth(posting_date)`,
    });
  }

  // AR / AP cubes: $ measures + DSO/DPO as weighted mean.
  if (tables.has(ar)) {
    out.push({
      name: `v_${prefix}_ar_monthly`,
      ddl: `CREATE VIEW ${db}.v_${prefix}_ar_monthly AS
SELECT tenant_id, org_id, any(org_name) AS org_name, ${calendarSelect('invoice_date')},
    sum(invoice_amount_usd) AS invoice_amount_usd,
    sum(collected_amount_usd) AS collected_amount_usd,
    sum(write_off_amount_usd) AS write_off_amount_usd,
    sum(outstanding_balance_usd) AS outstanding_balance_usd,
    sum(days_sales_outstanding) AS days_sales_outstanding, count() AS days_sales_outstanding_wt
FROM ${db}.${ar}
GROUP BY tenant_id, org_id, ${CAL_GROUP}(invoice_date), toYear(invoice_date), toQuarter(invoice_date), toMonth(invoice_date)`,
    });
  }
  if (tables.has(ap)) {
    out.push({
      name: `v_${prefix}_ap_monthly`,
      ddl: `CREATE VIEW ${db}.v_${prefix}_ap_monthly AS
SELECT tenant_id, org_id, any(org_name) AS org_name, ${calendarSelect('invoice_date')},
    sum(invoice_amount_usd) AS invoice_amount_usd,
    sum(paid_amount_usd) AS paid_amount_usd,
    sum(outstanding_balance_usd) AS outstanding_balance_usd,
    sum(days_payable_outstanding) AS days_payable_outstanding, count() AS days_payable_outstanding_wt
FROM ${db}.${ap}
GROUP BY tenant_id, org_id, ${CAL_GROUP}(invoice_date), toYear(invoice_date), toQuarter(invoice_date), toMonth(invoice_date)`,
    });
  }

  // Cash flow cube: flows by activity + closing balance (stock → engine argMax).
  if (tables.has(cf)) {
    out.push({
      name: `v_${prefix}_cashflow_monthly`,
      ddl: `CREATE VIEW ${db}.v_${prefix}_cashflow_monthly AS
SELECT tenant_id, org_id, any(org_name) AS org_name,
    makeDate(toUInt16(year), toUInt8(month), 1) AS period_date, year, quarter, month,
    cash_flow_activity,
    sum(cash_inflow_usd) AS cash_inflow_usd,
    sum(cash_outflow_usd) AS cash_outflow_usd,
    sum(net_cash_flow_usd) AS net_cash_flow_usd,
    max(closing_cash_balance_usd) AS closing_cash_balance_usd
FROM ${db}.${cf}
GROUP BY tenant_id, org_id, year, quarter, month, cash_flow_activity`,
    });
  }

  // Payroll cube: $ + hours by department & business unit; headcount = distinct employees.
  if (tables.has(pay)) {
    const joinDept = tables.has(t('dim_department'));
    const joinBu = tables.has(t('dim_business_unit'));
    const selects: string[] = [];
    const groups: string[] = [];
    if (joinDept) {
      selects.push('dd.department_name AS department');
      groups.push('dd.department_name');
    }
    if (joinBu) {
      selects.push('bu.business_unit_name AS business_unit');
      groups.push('bu.business_unit_name');
    }
    const joins =
      (joinDept ? `\nLEFT JOIN ${db}.${t('dim_department')} dd ON dd.tenant_id = f.tenant_id AND dd.org_id = f.org_id AND dd.department_key = f.department_key` : '') +
      (joinBu ? `\nLEFT JOIN ${db}.${t('dim_business_unit')} bu ON bu.tenant_id = f.tenant_id AND bu.org_id = f.org_id AND bu.business_unit_key = f.business_unit_key` : '');
    out.push({
      name: `v_${prefix}_payroll_monthly`,
      ddl: `CREATE VIEW ${db}.v_${prefix}_payroll_monthly AS
SELECT f.tenant_id AS tenant_id, f.org_id AS org_id, any(f.org_name) AS org_name,
    makeDate(toUInt16(f.fiscal_year), toUInt8(f.fiscal_period), 1) AS period_date, f.fiscal_year AS year${selects.length ? ',\n    ' + selects.join(',\n    ') : ''},
    sum(f.total_payroll_usd) AS total_payroll_usd,
    sum(f.basic_salary_usd) AS basic_salary_usd,
    sum(f.overtime_usd) AS overtime_usd,
    sum(f.paid_hours) AS paid_hours,
    sum(f.productive_hours) AS productive_hours,
    f.employee_key AS employee_key
FROM ${db}.${pay} f${joins}
GROUP BY f.tenant_id, f.org_id, f.fiscal_year, f.fiscal_period${groups.length ? ', ' + groups.join(', ') : ''}, f.employee_key`,
    });
  }

  return out;
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const viewsOnly = hasFlag('--views-only');
  const registerOnly = hasFlag('--register-only');
  const dryRun = hasFlag('--dry-run');
  const allowRemote = hasFlag('--allow-remote');
  const prefix = snake(getArg('--table-prefix') || 'sfin');
  const filePath = viewsOnly || registerOnly ? undefined : requiredArg('--file');
  const userEmail = getArg('--user-email') ?? 'demo1@numeriqu.com';
  const orgName = getArg('--org-name') ?? 'Star Schema Demo';
  const orgSlug = getArg('--org-slug') ?? 'star-schema-demo';
  const externalOrgId = getArg('--external-org-id') ?? 'star_schema_demo';

  if (!process.env.CLICKHOUSE_ANALYTICS_URL) throw new Error('CLICKHOUSE_ANALYTICS_URL is not set.');
  assertRemoteAllowed(process.env.CLICKHOUSE_ANALYTICS_URL, allowRemote, 'ClickHouse');
  const db = process.env.CLICKHOUSE_ANALYTICS_DB || 'analytics';
  const client = createClickHouseClient({
    url: process.env.CLICKHOUSE_ANALYTICS_URL,
    username: process.env.CLICKHOUSE_ANALYTICS_USER || 'dbt_transformer',
    password: process.env.CLICKHOUSE_ANALYTICS_PASSWORD || '',
    database: db,
  });

  // Discover the raw tables present for this prefix (used by both paths).
  const listRaw = async () => {
    const r = await client.query({
      query: `SELECT name FROM system.tables WHERE database = {db:String} AND name LIKE {p:String}`,
      query_params: { db, p: `${prefix}_%` },
      format: 'JSONEachRow',
    });
    return new Set(((await r.json()) as Array<{ name: string }>).map((x) => x.name));
  };

  async function recreateCubes() {
    const tables = await listRaw();
    const cubes = await buildCubeDdls(client, db, prefix, tables);
    for (const c of cubes) await run(client, `DROP VIEW IF EXISTS ${db}.${c.name}`);
    for (const c of cubes) await run(client, c.ddl);
    return cubes.map((c) => c.name);
  }

  // Rebuild cubes + (re)register them in the Dataset registry for an EXISTING
  // org, without re-ingesting. Used after the raw data is already loaded.
  if (hasFlag('--register-only')) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
    assertRemoteAllowed(process.env.DATABASE_URL, allowRemote, 'Postgres');
    const org = await findOrganizationBySlug(orgSlug);
    const cubeViews = await recreateCubes();
    const dataset = await registerDataset(org.id, prefix, cubeViews);
    console.log(JSON.stringify({ ok: true, registerOnly: true, organization: { id: org.id, slug: orgSlug }, kind: prefix, datasetId: dataset.id, cubeViews }, null, 2));
    return;
  }

  if (viewsOnly) {
    const cubeViews = await recreateCubes();
    console.log(JSON.stringify({ ok: true, viewsOnly: true, db, prefix, cubeViews }, null, 2));
    return;
  }

  const absFilePath = path.isAbsolute(filePath!) ? filePath! : path.resolve(process.cwd(), filePath!);
  if (!fs.existsSync(absFilePath)) throw new Error(`XLSX not found: ${absFilePath}`);
  const workbook = extractWorkbook(absFilePath);
  const specs = buildTableSpecs(workbook, prefix);

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          dryRun: true,
          file: absFilePath,
          prefix,
          org: { name: orgName, slug: orgSlug, externalOrgId },
          rawTables: Object.fromEntries(
            specs.map((s) => [
              s.table,
              {
                rows: workbook.sheets[s.sheet]!.records.length,
                columns: s.columns.map((c) => `${c.name}:${ddlFor(c.kind, c.nullable)}`),
              },
            ]),
          ),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
  assertRemoteAllowed(process.env.DATABASE_URL, allowRemote, 'Postgres');

  const user = await upsertUser(userEmail);
  const org = await upsertOrganization({ slug: orgSlug, name: orgName, createdById: user.id });
  await ensureMembership(org.id, user.id);
  const connection = await upsertConnection({ organizationId: org.id, externalOrganizationId: externalOrgId, displayName: orgName, createdById: user.id });
  const scope: Scope = { tenant_id: org.id, user_id: user.id, connection_id: connection.id, provider: 'xero', org_id: externalOrgId, org_name: orgName };

  await run(client, `CREATE DATABASE IF NOT EXISTS ${db}`);
  for (const spec of specs) {
    await run(client, rawTableDdl(db, spec));
    // Converge existing tables additively (safe re-run).
    for (const c of spec.columns) {
      await run(
        client,
        `ALTER TABLE ${db}.${spec.table} ADD COLUMN IF NOT EXISTS ${c.name} ${ddlFor(c.kind, c.nullable)}`,
      );
      // Nullable is monotonic for shared raw tables: once a workbook contains a
      // blank, keep the column nullable so a later tenant load cannot erase that
      // capability. Non-nullable columns are never narrowed on a subsequent run.
      if (c.nullable) {
        await run(client, `ALTER TABLE ${db}.${spec.table} MODIFY COLUMN ${c.name} ${ddlFor(c.kind, true)}`);
      }
    }
    await wipeScope(client, db, spec.table, scope);
  }
  const inserted: Record<string, number> = {};
  for (const spec of specs) {
    const rows = prepareRows(spec, workbook.sheets[spec.sheet]!.records, scope);
    await insertRows(client, db, spec.table, rows);
    inserted[spec.table] = rows.length;
  }

  const cubeViews = await recreateCubes();
  const dataset = await registerDataset(org.id, prefix, cubeViews);

  console.log(
    JSON.stringify(
      {
        ok: true,
        seeded: true,
        source: absFilePath,
        organization: { id: org.id, slug: org.slug, name: org.name },
        connection: { id: connection.id, externalOrganizationId: connection.externalOrganizationId },
        clickhouse: { db, prefix },
        datasetId: dataset.id,
        inserted,
        cubeViews,
        nextStep: `Cubes registered in the Dataset registry. Final step: append ${org.id} to CHART_ENGINE_NEW_ORGS in apps/api/.env and restart the API.`,
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
      /* ignore */
    }
  });
