import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { IsOptional, IsString, Length } from 'class-validator';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { CurrentUser } from '../../common/decorators/user.decorator';
import type { AuthUser } from '../../common/decorators/user.decorator';
import { OrganizationContextService } from '../org-context/org-context.service';
import { SignalIntelligenceService } from './signal-intelligence.service';

class CreateCommentDto {
  @IsString()
  @Length(2, 4000)
  content!: string;
}

class AssignSignalDto {
  @IsOptional()
  @IsString()
  assignedToUserId?: string | null;
}

class DismissSignalDto {
  @IsString()
  @Length(2, 500)
  reason!: string;
}

class BoardPackDto {
  @IsString()
  @Length(2, 160)
  title!: string;

  @IsString()
  @Length(2, 80)
  audience!: string;

  @IsOptional()
  @IsString()
  exportFormat?: string;
}

class WatchlistDto {
  @IsString()
  @Length(2, 140)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string | null;
}

@Controller('signal-intelligence')
@UseGuards(SupabaseAuthGuard)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }),
)
export class SignalIntelligenceController {
  constructor(
    private readonly orgContext: OrganizationContextService,
    private readonly signals: SignalIntelligenceService,
  ) {}

  @Get('signals')
  async listSignals(
    @CurrentUser() user: AuthUser,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.orgContext.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );
    return this.signals.listSignals(context.organization.id, context.user.id);
  }

  @Get('signals/:signalId')
  async getSignal(
    @CurrentUser() user: AuthUser,
    @Param('signalId') signalId: string,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.orgContext.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );
    return this.signals.getSignal(context.organization.id, context.user.id, signalId);
  }

  @Post('signals/:signalId/acknowledge')
  @HttpCode(200)
  async acknowledge(
    @CurrentUser() user: AuthUser,
    @Param('signalId') signalId: string,
    @Body() body: { note?: string },
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.orgContext.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );
    return this.signals.acknowledge(context.organization.id, context.user.id, signalId, body.note);
  }

  @Post('signals/:signalId/dismiss')
  @HttpCode(200)
  async dismiss(
    @CurrentUser() user: AuthUser,
    @Param('signalId') signalId: string,
    @Body() body: DismissSignalDto,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.orgContext.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );
    return this.signals.dismiss(context.organization.id, context.user.id, signalId, body.reason);
  }

  @Post('signals/:signalId/assign')
  @HttpCode(200)
  async assign(
    @CurrentUser() user: AuthUser,
    @Param('signalId') signalId: string,
    @Body() body: AssignSignalDto,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.orgContext.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );
    return this.signals.assign(
      context.organization.id,
      context.user.id,
      signalId,
      body.assignedToUserId ?? null,
    );
  }

  @Post('signals/:signalId/comments')
  async addComment(
    @CurrentUser() user: AuthUser,
    @Param('signalId') signalId: string,
    @Body() body: CreateCommentDto,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.orgContext.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );
    return this.signals.addComment(context.organization.id, context.user.id, signalId, body.content);
  }

  @Post('signals/:signalId/board-packs')
  async createBoardPack(
    @CurrentUser() user: AuthUser,
    @Param('signalId') signalId: string,
    @Body() body: BoardPackDto,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.orgContext.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );
    return this.signals.createBoardPack(context.organization.id, context.user.id, signalId, {
      title: body.title,
      audience: body.audience,
      exportFormat: body.exportFormat ?? 'json',
    });
  }

  @Get('board-packs')
  async listBoardPacks(
    @CurrentUser() user: AuthUser,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.orgContext.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );
    return this.signals.listBoardPacks(context.organization.id, context.user.id);
  }

  @Post('watchlists')
  async createWatchlist(
    @CurrentUser() user: AuthUser,
    @Body() body: WatchlistDto,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.orgContext.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );
    return this.signals.createWatchlist(context.organization.id, context.user.id, {
      name: body.name,
      description: body.description ?? null,
    });
  }

  @Get('watchlists')
  async listWatchlists(
    @CurrentUser() user: AuthUser,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.orgContext.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );
    return this.signals.listWatchlists(context.organization.id, context.user.id);
  }

  @Patch('recompute')
  @HttpCode(200)
  async recompute(
    @CurrentUser() user: AuthUser,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.orgContext.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );
    return this.signals.recompute(context.organization.id, context.user.id);
  }

  @Delete('watchlists/:watchlistId')
  @HttpCode(200)
  async deleteWatchlist(
    @CurrentUser() user: AuthUser,
    @Param('watchlistId') watchlistId: string,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.orgContext.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );
    return this.signals.deleteWatchlist(context.organization.id, context.user.id, watchlistId);
  }
}
