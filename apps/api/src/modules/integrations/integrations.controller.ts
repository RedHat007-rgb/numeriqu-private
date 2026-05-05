import {
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { PRISMA_TOKEN } from '../../database/database.module';
import type { PrismaClient } from '@repo/db';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { CurrentUser } from '../../common/decorators/user.decorator';
import type { AuthUser } from '../../common/decorators/user.decorator';
import { OrganizationContextService } from '../org-context/org-context.service';
import { IntegrationsService } from '../../integrations/integrations.service';

@Controller('integrations/connections')
@UseGuards(SupabaseAuthGuard)
export class IntegrationsController {
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly organizationContext: OrganizationContextService,
    private readonly integrationsService: IntegrationsService,
  ) {}

  @Get()
  async listConnections(@CurrentUser() user: AuthUser) {
    const context = await this.organizationContext.ensureContext({
      id: user.id,
      email: user.email,
    });

    const connections = await this.prisma.erpConnection.findMany({
      where: { organizationId: context.organization.id },
      orderBy: { updatedAt: 'desc' },
    });

    return connections.map((conn) => ({
      id: conn.id,
      provider: conn.provider.toLowerCase(),
      providerAccountId: conn.externalOrganizationId,
      orgName: conn.displayName || conn.externalOrganizationId,
      isActive: conn.status === 'ACTIVE',
      updatedAt: conn.updatedAt.toISOString(),
    }));
  }

  @Get('jobs')
  async listJobs(@CurrentUser() user: AuthUser) {
    const context = await this.organizationContext.ensureContext({
      id: user.id,
      email: user.email,
    });

    const jobs = await this.prisma.syncJob.findMany({
      where: { organizationId: context.organization.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { connection: true },
    });

    return jobs.map((job) => ({
      id: job.id,
      connectionId: job.connectionId,
      tenantId: job.organizationId,
      provider: job.connection.provider.toLowerCase(),
      status: job.status,
      recordsProcessed: job.recordsWritten,
      errorDetails: job.errorMessage,
      startedAt: job.startedAt?.toISOString() ?? null,
      completedAt: job.completedAt?.toISOString() ?? null,
      syncWindowStart: null,
      syncWindowEnd: null,
      orgName: job.connection.displayName || job.connection.externalOrganizationId,
    }));
  }

  @Post(':id/sync')
  async syncConnection(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const context = await this.organizationContext.ensureContext({
      id: user.id,
      email: user.email,
    });

    const connection = await this.prisma.erpConnection.findFirst({
      where: { id, organizationId: context.organization.id },
    });

    if (!connection) {
      throw new HttpException('Connection not found.', HttpStatus.NOT_FOUND);
    }

    this.integrationsService
      .startIntegrationSync(
        connection.organizationId,
        connection.createdById,
        connection.id,
        connection.provider,
        connection.externalOrganizationId,
      )
      .catch(() => {});

    return { status: 'accepted', message: 'Sync started.' };
  }

  @Post('sync-all')
  async syncAll(@CurrentUser() user: AuthUser) {
    const context = await this.organizationContext.ensureContext({
      id: user.id,
      email: user.email,
    });

    const connections = await this.prisma.erpConnection.findMany({
      where: { organizationId: context.organization.id, status: 'ACTIVE' },
    });

    if (connections.length === 0) {
      return { status: 'accepted', message: 'No active connections found.' };
    }

    for (const connection of connections) {
      this.integrationsService
        .startIntegrationSync(
          connection.organizationId,
          connection.createdById,
          connection.id,
          connection.provider,
          connection.externalOrganizationId,
        )
        .catch(() => {});
    }

    return { status: 'accepted', message: `Started ${connections.length} syncs.` };
  }

  @Delete(':id')
  async deleteConnection(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const context = await this.organizationContext.ensureContext({
      id: user.id,
      email: user.email,
    });

    const existing = await this.prisma.erpConnection.findFirst({
      where: { id, organizationId: context.organization.id },
      select: { id: true },
    });
    if (!existing) {
      throw new HttpException('Connection not found.', HttpStatus.NOT_FOUND);
    }

    await this.prisma.erpConnection.delete({ where: { id } });
    return { status: 'success', message: 'Connection removed successfully' };
  }
}

