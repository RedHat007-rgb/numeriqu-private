import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { CurrentUser } from '../../common/decorators/user.decorator';
import type { AuthUser } from '../../common/decorators/user.decorator';
import { OrganizationContextService } from '../org-context/org-context.service';
import { AgentService } from './agent.service';

@Controller('agent')
@UseGuards(SupabaseAuthGuard)
export class AgentController {
  constructor(
    private readonly organizationContext: OrganizationContextService,
    private readonly agentService: AgentService,
  ) {}

  @Get('health')
  async health() {
    return this.agentService.health();
  }

  @Get('sessions')
  async sessions(
    @CurrentUser() user: AuthUser,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.organizationContext.ensureContext(
      {
        id: user.id,
        email: user.email,
      },
      { organizationId },
    );
    return this.agentService.listSessions(
      context.organization.id,
      context.user.id,
    );
  }

  @Get('sessions/:id')
  async session(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.organizationContext.ensureContext(
      {
        id: user.id,
        email: user.email,
      },
      { organizationId },
    );
    const session = await this.agentService.getSession(
      context.organization.id,
      context.user.id,
      id,
    );
    if (!session) {
      throw new HttpException('Session not found.', HttpStatus.NOT_FOUND);
    }
    return session;
  }

  @Get('sessions/:id/dashboard')
  async sessionDashboard(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.organizationContext.ensureContext(
      {
        id: user.id,
        email: user.email,
      },
      { organizationId },
    );
    return this.agentService.dashboardForSession(
      context.organization.id,
      context.user.id,
      id,
    );
  }

  @Get('dashboards/latest')
  async latestDashboard(
    @CurrentUser() user: AuthUser,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.organizationContext.ensureContext(
      {
        id: user.id,
        email: user.email,
      },
      { organizationId },
    );
    return this.agentService.latestDashboard(
      context.organization.id,
      context.user.id,
    );
  }

  @Get('dashboards/:id/session')
  async dashboardSession(
    @CurrentUser() user: AuthUser,
    @Param('id') dashboardId: string,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.organizationContext.ensureContext(
      {
        id: user.id,
        email: user.email,
      },
      { organizationId },
    );
    const result = await this.agentService.getDashboardSession(
      dashboardId,
      context.organization.id,
      context.user.id,
    );
    if (!result) {
      throw new HttpException(
        'Session not found for this dashboard.',
        HttpStatus.NOT_FOUND,
      );
    }
    return result;
  }

  @Delete('sessions/:sessionId/charts/:widgetId')
  async deleteSessionChart(
    @CurrentUser() user: AuthUser,
    @Param('sessionId') sessionId: string,
    @Param('widgetId') widgetId: string,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.organizationContext.ensureContext(
      {
        id: user.id,
        email: user.email,
      },
      { organizationId },
    );
    return this.agentService.deleteSessionChart(
      sessionId,
      context.organization.id,
      context.membership.role,
      widgetId,
    );
  }

  @Get('widgets/:widgetId/evidence')
  async widgetEvidence(
    @CurrentUser() user: AuthUser,
    @Param('widgetId') widgetId: string,
    @Query('category') category: string,
    @Query('series') series?: string,
    @Query('expected') expected?: string,
    @Query('orgId') orgId?: string,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.organizationContext.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );
    const expectedValue =
      expected != null && expected !== '' && Number.isFinite(Number(expected))
        ? Number(expected)
        : undefined;
    return this.agentService.getFigureEvidence(
      context.organization.id,
      context.membership.role,
      widgetId,
      String(category ?? ''),
      series ? String(series) : undefined,
      expectedValue,
      orgId ? String(orgId) : undefined,
    );
  }

  @Get('metrics')
  async metrics(
    @CurrentUser() user: AuthUser,
    @Query('metric') metric: string,
    @Query('grouping') grouping: string,
    @Query('providerHint') providerHint?: string,
    @Query('clientName') clientName?: string,
    @Query('clientNames') clientNamesRaw?: string,
    @Query('orgId') orgId?: string,
    @Query('breakdown') breakdown?: string,
    @Query('topN') topN?: string,
    @Query('rangeKind') rangeKind?: string,
    @Query('rangeValue') rangeValue?: string,
    @Query('rangeStart') rangeStart?: string,
    @Query('rangeEnd') rangeEnd?: string,
    @Query('widgetId') widgetId?: string,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.organizationContext.ensureContext(
      {
        id: user.id,
        email: user.email,
      },
      { organizationId },
    );

    const parsedRange = (() => {
      if (!rangeKind) return undefined;
      const kind = String(rangeKind);
      const n = rangeValue ? Number(rangeValue) : undefined;
      const start = rangeStart ? String(rangeStart) : undefined;
      const end = rangeEnd ? String(rangeEnd) : undefined;
      if (kind === 'LAST_N_DAYS' && Number.isFinite(n))
        return { kind, days: n as number };
      if (kind === 'LAST_N_WEEKS' && Number.isFinite(n))
        return { kind, weeks: n as number };
      if (kind === 'LAST_N_MONTHS' && Number.isFinite(n))
        return { kind, months: n as number };
      if (kind === 'LAST_N_QUARTERS' && Number.isFinite(n))
        return { kind, quarters: n as number };
      if (kind === 'LAST_N_YEARS' && Number.isFinite(n))
        return { kind, years: n as number };
      if (
        kind === 'ALL_TIME' ||
        kind === 'MTD' ||
        kind === 'QTD' ||
        kind === 'YTD'
      )
        return { kind };
      if (kind === 'SINCE_DATE' && start) return { kind, start };
      if (kind === 'BETWEEN_DATES' && start && end) return { kind, start, end };
      return undefined;
    })();

    const clientNames = (() => {
      if (!clientNamesRaw) return undefined;
      const raw = String(clientNamesRaw).trim();
      if (!raw) return undefined;
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed
            .map((v) => String(v ?? '').trim())
            .filter(Boolean)
            .slice(0, 5);
        }
      } catch {
        // Accept pipe/comma separated fallback.
        return raw
          .split(/\s*(?:\||,|;)\s*/g)
          .map((v) => v.trim())
          .filter(Boolean)
          .slice(0, 5);
      }
      return undefined;
    })();

    return this.agentService.metricData(
      context.organization.id,
      context.membership.role,
      metric || 'revenue',
      grouping || 'month',
      parsedRange as any,
      providerHint ? String(providerHint) : undefined,
      clientName ? String(clientName) : undefined,
      clientNames,
      orgId ? String(orgId) : undefined,
      breakdown ? String(breakdown) : undefined,
      topN ? Number(topN) : undefined,
      widgetId ? String(widgetId) : undefined,
    );
  }

  @Post('query')
  async query(
    @CurrentUser() user: AuthUser,
    @Body() body: { query: string; sessionId?: string },
    @Headers('x-organization-id') organizationId: string | undefined,
    @Res() response: Response,
  ) {
    if (!body?.query?.trim()) {
      throw new HttpException('Query is required.', HttpStatus.BAD_REQUEST);
    }

    const context = await this.organizationContext.ensureContext(
      {
        id: user.id,
        email: user.email,
      },
      { organizationId },
    );

    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();

    // Planning can spend longer than the browser's inactivity window inside a
    // model or catalog call before the async generator yields its first domain
    // event. Emit transport-only progress frames so every client/proxy can
    // distinguish active work from a dead connection. This carries no business
    // data and is shared by every organization and question.
    const configuredHeartbeat = Number(
      process.env.AGENT_STREAM_HEARTBEAT_MS ?? 10_000,
    );
    const heartbeatMs = Number.isFinite(configuredHeartbeat)
      ? Math.max(1_000, Math.min(25_000, configuredHeartbeat))
      : 10_000;
    const heartbeat = setInterval(() => {
      if (response.writableEnded || response.destroyed) return;
      response.write(
        `data: ${JSON.stringify({ type: 'heartbeat', at: new Date().toISOString() })}\n\n`,
      );
      (response as any).flush?.();
    }, heartbeatMs);

    try {
      for await (const chunk of this.agentService.query(
        context.organization.id,
        context.user.id,
        context.membership.role,
        body.query,
        body.sessionId,
      )) {
        response.write(`data: ${chunk}\n`);
        (response as any).flush?.();
      }
    } finally {
      clearInterval(heartbeat);
      response.end();
    }
  }
}
