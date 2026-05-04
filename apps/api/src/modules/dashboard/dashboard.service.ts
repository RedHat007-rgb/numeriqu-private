import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { PrismaClient, Prisma } from '@repo/db';
import { PRISMA_TOKEN } from '../../database/database.module';
import { OrganizationContextService } from '../org-context/org-context.service';

type ChartInput = {
  title: string;
  type: string;
  queryConfig: Record<string, unknown>;
  chartConfig?: Record<string, unknown>;
};

@Injectable()
export class DashboardService {
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly orgContext: OrganizationContextService,
  ) {}

  async list(organizationId: string, userId: string) {
    await this.orgContext.assertPermission(organizationId, userId, 'VIEW_DASHBOARD');

    const dashboards = await this.prisma.dashboard.findMany({
      where: {
        organizationId,
        deletedAt: null,
        OR: [{ ownerId: userId }, { shares: { some: { sharedWithUserId: userId, revokedAt: null } } }],
      },
      orderBy: { updatedAt: 'desc' },
      include: { widgets: { orderBy: { displayOrder: 'asc' } } },
    });

    return dashboards.map((dashboard) => ({
      id: dashboard.id,
      title: dashboard.title,
      description: dashboard.description,
      ownerId: dashboard.ownerId,
      lastSyncedAt: dashboard.lastSyncedAt?.toISOString() ?? null,
      updatedAt: dashboard.updatedAt.toISOString(),
      charts: dashboard.widgets.map((widget) => ({
        id: widget.id,
        title: widget.title,
        type: widget.chartType,
        queryConfig: widget.queryConfig,
        chartConfig: widget.chartConfig,
        displayOrder: widget.displayOrder,
      })),
    }));
  }

  async getById(organizationId: string, userId: string, dashboardId: string) {
    await this.orgContext.assertPermission(organizationId, userId, 'VIEW_DASHBOARD');

    const dashboard = await this.prisma.dashboard.findFirst({
      where: {
        id: dashboardId,
        organizationId,
        deletedAt: null,
        OR: [{ ownerId: userId }, { shares: { some: { sharedWithUserId: userId, revokedAt: null } } }],
      },
      include: {
        widgets: { orderBy: { displayOrder: 'asc' } },
        shares: { where: { revokedAt: null } },
      },
    });

    if (!dashboard) {
      throw new HttpException(
        { message: 'Dashboard not found.', code: 'NOT_FOUND' },
        HttpStatus.NOT_FOUND,
      );
    }

    return {
      id: dashboard.id,
      title: dashboard.title,
      description: dashboard.description,
      ownerId: dashboard.ownerId,
      config: dashboard.config,
      permissions: dashboard.permissions,
      lastSyncedAt: dashboard.lastSyncedAt?.toISOString() ?? null,
      charts: dashboard.widgets.map((widget) => ({
        id: widget.id,
        title: widget.title,
        type: widget.chartType,
        queryConfig: widget.queryConfig,
        chartConfig: widget.chartConfig,
        displayOrder: widget.displayOrder,
      })),
      shares: dashboard.shares.map((share) => ({
        id: share.id,
        sharedWithUserId: share.sharedWithUserId,
        sharedByUserId: share.sharedByUserId,
        canEdit: share.canEdit,
      })),
    };
  }

  async create(params: {
    organizationId: string;
    ownerId: string;
    title: string;
    description?: string;
    config?: Record<string, unknown>;
    permissions?: Record<string, unknown>;
    charts: ChartInput[];
  }) {
    await this.orgContext.assertPermission(
      params.organizationId,
      params.ownerId,
      'CREATE_DASHBOARD',
    );

    if (params.charts.length < 4) {
      throw new HttpException(
        {
          message: 'A dashboard must contain at least 4 charts.',
          code: 'VALIDATION_FAILED',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const dashboard = await tx.dashboard.create({
        data: {
          organizationId: params.organizationId,
          ownerId: params.ownerId,
          title: params.title,
          description: params.description ?? null,
          config: (params.config ?? {}) as Prisma.InputJsonValue,
          permissions: (params.permissions ?? {}) as Prisma.InputJsonValue,
          lastSyncedAt: new Date(),
        },
      });

      await tx.dashboardWidget.createMany({
        data: params.charts.map((chart, index) => ({
          organizationId: params.organizationId,
          dashboardId: dashboard.id,
          title: chart.title,
          chartType: chart.type,
          queryConfig: chart.queryConfig as Prisma.InputJsonValue,
          chartConfig: (chart.chartConfig ?? {}) as Prisma.InputJsonValue,
          displayOrder: index,
        })),
      });

      return dashboard;
    });
  }

  async refresh(organizationId: string, userId: string, dashboardId: string) {
    await this.orgContext.assertPermission(organizationId, userId, 'VIEW_DASHBOARD');
    const updated = await this.prisma.dashboard.updateMany({
      where: {
        id: dashboardId,
        organizationId,
        deletedAt: null,
        OR: [{ ownerId: userId }, { shares: { some: { sharedWithUserId: userId, revokedAt: null } } }],
      },
      data: { lastSyncedAt: new Date() },
    });
    if (updated.count === 0) {
      throw new HttpException(
        { message: 'Dashboard not found.', code: 'NOT_FOUND' },
        HttpStatus.NOT_FOUND,
      );
    }
    return { success: true };
  }

  async share(params: {
    organizationId: string;
    requesterId: string;
    dashboardId: string;
    sharedWithUserId: string;
    canEdit: boolean;
  }) {
    await this.orgContext.assertPermission(
      params.organizationId,
      params.requesterId,
      'SHARE_DASHBOARD',
    );

    const dashboard = await this.prisma.dashboard.findFirst({
      where: {
        id: params.dashboardId,
        organizationId: params.organizationId,
        deletedAt: null,
        OR: [{ ownerId: params.requesterId }, { shares: { some: { sharedWithUserId: params.requesterId, canEdit: true, revokedAt: null } } }],
      },
      select: { id: true },
    });
    if (!dashboard) {
      throw new HttpException(
        { message: 'Dashboard not found or not shareable.', code: 'NOT_FOUND' },
        HttpStatus.NOT_FOUND,
      );
    }

    await this.orgContext.assertOrganizationMember(params.organizationId, params.sharedWithUserId);

    await this.prisma.dashboardShare.upsert({
      where: {
        dashboardId_sharedWithUserId: {
          dashboardId: params.dashboardId,
          sharedWithUserId: params.sharedWithUserId,
        },
      },
      create: {
        dashboardId: params.dashboardId,
        organizationId: params.organizationId,
        sharedWithUserId: params.sharedWithUserId,
        sharedByUserId: params.requesterId,
        canEdit: params.canEdit,
      },
      update: {
        canEdit: params.canEdit,
        sharedByUserId: params.requesterId,
        revokedAt: null,
      },
    });

    return { success: true };
  }

  async unshare(params: {
    organizationId: string;
    requesterId: string;
    dashboardId: string;
    sharedWithUserId: string;
  }) {
    await this.orgContext.assertPermission(
      params.organizationId,
      params.requesterId,
      'SHARE_DASHBOARD',
    );

    await this.prisma.dashboardShare.updateMany({
      where: {
        organizationId: params.organizationId,
        dashboardId: params.dashboardId,
        sharedWithUserId: params.sharedWithUserId,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
    return { success: true };
  }
}
