import { Controller, Get, Delete, Param, UseGuards, HttpException, HttpStatus } from '@nestjs/common';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import type { AuthUser } from '../common/decorators/user.decorator';
import { UserProvisioningService } from '../common/services/user-provisioning.service';
import { prisma } from '@repo/db';

@Controller('integrations/connections')
@UseGuards(SupabaseAuthGuard)
export class ConnectionsController {
  constructor(private readonly provisioning: UserProvisioningService) {}

  @Get()
  async getConnections(@CurrentUser() user: AuthUser) {
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);
    
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
    
    return connections.map(conn => {
      const meta = conn.metadata as Record<string, any> | null;
      return {
        id: conn.id,
        provider: conn.provider,
        providerAccountId: conn.providerAccountId,
        orgName: meta?.orgName || meta?.companyId || conn.providerAccountId,
        isActive: conn.isActive,
        updatedAt: conn.updatedAt,
      };
    });
  }

  @Delete(':id')
  async deleteConnection(@CurrentUser() user: AuthUser, @Param('id') connectionId: string) {
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);

    // Ensure the connection belongs to the caller's tenant
    const connection = await prisma.connection.findUnique({
      where: { id: connectionId }
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
        where: { connectionId }
      }),
      prisma.connection.delete({
        where: { id: connectionId }
      })
    ]);

    return { status: 'success', message: 'Connection removed successfully' };
  }
}
