import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { PrismaClient } from '@repo/db';
import { PRISMA_TOKEN } from '../../database/database.module';
import { createHash, randomBytes } from 'crypto';
import { Resend } from 'resend';
import { OrganizationContextService } from '../org-context/org-context.service';

@Injectable()
export class OrganizationService {
  private readonly logger = new Logger(OrganizationService.name);
  private readonly resend: Resend | null;
  private readonly resendFrom: string | null;

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly orgContext: OrganizationContextService,
  ) {
    this.resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
    this.resendFrom = process.env.RESEND_FROM_EMAIL ?? null;
  }

  private normalizeEmail(email: string) {
    return email.trim().toLowerCase();
  }

  private hashToken(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }

  private issueToken() {
    return randomBytes(24).toString('hex');
  }

  private async assertCollaborativeOrganization(organizationId: string) {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, accountType: true },
    });
    if (!organization) {
      throw new HttpException(
        { message: 'Organization not found.', code: 'NOT_FOUND' },
        HttpStatus.NOT_FOUND,
      );
    }
    if (organization.accountType === 'SOLO') {
      throw new HttpException(
        {
          message: 'Invites are not available for solo workspaces.',
          code: 'SOLO_RESTRICTION',
        },
        HttpStatus.FORBIDDEN,
      );
    }
    return organization;
  }

  private permissionFlagPatch(
    permission: 'VIEW_DASHBOARD' | 'CREATE_DASHBOARD' | 'SHARE_DASHBOARD',
    enabled: boolean,
  ) {
    if (permission === 'VIEW_DASHBOARD') return { canViewDashboard: enabled };
    if (permission === 'CREATE_DASHBOARD') return { canCreateDashboard: enabled };
    return { canShareDashboard: enabled };
  }

  private async sendInviteEmail(params: {
    email: string;
    organizationName: string;
    role: 'ADMIN' | 'USER';
    token: string;
  }) {
    if (!this.resend || !this.resendFrom) {
      this.logger.warn(`Invite email skipped for ${params.email}: Resend not configured.`);
      return;
    }

    const inviteUrlBase = process.env.WEB_APP_URL || 'http://localhost:3001';
    const inviteUrl = `${inviteUrlBase.replace(/\/$/, '')}/signup?inviteToken=${params.token}`;
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
        <h2 style="margin: 0 0 8px;">You were invited to ${params.organizationName}</h2>
        <p style="color: #475569;">Role: <strong>${params.role}</strong></p>
        <p style="color: #475569;">Use the link below to join the organization:</p>
        <p><a href="${inviteUrl}">${inviteUrl}</a></p>
        <p style="color: #64748b; font-size: 12px;">This invite expires in 7 days.</p>
      </div>
    `;

    const { error } = await this.resend.emails.send({
      from: this.resendFrom,
      to: params.email,
      subject: `Invitation to join ${params.organizationName}`,
      html,
    });

    if (error) {
      this.logger.error(`Failed to send invite email: ${JSON.stringify(error)}`);
      throw new HttpException(
        { message: 'Failed to send invite email.', code: 'EMAIL_SEND_FAILED' },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  async listOrganizationsForUser(userId: string) {
    const memberships = await this.prisma.organizationMembership.findMany({
      where: { userId, leftAt: null },
      include: {
        organization: {
          select: {
            id: true,
            name: true,
            slug: true,
            accountType: true,
            powerBiUrl: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
      orderBy: { joinedAt: 'asc' },
    });

    return memberships.map((membership) => ({
      organization: {
        ...membership.organization,
        createdAt: membership.organization.createdAt.toISOString(),
        updatedAt: membership.organization.updatedAt.toISOString(),
      },
      membership: {
        id: membership.id,
        role: membership.role,
        canViewDashboard: membership.canViewDashboard,
        canCreateDashboard: membership.canCreateDashboard,
        canShareDashboard: membership.canShareDashboard,
        joinedAt: membership.joinedAt.toISOString(),
      },
    }));
  }

  async listMembers(organizationId: string, requesterId: string) {
    await this.orgContext.assertOrganizationMember(organizationId, requesterId);
    const memberships = await this.prisma.organizationMembership.findMany({
      where: { organizationId, leftAt: null },
      include: {
        user: { select: { id: true, email: true, fullName: true } },
        permissionGrants: true,
      },
      orderBy: { joinedAt: 'asc' },
    });

    return memberships.map((membership) => ({
      id: membership.id,
      user: membership.user,
      role: membership.role,
      permissions: {
        canViewDashboard: membership.canViewDashboard,
        canCreateDashboard: membership.canCreateDashboard,
        canShareDashboard: membership.canShareDashboard,
        grants: membership.permissionGrants.map((grant) => grant.permission),
      },
      joinedAt: membership.joinedAt.toISOString(),
    }));
  }

  async listInvites(organizationId: string, requesterId: string) {
    await this.orgContext.assertAdmin(organizationId, requesterId);
    await this.assertCollaborativeOrganization(organizationId);
    const invites = await this.prisma.organizationInvite.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        role: true,
        canViewDashboard: true,
        canCreateDashboard: true,
        canShareDashboard: true,
        status: true,
        expiresAt: true,
        acceptedAt: true,
        createdAt: true,
      },
    });
    return invites.map((invite) => ({
      ...invite,
      expiresAt: invite.expiresAt.toISOString(),
      acceptedAt: invite.acceptedAt?.toISOString() ?? null,
      createdAt: invite.createdAt.toISOString(),
    }));
  }

  async createInvite(params: {
    organizationId: string;
    invitedById: string;
    email: string;
    role: 'ADMIN' | 'USER';
    canViewDashboard?: boolean;
    canCreateDashboard?: boolean;
    canShareDashboard?: boolean;
  }) {
    await this.orgContext.assertAdmin(params.organizationId, params.invitedById);
    await this.assertCollaborativeOrganization(params.organizationId);
    const normalizedEmail = this.normalizeEmail(params.email);

    const org = await this.prisma.organization.findUnique({
      where: { id: params.organizationId },
      select: { id: true, name: true },
    });
    if (!org) {
      throw new HttpException(
        { message: 'Organization not found.', code: 'NOT_FOUND' },
        HttpStatus.NOT_FOUND,
      );
    }

    const existingMember = await this.prisma.organizationMembership.findFirst({
      where: { organizationId: params.organizationId, user: { email: normalizedEmail }, leftAt: null },
      select: { id: true },
    });
    if (existingMember) {
      throw new HttpException(
        { message: 'User is already a member.', code: 'ALREADY_MEMBER' },
        HttpStatus.CONFLICT,
      );
    }

    const token = this.issueToken();
    const tokenHash = this.hashToken(token);

    const invite = await this.prisma.organizationInvite.create({
      data: {
        organizationId: params.organizationId,
        invitedById: params.invitedById,
        email: normalizedEmail,
        role: params.role,
        canViewDashboard: params.canViewDashboard ?? false,
        canCreateDashboard: params.canCreateDashboard ?? false,
        canShareDashboard: params.canShareDashboard ?? false,
        tokenHash,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    await this.sendInviteEmail({
      email: normalizedEmail,
      organizationName: org.name,
      role: params.role,
      token,
    });

    return {
      id: invite.id,
      email: invite.email,
      status: invite.status,
      expiresAt: invite.expiresAt.toISOString(),
    };
  }

  async resendInvite(params: { organizationId: string; inviteId: string; requesterId: string }) {
    await this.orgContext.assertAdmin(params.organizationId, params.requesterId);
    await this.assertCollaborativeOrganization(params.organizationId);
    const invite = await this.prisma.organizationInvite.findFirst({
      where: { id: params.inviteId, organizationId: params.organizationId },
      include: { organization: true },
    });
    if (!invite) {
      throw new HttpException(
        { message: 'Invite not found.', code: 'NOT_FOUND' },
        HttpStatus.NOT_FOUND,
      );
    }
    if (invite.status !== 'PENDING') {
      throw new HttpException(
        { message: 'Only pending invites can be resent.', code: 'INVALID_STATE' },
        HttpStatus.CONFLICT,
      );
    }

    const token = this.issueToken();
    await this.prisma.organizationInvite.update({
      where: { id: invite.id },
      data: {
        tokenHash: this.hashToken(token),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    await this.sendInviteEmail({
      email: invite.email,
      organizationName: invite.organization.name,
      role: invite.role,
      token,
    });

    return { success: true };
  }

  async revokeInvite(params: { organizationId: string; inviteId: string; requesterId: string }) {
    await this.orgContext.assertAdmin(params.organizationId, params.requesterId);
    await this.assertCollaborativeOrganization(params.organizationId);
    await this.prisma.organizationInvite.updateMany({
      where: { id: params.inviteId, organizationId: params.organizationId, status: 'PENDING' },
      data: { status: 'REVOKED' },
    });
    return { success: true };
  }

  async acceptInvite(params: { token: string; userId: string; userEmail: string }) {
    const tokenHash = this.hashToken(params.token);
    const normalizedEmail = this.normalizeEmail(params.userEmail);
    const invite = await this.prisma.organizationInvite.findFirst({
      where: { tokenHash, status: 'PENDING' },
      include: { organization: true },
    });
    if (!invite) {
      throw new HttpException(
        { message: 'Invalid invite token.', code: 'INVALID_TOKEN' },
        HttpStatus.BAD_REQUEST,
      );
    }
    if (invite.expiresAt < new Date()) {
      await this.prisma.organizationInvite.update({
        where: { id: invite.id },
        data: { status: 'EXPIRED' },
      });
      throw new HttpException(
        { message: 'Invite has expired.', code: 'INVITE_EXPIRED' },
        HttpStatus.BAD_REQUEST,
      );
    }
    if (normalizedEmail !== this.normalizeEmail(invite.email)) {
      throw new HttpException(
        { message: 'Invite email does not match your account.', code: 'EMAIL_MISMATCH' },
        HttpStatus.FORBIDDEN,
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { supabaseUserId: params.userId },
      select: { id: true },
    });
    if (!user) {
      throw new HttpException(
        { message: 'User account not found.', code: 'USER_NOT_FOUND' },
        HttpStatus.NOT_FOUND,
      );
    }

    const existingMembership = await this.prisma.organizationMembership.findFirst({
      where: { organizationId: invite.organizationId, userId: user.id },
      select: { id: true },
    });

    await this.prisma.$transaction(async (tx) => {
      if (!existingMembership) {
        await tx.organizationMembership.create({
          data: {
            organizationId: invite.organizationId,
            userId: user.id,
            role: invite.role,
            canViewDashboard: invite.canViewDashboard,
            canCreateDashboard: invite.canCreateDashboard,
            canShareDashboard: invite.canShareDashboard,
          },
        });
      }

      await tx.organizationInvite.update({
        where: { id: invite.id },
        data: { status: 'ACCEPTED', acceptedAt: new Date() },
      });
    });

    return {
      organizationId: invite.organizationId,
      organizationName: invite.organization.name,
    };
  }

  async grantMembershipPermission(params: {
    organizationId: string;
    requesterId: string;
    membershipId: string;
    permission: 'VIEW_DASHBOARD' | 'CREATE_DASHBOARD' | 'SHARE_DASHBOARD';
  }) {
    await this.orgContext.assertAdmin(params.organizationId, params.requesterId);
    const membership = await this.prisma.organizationMembership.findFirst({
      where: { id: params.membershipId, organizationId: params.organizationId },
      select: { id: true },
    });
    if (!membership) {
      throw new HttpException(
        { message: 'Membership not found.', code: 'NOT_FOUND' },
        HttpStatus.NOT_FOUND,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.membershipPermissionGrant.upsert({
        where: {
          membershipId_permission: {
            membershipId: membership.id,
            permission: params.permission,
          },
        },
        create: {
          organizationId: params.organizationId,
          membershipId: membership.id,
          permission: params.permission,
          grantedById: params.requesterId,
        },
        update: {
          grantedAt: new Date(),
          grantedById: params.requesterId,
        },
      });

      await tx.organizationMembership.update({
        where: { id: membership.id },
        data: this.permissionFlagPatch(params.permission, true),
      });
    });

    return { success: true };
  }

  async revokeMembershipPermission(params: {
    organizationId: string;
    requesterId: string;
    membershipId: string;
    permission: 'VIEW_DASHBOARD' | 'CREATE_DASHBOARD' | 'SHARE_DASHBOARD';
  }) {
    await this.orgContext.assertAdmin(params.organizationId, params.requesterId);
    await this.prisma.$transaction(async (tx) => {
      await tx.membershipPermissionGrant.deleteMany({
        where: {
          organizationId: params.organizationId,
          membershipId: params.membershipId,
          permission: params.permission,
        },
      });

      const membership = await tx.organizationMembership.findFirst({
        where: {
          id: params.membershipId,
          organizationId: params.organizationId,
          leftAt: null,
        },
        select: { id: true, role: true },
      });
      if (!membership) {
        throw new HttpException(
          { message: 'Membership not found.', code: 'NOT_FOUND' },
          HttpStatus.NOT_FOUND,
        );
      }

      if (membership.role !== 'ADMIN') {
        await tx.organizationMembership.update({
          where: { id: membership.id },
          data: this.permissionFlagPatch(params.permission, false),
        });
      }
    });
    return { success: true };
  }
}
