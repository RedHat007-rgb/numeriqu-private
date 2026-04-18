import {
  Controller,
  Get,
  Post,
  Body,
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
  ) {}

  /**
   * POST /agent/query — SSE streaming for Agent strategic mode
   */
  @Post('query')
  @UseGuards(SupabaseAuthGuard)
  async streamQuery(
    @CurrentUser() user: AuthUser,
    @Body() body: { query: string; history?: { role: string; content: string }[] },
    @Res() res: Response,
  ) {
    const { query, history = [] } = body;
    if (!query?.trim()) {
      throw new HttpException('Query is required.', HttpStatus.BAD_REQUEST);
    }

    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);
    this.logger.log(`[Agent:SSE] Stream for tenant=${tenant.id}: "${query.slice(0, 60)}"`);

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    try {
      for await (const chunk of this.agentService.query(tenant.id, user.id, query, history)) {
        res.write(`data: ${chunk}\n`);
        (res as any).flush?.();
      }
    } catch (error: any) {
      this.logger.error(`[Agent:SSE] Stream error: ${error.message}`);
      try {
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'Strategic analysis interrupted. Please try again.' })}\n\n`);
      } catch { /* client already gone */ }
    } finally {
      res.end();
    }
  }

  /**
   * GET /agent/metrics — Chart-ready analytics data for agent-generated insights
   */
  @Get('metrics')
  @UseGuards(SupabaseAuthGuard)
  async getChartData(
    @CurrentUser() user: AuthUser,
    @Query('metric') metric: string,
    @Query('grouping') grouping: string,
  ) {
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);

    if (metric === 'venture') {
      const profile = await this.financialData.getFinancialProfile(tenant.id);
      return { data: profile.ventureMetrics };
    }

    if (metric === 'revenue' && grouping === 'org') {
      const profile = await this.financialData.getFinancialProfile(tenant.id);
      const data = profile.connectedOrgs.map(org => ({
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
        return { data: Array.from(map.entries()).map(([name, value]) => ({ name, value: Math.round(value) })) };
      }
      return { data: await this.financialData.getInvoicesList(tenant.id) };
    }

    // Default: time series trend
    const trend = await this.financialData.getMonthlyRevenueTrend(tenant.id);

    if (grouping === 'org') {
      // Multiple lines: map data into { name: 'Month', 'OrgA': 100, 'OrgB': 200 }
      const periods = new Map<string, any>();
      for (const t of trend) {
        const monthLabel = t.month.split('-')[1] + '/' + t.month.split('-')[0].slice(2);
        const existing = periods.get(monthLabel) || { name: monthLabel };
        existing[t.org_name] = Math.abs(parseFloat(t.revenue) || 0);
        periods.set(monthLabel, existing);
      }
      return { data: Array.from(periods.values()) };
    }

    // Default: Aggregate chronologically
    const periods = new Map<string, any>();
    for (const t of trend) {
      const monthLabel = t.month.split('-')[1] + '/' + t.month.split('-')[0].slice(2);
      const existing = periods.get(monthLabel) || { name: monthLabel, value: 0 };
      existing.value += Math.abs(parseFloat(t.revenue) || 0);
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
}
