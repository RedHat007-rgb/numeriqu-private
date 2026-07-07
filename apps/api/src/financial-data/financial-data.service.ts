import { Injectable, Inject, Logger } from '@nestjs/common';
import { CLICKHOUSE_ANALYTICS_TOKEN } from '../database/database.module';
import { ClickHouseClient } from '@clickhouse/client';
import { prisma } from '@repo/db';

/** Applied to every ClickHouse query — prevents a single aggregation from OOM-killing the server */
const SAFE_QUERY_SETTINGS = {
  max_memory_usage: '536870912', // 512 MB per-query cap (string)
  max_execution_time: 30, // 30s hard timeout (number)
};

/**
 * FinancialDataService — The "Ground Truth" Engine (Gold Layer ONLY)
 *
 * DESIGN PRINCIPLE:
 * The Bronze→Silver→Gold pipeline exists so the read path ONLY touches Gold.
 * This service NEVER queries raw/Bronze tables. If Gold is empty, we return zeros.
 * The InlineTransformService is responsible for populating Gold after every sync.
 *
 * All queries are org-aware: they group by (provider, org_id, org_name) so that
 * multiple Xero orgs / QB companies are always surfaced as distinct dimensions.
 */
@Injectable()
export class FinancialDataService {
  private readonly logger = new Logger(FinancialDataService.name);
  private readonly dbName: string;

  constructor(
    @Inject(CLICKHOUSE_ANALYTICS_TOKEN)
    private readonly clickhouse: ClickHouseClient,
  ) {
    this.dbName = process.env.CLICKHOUSE_ANALYTICS_DB || 'analytics';
  }

  /**
   * Detect whether a tenant is using the GL-based sample data org.
   * Identified by connection metadata: { source: "sample_gl_v2" }
   */
  private isSampleGLOrg(activeConns: Array<{ metadata: any }>): boolean {
    return activeConns.some(
      (c) => (c.metadata as Record<string, any>)?.source === 'sample_gl_v2',
    );
  }

  private isEbpoOrg(
    activeConns: Array<{
      externalOrganizationId: string;
      metadata?: any;
    }>,
  ): boolean {
    return activeConns.some((conn) => {
      const metadata = (conn.metadata as Record<string, unknown>) || {};
      const source = String(metadata.source ?? '').toLowerCase();
      const orgName = String(metadata.orgName ?? '').toLowerCase();
      const externalOrgId = String(conn.externalOrganizationId ?? '').toLowerCase();
      return source.includes('ebpo') || orgName.includes('ebpo') || externalOrgId.includes('ebpo');
    });
  }

  /**
   * Get the organization-level financial profile for a tenant.
   * Routes to GL-based queries for sample orgs, invoice-based for real Xero/QB orgs.
   */
  async getFinancialProfile(tenantId: string): Promise<FinancialProfile> {
    this.logger.log(
      `[GroundTruth] Building financial profile for tenant=${tenantId}`,
    );

    // SECURE ISOLATION: Fetch strictly verified and active orchestration pipelines.
    const activeConns = await prisma.erpConnection.findMany({
      where: { organizationId: tenantId, status: 'ACTIVE' },
      select: { externalOrganizationId: true, provider: true, metadata: true },
    });

    // Route to GL-based queries for sample data orgs
    if (this.isSampleGLOrg(activeConns)) {
      return this.getSampleGLProfile(tenantId, activeConns);
    }

    if (activeConns.length === 0) {
      return {
        tenantId,
        revenue: {
          totalRevenue: 0,
          avgInvoiceValue: 0,
          totalInvoices: 0,
          minInvoice: 0,
          maxInvoice: 0,
          providerCount: 0,
          orgCount: 0,
          currencyCount: 0,
        },
        expenses: {
          totalExpenses: 0,
          totalBills: 0,
          overdueAmount: 0,
          overdueCount: 0,
        },
        netProfit: 0,
        profitMargin: 0,
        invoiceStats: { byStatusAndOrg: [] },
        accountSummary: { byTypeAndOrg: [] },
        connectedOrgs: [],
        budgetSummary: [],
        bankSummary: { total_transfers: 0, total_volume: 0 },
        ventureMetrics: {
          burnRate: 0,
          runwayMonths: 0,
          cashOnHand: 0,
          efficiencyMultiplier: 0,
        },
        computedAt: new Date().toISOString(),
      };
    }

    const activeOrgIds = activeConns.map((c) => c.externalOrganizationId);

    const [
      revenue,
      expenses,
      invoiceStats,
      accountSummary,
      connectedOrgs,
      budgetSummary,
      bankSummary,
      ventureMetrics,
    ] = await Promise.all([
      this.getRevenueMetrics(tenantId, activeOrgIds),
      this.getExpenseMetrics(tenantId, activeOrgIds),
      this.getInvoiceStatistics(tenantId, activeOrgIds),
      this.getAccountSummary(tenantId, activeOrgIds),
      this.getConnectedOrgs(tenantId, activeConns),
      this.getBudgetSummary(tenantId, activeOrgIds),
      this.getBankSummary(tenantId, activeOrgIds),
      this.getVentureMetrics(tenantId, activeOrgIds),
    ]);

    // Deterministically enforce identity counts bypassing Clickhouse cold-start boundaries
    revenue.orgCount = activeConns.length;
    revenue.providerCount = new Set(activeConns.map((c) => c.provider)).size;

    const netProfit = revenue.totalRevenue - expenses.totalExpenses;
    const profitMargin =
      revenue.totalRevenue > 0 ? (netProfit / revenue.totalRevenue) * 100 : 0;

    return {
      tenantId,
      revenue,
      expenses,
      netProfit,
      profitMargin: Math.round(profitMargin * 100) / 100,
      invoiceStats,
      accountSummary,
      connectedOrgs,
      budgetSummary,
      bankSummary,
      ventureMetrics,
      computedAt: new Date().toISOString(),
    };
  }

  /**
   * Budget Summary — Pulled from raw Xero data until Gold Layer transform is implemented.
   */
  private async getBudgetSummary(
    tenantId: string,
    activeOrgIds: string[],
  ): Promise<any[]> {
    try {
      const db = process.env.CLICKHOUSE_XERO_DB || 'xero_custom';
      const result = await this.clickhouse.query({
        query: `
          SELECT 
            org_name,
            JSONExtractString(raw_data, 'description') as description,
            JSONExtractFloat(raw_data, 'total') as total_amount
          FROM ${db}.xero_raw
          WHERE tenant_id = {tenantId:String}
            AND org_id IN ({activeOrgIds:Array(String)})
            AND resource = 'Budgets'
          LIMIT 10
        `,
        query_params: { tenantId, activeOrgIds },
        format: 'JSONEachRow',
      });
      return await result.json();
    } catch {
      return [];
    }
  }

  /**
   * Bank Transfer Summary — Recent volume and velocity.
   */
  private async getBankSummary(
    tenantId: string,
    activeOrgIds: string[],
  ): Promise<any> {
    try {
      const db = process.env.CLICKHOUSE_XERO_DB || 'xero_custom';
      const result = await this.clickhouse.query({
        query: `
          SELECT 
            count(*) as total_transfers,
            coalesce(sum(JSONExtractFloat(raw_data, 'amount')), 0) as total_volume
          FROM ${db}.xero_raw
          WHERE tenant_id = {tenantId:String}
            AND org_id IN ({activeOrgIds:Array(String)})
            AND resource = 'BankTransfers'
        `,
        query_params: { tenantId, activeOrgIds },
        format: 'JSONEachRow',
      });
      const rows: any[] = await result.json();
      return rows[0] || { total_transfers: 0, total_volume: 0 };
    } catch {
      return { total_transfers: 0, total_volume: 0 };
    }
  }

  /**
   * Connected orgs breakdown — lists every distinct (provider, org) pair that
   * has data in the Gold Layer, along with per-org revenue and invoice count.
   * This is the core fix: surfaces each Xero org and QB company separately.
   */
  async getConnectedOrgs(
    tenantId: string,
    activeConns: any[],
  ): Promise<ConnectedOrg[]> {
    const activeOrgIds = activeConns.map((c) => c.externalOrganizationId);
    if (activeOrgIds.length === 0) return [];

    // Seed from Prisma connection metadata (always available, even if Gold is empty)
    const orgMap = new Map<string, ConnectedOrg>();
    for (const conn of activeConns) {
      const meta = (conn.metadata as Record<string, any>) || {};
      orgMap.set(conn.externalOrganizationId, {
        provider: conn.provider,
        orgId: conn.externalOrganizationId,
        orgName: meta.orgName || meta.companyId || conn.externalOrganizationId,
        invoiceCount: 0,
        totalRevenue: 0,
        currency: 'USD',
      });
    }

    try {
      // Enrich with Gold Layer data (if available)
      const result = await this.clickhouse.query({
        query: `
          SELECT
            provider,
            org_id,
            org_name,
            count(*) as invoice_count,
            coalesce(sum(total_amount), 0) as total_revenue,
            any(currency) as currency
          FROM ${this.dbName}.fact_accounting_invoices
          WHERE tenant_id = {tenantId:String}
            AND org_id IN ({activeOrgIds:Array(String)})
          GROUP BY provider, org_id, org_name
        `,
        query_params: { tenantId, activeOrgIds },
        format: 'JSONEachRow',
        clickhouse_settings: SAFE_QUERY_SETTINGS,
      });
      const rows: any[] = await result.json();

      for (const r of rows) {
        const existing = orgMap.get(r.org_id);
        if (existing) {
          existing.invoiceCount = parseInt(r.invoice_count) || 0;
          existing.totalRevenue = parseFloat(r.total_revenue) || 0;
          existing.currency = r.currency || 'USD';
          if (r.org_name && r.org_name !== r.org_id) {
            existing.orgName = r.org_name;
          }
        }
      }
    } catch (e: any) {
      this.logger.error(
        `[FinancialData] ConnectedOrgs enrichment failed: ${e.message}`,
      );
    }

    return Array.from(orgMap.values()).sort(
      (a, b) => b.totalRevenue - a.totalRevenue,
    );
  }

  /**
   * Revenue metrics aggregated from the Gold Layer
   */
  private async getRevenueMetrics(
    tenantId: string,
    activeOrgIds: string[],
  ): Promise<RevenueMetrics> {
    try {
      const res = await this.clickhouse.query({
        query: `
          SELECT 
            coalesce(sum(total_amount), 0) as total_revenue,
            coalesce(avg(total_amount), 0) as avg_invoice_value,
            count(*) as total_invoices,
            coalesce(min(total_amount), 0) as min_invoice,
            coalesce(max(total_amount), 0) as max_invoice,
            count(DISTINCT provider) as provider_count,
            count(DISTINCT org_id) as org_count,
            count(DISTINCT currency) as currency_count
          FROM ${this.dbName}.fact_accounting_invoices
          WHERE tenant_id = {tenantId:String}
            AND org_id IN ({activeOrgIds:Array(String)})
            AND status IN ('AUTHORISED', 'PAID', 'Paid', 'Closed', 'NotSet', 'NeedToSend', 'OVERDUE', 'Overdue', 'Open', 'SUBMITTED')
        `,
        query_params: { tenantId, activeOrgIds },
        format: 'JSONEachRow',
        clickhouse_settings: SAFE_QUERY_SETTINGS,
      });
      const rows: any[] = await res.json();
      const r = rows[0] || {};

      return {
        totalRevenue: parseFloat(r.total_revenue) || 0,
        avgInvoiceValue:
          Math.round((parseFloat(r.avg_invoice_value) || 0) * 100) / 100,
        totalInvoices: parseInt(r.total_invoices) || 0,
        minInvoice: parseFloat(r.min_invoice) || 0,
        maxInvoice: parseFloat(r.max_invoice) || 0,
        providerCount: parseInt(r.provider_count) || 0,
        orgCount: parseInt(r.org_count) || 0,
        currencyCount: parseInt(r.currency_count) || 0,
      };
    } catch (e: any) {
      this.logger.error(`[FinancialData] Revenue query failed: ${e.message}`);
      return {
        totalRevenue: 0,
        avgInvoiceValue: 0,
        totalInvoices: 0,
        minInvoice: 0,
        maxInvoice: 0,
        providerCount: 0,
        orgCount: 0,
        currencyCount: 0,
      };
    }
  }

  /**
   * Exposure metrics from open / overdue invoices.
   *
   * NOTE: This repo currently models invoices in Gold; bills/expenses are not yet available
   * as a verified gold dataset. Treat these numbers as receivables exposure, not spend.
   */
  private async getExpenseMetrics(
    tenantId: string,
    activeOrgIds: string[],
  ): Promise<ExpenseMetrics> {
    try {
      const res = await this.clickhouse.query({
        query: `
          SELECT
            coalesce(sum(total_amount), 0) as total_expenses,
            count(*) as total_bills,
            coalesce(sum(CASE WHEN status IN ('OVERDUE', 'Overdue') THEN total_amount ELSE 0 END), 0) as overdue_amount,
            count(CASE WHEN status IN ('OVERDUE', 'Overdue') THEN 1 END) as overdue_count
          FROM ${this.dbName}.fact_accounting_invoices
          WHERE tenant_id = {tenantId:String}
            AND org_id IN ({activeOrgIds:Array(String)})
            AND status IN ('OVERDUE', 'Overdue', 'SUBMITTED', 'Open', 'NotSet', 'NeedToSend')
        `,
        query_params: { tenantId, activeOrgIds },
        format: 'JSONEachRow',
        clickhouse_settings: SAFE_QUERY_SETTINGS,
      });
      const rows: any[] = await res.json();
      const r = rows[0] || {};

      return {
        totalExpenses: parseFloat(r.total_expenses) || 0,
        totalBills: parseInt(r.total_bills) || 0,
        overdueAmount: parseFloat(r.overdue_amount) || 0,
        overdueCount: parseInt(r.overdue_count) || 0,
      };
    } catch (e: any) {
      this.logger.error(`[FinancialData] Expense query failed: ${e.message}`);
      return {
        totalExpenses: 0,
        totalBills: 0,
        overdueAmount: 0,
        overdueCount: 0,
      };
    }
  }

  /**
   * Invoice-level statistics — status distribution, per org breakdown
   */
  private async getInvoiceStatistics(
    tenantId: string,
    activeOrgIds: string[],
  ): Promise<InvoiceStats> {
    try {
      const result = await this.clickhouse.query({
        query: `
          SELECT
            status,
            provider,
            org_id,
            org_name,
            count(*) as count,
            coalesce(sum(total_amount), 0) as total_amount
          FROM ${this.dbName}.fact_accounting_invoices
          WHERE tenant_id = {tenantId:String}
            AND org_id IN ({activeOrgIds:Array(String)})
          GROUP BY status, provider, org_id, org_name
          ORDER BY total_amount DESC
          LIMIT 200
        `,
        query_params: { tenantId, activeOrgIds },
        format: 'JSONEachRow',
        clickhouse_settings: SAFE_QUERY_SETTINGS,
      });
      const rows: any[] = await result.json();
      return {
        byStatusAndOrg: rows.map((r) => ({
          status: r.status || 'UNKNOWN',
          provider: r.provider,
          orgId: r.org_id,
          orgName: r.org_name || r.org_id,
          count: parseInt(r.count),
          totalAmount: parseFloat(r.total_amount),
        })),
      };
    } catch (e) {
      this.logger.warn(`[GroundTruth] Invoice stats query failed: ${e}`);
      return { byStatusAndOrg: [] };
    }
  }

  /**
   * Chart of Accounts summary — per org
   */
  private async getAccountSummary(
    tenantId: string,
    activeOrgIds: string[],
  ): Promise<AccountSummary> {
    try {
      const result = await this.clickhouse.query({
        query: `
          SELECT
            account_type,
            classification,
            provider,
            org_id,
            org_name,
            count(*) as account_count
          FROM ${this.dbName}.dim_accounting_accounts
          WHERE tenant_id = {tenantId:String}
            AND org_id IN ({activeOrgIds:Array(String)})
            AND is_active = true
          GROUP BY account_type, classification, provider, org_id, org_name
          ORDER BY account_count DESC
          LIMIT 200
        `,
        query_params: { tenantId, activeOrgIds },
        format: 'JSONEachRow',
        clickhouse_settings: SAFE_QUERY_SETTINGS,
      });
      const rows: any[] = await result.json();
      return {
        byTypeAndOrg: rows.map((r) => ({
          accountType: r.account_type,
          classification: r.classification,
          provider: r.provider,
          orgId: r.org_id,
          orgName: r.org_name || r.org_id,
          count: parseInt(r.account_count),
        })),
      };
    } catch (e) {
      this.logger.warn(`[GroundTruth] Account summary query failed: ${e}`);
      return { byTypeAndOrg: [] };
    }
  }

  /**
   * Execute a dynamic, tenant-scoped SQL query against the Gold Layer.
   */
  async executeScopedQuery(tenantId: string, sqlQuery: string): Promise<any[]> {
    this.logger.log(
      `[ScopedQuery] Intent received: ${sqlQuery.slice(0, 50)}...`,
    );

    const normalized = sqlQuery.trim().toUpperCase();

    if (!normalized.startsWith('SELECT')) {
      throw new Error('Only SELECT queries permitted.');
    }
    const forbidden = [
      'DROP',
      'DELETE',
      'INSERT',
      'UPDATE',
      'ALTER',
      'CREATE',
      'TRUNCATE',
    ];
    if (forbidden.some((word) => normalized.includes(word))) {
      throw new Error('Unsafe SQL keywords detected.');
    }

    let finalQuery = sqlQuery;
    if (!normalized.includes('TENANT_ID')) {
      if (normalized.includes('WHERE')) {
        finalQuery = sqlQuery.replace(
          /WHERE/i,
          'WHERE tenant_id = {tenantId:String} AND ',
        );
      } else if (
        normalized.includes('GROUP BY') ||
        normalized.includes('ORDER BY')
      ) {
        const keyword = normalized.includes('GROUP BY')
          ? 'GROUP BY'
          : 'ORDER BY';
        finalQuery = sqlQuery.replace(
          new RegExp(keyword, 'i'),
          `WHERE tenant_id = {tenantId:String} ${keyword}`,
        );
      } else {
        finalQuery = `${sqlQuery} WHERE tenant_id = {tenantId:String}`;
      }
    }

    try {
      const activeConns = await prisma.erpConnection.findMany({
        where: { organizationId: tenantId, status: 'ACTIVE' },
        select: { externalOrganizationId: true },
      });
      const activeOrgIds = activeConns.map((c) => c.externalOrganizationId);
      if (activeOrgIds.length > 0) {
        if (finalQuery.includes('WHERE')) {
          finalQuery = finalQuery.replace(
            /WHERE/i,
            'WHERE org_id IN ({activeOrgIds:Array(String)}) AND ',
          );
        } else {
          finalQuery = `${finalQuery} WHERE org_id IN ({activeOrgIds:Array(String)})`;
        }
      }

      const result = await this.clickhouse.query({
        query: finalQuery,
        query_params: { tenantId, activeOrgIds },
        format: 'JSONEachRow',
        clickhouse_settings: SAFE_QUERY_SETTINGS,
      });
      return await result.json();
    } catch (e: any) {
      this.logger.error(
        `[ScopedQuery] SQL Error: ${e.message} for query: ${finalQuery}`,
      );
      return [];
    }
  }

  /**
   * Semantic Lookup — Uses ClickHouse tokens to find unstructured context.
   */
  async searchSemanticContext(tenantId: string, terms: string): Promise<any[]> {
    try {
      const activeConns = await prisma.erpConnection.findMany({
        where: { organizationId: tenantId, status: 'ACTIVE' },
        select: { externalOrganizationId: true },
      });
      const activeOrgIds = activeConns.map((c) => c.externalOrganizationId);
      if (activeOrgIds.length === 0) return [];

      const result = await this.clickhouse.query({
        query: `
          SELECT * FROM ${this.dbName}.rag_context_invoices
          WHERE tenant_id = {tenantId:String}
            AND org_id IN ({activeOrgIds:Array(String)})
            AND hasAny(splitByNonAlpha(lower(text_content)), splitByNonAlpha(lower({terms:String})))
          LIMIT 10
        `,
        query_params: { tenantId, terms, activeOrgIds },
        format: 'JSONEachRow',
        clickhouse_settings: SAFE_QUERY_SETTINGS,
      });
      return await result.json();
    } catch (e) {
      this.logger.warn(`[SemanticSearch] Search failed: ${e}`);
      return [];
    }
  }

  /**
   * Revenue by month — time series per org for trend analysis (Gold Layer only)
   */
  /**
   * SQL anchor for the EBPO dataset's latest available month. Relative windows
   * ("last N months", MTD/QTD/YTD) must be measured from the newest data — the
   * dataset is historical (ends Dec 2025), so anchoring to now() (a later date)
   * returns zero rows. Every EBPO query binds {tenantId:String}/{orgId:String},
   * so this correlated subquery is valid wherever it is embedded. Mirrors the
   * pattern already used by chart-spec-ebpo.ts.
   */
  private ebpoLatestAnchor(): string {
    return `(SELECT max(period_date) FROM ${this.dbName}.v_ebpo_kpi_monthly WHERE tenant_id = {tenantId:String} AND org_id = {orgId:String})`;
  }

  /**
   * Build a relative-date WHERE fragment. `anchor` is the SQL expression the
   * window is measured back from — pass a data-anchored expression (see
   * {@link ebpoLatestAnchor}) for historical datasets; defaults to now().
   */
  private timeWhere(range: any, dateColumn: string, anchor: string = 'now()'): string {
    if (!range || range.kind === 'ALL_TIME') return '';
    if (range.kind === 'MTD') return `AND ${dateColumn} >= toStartOfMonth(${anchor})`;
    if (range.kind === 'QTD') return `AND ${dateColumn} >= toStartOfQuarter(${anchor})`;
    if (range.kind === 'YTD') return `AND ${dateColumn} >= toStartOfYear(${anchor})`;
    if (range.kind === 'LAST_N_DAYS') {
      return `AND ${dateColumn} >= (${anchor} - INTERVAL ${Math.max(1, Math.floor(range.days ?? 1))} DAY)`;
    }
    if (range.kind === 'LAST_N_WEEKS') {
      return `AND ${dateColumn} >= (${anchor} - INTERVAL ${Math.max(1, Math.floor(range.weeks ?? 1))} WEEK)`;
    }
    if (range.kind === 'LAST_N_MONTHS') {
      // Whole calendar months including the anchor month: N=3 anchored to Dec → Oct, Nov, Dec.
      return `AND ${dateColumn} >= addMonths(toStartOfMonth(${anchor}), -${Math.max(1, Math.floor(range.months ?? 1)) - 1})`;
    }
    if (range.kind === 'LAST_N_QUARTERS') {
      return `AND ${dateColumn} >= addMonths(toStartOfMonth(${anchor}), -${Math.max(1, Math.floor(range.quarters ?? 1)) * 3 - 1})`;
    }
    if (range.kind === 'LAST_N_YEARS') {
      return `AND ${dateColumn} >= (${anchor} - INTERVAL ${Math.max(1, Math.floor(range.years ?? 1))} YEAR)`;
    }
    return '';
  }

  async getExecutiveSnapshot(tenantId: string, range?: any): Promise<ExecutiveSnapshot | null> {
    const activeConns = await prisma.erpConnection.findMany({
      where: { organizationId: tenantId, status: 'ACTIVE' },
      select: { externalOrganizationId: true, provider: true, metadata: true },
    });
    if (activeConns.length === 0 || !this.isEbpoOrg(activeConns)) return null;

    const orgId = activeConns[0]?.externalOrganizationId ?? '';
    const orgName =
      String((activeConns[0]?.metadata as Record<string, unknown>)?.orgName ?? '') ||
      'EBPO Enterprise';
    const anchor = this.ebpoLatestAnchor();
    const rangeFilter = this.timeWhere(range, 'period_date', anchor);

    try {
      const [summaryResult, latestResult, arResult, apResult, clientResult, unitResult] =
        await Promise.all([
          this.clickhouse.query({
            query: `
              SELECT
                round(sum(total_revenue_usd), 2) AS total_revenue_usd,
                round(sum(total_cost_usd), 2) AS total_cost_usd,
                round(sum(total_payroll_usd), 2) AS total_payroll_usd,
                round(sum(gross_margin_usd), 2) AS gross_margin_usd,
                round(sum(free_cash_flow_usd), 2) AS free_cash_flow_usd,
                round(sum(operating_cash_flow_usd), 2) AS operating_cash_flow_usd
              FROM (
                SELECT
                  total_revenue_usd,
                  total_cost_usd,
                  total_payroll_usd,
                  gross_margin_usd,
                  free_cash_flow_usd,
                  operating_cash_flow_usd
                FROM ${this.dbName}.v_ebpo_kpi_monthly
                WHERE tenant_id = {tenantId:String}
                  AND org_id = {orgId:String}
                  ${rangeFilter}
              ) k
            `,
            query_params: { tenantId, orgId },
            format: 'JSONEachRow',
            clickhouse_settings: SAFE_QUERY_SETTINGS,
          }),
          this.clickhouse.query({
            query: `
              SELECT
                period_date,
                cash_balance_usd,
                gross_margin_pct,
                payroll_to_revenue_pct,
                dso_days,
                dpo_days,
                sla_compliance_pct,
                utilization_pct,
                csat_pct,
                working_capital_usd,
                operating_cf_to_revenue_pct,
                fcf_margin_pct,
                ebitda_style_margin_pct,
                ar_outstanding_usd,
                ap_outstanding_usd
              FROM ${this.dbName}.v_ebpo_cfo_ratios_monthly
              WHERE tenant_id = {tenantId:String}
                AND org_id = {orgId:String}
                ${rangeFilter}
              ORDER BY period_date DESC
              LIMIT 1
            `,
            query_params: { tenantId, orgId },
            format: 'JSONEachRow',
            clickhouse_settings: SAFE_QUERY_SETTINGS,
          }),
          this.clickhouse.query({
            query: `
              WITH latest_period AS (
                SELECT max(period_date) AS period_date
                FROM (
                  SELECT period_date
                  FROM ${this.dbName}.v_ebpo_ar_aging
                  WHERE tenant_id = {tenantId:String}
                    AND org_id = {orgId:String}
                    ${rangeFilter}
                ) ar_periods
              )
              SELECT
                round(sum(outstanding_balance_usd), 2) AS outstanding_usd,
                count() AS line_count,
                round(sumIf(outstanding_balance_usd, lower(aging_bucket) NOT LIKE '%current%' AND lower(aging_bucket) NOT LIKE '%0-30%'), 2) AS overdue_usd,
                countIf(lower(aging_bucket) NOT LIKE '%current%' AND lower(aging_bucket) NOT LIKE '%0-30%') AS overdue_count
              FROM (
                SELECT period_date, outstanding_balance_usd, aging_bucket
                FROM ${this.dbName}.v_ebpo_ar_aging
                WHERE tenant_id = {tenantId:String}
                  AND org_id = {orgId:String}
              ) ar_rows
              WHERE period_date = (SELECT period_date FROM latest_period)
            `,
            query_params: { tenantId, orgId },
            format: 'JSONEachRow',
            clickhouse_settings: SAFE_QUERY_SETTINGS,
          }),
          this.clickhouse.query({
            query: `
              WITH latest_period AS (
                SELECT max(period_date) AS period_date
                FROM (
                  SELECT period_date
                  FROM ${this.dbName}.v_ebpo_ap_aging
                  WHERE tenant_id = {tenantId:String}
                    AND org_id = {orgId:String}
                    ${rangeFilter}
                ) ap_periods
              )
              SELECT
                round(sum(outstanding_balance_usd), 2) AS outstanding_usd,
                count() AS line_count
              FROM (
                SELECT period_date, outstanding_balance_usd
                FROM ${this.dbName}.v_ebpo_ap_aging
                WHERE tenant_id = {tenantId:String}
                  AND org_id = {orgId:String}
              ) ap_rows
              WHERE period_date = (SELECT period_date FROM latest_period)
            `,
            query_params: { tenantId, orgId },
            format: 'JSONEachRow',
            clickhouse_settings: SAFE_QUERY_SETTINGS,
          }),
          this.clickhouse.query({
            query: `
              SELECT
                coalesce(nullIf(client.client_name, ''), 'Unassigned') AS client_name,
                round(sum(revenue.revenue_usd), 2) AS total_revenue_usd
              FROM ${this.dbName}.ebpo_fact_revenue revenue
              INNER JOIN ${this.dbName}.ebpo_dim_date dates
                ON dates.tenant_id = revenue.tenant_id
               AND dates.org_id = revenue.org_id
               AND dates.date_key = revenue.date_key
              LEFT JOIN ${this.dbName}.ebpo_dim_client client
                ON client.tenant_id = revenue.tenant_id
               AND client.org_id = revenue.org_id
               AND client.client_key = revenue.client_key
              WHERE revenue.tenant_id = {tenantId:String}
                AND revenue.org_id = {orgId:String}
                ${this.timeWhere(range, 'dates.date', anchor)}
              GROUP BY client_name
              ORDER BY total_revenue_usd DESC
            `,
            query_params: { tenantId, orgId },
            format: 'JSONEachRow',
            clickhouse_settings: SAFE_QUERY_SETTINGS,
          }),
          this.clickhouse.query({
            query: `
              SELECT
                coalesce(nullIf(revenue.business_unit, ''), 'Unassigned') AS business_unit,
                round(sum(revenue.revenue_usd), 2) AS total_revenue_usd,
                round(sum(revenue.gross_margin_usd) / nullIf(sum(revenue.revenue_usd), 0) * 100, 2) AS gross_margin_pct
              FROM ${this.dbName}.ebpo_fact_revenue revenue
              INNER JOIN ${this.dbName}.ebpo_dim_date dates
                ON dates.tenant_id = revenue.tenant_id
               AND dates.org_id = revenue.org_id
               AND dates.date_key = revenue.date_key
              WHERE revenue.tenant_id = {tenantId:String}
                AND revenue.org_id = {orgId:String}
                ${this.timeWhere(range, 'dates.date', anchor)}
              GROUP BY business_unit
              ORDER BY total_revenue_usd DESC
              LIMIT 1
            `,
            query_params: { tenantId, orgId },
            format: 'JSONEachRow',
            clickhouse_settings: SAFE_QUERY_SETTINGS,
          }),
        ]);

      const summary = ((await summaryResult.json()) as any[])[0] ?? {};
      const latest = ((await latestResult.json()) as any[])[0] ?? {};
      const ar = ((await arResult.json()) as any[])[0] ?? {};
      const ap = ((await apResult.json()) as any[])[0] ?? {};
      const clientRows = (await clientResult.json()) as any[];
      const topClient = clientRows[0] ?? {};
      // Smallest revenue-generating account (query is ordered revenue DESC), skipping
      // zero/negative rows so an inactive client doesn't masquerade as the smallest.
      const smallestClient =
        [...clientRows].reverse().find((row) => (parseFloat(row.total_revenue_usd) || 0) > 0) ??
        clientRows[clientRows.length - 1] ??
        {};
      const topBusinessUnit = ((await unitResult.json()) as any[])[0] ?? {};

      const totalRevenue = parseFloat(summary.total_revenue_usd) || 0;
      const totalCost = parseFloat(summary.total_cost_usd) || 0;
      const totalPayroll = parseFloat(summary.total_payroll_usd) || 0;
      const grossMargin = parseFloat(summary.gross_margin_usd) || 0;
      const freeCashFlow = parseFloat(summary.free_cash_flow_usd) || 0;
      const operatingCashFlow = parseFloat(summary.operating_cash_flow_usd) || 0;
      const topClientRevenue = parseFloat(topClient.total_revenue_usd) || 0;
      const topClientConcentrationPct =
        totalRevenue > 0 ? Math.round((topClientRevenue / totalRevenue) * 10000) / 100 : 0;
      const smallestClientRevenue = parseFloat(smallestClient.total_revenue_usd) || 0;
      const smallestClientConcentrationPct =
        totalRevenue > 0 ? Math.round((smallestClientRevenue / totalRevenue) * 10000) / 100 : 0;

      // Dimensional breakdowns for the CFO "lower cards". Computed here (before the service
      // KPIs) so the org-level SLA/util/CSAT can use the range-average operations values
      // rather than a single latest-month snapshot. Isolated internally so a failing view
      // degrades one card to empty without nulling the whole snapshot.
      const breakdowns = await this.getEbpoBusinessBreakdowns(tenantId, orgId, range, totalCost);

      const cashBalance = parseFloat(latest.cash_balance_usd) || 0;
      const workingCapital = parseFloat(latest.working_capital_usd) || 0;
      const dsoDays = parseFloat(latest.dso_days) || 0;
      const dpoDays = parseFloat(latest.dpo_days) || 0;
      const payrollToRevenuePct = parseFloat(latest.payroll_to_revenue_pct) || 0;
      const grossMarginPct = parseFloat(latest.gross_margin_pct) || 0;
      // Range averages from the operations view (match the period averages finance reports),
      // falling back to the latest-month KPI value if operations data is unavailable.
      const slaCompliancePct = breakdowns.avgSlaPct || parseFloat(latest.sla_compliance_pct) || 0;
      const utilizationPct = breakdowns.avgUtilizationPct || parseFloat(latest.utilization_pct) || 0;
      const csatPct = breakdowns.avgCsatPct || parseFloat(latest.csat_pct) || 0;
      const operatingCfToRevenuePct = parseFloat(latest.operating_cf_to_revenue_pct) || 0;
      const fcfMarginPct = parseFloat(latest.fcf_margin_pct) || 0;
      const ebitdaStyleMarginPct = parseFloat(latest.ebitda_style_margin_pct) || 0;
      const arOutstanding = parseFloat(ar.outstanding_usd) || parseFloat(latest.ar_outstanding_usd) || 0;
      const apOutstanding = parseFloat(ap.outstanding_usd) || parseFloat(latest.ap_outstanding_usd) || 0;
      const overdueAmount = parseFloat(ar.overdue_usd) || 0;
      const overdueCount = parseInt(ar.overdue_count) || 0;
      const arLineCount = parseInt(ar.line_count) || 0;
      const apLineCount = parseInt(ap.line_count) || 0;

      const headline =
        freeCashFlow >= 0
          ? `Cash is compounding: free cash flow is ${Math.round(fcfMarginPct)}% of revenue while DSO is holding at ${Math.round(dsoDays)} days.`
          : `Collections need attention: free cash flow is under pressure and ${Math.round(dsoDays)} days are locked in receivables.`;

      const insights: ExecutiveInsight[] = [];
      if (topClientConcentrationPct >= 25) {
        insights.push({
          id: 'nq:client-concentration',
          title: 'Protect the biggest client concentration',
          description: `${topClient.client_name || 'Top client'} contributes ${topClientConcentrationPct.toFixed(1)}% of scoped revenue. Review renewal and pricing risk now.`,
          type: 'Warning',
          createdAt: new Date().toISOString(),
        });
      }
      if (dsoDays >= 45) {
        insights.push({
          id: 'nq:dso-pressure',
          title: 'Release cash from receivables faster',
          description: `DSO is ${Math.round(dsoDays)} days. Tighten collections on aged accounts before the next payroll cycle.`,
          type: 'Warning',
          createdAt: new Date().toISOString(),
        });
      }
      if (payrollToRevenuePct >= 45) {
        insights.push({
          id: 'nq:payroll-discipline',
          title: 'Payroll burden is climbing',
          description: `Payroll is ${payrollToRevenuePct.toFixed(1)}% of revenue in the latest month. Recheck utilization and staffing mix by delivery center.`,
          type: 'Info',
          createdAt: new Date().toISOString(),
        });
      }
      if (slaCompliancePct < 95) {
        insights.push({
          id: 'nq:service-risk',
          title: 'Service execution is at risk',
          description: `SLA is ${slaCompliancePct.toFixed(1)}% and utilization is ${utilizationPct.toFixed(1)}%. Finance should watch margin leakage from delivery stress.`,
          type: 'Warning',
          createdAt: new Date().toISOString(),
        });
      }

      return {
        mode: 'ebpo',
        orgId,
        orgName,
        headline,
        businessUnits: breakdowns.businessUnits,
        costElements: breakdowns.costElements,
        headcountByDepartment: breakdowns.headcountByDepartment,
        headcountByGeography: breakdowns.headcountByGeography,
        smallestDepartment: breakdowns.smallestDepartment,
        smallestGeography: breakdowns.smallestGeography,
        deliveryCenters: breakdowns.deliveryCenters,
        avgHandleTimeMinutes: breakdowns.avgHandleTimeMinutes,
        ticketsResolved: breakdowns.ticketsResolved,
        workforceHeadcount: breakdowns.workforceHeadcount,
        workforcePayroll: breakdowns.workforcePayroll,
        workforceCountries: breakdowns.workforceCountries,
        totalRevenue,
        totalCost,
        totalPayroll,
        grossMargin,
        cashBalance,
        workingCapital,
        freeCashFlow,
        operatingCashFlow,
        grossMarginPct,
        payrollToRevenuePct,
        dsoDays,
        dpoDays,
        operatingCfToRevenuePct,
        fcfMarginPct,
        ebitdaStyleMarginPct,
        cashConversionDays: dsoDays - dpoDays,
        slaCompliancePct,
        utilizationPct,
        csatPct,
        arOutstanding,
        arLineCount,
        apOutstanding,
        apLineCount,
        overdueAmount,
        overdueCount,
        topClientName: String(topClient.client_name ?? '') || null,
        topClientRevenue,
        topClientConcentrationPct,
        smallestClientName: String(smallestClient.client_name ?? '') || null,
        smallestClientRevenue,
        smallestClientConcentrationPct,
        topBusinessUnitName: String(topBusinessUnit.business_unit ?? '') || null,
        topBusinessUnitMarginPct: parseFloat(topBusinessUnit.gross_margin_pct) || 0,
        cashflowWaterfall: [
          { name: 'Revenue', value: totalRevenue, fill: '#00c7d2' },
          { name: 'Total Cost', value: -totalCost, fill: '#ff8a4c' },
          { name: 'Payroll', value: -totalPayroll, fill: '#ff5f7a' },
          { name: 'Free Cash Flow', value: freeCashFlow, fill: freeCashFlow >= 0 ? '#37d67a' : '#ff5f7a' },
          { name: 'Working Capital', value: workingCapital, fill: '#4f8cff' },
        ],
        insights,
      };
    } catch (error: any) {
      this.logger.warn(`[FinancialData] EBPO executive snapshot failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Dimensional breakdowns behind the CFO "lower cards": business units, cost
   * elements, workforce by department & geography, and delivery-center service.
   * Every query is isolated (Promise.allSettled + per-branch guards) so a single
   * failing view degrades that one card to an empty state without breaking the
   * rest of the dashboard. All figures come from the same EBPO views the agent
   * already reads — no fabricated numbers.
   */
  private async getEbpoBusinessBreakdowns(
    tenantId: string,
    orgId: string,
    range: any,
    deliveryCostUsd: number,
  ): Promise<EbpoBreakdowns> {
    const empty: EbpoBreakdowns = {
      businessUnits: [],
      costElements: [],
      headcountByDepartment: [],
      headcountByGeography: [],
      smallestDepartment: null,
      smallestGeography: null,
      deliveryCenters: [],
      avgSlaPct: 0,
      avgUtilizationPct: 0,
      avgCsatPct: 0,
      avgHandleTimeMinutes: 0,
      ticketsResolved: 0,
      workforceHeadcount: 0,
      workforcePayroll: 0,
      workforceCountries: 0,
    };

    const params = { tenantId, orgId };
    const anchor = this.ebpoLatestAnchor();
    const monthWhere = this.timeWhere(range, 'period_date', anchor);
    const factDateWhere = this.timeWhere(range, 'dates.date', anchor);
    // Roster employees with no payroll rows at all (never paid) have no date association,
    // so they can only be counted on the all-time view. On shorter ranges headcount stays
    // strictly payroll-driven (an unpaid employee was never "active" in any window).
    const isAllTime = !range || range.kind === 'ALL_TIME';

    const runJson = async (query: string): Promise<any[]> => {
      const result = await this.clickhouse.query({
        query,
        query_params: params,
        format: 'JSONEachRow',
        clickhouse_settings: SAFE_QUERY_SETTINGS,
      });
      return (await result.json()) as any[];
    };

    try {
      const [buRes, payrollRes, deptRes, geoRes, dcRes, workforceTotalsRes, rosterOnlyRes] = await Promise.allSettled([
        // Business units — real per-BU revenue, cost and ratio-of-sums margin. Full set,
        // ranked by revenue; the card slices the top 6 for bars but derives top/bottom
        // unit and best/worst margin from all of them.
        runJson(`
          SELECT
            coalesce(nullIf(revenue.business_unit, ''), 'Unassigned') AS name,
            round(sum(revenue.revenue_usd), 2) AS revenue_usd,
            round(sum(revenue.cost_usd), 2) AS cost_usd,
            round(sum(revenue.gross_margin_usd) / nullIf(sum(revenue.revenue_usd), 0) * 100, 2) AS margin_pct
          FROM ${this.dbName}.ebpo_fact_revenue revenue
          INNER JOIN ${this.dbName}.ebpo_dim_date dates
            ON dates.tenant_id = revenue.tenant_id
           AND dates.org_id = revenue.org_id
           AND dates.date_key = revenue.date_key
          WHERE revenue.tenant_id = {tenantId:String}
            AND revenue.org_id = {orgId:String}
            ${factDateWhere}
          GROUP BY name
          ORDER BY revenue_usd DESC
        `),
        // Payroll cost elements (flow — summed over range).
        runJson(`
          SELECT
            round(sum(total_base_salary_usd), 2) AS base_salary,
            round(sum(total_overtime_usd), 2) AS overtime,
            round(sum(total_bonus_usd), 2) AS bonus,
            round(sum(total_benefits_usd), 2) AS benefits
          FROM ${this.dbName}.v_ebpo_payroll_monthly
          WHERE tenant_id = {tenantId:String}
            AND org_id = {orgId:String}
            ${monthWhere}
        `),
        // Headcount by department — DISTINCT employees active within the selected range
        // (filter-driven), with payroll summed over that range. Each employee is stable to
        // one department, so per-department distinct counts partition cleanly. Top 6 for
        // the bars; the true totals come from the workforce-totals query below.
        runJson(`
          SELECT
            coalesce(nullIf(payroll.department, ''), 'Unassigned') AS name,
            uniqExact(payroll.employee_key) AS headcount,
            round(sum(payroll.total_payroll_usd), 2) AS payroll
          FROM ${this.dbName}.ebpo_fact_payroll payroll
          INNER JOIN ${this.dbName}.ebpo_dim_date dates
            ON dates.tenant_id = payroll.tenant_id
           AND dates.org_id = payroll.org_id
           AND dates.date_key = payroll.date_key
          WHERE payroll.tenant_id = {tenantId:String}
            AND payroll.org_id = {orgId:String}
            ${factDateWhere}
          GROUP BY name
          ORDER BY headcount DESC
        `),
        // Headcount by country — DISTINCT employees active within the selected range
        // (filter-driven). Top 6 for the bars; totals/percentages use the full-set
        // workforce-totals query below so nothing is understated by the LIMIT.
        runJson(`
          SELECT
            coalesce(nullIf(payroll.country, ''), 'Unassigned') AS name,
            uniqExact(payroll.employee_key) AS headcount
          FROM ${this.dbName}.ebpo_fact_payroll payroll
          INNER JOIN ${this.dbName}.ebpo_dim_date dates
            ON dates.tenant_id = payroll.tenant_id
           AND dates.org_id = payroll.org_id
           AND dates.date_key = payroll.date_key
          WHERE payroll.tenant_id = {tenantId:String}
            AND payroll.org_id = {orgId:String}
            ${factDateWhere}
          GROUP BY name
          ORDER BY headcount DESC
        `),
        // Delivery-center service scorecard — AVERAGED over the full selected range (not a
        // single latest-month snapshot) so SLA/util/CSAT match the period averages finance
        // reports. Full set, ranked by SLA; the card slices the top 6 for bars but derives
        // best/worst/count/avg from all. Tickets are summed over the range (a flow).
        runJson(`
          SELECT
            coalesce(nullIf(delivery_center, ''), 'Unassigned') AS name,
            round(avg(sla_compliance_pct), 1) AS sla_pct,
            round(avg(utilization_pct), 1) AS utilization_pct,
            round(avg(csat_pct), 1) AS csat_pct,
            round(avg(average_handling_time_minutes), 1) AS aht_minutes,
            round(sum(tickets_resolved), 0) AS tickets_resolved,
            sum(calls_handled) AS calls_handled
          FROM ${this.dbName}.v_ebpo_operations_monthly
          WHERE tenant_id = {tenantId:String}
            AND org_id = {orgId:String}
            ${monthWhere}
          GROUP BY name
          ORDER BY sla_pct DESC
        `),
        // Workforce TOTALS over the full selected range (NOT limited to the top-6 rows):
        // distinct headcount, payroll summed over the range, and distinct country count.
        // The cards use these for Total headcount / Total FTE / Countries / percentages so
        // they never understate when there are more than 6 departments or countries.
        runJson(`
          SELECT
            uniqExact(payroll.employee_key) AS headcount,
            round(sum(payroll.total_payroll_usd), 2) AS payroll,
            uniqExact(nullIf(payroll.country, '')) AS countries
          FROM ${this.dbName}.ebpo_fact_payroll payroll
          INNER JOIN ${this.dbName}.ebpo_dim_date dates
            ON dates.tenant_id = payroll.tenant_id
           AND dates.org_id = payroll.org_id
           AND dates.date_key = payroll.date_key
          WHERE payroll.tenant_id = {tenantId:String}
            AND payroll.org_id = {orgId:String}
            ${factDateWhere}
        `),
        // Roster-only employees: on the master list but with NO payroll rows anywhere.
        // Counted into headcount on the all-time view so it matches the true roster.
        runJson(`
          SELECT
            coalesce(nullIf(department, ''), 'Unassigned') AS name,
            coalesce(nullIf(country, ''), 'Unassigned') AS country,
            count() AS cnt
          FROM ${this.dbName}.ebpo_dim_employee dim
          WHERE dim.tenant_id = {tenantId:String}
            AND dim.org_id = {orgId:String}
            AND dim.employee_key NOT IN (
              SELECT employee_key FROM ${this.dbName}.ebpo_fact_payroll
              WHERE tenant_id = {tenantId:String} AND org_id = {orgId:String}
            )
          GROUP BY name, country
        `),
      ]);

      const labels = ['businessUnits', 'costElements', 'headcountByDepartment', 'headcountByGeography', 'deliveryCenters', 'workforceTotals', 'rosterOnly'];
      [buRes, payrollRes, deptRes, geoRes, dcRes, workforceTotalsRes, rosterOnlyRes].forEach((r, i) => {
        if (r.status === 'rejected') {
          this.logger.warn(`[FinancialData] EBPO breakdown "${labels[i]}" query failed: ${r.reason?.message ?? r.reason}`);
        }
      });

      const businessUnits: EbpoBusinessUnitRow[] =
        buRes.status === 'fulfilled'
          ? buRes.value.map((r) => ({
              name: String(r.name ?? 'Unassigned'),
              revenue: parseFloat(r.revenue_usd) || 0,
              cost: parseFloat(r.cost_usd) || 0,
              marginPct: parseFloat(r.margin_pct) || 0,
            }))
          : [];

      // NOTE: the COGS "Total Cost" line (FactRevenue[CostUSD]) was intentionally removed
      // from this breakdown — it duplicated/clashed with the card's "TOTAL COST" footer and
      // mixed a revenue-cost figure into what is otherwise the payroll composition. The
      // Total Cost measure still surfaces on the Net Margin / cashflow-waterfall views.
      const costElements: EbpoCostElementRow[] = [];
      void deliveryCostUsd;
      if (payrollRes.status === 'fulfilled') {
        const p = payrollRes.value[0] ?? {};
        const push = (name: string, raw: any) => {
          const value = parseFloat(raw) || 0;
          if (value > 0) costElements.push({ name, value: Math.round(value * 100) / 100 });
        };
        push('Base Salary', p.base_salary);
        push('Overtime', p.overtime);
        push('Bonus', p.bonus);
        push('Benefits', p.benefits);
      }
      costElements.sort((a, b) => b.value - a.value);

      // Roster-only (never-paid) employees, aggregated by department and country. Applied
      // ONLY on the all-time view so headcount reconciles to the full roster while shorter
      // ranges stay payroll-driven.
      const rosterOnlyRows = isAllTime && rosterOnlyRes.status === 'fulfilled' ? rosterOnlyRes.value : [];
      const rosterDeptAdds = new Map<string, number>();
      const rosterGeoAdds = new Map<string, number>();
      let rosterOnlyTotal = 0;
      for (const r of rosterOnlyRows) {
        const cnt = parseInt(r.cnt) || 0;
        if (cnt <= 0) continue;
        const dept = String(r.name ?? 'Unassigned');
        const country = String(r.country ?? 'Unassigned');
        rosterDeptAdds.set(dept, (rosterDeptAdds.get(dept) ?? 0) + cnt);
        rosterGeoAdds.set(country, (rosterGeoAdds.get(country) ?? 0) + cnt);
        rosterOnlyTotal += cnt;
      }

      // Full ranked lists (headcount DESC). The bars show the top 6; the smallest
      // team/base is derived from the FULL list so it isn't lost to the top-6 cap
      // (e.g. the 7th country never appears in the bars).
      const allDepartments: EbpoDepartmentRow[] =
        deptRes.status === 'fulfilled'
          ? deptRes.value.map((r) => ({
              name: String(r.name ?? 'Unassigned'),
              headcount: parseInt(r.headcount) || 0,
              payroll: parseFloat(r.payroll) || 0,
            }))
          : [];
      for (const [name, add] of rosterDeptAdds) {
        const row = allDepartments.find((d) => d.name === name);
        if (row) row.headcount += add;
        else allDepartments.push({ name, headcount: add, payroll: 0 });
      }
      allDepartments.sort((a, b) => b.headcount - a.headcount);
      const headcountByDepartment = allDepartments.slice(0, 6);
      const smallestDepartment =
        [...allDepartments].reverse().find((d) => d.headcount > 0) ?? null;

      const allGeographies: EbpoGeographyRow[] =
        geoRes.status === 'fulfilled'
          ? geoRes.value.map((r) => ({
              name: String(r.name ?? 'Unassigned'),
              headcount: parseInt(r.headcount) || 0,
            }))
          : [];
      for (const [name, add] of rosterGeoAdds) {
        const row = allGeographies.find((g) => g.name === name);
        if (row) row.headcount += add;
        else allGeographies.push({ name, headcount: add });
      }
      allGeographies.sort((a, b) => b.headcount - a.headcount);
      const headcountByGeography = allGeographies.slice(0, 6);
      const smallestGeography =
        [...allGeographies].reverse().find((g) => g.headcount > 0) ?? null;

      const opsRows = dcRes.status === 'fulfilled' ? dcRes.value : [];
      const deliveryCenters: EbpoDeliveryCenterRow[] = opsRows.map((r) => ({
        name: String(r.name ?? 'Unassigned'),
        slaPct: parseFloat(r.sla_pct) || 0,
        utilizationPct: parseFloat(r.utilization_pct) || 0,
        csatPct: parseFloat(r.csat_pct) || 0,
        callsHandled: parseInt(r.calls_handled) || 0,
      }));
      // Org-level operations KPIs over the selected range. SLA/util/CSAT/AHT are the mean
      // across delivery centers (each center already averaged over the range → equals the
      // overall period average); tickets are summed (a flow). Sourced from `tickets_resolved`
      // (the only ticket-volume column in the operations view).
      const meanOf = (key: string) => {
        const vals = opsRows.map((r) => parseFloat(r[key])).filter((v) => Number.isFinite(v));
        return vals.length > 0 ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10 : 0;
      };
      const avgSlaPct = meanOf('sla_pct');
      const avgUtilizationPct = meanOf('utilization_pct');
      const avgCsatPct = meanOf('csat_pct');
      const avgHandleTimeMinutes = meanOf('aht_minutes');
      const ticketsResolved = opsRows.reduce((s, r) => s + (parseFloat(r.tickets_resolved) || 0), 0);

      const wt = workforceTotalsRes.status === 'fulfilled' ? (workforceTotalsRes.value[0] ?? {}) : {};
      // Add never-paid roster employees to the total on the all-time view (rosterOnlyTotal is
      // 0 on shorter ranges). Payroll stays fact-sourced; countries reflect the merged geo
      // list so a roster-only employee in a new country is still counted.
      const workforceHeadcount = (parseInt(wt.headcount) || 0) + rosterOnlyTotal;
      const workforcePayroll = parseFloat(wt.payroll) || 0;
      const workforceCountries = Math.max(
        parseInt(wt.countries) || 0,
        allGeographies.filter((g) => g.headcount > 0 && g.name !== 'Unassigned').length,
      );

      return {
        businessUnits,
        costElements,
        headcountByDepartment,
        headcountByGeography,
        smallestDepartment,
        smallestGeography,
        deliveryCenters,
        avgSlaPct,
        avgUtilizationPct,
        avgCsatPct,
        avgHandleTimeMinutes,
        ticketsResolved,
        workforceHeadcount,
        workforcePayroll,
        workforceCountries,
      };
    } catch (error: any) {
      this.logger.warn(`[FinancialData] EBPO breakdowns failed: ${error.message}`);
      return empty;
    }
  }

  private async getEbpoMonthlyKpiTrend(tenantId: string, orgId: string, range?: any): Promise<any[]> {
    const time = this.timeWhere(range, 'period_date', this.ebpoLatestAnchor());
    const result = await this.clickhouse.query({
      query: `
        SELECT
          toStartOfMonth(period_date) AS month,
          'ebpo' AS provider,
          org_id,
          any(org_name) AS org_name,
          round(sum(total_revenue_usd), 2) AS revenue,
          round(sum(total_cost_usd + total_payroll_usd), 2) AS expenses,
          0 AS invoice_count,
          'USD' AS currency
        FROM (
          SELECT
            period_date,
            org_id,
            org_name,
            total_revenue_usd,
            total_cost_usd,
            total_payroll_usd
          FROM ${this.dbName}.v_ebpo_kpi_monthly
          WHERE tenant_id = {tenantId:String}
            AND org_id = {orgId:String}
            ${time}
        ) monthly_kpis
        GROUP BY month, org_id
        ORDER BY month ASC
      `,
      query_params: { tenantId, orgId },
      format: 'JSONEachRow',
      clickhouse_settings: SAFE_QUERY_SETTINGS,
    });
    return (await result.json()) as any[];
  }

  async getMonthlyRevenueTrend(tenantId: string, range?: any): Promise<any[]> {
    try {
      const activeConns = await prisma.erpConnection.findMany({
        where: { organizationId: tenantId, status: 'ACTIVE' },
        select: { externalOrganizationId: true, metadata: true },
      });
      const activeOrgIds = activeConns.map((c) => c.externalOrganizationId);
      if (activeOrgIds.length === 0) return [];

      // Route to GL-based trend for sample orgs
      if (this.isSampleGLOrg(activeConns)) {
        return this.getSampleGLMonthlyRevenue(tenantId, activeOrgIds[0]);
      }

      if (this.isEbpoOrg(activeConns)) {
        return this.getEbpoMonthlyKpiTrend(tenantId, activeOrgIds[0], range);
      }

      const time = this.timeWhere(range, 'issued_at');
      const result = await this.clickhouse.query({
        query: `
          SELECT
            toStartOfMonth(issued_at) as month,
            provider,
            org_id,
            org_name,
            sum(total_amount) as revenue,
            count(*) as invoice_count,
            any(currency) as currency
          FROM ${this.dbName}.fact_accounting_invoices
          WHERE tenant_id = {tenantId:String}
            AND org_id IN ({activeOrgIds:Array(String)})
            ${time}
          GROUP BY month, provider, org_id, org_name
          ORDER BY month ASC
          LIMIT 500
        `,
        query_params: { tenantId, activeOrgIds },
        format: 'JSONEachRow',
        clickhouse_settings: SAFE_QUERY_SETTINGS,
      });
      return await result.json();
    } catch (e: any) {
      this.logger.error(
        `[FinancialData] Monthly trend query failed: ${e.message}`,
      );
      return [];
    }
  }
  /**
   * Invoice List — Gold Layer only
   */
  async getInvoicesList(tenantId: string): Promise<any[]> {
    try {
      const activeConns = await prisma.erpConnection.findMany({
        where: { organizationId: tenantId, status: 'ACTIVE' },
        select: { externalOrganizationId: true },
      });
      const activeOrgIds = activeConns.map((c) => c.externalOrganizationId);
      if (activeOrgIds.length === 0) return [];

      const result = await this.clickhouse.query({
        query: `
          SELECT
            invoice_number,
            org_name,
            total_amount as amount,
            currency,
            status,
            issued_at as date
          FROM ${this.dbName}.fact_accounting_invoices
          WHERE tenant_id = {tenantId:String}
            AND org_id IN ({activeOrgIds:Array(String)})
          ORDER BY issued_at DESC
          LIMIT 50
        `,
        query_params: { tenantId, activeOrgIds },
        format: 'JSONEachRow',
        clickhouse_settings: SAFE_QUERY_SETTINGS,
      });
      return await result.json();
    } catch (e: any) {
      this.logger.error(
        `[FinancialData] Invoices list query failed: ${e.message}`,
      );
      return [];
    }
  }

  /**
   * Invoice Payment Delays (DSO-style) — Invoice-level days-to-pay for a specific client/contact.
   *
   * For Xero, "paid_at" is derived from the latest Payment.date applied to the invoice
   * in the raw table (`xero_raw`, resource = 'Payments').
   *
   * NOTE: This intentionally uses raw payments because Gold invoices do not currently
   * materialize a paid_at / fullyPaidOnDate column.
   */
  async getInvoicePaymentDelaysByContactName(
    tenantId: string,
    contactName: string,
    options?: { limit?: number; includeUnpaid?: boolean },
  ): Promise<
    Array<{
      invoiceId: string;
      invoiceNumber: string;
      orgName: string;
      contactName: string;
      status: string;
      currency: string;
      amount: number;
      invoiceDate: string | null;
      paidDate: string | null;
      daysToPay: number | null;
    }>
  > {
    const limit = Math.min(Math.max(options?.limit ?? 200, 1), 1000);
    const includeUnpaid = options?.includeUnpaid ?? false;

    try {
      const activeConns = await prisma.erpConnection.findMany({
        where: { organizationId: tenantId, status: 'ACTIVE' },
        select: { externalOrganizationId: true },
      });
      const activeOrgIds = activeConns.map((c) => c.externalOrganizationId);
      if (activeOrgIds.length === 0) return [];

      const xeroDb = process.env.CLICKHOUSE_XERO_DB || 'xero_custom';

      // We currently support invoice paid-date derivation for Xero only.
      // If the tenant has non-Xero invoices with the same contact name, they will not be included.
      const result = await this.clickhouse.query({
        query: `
          WITH payments AS (
            SELECT
              JSONExtractString(raw_data, 'invoice', 'invoiceID') AS invoice_external_id,
              max(parseDateTimeBestEffortOrNull(JSONExtractString(raw_data, 'date'))) AS paid_at
            FROM ${xeroDb}.xero_raw
            WHERE tenant_id = {tenantId:String}
              AND org_id IN ({activeOrgIds:Array(String)})
              AND resource = 'Payments'
            GROUP BY invoice_external_id
          )
          SELECT
            i.invoice_id                                            AS invoice_id,
            i.invoice_number                                        AS invoice_number,
            i.org_name                                              AS org_name,
            i.contact_name                                          AS contact_name,
            i.status                                                AS status,
            i.currency                                              AS currency,
            toFloat64(i.total_amount)                               AS amount,
            ifNull(toString(i.issued_at), '')                       AS issued_at,
            ifNull(toString(p.paid_at), '')                         AS paid_at,
            if(
              (p.paid_at IS NULL) OR (i.issued_at IS NULL),
              NULL,
              dateDiff('day', toDate(i.issued_at), toDate(p.paid_at))
            )                                                       AS days_to_pay
          FROM ${this.dbName}.fact_accounting_invoices i
          LEFT JOIN payments p ON p.invoice_external_id = i.invoice_external_id
          WHERE i.tenant_id = {tenantId:String}
            AND i.org_id IN ({activeOrgIds:Array(String)})
            AND i.provider = 'xero'
            AND positionCaseInsensitiveUTF8(i.contact_name, {contactName:String}) > 0
            ${includeUnpaid ? '' : 'AND p.paid_at IS NOT NULL'}
          ORDER BY i.issued_at DESC
          LIMIT {limit:UInt32}
        `,
        query_params: { tenantId, activeOrgIds, contactName, limit },
        format: 'JSONEachRow',
        clickhouse_settings: SAFE_QUERY_SETTINGS,
      });

      const rows: any[] = await result.json();
      return rows.map((r) => ({
        invoiceId: String(r.invoice_id ?? ''),
        invoiceNumber: String(r.invoice_number ?? ''),
        orgName: String(r.org_name ?? ''),
        contactName: String(r.contact_name ?? ''),
        status: String(r.status ?? ''),
        currency: String(r.currency ?? ''),
        amount: Number(r.amount ?? 0),
        invoiceDate: r.issued_at ? String(r.issued_at) : null,
        paidDate: r.paid_at ? String(r.paid_at) : null,
        daysToPay:
          r.days_to_pay === null || r.days_to_pay === undefined
            ? null
            : Number(r.days_to_pay),
      }));
    } catch (e: any) {
      this.logger.error(
        `[FinancialData] Invoice payment delays query failed: ${e.message}`,
      );
      return [];
    }
  }

  /**
   * Venture Intelligence — Burn, Runway, and Efficiency.
   * Superior to ChartMogul by factoring in actual accounting outflows, not just MRR.
   */
  async getVentureMetrics(
    tenantId: string,
    activeOrgIds: string[],
  ): Promise<VentureMetrics> {
    try {
      const [burnResult, cashResult] = await Promise.all([
        this.clickhouse.query({
          query: `
            SELECT coalesce(avg(outflow), 0) as avg_burn_rate
            FROM (
              SELECT
                toStartOfMonth(issued_at) as month,
                sum(abs(total_amount)) as outflow
              FROM ${this.dbName}.fact_accounting_invoices
              WHERE tenant_id = {tenantId:String}
                AND org_id IN ({activeOrgIds:Array(String)})
                AND status IN ('PAID', 'AUTHORISED', 'Paid', 'Closed')
                AND total_amount < 0
              GROUP BY month
              ORDER BY month DESC
              LIMIT 3
            )
          `,
          query_params: { tenantId, activeOrgIds },
          format: 'JSONEachRow',
          clickhouse_settings: SAFE_QUERY_SETTINGS,
        }),
        this.clickhouse.query({
          query: `
            SELECT coalesce(sum(JSONExtractFloat(raw_data, 'amount')), 0) as current_cash
            FROM ${process.env.CLICKHOUSE_XERO_DB || 'xero_custom'}.xero_raw
            WHERE tenant_id = {tenantId:String}
              AND resource = 'BankTransfers'
          `,
          query_params: { tenantId },
          format: 'JSONEachRow',
          clickhouse_settings: SAFE_QUERY_SETTINGS,
        }),
      ]);

      const burnRows: any[] = await burnResult.json();
      const cashRows: any[] = await cashResult.json();
      const r = {
        avg_burn_rate: burnRows[0]?.avg_burn_rate ?? 0,
        current_cash: cashRows[0]?.current_cash ?? 0,
      };

      const burnRate = parseFloat(r.avg_burn_rate);
      const cash = parseFloat(r.current_cash);
      const runway = burnRate > 0 ? cash / burnRate : 99; // 99 as infinity proxy

      return {
        burnRate: Math.round(burnRate),
        runwayMonths: Math.round(runway * 10) / 10,
        cashOnHand: Math.round(cash),
        efficiencyMultiplier:
          burnRate > 0 ? Math.round((cash / burnRate) * 100) / 100 : 0,
      };
    } catch {
      return {
        burnRate: 0,
        runwayMonths: 0,
        cashOnHand: 0,
        efficiencyMultiplier: 0,
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // GL-BASED SAMPLE DATA QUERIES
  // Used when the ERP connection metadata has { source: "sample_gl_v2" }.
  // Queries analytics.sample_gl_dump + analytics.sample_trial_balance instead of
  // the invoice-centric Gold Layer tables.
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Full financial profile built from GL tables (sample org path).
   * Mirrors the Power BI DAX measures exactly:
   *   Revenue   = ABS(SUM(net_balance)) WHERE account_type = 'Income'
   *   Expenses  = SUM(net_balance)      WHERE account_type = 'Expense'
   *   COGS      = SUM(net_balance)      WHERE account_type = 'Cost of Goods Sold'
   *   Cash      = SUM(net_balance)      WHERE account_type = 'Bank'
   */
  private async getSampleGLProfile(
    tenantId: string,
    activeConns: Array<{ externalOrganizationId: string; provider: string; metadata: any }>,
  ): Promise<FinancialProfile> {
    const orgId   = activeConns[0]?.externalOrganizationId ?? '';
    const orgName = (activeConns[0]?.metadata as any)?.orgName ?? 'Sample Company 2024';

    const [tbMetrics, monthlyTrend, deptBreakdown] = await Promise.all([
      this.getSampleTrialBalanceMetrics(tenantId, orgId),
      this.getSampleMonthlyTrend(tenantId, orgId),
      this.getSampleDeptBreakdown(tenantId, orgId),
    ]);

    this.logger.log(`[GL] tbMetrics = ${JSON.stringify(tbMetrics)}`);

    const revenue      = tbMetrics.revenue;
    const expenses     = tbMetrics.expenses;
    const cogs         = tbMetrics.cogs;
    const cash         = tbMetrics.cash;
    const netProfit    = revenue - expenses;
    const profitMargin = revenue > 0 ? Math.round((netProfit / revenue) * 10000) / 100 : 0;
    const runway       = expenses > 0 ? Math.round((cash / (expenses / 12)) * 10) / 10 : 99;

    return {
      tenantId,
      revenue: {
        totalRevenue:    revenue,
        avgInvoiceValue: 0,
        totalInvoices:   0,
        minInvoice:      0,
        maxInvoice:      0,
        providerCount:   1,
        orgCount:        1,
        currencyCount:   1,
      },
      expenses: {
        totalExpenses: expenses,
        totalBills:    0,
        overdueAmount: 0,
        overdueCount:  0,
      },
      netProfit,
      profitMargin,
      invoiceStats: { byStatusAndOrg: [] },
      accountSummary: { byTypeAndOrg: [] },
      connectedOrgs: [{
        provider:     'sample',
        orgId,
        orgName,
        invoiceCount: 0,
        totalRevenue: revenue,
        currency:     'USD',
      }],
      budgetSummary: [],
      bankSummary:   { total_transfers: 0, total_volume: cash },
      ventureMetrics: {
        burnRate:             Math.round(expenses / 12),
        runwayMonths:         runway,
        cashOnHand:           cash,
        efficiencyMultiplier: expenses > 0 ? Math.round((revenue / expenses) * 100) / 100 : 0,
      },
      // Attach extra GL fields for the dashboard charts
      glMonthlyTrend:  monthlyTrend,
      glDeptBreakdown: deptBreakdown,
      glCogs:          cogs,
      computedAt: new Date().toISOString(),
    } as any;
  }

  /** KPI aggregates from trial_balance — mirrors Power BI DAX Revenue / Expenses / COGS / Cash */
  private async getSampleTrialBalanceMetrics(tenantId: string, orgId: string) {
    try {
      const res = await this.clickhouse.query({
        query: `
          SELECT
            account_type,
            ABS(sum(net_balance)) as total
          FROM ${this.dbName}.sample_trial_balance
          WHERE tenant_id = {tenantId:String}
            AND org_id    = {orgId:String}
          GROUP BY account_type
        `,
        query_params: { tenantId, orgId },
        format: 'JSONEachRow',
        clickhouse_settings: SAFE_QUERY_SETTINGS,
      });
      const rows: any[] = await res.json();
      const get = (type: string) => parseFloat(rows.find((r: any) => r.account_type === type)?.total ?? 0) || 0;

      return {
        revenue:  get('Income'),
        expenses: get('Expense'),
        cogs:     get('Cost of Goods Sold'),
        cash:     get('Bank'),
        ar:       get('Accounts Receivable'),
        ap:       get('Accounts Payable'),
      };
    } catch (e: any) {
      this.logger.error(`[GL] Trial balance query failed: ${e.message}`);
      return { revenue: 0, expenses: 0, cogs: 0, cash: 0, ar: 0, ap: 0 };
    }
  }

  /** Monthly spend trend from GL transactions — mirrors Power BI Monthly Spend chart */
  private async getSampleMonthlyTrend(tenantId: string, orgId: string): Promise<any[]> {
    try {
      const res = await this.clickhouse.query({
        query: `
          SELECT
            toStartOfMonth(date) AS month,
            department,
            sum(debit) AS debit_total,
            sum(credit) AS credit_total,
            count(*) AS tx_count
          FROM ${this.dbName}.sample_gl_dump
          WHERE tenant_id = {tenantId:String}
            AND org_id    = {orgId:String}
            AND date IS NOT NULL
          GROUP BY month, department
          ORDER BY month ASC, department ASC
        `,
        query_params: { tenantId, orgId },
        format: 'JSONEachRow',
        clickhouse_settings: SAFE_QUERY_SETTINGS,
      });
      const rows: any[] = await res.json();
      return rows.map((r) => ({
        month:      (r.month ?? '').slice(0, 7),
        department: r.department,
        debit:      parseFloat(r.debit_total)  || 0,
        credit:     parseFloat(r.credit_total) || 0,
        txCount:    parseInt(r.tx_count)       || 0,
      }));
    } catch (e: any) {
      this.logger.error(`[GL] Monthly trend query failed: ${e.message}`);
      return [];
    }
  }

  /** Department spend breakdown — mirrors Power BI Spend by Department donut */
  private async getSampleDeptBreakdown(tenantId: string, orgId: string): Promise<any[]> {
    try {
      const res = await this.clickhouse.query({
        query: `
          SELECT
            department,
            sum(debit) AS total_spend
          FROM ${this.dbName}.sample_gl_dump
          WHERE tenant_id = {tenantId:String}
            AND org_id    = {orgId:String}
            AND account_type = 'Expense'
            AND department != ''
          GROUP BY department
          ORDER BY total_spend DESC
        `,
        query_params: { tenantId, orgId },
        format: 'JSONEachRow',
        clickhouse_settings: SAFE_QUERY_SETTINGS,
      });
      const rows: any[] = await res.json();
      return rows.map((r) => ({
        department: r.department,
        totalSpend: parseFloat(r.total_spend) || 0,
      }));
    } catch (e: any) {
      this.logger.error(`[GL] Dept breakdown query failed: ${e.message}`);
      return [];
    }
  }

  /**
   * Monthly revenue trend for sample GL org — uses credit amounts where account_type = 'Income'.
   * Called by getMonthlyRevenueTrend() when the org is a sample GL org.
   */
  private async getSampleGLMonthlyRevenue(tenantId: string, orgId: string): Promise<any[]> {
    try {
      const res = await this.clickhouse.query({
        query: `
          SELECT
            toStartOfMonth(date)    AS month,
            ABS(sum(credit - debit)) AS revenue,
            count(*)                AS invoice_count
          FROM ${this.dbName}.sample_gl_dump
          WHERE tenant_id = {tenantId:String}
            AND org_id    = {orgId:String}
            AND date IS NOT NULL
            AND account_number IN (
              SELECT account_number
              FROM ${this.dbName}.sample_trial_balance
              WHERE tenant_id  = {tenantId:String}
                AND org_id     = {orgId:String}
                AND account_type = 'Income'
            )
          GROUP BY month
          ORDER BY month ASC
        `,
        query_params: { tenantId, orgId },
        format: 'JSONEachRow',
        clickhouse_settings: SAFE_QUERY_SETTINGS,
      });
      const rows: any[] = await res.json();
      return rows.map((r) => ({
        month:         (r.month ?? '').slice(0, 7),
        provider:      'sample',
        org_id:        orgId,
        org_name:      'Sample Company 2024',
        revenue:       String(parseFloat(r.revenue) || 0),
        invoice_count: String(parseInt(r.invoice_count) || 0),
        currency:      'USD',
      }));
    } catch (e: any) {
      this.logger.error(`[GL] Monthly revenue query failed: ${e.message}`);
      return [];
    }
  }
}

// --- Type Definitions ---
export interface ConnectedOrg {
  provider: string;
  orgId: string;
  orgName: string;
  invoiceCount: number;
  totalRevenue: number;
  currency: string;
}

export interface FinancialProfile {
  tenantId: string;
  revenue: RevenueMetrics;
  expenses: ExpenseMetrics;
  netProfit: number;
  profitMargin: number;
  invoiceStats: InvoiceStats;
  accountSummary: AccountSummary;
  connectedOrgs: ConnectedOrg[];
  budgetSummary: any[];
  bankSummary: { total_transfers: number; total_volume: number };
  ventureMetrics: VentureMetrics;
  computedAt: string;
}

export interface VentureMetrics {
  burnRate: number;
  runwayMonths: number;
  cashOnHand: number;
  efficiencyMultiplier: number;
}

export interface ExecutiveInsight {
  id: string;
  title: string;
  description?: string | null;
  type: string;
  createdAt: string;
}

export interface ExecutiveSnapshot {
  mode: 'ebpo';
  orgId: string;
  orgName: string;
  headline: string;
  totalRevenue: number;
  totalCost: number;
  totalPayroll: number;
  grossMargin: number;
  cashBalance: number;
  workingCapital: number;
  freeCashFlow: number;
  operatingCashFlow: number;
  grossMarginPct: number;
  payrollToRevenuePct: number;
  dsoDays: number;
  dpoDays: number;
  operatingCfToRevenuePct: number;
  fcfMarginPct: number;
  ebitdaStyleMarginPct: number;
  cashConversionDays: number;
  slaCompliancePct: number;
  utilizationPct: number;
  csatPct: number;
  arOutstanding: number;
  arLineCount: number;
  apOutstanding: number;
  apLineCount: number;
  overdueAmount: number;
  overdueCount: number;
  topClientName?: string | null;
  topClientRevenue?: number;
  topClientConcentrationPct?: number;
  smallestClientName?: string | null;
  smallestClientRevenue?: number;
  smallestClientConcentrationPct?: number;
  topBusinessUnitName?: string | null;
  topBusinessUnitMarginPct?: number;
  businessUnits: EbpoBusinessUnitRow[];
  costElements: EbpoCostElementRow[];
  headcountByDepartment: EbpoDepartmentRow[];
  headcountByGeography: EbpoGeographyRow[];
  smallestDepartment: EbpoDepartmentRow | null;
  smallestGeography: EbpoGeographyRow | null;
  deliveryCenters: EbpoDeliveryCenterRow[];
  avgHandleTimeMinutes: number;
  ticketsResolved: number;
  workforceHeadcount: number;
  workforcePayroll: number;
  workforceCountries: number;
  cashflowWaterfall: Array<{ name: string; value: number; fill?: string }>;
  insights: ExecutiveInsight[];
}

export interface EbpoBusinessUnitRow {
  name: string;
  revenue: number;
  cost: number;
  marginPct: number;
}
export interface EbpoCostElementRow {
  name: string;
  value: number;
}
export interface EbpoDepartmentRow {
  name: string;
  headcount: number;
  payroll: number;
}
export interface EbpoGeographyRow {
  name: string;
  headcount: number;
}
export interface EbpoDeliveryCenterRow {
  name: string;
  slaPct: number;
  utilizationPct: number;
  csatPct: number;
  callsHandled: number;
}

export interface EbpoBreakdowns {
  businessUnits: EbpoBusinessUnitRow[];
  costElements: EbpoCostElementRow[];
  headcountByDepartment: EbpoDepartmentRow[];
  headcountByGeography: EbpoGeographyRow[];
  /** Smallest team/base by headcount over the full set (not limited to the top-6 bars). */
  smallestDepartment: EbpoDepartmentRow | null;
  smallestGeography: EbpoGeographyRow | null;
  deliveryCenters: EbpoDeliveryCenterRow[];
  /** Range-average SLA / utilization / CSAT across delivery centers (period average). */
  avgSlaPct: number;
  avgUtilizationPct: number;
  avgCsatPct: number;
  /** Range-average handle time (minutes) across delivery centers. */
  avgHandleTimeMinutes: number;
  /** Total tickets resolved over the range across delivery centers. */
  ticketsResolved: number;
  /** Distinct employees active within the selected range (full set, not top-6). */
  workforceHeadcount: number;
  /** Total payroll summed over the selected range. */
  workforcePayroll: number;
  /** Distinct countries with workforce in the selected range. */
  workforceCountries: number;
}

export interface RevenueMetrics {
  totalRevenue: number;
  avgInvoiceValue: number;
  totalInvoices: number;
  minInvoice: number;
  maxInvoice: number;
  providerCount: number;
  orgCount: number;
  currencyCount: number;
}

export interface ExpenseMetrics {
  totalExpenses: number;
  totalBills: number;
  overdueAmount: number;
  overdueCount: number;
}

export interface InvoiceStats {
  byStatusAndOrg: Array<{
    status: string;
    provider: string;
    orgId: string;
    orgName: string;
    count: number;
    totalAmount: number;
  }>;
}

export interface AccountSummary {
  byTypeAndOrg: Array<{
    accountType: string;
    classification: string;
    provider: string;
    orgId: string;
    orgName: string;
    count: number;
  }>;
}
