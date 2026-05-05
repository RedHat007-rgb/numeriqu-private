import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { Resend } from 'resend';
import { prisma } from '@repo/db';
import { createHash, randomBytes } from 'crypto';

const INVITE_TTL_DAYS = 7;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface OrgSummary {
  id: string;
  orgName: string;
  provider: string;
  providerAccountId: string;
  isActive: boolean;
  updatedAt: Date;
  memberCount: number;
}

export interface OrgMember {
  userId: string;
  email: string;
  name: string | null;
  role: string;
  joinedAt: Date;
}

export interface PendingInvite {
  id: string;
  email: string;
  role: string;
  expiresAt: Date;
  createdAt: Date;
}

@Injectable()
export class OrgService {
  private readonly logger = new Logger(OrgService.name);
  private readonly resend: Resend;

  constructor() {
    this.resend = new Resend(process.env.RESEND_API_KEY);
  }

  async listOrganizations(organizationId: string): Promise<OrgSummary[]> {
    const connections = await prisma.erpConnection.findMany({
      where: { organizationId },
      orderBy: { updatedAt: 'desc' },
    });

    const memberships = await prisma.organizationMembership.findMany({
      where: { organizationId, leftAt: null },
      select: { id: true },
    });

    return connections.map((conn) => ({
      id: conn.id,
      orgName: conn.displayName || conn.externalOrganizationId,
      provider: conn.provider.toLowerCase(),
      providerAccountId: conn.externalOrganizationId,
      isActive: conn.status === 'ACTIVE',
      updatedAt: conn.updatedAt,
      memberCount: memberships.length,
    }));
  }

  async getOrganization(
    organizationId: string,
    connectionId: string,
  ): Promise<{ org: OrgSummary; members: OrgMember[]; invites: PendingInvite[] }> {
    const conn = await prisma.erpConnection.findFirst({
      where: { id: connectionId, organizationId },
    });
    if (!conn) throw new NotFoundException('Organization not found.');

    const memberships = await prisma.organizationMembership.findMany({
      where: { organizationId, leftAt: null },
      include: { user: { select: { id: true, email: true, fullName: true } } },
    });

    const org: OrgSummary = {
      id: conn.id,
      orgName: conn.displayName || conn.externalOrganizationId,
      provider: conn.provider.toLowerCase(),
      providerAccountId: conn.externalOrganizationId,
      isActive: conn.status === 'ACTIVE',
      updatedAt: conn.updatedAt,
      memberCount: memberships.length,
    };

    const members: OrgMember[] = memberships.map((m) => ({
      userId: m.user.id,
      email: m.user.email,
      name: m.user.fullName,
      role: m.role.toLowerCase(),
      joinedAt: m.joinedAt,
    }));

    const invites = await prisma.organizationInvite.findMany({
      where: { organizationId, status: 'PENDING', expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });

    const pendingInvites: PendingInvite[] = invites.map((inv) => ({
      id: inv.id,
      email: inv.email,
      role: inv.role.toLowerCase(),
      expiresAt: inv.expiresAt,
      createdAt: inv.createdAt,
    }));

    return { org, members, invites: pendingInvites };
  }

  async inviteToOrganization(
    organizationId: string,
    inviterUserId: string,
    inviterEmail: string,
    targetEmail: string,
    role: 'admin' | 'member' = 'member',
  ): Promise<{ inviteId: string; token: string }> {
    const organization = await prisma.organization.findUnique({
      where: { id: organizationId },
    });
    if (!organization) throw new NotFoundException('Organization not found.');

    const existing = await prisma.organizationInvite.findFirst({
      where: {
        organizationId,
        email: targetEmail.toLowerCase(),
        status: 'PENDING',
        expiresAt: { gt: new Date() },
      },
    });
    if (existing) throw new BadRequestException('An active invite already exists for this email.');

    const token = randomBytes(32).toString('hex');
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
    const prismaRole = role === 'admin' ? 'ADMIN' : 'USER';

    const invite = await prisma.organizationInvite.create({
      data: {
        organizationId,
        invitedById: inviterUserId,
        email: targetEmail.toLowerCase(),
        role: prismaRole,
        tokenHash,
        expiresAt,
        canViewDashboard: true,
        canCreateDashboard: prismaRole === 'ADMIN',
        canShareDashboard: prismaRole === 'ADMIN',
      },
    });

    const webAppUrl = process.env.WEB_APP_URL || 'http://localhost:3010';
    const inviteUrl = `${webAppUrl}/invite/${token}?org=${organizationId}`;
    await this.sendInviteEmail(targetEmail, inviterEmail, organization.name, inviteUrl);

    return { inviteId: invite.id, token };
  }

  async acceptInvite(
    token: string,
    organizationId: string,
    acceptorSupabaseId: string,
    acceptorEmail: string,
  ): Promise<{ success: boolean; orgName: string }> {
    const tokenHash = hashToken(token);
    const invite = await prisma.organizationInvite.findFirst({
      where: { tokenHash, organizationId },
    });

    if (!invite) throw new BadRequestException('Invite not found.');
    if (invite.status !== 'PENDING') throw new BadRequestException('This invite has already been used or revoked.');
    if (new Date() > invite.expiresAt) throw new BadRequestException('This invite has expired.');
    if (invite.email !== acceptorEmail.toLowerCase()) {
      throw new ForbiddenException('This invite was sent to a different email address.');
    }

    const organization = await prisma.organization.findUnique({ where: { id: organizationId } });
    if (!organization) throw new NotFoundException('Organization not found.');

    let user = await prisma.user.findUnique({ where: { supabaseUserId: acceptorSupabaseId } });
    if (!user) {
      user = await prisma.user.create({
        data: {
          supabaseUserId: acceptorSupabaseId,
          email: acceptorEmail.toLowerCase(),
          fullName: acceptorEmail.split('@')[0],
          isVerified: true,
          isActive: true,
        },
      });
    }

    await prisma.organizationMembership.upsert({
      where: { organizationId_userId: { organizationId, userId: user.id } },
      update: { role: invite.role, leftAt: null },
      create: {
        organizationId,
        userId: user.id,
        role: invite.role,
        canViewDashboard: invite.canViewDashboard,
        canCreateDashboard: invite.canCreateDashboard,
        canShareDashboard: invite.canShareDashboard,
      },
    });

    await prisma.organizationInvite.update({
      where: { id: invite.id },
      data: { status: 'ACCEPTED', acceptedAt: new Date() },
    });

    this.logger.log(`[Org] ${acceptorEmail} accepted invite to ${organization.name}`);
    return { success: true, orgName: organization.name };
  }

  async removeMember(
    organizationId: string,
    targetUserId: string,
    requestingRole: string,
  ): Promise<void> {
    if (requestingRole === 'USER') throw new ForbiddenException('Only admins can remove members.');

    await prisma.organizationMembership.updateMany({
      where: { organizationId, userId: targetUserId },
      data: { leftAt: new Date() },
    });
  }

  async getInviteDetails(token: string): Promise<{
    email: string;
    orgName: string;
    role: string;
    expired: boolean;
  }> {
    const tokenHash = hashToken(token);
    const invite = await prisma.organizationInvite.findFirst({
      where: { tokenHash },
      include: { organization: { select: { name: true } } },
    });
    if (!invite) throw new NotFoundException('Invite not found.');

    const expired = invite.status !== 'PENDING' || new Date() > invite.expiresAt;
    return {
      email: invite.email,
      orgName: invite.organization.name,
      role: invite.role.toLowerCase(),
      expired,
    };
  }

  private async sendInviteEmail(
    to: string,
    inviterEmail: string,
    orgName: string,
    inviteUrl: string,
  ): Promise<void> {
    const { error } = await this.resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL!,
      to,
      subject: `You're invited to join ${orgName} on Numeriqu`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#0f172a;color:#e2e8f0;border-radius:12px;">
          <h2 style="margin:0 0 8px;font-size:22px;color:#fff;">You've been invited</h2>
          <p style="margin:0 0 24px;color:#94a3b8;">
            <strong style="color:#e2e8f0">${inviterEmail}</strong> invited you to join
            <strong style="color:#60a5fa">${orgName}</strong> on Numeriqu.
          </p>
          <a href="${inviteUrl}" style="display:inline-block;padding:14px 28px;background:#3b82f6;color:#fff;border-radius:8px;font-weight:600;text-decoration:none;font-size:15px;">
            Accept Invitation
          </a>
          <p style="margin:24px 0 0;font-size:12px;color:#475569;">
            This invitation expires in ${INVITE_TTL_DAYS} days. If you didn't expect this, you can safely ignore it.
          </p>
        </div>
      `,
    });
    if (error) {
      this.logger.error(`[Org] Failed to send invite email to ${to}: ${JSON.stringify(error)}`);
      throw new BadRequestException('Failed to send invite email.');
    }
  }
}
