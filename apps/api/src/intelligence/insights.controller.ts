import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Patch,
  Delete,
  UseGuards,
  Request,
} from '@nestjs/common';
import { AgentToolsService } from './agent-tools.service';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { Inject, Injectable } from '@nestjs/common';
import { PRISMA_TOKEN } from '../database/database.module';
import type { PrismaClient } from '@repo/db';

/**
 * InsightsController — The "Financial Insights Hub"
 *
 * Manages the AI-generated visualizations that are pinned to the user's dashboard.
 */
@Controller('insights')
@UseGuards(SupabaseAuthGuard)
export class InsightsController {
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly agentTools: AgentToolsService,
  ) {}

  /**
   * List all saved/pinned insights for the tenant.
   */
  @Get()
  async getInsights(@Request() req: any) {
    const tenantId = req.user.tenantId;
    return this.prisma.insight.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Get a single insight configuration.
   */
  @Get(':id')
  async getInsight(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user.tenantId;
    return this.prisma.insight.findFirstOrThrow({
      where: { id, tenantId },
    });
  }

  /**
   * Toggle persistent pin status or favorite status.
   */
  @Patch(':id')
  async updateInsight(
    @Param('id') id: string,
    @Body() data: { isFavorite?: boolean; pinned?: boolean; title?: string },
    @Request() req: any,
  ) {
    const tenantId = req.user.tenantId;

    // Ensure the insight belongs to the requester's tenant
    const insight = await this.prisma.insight.findFirst({
      where: { id, tenantId },
    });

    if (!insight) {
      throw new Error('Insight not found or access denied.');
    }

    return this.prisma.insight.update({
      where: { id },
      data,
    });
  }

  @Delete(':id')
  async deleteInsight(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user.tenantId;
    return this.prisma.insight.deleteMany({
      where: { id, tenantId },
    });
  }
}
