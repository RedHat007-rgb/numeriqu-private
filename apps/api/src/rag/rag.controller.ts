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
import { RagService } from './rag.service';
import { RagContextCacheService } from './rag-context-cache.service';
import { FinancialDataService } from '../financial-data/financial-data.service';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import type { AuthUser } from '../common/decorators/user.decorator';
import { UserProvisioningService } from '../common/services/user-provisioning.service';
import { PersistenceService } from '../common/services/persistence.service';

/**
 * RagController — SSE Streaming Endpoint for Personal Advisor
 *
 * ISOLATION: This controller ONLY handles RAG queries.
 * Agent queries go to /agent/query via AgentController.
 */
@Controller('rag')
export class RagController {
  private readonly logger = new Logger(RagController.name);

  constructor(
    private readonly ragService: RagService,
    private readonly financialData: FinancialDataService,
    private readonly provisioning: UserProvisioningService,
    private readonly contextCache: RagContextCacheService,
    private readonly persistence: PersistenceService,
  ) {}

  /**
   * POST /rag/query — Zero-latency SSE streaming for RAG advisor mode
   */
  @Post('query')
  @UseGuards(SupabaseAuthGuard)
  async streamQuery(
    @CurrentUser() user: AuthUser,
    @Body()
    body: { query: string; history?: { role: string; content: string }[] },
    @Res() res: Response,
  ) {
    const { query, history = [] } = body;
    if (!query?.trim()) {
      throw new HttpException('Query is required.', HttpStatus.BAD_REQUEST);
    }

    const { tenant } = await this.provisioning.ensureProvisioned(
      user.id,
      user.email,
    );
    this.logger.log(
      `[RAG:SSE] Stream for tenant=${tenant.id}: "${query.slice(0, 60)}"`,
    );

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    try {
      const sessionId = (body as any).sessionId;
      for await (const chunk of this.ragService.query(
        tenant.id,
        user.id,
        query,
        sessionId,
      )) {
        res.write(`data: ${chunk}\n`);
        (res as any).flush?.();
      }
    } catch (error: any) {
      this.logger.error(`[RAG:SSE] Stream error: ${error.message}`);
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
   * GET /rag/profile — Raw financial profile
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
   * DELETE /rag/cache/:tenantId — Invalidate the RAG context cache
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
    if (tenantId !== tenant.id) {
      throw new HttpException('Forbidden.', HttpStatus.FORBIDDEN);
    }
    this.contextCache.invalidate(tenantId);
    return { invalidated: true, tenantId };
  }

  /**
   * GET /rag/health — RAG layer health check
   */
  @Get('health')
  async healthCheck() {
    const health = await this.ragService.healthCheck();
    return {
      ...health,
      status: health.ollama ? 'operational' : 'degraded',
      advisory: health.ollama
        ? `RAG Advisor is ready. Mode: ${health.mode}`
        : 'Ollama offline — start with: ollama serve && ollama pull llama3.2:3b',
    };
  }

  /**
   * GET /rag/sessions — List historical RAG sessions
   */
  @Get('sessions')
  @UseGuards(SupabaseAuthGuard)
  async listSessions(@CurrentUser() user: AuthUser) {
    const { tenant } = await this.provisioning.ensureProvisioned(
      user.id,
      user.email,
    );
    return this.persistence.listSessions(tenant.id, user.id, 'rag');
  }

  /**
   * GET /rag/sessions/:id — Retrieve a specific RAG session
   */
  @Get('sessions/:id')
  @UseGuards(SupabaseAuthGuard)
  async getSession(
    @CurrentUser() user: AuthUser,
    @Param('id') sessionId: string,
  ) {
    const { tenant } = await this.provisioning.ensureProvisioned(
      user.id,
      user.email,
    );
    return this.persistence.getOrCreateSession({
      tenantId: tenant.id,
      userId: user.id,
      sessionId,
      mode: 'rag',
    });
  }
}
