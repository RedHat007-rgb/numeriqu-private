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
  IsEmail,
  IsString,
  Length,
  IsBoolean,
  IsOptional,
  IsIn,
} from 'class-validator';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { CurrentUser } from '../../common/decorators/user.decorator';
import type { AuthUser } from '../../common/decorators/user.decorator';
import { OrganizationContextService } from '../org-context/org-context.service';
import { OrganizationService } from './organization.service';

class CreateInviteDto {
  @IsEmail()
  email!: string;

  @IsIn(['ADMIN', 'USER'])
  role!: 'ADMIN' | 'USER';

  @IsOptional()
  @IsBoolean()
  canViewDashboard?: boolean;

  @IsOptional()
  @IsBoolean()
  canCreateDashboard?: boolean;

  @IsOptional()
  @IsBoolean()
  canShareDashboard?: boolean;
}

class AcceptInviteDto {
  @IsString()
  @Length(20, 128)
  token!: string;
}

class PermissionDto {
  @IsIn(['VIEW_DASHBOARD', 'CREATE_DASHBOARD', 'SHARE_DASHBOARD'])
  permission!: 'VIEW_DASHBOARD' | 'CREATE_DASHBOARD' | 'SHARE_DASHBOARD';
}

@Controller('organizations')
@UseGuards(SupabaseAuthGuard)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }),
)
export class OrganizationController {
  constructor(
    private readonly orgContext: OrganizationContextService,
    private readonly organizationService: OrganizationService,
  ) {}

  @Get('current')
  async current(@CurrentUser() user: AuthUser) {
    const context = await this.orgContext.ensureContext({ id: user.id, email: user.email });
    return {
      organization: context.organization,
      membership: {
        id: context.membership.id,
        role: context.membership.role,
        canViewDashboard: context.membership.canViewDashboard,
        canCreateDashboard: context.membership.canCreateDashboard,
        canShareDashboard: context.membership.canShareDashboard,
      },
    };
  }

  @Get('members')
  async members(@CurrentUser() user: AuthUser) {
    const context = await this.orgContext.ensureContext({ id: user.id, email: user.email });
    return this.organizationService.listMembers(context.organization.id, context.user.id);
  }

  @Get('invites')
  async invites(@CurrentUser() user: AuthUser) {
    const context = await this.orgContext.ensureContext({ id: user.id, email: user.email });
    return this.organizationService.listInvites(context.organization.id, context.user.id);
  }

  @Post('invites')
  async createInvite(@CurrentUser() user: AuthUser, @Body() body: CreateInviteDto) {
    const context = await this.orgContext.ensureContext({ id: user.id, email: user.email });
    return this.organizationService.createInvite({
      organizationId: context.organization.id,
      invitedById: context.user.id,
      email: body.email,
      role: body.role,
      canViewDashboard: body.canViewDashboard,
      canCreateDashboard: body.canCreateDashboard,
      canShareDashboard: body.canShareDashboard,
    });
  }

  @Post('invites/:id/resend')
  @HttpCode(200)
  async resendInvite(@CurrentUser() user: AuthUser, @Param('id') inviteId: string) {
    const context = await this.orgContext.ensureContext({ id: user.id, email: user.email });
    return this.organizationService.resendInvite({
      organizationId: context.organization.id,
      inviteId,
      requesterId: context.user.id,
    });
  }

  @Delete('invites/:id')
  @HttpCode(200)
  async revokeInvite(@CurrentUser() user: AuthUser, @Param('id') inviteId: string) {
    const context = await this.orgContext.ensureContext({ id: user.id, email: user.email });
    return this.organizationService.revokeInvite({
      organizationId: context.organization.id,
      inviteId,
      requesterId: context.user.id,
    });
  }

  @Post('invites/accept')
  @HttpCode(200)
  async acceptInvite(@CurrentUser() user: AuthUser, @Body() body: AcceptInviteDto) {
    return this.organizationService.acceptInvite({
      token: body.token,
      userId: user.id,
      userEmail: user.email,
    });
  }

  @Patch('members/:membershipId/permissions')
  @HttpCode(200)
  async grantPermission(
    @CurrentUser() user: AuthUser,
    @Param('membershipId') membershipId: string,
    @Body() body: PermissionDto,
  ) {
    const context = await this.orgContext.ensureContext({ id: user.id, email: user.email });
    return this.organizationService.grantMembershipPermission({
      organizationId: context.organization.id,
      requesterId: context.user.id,
      membershipId,
      permission: body.permission,
    });
  }

  @Delete('members/:membershipId/permissions/:permission')
  @HttpCode(200)
  async revokePermission(
    @CurrentUser() user: AuthUser,
    @Param('membershipId') membershipId: string,
    @Param('permission') permission: 'VIEW_DASHBOARD' | 'CREATE_DASHBOARD' | 'SHARE_DASHBOARD',
  ) {
    const context = await this.orgContext.ensureContext({ id: user.id, email: user.email });
    return this.organizationService.revokeMembershipPermission({
      organizationId: context.organization.id,
      requesterId: context.user.id,
      membershipId,
      permission,
    });
  }
}
