import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { CurrentUser } from '../../common/decorators/user.decorator';
import type { AuthUser } from '../../common/decorators/user.decorator';
import { OrganizationContextService } from '../org-context/org-context.service';
import { RagService } from './rag.service';
import { normalizePrismTone } from './prism-policy';
import { PrismQueryDto } from './prism-query.dto';

@Controller('rag')
@UseGuards(SupabaseAuthGuard)
export class RagController {
  constructor(
    private readonly organizationContext: OrganizationContextService,
    private readonly ragService: RagService,
  ) {}

  @Get('health')
  async health() {
    return this.ragService.health();
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
    return this.ragService.listSessions(
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
    const session = await this.ragService.getSession(
      context.organization.id,
      context.user.id,
      id,
    );
    if (!session) {
      throw new HttpException('Session not found.', HttpStatus.NOT_FOUND);
    }
    return session;
  }

  @Post('query')
  async query(
    @CurrentUser() user: AuthUser,
    @Body() body: PrismQueryDto,
    @Headers('x-organization-id') organizationId: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    if (!body?.query?.trim()) {
      throw new HttpException('Query is required.', HttpStatus.BAD_REQUEST);
    }
    if (body.query.length > 4_000) {
      throw new HttpException(
        'Query must be 4,000 characters or fewer.',
        HttpStatus.BAD_REQUEST,
      );
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

    const controller = new AbortController();
    const abort = () => controller.abort();
    request.once('aborted', abort);
    response.once('close', abort);

    try {
      for await (const chunk of this.ragService.query(
        context.organization.id,
        context.user.id,
        body.query,
        body.sessionId,
        normalizePrismTone(body.tone),
        controller.signal,
      )) {
        if (controller.signal.aborted || response.destroyed) break;
        response.write(`data: ${chunk}\n`);
        (response as any).flush?.();
      }
    } finally {
      request.off('aborted', abort);
      response.off('close', abort);
      if (!response.destroyed) response.end();
    }
  }
}
