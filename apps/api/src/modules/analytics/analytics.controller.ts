import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import type { PrismaClient } from '@repo/db';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { CurrentUser } from '../../common/decorators/user.decorator';
import type { AuthUser } from '../../common/decorators/user.decorator';
import { OrganizationContextService } from '../org-context/org-context.service';
import { PRISMA_TOKEN } from '../../database/database.module';

type TrendRow = {
  month: Date;
  revenue: number;
  invoices: bigint;
};

@Controller('analytics')
@UseGuards(SupabaseAuthGuard)
export class AnalyticsController {
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly organizationContext: OrganizationContextService,
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

    const invoiceAgg = await this.prisma.financialInvoice.aggregate({
      where: { organizationId, deletedAt: null },
      _sum: { totalAmount: true, taxAmount: true, amountDue: true },
      _count: { id: true },
    });

    const invoiceStatus = await this.prisma.financialInvoice.groupBy({
      by: ['status'],
      where: { organizationId, deletedAt: null },
      _count: { status: true },
      _sum: { totalAmount: true },
    });

    const orgBreakdown = await this.prisma.$queryRaw<Array<{
      connection_id: string;
      org_name: string | null;
      provider: string;
      total_revenue: number;
      invoice_count: bigint;
    }>>`
      SELECT
        i.connection_id,
        c.display_name as org_name,
        c.provider::text as provider,
        COALESCE(SUM(i.total_amount), 0)::float8 as total_revenue,
        COUNT(*)::bigint as invoice_count
      FROM financial_invoices i
      JOIN erp_connections c ON c.id = i.connection_id
      WHERE i.organization_id = ${organizationId}::uuid
      AND i.deleted_at IS NULL
      GROUP BY i.connection_id, c.display_name, c.provider
      ORDER BY total_revenue DESC
    `;

    const monthlyTrend = await this.prisma.$queryRaw<TrendRow[]>`
      SELECT
        date_trunc('month', issue_date)::date as month,
        COALESCE(SUM(total_amount), 0)::float8 as revenue,
        COUNT(*)::bigint as invoices
      FROM financial_invoices
      WHERE organization_id = ${organizationId}::uuid
      AND deleted_at IS NULL
      GROUP BY date_trunc('month', issue_date)
      ORDER BY month ASC
      LIMIT 24
    `;

    const totalRevenue = Number(invoiceAgg._sum.totalAmount ?? 0);
    const totalExpenses = Number(invoiceAgg._sum.taxAmount ?? 0);
    const netProfit = totalRevenue - totalExpenses;
    const profitMargin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;
    const totalInvoices = invoiceAgg._count.id;
    const avgInvoiceValue = totalInvoices > 0 ? totalRevenue / totalInvoices : 0;
    const overdueAmount = Number(invoiceAgg._sum.amountDue ?? 0);

    const orgCount = orgBreakdown.length;
    const providerCount = new Set(orgBreakdown.map((row) => row.provider)).size;

    return {
      kpis: {
        totalRevenue,
        totalExpenses,
        netProfit,
        profitMargin,
        totalInvoices,
        avgInvoiceValue,
        overdueAmount,
        overdueCount: 0,
        orgCount,
        providerCount,
      },
      venture: {
        burnRate: totalExpenses / Math.max(1, Math.min(12, monthlyTrend.length)),
        runwayMonths: 0,
        cashOnHand: netProfit,
        efficiencyMultiplier: totalExpenses > 0 ? totalRevenue / totalExpenses : 0,
      },
      charts: {
        monthlyTrend: monthlyTrend.map((row) => {
          const month = new Date(row.month);
          const mm = String(month.getMonth() + 1).padStart(2, '0');
          const yy = String(month.getFullYear()).slice(2);
          return {
            name: `${mm}/${yy}`,
            month: month.toISOString().slice(0, 7),
            revenue: Number(row.revenue ?? 0),
            expenses: 0,
            invoices: Number(row.invoices ?? 0),
          };
        }),
        orgBreakdown: orgBreakdown.map((row) => ({
          name: row.org_name || row.connection_id,
          value: Number(row.total_revenue ?? 0),
          provider: row.provider.toLowerCase(),
          invoiceCount: Number(row.invoice_count ?? 0),
          currency: 'USD',
        })),
        invoiceStatus: invoiceStatus.map((row) => ({
          name: row.status,
          count: Number(row._count.status ?? 0),
          amount: Number(row._sum.totalAmount ?? 0),
        })),
        cashflowWaterfall: [
          { name: 'Revenue', value: totalRevenue, fill: '#00F5D4' },
          { name: 'Expenses', value: -totalExpenses, fill: '#FF6B6B' },
          { name: 'Net Profit', value: netProfit, fill: netProfit >= 0 ? '#00F5D4' : '#FF6B6B' },
        ],
      },
      connectedOrgs: orgBreakdown.map((row) => ({
        orgName: row.org_name || row.connection_id,
        provider: row.provider.toLowerCase(),
        totalRevenue: Number(row.total_revenue ?? 0),
        invoiceCount: Number(row.invoice_count ?? 0),
        currency: 'USD',
      })),
      insights: [],
      meta: {
        computedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
      },
    };
  }
}

