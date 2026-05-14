import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  UseGuards,
  ForbiddenException,
  Query,
  Headers,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import type { AuthUser } from '../common/decorators/user.decorator';
import { OrganizationContextService } from '../modules/org-context/org-context.service';
import { OrgService } from './org.service';

@Controller('org')
export class OrgController {
  constructor(
    private readonly orgService: OrgService,
    private readonly orgContext: OrganizationContextService,
  ) {}

  @Get('organizations')
  @UseGuards(SupabaseAuthGuard)
  async listOrganizations(
    @CurrentUser() user: AuthUser,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const ctx = await this.orgContext.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );
    return this.orgService.listOrganizations(ctx.organization.id);
  }

  @Get('organizations/:id')
  @UseGuards(SupabaseAuthGuard)
  async getOrganization(
    @CurrentUser() user: AuthUser,
    @Param('id') connectionId: string,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const ctx = await this.orgContext.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );
    if (ctx.membership.role !== 'ADMIN') throw new ForbiddenException('Admins only.');
    return this.orgService.getOrganization(ctx.organization.id, connectionId);
  }

  @Post('organizations/:id/invite')
  @UseGuards(SupabaseAuthGuard)
  async inviteToOrganization(
    @CurrentUser() user: AuthUser,
    @Param('id') connectionId: string,
    @Body() body: { email: string; role?: 'admin' | 'member' },
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const ctx = await this.orgContext.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );
    if (ctx.membership.role !== 'ADMIN') throw new ForbiddenException('Admins only.');
    return this.orgService.inviteToOrganization(
      ctx.organization.id,
      ctx.user.id,
      user.email,
      body.email,
      body.role ?? 'member',
    );
  }

  @Delete('organizations/:id/members/:userId')
  @UseGuards(SupabaseAuthGuard)
  async removeMember(
    @CurrentUser() user: AuthUser,
    @Param('userId') targetUserId: string,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const ctx = await this.orgContext.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );
    await this.orgService.removeMember(ctx.organization.id, targetUserId, ctx.membership.role);
    return { status: 'success' };
  }

  @Get('invite/:token')
  async getInvite(@Param('token') token: string) {
    return this.orgService.getInviteDetails(token);
  }

  @Post('invite/:token/accept')
  @UseGuards(SupabaseAuthGuard)
  async acceptInvite(
    @CurrentUser() user: AuthUser,
    @Param('token') token: string,
    @Query('org') organizationId: string,
  ) {
    return this.orgService.acceptInvite(token, organizationId, user.id, user.email);
  }
}
