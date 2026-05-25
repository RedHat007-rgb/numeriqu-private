import { Controller, Get, Headers, Inject, UseGuards, Query } from '@nestjs/common';
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
  async insights(
    @CurrentUser() user: AuthUser,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.organizationContext.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );

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
  async dashboard(
    @CurrentUser() user: AuthUser,
    @Query('rangeKind') rangeKind?: string,
    @Query('rangeValue') rangeValue?: string,
    @Headers('x-organization-id') orgHeader?: string,
  ) {
    const startedAt = Date.now();
    const context = await this.organizationContext.ensureContext(
      { id: user.id, email: user.email },
      { organizationId: orgHeader },
    );
    const organizationId = context.organization.id;

    const range = (() => {
      if (!rangeKind) return null;
      const kind = String(rangeKind);
      const n = rangeValue ? Number(rangeValue) : undefined;
      if (kind === 'LAST_N_DAYS' && Number.isFinite(n)) return { kind, days: n as number };
      if (kind === 'LAST_N_WEEKS' && Number.isFinite(n)) return { kind, weeks: n as number };
      if (kind === 'LAST_N_MONTHS' && Number.isFinite(n)) return { kind, months: n as number };
      if (kind === 'LAST_N_QUARTERS' && Number.isFinite(n)) return { kind, quarters: n as number };
      if (kind === 'LAST_N_YEARS' && Number.isFinite(n)) return { kind, years: n as number };
      if (kind === 'ALL_TIME' || kind === 'MTD' || kind === 'QTD' || kind === 'YTD') return { kind };
      return null;
    })();

    const [profile, monthlyTrend] = await Promise.all([
      this.financialData.getFinancialProfile(organizationId),
      this.financialData.getMonthlyRevenueTrend(organizationId, range as any),
    ]);

    // Build Recharts-ready monthly trend (range-filtered server-side)
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

    // Org breakdown for the selected range, derived from the same trend rows.
    const orgMap = new Map<string, { name: string; provider: string; currency: string; revenue: number; invoices: number }>();
    for (const row of monthlyTrend) {
      const orgId = String(row.org_id ?? row.orgId ?? '');
      const key = orgId || String(row.org_name ?? row.orgName ?? '');
      if (!key) continue;
      const existing = orgMap.get(key) || {
        name: String(row.org_name ?? row.orgName ?? key),
        provider: String(row.provider ?? 'UNKNOWN'),
        currency: String(row.currency ?? 'USD'),
        revenue: 0,
        invoices: 0,
      };
      existing.revenue += Math.abs(parseFloat(row.revenue) || 0);
      existing.invoices += parseInt(row.invoice_count) || 0;
      orgMap.set(key, existing);
    }

    const orgBreakdown = Array.from(orgMap.values())
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 12)
      .map((org) => ({
        name: org.name,
        value: Math.round(org.revenue),
        provider: org.provider,
        invoiceCount: org.invoices,
        currency: org.currency,
      }));

    const chartRevenue = monthlyChart.reduce((s, m) => s + (m.revenue || 0), 0);
    // profile.revenue.totalRevenue is authoritative (from GL trial balance for sample orgs,
    // from invoice aggregation for real orgs). Fall back to chart sum only if profile has none.
    const totalRevenue = profile.revenue.totalRevenue > 0 ? profile.revenue.totalRevenue : chartRevenue;
    const chartInvoices = monthlyChart.reduce((s, m) => s + (m.invoices || 0), 0);
    const totalInvoices = profile.revenue.totalInvoices > 0 ? profile.revenue.totalInvoices : chartInvoices;
    const avgInvoiceValue = profile.revenue.avgInvoiceValue > 0
      ? profile.revenue.avgInvoiceValue
      : (totalInvoices > 0 ? totalRevenue / totalInvoices : 0);

    // Note: This repo does not yet have a verified expense/bills gold model.
    // We surface open invoice exposure separately so the UI can label it accurately.
    const openInvoiceAmount = profile.expenses?.totalExpenses ?? 0;
    const openInvoiceCount = profile.expenses?.totalBills ?? 0;

    const overdueAmount = profile.expenses?.overdueAmount ?? 0;
    const overdueCount = profile.expenses?.overdueCount ?? 0;

    return {
      kpis: {
        totalRevenue,
        totalExpenses: openInvoiceAmount,
        netProfit: 0,
        profitMargin: 0,
        totalInvoices,
        avgInvoiceValue,
        openInvoiceAmount,
        openInvoiceCount,
        overdueAmount,
        overdueCount,
        orgCount: orgBreakdown.length,
        providerCount: new Set(orgBreakdown.map((o) => o.provider)).size,
      },
      venture: {
        burnRate: profile.ventureMetrics?.burnRate ?? 0,
        runwayMonths: profile.ventureMetrics?.runwayMonths ?? 0,
        cashOnHand: profile.ventureMetrics?.cashOnHand ?? 0,
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
        cashflowWaterfall: [],
      },
      connectedOrgs: orgBreakdown,
      insights: [],
      meta: {
        computedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        range: range ?? { kind: 'ALL_TIME' },
      },
    };
  }
}
