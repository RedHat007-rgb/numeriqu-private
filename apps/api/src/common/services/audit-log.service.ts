import { Injectable, Logger } from '@nestjs/common';
import { prisma } from '@repo/db';

export type AuditAction =
  // Auth
  | 'user.login'
  | 'user.created'
  // Org management
  | 'member.invited'
  | 'member.invite_accepted'
  | 'member.removed'
  | 'member.permissions_updated'
  // Connections
  | 'connection.created'
  | 'connection.deleted'
  | 'connection.synced'
  | 'connection.sync_scheduled'
  // Dashboards
  | 'dashboard.created'
  | 'dashboard.published'
  | 'dashboard.shared'
  | 'dashboard.deleted'
  // Chat
  | 'chat.session_started'
  // System
  | 'system.error';

export interface AuditLogEntry {
  tenantId: string;
  userId?: string;
  action: AuditAction;
  resource?: string;
  resourceId?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}

/**
 * AuditLogService — Immutable security trail.
 *
 * Never throws — audit logging must never break the happy path.
 * Failures are swallowed and logged to stderr only.
 *
 * All writes are fire-and-forget with a try/catch to prevent
 * audit failures from bubbling up to the API response.
 */
@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  async log(entry: AuditLogEntry): Promise<void> {
    try {
      await prisma.auditLog.create({
        data: {
          tenantId: entry.tenantId,
          userId: entry.userId ?? null,
          action: entry.action,
          resource: entry.resource ?? null,
          resourceId: entry.resourceId ?? null,
          ipAddress: entry.ipAddress ?? null,
          userAgent: entry.userAgent ?? null,
          metadata: (entry.metadata ?? {}) as any,
        },
      });
    } catch (e: unknown) {
      // Never throw — audit logging must not break the request
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`[AuditLog] Failed to write audit entry: ${msg}`, {
        action: entry.action,
        tenantId: entry.tenantId,
      });
    }
  }

  /**
   * Convenience: fire-and-forget without awaiting.
   * Use this in controllers where you don't want to add latency.
   */
  logAsync(entry: AuditLogEntry): void {
    this.log(entry).catch(() => {
      // already handled inside log()
    });
  }

  /**
   * Fetch audit trail for a tenant (admin use only).
   */
  async getTrail(
    tenantId: string,
    opts: { limit?: number; action?: string; userId?: string } = {},
  ) {
    return prisma.auditLog.findMany({
      where: {
        tenantId,
        ...(opts.action ? { action: opts.action } : {}),
        ...(opts.userId ? { userId: opts.userId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: opts.limit ?? 50,
      select: {
        id: true,
        action: true,
        resource: true,
        resourceId: true,
        userId: true,
        ipAddress: true,
        metadata: true,
        createdAt: true,
      },
    });
  }
}
