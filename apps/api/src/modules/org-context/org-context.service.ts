import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { PrismaClient } from '@repo/db';
import { PRISMA_TOKEN } from '../../database/database.module';

type AuthIdentity = { id: string; email: string };
type EnsureContextOptions = {
  organizationId?: string;
  preferredAccountType?: 'SOLO' | 'ORGANIZATION';
};

@Injectable()
export class OrganizationContextService {
  private readonly logger = new Logger(OrganizationContextService.name);

  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient) {}

  private normalizeEmail(email: string) {
    return email.trim().toLowerCase();
  }

  private slugify(value: string) {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
  }

  private async createUniqueOrganizationSlug(base: string) {
    const normalized = this.slugify(base) || 'workspace';
    for (let i = 0; i < 8; i += 1) {
      const suffix = i === 0 ? '' : `-${Math.floor(Math.random() * 10000)}`;
      const candidate = `${normalized}${suffix}`;
      const exists = await this.prisma.organization.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });
      if (!exists) return candidate;
    }
    return `${normalized}-${Date.now().toString(36)}`;
  }

  private async resolveOrProvisionUser(identity: AuthIdentity, email: string) {
    const selectUser = {
      id: true,
      supabaseUserId: true,
      email: true,
      fullName: true,
      isActive: true,
      isVerified: true,
    } as const;

    const bySupabase = await this.prisma.user.findUnique({
      where: { supabaseUserId: identity.id },
      select: selectUser,
    });
    if (bySupabase) {
      if (bySupabase.email !== email || !bySupabase.isActive || !bySupabase.isVerified) {
        return this.prisma.user.update({
          where: { id: bySupabase.id },
          data: {
            email,
            isActive: true,
            isVerified: true,
          },
          select: selectUser,
        });
      }
      return bySupabase;
    }

    const byEmail = await this.prisma.user.findUnique({
      where: { email },
      select: selectUser,
    });
    if (byEmail) {
      // Relink legacy/local user row to current Supabase identity.
      return this.prisma.user.update({
        where: { id: byEmail.id },
        data: {
          supabaseUserId: identity.id,
          isActive: true,
          isVerified: true,
        },
        select: selectUser,
      });
    }

    const fullName = email.split('@')[0] || 'user';
    return this.prisma.user.create({
      data: {
        supabaseUserId: identity.id,
        email,
        fullName,
        isVerified: true,
        isActive: true,
      },
      select: selectUser,
    });
  }

  async ensureContext(identity: AuthIdentity, options: EnsureContextOptions = {}) {
    const email = this.normalizeEmail(identity.email);

    let user;
    try {
      user = await this.resolveOrProvisionUser(identity, email);
    } catch (error) {
      this.logger.error(
        `Failed to provision/resolve user for ${email}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new HttpException(
        {
          message: 'Unable to provision user context. Please retry.',
          code: 'USER_CONTEXT_FAILED',
        },
        HttpStatus.CONFLICT,
      );
    }

    let membership =
      options.organizationId
        ? await this.prisma.organizationMembership.findFirst({
            where: {
              userId: user.id,
              organizationId: options.organizationId,
              leftAt: null,
            },
            include: { organization: true, permissionGrants: true },
          })
        : await this.prisma.organizationMembership.findFirst({
            where: { userId: user.id, leftAt: null },
            orderBy: { joinedAt: 'asc' },
            include: { organization: true, permissionGrants: true },
          });

    if (!membership) {
      if (options.organizationId) {
        throw new HttpException(
          {
            message: 'You are not a member of the requested organization.',
            code: 'FORBIDDEN',
          },
          HttpStatus.FORBIDDEN,
        );
      }

      const orgName = `${email.split('@')[0]}'s organization`;
      const slug = await this.createUniqueOrganizationSlug(orgName);
      const organization = await this.prisma.organization.create({
        data: {
          accountType: options.preferredAccountType ?? 'ORGANIZATION',
          name: orgName,
          slug,
          createdById: user.id,
        },
      });

      membership = await this.prisma.organizationMembership.create({
        data: {
          organizationId: organization.id,
          userId: user.id,
          role: 'ADMIN',
          canViewDashboard: true,
          canCreateDashboard: true,
          canShareDashboard: true,
        },
        include: { organization: true, permissionGrants: true },
      });
      this.logger.log(`Provisioned default organization ${organization.id} for ${email}`);
    }

    return {
      user,
      organization: membership.organization,
      membership,
    };
  }

  async getMembershipWithPermissions(organizationId: string, userId: string) {
    return this.prisma.organizationMembership.findFirst({
      where: { organizationId, userId, leftAt: null },
      include: { permissionGrants: true },
    });
  }

  async assertOrganizationMember(organizationId: string, userId: string) {
    const membership = await this.getMembershipWithPermissions(organizationId, userId);
    if (!membership) {
      throw new HttpException(
        { message: 'You are not a member of this organization.', code: 'FORBIDDEN' },
        HttpStatus.FORBIDDEN,
      );
    }
    return membership;
  }

  async assertAdmin(organizationId: string, userId: string) {
    const membership = await this.assertOrganizationMember(organizationId, userId);
    if (membership.role !== 'ADMIN') {
      throw new HttpException(
        { message: 'Admin access required.', code: 'FORBIDDEN' },
        HttpStatus.FORBIDDEN,
      );
    }
    return membership;
  }

  async assertPermission(
    organizationId: string,
    userId: string,
    permission: 'VIEW_DASHBOARD' | 'CREATE_DASHBOARD' | 'SHARE_DASHBOARD',
  ) {
    const membership = await this.assertOrganizationMember(organizationId, userId);
    if (membership.role === 'ADMIN') return membership;

    const fromFlags =
      (permission === 'VIEW_DASHBOARD' && membership.canViewDashboard) ||
      (permission === 'CREATE_DASHBOARD' && membership.canCreateDashboard) ||
      (permission === 'SHARE_DASHBOARD' && membership.canShareDashboard);

    const fromGrant = membership.permissionGrants.some(
      (grant) => grant.permission === permission,
    );

    if (!fromFlags && !fromGrant) {
      throw new HttpException(
        {
          message: `Missing required permission: ${permission}.`,
          code: 'FORBIDDEN',
        },
        HttpStatus.FORBIDDEN,
      );
    }

    return membership;
  }
}
