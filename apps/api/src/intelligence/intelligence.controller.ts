import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
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
    @Body() body: { query: string },
    @Res() res: Response,
  ) {
    const { query } = body;
    if (!query?.trim()) {
      throw new HttpException('Query is required.', HttpStatus.BAD_REQUEST);
    }

    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);
    this.logger.log(`[SSE] Stream for tenant=${tenant.id}: "${query.slice(0, 60)}"`);

    // ── SSE HEADERS ──────────────────────────────────────────────────────────
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');  // Disable nginx/proxy buffering
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
    res.flushHeaders(); // ← Sends HTTP 200 to client immediately (before any data)

    const closeHandler = () => {
      this.logger.debug(`[SSE] Client disconnected for tenant=${tenant.id}`);
    };
    res.on('close', closeHandler);

    try {
      for await (const chunk of this.intelligence.query(tenant.id, query)) {
        // Write as SSE `data:` frame — the `\n` at end of chunk is already there
        res.write(`data: ${chunk}\n`);
        // Force-flush the TCP buffer after EVERY chunk.
        // This is what makes streaming visible in real-time.
        (res as any).flush?.();
      }
    } catch (error: any) {
      this.logger.error(`[SSE] Stream error: ${error.message}`);
      try {
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'Stream interrupted.' })}\n\n`);
      } catch { /* client already gone */ }
    } finally {
      res.removeListener('close', closeHandler);
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
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);
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
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);
    // Only allow tenants to invalidate their own cache
    if (tenantId !== tenant.id) {
      throw new HttpException('Forbidden.', HttpStatus.FORBIDDEN);
    }
    this.contextCache.invalidate(tenantId);
    return { invalidated: true, tenantId };
  }

  /**
   * GET /ai/health — AI engine health check
   * Returns Ollama status, model, latency, and cache stats.
   */
  @Get('health')
  async healthCheck() {
    const health = await this.intelligence.healthCheck();
    return {
      status:   health.ollama ? 'operational' : 'degraded',
      ...health,
      advisory: health.ollama
        ? `Numeriqu Intelligence is ready. Mode: ${health.mode}`
        : 'Ollama offline — start with: ollama serve && ollama pull llama3.2:3b',
    };
  }
}
