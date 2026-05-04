import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { prisma } from '@repo/db';
import { AuditLogService } from './audit-log.service';

export interface PermissionUpdate {
  canCreateDashboard?: boolean;
  canShareDashboard?: boolean;
  canQueryRag?: boolean;
  canUseAgent?: boolean;
}

/**
 * UserPermissionsService — Granular permission management for member users.
 *
 * Admins always have full access — no permission record needed.
 * This service only operates on MEMBER users' permission records.
 */
@Injectable()
export class UserPermissionsService {
  private readonly logger = new Logger(UserPermissionsService.name);

  constructor(private readonly auditLog: AuditLogService) {}

  /**
   * Create a default permission record for a newly invited member.
   * Called automatically when a member accepts an invite.
   * Defaults: RAG enabled, dashboards/agent disabled (least privilege).
   */
  async createDefaultForMember(
    userId: string,
    tenantId: string,
    grantedBy: string,
  ): Promise<void> {
    try {
      await prisma.userPermission.upsert({
        where: { userId },
        create: {
          userId,
          tenantId,
          canCreateDashboard: false,
          canShareDashboard: false,
          canQueryRag: true,
          canUseAgent: false,
          grantedBy,
        },
        update: {},
      });

      this.logger.log(
        `[Permissions] Default permissions created for member=${userId} tenant=${tenantId}`,
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`[Permissions] Failed to create default permissions: ${msg}`);
      throw e;
    }
  }

  async updatePermissions(
    adminUserId: string,
    targetUserId: string,
    tenantId: string,
    updates: PermissionUpdate,
  ): Promise<void> {
    const targetUser = await prisma.user.findFirst({
      where: { id: targetUserId, tenantId },
      select: { id: true, role: true },
    });

    if (!targetUser) {
      throw new NotFoundException('User not found in this organization.');
    }

    if (targetUser.role === 'admin') {
      throw new ForbiddenException(
        'Cannot modify permissions of an admin. Admins always have full access.',
      );
    }

    await prisma.userPermission.upsert({
      where: { userId: targetUserId },
      create: {
        userId: targetUserId,
        tenantId,
        canCreateDashboard: updates.canCreateDashboard ?? false,
        canShareDashboard: updates.canShareDashboard ?? false,
        canQueryRag: updates.canQueryRag ?? true,
        canUseAgent: updates.canUseAgent ?? false,
        grantedBy: adminUserId,
      },
      update: { ...updates, grantedBy: adminUserId },
    });

    this.logger.log(
      `[Permissions] Updated for userId=${targetUserId} by admin=${adminUserId}`,
    );

    this.auditLog.logAsync({
      tenantId,
      userId: adminUserId,
      action: 'member.permissions_updated',
      resource: 'user',
      resourceId: targetUserId,
      metadata: { updates },
    });
  }

  async getPermissions(userId: string, tenantId: string) {
    const user = await prisma.user.findFirst({
      where: { id: userId, tenantId },
      select: { id: true, email: true, name: true, role: true, permission: true },
    });

    if (!user) {
      throw new NotFoundException('User not found in this organization.');
    }

    if (user.role === 'admin') {
      return {
        userId: user.id,
        canCreateDashboard: true,
        canShareDashboard: true,
        canQueryRag: true,
        canUseAgent: true,
        isAdmin: true,
      };
    }

    return {
      userId: user.id,
      ...(user.permission ?? {
        canCreateDashboard: false,
        canShareDashboard: false,
        canQueryRag: true,
        canUseAgent: false,
      }),
      isAdmin: false,
    };
  }
}
