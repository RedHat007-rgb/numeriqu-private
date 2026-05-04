import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { CurrentUser } from '../../common/decorators/user.decorator';
import type { AuthUser } from '../../common/decorators/user.decorator';
import { OrganizationContextService } from '../org-context/org-context.service';
import { DashboardService } from './dashboard.service';

class ChartDto {
  @IsString()
  @Length(2, 120)
  title!: string;

  @IsString()
  type!: string;

  @IsObject()
  queryConfig!: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  chartConfig?: Record<string, unknown>;
}

class CreateDashboardDto {
  @IsString()
  @Length(2, 160)
  title!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  permissions?: Record<string, unknown>;

  @IsArray()
  @ArrayMinSize(4)
  @ValidateNested({ each: true })
  @Type(() => ChartDto)
  charts!: ChartDto[];
}

class ShareDashboardDto {
  @IsString()
  sharedWithUserId!: string;

  @IsBoolean()
  canEdit!: boolean;
}

@Controller('dashboards')
@UseGuards(SupabaseAuthGuard)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }),
)
export class DashboardController {
  constructor(
    private readonly orgContext: OrganizationContextService,
    private readonly dashboardService: DashboardService,
  ) {}

  @Get()
  async list(@CurrentUser() user: AuthUser) {
    const context = await this.orgContext.ensureContext({ id: user.id, email: user.email });
    return this.dashboardService.list(context.organization.id, context.user.id);
  }

  @Get(':id')
  async getById(@CurrentUser() user: AuthUser, @Param('id') dashboardId: string) {
    const context = await this.orgContext.ensureContext({ id: user.id, email: user.email });
    return this.dashboardService.getById(context.organization.id, context.user.id, dashboardId);
  }

  @Post()
  async create(@CurrentUser() user: AuthUser, @Body() body: CreateDashboardDto) {
    const context = await this.orgContext.ensureContext({ id: user.id, email: user.email });
    return this.dashboardService.create({
      organizationId: context.organization.id,
      ownerId: context.user.id,
      title: body.title,
      description: body.description,
      config: body.config,
      permissions: body.permissions,
      charts: body.charts,
    });
  }

  @Patch(':id/refresh')
  @HttpCode(200)
  async refresh(@CurrentUser() user: AuthUser, @Param('id') dashboardId: string) {
    const context = await this.orgContext.ensureContext({ id: user.id, email: user.email });
    return this.dashboardService.refresh(context.organization.id, context.user.id, dashboardId);
  }

  @Post(':id/share')
  @HttpCode(200)
  async share(
    @CurrentUser() user: AuthUser,
    @Param('id') dashboardId: string,
    @Body() body: ShareDashboardDto,
  ) {
    const context = await this.orgContext.ensureContext({ id: user.id, email: user.email });
    return this.dashboardService.share({
      organizationId: context.organization.id,
      requesterId: context.user.id,
      dashboardId,
      sharedWithUserId: body.sharedWithUserId,
      canEdit: body.canEdit,
    });
  }

  @Delete(':id/share/:userId')
  @HttpCode(200)
  async unshare(
    @CurrentUser() user: AuthUser,
    @Param('id') dashboardId: string,
    @Param('userId') sharedWithUserId: string,
  ) {
    const context = await this.orgContext.ensureContext({ id: user.id, email: user.email });
    return this.dashboardService.unshare({
      organizationId: context.organization.id,
      requesterId: context.user.id,
      dashboardId,
      sharedWithUserId,
    });
  }
}
