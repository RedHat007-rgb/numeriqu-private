import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import type { PrismaClient } from '@repo/db';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { CurrentUser } from '../../common/decorators/user.decorator';
import type { AuthUser } from '../../common/decorators/user.decorator';
import { OrganizationContextService } from '../org-context/org-context.service';
import { FinancialDataService } from '../../financial-data/financial-data.service';
import { PRISMA_TOKEN } from '../../database/database.module';

@Controller('analytics')
@UseGuards(SupabaseAuthGuard)
export class AnalyticsController {
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly organizationContext: OrganizationContextService,
    private readonly financialData: FinancialDataService,
  ) {}

  @Get('insights')
  async insights(@CurrentUser() user: AuthUser) {
    const context = await this.organizationContext.ensureContext({
      id: user.id,
      email: user.email,
    });

    const dashboards = await this.prisma.dashboard.findMany({
      where: { organizationId: context.organization.id, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, title: true, description: true, createdAt: true },
    });

    return dashboards.map((d) => ({
      id: d.id,
      title: d.title,
      description: d.description,
      type: 'dashboard',
      createdAt: d.createdAt.toISOString(),
    }));
  }

  @Get('dashboard')
  async dashboard(@CurrentUser() user: AuthUser) {
    const startedAt = Date.now();
    const context = await this.organizationContext.ensureContext({
      id: user.id,
      email: user.email,
    });
    const organizationId = context.organization.id;

    const [profile, monthlyTrend] = await Promise.all([
      this.financialData.getFinancialProfile(organizationId),
      this.financialData.getMonthlyRevenueTrend(organizationId),
    ]);

    // Build Recharts-ready monthly trend
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
        expenses: 0,
        invoices: data.invoices,
      }));

    const orgBreakdown = (profile.connectedOrgs || []).map((org) => ({
      name: org.orgName,
      value: Math.round(org.totalRevenue),
      provider: org.provider,
      invoiceCount: org.invoiceCount ?? 0,
      currency: org.currency ?? 'USD',
    }));

    const totalRevenue = profile.revenue?.totalRevenue ?? 0;
    const totalExpenses = profile.expenses?.totalExpenses ?? 0;
    const netProfit = totalRevenue - totalExpenses;
    const profitMargin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;
    const totalInvoices = profile.revenue?.totalInvoices ?? 0;
    const avgInvoiceValue = profile.revenue?.avgInvoiceValue ?? 0;
    const overdueAmount = profile.expenses?.overdueAmount ?? 0;
    const overdueCount = profile.expenses?.overdueCount ?? 0;

    return {
      kpis: {
        totalRevenue,
        totalExpenses,
        netProfit,
        profitMargin,
        totalInvoices,
        avgInvoiceValue,
        overdueAmount,
        overdueCount,
        orgCount: orgBreakdown.length,
        providerCount: new Set(orgBreakdown.map((o) => o.provider)).size,
      },
      venture: {
        burnRate: profile.ventureMetrics?.burnRate ?? 0,
        runwayMonths: profile.ventureMetrics?.runwayMonths ?? 0,
        cashOnHand: profile.ventureMetrics?.cashOnHand ?? netProfit,
        efficiencyMultiplier: profile.ventureMetrics?.efficiencyMultiplier ?? 0,
      },
      charts: {
        monthlyTrend: monthlyChart,
        orgBreakdown,
        invoiceStatus: (profile.invoiceStats?.byStatusAndOrg ?? []).map((row) => ({
          name: row.status,
          count: row.count,
          amount: row.totalAmount,
        })),
        cashflowWaterfall: [
          { name: 'Revenue', value: totalRevenue, fill: '#00F5D4' },
          { name: 'Expenses', value: -totalExpenses, fill: '#FF6B6B' },
          { name: 'Net Profit', value: netProfit, fill: netProfit >= 0 ? '#00F5D4' : '#FF6B6B' },
        ],
      },
      connectedOrgs: orgBreakdown,
      insights: [],
      meta: {
        computedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
      },
    };
  }
}
