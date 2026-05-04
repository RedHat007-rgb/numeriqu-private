import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Patch,
  Delete,
  UseGuards,
  Logger,
  Inject,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/user.decorator';
import type { AuthUser } from '../common/decorators/user.decorator';
import { UserProvisioningService } from '../common/services/user-provisioning.service';
import { AuditLogService } from '../common/services/audit-log.service';
import { FinancialDataService } from '../financial-data/financial-data.service';
import { PRISMA_TOKEN } from '../database/database.module';
import type { PrismaClient } from '@repo/db';

/**
 * AnalyticsController — Financial Intelligence Dashboard
 *
 * Dashboard CRUD:
 *   - Admin: full CRUD on all dashboards in their org
 *   - Member: can view dashboards shared with them
 *   - Member (canCreateDashboard=true): can create their own
 *
 * Data endpoints:
 *   - /analytics/dashboard — KPI summary + charts (reads from Gold Layer)
 *   - /analytics/trend     — monthly revenue trend
 *   - /analytics/invoices  — recent invoices list
 *
 * NOTE: Insight model removed — dashboards replace it.
 * Legacy /analytics/insights route kept for frontend backward compat
 * but now returns dashboards in the same shape.
 */
@Controller('analytics')
@UseGuards(SupabaseAuthGuard)
export class AnalyticsController {
  private readonly logger = new Logger(AnalyticsController.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly provisioning: UserProvisioningService,
    private readonly auditLog: AuditLogService,
    private readonly financialData: FinancialDataService,
  ) {}

  // ─── DASHBOARDS ──────────────────────────────────────────────────────────

  /**
   * GET /analytics/dashboards
   * Admin: returns all dashboards in the org.
   * Member: returns only dashboards explicitly shared with them.
   */
  @Get('dashboards')
  async listDashboards(@CurrentUser() user: AuthUser) {
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);

    if (user.role === 'admin') {
      const dashboards = await this.prisma.dashboard.findMany({
        where: { tenantId: tenant.id },
        include: {
          charts: { orderBy: { layoutIndex: 'asc' } },
          connection: { select: { id: true, displayName: true, provider: true } },
          _count: { select: { shares: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
      return dashboards;
    }

    // Member: only shared dashboards + their own (if they have create permission)
    const sharedDashboards = await this.prisma.dashboard.findMany({
      where: {
        tenantId: tenant.id,
        OR: [
          { userId: user.id }, // their own
          {
            shares: { some: { userId: user.id } },
            isPublished: true,
          },
        ],
      },
      include: {
        charts: { orderBy: { layoutIndex: 'asc' } },
        connection: { select: { id: true, displayName: true, provider: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return sharedDashboards;
  }

  /**
   * GET /analytics/dashboards/:id
   * Returns a single dashboard with all its charts.
   * Access control: admin sees any, member sees only their own or shared.
   */
  @Get('dashboards/:id')
  async getDashboard(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);

    const dashboard = await this.prisma.dashboard.findFirst({
      where: {
        id,
        tenantId: tenant.id,
        ...(user.role === 'member'
          ? {
              OR: [
                { userId: user.id },
                { shares: { some: { userId: user.id } }, isPublished: true },
              ],
            }
          : {}),
      },
      include: {
        charts: { orderBy: { layoutIndex: 'asc' } },
        connection: { select: { id: true, displayName: true, provider: true } },
        shares: {
          select: { userId: true, canEdit: true, sharedAt: true },
        },
      },
    });

    if (!dashboard) {
      throw new NotFoundException('Dashboard not found or you do not have access.');
    }

    return dashboard;
  }

  /**
   * POST /analytics/dashboards
   * Create a new dashboard.
   * Admin: always allowed.
   * Member: requires canCreateDashboard permission.
   * Rule: a dashboard must have at least 4 charts before it can be published.
   */
  @Post('dashboards')
  @UseGuards(PermissionsGuard)
  @RequirePermission('canCreateDashboard')
  async createDashboard(
    @CurrentUser() user: AuthUser,
    @Body()
    body: {
      title: string;
      description?: string;
      connectionId?: string;
    },
  ) {
    if (!body?.title?.trim()) {
      throw new BadRequestException('Dashboard title is required.');
    }

    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);

    // If connectionId provided, verify it belongs to this tenant
    if (body.connectionId) {
      const conn = await this.prisma.connection.findFirst({
        where: { id: body.connectionId, tenantId: tenant.id },
      });
      if (!conn) {
        throw new NotFoundException('Connection not found in your organization.');
      }

      // Members must have access to this connection
      if (user.role === 'member') {
        const membership = await this.prisma.orgMembership.findFirst({
          where: { userId: user.id, connectionId: body.connectionId, tenantId: tenant.id },
        });
        if (!membership) {
          throw new ForbiddenException('You do not have access to this ERP connection.');
        }
      }
    }

    const dashboard = await this.prisma.dashboard.create({
      data: {
        tenantId: tenant.id,
        userId: user.id,
        connectionId: body.connectionId ?? null,
        title: body.title.trim(),
        description: body.description ?? null,
        isPublished: false,
      },
      include: { charts: true },
    });

    this.auditLog.logAsync({
      tenantId: tenant.id,
      userId: user.id,
      action: 'dashboard.created',
      resource: 'dashboard',
      resourceId: dashboard.id,
      metadata: { title: dashboard.title },
    });

    return dashboard;
  }

  /**
   * PATCH /analytics/dashboards/:id
   * Update dashboard metadata.
   * Publishing requires >= 4 charts.
   */
  @Patch('dashboards/:id')
  async updateDashboard(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Body()
    body: {
      title?: string;
      description?: string;
      isPublished?: boolean;
    },
  ) {
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);

    const dashboard = await this.prisma.dashboard.findFirst({
      where: { id, tenantId: tenant.id },
      include: { _count: { select: { charts: true } } },
    });

    if (!dashboard) throw new NotFoundException('Dashboard not found.');

    // Only the creator or an admin can update
    if (user.role !== 'admin' && dashboard.userId !== user.id) {
      throw new ForbiddenException('You do not have permission to edit this dashboard.');
    }

    // Enforce minimum 4 charts before publishing
    if (body.isPublished === true && dashboard._count.charts < 4) {
      throw new BadRequestException(
        `A dashboard must have at least 4 charts before publishing. This dashboard has ${dashboard._count.charts}.`,
      );
    }

    const updated = await this.prisma.dashboard.update({
      where: { id },
      data: {
        ...(body.title ? { title: body.title.trim() } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.isPublished !== undefined ? { isPublished: body.isPublished } : {}),
      },
    });

    if (body.isPublished === true) {
      this.auditLog.logAsync({
        tenantId: tenant.id,
        userId: user.id,
        action: 'dashboard.published',
        resource: 'dashboard',
        resourceId: id,
      });
    }

    return updated;
  }

  /**
   * DELETE /analytics/dashboards/:id
   * Admin: can delete any dashboard.
   * Member: can only delete their own.
   */
  @Delete('dashboards/:id')
  async deleteDashboard(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);

    const dashboard = await this.prisma.dashboard.findFirst({
      where: { id, tenantId: tenant.id },
    });

    if (!dashboard) throw new NotFoundException('Dashboard not found.');

    if (user.role !== 'admin' && dashboard.userId !== user.id) {
      throw new ForbiddenException('You do not have permission to delete this dashboard.');
    }

    await this.prisma.dashboard.delete({ where: { id } });

    this.auditLog.logAsync({
      tenantId: tenant.id,
      userId: user.id,
      action: 'dashboard.deleted',
      resource: 'dashboard',
      resourceId: id,
    });

    return { message: 'Dashboard deleted.' };
  }

  /**
   * POST /analytics/dashboards/:id/share
   * Admin only (or member with canShareDashboard).
   * Share a dashboard with a specific member.
   */
  @Post('dashboards/:id/share')
  @UseGuards(PermissionsGuard)
  @RequirePermission('canShareDashboard')
  async shareDashboard(
    @Param('id') dashboardId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: { userId: string; canEdit?: boolean },
  ) {
    if (!body?.userId) throw new BadRequestException('userId is required.');
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);

    // Verify dashboard belongs to this tenant
    const dashboard = await this.prisma.dashboard.findFirst({
      where: { id: dashboardId, tenantId: tenant.id },
    });
    if (!dashboard) throw new NotFoundException('Dashboard not found.');

    // Only creator or admin can share
    if (user.role !== 'admin' && dashboard.userId !== user.id) {
      throw new ForbiddenException('Only the dashboard creator or an admin can share it.');
    }

    // Verify target user is in the org
    const targetUser = await this.prisma.user.findFirst({
      where: { id: body.userId, tenantId: tenant.id },
    });
    if (!targetUser) throw new NotFoundException('User not found in your organization.');

    await this.prisma.dashboardShare.upsert({
      where: { dashboardId_userId: { dashboardId, userId: body.userId } },
      create: { dashboardId, userId: body.userId, canEdit: body.canEdit ?? false, sharedBy: user.id },
      update: { canEdit: body.canEdit ?? false, sharedBy: user.id },
    });

    this.auditLog.logAsync({
      tenantId: tenant.id,
      userId: user.id,
      action: 'dashboard.shared',
      resource: 'dashboard',
      resourceId: dashboardId,
      metadata: { sharedWithUserId: body.userId, canEdit: body.canEdit },
    });

    return { message: 'Dashboard shared successfully.' };
  }

  // ─── LEGACY COMPAT: /analytics/insights → returns dashboards ─────────────

  /**
   * GET /analytics/insights
   * @deprecated — returns dashboards in legacy insight shape for frontend compat.
   * Frontend should migrate to GET /analytics/dashboards.
   */
  @Get('insights')
  async getInsights(@CurrentUser() user: AuthUser) {
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);

    const where =
      user.role === 'admin'
        ? { tenantId: tenant.id }
        : {
            tenantId: tenant.id,
            OR: [
              { userId: user.id },
              { shares: { some: { userId: user.id } }, isPublished: true },
            ],
          };

    const dashboards = await this.prisma.dashboard.findMany({
      where,
      include: { charts: { orderBy: { layoutIndex: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    });

    // Return in legacy shape so existing frontend code doesn't break
    return dashboards.map((d) => ({
      id: d.id,
      tenantId: d.tenantId,
      title: d.title,
      description: d.description,
      type: 'dashboard',
      config: { charts: d.charts },
      category: 'strategic',
      pinned: d.isPublished,
      isFavorite: d.isPublished,
      createdAt: d.createdAt,
    }));
  }

  // ─── DATA ENDPOINTS ───────────────────────────────────────────────────────

  /**
   * GET /analytics/dashboard
   * Executive KPI summary + all chart data.
   * Members scoped to their accessible connections only.
   */
  @Get('dashboard')
  async getDashboardData(@CurrentUser() user: AuthUser, @Query('connectionId') connectionId?: string) {
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);
    const startTime = Date.now();

    // Members: verify they have access to the requested connection
    if (user.role === 'member' && connectionId) {
      const membership = await this.prisma.orgMembership.findFirst({
        where: { userId: user.id, connectionId, tenantId: tenant.id },
      });
      if (!membership) {
        throw new ForbiddenException(
          'You do not have access to this ERP connection. Contact your admin.',
        );
      }
    }

    try {
      const [profile, monthlyTrend] = await Promise.all([
        this.financialData.getFinancialProfile(tenant.id),
        this.financialData.getMonthlyRevenueTrend(tenant.id),
      ]);

      const trendMap = new Map<string, { revenue: number; invoices: number }>();
      for (const row of monthlyTrend) {
        const month = (row.month ?? '').slice(0, 7);
        const existing = trendMap.get(month) ?? { revenue: 0, invoices: 0 };
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
          invoices: data.invoices,
        }));

      const statusMap = new Map<string, { count: number; amount: number }>();
      for (const stat of profile.invoiceStats?.byStatusAndOrg ?? []) {
        const existing = statusMap.get(stat.status) ?? { count: 0, amount: 0 };
        existing.count += stat.count;
        existing.amount += stat.totalAmount;
        statusMap.set(stat.status, existing);
      }

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
          orgCount: profile.connectedOrgs?.length ?? 0,
          providerCount: profile.revenue.providerCount,
        },
        venture: profile.ventureMetrics,
        charts: {
          monthlyTrend: monthlyChart,
          orgBreakdown: (profile.connectedOrgs ?? []).map((org) => ({
            name: org.orgName,
            value: Math.round(org.totalRevenue),
            provider: org.provider,
            invoiceCount: org.invoiceCount,
          })),
          invoiceStatus: [...statusMap.entries()].map(([status, data]) => ({
            name: status,
            count: data.count,
            amount: Math.round(data.amount),
          })),
          cashflowWaterfall: [
            { name: 'Revenue', value: Math.round(profile.revenue.totalRevenue), fill: '#10B981' },
            { name: 'Expenses', value: -Math.round(profile.expenses.totalExpenses), fill: '#F43F5E' },
            { name: 'Net Profit', value: Math.round(profile.netProfit), fill: profile.netProfit >= 0 ? '#10B981' : '#F43F5E' },
          ],
        },
        connectedOrgs: profile.connectedOrgs,
        meta: {
          computedAt: profile.computedAt,
          latencyMs: Date.now() - startTime,
        },
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`[Dashboard] Data fetch failed: ${msg}`);
      return this.emptyDashboardResponse(startTime);
    }
  }

  @Get('trend')
  async getTrend(@CurrentUser() user: AuthUser, @Query('orgId') orgId?: string) {
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);
    const trend = await this.financialData.getMonthlyRevenueTrend(tenant.id);

    const filtered = orgId ? trend.filter((t: any) => t.org_id === orgId) : trend;

    return filtered.map((t: any) => ({
      name: (t.month ?? '').slice(0, 7).split('-').reverse().join('/').slice(0, 5),
      month: (t.month ?? '').slice(0, 7),
      revenue: Math.abs(parseFloat(t.revenue) || 0),
      invoices: parseInt(t.invoice_count) || 0,
      orgName: t.org_name,
      provider: t.provider,
    }));
  }

  @Get('invoices')
  async getInvoices(@CurrentUser() user: AuthUser) {
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);
    return this.financialData.getInvoicesList(tenant.id);
  }

  // ─── PRIVATE ─────────────────────────────────────────────────────────────

  private emptyDashboardResponse(startTime: number) {
    return {
      kpis: { totalRevenue: 0, totalExpenses: 0, netProfit: 0, profitMargin: 0, totalInvoices: 0, avgInvoiceValue: 0, overdueAmount: 0, overdueCount: 0, orgCount: 0, providerCount: 0 },
      venture: { burnRate: 0, runwayMonths: 0, cashOnHand: 0, efficiencyMultiplier: 0 },
      charts: { monthlyTrend: [], orgBreakdown: [], invoiceStatus: [], cashflowWaterfall: [] },
      connectedOrgs: [],
      meta: { computedAt: new Date().toISOString(), latencyMs: Date.now() - startTime, error: 'Data temporarily unavailable' },
    };
  }
}
