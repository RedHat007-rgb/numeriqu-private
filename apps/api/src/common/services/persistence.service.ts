import { Injectable, Inject, Logger, NotFoundException } from '@nestjs/common';
import { PRISMA_TOKEN } from '../../database/database.module';
import type { PrismaClient } from '@repo/db';

/**
 * PersistenceService — Chat session + dashboard state management.
 *
 * DESIGN PRINCIPLES:
 * 1. TENANT ISOLATION: Every query binds to tenantId — no cross-tenant reads.
 * 2. SESSION OWNERSHIP: Sessions are verified to belong to the requesting user.
 * 3. CONNECTION SCOPING: Sessions can be scoped to a specific ERP org (connectionId).
 */
@Injectable()
export class PersistenceService {
  private readonly logger = new Logger(PersistenceService.name);

  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient) {}

  // ─── CHAT SESSIONS ──────────────────────────────────────────────────────────

  async getOrCreateSession(params: {
    tenantId: string;
    userId: string;
    sessionId?: string;
    title?: string;
    mode: 'agent' | 'rag';
    connectionId?: string | null;
  }) {
    if (params.sessionId) {
      const session = await this.prisma.chatSession.findFirst({
        where: {
          id: params.sessionId,
          tenantId: params.tenantId, // SECURITY: always verify tenant ownership
          userId: params.userId,
        },
        include: {
          messages: { orderBy: { createdAt: 'desc' }, take: 200 },
        },
      });

      if (!session) {
        throw new NotFoundException('Session not found or does not belong to you.');
      }

      // Return messages in chronological order for LLM context
      return { ...session, messages: [...session.messages].reverse() };
    }

    return this.prisma.chatSession.create({
      data: {
        tenantId: params.tenantId,
        userId: params.userId,
        title: params.title ?? `Session ${new Date().toLocaleDateString()}`,
        mode: params.mode,
        connectionId: params.connectionId ?? null,
      },
      include: { messages: true },
    });
  }

  async saveMessage(params: {
    sessionId: string;
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    toolCalls?: unknown;
    toolCallId?: string;
    tokens?: number;
    latencyMs?: number;
  }) {
    return this.prisma.chatMessage.create({
      data: {
        chatSessionId: params.sessionId,
        role: params.role,
        content: params.content,
        toolCalls: params.toolCalls ? (params.toolCalls as any) : null,
        toolCallId: params.toolCallId ?? null,
        tokens: params.tokens ?? 0,
        latencyMs: params.latencyMs ?? 0,
      },
    });
  }

  async listSessions(tenantId: string, userId: string, mode?: 'agent' | 'rag') {
    return this.prisma.chatSession.findMany({
      where: {
        tenantId,
        userId, // Users only see their own sessions
        ...(mode ? { mode } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: {
        id: true,
        title: true,
        mode: true,
        connectionId: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  // ─── DASHBOARDS ─────────────────────────────────────────────────────────────

  /**
   * Get a dashboard with tenant isolation check.
   * For members, verifies they have access (own or shared).
   */
  async getDashboard(id: string, tenantId: string, userId?: string, role?: string) {
    const where: Record<string, unknown> = { id, tenantId };

    if (role === 'member' && userId) {
      where.OR = [
        { userId },
        { shares: { some: { userId } }, isPublished: true },
      ];
    }

    return this.prisma.dashboard.findFirst({
      where: where as any,
      include: { charts: { orderBy: { layoutIndex: 'asc' } } },
    });
  }

  async listDashboards(tenantId: string, userId: string, role?: string) {
    const where =
      role === 'admin'
        ? { tenantId }
        : {
            tenantId,
            OR: [
              { userId },
              { shares: { some: { userId } }, isPublished: true },
            ],
          };

    return this.prisma.dashboard.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      include: { charts: { orderBy: { layoutIndex: 'asc' } } },
    });
  }

  async deleteDashboard(id: string, tenantId: string, userId: string, role?: string) {
    const dashboard = await this.prisma.dashboard.findFirst({
      where: { id, tenantId },
    });

    if (!dashboard) return { count: 0 };

    // Only creator or admin can delete
    if (role !== 'admin' && dashboard.userId !== userId) {
      throw new Error('Forbidden: you do not own this dashboard.');
    }

    return this.prisma.dashboard.deleteMany({ where: { id, tenantId } });
  }
}
