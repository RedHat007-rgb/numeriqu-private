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
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import type { Response } from 'express';
import { RagService } from './rag.service';
import { RagContextCacheService } from './rag-context-cache.service';
import { FinancialDataService } from '../financial-data/financial-data.service';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermission } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/user.decorator';
import type { AuthUser } from '../common/decorators/user.decorator';
import { UserProvisioningService } from '../common/services/user-provisioning.service';
import { AuditLogService } from '../common/services/audit-log.service';
import { PersistenceService } from '../common/services/persistence.service';
import { prisma } from '@repo/db';

/**
 * RagController — SSE Streaming RAG Advisor
 *
 * ISOLATION: This controller ONLY handles RAG queries.
 * Agent queries go to /agent/* via AgentController.
 *
 * SCOPE ENFORCEMENT:
 *   - Admin: can query across all connected orgs (no connectionId required)
 *   - Member (canQueryRag=true): can only query their granted connections
 *     If a connectionId is provided in body, it is verified against org_memberships.
 */
@Controller('rag')
@UseGuards(SupabaseAuthGuard, PermissionsGuard)
@RequirePermission('canQueryRag')
export class RagController {
  private readonly logger = new Logger(RagController.name);

  constructor(
    private readonly ragService: RagService,
    private readonly financialData: FinancialDataService,
    private readonly provisioning: UserProvisioningService,
    private readonly auditLog: AuditLogService,
    private readonly contextCache: RagContextCacheService,
    private readonly persistence: PersistenceService,
  ) {}

  /**
   * POST /rag/query — SSE streaming RAG advisor
   *
   * Body: { query: string, sessionId?: string, connectionId?: string }
   * If connectionId is provided, the query is scoped to that org only.
   * Members MUST provide a connectionId they have access to.
   * Admins can omit connectionId to query across all connected orgs.
   */
  @Post('query')
  async streamQuery(
    @CurrentUser() user: AuthUser,
    @Body()
    body: {
      query: string;
      history?: { role: string; content: string }[];
      sessionId?: string;
      connectionId?: string;
    },
    @Res() res: Response,
  ) {
    const { query } = body;
    if (!query?.trim()) {
      throw new BadRequestException('Query is required.');
    }

    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);

    // Scope enforcement for members
    if (user.role === 'member') {
      if (!body.connectionId) {
        throw new ForbiddenException(
          'Please select an ERP organization to query. You must specify a connectionId.',
        );
      }
      const membership = await prisma.orgMembership.findFirst({
        where: {
          userId: user.id,
          connectionId: body.connectionId,
          tenantId: tenant.id,
        },
      });
      if (!membership) {
        throw new ForbiddenException(
          'You do not have access to this ERP organization. Contact your admin.',
        );
      }
    }

    this.logger.log(
      `[RAG] Query from ${user.role} tenant=${tenant.id}: "${query.slice(0, 60)}"`,
    );

    this.auditLog.logAsync({
      tenantId: tenant.id,
      userId: user.id,
      action: 'chat.session_started',
      resource: 'chat_session',
      metadata: { mode: 'rag', connectionId: body.connectionId ?? null },
    });

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    try {
      for await (const chunk of this.ragService.query(
        tenant.id,
        user.id,
        query,
        body.sessionId,
      )) {
        res.write(`data: ${chunk}\n`);
        (res as any).flush?.();
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Stream error';
      this.logger.error(`[RAG] Stream error: ${msg}`);
      try {
        res.write(
          `data: ${JSON.stringify({ type: 'error', message: 'Query stream interrupted. Please try again.' })}\n\n`,
        );
      } catch {
        /* client already disconnected */
      }
    } finally {
      res.end();
    }
  }

  /**
   * GET /rag/profile — Raw financial profile (admin only for cross-org view)
   */
  @Get('profile')
  async getProfile(@CurrentUser() user: AuthUser) {
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);
    return this.financialData.getFinancialProfile(tenant.id);
  }

  /**
   * GET /rag/sessions — List historical RAG sessions for this user
   */
  @Get('sessions')
  async listSessions(@CurrentUser() user: AuthUser) {
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);
    return this.persistence.listSessions(tenant.id, user.id, 'rag');
  }

  /**
   * GET /rag/sessions/:id — Retrieve a specific RAG session with messages
   */
  @Get('sessions/:id')
  async getSession(@CurrentUser() user: AuthUser, @Param('id') sessionId: string) {
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);
    return this.persistence.getOrCreateSession({
      tenantId: tenant.id,
      userId: user.id,
      sessionId,
      mode: 'rag',
    });
  }

  /**
   * DELETE /rag/cache/:tenantId — Invalidate the RAG context cache
   */
  @Delete('cache/:tenantId')
  async invalidateCache(
    @CurrentUser() user: AuthUser,
    @Param('tenantId') tenantId: string,
  ) {
    if (user.role !== 'admin') {
      throw new ForbiddenException('Only admins can invalidate the RAG cache.');
    }
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);
    if (tenantId !== tenant.id) {
      throw new HttpException('Forbidden.', HttpStatus.FORBIDDEN);
    }
    this.contextCache.invalidate(tenantId);
    return { invalidated: true, tenantId };
  }

  /**
   * GET /rag/health — RAG layer health check (public)
   */
  @Get('health')
  @UseGuards() // override class-level guard — health is public
  async healthCheck() {
    const health = await this.ragService.healthCheck();
    return {
      ...health,
      status: health.ollama ? 'operational' : 'degraded',
      advisory: health.ollama
        ? `RAG Advisor ready. Mode: ${health.mode}`
        : 'Ollama offline — run: ollama serve && ollama pull llama3.2:3b',
    };
  }
}
