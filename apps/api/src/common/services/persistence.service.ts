import { Injectable, Inject, Logger } from '@nestjs/common';
import { PRISMA_TOKEN } from '../../database/database.module';
import type { PrismaClient } from '@repo/db';

/**
 * PersistenceService — Master Orchestrator for Analytical State
 * 
 * DESIGN PRINCIPLES:
 * 1. TENANT ISOLATION: Every query MUST bind to tenantId.
 * 2. DURABLE HISTORY: Auto-creates sessions if sessionId is missing.
 * 3. REAL-TIME DASHBOARDS: Stores configuration, NOT results.
 */
@Injectable()
export class PersistenceService {
  private readonly logger = new Logger(PersistenceService.name);

  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient) {}

  // ─── CHAT SESSION MANAGEMENT ───────────────────────────────────────────────

  async getOrCreateSession(params: {
    tenantId: string;
    userId: string;
    sessionId?: string;
    title?: string;
    mode: 'agent' | 'rag';
  }) {
    if (params.sessionId) {
      const session = await this.prisma.chatSession.findUnique({
        where: { id: params.sessionId },
        include: {
          // Latest turns for the model (ascending `take` would incorrectly keep only the *oldest* rows).
          messages: { orderBy: { createdAt: 'desc' }, take: 200 },
        },
      });
      if (session) {
        const chronological = [...session.messages].reverse();
        return { ...session, messages: chronological };
      }
    }

    return this.prisma.chatSession.create({
      data: {
        tenantId: params.tenantId,
        userId: params.userId,
        title: params.title || `Mission: ${new Date().toLocaleDateString()}`,
        mode: params.mode,
      },
      include: { messages: true },
    });
  }

  async saveMessage(params: {
    sessionId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    toolCalls?: any;
    tokens?: number;
    latencyMs?: number;
  }) {
    return this.prisma.chatMessage.create({
      data: {
        chatSessionId: params.sessionId,
        role: params.role,
        content: params.content,
        toolCalls: params.toolCalls || null,
        tokens: params.tokens || 0,
        latencyMs: params.latencyMs || 0,
      },
    });
  }

  async listSessions(tenantId: string, userId: string, mode?: 'agent' | 'rag') {
    return this.prisma.chatSession.findMany({
      where: { tenantId, userId, ...(mode ? { mode } : {}) },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });
  }

  // ─── DASHBOARD MANAGEMENT ──────────────────────────────────────────────────

  async getDashboard(id: string, tenantId: string) {
    return this.prisma.dashboard.findFirst({
      where: { id, tenantId },
      include: { charts: { orderBy: { layoutIndex: 'asc' } } },
    });
  }

  async listDashboards(tenantId: string, userId: string) {
    return this.prisma.dashboard.findMany({
      where: { tenantId, userId },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async deleteDashboard(id: string, tenantId: string) {
    return this.prisma.dashboard.deleteMany({
      where: { id, tenantId },
    });
  }
}
