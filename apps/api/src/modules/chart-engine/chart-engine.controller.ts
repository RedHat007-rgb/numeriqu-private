import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
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
import { ChartEngineService } from './chart-engine.service';

class IntrospectDto {
  @IsString()
  @Length(1, 60)
  kind!: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  tablePattern?: string;
}

@Controller('chart-engine')
@UseGuards(SupabaseAuthGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class ChartEngineController {
  constructor(
    private readonly orgContext: OrganizationContextService,
    private readonly engine: ChartEngineService,
  ) {}

  /** Admin-triggered: (re)introspect the dataset and build/persist its model. */
  @Post('introspect')
  @HttpCode(200)
  async introspect(
    @CurrentUser() user: AuthUser,
    @Body() body: IntrospectDto,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.orgContext.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );
    return this.engine.introspectAndBuildModel(context.organization.id, context.user.id, {
      kind: body.kind,
      ...(body.tablePattern ? { tablePattern: body.tablePattern } : {}),
    });
  }

  /** Read the active derived semantic model for an org+kind. */
  @Get('model')
  async getModel(
    @CurrentUser() user: AuthUser,
    @Query('kind') kind: string,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.orgContext.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );
    return this.engine.getActiveModel(context.organization.id, kind || 'default');
  }
}
