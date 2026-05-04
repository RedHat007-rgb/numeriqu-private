import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@repo/db';
import {
  CLICKHOUSE_ANALYTICS_TOKEN,
  PRISMA_TOKEN,
} from '../../database/database.module';
import type { ClickHouseClient } from '@clickhouse/client';

type OrganizationScope = {
  connectionIds: string[];
  externalOrgIds: string[];
};

type RagSummaryRow = {
  invoice_count: string | number;
  total_amount: string | number;
  open_amount: string | number;
};

type RagContextRow = {
  text_content: string;
};

const SAFE_QUERY_SETTINGS = {
  max_memory_usage: '536870912',
  max_execution_time: 20,
};

@Injectable()
export class RagService {
  private readonly analyticsDb: string;

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    @Inject(CLICKHOUSE_ANALYTICS_TOKEN)
    private readonly clickhouse: ClickHouseClient,
  ) {
    this.analyticsDb = process.env.CLICKHOUSE_ANALYTICS_DB || 'analytics';
  }

  private chunk(type: string, payload: Record<string, unknown>) {
    return JSON.stringify({ type, ...payload }) + '\n';
  }

  private asNumber(value: unknown) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }

  private async getOrganizationScope(organizationId: string): Promise<OrganizationScope> {
    const connections = await this.prisma.erpConnection.findMany({
      where: { organizationId, status: 'ACTIVE' },
      select: { id: true, externalOrganizationId: true },
    });

    return {
      connectionIds: connections.map((connection) => connection.id),
      externalOrgIds: connections
        .map((connection) => connection.externalOrganizationId)
        .filter((value): value is string => Boolean(value)),
    };
  }

  private async readSummary(scope: OrganizationScope, organizationId: string) {
    if (scope.connectionIds.length === 0) {
      return { invoiceCount: 0, totalAmount: 0, openAmount: 0 };
    }

    const result = await this.clickhouse.query({
      query: `
        SELECT
          count() AS invoice_count,
          coalesce(sum(total_amount), 0) AS total_amount,
          coalesce(
            sumIf(total_amount, lowerUTF8(status) NOT IN ('paid', 'closed')),
            0
          ) AS open_amount
        FROM ${this.analyticsDb}.fact_accounting_invoices
        WHERE connection_id IN ({connectionIds:Array(String)})
          AND (
            tenant_id = {organizationId:String}
            OR org_id IN ({externalOrgIds:Array(String)})
          )
      `,
      query_params: {
        connectionIds: scope.connectionIds,
        organizationId,
        externalOrgIds: scope.externalOrgIds,
      },
      format: 'JSONEachRow',
      clickhouse_settings: SAFE_QUERY_SETTINGS,
    });

    const rows = (await result.json()) as RagSummaryRow[];
    const row = rows[0];
    if (!row) return { invoiceCount: 0, totalAmount: 0, openAmount: 0 };
    return {
      invoiceCount: this.asNumber(row.invoice_count),
      totalAmount: this.asNumber(row.total_amount),
      openAmount: this.asNumber(row.open_amount),
    };
  }

  private async readContextSnippets(scope: OrganizationScope, organizationId: string) {
    if (scope.externalOrgIds.length === 0) return [];

    const result = await this.clickhouse.query({
      query: `
        SELECT text_content
        FROM ${this.analyticsDb}.rag_context_invoices
        WHERE
          tenant_id = {organizationId:String}
          OR org_id IN ({externalOrgIds:Array(String)})
        ORDER BY issued_at DESC
        LIMIT 3
      `,
      query_params: {
        organizationId,
        externalOrgIds: scope.externalOrgIds,
      },
      format: 'JSONEachRow',
      clickhouse_settings: SAFE_QUERY_SETTINGS,
    });

    const rows = (await result.json()) as RagContextRow[];
    return rows
      .map((row) => row.text_content?.trim())
      .filter((value): value is string => Boolean(value));
  }

  async health() {
    return {
      status: 'operational',
      advisory: 'RAG layer ready',
      mode: 'database-grounded',
      ollama: false,
    };
  }

  async listSessions(organizationId: string, userId: string) {
    const sessions = await this.prisma.ragChatSession.findMany({
      where: { organizationId, userId },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      include: { _count: { select: { messages: true } } },
    });

    return sessions.map((session) => ({
      id: session.id,
      title: session.title,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
      messageCount: session._count.messages,
    }));
  }

  async getSession(organizationId: string, userId: string, sessionId: string) {
    const session = await this.prisma.ragChatSession.findFirst({
      where: { id: sessionId, organizationId, userId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!session) return null;
    return {
      id: session.id,
      title: session.title,
      messages: session.messages.map((message) => ({
        role: message.role.toLowerCase(),
        content: message.content,
      })),
    };
  }

  async *query(
    organizationId: string,
    userId: string,
    query: string,
    sessionId?: string,
  ): AsyncGenerator<string> {
    const session = sessionId
      ? await this.prisma.ragChatSession.findFirst({
          where: { id: sessionId, organizationId, userId },
        })
      : null;

    const currentSession =
      session ||
      (await this.prisma.ragChatSession.create({
        data: {
          organizationId,
          userId,
          title: query.slice(0, 80),
        },
      }));

    await this.prisma.ragChatMessage.create({
      data: {
        sessionId: currentSession.id,
        organizationId,
        role: 'USER',
        content: query,
      },
    });

    const scope = await this.getOrganizationScope(organizationId);
    const summary = await this.readSummary(scope, organizationId);
    const snippets = await this.readContextSnippets(scope, organizationId);

    const answer =
      `Based on your ClickHouse gold-layer data, there are ${summary.invoiceCount} invoices, ` +
      `total invoice value is ${summary.totalAmount.toFixed(2)}, ` +
      `and open amount is ${summary.openAmount.toFixed(2)}.` +
      (snippets.length > 0
        ? `\n\nRecent context:\n- ${snippets.join('\n- ')}`
        : '');

    yield this.chunk('status', { message: 'Analyzing financial context...' });
    for (const piece of answer.match(/.{1,40}/g) || [answer]) {
      yield this.chunk('token', { content: piece });
    }

    await this.prisma.ragChatMessage.create({
      data: {
        sessionId: currentSession.id,
        organizationId,
        role: 'ASSISTANT',
        content: answer,
      },
    });

    yield this.chunk('done', {
      metrics: { sessionId: currentSession.id, mode: 'rag', totalMs: 1 },
    });
  }
}
