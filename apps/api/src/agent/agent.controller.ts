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
import { OrganizationContextService } from '../modules/org-context/org-context.service';
import { PersistenceService } from '../common/services/persistence.service';

@Controller('agent')
export class AgentController {
  private readonly logger = new Logger(AgentController.name);

  constructor(
    private readonly agentService: AgentService,
    private readonly financialData: FinancialDataService,
    private readonly orgContext: OrganizationContextService,
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

    this.logger.log(
      `[Agent:SSE] tenant=${organization.id}: "${query.slice(0, 60)}"`,
    );

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    try {
      for await (const chunk of this.agentService.query(
        organization.id,
        user.id,
        query,
        body.sessionId,
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
          `data: ${JSON.stringify({ type: 'error', message: 'Analysis stream interrupted.' })}\n\n`,
        );
      } catch {
        /* connection dead */
      }
    } finally {
      res.end();
    }
  }

  @Get('metrics')
  @UseGuards(SupabaseAuthGuard)
  async getChartData(
    @CurrentUser() user: AuthUser,
    @Query('metric') metric: string,
    @Query('grouping') grouping: string,
  ) {
    const { organization } = await this.orgContext.ensureContext({
      id: user.id,
      email: user.email,
    });

    if (metric === 'venture') {
      const profile = await this.financialData.getFinancialProfile(
        organization.id,
      );
      return { data: profile.ventureMetrics };
    }

    if (metric === 'revenue' && grouping === 'org') {
      const profile = await this.financialData.getFinancialProfile(
        organization.id,
      );
      return {
        data: profile.connectedOrgs.map((org) => ({
          name: org.orgName,
          value: Math.round(org.totalRevenue),
        })),
      };
    }

    if (metric === 'invoices') {
      if (grouping === 'status') {
        const profile = await this.financialData.getFinancialProfile(
          organization.id,
        );
        const map = new Map<string, number>();
        for (const stat of profile.invoiceStats.byStatusAndOrg) {
          map.set(
            stat.status,
            (map.get(stat.status) ?? 0) + Math.abs(stat.totalAmount),
          );
        }
        return {
          data: Array.from(map.entries()).map(([name, value]) => ({
            name,
            value: Math.round(value),
          })),
        };
      }
      return {
        data: await this.financialData.getInvoicesList(organization.id),
      };
    }

    const trend = await this.financialData.getMonthlyRevenueTrend(
      organization.id,
    );
    const periods = new Map<string, any>();
    for (const t of trend) {
      const monthLabel =
        t.month.split('-')[1] + '/' + t.month.split('-')[0].slice(2);
      const existing = periods.get(monthLabel) || {
        name: monthLabel,
        value: 0,
      };
      if (grouping === 'org') {
        existing[t.org_name] = Math.abs(parseFloat(t.revenue) || 0);
      } else {
        existing.value += Math.abs(parseFloat(t.revenue) || 0);
      }
      periods.set(monthLabel, existing);
    }
    return { data: Array.from(periods.values()) };
  }

  @Get('health')
  async healthCheck() {
    const health = await this.agentService.healthCheck();
    return {
      ...health,
      status: health.ollama ? 'operational' : 'degraded',
      advisory: health.ollama
        ? `Agent ready. Model: ${health.engine}`
        : 'Ollama offline — check your Azure VM at ' +
          (process.env.OLLAMA_URL || 'http://localhost:11434'),
    };
  }

  @Get('sessions')
  @UseGuards(SupabaseAuthGuard)
  async listSessions(@CurrentUser() user: AuthUser) {
    const { organization } = await this.orgContext.ensureContext({
      id: user.id,
      email: user.email,
    });
    return this.persistence.listSessions(organization.id, user.id, 'agent');
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
      mode: 'agent',
    });
  }

  @Get('dashboards')
  @UseGuards(SupabaseAuthGuard)
  async listDashboards(@CurrentUser() user: AuthUser) {
    const { organization } = await this.orgContext.ensureContext({
      id: user.id,
      email: user.email,
    });
    return this.persistence.listDashboards(organization.id, user.id);
  }

  @Get('dashboards/latest')
  @UseGuards(SupabaseAuthGuard)
  async getLatestDashboard(@CurrentUser() user: AuthUser) {
    const { organization } = await this.orgContext.ensureContext({
      id: user.id,
      email: user.email,
    });
    const list = await this.persistence.listDashboards(
      organization.id,
      user.id,
    );
    if (list.length === 0) return null;
    return this.persistence.getDashboard(list[0].id, organization.id);
  }
}
