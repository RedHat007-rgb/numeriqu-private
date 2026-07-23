import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser } from '../../common/decorators/user.decorator';
import type { AuthUser } from '../../common/decorators/user.decorator';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { OrganizationContextService } from '../org-context/org-context.service';
import { PrismJobsService } from './prism-jobs.service';

class CreatePrismBriefingDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4_000)
  prompt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  period?: string;
}

@Controller('rag/jobs')
@UseGuards(SupabaseAuthGuard)
export class PrismJobsController {
  constructor(
    private readonly organizations: OrganizationContextService,
    private readonly jobs: PrismJobsService,
  ) {}

  @Post('briefings')
  async createBriefing(
    @CurrentUser() user: AuthUser,
    @Body() body: CreatePrismBriefingDto,
    @Headers('x-organization-id') organizationId?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (!idempotencyKey?.trim() || idempotencyKey.length > 128) {
      throw new HttpException(
        'A valid Idempotency-Key header is required.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const context = await this.organizations.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );
    const job = await this.jobs.enqueue({
      organizationId: context.organization.id,
      userId: context.user.id,
      type: 'BRIEFING',
      idempotencyKey: idempotencyKey.trim(),
      payload: { prompt: body.prompt, period: body.period },
    });
    return { id: job.id, status: job.status, createdAt: job.createdAt };
  }

  @Get(':id')
  async getJob(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.organizations.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );
    const job = await this.jobs.get(
      context.organization.id,
      context.user.id,
      id,
    );
    if (!job) throw new HttpException('Job not found.', HttpStatus.NOT_FOUND);
    return job;
  }
}
