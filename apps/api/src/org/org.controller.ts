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
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import type { AuthUser } from '../common/decorators/user.decorator';
import { UserProvisioningService } from '../common/services/user-provisioning.service';
import { OrgService } from './org.service';

@Controller('org')
export class OrgController {
  constructor(
    private readonly orgService: OrgService,
    private readonly provisioning: UserProvisioningService,
  ) {}

  /**
   * GET /org/organizations
   * List all organizations (= connections) for this tenant.
   * All roles can call this; members see only their scoped orgs (via connections controller).
   */
  @Get('organizations')
  @UseGuards(SupabaseAuthGuard)
  async listOrganizations(@CurrentUser() user: AuthUser) {
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);
    return this.orgService.listOrganizations(tenant.id);
  }

  /**
   * GET /org/organizations/:id
   * Get one organization with full member list + pending invites.
   * Only owner/admin can see the full member list and invites.
   */
  @Get('organizations/:id')
  @UseGuards(SupabaseAuthGuard)
  async getOrganization(
    @CurrentUser() user: AuthUser,
    @Param('id') connectionId: string,
  ) {
    const { tenant, user: dbUser } = await this.provisioning.ensureProvisioned(user.id, user.email);
    if (dbUser.role === 'member') throw new ForbiddenException('Admins and owners only.');
    return this.orgService.getOrganization(tenant.id, connectionId);
  }

  /**
   * POST /org/organizations/:id/invite
   * Invite a user by email to a specific organization.
   * Body: { email: string; role?: 'admin' | 'member' }
   */
  @Post('organizations/:id/invite')
  @UseGuards(SupabaseAuthGuard)
  async inviteToOrganization(
    @CurrentUser() user: AuthUser,
    @Param('id') connectionId: string,
    @Body() body: { email: string; role?: 'admin' | 'member' },
  ) {
    const { tenant, user: dbUser } = await this.provisioning.ensureProvisioned(user.id, user.email);
    if (dbUser.role === 'member') throw new ForbiddenException('Admins and owners only.');
    return this.orgService.inviteToOrganization(
      tenant.id,
      connectionId,
      user.email,
      body.email,
      body.role ?? 'member',
    );
  }

  /**
   * DELETE /org/organizations/:id/members/:userId
   * Remove a member from a specific organization.
   */
  @Delete('organizations/:id/members/:userId')
  @UseGuards(SupabaseAuthGuard)
  async removeMember(
    @CurrentUser() user: AuthUser,
    @Param('id') connectionId: string,
    @Param('userId') targetUserId: string,
  ) {
    const { tenant, user: dbUser } = await this.provisioning.ensureProvisioned(user.id, user.email);
    await this.orgService.removeMember(tenant.id, connectionId, targetUserId, dbUser.role);
    return { status: 'success' };
  }

  /**
   * GET /org/invite/:token
   * Public — returns invite metadata for the accept page (no auth required).
   */
  @Get('invite/:token')
  async getInvite(@Param('token') token: string) {
    return this.orgService.getInviteDetails(token);
  }

  /**
   * POST /org/invite/:token/accept
   * Accept an invite. The caller must be authenticated as the invited email.
   * Query param: ?org=<connectionId>
   */
  @Post('invite/:token/accept')
  @UseGuards(SupabaseAuthGuard)
  async acceptInvite(
    @CurrentUser() user: AuthUser,
    @Param('token') token: string,
    @Query('org') connectionId: string,
  ) {
    return this.orgService.acceptInvite(token, connectionId, user.id, user.email);
  }
}
