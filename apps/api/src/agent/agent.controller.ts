import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Res,
  Query,
  Logger,
  HttpException,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AgentService } from './agent.service';
import { FinancialDataService } from '../financial-data/financial-data.service';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import type { AuthUser } from '../common/decorators/user.decorator';
import { UserProvisioningService } from '../common/services/user-provisioning.service';
import { PersistenceService } from '../common/services/persistence.service';

/**
 * AgentController — SSE Streaming Endpoint for Strategic Agent
 *
 * ISOLATION: This controller ONLY handles Agent (strategic) queries.
 * RAG queries go to /rag/query via RagController.
 */
@Controller('agent')
export class AgentController {
  private readonly logger = new Logger(AgentController.name);

  constructor(
    private readonly agentService: AgentService,
    private readonly financialData: FinancialDataService,
    private readonly provisioning: UserProvisioningService,
    private readonly persistence: PersistenceService,
  ) {
    this.logger.log('AgentController initialized with Strategist V2 routes');
  }

  /**
   * POST /agent/query — SSE streaming for Agent strategic mode
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
      `[Agent:SSE] Stream for tenant=${tenant.id}: "${query.slice(0, 60)}"`,
    );

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    try {
      const sessionId = (body as any).sessionId;
      for await (const chunk of this.agentService.query(
        tenant.id,
        user.id,
        query,
        sessionId,
      )) {
        res.write(`data: ${chunk}\n`);
        (res as any).flush?.();
      }
    } catch (error: any) {
      this.logger.error(
        `[Agent:SSE:Fatal] Stream crashed: ${error.message}`,
        error.stack,
      );
      try {
        res.write(
          `data: ${JSON.stringify({
            type: 'error',
            message:
              'Analysis stream was interrupted due to technical turbulence.',
          })}\n\n`,
        );
      } catch {
        /* connection dead */
      }
    } finally {
      res.end();
    }
  }

  /**
   * GET /agent/metrics — Chart-ready analytics data
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

    if (metric === 'revenue' && grouping === 'org') {
      const profile = await this.financialData.getFinancialProfile(tenant.id);
      const data = profile.connectedOrgs.map((org) => ({
        name: org.orgName,
        value: Math.round(org.totalRevenue),
      }));
      return { data };
    }

    if (metric === 'invoices') {
      if (grouping === 'status') {
        const profile = await this.financialData.getFinancialProfile(tenant.id);
        const map = new Map();
        for (const stat of profile.invoiceStats.byStatusAndOrg) {
          const existing = map.get(stat.status) || 0;
          map.set(stat.status, existing + Math.abs(stat.totalAmount));
        }
        return {
          data: Array.from(map.entries()).map(([name, value]) => ({
            name,
            value: Math.round(value),
          })),
        };
      }
      return { data: await this.financialData.getInvoicesList(tenant.id) };
    }

    const trend = await this.financialData.getMonthlyRevenueTrend(tenant.id);
    const periods = new Map<string, any>();
    for (const t of trend) {
      const monthLabel =
        t.month.split('-')[1] + '/' + t.month.split('-')[0].slice(2);
      const existing = periods.get(monthLabel) || { name: monthLabel, value: 0 };
      if (grouping === 'org') {
        existing[t.org_name] = Math.abs(parseFloat(t.revenue) || 0);
      } else {
        existing.value += Math.abs(parseFloat(t.revenue) || 0);
      }
      periods.set(monthLabel, existing);
    }
    return { data: Array.from(periods.values()) };
  }

  /**
   * GET /agent/health — Agent layer health check
   */
  @Get('health')
  async healthCheck() {
    const health = await this.agentService.healthCheck();
    return {
      ...health,
      status: health.ollama ? 'operational' : 'degraded',
      advisory: health.ollama
        ? `Strategic Agent is ready. Mode: ${health.mode}`
        : 'Ollama offline — start with: ollama serve && ollama pull llama3.2:3b',
    };
  }

  /**
   * GET /agent/sessions — List historical Agent sessions
   */
  @Get('sessions')
  @UseGuards(SupabaseAuthGuard)
  async listSessions(@CurrentUser() user: AuthUser) {
    const { tenant } = await this.provisioning.ensureProvisioned(
      user.id,
      user.email,
    );
    return this.persistence.listSessions(tenant.id, user.id, 'agent');
  }

  /**
   * GET /agent/sessions/:id — Retrieve a specific Agent session
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
      mode: 'agent',
    });
  }

  /**
   * GET /agent/dashboards — List available dashboards
   */
  @Get('dashboards')
  @UseGuards(SupabaseAuthGuard)
  async listDashboards(@CurrentUser() user: AuthUser) {
    const { tenant } = await this.provisioning.ensureProvisioned(
      user.id,
      user.email,
    );
    return this.persistence.listDashboards(tenant.id, user.id);
  }

  /**
   * GET /agent/dashboards/latest — Get the current operational dashboard for sync
   */
  @Get('dashboards/latest')
  @UseGuards(SupabaseAuthGuard)
  async getLatestDashboard(@CurrentUser() user: AuthUser) {
    const { tenant } = await this.provisioning.ensureProvisioned(
      user.id,
      user.email,
    );
    const list = await this.persistence.listDashboards(tenant.id, user.id);
    if (list.length === 0) return null;
    return this.persistence.getDashboard(list[0].id, tenant.id);
  }
}
