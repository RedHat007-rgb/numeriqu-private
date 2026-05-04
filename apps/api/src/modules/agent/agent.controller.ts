import {
  Body,
  Controller,
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
    const context = await this.organizationContext.ensureContext({
      id: user.id,
      email: user.email,
    }, { organizationId });
    return this.agentService.listSessions(context.organization.id, context.user.id);
  }

  @Get('sessions/:id')
  async session(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.organizationContext.ensureContext({
      id: user.id,
      email: user.email,
    }, { organizationId });
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

  @Get('dashboards/latest')
  async latestDashboard(
    @CurrentUser() user: AuthUser,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.organizationContext.ensureContext({
      id: user.id,
      email: user.email,
    }, { organizationId });
    return this.agentService.latestDashboard(context.organization.id, context.user.id);
  }

  @Get('metrics')
  async metrics(
    @CurrentUser() user: AuthUser,
    @Query('metric') metric: string,
    @Query('grouping') grouping: string,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.organizationContext.ensureContext({
      id: user.id,
      email: user.email,
    }, { organizationId });
    return this.agentService.metricData(
      context.organization.id,
      metric || 'revenue',
      grouping || 'month',
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

    const context = await this.organizationContext.ensureContext({
      id: user.id,
      email: user.email,
    }, { organizationId });

    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();

    try {
      for await (const chunk of this.agentService.query(
        context.organization.id,
        context.user.id,
        body.query,
        body.sessionId,
      )) {
        response.write(`data: ${chunk}\n`);
        (response as any).flush?.();
      }
    } finally {
      response.end();
    }
  }
}
