import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/user.decorator';
import type { AuthUser } from '../common/decorators/user.decorator';
import { UserPermissionsService } from '../common/services/user-permissions.service';
import { OrgService } from './org.service';

/**
 * OrgController — Organization management endpoints.
 *
 * All routes require authentication (SupabaseAuthGuard).
 * Admin-only routes are additionally guarded by RolesGuard.
 *
 * Base: /org
 */
@Controller('org')
@UseGuards(SupabaseAuthGuard)
export class OrgController {
  constructor(
    private readonly orgService: OrgService,
    private readonly userPermissions: UserPermissionsService,
  ) {}

  // ─── MEMBERS ─────────────────────────────────────────────────────────────

  /**
   * GET /org/members
   * List all members of the authenticated user's organization.
   * Admin: sees all members with full detail.
   * Member: sees list but without permission detail (future scope).
   */
  @Get('members')
  async listMembers(@CurrentUser() user: AuthUser) {
    this.assertTenant(user);
    return this.orgService.listMembers(user.tenantId!);
  }

  /**
   * DELETE /org/members/:userId
   * Admin-only: remove a member from the organization.
   */
  @Delete('members/:userId')
  @Roles('admin')
  @UseGuards(RolesGuard)
  @HttpCode(HttpStatus.OK)
  async removeMember(
    @CurrentUser() user: AuthUser,
    @Param('userId') targetUserId: string,
  ) {
    this.assertTenant(user);
    if (targetUserId === user.id) {
      throw new BadRequestException('You cannot remove yourself from the organization.');
    }
    return this.orgService.removeMember(user.id, targetUserId, user.tenantId!);
  }

  // ─── INVITES ─────────────────────────────────────────────────────────────

  /**
   * POST /org/invite
   * Admin-only: send an email invitation to join the organization.
   *
   * Body: { email: string, role?: 'admin' | 'member' }
   */
  @Post('invite')
  @Roles('admin')
  @UseGuards(RolesGuard)
  async inviteMember(
    @CurrentUser() user: AuthUser,
    @Body() body: { email: string; role?: 'admin' | 'member' },
  ) {
    this.assertTenant(user);
    if (!body?.email) throw new BadRequestException('Email is required.');
    const role = body.role ?? 'member';
    if (!['admin', 'member'].includes(role)) {
      throw new BadRequestException('Role must be "admin" or "member".');
    }
    return this.orgService.inviteMember(user.id, user.tenantId!, body.email, role);
  }

  /**
   * GET /org/invites
   * Admin-only: list pending invitations.
   */
  @Get('invites')
  @Roles('admin')
  @UseGuards(RolesGuard)
  async listInvites(@CurrentUser() user: AuthUser) {
    this.assertTenant(user);
    return this.orgService.listPendingInvites(user.tenantId!);
  }

  /**
   * DELETE /org/invites/:inviteId
   * Admin-only: cancel a pending invite.
   */
  @Delete('invites/:inviteId')
  @Roles('admin')
  @UseGuards(RolesGuard)
  @HttpCode(HttpStatus.OK)
  async cancelInvite(
    @CurrentUser() user: AuthUser,
    @Param('inviteId') inviteId: string,
  ) {
    this.assertTenant(user);
    return this.orgService.cancelInvite(user.id, inviteId, user.tenantId!);
  }

  /**
   * POST /org/invite/accept
   * Public-facing endpoint (still requires auth — user must be logged in).
   * Called from the invite accept page after signup.
   *
   * Body: { token: string }
   */
  @Post('invite/accept')
  async acceptInvite(
    @CurrentUser() user: AuthUser,
    @Body() body: { token: string },
  ) {
    if (!body?.token) throw new BadRequestException('Invitation token is required.');
    return this.orgService.acceptInvite(body.token, user.id, user.email, user.name ?? undefined);
  }

  // ─── PERMISSIONS ─────────────────────────────────────────────────────────

  /**
   * GET /org/members/:userId/permissions
   * Admin-only: get a member's current permissions.
   */
  @Get('members/:userId/permissions')
  @Roles('admin')
  @UseGuards(RolesGuard)
  async getMemberPermissions(
    @CurrentUser() user: AuthUser,
    @Param('userId') targetUserId: string,
  ) {
    this.assertTenant(user);
    return this.userPermissions.getPermissions(targetUserId, user.tenantId!);
  }

  /**
   * PATCH /org/members/:userId/permissions
   * Admin-only: update a member's permission flags.
   *
   * Body: { canCreateDashboard?, canShareDashboard?, canQueryRag?, canUseAgent? }
   */
  @Patch('members/:userId/permissions')
  @Roles('admin')
  @UseGuards(RolesGuard)
  async updateMemberPermissions(
    @CurrentUser() user: AuthUser,
    @Param('userId') targetUserId: string,
    @Body()
    body: {
      canCreateDashboard?: boolean;
      canShareDashboard?: boolean;
      canQueryRag?: boolean;
      canUseAgent?: boolean;
    },
  ) {
    this.assertTenant(user);
    await this.userPermissions.updatePermissions(
      user.id,
      targetUserId,
      user.tenantId!,
      body,
    );
    return { message: 'Permissions updated.' };
  }

  // ─── CONNECTION ACCESS ────────────────────────────────────────────────────

  /**
   * POST /org/members/:userId/connections/:connectionId
   * Admin-only: grant a member access to a specific ERP connection.
   */
  @Post('members/:userId/connections/:connectionId')
  @Roles('admin')
  @UseGuards(RolesGuard)
  async grantAccess(
    @CurrentUser() user: AuthUser,
    @Param('userId') targetUserId: string,
    @Param('connectionId') connectionId: string,
  ) {
    this.assertTenant(user);
    return this.orgService.grantConnectionAccess(
      user.id,
      user.tenantId!,
      targetUserId,
      connectionId,
    );
  }

  /**
   * DELETE /org/members/:userId/connections/:connectionId
   * Admin-only: revoke a member's access to a specific ERP connection.
   */
  @Delete('members/:userId/connections/:connectionId')
  @Roles('admin')
  @UseGuards(RolesGuard)
  @HttpCode(HttpStatus.OK)
  async revokeAccess(
    @CurrentUser() user: AuthUser,
    @Param('userId') targetUserId: string,
    @Param('connectionId') connectionId: string,
  ) {
    this.assertTenant(user);
    return this.orgService.revokeConnectionAccess(
      user.id,
      user.tenantId!,
      targetUserId,
      connectionId,
    );
  }

  // ─── AUDIT ───────────────────────────────────────────────────────────────

  /**
   * GET /org/audit
   * Admin-only: view the organization's audit trail.
   */
  @Get('audit')
  @Roles('admin')
  @UseGuards(RolesGuard)
  async getAuditTrail(
    @CurrentUser() user: AuthUser,
    @Query('limit') limit?: string,
  ) {
    this.assertTenant(user);
    const parsedLimit = limit ? Math.min(parseInt(limit, 10), 200) : 50;
    return this.orgService.getAuditTrail(user.tenantId!, parsedLimit);
  }

  // ─── UTILS ───────────────────────────────────────────────────────────────

  private assertTenant(user: AuthUser): void {
    if (!user.tenantId) {
      throw new BadRequestException(
        'Your account is not associated with an organization. Please complete account setup.',
      );
    }
  }
}
