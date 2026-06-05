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
import { OrganizationContextService } from '../modules/org-context/org-context.service';
import { PersistenceService } from '../common/services/persistence.service';

@Controller('rag')
export class RagController {
  private readonly logger = new Logger(RagController.name);

  constructor(
    private readonly ragService: RagService,
    private readonly financialData: FinancialDataService,
    private readonly orgContext: OrganizationContextService,
    private readonly contextCache: RagContextCacheService,
    private readonly persistence: PersistenceService,
  ) {}

  @Post('query')
  @UseGuards(SupabaseAuthGuard)
  async streamQuery(
    @CurrentUser() user: AuthUser,
    @Body() body: { query: string; sessionId?: string },
    @Res() res: Response,
  ) {
    const { query } = body;
    if (!query?.trim()) {
      throw new HttpException('Query is required.', HttpStatus.BAD_REQUEST);
    }

    const { organization } = await this.orgContext.ensureContext({
      id: user.id,
      email: user.email,
    });

    this.logger.log(`[RAG:SSE] tenant=${organization.id}: "${query.slice(0, 60)}"`);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    try {
      for await (const chunk of this.ragService.query(
        organization.id,
        user.id,
        query,
        body.sessionId,
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
      } catch { /* client already gone */ }
    } finally {
      res.end();
    }
  }

  @Get('profile')
  @UseGuards(SupabaseAuthGuard)
  async getProfile(@CurrentUser() user: AuthUser) {
    const { organization } = await this.orgContext.ensureContext({
      id: user.id,
      email: user.email,
    });
    return this.financialData.getFinancialProfile(organization.id);
  }

  @Delete('cache/:tenantId')
  @UseGuards(SupabaseAuthGuard)
  async invalidateCache(
    @CurrentUser() user: AuthUser,
    @Param('tenantId') tenantId: string,
  ) {
    const { organization } = await this.orgContext.ensureContext({
      id: user.id,
      email: user.email,
    });
    if (tenantId !== organization.id) {
      throw new HttpException('Forbidden.', HttpStatus.FORBIDDEN);
    }
    this.contextCache.invalidate(tenantId);
    return { invalidated: true, tenantId };
  }

  @Get('health')
  async healthCheck() {
    const health = await this.ragService.healthCheck();
    const backendLabel = health.provider === 'openai' ? 'OpenAI' : 'Ollama';
    return {
      ...health,
      status: health.ollama ? 'operational' : 'degraded',
      advisory: health.ollama
        ? `RAG Advisor ready. Model: ${health.engine}`
        : `${backendLabel} offline — check ${health.backendUrl}`,
    };
  }

  @Get('sessions')
  @UseGuards(SupabaseAuthGuard)
  async listSessions(@CurrentUser() user: AuthUser) {
    const { organization } = await this.orgContext.ensureContext({
      id: user.id,
      email: user.email,
    });
    return this.persistence.listSessions(organization.id, user.id, 'rag');
  }

  @Get('sessions/:id')
  @UseGuards(SupabaseAuthGuard)
  async getSession(
    @CurrentUser() user: AuthUser,
    @Param('id') sessionId: string,
  ) {
    const { organization } = await this.orgContext.ensureContext({
      id: user.id,
      email: user.email,
    });
    return this.persistence.getOrCreateSession({
      tenantId: organization.id,
      userId: user.id,
      sessionId,
      mode: 'rag',
    });
  }
}
