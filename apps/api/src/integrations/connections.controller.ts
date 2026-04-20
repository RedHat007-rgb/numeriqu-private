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
import { UserProvisioningService } from '../common/services/user-provisioning.service';
import { IntegrationsService } from './integrations.service';
import { prisma } from '@repo/db';

@Controller('integrations/connections')
@UseGuards(SupabaseAuthGuard)
export class ConnectionsController {
  constructor(
    private readonly provisioning: UserProvisioningService,
    private readonly integrations: IntegrationsService,
  ) {}

  @Get()
  async getConnections(@CurrentUser() user: AuthUser) {
    const { tenant } = await this.provisioning.ensureProvisioned(
      user.id,
      user.email,
    );

    const connections = await prisma.connection.findMany({
      where: {
        tenantId: tenant.id,
      },
      select: {
        id: true,
        provider: true,
        providerAccountId: true,
        metadata: true,
        isActive: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
    });

    return connections.map((conn) => {
      const meta = conn.metadata as Record<string, unknown> | null;
      return {
        id: conn.id,
        provider: conn.provider,
        providerAccountId: conn.providerAccountId,
        orgName:
          typeof meta?.orgName === 'string'
            ? meta.orgName
            : typeof meta?.companyId === 'string'
              ? meta.companyId
              : conn.providerAccountId,
        isActive: conn.isActive,
        updatedAt: conn.updatedAt,
      };
    });
  }

  @Get('jobs')
  async getSyncJobs(@CurrentUser() user: AuthUser) {
    const { tenant } = await this.provisioning.ensureProvisioned(
      user.id,
      user.email,
    );

    const jobs = await prisma.syncJob.findMany({
      where: { tenantId: tenant.id },
      orderBy: { startedAt: 'desc' },
      take: 20,
      include: {
        connection: {
          select: { metadata: true, providerAccountId: true },
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
            : (connection?.providerAccountId ?? null),
      };
    });
  }

  @Post(':id/sync')
  async syncConnection(
    @CurrentUser() user: AuthUser,
    @Param('id') connectionId: string,
  ) {
    const { tenant } = await this.provisioning.ensureProvisioned(
      user.id,
      user.email,
    );

    const connection = await prisma.connection.findUnique({
      where: { id: connectionId },
    });

    if (!connection) {
      throw new HttpException('Connection not found', HttpStatus.NOT_FOUND);
    }

    if (connection.tenantId !== tenant.id || connection.userId !== user.id) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }

    this.integrations
      .startIntegrationSync(
        connection.tenantId,
        connection.userId,
        connection.id,
        connection.provider,
        connection.providerAccountId,
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
    const { tenant } = await this.provisioning.ensureProvisioned(
      user.id,
      user.email,
    );

    const connections = await prisma.connection.findMany({
      where: { tenantId: tenant.id, userId: user.id, isActive: true },
    });

    for (const connection of connections) {
      this.integrations
        .startIntegrationSync(
          connection.tenantId,
          connection.userId,
          connection.id,
          connection.provider,
          connection.providerAccountId,
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
    const { tenant } = await this.provisioning.ensureProvisioned(
      user.id,
      user.email,
    );

    // Ensure the connection belongs to the caller's tenant
    const connection = await prisma.connection.findUnique({
      where: { id: connectionId },
    });

    if (!connection) {
      throw new HttpException('Connection not found', HttpStatus.NOT_FOUND);
    }

    if (connection.tenantId !== tenant.id) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }

    // Perform a transactional delete to handle foreign key constraints (SyncJobs -> Connection)
    await prisma.$transaction([
      prisma.syncJob.deleteMany({
        where: { connectionId },
      }),
      prisma.connection.delete({
        where: { id: connectionId },
      }),
    ]);

    return { status: 'success', message: 'Connection removed successfully' };
  }
}
