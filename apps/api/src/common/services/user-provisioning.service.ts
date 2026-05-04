import { Injectable, Logger } from '@nestjs/common';
import { prisma } from '@repo/db';
import { AuditLogService } from './audit-log.service';

export interface ProvisionedContext {
  user: { id: string; email: string; name: string | null; role: string };
  tenant: { id: string; name: string; accountType: string; slug: string | null };
}

/**
 * UserProvisioningService — Just-In-Time user + tenant creation.
 *
 * Called on every authenticated request via /auth/me.
 * Idempotent: safe to call multiple times for the same user.
 *
 * Flow:
 *   1. User verifies OTP → Supabase user created (email_confirm: true)
 *   2. Frontend calls signInWithPassword → gets JWT
 *   3. First API call hits /auth/me → this service creates the Numeriqu user + tenant
 *   4. Subsequent calls return the existing records (no-op)
 */
@Injectable()
export class UserProvisioningService {
  private readonly logger = new Logger(UserProvisioningService.name);

  constructor(private readonly auditLog: AuditLogService) {}

  async ensureProvisioned(
    supabaseUserId: string,
    email: string,
    opts?: {
      name?: string;
      accountType?: 'organization';
      orgName?: string;
      role?: 'admin' | 'member';
    },
  ): Promise<ProvisionedContext> {
    const existing = await prisma.user.findUnique({
      where: { id: supabaseUserId },
      include: { tenant: true },
    });

    if (existing?.tenant) {
      return {
        user: { id: existing.id, email: existing.email, name: existing.name, role: existing.role },
        tenant: {
          id: existing.tenant.id,
          name: existing.tenant.name,
          accountType: existing.tenant.accountType,
          slug: existing.tenant.slug,
        },
      };
    }

    this.logger.log(`[JIT] Provisioning new user: ${email}`);

    const accountType = opts?.accountType ?? 'organization';
    const role = opts?.role ?? 'admin';
    const tenantName = opts?.orgName ?? this.defaultTenantName(email);

    // Generate URL-safe slug from tenant name
    const baseSlug = tenantName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);

    const slug = await this.uniqueSlug(baseSlug);

    // If user row exists without a tenant (edge case), create tenant and link
    if (existing && !existing.tenantId) {
      const tenant = await prisma.tenant.create({
        data: { name: tenantName, accountType, slug },
      });
      const updatedUser = await prisma.user.update({
        where: { id: existing.id },
        data: { tenantId: tenant.id, role },
        include: { tenant: true },
      });

      this.auditLog.logAsync({
        tenantId: tenant.id,
        userId: updatedUser.id,
        action: 'user.created',
        resource: 'user',
        resourceId: updatedUser.id,
      });

      return {
        user: { id: updatedUser.id, email: updatedUser.email, name: updatedUser.name, role: updatedUser.role },
        tenant: { id: tenant.id, name: tenant.name, accountType: tenant.accountType, slug: tenant.slug },
      };
    }

    // Create tenant + user together
    const [tenant, user] = await prisma.$transaction(async (tx) => {
      const t = await tx.tenant.create({
        data: { name: tenantName, accountType, slug },
      });

      const u = await tx.user.create({
        data: {
          id: supabaseUserId,
          email,
          name: opts?.name ?? email.split('@')[0],
          tenantId: t.id,
          role,
        },
      });

      return [t, u];
    });

    this.logger.log(
      `[JIT] Provisioned tenant=${tenant.id} user=${user.id} role=${role}`,
    );

    this.auditLog.logAsync({
      tenantId: tenant.id,
      userId: user.id,
      action: 'user.created',
      resource: 'user',
      resourceId: user.id,
    });

    return {
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      tenant: { id: tenant.id, name: tenant.name, accountType: tenant.accountType, slug: tenant.slug },
    };
  }

  private defaultTenantName(email: string): string {
    return email.split('@')[0] + "'s Organization";
  }

  private async uniqueSlug(base: string): Promise<string> {
    let slug = base;
    let attempt = 0;
    while (attempt < 10) {
      const existing = await prisma.tenant.findUnique({ where: { slug } });
      if (!existing) return slug;
      attempt++;
      slug = `${base}-${attempt}`;
    }
    // Fallback: append random suffix
    return `${base}-${Math.random().toString(36).slice(2, 6)}`;
  }
}
