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

    const [profile, monthlyTrend, executive] = await Promise.all([
      this.financialData.getFinancialProfile(organizationId),
      this.financialData.getMonthlyRevenueTrend(organizationId, range as any),
      this.financialData.getExecutiveSnapshot(organizationId, range as any),
    ]);

    // Build Recharts-ready monthly trend (range-filtered server-side)
    const trendMap = new Map<string, { revenue: number; expenses: number; invoices: number }>();
    for (const row of monthlyTrend) {
      const month = (row.month ?? '').slice(0, 7);
      const existing = trendMap.get(month) || { revenue: 0, expenses: 0, invoices: 0 };
      existing.revenue += Math.abs(parseFloat(row.revenue) || 0);
      existing.expenses += Math.abs(parseFloat(row.expenses ?? row.total_cost ?? 0) || 0);
      existing.invoices += parseInt(row.invoice_count) || 0;
      trendMap.set(month, existing);
    }

    const monthlyChart = [...trendMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, data]) => ({
        name: month.split('-')[1] + '/' + month.split('-')[0].slice(2),
        month,
        revenue: Math.round(data.revenue),
        expenses: Math.round(data.expenses),
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

    const rangeRevenueByOrg = new Map(
      Array.from(orgMap.entries()).map(([orgId, org]) => [
        orgId,
        {
          revenue: Math.round(org.revenue),
          invoices: org.invoices,
          currency: org.currency,
        },
      ]),
    );

    const connectedOrgs =
      (profile.connectedOrgs ?? []).length > 0
        ? (profile.connectedOrgs ?? [])
            .map((org) => {
              const rangeScoped = rangeRevenueByOrg.get(org.orgId);
              return {
                orgName: org.orgName,
                provider: org.provider,
                totalRevenue: rangeScoped?.revenue ?? Math.round(org.totalRevenue),
                invoiceCount: rangeScoped?.invoices ?? org.invoiceCount,
                currency: rangeScoped?.currency ?? org.currency,
              };
            })
            .sort((a, b) => b.totalRevenue - a.totalRevenue || b.invoiceCount - a.invoiceCount)
        : orgBreakdown.map((org) => ({
            orgName: org.name,
            provider: org.provider ?? 'UNKNOWN',
            totalRevenue: org.value,
            invoiceCount: org.invoiceCount ?? 0,
            currency: org.currency ?? 'USD',
          }));

    const providerCount =
      profile.revenue.providerCount > 0
        ? profile.revenue.providerCount
        : new Set((profile.connectedOrgs ?? []).map((org) => org.provider)).size;
    const orgCount =
      profile.revenue.orgCount > 0
        ? profile.revenue.orgCount
        : (profile.connectedOrgs ?? []).length;

    const chartRevenue = monthlyChart.reduce((s, m) => s + (m.revenue || 0), 0);
    const chartExpenses = monthlyChart.reduce((s, m) => s + (m.expenses || 0), 0);
    const totalRevenue =
      executive?.totalRevenue ??
      (range && range.kind !== 'ALL_TIME'
        ? chartRevenue
        : profile.revenue.totalRevenue > 0
          ? profile.revenue.totalRevenue
          : chartRevenue);
    const chartInvoices = monthlyChart.reduce((s, m) => s + (m.invoices || 0), 0);
    const totalInvoices = profile.revenue.totalInvoices > 0 ? profile.revenue.totalInvoices : chartInvoices;
    const avgInvoiceValue = profile.revenue.avgInvoiceValue > 0
      ? profile.revenue.avgInvoiceValue
      : (totalInvoices > 0 ? totalRevenue / totalInvoices : 0);

    const totalExpenses = executive ? executive.totalCost + executive.totalPayroll : (chartExpenses || profile.expenses?.totalExpenses || 0);
    const netProfit = executive
      ? executive.totalRevenue - executive.totalCost - executive.totalPayroll
      : profile.netProfit;
    const profitMargin = totalRevenue > 0 ? Math.round((netProfit / totalRevenue) * 10000) / 100 : 0;

    const openInvoiceAmount = executive?.arOutstanding ?? profile.expenses?.totalExpenses ?? 0;
    const openInvoiceCount = executive?.arLineCount ?? profile.expenses?.totalBills ?? 0;
    const overdueAmount = executive?.overdueAmount ?? profile.expenses?.overdueAmount ?? 0;
    const overdueCount = executive?.overdueCount ?? profile.expenses?.overdueCount ?? 0;
    const connectedOrgsResolved =
      executive
        ? [{
            orgName: executive.orgName,
            provider: 'EBPO',
            totalRevenue,
            invoiceCount: openInvoiceCount,
            currency: 'USD',
          }]
        : connectedOrgs;

    const invoiceStatus =
      executive
        ? [
            { name: 'AR Outstanding', count: openInvoiceCount, amount: openInvoiceAmount },
            { name: 'Overdue AR', count: overdueCount, amount: overdueAmount },
            { name: 'AP Outstanding', count: executive.apLineCount, amount: executive.apOutstanding },
          ].filter((row) => row.amount > 0 || row.count > 0)
        : (profile.invoiceStats?.byStatusAndOrg ?? []).map((row) => ({
            name: row.status,
            count: row.count,
            amount: row.totalAmount,
          }));

    return {
      kpis: {
        totalRevenue,
        totalExpenses,
        netProfit,
        profitMargin,
        totalInvoices,
        avgInvoiceValue,
        openInvoiceAmount,
        openInvoiceCount,
        overdueAmount,
        overdueCount,
        orgCount: executive ? 1 : orgCount,
        providerCount: executive ? 1 : providerCount,
      },
      venture: {
        burnRate: executive
          ? Math.round((executive.totalCost + executive.totalPayroll) / Math.max(1, monthlyChart.length || 1))
          : profile.ventureMetrics?.burnRate ?? 0,
        runwayMonths: executive
          ? (executive.totalCost + executive.totalPayroll) > 0
            ? Math.round((executive.cashBalance / ((executive.totalCost + executive.totalPayroll) / Math.max(1, monthlyChart.length || 1))) * 10) / 10
            : 99
          : profile.ventureMetrics?.runwayMonths ?? 0,
        cashOnHand: executive?.cashBalance ?? profile.ventureMetrics?.cashOnHand ?? 0,
        efficiencyMultiplier: executive
          ? (executive.totalCost + executive.totalPayroll) > 0
            ? Math.round((executive.totalRevenue / (executive.totalCost + executive.totalPayroll)) * 100) / 100
            : 0
          : profile.ventureMetrics?.efficiencyMultiplier ?? 0,
      },
      cfo: executive
        ? {
            mode: 'ebpo',
            headline: executive.headline,
            cashBalance: executive.cashBalance,
            workingCapital: executive.workingCapital,
            freeCashFlow: executive.freeCashFlow,
            operatingCashFlow: executive.operatingCashFlow,
            grossMarginPct: executive.grossMarginPct,
            payrollToRevenuePct: executive.payrollToRevenuePct,
            dsoDays: executive.dsoDays,
            dpoDays: executive.dpoDays,
            cashConversionDays: executive.cashConversionDays,
            slaCompliancePct: executive.slaCompliancePct,
            utilizationPct: executive.utilizationPct,
            csatPct: executive.csatPct,
            apOutstanding: executive.apOutstanding,
            topClientName: executive.topClientName,
            topClientRevenue: executive.topClientRevenue,
            topClientConcentrationPct: executive.topClientConcentrationPct,
            topBusinessUnitName: executive.topBusinessUnitName,
            topBusinessUnitMarginPct: executive.topBusinessUnitMarginPct,
            businessUnits: executive.businessUnits,
            costElements: executive.costElements,
            headcountByDepartment: executive.headcountByDepartment,
            headcountByGeography: executive.headcountByGeography,
            deliveryCenters: executive.deliveryCenters,
          }
        : {
            mode: 'generic',
            headline: 'This view summarizes live financial coverage across your connected entities.',
            cashBalance: profile.ventureMetrics?.cashOnHand ?? 0,
            workingCapital: 0,
            freeCashFlow: 0,
            operatingCashFlow: 0,
            grossMarginPct: profitMargin,
            payrollToRevenuePct: 0,
            dsoDays: 0,
            dpoDays: 0,
            cashConversionDays: 0,
            slaCompliancePct: 0,
            utilizationPct: 0,
            csatPct: 0,
            apOutstanding: 0,
            topClientName: null,
            topClientRevenue: 0,
            topClientConcentrationPct: 0,
            topBusinessUnitName: null,
            topBusinessUnitMarginPct: 0,
            businessUnits: [],
            costElements: [],
            headcountByDepartment: [],
            headcountByGeography: [],
            deliveryCenters: [],
          },
      charts: {
        monthlyTrend: monthlyChart,
        orgBreakdown,
        invoiceStatus,
        cashflowWaterfall: executive?.cashflowWaterfall ?? [],
      },
      connectedOrgs: connectedOrgsResolved,
      insights: executive?.insights ?? [],
      meta: {
        computedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        range: range ?? { kind: 'ALL_TIME' },
      },
    };
  }
}
