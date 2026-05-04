import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@repo/db';
import { PRISMA_TOKEN } from '../../database/database.module';

type AuditEvent = {
  id: string;
  type: string;
  actorId: string | null;
  occurredAt: string;
  summary: string;
  payload?: Record<string, unknown> | null;
};

@Injectable()
export class AuditService {
  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient) {}

  async listOrganizationAuditEvents(organizationId: string, limit = 100): Promise<AuditEvent[]> {
    const safeLimit = Math.max(1, Math.min(limit, 500));

    const [
      agentEvents,
      invites,
      grants,
      shares,
      revisions,
      syncJobs,
      requests,
    ] = await Promise.all([
      this.prisma.agentRunEvent.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        take: safeLimit,
        include: { run: { select: { request: { select: { requestedById: true } } } } },
      }),
      this.prisma.organizationInvite.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        take: safeLimit,
      }),
      this.prisma.membershipPermissionGrant.findMany({
        where: { organizationId },
        orderBy: { grantedAt: 'desc' },
        take: safeLimit,
      }),
      this.prisma.dashboardShare.findMany({
        where: { organizationId },
        orderBy: { sharedAt: 'desc' },
        take: safeLimit,
      }),
      this.prisma.messageRevision.findMany({
        where: { organizationId },
        orderBy: { editedAt: 'desc' },
        take: safeLimit,
      }),
      this.prisma.syncJob.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        take: safeLimit,
      }),
      this.prisma.agentDashboardRequest.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        take: safeLimit,
      }),
    ]);

    const events: AuditEvent[] = [
      ...agentEvents.map((event) => ({
        id: event.id,
        type: `AGENT_${event.eventType}`,
        actorId: event.run.request.requestedById,
        occurredAt: event.createdAt.toISOString(),
        summary: `Agent event: ${event.eventType}`,
        payload:
          event.payload && typeof event.payload === 'object'
            ? (event.payload as Record<string, unknown>)
            : null,
      })),
      ...invites.map((invite) => ({
        id: invite.id,
        type: 'ORG_INVITE',
        actorId: invite.invitedById,
        occurredAt: invite.createdAt.toISOString(),
        summary: `Invite ${invite.status.toLowerCase()} for ${invite.email}`,
        payload: {
          role: invite.role,
          status: invite.status,
          acceptedAt: invite.acceptedAt?.toISOString() ?? null,
        },
      })),
      ...grants.map((grant) => ({
        id: grant.id,
        type: 'MEMBERSHIP_PERMISSION_GRANTED',
        actorId: grant.grantedById,
        occurredAt: grant.grantedAt.toISOString(),
        summary: `Permission granted: ${grant.permission}`,
        payload: { membershipId: grant.membershipId, permission: grant.permission },
      })),
      ...shares.map((share) => ({
        id: share.id,
        type: share.revokedAt ? 'DASHBOARD_UNSHARED' : 'DASHBOARD_SHARED',
        actorId: share.sharedByUserId,
        occurredAt: (share.revokedAt ?? share.sharedAt).toISOString(),
        summary: `Dashboard share ${share.revokedAt ? 'revoked' : 'created'}`,
        payload: {
          dashboardId: share.dashboardId,
          sharedWithUserId: share.sharedWithUserId,
          canEdit: share.canEdit,
        },
      })),
      ...revisions.map((revision) => ({
        id: revision.id,
        type: 'MESSAGE_EDITED',
        actorId: revision.editorId,
        occurredAt: revision.editedAt.toISOString(),
        summary: 'Message content edited',
        payload: { messageId: revision.messageId },
      })),
      ...syncJobs.map((job) => ({
        id: job.id,
        type: `SYNC_${job.status}`,
        actorId: job.requestedById,
        occurredAt: job.createdAt.toISOString(),
        summary: `Sync job ${job.status.toLowerCase()}`,
        payload: {
          connectionId: job.connectionId,
          recordsWritten: job.recordsWritten,
          errorMessage: job.errorMessage,
        },
      })),
      ...requests.map((request) => ({
        id: request.id,
        type: `AGENT_REQUEST_${request.status}`,
        actorId: request.requestedById,
        occurredAt: request.createdAt.toISOString(),
        summary: `Agent dashboard request ${request.status.toLowerCase()}`,
        payload: {
          generatedDashboardId: request.generatedDashboardId,
          errorCode: request.errorCode,
        },
      })),
    ];

    return events
      .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt))
      .slice(0, safeLimit);
  }
}
