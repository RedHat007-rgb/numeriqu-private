import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { Resend } from 'resend';
import { prisma } from '@repo/db';
import { AuditLogService } from '../common/services/audit-log.service';
import { UserPermissionsService } from '../common/services/user-permissions.service';

const INVITE_TTL_HOURS = 48;

/**
 * OrgService — Organization member lifecycle management.
 *
 * Admin-only operations:
 *   - Invite members by email
 *   - List members + their connection access
 *   - Update member permissions
 *   - Remove members
 *   - Grant / revoke connection access
 *
 * Domain rules enforced here:
 *   - Admins cannot be removed by other admins (only by themselves)
 *   - Cannot invite an email that already has a user in this tenant
 *   - Cannot invite the same email twice while a pending invite exists
 *   - Removing a member cleans up all their memberships and permissions
 */
@Injectable()
export class OrgService {
  private readonly logger = new Logger(OrgService.name);
  private readonly resend: Resend;

  constructor(
    private readonly auditLog: AuditLogService,
    private readonly userPermissions: UserPermissionsService,
  ) {
    this.resend = new Resend(process.env.RESEND_API_KEY);
  }

  // ─── MEMBERS ───────────────────────────────────────────────────────────────

  /**
   * List all members of the tenant with their connection access and permissions.
   */
  async listMembers(tenantId: string) {
    const users = await prisma.user.findMany({
      where: { tenantId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
        permission: {
          select: {
            canCreateDashboard: true,
            canShareDashboard: true,
            canQueryRag: true,
            canUseAgent: true,
          },
        },
        memberships: {
          select: {
            connectionId: true,
            connection: {
              select: {
                id: true,
                displayName: true,
                provider: true,
                providerAccountId: true,
                isActive: true,
              },
            },
          },
        },
      },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    });

    return users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      createdAt: u.createdAt,
      permissions:
        u.role === 'admin'
          ? { canCreateDashboard: true, canShareDashboard: true, canQueryRag: true, canUseAgent: true }
          : (u.permission ?? { canCreateDashboard: false, canShareDashboard: false, canQueryRag: true, canUseAgent: false }),
      accessibleConnections: u.memberships.map((m) => m.connection),
    }));
  }

  /**
   * Remove a member from the organization.
   * Cleans up: memberships, permissions, shared dashboards (access revoked).
   * Does NOT delete the Supabase user — they can still sign in, just not access this org.
   */
  async removeMember(adminId: string, targetUserId: string, tenantId: string) {
    const target = await prisma.user.findFirst({
      where: { id: targetUserId, tenantId },
      select: { id: true, email: true, role: true },
    });

    if (!target) {
      throw new NotFoundException('Member not found in this organization.');
    }

    if (target.role === 'admin') {
      throw new ForbiddenException(
        'Admin accounts cannot be removed by other admins. Contact support.',
      );
    }

    // Cascade cleanup in transaction
    await prisma.$transaction([
      prisma.orgMembership.deleteMany({ where: { userId: targetUserId, tenantId } }),
      prisma.userPermission.deleteMany({ where: { userId: targetUserId } }),
      prisma.dashboardShare.deleteMany({ where: { userId: targetUserId } }),
      prisma.chatSession.deleteMany({ where: { userId: targetUserId, tenantId } }),
      prisma.user.update({
        where: { id: targetUserId },
        data: { tenantId: null }, // detach from org, don't delete the account
      }),
    ]);

    this.logger.log(
      `[Org] Member removed: userId=${targetUserId} by admin=${adminId} tenant=${tenantId}`,
    );

    this.auditLog.logAsync({
      tenantId,
      userId: adminId,
      action: 'member.removed',
      resource: 'user',
      resourceId: targetUserId,
      metadata: { removedEmail: target.email },
    });

    return { message: 'Member removed from organization.' };
  }

  // ─── INVITES ───────────────────────────────────────────────────────────────

  /**
   * Send an email invitation to join the organization.
   * Creates an OrgInvite record and sends the invite email via Resend.
   */
  async inviteMember(
    adminId: string,
    tenantId: string,
    email: string,
    role: 'admin' | 'member' = 'member',
  ) {
    // Guard: email already a member?
    const existing = await prisma.user.findFirst({
      where: { email, tenantId },
    });
    if (existing) {
      throw new ConflictException('This email address is already a member of your organization.');
    }

    // Guard: pending invite already exists?
    const pendingInvite = await prisma.orgInvite.findFirst({
      where: {
        email,
        tenantId,
        acceptedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (pendingInvite) {
      throw new ConflictException(
        'An active invitation has already been sent to this email. Please wait for it to expire before resending.',
      );
    }

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });

    if (!tenant) throw new NotFoundException('Organization not found.');

    const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000);

    const invite = await prisma.orgInvite.create({
      data: { tenantId, email, role, expiresAt },
    });

    const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/invite/accept?token=${invite.token}`;

    await this.resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL!,
      to: email,
      subject: `You've been invited to ${tenant.name} on Numeriqu`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 32px; background: #050508; color: #F8FAFC; border-radius: 16px; border: 1px solid rgba(255,255,255,0.08);">
          <h1 style="margin: 0 0 12px; font-size: 20px; font-weight: 700;">You've been invited</h1>
          <p style="margin: 0 0 24px; color: #94A3B8; font-size: 14px; line-height: 1.6;">
            You've been invited to join <strong style="color: #F8FAFC;">${tenant.name}</strong> on Numeriqu as a <strong style="color: #3B82F6;">${role}</strong>.
          </p>
          <a href="${inviteUrl}" style="display: inline-block; padding: 14px 28px; background: #2563EB; color: #fff; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 14px;">Accept Invitation</a>
          <p style="margin: 24px 0 0; font-size: 12px; color: #475569;">This invitation expires in ${INVITE_TTL_HOURS} hours. If you didn't expect this, ignore this email.</p>
        </div>
      `,
    });

    this.logger.log(
      `[Org] Invite sent to ${email} role=${role} tenant=${tenantId}`,
    );

    this.auditLog.logAsync({
      tenantId,
      userId: adminId,
      action: 'member.invited',
      resource: 'org_invite',
      resourceId: invite.id,
      metadata: { email, role },
    });

    return {
      message: `Invitation sent to ${email}.`,
      inviteId: invite.id,
      expiresAt: invite.expiresAt,
    };
  }

  /**
   * Accept an invite by token.
   * Creates the user account (if not existing), links to tenant, creates default permissions.
   * Called from the invite accept page after the user has completed signup.
   */
  async acceptInvite(token: string, supabaseUserId: string, email: string, name?: string) {
    const invite = await prisma.orgInvite.findUnique({
      where: { token },
      include: { tenant: true },
    });

    if (!invite) {
      throw new NotFoundException('Invitation not found or already used.');
    }

    if (invite.acceptedAt) {
      throw new ConflictException('This invitation has already been accepted.');
    }

    if (new Date() > invite.expiresAt) {
      throw new BadRequestException('This invitation has expired. Please request a new one.');
    }

    if (invite.email !== email) {
      throw new ForbiddenException('This invitation was sent to a different email address.');
    }

    // Create or update the user record in Numeriqu
    const user = await prisma.user.upsert({
      where: { id: supabaseUserId },
      create: {
        id: supabaseUserId,
        email,
        name: name ?? email.split('@')[0],
        tenantId: invite.tenantId,
        role: invite.role as 'admin' | 'member',
      },
      update: {
        tenantId: invite.tenantId,
        role: invite.role as 'admin' | 'member',
      },
    });

    // Create default permission record for members
    if (invite.role === 'member') {
      // Find the first admin of the org to set as grantor
      const admin = await prisma.user.findFirst({
        where: { tenantId: invite.tenantId, role: 'admin' },
        select: { id: true },
      });
      await this.userPermissions.createDefaultForMember(
        user.id,
        invite.tenantId,
        admin?.id ?? user.id,
      );
    }

    // Mark invite as accepted
    await prisma.orgInvite.update({
      where: { id: invite.id },
      data: { acceptedAt: new Date() },
    });

    this.logger.log(
      `[Org] Invite accepted: userId=${user.id} tenant=${invite.tenantId} role=${invite.role}`,
    );

    this.auditLog.logAsync({
      tenantId: invite.tenantId,
      userId: user.id,
      action: 'member.invite_accepted',
      resource: 'org_invite',
      resourceId: invite.id,
    });

    return {
      message: 'Invitation accepted. Welcome to the organization.',
      tenantId: invite.tenantId,
      role: invite.role,
    };
  }

  /**
   * List pending (not yet accepted, not expired) invites for the org.
   */
  async listPendingInvites(tenantId: string) {
    return prisma.orgInvite.findMany({
      where: {
        tenantId,
        acceptedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        email: true,
        role: true,
        expiresAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Cancel a pending invite.
   */
  async cancelInvite(adminId: string, inviteId: string, tenantId: string) {
    const invite = await prisma.orgInvite.findFirst({
      where: { id: inviteId, tenantId, acceptedAt: null },
    });

    if (!invite) {
      throw new NotFoundException('Invite not found or already accepted.');
    }

    await prisma.orgInvite.delete({ where: { id: inviteId } });

    this.auditLog.logAsync({
      tenantId,
      userId: adminId,
      action: 'member.removed',
      resource: 'org_invite',
      resourceId: inviteId,
      metadata: { cancelled: true, email: invite.email },
    });

    return { message: 'Invitation cancelled.' };
  }

  // ─── CONNECTION ACCESS ─────────────────────────────────────────────────────

  /**
   * Grant a member access to a specific ERP connection.
   * Idempotent — safe to call multiple times.
   */
  async grantConnectionAccess(
    adminId: string,
    tenantId: string,
    userId: string,
    connectionId: string,
  ) {
    const [user, connection] = await Promise.all([
      prisma.user.findFirst({ where: { id: userId, tenantId }, select: { id: true, role: true } }),
      prisma.connection.findFirst({ where: { id: connectionId, tenantId }, select: { id: true } }),
    ]);

    if (!user) throw new NotFoundException('User not found in this organization.');
    if (!connection) throw new NotFoundException('Connection not found in this organization.');
    if (user.role === 'admin') {
      throw new ForbiddenException('Admins already have full access to all connections.');
    }

    await prisma.orgMembership.upsert({
      where: { tenantId_userId_connectionId: { tenantId, userId, connectionId } },
      create: { tenantId, userId, connectionId },
      update: {},
    });

    this.logger.log(`[Org] Connection access granted: userId=${userId} conn=${connectionId}`);

    return { message: 'Access granted.' };
  }

  /**
   * Revoke a member's access to a specific ERP connection.
   */
  async revokeConnectionAccess(
    adminId: string,
    tenantId: string,
    userId: string,
    connectionId: string,
  ) {
    const deleted = await prisma.orgMembership.deleteMany({
      where: { tenantId, userId, connectionId },
    });

    if (deleted.count === 0) {
      throw new NotFoundException('No access grant found to revoke.');
    }

    this.logger.log(`[Org] Connection access revoked: userId=${userId} conn=${connectionId}`);

    return { message: 'Access revoked.' };
  }

  // ─── AUDIT ─────────────────────────────────────────────────────────────────

  async getAuditTrail(tenantId: string, limit = 50) {
    return this.auditLog.getTrail(tenantId, { limit });
  }
}
