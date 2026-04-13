import {
  Controller,
  Post,
  Req,
  Get,
  UseGuards,
  InternalServerErrorException,
} from '@nestjs/common';
import { IntegrationsService } from './integrations/integrations.service';
import { prisma } from '@repo/db';
import { v4 as uuidv4 } from 'uuid';
import { SupabaseAuthGuard } from './common/guards/supabase-auth.guard';
import { CurrentUser } from './common/decorators/user.decorator';
import type { AuthUser } from './common/decorators/user.decorator';
import { UserProvisioningService } from './common/services/user-provisioning.service';

@Controller()
export class AppController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly provisioning: UserProvisioningService,
  ) {}

  /**
   * GET /auth/me — Authenticated user profile + tenant
   * 
   * First call triggers JIT provisioning (creates user + tenant).
   * Subsequent calls return the existing records.
   */
  @Get('auth/me')
  @UseGuards(SupabaseAuthGuard)
  async getMe(@CurrentUser() user: AuthUser) {
    const result = await this.provisioning.ensureProvisioned(user.id, user.email);
    return result;
  }

  // --- TEST ENDPOINTS (backward compat) ---

  @Post('test/setup')
  async setupDummyData() {
    try {
      const userId = uuidv4();
      const user = await prisma.user.create({
        data: {
          id: userId,
          email: `test-${userId}@example.com`,
          name: 'Integration Tester',
        },
      });

      const tenant = await prisma.tenant.create({
        data: { name: 'Test Organization' },
      });

      const connection = await prisma.connection.create({
        data: {
          tenantId: tenant.id,
          userId: user.id,
          provider: 'quickbooks',
          providerAccountId: 'QBO_REALM_12345',
          accessToken: 'N/A',
          refreshToken: 'N/A',
          isActive: true,
        },
      });

      return {
        message: 'Setup complete. Store these IDs to trigger sync.',
        user,
        tenant,
        connection,
      };
    } catch (error) {
      console.error(error);
      throw new InternalServerErrorException('Error creating test data.');
    }
  }

  @Post('test/trigger-sync')
  @UseGuards(SupabaseAuthGuard)
  async triggerSync(@CurrentUser() user: AuthUser, @Req() req: any) {
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);

    const provider = req.query.provider;
    const filter: any = { isActive: true, tenantId: tenant.id };
    if (provider) filter.provider = provider;

    const connections = await prisma.connection.findMany({
      where: filter,
    });

    if (connections.length === 0) {
      return {
        error: `No active ${provider || 'any'} connections found.`,
      };
    }

    for (const conn of connections) {
      this.integrations
        .startIntegrationSync(
          conn.tenantId,
          conn.userId,
          conn.id,
          conn.provider,
          conn.providerAccountId,
        )
        .catch((e) => console.error(`Sync failed for ${conn.provider}:`, e));
    }

    return {
      message: `Triggered sync for ${connections.length} ${provider || ''} active pipelines.`,
      connections: connections.map((c) => ({ provider: c.provider, id: c.id })),
    };
  }

  @Get('test/jobs')
  @UseGuards(SupabaseAuthGuard)
  async checkJobs(@CurrentUser() user: AuthUser) {
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);

    const jobs = await prisma.syncJob.findMany({
      where: { tenantId: tenant.id },
      orderBy: { startedAt: 'desc' },
      take: 10,
      include: {
        connection: {
          select: { metadata: true },
        },
      },
    });

    return jobs.map((job) => {
      const meta = job.connection?.metadata as Record<string, any> | null;
      const orgName = meta?.orgName as string | undefined;
      const { connection: _connection, ...rest } = job;
      return { ...rest, orgName: orgName || null };
    });
  }
}
