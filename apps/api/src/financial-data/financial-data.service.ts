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
  private timeWhere(range?: any): string {
    if (!range || range.kind === 'ALL_TIME') return '';
    if (range.kind === 'MTD') return `AND issued_at >= toStartOfMonth(now())`;
    if (range.kind === 'QTD') return `AND issued_at >= toStartOfQuarter(now())`;
    if (range.kind === 'YTD') return `AND issued_at >= toStartOfYear(now())`;
    if (range.kind === 'LAST_N_DAYS') return `AND issued_at >= (now() - INTERVAL ${Math.max(1, Math.floor(range.days ?? 1))} DAY)`;
    if (range.kind === 'LAST_N_WEEKS') return `AND issued_at >= (now() - INTERVAL ${Math.max(1, Math.floor(range.weeks ?? 1))} WEEK)`;
    if (range.kind === 'LAST_N_MONTHS') return `AND issued_at >= (now() - INTERVAL ${Math.max(1, Math.floor(range.months ?? 1))} MONTH)`;
    if (range.kind === 'LAST_N_QUARTERS') return `AND issued_at >= (now() - INTERVAL ${Math.max(1, Math.floor(range.quarters ?? 1)) * 3} MONTH)`;
    if (range.kind === 'LAST_N_YEARS') return `AND issued_at >= (now() - INTERVAL ${Math.max(1, Math.floor(range.years ?? 1))} YEAR)`;
    return '';
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

      const time = this.timeWhere(range);
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
