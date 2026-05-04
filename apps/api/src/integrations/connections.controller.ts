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

  /**
   * Resolve which connectionIds a user is allowed to see.
   * - owner / admin → all connections for the tenant
   * - member with no OrgMembership rows → all (backward compat for existing members)
   * - member with OrgMembership rows → only the scoped connection ids
   */
  private async getAllowedConnectionIds(
    tenantId: string,
    userId: string,
    role: string,
  ): Promise<string[] | null> {
    if (role === 'owner' || role === 'admin') return null; // null = unrestricted

    const memberships = await prisma.orgMembership.findMany({
      where: { tenantId, userId },
      select: { connectionId: true },
    });

    if (memberships.length === 0) return null; // no explicit scoping → all

    // null connectionId on a membership row = access to all
    if (memberships.some((m) => m.connectionId === null)) return null;

    return memberships.map((m) => m.connectionId as string);
  }

  @Get()
  async getConnections(@CurrentUser() user: AuthUser) {
    const { tenant, user: dbUser } = await this.provisioning.ensureProvisioned(
      user.id,
      user.email,
    );

    const allowedIds = await this.getAllowedConnectionIds(
      tenant.id,
      user.id,
      dbUser.role,
    );

    const connections = await prisma.connection.findMany({
      where: {
        tenantId: tenant.id,
        ...(allowedIds ? { id: { in: allowedIds } } : {}),
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
    const { tenant, user: dbUser } = await this.provisioning.ensureProvisioned(
      user.id,
      user.email,
    );

    const allowedIds = await this.getAllowedConnectionIds(
      tenant.id,
      user.id,
      dbUser.role,
    );

    const jobs = await prisma.syncJob.findMany({
      where: {
        tenantId: tenant.id,
        ...(allowedIds ? { connectionId: { in: allowedIds } } : {}),
      },
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
    const { tenant, user: dbUser } = await this.provisioning.ensureProvisioned(
      user.id,
      user.email,
    );

    const connection = await prisma.connection.findUnique({
      where: { id: connectionId },
    });

    if (!connection) {
      throw new HttpException('Connection not found', HttpStatus.NOT_FOUND);
    }

    if (connection.tenantId !== tenant.id) {
      throw new HttpException('Forbidden', HttpStatus.FORBIDDEN);
    }

    // Members can only sync their scoped connections
    const allowedIds = await this.getAllowedConnectionIds(
      tenant.id,
      user.id,
      dbUser.role,
    );
    if (allowedIds && !allowedIds.includes(connectionId)) {
      throw new HttpException('Forbidden', HttpStatus.FORBIDDEN);
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
    const { tenant, user: dbUser } = await this.provisioning.ensureProvisioned(
      user.id,
      user.email,
    );

    const allowedIds = await this.getAllowedConnectionIds(
      tenant.id,
      user.id,
      dbUser.role,
    );

    const connections = await prisma.connection.findMany({
      where: {
        tenantId: tenant.id,
        isActive: true,
        ...(allowedIds ? { id: { in: allowedIds } } : {}),
      },
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
    const { tenant, user: dbUser } = await this.provisioning.ensureProvisioned(
      user.id,
      user.email,
    );

    const connection = await prisma.connection.findUnique({
      where: { id: connectionId },
    });

    if (!connection) {
      throw new HttpException('Connection not found', HttpStatus.NOT_FOUND);
    }

    if (connection.tenantId !== tenant.id) {
      throw new HttpException('Forbidden', HttpStatus.FORBIDDEN);
    }

    // Only owner/admin can delete connections
    if (dbUser.role === 'member') {
      throw new HttpException('Forbidden', HttpStatus.FORBIDDEN);
    }

    await prisma.$transaction([
      prisma.orgMembership.deleteMany({ where: { connectionId } }),
      prisma.syncJob.deleteMany({ where: { connectionId } }),
      prisma.connection.delete({ where: { id: connectionId } }),
    ]);

    return { status: 'success', message: 'Connection removed successfully' };
  }
}
