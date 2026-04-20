import { Injectable, Logger } from '@nestjs/common';
import { prisma } from '@repo/db';

/**
 * UserProvisioningService — Auto-creates user + tenant on first authenticated request.
 *
 * Pattern: "JIT (Just-In-Time) Provisioning"
 * - When a Supabase user logs in for the first time, this service
 *   auto-creates their User + Tenant records in PostgreSQL.
 * - Subsequent calls return the cached/existing records.
 */
@Injectable()
export class UserProvisioningService {
  private readonly logger = new Logger(UserProvisioningService.name);

  /**
   * Ensure a user + tenant exist for the given Supabase auth ID.
   * Creates them if they don't exist (idempotent).
   */
  async ensureProvisioned(
    supabaseUserId: string,
    email: string,
  ): Promise<{
    user: { id: string; email: string };
    tenant: { id: string; name: string };
  }> {
    // 1. Check if user already exists with an associated tenant
    let user = await prisma.user.findUnique({
      where: { id: supabaseUserId },
      include: { tenant: true },
    });

    if (user?.tenant) {
      return {
        user: { id: user.id, email: user.email },
        tenant: { id: user.tenant.id, name: user.tenant.name },
      };
    }

    // 2. JIT Provisioning Strategy
    this.logger.log(`[JIT] Provisioning infrastructure for user: ${email}`);

    // If user exists but has no tenantId (legacy migration path)
    if (user && !user.tenantId) {
      this.logger.warn(
        `[JIT] User ${user.email} exists without tenant. Creating stable association...`,
      );
      const tenant = await prisma.tenant.create({
        data: { name: email.split('@')[0] + "'s Organization" },
      });
      user = await prisma.user.update({
        where: { id: user.id },
        data: { tenantId: tenant.id },
        include: { tenant: true },
      });
      return {
        user: { id: user.id, email: user.email },
        tenant: { id: tenant.id, name: tenant.name },
      };
    }

    // 3. Complete new provisioning
    const tenant = await prisma.tenant.create({
      data: { name: email.split('@')[0] + "'s Organization" },
    });

    user = await prisma.user.create({
      data: {
        id: supabaseUserId,
        email,
        name: email.split('@')[0],
        tenantId: tenant.id,
      },
      include: { tenant: true },
    });

    this.logger.log(
      `[JIT] Production environment ready: tenant=${tenant.id} for user=${user.id}`,
    );

    return {
      user: { id: user.id, email: user.email },
      tenant: { id: tenant.id, name: tenant.name },
    };
  }
}
