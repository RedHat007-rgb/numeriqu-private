import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient as createClickHouseClient } from "@clickhouse/client";
import dotenv from "dotenv";
import { ErpProvider } from "../generated/prisma/client";

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

type ColumnKind = "string" | "uint" | "float" | "date";

type ColumnSpec = {
  source: string;
  name: string;
  kind: ColumnKind;
  ddl: string;
};

type TableSpec = {
  sheet: string;
  table: string;
  columns: ColumnSpec[];
  orderBy: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../.env.local"), quiet: true });
dotenv.config({ path: path.resolve(__dirname, "../../.env.local"), quiet: true });
dotenv.config({ path: path.resolve(__dirname, "../../../apps/api/.env"), quiet: true });

const SOURCE_TAG = "ebpo_financial_dataset";

const tableSpecs: TableSpec[] = [
  {
    sheet: "DimDate",
    table: "ebpo_dim_date",
    orderBy: "date_key",
    columns: [
      col("DateKey", "date_key", "uint", "UInt32"),
      col("Date", "date", "date", "Date"),
      col("Year", "year", "uint", "UInt16"),
      col("Quarter", "quarter", "uint", "UInt8"),
      col("Month", "month", "uint", "UInt8"),
      col("MonthName", "month_name", "string", "LowCardinality(String)"),
      col("FiscalYear", "fiscal_year", "uint", "UInt16"),
    ],
  },
  {
    sheet: "DimGeography",
    table: "ebpo_dim_geography",
    orderBy: "geography_key",
    columns: [
      col("GeographyKey", "geography_key", "uint", "UInt32"),
      col("Region", "region", "string", "LowCardinality(String)"),
      col("Country", "country", "string", "LowCardinality(String)"),
      col("StateProvince", "state_province", "string", "String"),
      col("City", "city", "string", "String"),
      col("DeliveryCenter", "delivery_center", "string", "String"),
      col("TimeZone", "time_zone", "string", "LowCardinality(String)"),
      col("MarketType", "market_type", "string", "LowCardinality(String)"),
    ],
  },
  {
    sheet: "DimDepartment",
    table: "ebpo_dim_department",
    orderBy: "department_key",
    columns: [
      col("DepartmentKey", "department_key", "uint", "UInt32"),
      col("DepartmentName", "department_name", "string", "LowCardinality(String)"),
    ],
  },
  {
    sheet: "DimBusinessUnit",
    table: "ebpo_dim_business_unit",
    orderBy: "business_unit_key",
    columns: [
      col("BusinessUnitKey", "business_unit_key", "uint", "UInt32"),
      col("BusinessUnitName", "business_unit_name", "string", "LowCardinality(String)"),
    ],
  },
  {
    sheet: "DimAccount",
    table: "ebpo_dim_account",
    orderBy: "account_key",
    columns: [
      col("AccountKey", "account_key", "uint", "UInt32"),
      col("AccountNumber", "account_number", "string", "String"),
      col("AccountName", "account_name", "string", "String"),
    ],
  },
  {
    sheet: "DimClient",
    table: "ebpo_dim_client",
    orderBy: "client_key",
    columns: [
      col("ClientKey", "client_key", "uint", "UInt32"),
      col("ClientName", "client_name", "string", "String"),
      col("Industry", "industry", "string", "LowCardinality(String)"),
    ],
  },
  {
    sheet: "DimVendor",
    table: "ebpo_dim_vendor",
    orderBy: "vendor_key",
    columns: [
      col("VendorKey", "vendor_key", "uint", "UInt32"),
      col("VendorName", "vendor_name", "string", "String"),
    ],
  },
  {
    sheet: "DimEmployee",
    table: "ebpo_dim_employee",
    orderBy: "employee_key",
    columns: [
      col("EmployeeKey", "employee_key", "uint", "UInt32"),
      col("EmployeeID", "employee_id", "string", "String"),
      col("Department", "department", "string", "LowCardinality(String)"),
      col("Grade", "grade", "string", "LowCardinality(String)"),
      col("Country", "country", "string", "LowCardinality(String)"),
      col("City", "city", "string", "String"),
      col("DeliveryCenter", "delivery_center", "string", "String"),
      col("MonthlySalaryUSD", "monthly_salary_usd", "float", "Float64"),
    ],
  },
  {
    sheet: "FactPayroll",
    table: "ebpo_fact_payroll",
    orderBy: "date_key, employee_key",
    columns: [
      col("DateKey", "date_key", "uint", "UInt32"),
      col("EmployeeKey", "employee_key", "uint", "UInt32"),
      col("Department", "department", "string", "LowCardinality(String)"),
      col("Country", "country", "string", "LowCardinality(String)"),
      col("BaseSalary", "base_salary_usd", "float", "Float64"),
      col("Overtime", "overtime_usd", "float", "Float64"),
      col("Bonus", "bonus_usd", "float", "Float64"),
      col("Benefits", "benefits_usd", "float", "Float64"),
      col("TotalPayroll", "total_payroll_usd", "float", "Float64"),
    ],
  },
  {
    sheet: "FactRevenue",
    table: "ebpo_fact_revenue",
    orderBy: "date_key, client_key, business_unit, contract_type",
    columns: [
      col("DateKey", "date_key", "uint", "UInt32"),
      col("ClientKey", "client_key", "uint", "UInt32"),
      // Added 2026-07-06: geography/department dimension keys enable cost & revenue
      // breakdown by region and department. Additive FKs to ebpo_dim_geography /
      // ebpo_dim_department; revenue/cost/margin measures are unchanged.
      col("GeographyKey", "geography_key", "uint", "UInt32"),
      col("DepartmentKey", "department_key", "uint", "UInt32"),
      col("BusinessUnit", "business_unit", "string", "LowCardinality(String)"),
      col("ContractType", "contract_type", "string", "LowCardinality(String)"),
      col("RevenueUSD", "revenue_usd", "float", "Float64"),
      col("CostUSD", "cost_usd", "float", "Float64"),
      col("GrossMarginUSD", "gross_margin_usd", "float", "Float64"),
    ],
  },
  // FactGeneralLedger was removed from the dataset (2026-06-25). The GL fact table and
  // v_ebpo_gl_monthly view are no longer seeded; expense reporting uses total_expenses
  // (Total Cost + Total Payroll) and trial-balance accounts.
  {
    sheet: "FactTrialBalance",
    table: "ebpo_fact_trial_balance",
    orderBy: "date_key, account_number",
    columns: [
      col("DateKey", "date_key", "uint", "UInt32"),
      col("AccountNumber", "account_number", "string", "String"),
      col("OpeningBalance", "opening_balance_usd", "float", "Float64"),
      col("DebitMovement", "debit_movement_usd", "float", "Float64"),
      col("CreditMovement", "credit_movement_usd", "float", "Float64"),
      col("ClosingBalance", "closing_balance_usd", "float", "Float64"),
    ],
  },
  {
    sheet: "FactAccountsReceivable",
    table: "ebpo_fact_accounts_receivable",
    orderBy: "date_key, client_key, aging_bucket",
    columns: [
      col("DateKey", "date_key", "uint", "UInt32"),
      col("ClientKey", "client_key", "uint", "UInt32"),
      col("InvoiceAmount", "invoice_amount_usd", "float", "Float64"),
      col("CollectedAmount", "collected_amount_usd", "float", "Float64"),
      col("OutstandingBalance", "outstanding_balance_usd", "float", "Float64"),
      col("AgingBucket", "aging_bucket", "string", "LowCardinality(String)"),
    ],
  },
  {
    sheet: "FactAccountsPayable",
    table: "ebpo_fact_accounts_payable",
    orderBy: "date_key, vendor_key, aging_bucket",
    columns: [
      col("DateKey", "date_key", "uint", "UInt32"),
      col("VendorKey", "vendor_key", "uint", "UInt32"),
      col("InvoiceAmount", "invoice_amount_usd", "float", "Float64"),
      col("PaidAmount", "paid_amount_usd", "float", "Float64"),
      col("OutstandingBalance", "outstanding_balance_usd", "float", "Float64"),
      col("AgingBucket", "aging_bucket", "string", "LowCardinality(String)"),
    ],
  },
  {
    sheet: "FactOperations",
    table: "ebpo_fact_operations",
    orderBy: "date_key, delivery_center",
    columns: [
      col("DateKey", "date_key", "uint", "UInt32"),
      col("DeliveryCenter", "delivery_center", "string", "String"),
      col("CallsHandled", "calls_handled", "float", "Float64"),
      col("TicketsResolved", "tickets_resolved", "float", "Float64"),
      col("AHTMinutes", "aht_minutes", "float", "Float64"),
      col("SLACompliancePct", "sla_compliance_pct", "float", "Float64"),
      col("CSATPct", "csat_pct", "float", "Float64"),
      col("UtilizationPct", "utilization_pct", "float", "Float64"),
    ],
  },
  {
    sheet: "FactCashFlow",
    table: "ebpo_fact_cash_flow",
    orderBy: "date_key",
    columns: [
      col("DateKey", "date_key", "uint", "UInt32"),
      col("OperatingCashFlow", "operating_cash_flow_usd", "float", "Float64"),
      col("InvestingCashFlow", "investing_cash_flow_usd", "float", "Float64"),
      col("FinancingCashFlow", "financing_cash_flow_usd", "float", "Float64"),
      col("FreeCashFlow", "free_cash_flow_usd", "float", "Float64"),
      col("CashBalance", "cash_balance_usd", "float", "Float64"),
    ],
  },
  {
    sheet: "FactFixedAssets",
    table: "ebpo_fact_fixed_assets",
    orderBy: "asset_key",
    columns: [
      col("AssetKey", "asset_key", "uint", "UInt32"),
      col("DeliveryCenter", "delivery_center", "string", "String"),
      col("AssetType", "asset_type", "string", "LowCardinality(String)"),
      col("AssetCostUSD", "asset_cost_usd", "float", "Float64"),
      col("AccumulatedDepreciationUSD", "accumulated_depreciation_usd", "float", "Float64"),
      col("NetBookValueUSD", "net_book_value_usd", "float", "Float64"),
    ],
  },
];

function col(source: string, name: string, kind: ColumnKind, ddl: string): ColumnSpec {
  return { source, name, kind, ddl };
}

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

function requiredArg(flag: string): string {
  const value = getArg(flag);
  if (!value) throw new Error(`Missing required argument: ${flag} <value>`);
  return value;
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

function extractWorkbook(xlsxPath: string): WorkbookDump {
  const extractorPath = path.resolve(__dirname, "extract_xlsx_json.py");
  const python = process.env.PYTHON || "python3";
  const result = spawnSync(python, [extractorPath, xlsxPath], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`XLSX extract failed (exit ${result.status}): ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout) as WorkbookDump;
}

function toUInt(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

function toFloat(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function toDateOnly(value: unknown): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const text = toText(value);
  if (!text) return "1970-01-01";
  const direct = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (direct) return direct[1];
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const parsed = new Date(text);
  if (Number.isFinite(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return "1970-01-01";
}

function coerceValue(value: unknown, kind: ColumnKind): string | number {
  switch (kind) {
    case "uint":
      return toUInt(value);
    case "float":
      return toFloat(value);
    case "date":
      return toDateOnly(value);
    case "string":
      return toText(value);
  }
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
    for (const column of spec.columns) {
      out[column.name] = coerceValue(record[column.source], column.kind);
    }
    return out;
  });
}

async function upsertUser(email: string) {
  const prisma = await getPrisma();
  const normalized = email.trim().toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email: normalized } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email: normalized,
      fullName: "EBPO Sample User",
      supabaseUserId: crypto.randomUUID(),
      isActive: true,
      isVerified: true,
    },
  });
}

async function upsertOrganization(params: { slug: string; name: string; createdById: string }) {
  const prisma = await getPrisma();
  return prisma.organization.upsert({
    where: { slug: params.slug },
    create: {
      slug: params.slug,
      name: params.name,
      createdById: params.createdById,
    },
    update: { name: params.name },
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
  externalOrganizationId: string;
  displayName: string;
  createdById: string;
}) {
  const prisma = await getPrisma();
  return prisma.erpConnection.upsert({
    where: {
      organizationId_provider_externalOrganizationId: {
        organizationId: params.organizationId,
        provider: ErpProvider.XERO,
        externalOrganizationId: params.externalOrganizationId,
      },
    },
    create: {
      organizationId: params.organizationId,
      provider: ErpProvider.XERO,
      externalOrganizationId: params.externalOrganizationId,
      displayName: params.displayName,
      accessTokenEncrypted: "N/A",
      refreshTokenEncrypted: null,
      tokenExpiresAt: null,
      status: "ACTIVE",
      createdById: params.createdById,
      metadata: { seeded: true, source: SOURCE_TAG },
    },
    update: {
      displayName: params.displayName,
      status: "ACTIVE",
      metadata: { seeded: true, source: SOURCE_TAG },
    },
  });
}

function rawTableDdl(db: string, spec: TableSpec) {
  const columnDdl = spec.columns.map((column) => `            ${column.name} ${column.ddl}`).join(",\n");
  return `
          CREATE TABLE IF NOT EXISTS ${db}.${spec.table} (
            tenant_id String,
            user_id String DEFAULT '',
            connection_id String DEFAULT '',
            provider LowCardinality(String) DEFAULT '',
            org_id String,
            org_name String DEFAULT '',
            source_dataset LowCardinality(String) DEFAULT '${SOURCE_TAG}',
${columnDdl},
            loaded_at DateTime DEFAULT now()
          ) ENGINE = MergeTree()
          ORDER BY (tenant_id, org_id, ${spec.orderBy})
        `;
}

function semanticViewDdls(db: string) {
  return [
    `
      CREATE VIEW ${db}.v_ebpo_revenue_monthly AS
      SELECT
        tenant_id,
        org_id,
        org_name,
        period_date,
        year,
        quarter,
        month,
        month_name,
        total_revenue_usd,
        total_cost_usd,
        gross_margin_usd,
        gross_margin_pct,
        round(
          (total_revenue_usd - lagInFrame(total_revenue_usd, 12) OVER w)
          / nullIf(lagInFrame(total_revenue_usd, 12) OVER w, 0) * 100,
          2
        ) AS revenue_yoy_pct
      FROM (
        SELECT
          revenue.tenant_id AS tenant_id,
          revenue.org_id AS org_id,
          any(revenue.org_name) AS org_name,
          dates.date AS period_date,
          dates.year AS year,
          dates.quarter AS quarter,
          dates.month AS month,
          dates.month_name AS month_name,
          round(sum(revenue.revenue_usd), 2) AS total_revenue_usd,
          round(sum(revenue.cost_usd), 2) AS total_cost_usd,
          round(sum(revenue.gross_margin_usd), 2) AS gross_margin_usd,
          round(sum(revenue.gross_margin_usd) / nullIf(sum(revenue.revenue_usd), 0) * 100, 2) AS gross_margin_pct
        FROM ${db}.ebpo_fact_revenue revenue
        INNER JOIN ${db}.ebpo_dim_date dates
          ON dates.tenant_id = revenue.tenant_id AND dates.org_id = revenue.org_id AND dates.date_key = revenue.date_key
        GROUP BY revenue.tenant_id, revenue.org_id, dates.date, dates.year, dates.quarter, dates.month, dates.month_name
      )
      WINDOW w AS (PARTITION BY tenant_id, org_id ORDER BY period_date ASC ROWS BETWEEN 12 PRECEDING AND CURRENT ROW)
    `,
    `
      CREATE VIEW ${db}.v_ebpo_revenue_expense_by_client_monthly AS
      SELECT
        revenue.tenant_id AS tenant_id,
        revenue.org_id AS org_id,
        any(revenue.org_name) AS org_name,
        dates.date AS period_date,
        dates.year AS year,
        dates.quarter AS quarter,
        dates.month AS month,
        dates.month_name AS month_name,
        clients.client_name AS client_name,
        clients.industry AS industry,
        round(sum(revenue.revenue_usd), 2) AS total_revenue_usd,
        round(sum(revenue.cost_usd), 2) AS total_cost_usd,
        round(sum(revenue.gross_margin_usd), 2) AS gross_margin_usd,
        round(sum(revenue.gross_margin_usd) / nullIf(sum(revenue.revenue_usd), 0) * 100, 2) AS gross_margin_pct,
        round(sum(revenue.cost_usd) + coalesce(any(payroll.total_payroll_usd), 0), 2) AS total_expenses_usd,
        round((sum(revenue.cost_usd) + coalesce(any(payroll.total_payroll_usd), 0)) / nullIf(sum(revenue.revenue_usd), 0) * 100, 2) AS expense_to_revenue_pct
      FROM ${db}.ebpo_fact_revenue revenue
      INNER JOIN ${db}.ebpo_dim_date dates
        ON dates.tenant_id = revenue.tenant_id AND dates.org_id = revenue.org_id AND dates.date_key = revenue.date_key
      INNER JOIN ${db}.ebpo_dim_client clients
        ON clients.tenant_id = revenue.tenant_id AND clients.org_id = revenue.org_id AND clients.client_key = revenue.client_key
      LEFT JOIN (
        SELECT tenant_id, org_id, date_key, sum(total_payroll_usd) AS total_payroll_usd
        FROM ${db}.ebpo_fact_payroll
        GROUP BY tenant_id, org_id, date_key
      ) payroll
        ON payroll.tenant_id = revenue.tenant_id AND payroll.org_id = revenue.org_id AND payroll.date_key = revenue.date_key
      GROUP BY revenue.tenant_id, revenue.org_id, dates.date, dates.year, dates.quarter, dates.month, dates.month_name,
        clients.client_name, clients.industry
    `,
    `
      CREATE VIEW ${db}.v_ebpo_revenue_expense_by_client AS
      SELECT
        monthly.tenant_id AS tenant_id,
        monthly.org_id AS org_id,
        any(monthly.org_name) AS org_name,
        monthly.client_name AS client_name,
        monthly.industry AS industry,
        round(sum(monthly.total_revenue_usd), 2) AS total_revenue_usd,
        round(sum(monthly.total_cost_usd), 2) AS total_cost_usd,
        round(sum(monthly.gross_margin_usd), 2) AS gross_margin_usd,
        round(sum(monthly.gross_margin_usd) / nullIf(sum(monthly.total_revenue_usd), 0) * 100, 2) AS gross_margin_pct,
        round(sum(monthly.total_expenses_usd), 2) AS total_expenses_usd,
        round(sum(monthly.total_expenses_usd) / nullIf(sum(monthly.total_revenue_usd), 0) * 100, 2) AS expense_to_revenue_pct
      FROM ${db}.v_ebpo_revenue_expense_by_client_monthly monthly
      GROUP BY monthly.tenant_id, monthly.org_id, monthly.client_name, monthly.industry
    `,
    `
      CREATE VIEW ${db}.v_ebpo_revenue_by_client AS
      SELECT
        revenue.tenant_id AS tenant_id,
        revenue.org_id AS org_id,
        any(revenue.org_name) AS org_name,
        clients.client_name AS client_name,
        clients.industry AS industry,
        round(sum(revenue.revenue_usd), 2) AS total_revenue_usd,
        round(sum(revenue.cost_usd), 2) AS total_cost_usd,
        round(sum(revenue.gross_margin_usd), 2) AS gross_margin_usd,
        round(sum(revenue.gross_margin_usd) / nullIf(sum(revenue.revenue_usd), 0) * 100, 2) AS gross_margin_pct
      FROM ${db}.ebpo_fact_revenue revenue
      INNER JOIN ${db}.ebpo_dim_client clients
        ON clients.tenant_id = revenue.tenant_id AND clients.org_id = revenue.org_id AND clients.client_key = revenue.client_key
      GROUP BY revenue.tenant_id, revenue.org_id, clients.client_name, clients.industry
    `,
    `
      CREATE VIEW ${db}.v_ebpo_revenue_by_client_contract AS
      SELECT
        revenue.tenant_id AS tenant_id,
        revenue.org_id AS org_id,
        any(revenue.org_name) AS org_name,
        clients.client_name AS client_name,
        clients.industry AS industry,
        revenue.contract_type AS contract_type,
        revenue.business_unit AS business_unit,
        round(sum(revenue.revenue_usd), 2) AS total_revenue_usd,
        round(sum(revenue.cost_usd), 2) AS total_cost_usd,
        round(sum(revenue.gross_margin_usd), 2) AS gross_margin_usd,
        round(sum(revenue.gross_margin_usd) / nullIf(sum(revenue.revenue_usd), 0) * 100, 2) AS gross_margin_pct
      FROM ${db}.ebpo_fact_revenue revenue
      INNER JOIN ${db}.ebpo_dim_client clients
        ON clients.tenant_id = revenue.tenant_id AND clients.org_id = revenue.org_id AND clients.client_key = revenue.client_key
      GROUP BY revenue.tenant_id, revenue.org_id, clients.client_name, clients.industry, revenue.contract_type, revenue.business_unit
    `,
    `
      CREATE VIEW ${db}.v_ebpo_revenue_by_business_unit AS
      SELECT
        tenant_id,
        org_id,
        any(org_name) AS org_name,
        business_unit,
        contract_type,
        round(sum(revenue.revenue_usd), 2) AS total_revenue_usd,
        round(sum(revenue.cost_usd), 2) AS total_cost_usd,
        round(sum(revenue.gross_margin_usd), 2) AS gross_margin_usd,
        round(sum(revenue.gross_margin_usd) / nullIf(sum(revenue.revenue_usd), 0) * 100, 2) AS gross_margin_pct
      FROM ${db}.ebpo_fact_revenue revenue
      GROUP BY tenant_id, org_id, business_unit, contract_type
    `,
    `
      CREATE VIEW ${db}.v_ebpo_revenue_by_business_unit_monthly AS
      SELECT
        revenue.tenant_id AS tenant_id,
        revenue.org_id AS org_id,
        any(revenue.org_name) AS org_name,
        dates.date AS period_date,
        dates.year AS year,
        dates.quarter AS quarter,
        dates.month AS month,
        dates.month_name AS month_name,
        revenue.business_unit AS business_unit,
        revenue.contract_type AS contract_type,
        round(sum(revenue.revenue_usd), 2) AS total_revenue_usd,
        round(sum(revenue.cost_usd), 2) AS total_cost_usd,
        round(sum(revenue.gross_margin_usd), 2) AS gross_margin_usd,
        round(sum(revenue.gross_margin_usd) / nullIf(sum(revenue.revenue_usd), 0) * 100, 2) AS gross_margin_pct
      FROM ${db}.ebpo_fact_revenue revenue
      INNER JOIN ${db}.ebpo_dim_date dates
        ON dates.tenant_id = revenue.tenant_id AND dates.org_id = revenue.org_id AND dates.date_key = revenue.date_key
      GROUP BY revenue.tenant_id, revenue.org_id, dates.date, dates.year, dates.quarter, dates.month, dates.month_name,
        revenue.business_unit, revenue.contract_type
    `,
    `
      CREATE VIEW ${db}.v_ebpo_revenue_by_geography_monthly AS
      SELECT
        revenue.tenant_id AS tenant_id,
        revenue.org_id AS org_id,
        any(revenue.org_name) AS org_name,
        dates.date AS period_date,
        dates.year AS year,
        dates.quarter AS quarter,
        dates.month AS month,
        dates.month_name AS month_name,
        geo.region AS region,
        geo.country AS country,
        geo.delivery_center AS delivery_center,
        round(sum(revenue.revenue_usd), 2) AS total_revenue_usd,
        round(sum(revenue.cost_usd), 2) AS total_cost_usd,
        round(sum(revenue.gross_margin_usd), 2) AS gross_margin_usd,
        round(sum(revenue.gross_margin_usd) / nullIf(sum(revenue.revenue_usd), 0) * 100, 2) AS gross_margin_pct
      FROM ${db}.ebpo_fact_revenue revenue
      INNER JOIN ${db}.ebpo_dim_date dates
        ON dates.tenant_id = revenue.tenant_id AND dates.org_id = revenue.org_id AND dates.date_key = revenue.date_key
      INNER JOIN ${db}.ebpo_dim_geography geo
        ON geo.tenant_id = revenue.tenant_id AND geo.org_id = revenue.org_id AND geo.geography_key = revenue.geography_key
      GROUP BY revenue.tenant_id, revenue.org_id, dates.date, dates.year, dates.quarter, dates.month, dates.month_name,
        geo.region, geo.country, geo.delivery_center
    `,
    `
      CREATE VIEW ${db}.v_ebpo_revenue_by_department_monthly AS
      SELECT
        revenue.tenant_id AS tenant_id,
        revenue.org_id AS org_id,
        any(revenue.org_name) AS org_name,
        dates.date AS period_date,
        dates.year AS year,
        dates.quarter AS quarter,
        dates.month AS month,
        dates.month_name AS month_name,
        dept.department_name AS department,
        round(sum(revenue.revenue_usd), 2) AS total_revenue_usd,
        round(sum(revenue.cost_usd), 2) AS total_cost_usd,
        round(sum(revenue.gross_margin_usd), 2) AS gross_margin_usd,
        round(sum(revenue.gross_margin_usd) / nullIf(sum(revenue.revenue_usd), 0) * 100, 2) AS gross_margin_pct
      FROM ${db}.ebpo_fact_revenue revenue
      INNER JOIN ${db}.ebpo_dim_date dates
        ON dates.tenant_id = revenue.tenant_id AND dates.org_id = revenue.org_id AND dates.date_key = revenue.date_key
      INNER JOIN ${db}.ebpo_dim_department dept
        ON dept.tenant_id = revenue.tenant_id AND dept.org_id = revenue.org_id AND dept.department_key = revenue.department_key
      GROUP BY revenue.tenant_id, revenue.org_id, dates.date, dates.year, dates.quarter, dates.month, dates.month_name,
        dept.department_name
    `,
    `
      CREATE VIEW ${db}.v_ebpo_revenue_by_client_contract_monthly AS
      SELECT
        revenue.tenant_id AS tenant_id,
        revenue.org_id AS org_id,
        any(revenue.org_name) AS org_name,
        dates.date AS period_date,
        dates.year AS year,
        dates.quarter AS quarter,
        dates.month AS month,
        dates.month_name AS month_name,
        clients.client_name AS client_name,
        clients.industry AS industry,
        revenue.contract_type AS contract_type,
        revenue.business_unit AS business_unit,
        round(sum(revenue.revenue_usd), 2) AS total_revenue_usd,
        round(sum(revenue.cost_usd), 2) AS total_cost_usd,
        round(sum(revenue.gross_margin_usd), 2) AS gross_margin_usd,
        round(sum(revenue.gross_margin_usd) / nullIf(sum(revenue.revenue_usd), 0) * 100, 2) AS gross_margin_pct
      FROM ${db}.ebpo_fact_revenue revenue
      INNER JOIN ${db}.ebpo_dim_date dates
        ON dates.tenant_id = revenue.tenant_id AND dates.org_id = revenue.org_id AND dates.date_key = revenue.date_key
      INNER JOIN ${db}.ebpo_dim_client clients
        ON clients.tenant_id = revenue.tenant_id AND clients.org_id = revenue.org_id AND clients.client_key = revenue.client_key
      GROUP BY revenue.tenant_id, revenue.org_id, dates.date, dates.year, dates.quarter, dates.month, dates.month_name,
        clients.client_name, clients.industry, revenue.contract_type, revenue.business_unit
    `,
    `
      CREATE VIEW ${db}.v_ebpo_payroll_monthly AS
      SELECT
        payroll.tenant_id AS tenant_id,
        payroll.org_id AS org_id,
        any(payroll.org_name) AS org_name,
        dates.date AS period_date,
        dates.year,
        dates.quarter,
        dates.month,
        dates.month_name,
        payroll.department AS department,
        payroll.country AS country,
        uniqExact(payroll.employee_key) AS employee_count,
        round(sum(payroll.base_salary_usd), 2) AS total_base_salary_usd,
        round(sum(payroll.overtime_usd), 2) AS total_overtime_usd,
        round(sum(payroll.bonus_usd), 2) AS total_bonus_usd,
        round(sum(payroll.benefits_usd), 2) AS total_benefits_usd,
        round(sum(payroll.total_payroll_usd), 2) AS total_payroll_usd
      FROM ${db}.ebpo_fact_payroll payroll
      INNER JOIN ${db}.ebpo_dim_date dates
        ON dates.tenant_id = payroll.tenant_id AND dates.org_id = payroll.org_id AND dates.date_key = payroll.date_key
      GROUP BY payroll.tenant_id, payroll.org_id, dates.date, dates.year, dates.quarter, dates.month, dates.month_name, payroll.department, payroll.country
    `,
    `
      CREATE VIEW ${db}.v_ebpo_employee_headcount AS
      SELECT
        emp.tenant_id AS tenant_id,
        emp.org_id AS org_id,
        any(emp.org_name) AS org_name,
        emp.department AS department,
        emp.country AS country,
        emp.delivery_center AS delivery_center,
        emp.grade AS grade,
        count() AS employee_count,
        round(avg(emp.monthly_salary_usd), 2) AS avg_monthly_salary_usd,
        round(sum(emp.monthly_salary_usd), 2) AS total_monthly_salary_usd
      FROM ${db}.ebpo_dim_employee emp
      GROUP BY emp.tenant_id, emp.org_id, emp.department, emp.country, emp.delivery_center, emp.grade
    `,
    `
      CREATE VIEW ${db}.v_ebpo_trial_balance_monthly AS
      SELECT
        trial.tenant_id AS tenant_id,
        trial.org_id AS org_id,
        any(trial.org_name) AS org_name,
        dates.date AS period_date,
        dates.year AS year,
        dates.quarter AS quarter,
        dates.month AS month,
        dates.month_name AS month_name,
        trial.account_number AS account_number,
        any(accounts.account_name) AS account_name,
        round(sum(trial.opening_balance_usd), 2) AS opening_balance_usd,
        round(sum(trial.debit_movement_usd), 2) AS debit_movement_usd,
        round(sum(trial.credit_movement_usd), 2) AS credit_movement_usd,
        round(sum(trial.closing_balance_usd), 2) AS closing_balance_usd,
        round(sum(trial.debit_movement_usd - trial.credit_movement_usd), 2) AS net_movement_usd
      FROM ${db}.ebpo_fact_trial_balance trial
      INNER JOIN ${db}.ebpo_dim_date dates
        ON dates.tenant_id = trial.tenant_id AND dates.org_id = trial.org_id AND dates.date_key = trial.date_key
      LEFT JOIN ${db}.ebpo_dim_account accounts
        ON accounts.tenant_id = trial.tenant_id AND accounts.org_id = trial.org_id AND accounts.account_number = trial.account_number
      GROUP BY trial.tenant_id, trial.org_id, dates.date, dates.year, dates.quarter, dates.month, dates.month_name, trial.account_number
    `,
    `
      CREATE VIEW ${db}.v_ebpo_ar_aging AS
      SELECT
        ar.tenant_id AS tenant_id,
        ar.org_id AS org_id,
        any(ar.org_name) AS org_name,
        dates.date AS period_date,
        clients.client_name AS client_name,
        clients.industry AS industry,
        ar.aging_bucket AS aging_bucket,
        round(sum(ar.invoice_amount_usd), 2) AS invoice_amount_usd,
        round(sum(ar.collected_amount_usd), 2) AS collected_amount_usd,
        round(sum(ar.outstanding_balance_usd), 2) AS outstanding_balance_usd,
        round(sum(ar.outstanding_balance_usd), 2) AS outstanding_usd,
        round(sum(ar.collected_amount_usd) / nullIf(sum(ar.invoice_amount_usd), 0) * 100, 2) AS collection_rate_pct,
        round(sum(ar.collected_amount_usd) / nullIf(sum(ar.invoice_amount_usd), 0) * 100, 2) AS collection_rate_percentage
      FROM ${db}.ebpo_fact_accounts_receivable ar
      INNER JOIN ${db}.ebpo_dim_date dates
        ON dates.tenant_id = ar.tenant_id AND dates.org_id = ar.org_id AND dates.date_key = ar.date_key
      INNER JOIN ${db}.ebpo_dim_client clients
        ON clients.tenant_id = ar.tenant_id AND clients.org_id = ar.org_id AND clients.client_key = ar.client_key
      GROUP BY ar.tenant_id, ar.org_id, dates.date, clients.client_name, clients.industry, ar.aging_bucket
    `,
    `
      CREATE VIEW ${db}.v_ebpo_ap_aging AS
      SELECT
        ap.tenant_id AS tenant_id,
        ap.org_id AS org_id,
        any(ap.org_name) AS org_name,
        dates.date AS period_date,
        vendors.vendor_name AS vendor_name,
        ap.aging_bucket AS aging_bucket,
        round(sum(ap.invoice_amount_usd), 2) AS invoice_amount_usd,
        round(sum(ap.paid_amount_usd), 2) AS paid_amount_usd,
        round(sum(ap.outstanding_balance_usd), 2) AS outstanding_balance_usd,
        round(sum(ap.outstanding_balance_usd), 2) AS outstanding_usd
      FROM ${db}.ebpo_fact_accounts_payable ap
      INNER JOIN ${db}.ebpo_dim_date dates
        ON dates.tenant_id = ap.tenant_id AND dates.org_id = ap.org_id AND dates.date_key = ap.date_key
      INNER JOIN ${db}.ebpo_dim_vendor vendors
        ON vendors.tenant_id = ap.tenant_id AND vendors.org_id = ap.org_id AND vendors.vendor_key = ap.vendor_key
      GROUP BY ap.tenant_id, ap.org_id, dates.date, vendors.vendor_name, ap.aging_bucket
    `,
    `
      CREATE VIEW ${db}.v_ebpo_operations_monthly AS
      SELECT
        operations.tenant_id AS tenant_id,
        operations.org_id AS org_id,
        any(operations.org_name) AS org_name,
        dates.date AS period_date,
        dates.year,
        dates.quarter,
        dates.month,
        dates.month_name,
        operations.delivery_center AS delivery_center,
        any(geo.region) AS region,
        any(geo.country) AS country,
        any(geo.market_type) AS market_type,
        round(sum(operations.calls_handled), 2) AS calls_handled,
        round(sum(operations.tickets_resolved), 2) AS tickets_resolved,
        round(avg(operations.aht_minutes), 2) AS avg_aht_minutes,
        round(avg(operations.aht_minutes), 2) AS average_handling_time_minutes,
        round(avg(operations.sla_compliance_pct), 2) AS sla_compliance_pct,
        round(avg(operations.sla_compliance_pct), 2) AS sla_compliance_percentage,
        round(avg(operations.csat_pct), 2) AS csat_pct,
        round(avg(operations.csat_pct), 2) AS csat_percentage,
        round(avg(operations.utilization_pct), 2) AS utilization_pct,
        round(avg(operations.utilization_pct), 2) AS utilization_percentage
      FROM ${db}.ebpo_fact_operations operations
      INNER JOIN ${db}.ebpo_dim_date dates
        ON dates.tenant_id = operations.tenant_id AND dates.org_id = operations.org_id AND dates.date_key = operations.date_key
      LEFT JOIN ${db}.ebpo_dim_geography geo
        ON geo.tenant_id = operations.tenant_id AND geo.org_id = operations.org_id AND geo.delivery_center = operations.delivery_center
      GROUP BY operations.tenant_id, operations.org_id, dates.date, dates.year, dates.quarter, dates.month, dates.month_name, operations.delivery_center
    `,
    `
      CREATE VIEW ${db}.v_ebpo_cash_flow_monthly AS
      SELECT
        cash.tenant_id AS tenant_id,
        cash.org_id AS org_id,
        any(cash.org_name) AS org_name,
        dates.date AS period_date,
        dates.year,
        dates.quarter,
        dates.month,
        dates.month_name,
        round(sum(cash.operating_cash_flow_usd), 2) AS operating_cash_flow_usd,
        round(sum(cash.investing_cash_flow_usd), 2) AS investing_cash_flow_usd,
        round(sum(cash.financing_cash_flow_usd), 2) AS financing_cash_flow_usd,
        round(sum(cash.free_cash_flow_usd), 2) AS free_cash_flow_usd,
        round(max(cash.cash_balance_usd), 2) AS cash_balance_usd
      FROM ${db}.ebpo_fact_cash_flow cash
      INNER JOIN ${db}.ebpo_dim_date dates
        ON dates.tenant_id = cash.tenant_id AND dates.org_id = cash.org_id AND dates.date_key = cash.date_key
      GROUP BY cash.tenant_id, cash.org_id, dates.date, dates.year, dates.quarter, dates.month, dates.month_name
    `,
    `
      CREATE VIEW ${db}.v_ebpo_fixed_assets_by_center AS
      SELECT
        assets.tenant_id AS tenant_id,
        assets.org_id AS org_id,
        any(assets.org_name) AS org_name,
        assets.delivery_center AS delivery_center,
        assets.asset_type AS asset_type,
        count() AS asset_count,
        round(sum(assets.asset_cost_usd), 2) AS asset_cost_usd,
        round(sum(assets.accumulated_depreciation_usd), 2) AS accumulated_depreciation_usd,
        round(sum(assets.net_book_value_usd), 2) AS net_book_value_usd,
        round(sum(assets.net_book_value_usd), 2) AS net_book_value,
        round(sum(assets.accumulated_depreciation_usd) / nullIf(sum(assets.asset_cost_usd), 0) * 100, 2) AS depreciation_pct
      FROM ${db}.ebpo_fact_fixed_assets assets
      GROUP BY assets.tenant_id, assets.org_id, assets.delivery_center, assets.asset_type
    `,
    `
      CREATE VIEW ${db}.v_ebpo_client_revenue_collection AS
      SELECT
        revenue.tenant_id AS tenant_id,
        revenue.org_id AS org_id,
        revenue.org_name AS org_name,
        revenue.client_name AS client_name,
        revenue.industry AS industry,
        revenue.total_revenue_usd AS total_revenue_usd,
        revenue.total_cost_usd AS total_cost_usd,
        revenue.gross_margin_usd AS gross_margin_usd,
        revenue.gross_margin_pct AS gross_margin_pct,
        coalesce(ar.invoice_amount_usd, 0) AS invoice_amount_usd,
        coalesce(ar.collected_amount_usd, 0) AS collected_amount_usd,
        coalesce(ar.outstanding_balance_usd, 0) AS outstanding_balance_usd,
        coalesce(ar.outstanding_balance_usd, 0) AS outstanding_usd,
        coalesce(ar.collection_rate_pct, 0) AS collection_rate_pct
      FROM (
        SELECT
          fact.tenant_id AS tenant_id,
          fact.org_id AS org_id,
          any(fact.org_name) AS org_name,
          client.client_name AS client_name,
          client.industry AS industry,
          round(sum(fact.revenue_usd), 2) AS total_revenue_usd,
          round(sum(fact.cost_usd), 2) AS total_cost_usd,
          round(sum(fact.gross_margin_usd), 2) AS gross_margin_usd,
          round(sum(fact.gross_margin_usd) / nullIf(sum(fact.revenue_usd), 0) * 100, 2) AS gross_margin_pct
        FROM ${db}.ebpo_fact_revenue fact
        INNER JOIN ${db}.ebpo_dim_client client
          ON client.tenant_id = fact.tenant_id AND client.org_id = fact.org_id AND client.client_key = fact.client_key
        GROUP BY fact.tenant_id, fact.org_id, client.client_name, client.industry
      ) revenue
      LEFT JOIN (
        SELECT
          ar.tenant_id AS tenant_id,
          ar.org_id AS org_id,
          client.client_name AS client_name,
          round(sum(ar.invoice_amount_usd), 2) AS invoice_amount_usd,
          round(sum(ar.collected_amount_usd), 2) AS collected_amount_usd,
          round(sum(ar.outstanding_balance_usd), 2) AS outstanding_balance_usd,
          round(sum(ar.collected_amount_usd) / nullIf(sum(ar.invoice_amount_usd), 0) * 100, 2) AS collection_rate_pct
        FROM ${db}.ebpo_fact_accounts_receivable ar
        INNER JOIN ${db}.ebpo_dim_client client
          ON client.tenant_id = ar.tenant_id AND client.org_id = ar.org_id AND client.client_key = ar.client_key
        GROUP BY ar.tenant_id, ar.org_id, client.client_name
      ) ar
        ON ar.tenant_id = revenue.tenant_id AND ar.org_id = revenue.org_id AND ar.client_name = revenue.client_name
    `,
    `
      CREATE VIEW ${db}.v_ebpo_department_efficiency_monthly AS
      SELECT
        payroll.tenant_id AS tenant_id,
        payroll.org_id AS org_id,
        any(payroll.org_name) AS org_name,
        dates.date AS period_date,
        dates.year AS year,
        dates.quarter AS quarter,
        dates.month AS month,
        dates.month_name AS month_name,
        payroll.department AS department,
        uniqExact(payroll.employee_key) AS employee_count,
        round(sum(payroll.total_payroll_usd), 2) AS total_payroll_usd,
        round(any(revenue.total_revenue_usd), 2) AS total_revenue_usd,
        round(any(revenue.total_cost_usd), 2) AS total_cost_usd,
        round(any(revenue.gross_margin_usd), 2) AS gross_margin_usd,
        round(any(revenue.total_revenue_usd) / nullIf(uniqExact(payroll.employee_key), 0), 2) AS revenue_per_employee_usd,
        round(sum(payroll.total_payroll_usd) / nullIf(uniqExact(payroll.employee_key), 0), 2) AS cost_per_employee_usd
      FROM ${db}.ebpo_fact_payroll payroll
      INNER JOIN ${db}.ebpo_dim_date dates
        ON dates.tenant_id = payroll.tenant_id AND dates.org_id = payroll.org_id AND dates.date_key = payroll.date_key
      LEFT JOIN (
        SELECT tenant_id, org_id, date_key, sum(revenue_usd) AS total_revenue_usd, sum(cost_usd) AS total_cost_usd, sum(gross_margin_usd) AS gross_margin_usd
        FROM ${db}.ebpo_fact_revenue
        GROUP BY tenant_id, org_id, date_key
      ) revenue
        ON revenue.tenant_id = payroll.tenant_id AND revenue.org_id = payroll.org_id AND revenue.date_key = payroll.date_key
      GROUP BY payroll.tenant_id, payroll.org_id, dates.date, dates.year, dates.quarter, dates.month, dates.month_name, payroll.department
    `,
    `
      CREATE VIEW ${db}.v_ebpo_business_unit_efficiency AS
      SELECT
        revenue.tenant_id AS tenant_id,
        revenue.org_id AS org_id,
        any(revenue.org_name) AS org_name,
        revenue.business_unit AS business_unit,
        round(sum(revenue.revenue_usd), 2) AS total_revenue_usd,
        round(sum(revenue.cost_usd), 2) AS total_cost_usd,
        round(sum(revenue.gross_margin_usd), 2) AS gross_margin_usd,
        any(headcount.employee_count) AS employee_count,
        round(sum(revenue.revenue_usd) / nullIf(any(headcount.employee_count), 0), 2) AS revenue_per_employee_usd
      FROM ${db}.ebpo_fact_revenue revenue
      LEFT JOIN (
        SELECT tenant_id, org_id, count() AS employee_count
        FROM ${db}.ebpo_dim_employee
        GROUP BY tenant_id, org_id
      ) headcount
        ON headcount.tenant_id = revenue.tenant_id AND headcount.org_id = revenue.org_id
      GROUP BY revenue.tenant_id, revenue.org_id, revenue.business_unit
    `,
    `
      CREATE VIEW ${db}.v_ebpo_delivery_center_efficiency_monthly AS
      -- OPERATIONS by delivery center / geography only. Revenue is intentionally NOT
      -- included: FactRevenue has no geography key, so any revenue-by-geography figure
      -- would be a fabricated allocation. "revenue by country/region/delivery center"
      -- must refuse, matching the source model (PowerBI has no such relationship).
      SELECT
        operations.tenant_id AS tenant_id,
        operations.org_id AS org_id,
        any(operations.org_name) AS org_name,
        dates.date AS period_date,
        dates.year AS year,
        dates.quarter AS quarter,
        dates.month AS month,
        dates.month_name AS month_name,
        operations.delivery_center AS delivery_center,
        any(geo.region) AS region,
        any(geo.country) AS country,
        round(sum(operations.calls_handled), 2) AS calls_handled,
        round(avg(operations.utilization_pct), 2) AS utilization_pct,
        any(headcount.employee_count) AS employee_count
      FROM ${db}.ebpo_fact_operations operations
      INNER JOIN ${db}.ebpo_dim_date dates
        ON dates.tenant_id = operations.tenant_id AND dates.org_id = operations.org_id AND dates.date_key = operations.date_key
      LEFT JOIN ${db}.ebpo_dim_geography geo
        ON geo.tenant_id = operations.tenant_id AND geo.org_id = operations.org_id AND geo.delivery_center = operations.delivery_center
      LEFT JOIN (
        SELECT tenant_id, org_id, delivery_center, count() AS employee_count
        FROM ${db}.ebpo_dim_employee
        GROUP BY tenant_id, org_id, delivery_center
      ) headcount
        ON headcount.tenant_id = operations.tenant_id AND headcount.org_id = operations.org_id AND headcount.delivery_center = operations.delivery_center
      GROUP BY operations.tenant_id, operations.org_id, dates.date, dates.year, dates.quarter, dates.month, dates.month_name, operations.delivery_center
    `,
    `
      CREATE VIEW ${db}.v_ebpo_salary_by_dept_grade AS
      SELECT
        emp.tenant_id AS tenant_id,
        emp.org_id AS org_id,
        any(emp.org_name) AS org_name,
        emp.department AS department,
        emp.grade AS grade,
        count() AS employee_count,
        round(avg(emp.monthly_salary_usd), 2) AS avg_monthly_salary_usd,
        round(sum(emp.monthly_salary_usd), 2) AS total_monthly_salary_usd
      FROM ${db}.ebpo_dim_employee emp
      GROUP BY emp.tenant_id, emp.org_id, emp.department, emp.grade
    `,
    `
      CREATE VIEW ${db}.v_ebpo_kpi_monthly AS
      SELECT
        dates.tenant_id AS tenant_id,
        dates.org_id AS org_id,
        any(dates.org_name) AS org_name,
        dates.date AS period_date,
        dates.year,
        dates.quarter,
        dates.month,
        dates.month_name,
        round(coalesce(revenue.total_revenue_usd, 0), 2) AS total_revenue_usd,
        round(coalesce(revenue.total_cost_usd, 0), 2) AS total_cost_usd,
        round(coalesce(revenue.gross_margin_usd, 0), 2) AS gross_margin_usd,
        round(coalesce(revenue.gross_margin_usd, 0) / nullIf(coalesce(revenue.total_revenue_usd, 0), 0) * 100, 2) AS gross_margin_pct,
        round(coalesce(payroll.total_payroll_usd, 0), 2) AS total_payroll_usd,
        round(coalesce(payroll.total_payroll_usd, 0) / nullIf(coalesce(revenue.total_revenue_usd, 0), 0) * 100, 2) AS payroll_to_revenue_pct,
        round(coalesce(ar.ar_outstanding_usd, 0), 2) AS ar_outstanding_usd,
        round(coalesce(ap.ap_outstanding_usd, 0), 2) AS ap_outstanding_usd,
        round(coalesce(cash.operating_cash_flow_usd, 0), 2) AS operating_cash_flow_usd,
        round(coalesce(cash.free_cash_flow_usd, 0), 2) AS free_cash_flow_usd,
        round(coalesce(cash.cash_balance_usd, 0), 2) AS cash_balance_usd,
        round(coalesce(operations.sla_compliance_pct, 0), 2) AS sla_compliance_pct,
        round(coalesce(operations.csat_pct, 0), 2) AS csat_pct,
        round(coalesce(operations.utilization_pct, 0), 2) AS utilization_pct,
        round(coalesce(ar.ar_outstanding_usd, 0) / nullIf(coalesce(revenue.total_revenue_usd, 0) / 365, 0), 2) AS dso_days,
        round(coalesce(ap.ap_outstanding_usd, 0) / nullIf(coalesce(revenue.total_cost_usd, 0) / 365, 0), 2) AS dpo_days
      FROM ${db}.ebpo_dim_date dates
      LEFT JOIN (
        SELECT tenant_id, org_id, date_key, sum(revenue_usd) AS total_revenue_usd, sum(cost_usd) AS total_cost_usd, sum(gross_margin_usd) AS gross_margin_usd
        FROM ${db}.ebpo_fact_revenue
        GROUP BY tenant_id, org_id, date_key
      ) revenue ON revenue.tenant_id = dates.tenant_id AND revenue.org_id = dates.org_id AND revenue.date_key = dates.date_key
      LEFT JOIN (
        SELECT tenant_id, org_id, date_key, sum(total_payroll_usd) AS total_payroll_usd
        FROM ${db}.ebpo_fact_payroll
        GROUP BY tenant_id, org_id, date_key
      ) payroll ON payroll.tenant_id = dates.tenant_id AND payroll.org_id = dates.org_id AND payroll.date_key = dates.date_key
      LEFT JOIN (
        SELECT tenant_id, org_id, date_key, sum(outstanding_balance_usd) AS ar_outstanding_usd
        FROM ${db}.ebpo_fact_accounts_receivable
        GROUP BY tenant_id, org_id, date_key
      ) ar ON ar.tenant_id = dates.tenant_id AND ar.org_id = dates.org_id AND ar.date_key = dates.date_key
      LEFT JOIN (
        SELECT tenant_id, org_id, date_key, sum(outstanding_balance_usd) AS ap_outstanding_usd
        FROM ${db}.ebpo_fact_accounts_payable
        GROUP BY tenant_id, org_id, date_key
      ) ap ON ap.tenant_id = dates.tenant_id AND ap.org_id = dates.org_id AND ap.date_key = dates.date_key
      LEFT JOIN ${db}.ebpo_fact_cash_flow cash
        ON cash.tenant_id = dates.tenant_id AND cash.org_id = dates.org_id AND cash.date_key = dates.date_key
      LEFT JOIN (
        SELECT tenant_id, org_id, date_key, avg(sla_compliance_pct) AS sla_compliance_pct, avg(csat_pct) AS csat_pct, avg(utilization_pct) AS utilization_pct
        FROM ${db}.ebpo_fact_operations
        GROUP BY tenant_id, org_id, date_key
      ) operations ON operations.tenant_id = dates.tenant_id AND operations.org_id = dates.org_id AND operations.date_key = dates.date_key
      GROUP BY dates.tenant_id, dates.org_id, dates.date, dates.year, dates.quarter, dates.month, dates.month_name,
        revenue.total_revenue_usd, revenue.total_cost_usd, revenue.gross_margin_usd, payroll.total_payroll_usd,
        ar.ar_outstanding_usd, ap.ap_outstanding_usd, cash.operating_cash_flow_usd, cash.free_cash_flow_usd,
        cash.cash_balance_usd, operations.sla_compliance_pct, operations.csat_pct, operations.utilization_pct
    `,
    // Derived CFO ratios — single source of truth, built ON the KPI view above.
    // SUPERSET of the KPI view (all base columns + ratios) so a follow-up that adds
    // another base measure (revenue, FCF, cash balance…) still finds it here.
    // (current/quick ratio deliberately omitted: no full current-liabilities data.)
    `
      CREATE VIEW ${db}.v_ebpo_cfo_ratios_monthly AS
      SELECT
        k.*,
        round(k.total_cost_usd / nullIf(k.total_revenue_usd, 0) * 100, 2) AS cost_to_income_pct,
        round(k.free_cash_flow_usd / nullIf(k.total_revenue_usd, 0) * 100, 2) AS fcf_margin_pct,
        round(k.operating_cash_flow_usd / nullIf(k.total_revenue_usd, 0) * 100, 2) AS operating_cf_to_revenue_pct,
        round((k.total_revenue_usd - k.total_cost_usd - k.total_payroll_usd) / nullIf(k.total_revenue_usd, 0) * 100, 2) AS ebitda_style_margin_pct,
        round(k.cash_balance_usd + k.ar_outstanding_usd - k.ap_outstanding_usd, 2) AS working_capital_usd
      FROM ${db}.v_ebpo_kpi_monthly k
    `,
  ];
}

async function runQuery(client: ReturnType<typeof createClickHouseClient>, query: string) {
  const result = await client.query({ query });
  await result.text();
}

async function createRawTables(client: ReturnType<typeof createClickHouseClient>, db: string) {
  await runQuery(client, `CREATE DATABASE IF NOT EXISTS ${db}`);
  for (const spec of tableSpecs) {
    await runQuery(client, rawTableDdl(db, spec));
  }
  await ensureRawTableColumns(client, db);
}

/**
 * Idempotently converge already-existing raw tables to the current column spec.
 *
 * `CREATE TABLE IF NOT EXISTS` does not add columns to a table that already
 * exists, so any newly introduced ColumnSpec (e.g. geography_key / department_key
 * on ebpo_fact_revenue) must be applied explicitly. `ADD COLUMN IF NOT EXISTS`
 * is a metadata-only, additive operation: existing columns are skipped, existing
 * rows keep their values (new columns default), and no other data is touched.
 */
async function ensureRawTableColumns(client: ReturnType<typeof createClickHouseClient>, db: string) {
  for (const spec of tableSpecs) {
    for (const column of spec.columns) {
      await runQuery(
        client,
        `ALTER TABLE ${db}.${spec.table} ADD COLUMN IF NOT EXISTS ${column.name} ${column.ddl}`,
      );
    }
  }
}

async function recreateSemanticViews(client: ReturnType<typeof createClickHouseClient>, db: string) {
  const viewNames = [
    "v_ebpo_client_revenue_collection",
    "v_ebpo_department_efficiency_monthly",
    "v_ebpo_business_unit_efficiency",
    "v_ebpo_delivery_center_efficiency_monthly",
    "v_ebpo_revenue_expense_by_client",
    "v_ebpo_revenue_expense_by_client_monthly",
    "v_ebpo_revenue_monthly",
    "v_ebpo_revenue_by_client",
    "v_ebpo_revenue_by_client_contract",
    "v_ebpo_revenue_by_business_unit",
    "v_ebpo_revenue_by_business_unit_monthly",
    "v_ebpo_revenue_by_geography_monthly",
    "v_ebpo_revenue_by_department_monthly",
    "v_ebpo_revenue_by_client_contract_monthly",
    "v_ebpo_payroll_monthly",
    "v_ebpo_employee_headcount",
    "v_ebpo_trial_balance_monthly",
    "v_ebpo_ar_aging",
    "v_ebpo_ap_aging",
    "v_ebpo_operations_monthly",
    "v_ebpo_cash_flow_monthly",
    "v_ebpo_fixed_assets_by_center",
    "v_ebpo_salary_by_dept_grade",
    "v_ebpo_cfo_ratios_monthly",
    "v_ebpo_kpi_monthly",
  ];
  for (const viewName of viewNames) {
    await runQuery(client, `DROP VIEW IF EXISTS ${db}.${viewName}`);
  }
  for (const ddl of semanticViewDdls(db)) {
    await runQuery(client, ddl);
  }
}

async function wipeScope(client: ReturnType<typeof createClickHouseClient>, db: string, scope: Scope) {
  for (const spec of tableSpecs) {
    await client.command({
      query: `ALTER TABLE ${db}.${spec.table} DELETE WHERE tenant_id = {tenantId:String} AND org_id = {orgId:String} SETTINGS mutations_sync = 1`,
      query_params: { tenantId: scope.tenant_id, orgId: scope.org_id },
    });
  }
}

async function insertRows(client: ReturnType<typeof createClickHouseClient>, db: string, table: string, rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) return;
  const batchSize = 5000;
  for (let startIndex = 0; startIndex < rows.length; startIndex += batchSize) {
    await client.insert({
      table: `${db}.${table}`,
      values: rows.slice(startIndex, startIndex + batchSize),
      format: "JSONEachRow",
    });
  }
}

async function countRows(client: ReturnType<typeof createClickHouseClient>, db: string, table: string, scope: Scope) {
  const result = await client.query({
    query: `SELECT count() AS row_count FROM ${db}.${table} WHERE tenant_id = {tenantId:String} AND org_id = {orgId:String}`,
    query_params: { tenantId: scope.tenant_id, orgId: scope.org_id },
    format: "JSONEachRow",
  });
  const rows = (await result.json()) as Array<{ row_count: string | number }>;
  return Number(rows[0]?.row_count ?? 0);
}

async function validateViews(client: ReturnType<typeof createClickHouseClient>, db: string, scope: Scope) {
  const queries = [
    {
      name: "monthly_revenue",
      query: `SELECT count() AS rows, round(sum(total_revenue_usd), 2) AS value FROM ${db}.v_ebpo_revenue_monthly WHERE tenant_id = {tenantId:String} AND org_id = {orgId:String}`,
    },
    {
      name: "payroll_by_department",
      query: `SELECT count() AS rows, round(sum(total_payroll_usd), 2) AS value FROM ${db}.v_ebpo_payroll_monthly WHERE tenant_id = {tenantId:String} AND org_id = {orgId:String}`,
    },
    {
      name: "ar_outstanding",
      query: `SELECT count() AS rows, round(sum(outstanding_balance_usd), 2) AS value FROM ${db}.v_ebpo_ar_aging WHERE tenant_id = {tenantId:String} AND org_id = {orgId:String}`,
    },
    {
      name: "ap_outstanding",
      query: `SELECT count() AS rows, round(sum(outstanding_balance_usd), 2) AS value FROM ${db}.v_ebpo_ap_aging WHERE tenant_id = {tenantId:String} AND org_id = {orgId:String}`,
    },
    {
      name: "operations",
      query: `SELECT count() AS rows, round(avg(sla_compliance_pct), 2) AS value FROM ${db}.v_ebpo_operations_monthly WHERE tenant_id = {tenantId:String} AND org_id = {orgId:String}`,
    },
    {
      name: "kpis",
      query: `SELECT count() AS rows, round(sum(total_revenue_usd), 2) AS value FROM ${db}.v_ebpo_kpi_monthly WHERE tenant_id = {tenantId:String} AND org_id = {orgId:String}`,
    },
    {
      name: "revenue_by_geography",
      query: `SELECT count() AS rows, round(sum(total_revenue_usd), 2) AS value FROM ${db}.v_ebpo_revenue_by_geography_monthly WHERE tenant_id = {tenantId:String} AND org_id = {orgId:String}`,
    },
    {
      name: "revenue_by_department",
      query: `SELECT count() AS rows, round(sum(total_revenue_usd), 2) AS value FROM ${db}.v_ebpo_revenue_by_department_monthly WHERE tenant_id = {tenantId:String} AND org_id = {orgId:String}`,
    },
  ];
  const out: Record<string, { rows: number; value: number }> = {};
  for (const item of queries) {
    const result = await client.query({
      query: item.query,
      query_params: { tenantId: scope.tenant_id, orgId: scope.org_id },
      format: "JSONEachRow",
    });
    const rows = (await result.json()) as Array<{ rows: string | number; value: string | number | null }>;
    out[item.name] = {
      rows: Number(rows[0]?.rows ?? 0),
      value: Number(rows[0]?.value ?? 0),
    };
  }
  return out;
}

async function main() {
  const viewsOnly = hasFlag("--views-only");
  const filePath = viewsOnly ? undefined : requiredArg("--file");
  const userEmail = getArg("--user-email") ?? "demo1@numeriqu.com";
  const orgName = getArg("--org-name") ?? "Sample Company 2024";
  const orgSlug = getArg("--org-slug") ?? "sample-company-2024";
  const externalOrgId = getArg("--external-org-id") ?? "ebpo_sample_company";
  const dryRun = hasFlag("--dry-run");
  const allowRemote = hasFlag("--allow-remote");

  if (!process.env.CLICKHOUSE_ANALYTICS_URL) throw new Error("CLICKHOUSE_ANALYTICS_URL is not set.");
  assertRemoteAllowed(process.env.CLICKHOUSE_ANALYTICS_URL, allowRemote, "ClickHouse");

  const analyticsDb = process.env.CLICKHOUSE_ANALYTICS_DB || "analytics";
  const clickhouse = createClickHouseClient({
    url: process.env.CLICKHOUSE_ANALYTICS_URL,
    username: process.env.CLICKHOUSE_ANALYTICS_USER || "dbt_transformer",
    password: process.env.CLICKHOUSE_ANALYTICS_PASSWORD || "",
    database: analyticsDb,
  });

  if (viewsOnly) {
    await recreateSemanticViews(clickhouse, analyticsDb);
    console.log(
      JSON.stringify(
        {
          ok: true,
          viewsOnly: true,
          clickhouse: { db: analyticsDb },
          views: semanticViewDdls(analyticsDb).length,
        },
        null,
        2,
      ),
    );
    return;
  }

  const absFilePath = path.isAbsolute(filePath!) ? filePath! : path.resolve(process.cwd(), filePath!);
  if (!fs.existsSync(absFilePath)) throw new Error(`XLSX not found: ${absFilePath}`);

  const workbook = extractWorkbook(absFilePath);
  const missing = tableSpecs.filter((spec) => (workbook.sheets[spec.sheet]?.records ?? []).length === 0);
  if (missing.length > 0) {
    throw new Error(`Missing/empty expected workbook sheets: ${missing.map((spec) => spec.sheet).join(", ")}`);
  }

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          dryRun: true,
          file: absFilePath,
          org: { name: orgName, slug: orgSlug, externalOrgId },
          rawTables: Object.fromEntries(tableSpecs.map((spec) => [spec.table, workbook.sheets[spec.sheet].records.length])),
          views: semanticViewDdls("<analytics_db>").length,
          note: "Raw workbook values are preserved; semantic views are derived for charting.",
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set.");
  assertRemoteAllowed(process.env.DATABASE_URL, allowRemote, "Postgres");

  const user = await upsertUser(userEmail);
  const org = await upsertOrganization({ slug: orgSlug, name: orgName, createdById: user.id });
  await ensureMembership(org.id, user.id);
  const connection = await upsertConnection({
    organizationId: org.id,
    externalOrganizationId: externalOrgId,
    displayName: "EBPO Financial Dataset",
    createdById: user.id,
  });

  const scope: Scope = {
    tenant_id: org.id,
    user_id: user.id,
    connection_id: connection.id,
    provider: "xero",
    org_id: externalOrgId,
    org_name: orgName,
  };

  await createRawTables(clickhouse, analyticsDb);
  await recreateSemanticViews(clickhouse, analyticsDb);
  await wipeScope(clickhouse, analyticsDb, scope);

  const inserted: Record<string, number> = {};
  for (const spec of tableSpecs) {
    const records = workbook.sheets[spec.sheet].records;
    const rows = prepareRows(spec, records, scope);
    await insertRows(clickhouse, analyticsDb, spec.table, rows);
    inserted[spec.table] = rows.length;
  }

  const counts: Record<string, number> = {};
  for (const spec of tableSpecs) {
    counts[spec.table] = await countRows(clickhouse, analyticsDb, spec.table, scope);
  }
  const validations = await validateViews(clickhouse, analyticsDb, scope);

  console.log(
    JSON.stringify(
      {
        ok: true,
        seeded: true,
        source: absFilePath,
        organization: { id: org.id, slug: org.slug, name: org.name },
        connection: { id: connection.id, externalOrganizationId: connection.externalOrganizationId },
        clickhouse: { db: analyticsDb },
        inserted,
        counts,
        validations,
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
