import { Injectable, Logger } from '@nestjs/common';
import { prisma } from '@repo/db';

@Injectable()
export class UserProvisioningService {
  private readonly logger = new Logger(UserProvisioningService.name);

  async ensureProvisioned(
    supabaseUserId: string,
    email: string,
    opts?: { name?: string; accountType?: 'solo' | 'organization'; role?: string },
  ): Promise<{
    user: { id: string; email: string; role: string };
    tenant: { id: string; name: string; accountType: string; slug: string | null };
  }> {
    let user = await prisma.user.findUnique({
      where: { id: supabaseUserId },
      include: { tenant: true },
    });

    if (user?.tenant) {
      return {
        user: { id: user.id, email: user.email, role: user.role },
        tenant: {
          id: user.tenant.id,
          name: user.tenant.name,
          accountType: user.tenant.accountType,
          slug: user.tenant.slug,
        },
      };
    }

    this.logger.log(`[JIT] Provisioning user: ${email}`);

    const accountType = opts?.accountType ?? 'solo';
    const role = opts?.role ?? 'owner';

    if (user && !user.tenantId) {
      const tenant = await prisma.tenant.create({
        data: { name: opts?.name ?? this.defaultOrgName(email), accountType },
      });
      user = await prisma.user.update({
        where: { id: user.id },
        data: { tenantId: tenant.id, role },
        include: { tenant: true },
      });
      return {
        user: { id: user.id, email: user.email, role: user.role },
        tenant: { id: tenant.id, name: tenant.name, accountType: tenant.accountType, slug: tenant.slug },
      };
    }

    const tenantName = opts?.name ?? this.defaultOrgName(email);
    const tenant = await prisma.tenant.create({
      data: { name: tenantName, accountType },
    });

    user = await prisma.user.create({
      data: {
        id: supabaseUserId,
        email,
        name: opts?.name ?? email.split('@')[0],
        tenantId: tenant.id,
        role,
      },
      include: { tenant: true },
    });

    this.logger.log(`[JIT] Provisioned tenant=${tenant.id} user=${user.id} role=${role}`);

    return {
      user: { id: user.id, email: user.email, role: user.role },
      tenant: { id: tenant.id, name: tenant.name, accountType: tenant.accountType, slug: tenant.slug },
    };
  }

  private defaultOrgName(email: string): string {
    return email.split('@')[0] + "'s Workspace";
  }
}
