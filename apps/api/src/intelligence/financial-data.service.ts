import { Injectable, Inject, Logger } from '@nestjs/common';
import { CLICKHOUSE_ANALYTICS_TOKEN } from '../database/database.module';
import { ClickHouseClient } from '@clickhouse/client';
import { prisma } from '@repo/db';

/** Applied to every ClickHouse query — prevents a single aggregation from OOM-killing the server */
const SAFE_QUERY_SETTINGS = {
  max_memory_usage: '536870912', // 512 MB per-query cap (string)
  max_execution_time: 30,        // 30s hard timeout (number)
};

/**
 * FinancialDataService — The "Ground Truth" Engine
 * 
 * Provides deterministic, SQL-computed financial metrics from ClickHouse's Gold Layer.
 * All queries are org-aware: they group by (provider, org_id, org_name) so that
 * multiple Xero orgs / QB companies are always surfaced as distinct dimensions.
 */
@Injectable()
export class FinancialDataService {
  private readonly logger = new Logger(FinancialDataService.name);
  private readonly dbName: string;

  constructor(
    @Inject(CLICKHOUSE_ANALYTICS_TOKEN) private readonly clickhouse: ClickHouseClient,
  ) {
    this.dbName = process.env.CLICKHOUSE_ANALYTICS_DB || 'analytics';
  }

  /**
   * Get the organization-level financial profile for a tenant.
   * This is the "Ground Truth Block" injected into every LLM prompt.
   */
  async getFinancialProfile(tenantId: string): Promise<FinancialProfile> {
    this.logger.log(`[GroundTruth] Building financial profile for tenant=${tenantId}`);

    // SECURE ISOLATION: Fetch strictly verified and active orchestration pipelines.
    const activeConns = await prisma.connection.findMany({
      where: { tenantId, isActive: true },
      select: { providerAccountId: true, provider: true, metadata: true }
    });

    if (activeConns.length === 0) {
      return {
        tenantId,
        revenue: { totalRevenue: 0, avgInvoiceValue: 0, totalInvoices: 0, minInvoice: 0, maxInvoice: 0, providerCount: 0, orgCount: 0, currencyCount: 0 },
        expenses: { totalExpenses: 0, totalBills: 0, overdueAmount: 0, overdueCount: 0 },
        netProfit: 0,
        profitMargin: 0,
        invoiceStats: { byStatusAndOrg: [] },
        accountSummary: { byTypeAndOrg: [] },
        connectedOrgs: [],
        computedAt: new Date().toISOString(),
      };
    }

    const activeOrgIds = activeConns.map((c) => c.providerAccountId);

    const [revenue, expenses, invoiceStats, accountSummary, connectedOrgs] = await Promise.all([
      this.getRevenueMetrics(tenantId, activeOrgIds),
      this.getExpenseMetrics(tenantId, activeOrgIds),
      this.getInvoiceStatistics(tenantId, activeOrgIds),
      this.getAccountSummary(tenantId, activeOrgIds),
      this.getConnectedOrgs(tenantId, activeConns),
    ]);
    
    // Deterministically enforce identity counts bypassing Clickhouse cold-start boundaries
    revenue.orgCount = activeConns.length;
    revenue.providerCount = new Set(activeConns.map((c) => c.provider)).size;

    const netProfit = revenue.totalRevenue - expenses.totalExpenses;
    const profitMargin = revenue.totalRevenue > 0
      ? ((netProfit / revenue.totalRevenue) * 100)
      : 0;

    return {
      tenantId,
      revenue,
      expenses,
      netProfit,
      profitMargin: Math.round(profitMargin * 100) / 100,
      invoiceStats,
      accountSummary,
      connectedOrgs,
      computedAt: new Date().toISOString(),
    };
  }

  /**
   * Connected orgs breakdown — lists every distinct (provider, org) pair that
   * has data in the Gold Layer, along with per-org revenue and invoice count.
   * This is the core fix: surfaces each Xero org and QB company separately.
   */
  async getConnectedOrgs(tenantId: string, activeConns: any[]): Promise<ConnectedOrg[]> {
    const activeOrgIds = activeConns.map((c) => c.providerAccountId);
    if (activeOrgIds.length === 0) return [];

    const orgMap = new Map<string, ConnectedOrg>();
    for (const conn of activeConns) {
      const meta = conn.metadata as Record<string, any> || {};
      orgMap.set(conn.providerAccountId, {
        provider: conn.provider,
        orgId: conn.providerAccountId,
        orgName: meta.orgName || meta.companyId || conn.providerAccountId,
        invoiceCount: 0,
        totalRevenue: 0,
        currency: 'USD'
      });
    }

    try {
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
    } catch (e) {
      this.logger.warn(`[GroundTruth] ConnectedOrgs query failed: ${e}`);
    }

    return Array.from(orgMap.values()).sort((a, b) => b.totalRevenue - a.totalRevenue);
  }

  /**
   * Revenue metrics aggregated from the Gold Layer
   */
  private async getRevenueMetrics(tenantId: string, activeOrgIds: string[]): Promise<RevenueMetrics> {
    try {
      const result = await this.clickhouse.query({
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
            AND status IN ('AUTHORISED', 'PAID', 'Paid', 'Closed', 'NotSet', 'NeedToSend')
        `,
        query_params: { tenantId, activeOrgIds },
        format: 'JSONEachRow',
        clickhouse_settings: SAFE_QUERY_SETTINGS,
      });
      const rows: any[] = await result.json();
      const r = rows[0] || {};
      return {
        totalRevenue: parseFloat(r.total_revenue) || 0,
        avgInvoiceValue: Math.round((parseFloat(r.avg_invoice_value) || 0) * 100) / 100,
        totalInvoices: parseInt(r.total_invoices) || 0,
        minInvoice: parseFloat(r.min_invoice) || 0,
        maxInvoice: parseFloat(r.max_invoice) || 0,
        providerCount: parseInt(r.provider_count) || 0,
        orgCount: parseInt(r.org_count) || 0,
        currencyCount: parseInt(r.currency_count) || 0,
      };
    } catch (e) {
      this.logger.warn(`[GroundTruth] Revenue query failed, returning zeros: ${e}`);
      return { totalRevenue: 0, avgInvoiceValue: 0, totalInvoices: 0, minInvoice: 0, maxInvoice: 0, providerCount: 0, orgCount: 0, currencyCount: 0 };
    }
  }

  /**
   * Expense metrics from overdue / payable invoices
   */
  private async getExpenseMetrics(tenantId: string, activeOrgIds: string[]): Promise<ExpenseMetrics> {
    try {
      const result = await this.clickhouse.query({
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
      const rows: any[] = await result.json();
      const r = rows[0] || {};
      return {
        totalExpenses: parseFloat(r.total_expenses) || 0,
        totalBills: parseInt(r.total_bills) || 0,
        overdueAmount: parseFloat(r.overdue_amount) || 0,
        overdueCount: parseInt(r.overdue_count) || 0,
      };
    } catch (e) {
      this.logger.warn(`[GroundTruth] Expense query failed: ${e}`);
      return { totalExpenses: 0, totalBills: 0, overdueAmount: 0, overdueCount: 0 };
    }
  }

  /**
   * Invoice-level statistics — status distribution, per org breakdown
   */
  private async getInvoiceStatistics(tenantId: string, activeOrgIds: string[]): Promise<InvoiceStats> {
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
        byStatusAndOrg: rows.map(r => ({
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
  private async getAccountSummary(tenantId: string, activeOrgIds: string[]): Promise<AccountSummary> {
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
        byTypeAndOrg: rows.map(r => ({
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
    this.logger.log(`[ScopedQuery] Intent received: ${sqlQuery.slice(0, 50)}...`);
    
    const normalized = sqlQuery.trim().toUpperCase();
    
    if (!normalized.startsWith('SELECT')) {
      throw new Error('Only SELECT queries permitted.');
    }
    const forbidden = ['DROP', 'DELETE', 'INSERT', 'UPDATE', 'ALTER', 'CREATE', 'TRUNCATE'];
    if (forbidden.some(word => normalized.includes(word))) {
      throw new Error('Unsafe SQL keywords detected.');
    }

    let finalQuery = sqlQuery;
    if (!normalized.includes('TENANT_ID')) {
      if (normalized.includes('WHERE')) {
        finalQuery = sqlQuery.replace(/WHERE/i, 'WHERE tenant_id = {tenantId:String} AND ');
      } else if (normalized.includes('GROUP BY') || normalized.includes('ORDER BY')) {
        const keyword = normalized.includes('GROUP BY') ? 'GROUP BY' : 'ORDER BY';
        finalQuery = sqlQuery.replace(new RegExp(keyword, 'i'), `WHERE tenant_id = {tenantId:String} ${keyword}`);
      } else {
        finalQuery = `${sqlQuery} WHERE tenant_id = {tenantId:String}`;
      }
    }

    try {
      const activeConns = await prisma.connection.findMany({
        where: { tenantId, isActive: true },
        select: { providerAccountId: true }
      });
      const activeOrgIds = activeConns.map((c) => c.providerAccountId);
      if (activeOrgIds.length > 0) {
        if (finalQuery.includes('WHERE')) {
          finalQuery = finalQuery.replace(/WHERE/i, 'WHERE org_id IN ({activeOrgIds:Array(String)}) AND ');
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
      this.logger.error(`[ScopedQuery] SQL Error: ${e.message} for query: ${finalQuery}`);
      return [];
    }
  }

  /**
   * Semantic Lookup — Uses ClickHouse tokens to find unstructured context.
   */
  async searchSemanticContext(tenantId: string, terms: string): Promise<any[]> {
    try {
      const activeConns = await prisma.connection.findMany({
        where: { tenantId, isActive: true },
        select: { providerAccountId: true }
      });
      const activeOrgIds = activeConns.map((c) => c.providerAccountId);
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
   * Revenue by month — time series per org for trend analysis
   */
  async getMonthlyRevenueTrend(tenantId: string): Promise<any[]> {
    try {
      const activeConns = await prisma.connection.findMany({
        where: { tenantId, isActive: true },
        select: { providerAccountId: true }
      });
      const activeOrgIds = activeConns.map((c) => c.providerAccountId);
      if (activeOrgIds.length === 0) return [];

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
          GROUP BY month, provider, org_id, org_name
          ORDER BY month ASC
          LIMIT 500
        `,
        query_params: { tenantId, activeOrgIds },
        format: 'JSONEachRow',
        clickhouse_settings: SAFE_QUERY_SETTINGS,
      });
      return await result.json();
    } catch (e) {
      this.logger.warn(`[MonthlyTrend] Failed: ${e}`);
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
  computedAt: string;
}

interface RevenueMetrics {
  totalRevenue: number;
  avgInvoiceValue: number;
  totalInvoices: number;
  minInvoice: number;
  maxInvoice: number;
  providerCount: number;
  orgCount: number;
  currencyCount: number;
}

interface ExpenseMetrics {
  totalExpenses: number;
  totalBills: number;
  overdueAmount: number;
  overdueCount: number;
}

interface InvoiceStats {
  byStatusAndOrg: Array<{
    status: string;
    provider: string;
    orgId: string;
    orgName: string;
    count: number;
    totalAmount: number;
  }>;
}

interface AccountSummary {
  byTypeAndOrg: Array<{
    accountType: string;
    classification: string;
    provider: string;
    orgId: string;
    orgName: string;
    count: number;
  }>;
}
