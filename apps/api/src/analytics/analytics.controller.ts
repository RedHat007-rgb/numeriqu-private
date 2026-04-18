import { Controller, Get, Post, Body, Param, Query, Patch, Delete, UseGuards, Logger, Inject } from '@nestjs/common';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import type { AuthUser } from '../common/decorators/user.decorator';
import { UserProvisioningService } from '../common/services/user-provisioning.service';
import { FinancialDataService } from '../financial-data/financial-data.service';
import { PRISMA_TOKEN } from '../database/database.module';
import type { PrismaClient } from '@repo/db';

/**
 * AnalyticsController — The "Financial Intelligence Gallery"
 *
 * Manages AI-generated visualizations and provides chart-ready data endpoints
 * for the executive dashboard. Every endpoint returns data pre-formatted
 * for Recharts so the frontend has zero transformation overhead.
 */
@Controller('analytics')
@UseGuards(SupabaseAuthGuard)
export class AnalyticsController {
  private readonly logger = new Logger(AnalyticsController.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly provisioning: UserProvisioningService,
    private readonly financialData: FinancialDataService,
  ) {}

  // ─── INSIGHT CRUD ──────────────────────────────────────────────────────────

  /**
   * GET /analytics/insights — List all saved/pinned insights for the tenant.
   */
  @Get('insights')
  async getInsights(@CurrentUser() user: AuthUser) {
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);
    
    // Fetch legacy individual charts
    const insights = await this.prisma.insight.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: 'desc' },
    });

    // Fetch orchestrated dashboards
    const dashboards = await this.prisma.dashboard.findMany({
      where: { tenantId: tenant.id, userId: user.id },
      include: { charts: { orderBy: { layoutIndex: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    });

    const mappedDashboards = dashboards.map(d => ({
      id: d.id,
      tenantId: d.tenantId,
      title: d.title,
      description: d.description,
      type: 'dashboard',
      config: { charts: d.charts },
      category: 'strategic',
      pinned: true,
      createdAt: d.createdAt,
    }));

    return [...mappedDashboards, ...insights].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  @Get('insights/:id')
  async getInsight(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);
    return this.prisma.insight.findFirst({ where: { id, tenantId: tenant.id } });
  }

  @Patch('insights/:id')
  async updateInsight(
    @Param('id') id: string,
    @Body() data: { isFavorite?: boolean; pinned?: boolean; title?: string },
    @CurrentUser() user: AuthUser,
  ) {
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);
    return this.prisma.insight.updateMany({ where: { id, tenantId: tenant.id }, data });
  }

  @Delete('insights/:id')
  async deleteInsight(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);
    const delDashboard = await this.prisma.dashboard.deleteMany({ where: { id, tenantId: tenant.id } });
    if (delDashboard.count > 0) return { success: true };
    return this.prisma.insight.deleteMany({ where: { id, tenantId: tenant.id } });
  }

  // ─── EXECUTIVE DASHBOARD DATA ENDPOINTS ────────────────────────────────────

  /**
   * GET /analytics/dashboard — Executive summary KPIs + chart data
   * Returns everything the dashboard needs in a single request (reduces waterfall).
   */
  @Get('dashboard')
  async getDashboard(@CurrentUser() user: AuthUser) {
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);
    const startTime = Date.now();

    try {
      const [profile, monthlyTrend, insights] = await Promise.all([
        this.financialData.getFinancialProfile(tenant.id),
        this.financialData.getMonthlyRevenueTrend(tenant.id),
        this.prisma.insight.findMany({
          where: { tenantId: tenant.id, pinned: true },
          orderBy: { createdAt: 'desc' },
          take: 12,
        }),
      ]);

      // Transform monthly trend into Recharts-ready format
      const trendMap = new Map<string, { revenue: number; expenses: number; invoices: number }>();
      for (const row of monthlyTrend) {
        const month = (row.month ?? '').slice(0, 7);
        const existing = trendMap.get(month) || { revenue: 0, expenses: 0, invoices: 0 };
        existing.revenue += Math.abs(parseFloat(row.revenue) || 0);
        existing.invoices += parseInt(row.invoice_count) || 0;
        trendMap.set(month, existing);
      }

      const monthlyChart = [...trendMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, data]) => ({
          name: month.split('-')[1] + '/' + month.split('-')[0].slice(2),
          month,
          revenue: Math.round(data.revenue),
          expenses: 0, // Will be enriched when expense trend endpoint is added
          invoices: data.invoices,
        }));

      // Revenue by org for donut chart
      const orgBreakdown = (profile.connectedOrgs || []).map(org => ({
        name: org.orgName,
        value: Math.round(org.totalRevenue),
        provider: org.provider,
        invoiceCount: org.invoiceCount,
        currency: org.currency,
      }));

      // Invoice status distribution
      const statusMap = new Map<string, { count: number; amount: number }>();
      for (const stat of (profile.invoiceStats?.byStatusAndOrg || [])) {
        const key = stat.status;
        const existing = statusMap.get(key) || { count: 0, amount: 0 };
        existing.count += stat.count;
        existing.amount += stat.totalAmount;
        statusMap.set(key, existing);
      }
      const invoiceStatusChart = [...statusMap.entries()].map(([status, data]) => ({
        name: status,
        count: data.count,
        amount: Math.round(data.amount),
      }));

      // Cash flow waterfall
      const cashflowWaterfall = [
        { name: 'Revenue', value: Math.round(profile.revenue.totalRevenue), fill: '#00F5D4' },
        { name: 'Expenses', value: -Math.round(profile.expenses.totalExpenses), fill: '#FF6B6B' },
        { name: 'Net Profit', value: Math.round(profile.netProfit), fill: profile.netProfit >= 0 ? '#00F5D4' : '#FF6B6B' },
      ];

      return {
        kpis: {
          totalRevenue: profile.revenue.totalRevenue,
          totalExpenses: profile.expenses.totalExpenses,
          netProfit: profile.netProfit,
          profitMargin: profile.profitMargin,
          totalInvoices: profile.revenue.totalInvoices,
          avgInvoiceValue: profile.revenue.avgInvoiceValue,
          overdueAmount: profile.expenses.overdueAmount,
          overdueCount: profile.expenses.overdueCount,
          orgCount: profile.connectedOrgs?.length || 0,
          providerCount: profile.revenue.providerCount,
        },
        venture: profile.ventureMetrics,
        charts: {
          monthlyTrend: monthlyChart,
          orgBreakdown,
          invoiceStatus: invoiceStatusChart,
          cashflowWaterfall,
        },
        connectedOrgs: profile.connectedOrgs,
        insights,
        meta: {
          computedAt: profile.computedAt,
          latencyMs: Date.now() - startTime,
        },
      };
    } catch (error: any) {
      this.logger.error(`[Dashboard] Failed: ${error.message}`);
      return {
        kpis: {
          totalRevenue: 0, totalExpenses: 0, netProfit: 0, profitMargin: 0,
          totalInvoices: 0, avgInvoiceValue: 0, overdueAmount: 0, overdueCount: 0,
          orgCount: 0, providerCount: 0,
        },
        venture: { burnRate: 0, runwayMonths: 0, cashOnHand: 0, efficiencyMultiplier: 0 },
        charts: { monthlyTrend: [], orgBreakdown: [], invoiceStatus: [], cashflowWaterfall: [] },
        connectedOrgs: [],
        insights: [],
        meta: { computedAt: new Date().toISOString(), latencyMs: Date.now() - startTime, error: 'Data temporarily unavailable' },
      };
    }
  }

  /**
   * GET /analytics/trend — Detailed monthly trend with optional org filter.
   */
  @Get('trend')
  async getTrend(
    @CurrentUser() user: AuthUser,
    @Query('orgId') orgId?: string,
  ) {
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);
    const trend = await this.financialData.getMonthlyRevenueTrend(tenant.id);

    let filtered = trend;
    if (orgId) {
      filtered = trend.filter((t: any) => t.org_id === orgId);
    }

    return filtered.map((t: any) => ({
      name: (t.month ?? '').slice(0, 7).split('-')[1] + '/' + (t.month ?? '').slice(0, 7).split('-')[0].slice(2),
      month: (t.month ?? '').slice(0, 7),
      revenue: Math.abs(parseFloat(t.revenue) || 0),
      invoices: parseInt(t.invoice_count) || 0,
      orgName: t.org_name,
      provider: t.provider,
    }));
  }

  /**
   * GET /analytics/invoices — Recent invoices list for the table view.
   */
  @Get('invoices')
  async getInvoices(@CurrentUser() user: AuthUser) {
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);
    return this.financialData.getInvoicesList(tenant.id);
  }
}
