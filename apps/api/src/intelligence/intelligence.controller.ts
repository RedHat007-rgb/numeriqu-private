import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  Res,
  Logger,
  HttpException,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { IntelligenceService } from './intelligence.service';
import { FinancialDataService } from './financial-data.service';
import { ContextCacheService } from './context-cache.service';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import type { AuthUser } from '../common/decorators/user.decorator';
import { UserProvisioningService } from '../common/services/user-provisioning.service';

@Controller('ai')
export class IntelligenceController {
  private readonly logger = new Logger(IntelligenceController.name);

  constructor(
    private readonly intelligence: IntelligenceService,
    private readonly financialData: FinancialDataService,
    private readonly provisioning: UserProvisioningService,
    private readonly contextCache: ContextCacheService,
  ) {}

  /**
   * POST /ai/query — Zero-latency SSE streaming endpoint
   *
   * SSE BEST PRACTICES (critical for flush behaviour):
   * - Content-Type: text/event-stream
   * - X-Accel-Buffering: no   (disables nginx buffering — MUST have this)
   * - res.flushHeaders()      (sends HTTP 200 + headers immediately)
   * We use raw \n-delimited JSON (not SSE `data:` prefix) for minimal overhead.
   * The client handles both formats via the cleanLine strip logic.
   */
  @Post('query')
  @UseGuards(SupabaseAuthGuard)
  async streamQuery(
    @CurrentUser() user: AuthUser,
    @Body() body: { query: string; mode?: 'advisor' | 'agent' },
    @Res() res: Response,
  ) {
    const { query, mode = 'advisor' } = body;
    if (!query?.trim()) {
      throw new HttpException('Query is required.', HttpStatus.BAD_REQUEST);
    }

    const { tenant } = await this.provisioning.ensureProvisioned(
      user.id,
      user.email,
    );
    this.logger.log(
      `[SSE] Stream (${mode}) for tenant=${tenant.id}: "${query.slice(0, 60)}"`,
    );

    // ... headers ...
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    try {
      for await (const chunk of this.intelligence.query(
        tenant.id,
        query,
        mode,
      )) {
        // Write as SSE `data:` frame — the `\n` at end of chunk is already there
        res.write(`data: ${chunk}\n`);
        // Force-flush the TCP buffer after EVERY chunk.
        // This is what makes streaming visible in real-time.
        (res as any).flush?.();
      }
    } catch (error: any) {
      this.logger.error(`[SSE] Stream error: ${error.message}`);
      try {
        res.write(
          `data: ${JSON.stringify({ type: 'error', message: 'Stream interrupted.' })}\n\n`,
        );
      } catch {
        /* client already gone */
      }
    } finally {
      res.end();
    }
  }

  /**
   * GET /ai/profile — Raw financial profile (no LLM)
   * Used by dashboards that want the structured data without chat overhead.
   */
  @Get('profile')
  @UseGuards(SupabaseAuthGuard)
  async getProfile(@CurrentUser() user: AuthUser) {
    const { tenant } = await this.provisioning.ensureProvisioned(
      user.id,
      user.email,
    );
    return this.financialData.getFinancialProfile(tenant.id);
  }

  /**
   * DELETE /ai/cache/:tenantId — Invalidate the in-memory cache
   * Call this after a sync completes to force fresh data on next query.
   */
  @Delete('cache/:tenantId')
  @UseGuards(SupabaseAuthGuard)
  async invalidateCache(
    @CurrentUser() user: AuthUser,
    @Param('tenantId') tenantId: string,
  ) {
    const { tenant } = await this.provisioning.ensureProvisioned(
      user.id,
      user.email,
    );
    // Only allow tenants to invalidate their own cache
    if (tenantId !== tenant.id) {
      throw new HttpException('Forbidden.', HttpStatus.FORBIDDEN);
    }
    this.contextCache.invalidate(tenantId);
    return { invalidated: true, tenantId };
  }

  /**
   * GET /ai/metrics — Chart-ready analytics data
   */
  @Get('metrics')
  @UseGuards(SupabaseAuthGuard)
  async getChartData(
    @CurrentUser() user: AuthUser,
    @Query('metric') metric: string,
    @Query('grouping') grouping: string,
  ) {
    const { tenant } = await this.provisioning.ensureProvisioned(
      user.id,
      user.email,
    );

    if (metric === 'venture') {
      const profile = await this.financialData.getFinancialProfile(tenant.id);
      return { data: profile.ventureMetrics };
    }

    if (metric === 'invoices') {
      const data = await this.financialData.getInvoicesList(tenant.id);
      return { data };
    }

    // In a production environment, this would call specialized ClickHouse aggregators.
    const trend = await this.financialData.getMonthlyRevenueTrend(tenant.id);

    // Format for Recharts: { name: 'Jan', value: 12000 }
    const formatted = trend.map((t: any) => ({
      name: t.month.split('-')[1] + '/' + t.month.split('-')[0].slice(2),
      value: Math.abs(parseFloat(t.revenue) || 0),
    }));

    return { data: formatted };
  }

  /**
   * GET /ai/health — AI engine health check
   * Returns Ollama status, model, latency, and cache stats.
   */
  @Get('health')
  async healthCheck() {
    const health = await this.intelligence.healthCheck();
    return {
      ...health,
      status: health.ollama ? 'operational' : 'degraded',
      advisory: health.ollama
        ? `Numeriqu Intelligence is ready. Mode: ${health.mode}`
        : 'Ollama offline — start with: ollama serve && ollama pull llama3.2:3b',
    };
  }
}
