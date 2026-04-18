import { Controller, Get, Param, Patch, Body, Delete, UseGuards, Inject } from '@nestjs/common';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import type { AuthUser } from '../common/decorators/user.decorator';
import { UserProvisioningService } from '../common/services/user-provisioning.service';
import { PRISMA_TOKEN } from '../database/database.module';
import type { PrismaClient } from '@repo/db';

/**
 * InsightsCompatController — Backward-Compatible /insights Endpoints
 *
 * The original frontend calls /insights, /insights/:id etc.
 * This controller mirrors the AnalyticsController at the old /insights path
 * so existing frontend code keeps working without changes.
 *
 * @deprecated — Migrate frontend to /analytics/insights and remove this.
 */
@Controller('insights')
@UseGuards(SupabaseAuthGuard)
export class InsightsCompatController {
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly provisioning: UserProvisioningService,
  ) {}

  @Get()
  async getInsights(@CurrentUser() user: AuthUser) {
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);
    return this.prisma.insight.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: 'desc' },
    });
  }

  @Get(':id')
  async getInsight(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);
    return this.prisma.insight.findFirstOrThrow({
      where: { id, tenantId: tenant.id },
    });
  }

  @Patch(':id')
  async updateInsight(
    @Param('id') id: string,
    @Body() data: { isFavorite?: boolean; pinned?: boolean; title?: string },
    @CurrentUser() user: AuthUser,
  ) {
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);
    const insight = await this.prisma.insight.findFirst({ where: { id, tenantId: tenant.id } });
    if (!insight) throw new Error('Insight not found or access denied.');
    return this.prisma.insight.update({ where: { id }, data });
  }

  @Delete(':id')
  async deleteInsight(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);
    return this.prisma.insight.deleteMany({ where: { id, tenantId: tenant.id } });
  }
}
