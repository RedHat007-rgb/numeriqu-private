import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { Resend } from 'resend';
import { createClient } from '@supabase/supabase-js';
import { prisma } from '@repo/db';
import { randomUUID } from 'crypto';

const INVITE_TTL_DAYS = 7;

export interface OrgSummary {
  id: string;            // connection id
  orgName: string;
  provider: string;
  providerAccountId: string;
  isActive: boolean | null;
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
  private readonly supabaseAdmin = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  constructor() {
    this.resend = new Resend(process.env.RESEND_API_KEY);
  }

  /** List all organizations (= connections) for a tenant with member counts. */
  async listOrganizations(tenantId: string): Promise<OrgSummary[]> {
    const connections = await prisma.connection.findMany({
      where: { tenantId },
      orderBy: { updatedAt: 'desc' },
      include: {
        memberships: { select: { id: true } },
      },
    });

    return connections.map((conn) => {
      const meta = conn.metadata as Record<string, unknown> | null;
      return {
        id: conn.id,
        orgName:
          typeof meta?.orgName === 'string'
            ? meta.orgName
            : conn.providerAccountId,
        provider: conn.provider,
        providerAccountId: conn.providerAccountId,
        isActive: conn.isActive,
        updatedAt: conn.updatedAt,
        memberCount: conn.memberships.length,
      };
    });
  }

  /** Get one org with full member list + pending invites. */
  async getOrganization(
    tenantId: string,
    connectionId: string,
  ): Promise<{
    org: OrgSummary;
    members: OrgMember[];
    invites: PendingInvite[];
  }> {
    const conn = await prisma.connection.findUnique({
      where: { id: connectionId },
      include: {
        memberships: {
          include: { user: { select: { id: true, email: true, name: true, role: true, createdAt: true } } },
        },
      },
    });

    if (!conn || conn.tenantId !== tenantId) {
      throw new NotFoundException('Organization not found.');
    }

    const meta = conn.metadata as Record<string, unknown> | null;
    const org: OrgSummary = {
      id: conn.id,
      orgName: typeof meta?.orgName === 'string' ? meta.orgName : conn.providerAccountId,
      provider: conn.provider,
      providerAccountId: conn.providerAccountId,
      isActive: conn.isActive,
      updatedAt: conn.updatedAt,
      memberCount: conn.memberships.length,
    };

    const members: OrgMember[] = conn.memberships.map((m) => ({
      userId: m.user.id,
      email: m.user.email,
      name: m.user.name,
      role: m.user.role,
      joinedAt: m.createdAt,
    }));

    const now = new Date();
    const invites = await prisma.orgInvite.findMany({
      where: { tenantId, acceptedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    });

    const pendingInvites: PendingInvite[] = invites.map((inv) => ({
      id: inv.id,
      email: inv.email,
      role: inv.role,
      expiresAt: inv.expiresAt,
      createdAt: inv.createdAt,
    }));

    return { org, members, invites: pendingInvites };
  }

  /** Invite a user by email to a specific organization (connection). */
  async inviteToOrganization(
    tenantId: string,
    connectionId: string,
    inviterEmail: string,
    targetEmail: string,
    role: 'admin' | 'member' = 'member',
  ): Promise<{ inviteId: string; token: string }> {
    // Verify the connection belongs to this tenant
    const conn = await prisma.connection.findUnique({ where: { id: connectionId } });
    if (!conn || conn.tenantId !== tenantId) {
      throw new NotFoundException('Organization not found.');
    }

    const meta = conn.metadata as Record<string, unknown> | null;
    const orgName = typeof meta?.orgName === 'string' ? meta.orgName : conn.providerAccountId;

    // Check for an existing un-expired pending invite for this email
    const existing = await prisma.orgInvite.findFirst({
      where: {
        tenantId,
        email: targetEmail,
        acceptedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (existing) {
      throw new BadRequestException('An active invite already exists for this email.');
    }

    const token = randomUUID();
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

    const invite = await prisma.orgInvite.create({
      data: {
        tenantId,
        email: targetEmail,
        role,
        token,
        expiresAt,
      },
    });

    // Store which connection this invite is for in the token metadata
    // We encode it in the invite token payload via a separate lookup table entry
    // using the OrgMembership connectionId field at acceptance time.
    // Pass connectionId through the invite email URL as a query param (non-secret).
    const webAppUrl = process.env.WEB_APP_URL || 'http://localhost:3010';
    const inviteUrl = `${webAppUrl}/invite/${token}?org=${connectionId}`;

    await this.sendInviteEmail(targetEmail, inviterEmail, orgName, inviteUrl);

    return { inviteId: invite.id, token };
  }

  /** Accept an invite — creates/finds the user and creates the OrgMembership. */
  async acceptInvite(
    token: string,
    connectionId: string,
    acceptorSupabaseId: string,
    acceptorEmail: string,
  ): Promise<{ success: boolean; orgName: string }> {
    const invite = await prisma.orgInvite.findUnique({ where: { token } });

    if (!invite) throw new BadRequestException('Invite not found.');
    if (invite.acceptedAt) throw new BadRequestException('This invite has already been used.');
    if (new Date() > invite.expiresAt) throw new BadRequestException('This invite has expired.');
    if (invite.email.toLowerCase() !== acceptorEmail.toLowerCase()) {
      throw new ForbiddenException('This invite was sent to a different email address.');
    }

    const conn = await prisma.connection.findUnique({ where: { id: connectionId } });
    if (!conn || conn.tenantId !== invite.tenantId) {
      throw new NotFoundException('Organization not found.');
    }

    const meta = conn.metadata as Record<string, unknown> | null;
    const orgName = typeof meta?.orgName === 'string' ? meta.orgName : conn.providerAccountId;

    // Ensure the acceptor is provisioned in this tenant
    let user = await prisma.user.findUnique({ where: { id: acceptorSupabaseId } });
    if (!user) {
      // First time this Supabase user touches our DB — create them under the invite's tenant
      user = await prisma.user.create({
        data: {
          id: acceptorSupabaseId,
          email: acceptorEmail,
          tenantId: invite.tenantId,
          role: invite.role,
        },
      });
    }

    // Create the OrgMembership scoped to this specific connection
    await prisma.orgMembership.upsert({
      where: {
        tenantId_userId_connectionId: {
          tenantId: invite.tenantId,
          userId: acceptorSupabaseId,
          connectionId,
        },
      },
      update: {},
      create: {
        tenantId: invite.tenantId,
        userId: acceptorSupabaseId,
        connectionId,
      },
    });

    // Mark invite as accepted
    await prisma.orgInvite.update({
      where: { id: invite.id },
      data: { acceptedAt: new Date() },
    });

    this.logger.log(
      `[Org] User ${acceptorEmail} accepted invite to org ${orgName} (conn=${connectionId})`,
    );

    return { success: true, orgName };
  }

  /** Remove a member from a specific organization. */
  async removeMember(
    tenantId: string,
    connectionId: string,
    targetUserId: string,
    requestingRole: string,
  ): Promise<void> {
    if (requestingRole === 'member') throw new ForbiddenException('Only admins and owners can remove members.');

    const conn = await prisma.connection.findUnique({ where: { id: connectionId } });
    if (!conn || conn.tenantId !== tenantId) {
      throw new NotFoundException('Organization not found.');
    }

    await prisma.orgMembership.deleteMany({
      where: { tenantId, userId: targetUserId, connectionId },
    });
  }

  /** Get invite details (for displaying the accept page without auth). */
  async getInviteDetails(token: string): Promise<{
    email: string;
    orgName: string;
    role: string;
    expired: boolean;
  }> {
    const invite = await prisma.orgInvite.findUnique({ where: { token } });
    if (!invite) throw new NotFoundException('Invite not found.');

    const expired = new Date() > invite.expiresAt || invite.acceptedAt !== null;
    const tenant = await prisma.tenant.findUnique({ where: { id: invite.tenantId } });

    return {
      email: invite.email,
      orgName: tenant?.name ?? 'an organization',
      role: invite.role,
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
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #0f172a; color: #e2e8f0; border-radius: 12px;">
          <h2 style="margin: 0 0 8px; font-size: 22px; color: #fff;">You've been invited</h2>
          <p style="margin: 0 0 24px; color: #94a3b8;">
            <strong style="color:#e2e8f0">${inviterEmail}</strong> invited you to join
            <strong style="color:#60a5fa">${orgName}</strong> on Numeriqu.
          </p>
          <a href="${inviteUrl}"
             style="display:inline-block; padding: 14px 28px; background: #3b82f6; color: #fff;
                    border-radius: 8px; font-weight: 600; text-decoration: none; font-size: 15px;">
            Accept Invitation
          </a>
          <p style="margin: 24px 0 0; font-size: 12px; color: #475569;">
            This invitation expires in 7 days. If you didn't expect this, you can safely ignore it.
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
