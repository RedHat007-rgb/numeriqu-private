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
  async ensureProvisioned(supabaseUserId: string, email: string): Promise<{
    user: { id: string; email: string };
    tenant: { id: string; name: string };
  }> {
    // Check if user already exists
    let user = await prisma.user.findUnique({
      where: { id: supabaseUserId },
      include: { connections: { include: { tenant: true }, take: 1 } },
    });

    if (user) {
      // Find their tenant from connections, or create one
      const existingTenant = user.connections[0]?.tenant;
      if (existingTenant) {
        return {
          user: { id: user.id, email: user.email },
          tenant: { id: existingTenant.id, name: existingTenant.name },
        };
      }
    }

    // JIT Provisioning
    this.logger.log(`[JIT] Provisioning new user: ${email}`);

    // Upsert user (use Supabase auth UUID as the PK)
    user = await prisma.user.upsert({
      where: { id: supabaseUserId },
      create: {
        id: supabaseUserId,
        email,
        name: email.split('@')[0],
      },
      update: { email }, // Keep email in sync with Supabase
      include: { connections: { include: { tenant: true }, take: 1 } },
    });

    // Check if they have a tenant via connections
    let tenant = user.connections[0]?.tenant;

    if (!tenant) {
      // Create a default tenant for this user
      tenant = await prisma.tenant.create({
        data: {
          name: email.split('@')[0] + "'s Organization",
        },
      });
      this.logger.log(`[JIT] Created tenant=${tenant.id} for user=${user.id}`);
    }

    return {
      user: { id: user.id, email: user.email },
      tenant: { id: tenant.id, name: tenant.name },
    };
  }
}
