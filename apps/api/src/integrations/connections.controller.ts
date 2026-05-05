import {
  Controller,
  Get,
  Delete,
  Post,
  Param,
  UseGuards,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import type { AuthUser } from '../common/decorators/user.decorator';
import { OrganizationContextService } from '../modules/org-context/org-context.service';
import { IntegrationsService } from './integrations.service';
import { prisma } from '@repo/db';

@Controller('integrations/connections')
@UseGuards(SupabaseAuthGuard)
export class ConnectionsController {
  constructor(
    private readonly orgContext: OrganizationContextService,
    private readonly integrations: IntegrationsService,
  ) {}

  @Get()
  async getConnections(@CurrentUser() user: AuthUser) {
    const { organization } = await this.orgContext.ensureContext(
      { id: user.id, email: user.email },
    );

    const connections = await prisma.erpConnection.findMany({
      where: {
        organizationId: organization.id,
      },
      select: {
        id: true,
        provider: true,
        externalOrganizationId: true,
        metadata: true,
        status: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
    });

    return connections.map((conn) => {
      const meta = conn.metadata as Record<string, unknown> | null;
      return {
        id: conn.id,
        provider: conn.provider,
        providerAccountId: conn.externalOrganizationId,
        orgName:
          typeof meta?.orgName === 'string'
            ? meta.orgName
            : typeof meta?.companyId === 'string'
              ? meta.companyId
              : conn.externalOrganizationId,
        isActive: conn.status === 'ACTIVE',
        updatedAt: conn.updatedAt,
      };
    });
  }

  @Get('jobs')
  async getSyncJobs(@CurrentUser() user: AuthUser) {
    const { organization } = await this.orgContext.ensureContext(
      { id: user.id, email: user.email },
    );

    const jobs = await prisma.syncJob.findMany({
      where: {
        organizationId: organization.id,
      },
      orderBy: { startedAt: 'desc' },
      take: 20,
      include: {
        connection: {
          select: { metadata: true, externalOrganizationId: true },
        },
      },
    });

    return jobs.map((job) => {
      const meta = job.connection?.metadata as Record<string, unknown> | null;
      const { connection, ...rest } = job;
      return {
        ...rest,
        orgName:
          typeof meta?.orgName === 'string'
            ? meta.orgName
            : (connection?.externalOrganizationId ?? null),
      };
    });
  }

  @Post(':id/sync')
  async syncConnection(
    @CurrentUser() user: AuthUser,
    @Param('id') connectionId: string,
  ) {
    const { organization } = await this.orgContext.ensureContext(
      { id: user.id, email: user.email },
    );

    const connection = await prisma.erpConnection.findUnique({
      where: { id: connectionId },
    });

    if (!connection) {
      throw new HttpException('Connection not found', HttpStatus.NOT_FOUND);
    }

    if (connection.organizationId !== organization.id) {
      throw new HttpException('Forbidden', HttpStatus.FORBIDDEN);
    }

    this.integrations
      .startIntegrationSync(
        connection.organizationId,
        connection.createdById,
        connection.id,
        connection.provider,
        connection.externalOrganizationId,
      )
      .catch((error: unknown) => {
        console.error(`Sync failed for ${connection.provider}:`, error);
      });

    return {
      status: 'accepted',
      message: `Sync queued for ${connection.provider}.`,
      connectionId: connection.id,
    };
  }

  @Post('sync-all')
  async syncAllConnections(@CurrentUser() user: AuthUser) {
    const { organization } = await this.orgContext.ensureContext(
      { id: user.id, email: user.email },
    );

    const connections = await prisma.erpConnection.findMany({
      where: {
        organizationId: organization.id,
        status: 'ACTIVE',
      },
    });

    for (const connection of connections) {
      this.integrations
        .startIntegrationSync(
          connection.organizationId,
          connection.createdById,
          connection.id,
          connection.provider,
          connection.externalOrganizationId,
        )
        .catch((error: unknown) => {
          console.error(`Sync failed for ${connection.provider}:`, error);
        });
    }

    return {
      status: 'accepted',
      message: `Queued ${connections.length} active connection syncs.`,
      connectionIds: connections.map((connection) => connection.id),
    };
  }

  @Delete(':id')
  async deleteConnection(
    @CurrentUser() user: AuthUser,
    @Param('id') connectionId: string,
  ) {
    const { organization, membership } = await this.orgContext.ensureContext(
      { id: user.id, email: user.email },
    );

    const connection = await prisma.erpConnection.findUnique({
      where: { id: connectionId },
    });

    if (!connection) {
      throw new HttpException('Connection not found', HttpStatus.NOT_FOUND);
    }

    if (connection.organizationId !== organization.id) {
      throw new HttpException('Forbidden', HttpStatus.FORBIDDEN);
    }

    // Only owner/admin can delete connections
    if (membership.role !== 'ADMIN') {
      throw new HttpException('Forbidden', HttpStatus.FORBIDDEN);
    }

    await prisma.$transaction([
      prisma.syncJob.deleteMany({ where: { connectionId } }),
      prisma.erpConnection.delete({ where: { id: connectionId } }),
    ]);

    return { status: 'success', message: 'Connection removed successfully' };
  }
}
