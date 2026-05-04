import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient, Prisma } from '@repo/db';
import {
  CLICKHOUSE_ANALYTICS_TOKEN,
  PRISMA_TOKEN,
} from '../../database/database.module';
import type { ClickHouseClient } from '@clickhouse/client';
import { OrganizationContextService } from '../org-context/org-context.service';

type OrganizationScope = {
  connectionIds: string[];
  externalOrgIds: string[];
};

type RevenueTrendRow = {
  month: string;
  total_revenue: string | number;
};

type RevenueOrgRow = {
  org_name: string | null;
  total_revenue: string | number;
};

type StatusRow = {
  status: string;
  total_amount: string | number;
  total_count: string | number;
};

type VentureSummaryRow = {
  total_revenue: string | number;
  open_amount: string | number;
};

const SAFE_QUERY_SETTINGS = {
  max_memory_usage: '536870912',
  max_execution_time: 20,
};

@Injectable()
export class AgentService {
  private readonly analyticsDb: string;

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    @Inject(CLICKHOUSE_ANALYTICS_TOKEN)
    private readonly clickhouse: ClickHouseClient,
    private readonly orgContext: OrganizationContextService,
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

  private async queryRows<T>(
    query: string,
    queryParams: Record<string, unknown>,
  ): Promise<T[]> {
    const result = await this.clickhouse.query({
      query,
      query_params: queryParams,
      format: 'JSONEachRow',
      clickhouse_settings: SAFE_QUERY_SETTINGS,
    });
    return (await result.json()) as T[];
  }

  async health() {
    return {
      status: 'operational',
      advisory: 'Agent layer ready',
      mode: 'dashboard-agent',
      ollama: false,
    };
  }

  async listSessions(organizationId: string, userId: string) {
    const sessions = await this.prisma.agentChatSession.findMany({
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
    const session = await this.prisma.agentChatSession.findFirst({
      where: { id: sessionId, organizationId, userId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!session) return null;
    return {
      id: session.id,
      title: session.title,
      messages: session.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    };
  }

  async latestDashboard(organizationId: string, userId: string) {
    const dashboard = await this.prisma.dashboard.findFirst({
      where: {
        organizationId,
        ownerId: userId,
        deletedAt: null,
      },
      orderBy: { updatedAt: 'desc' },
      include: {
        widgets: {
          orderBy: { displayOrder: 'asc' },
        },
      },
    });

    if (!dashboard) return null;
    return {
      id: dashboard.id,
      title: dashboard.title,
      description: dashboard.description,
      charts: dashboard.widgets.map((widget) => ({
        id: widget.id,
        title: widget.title,
        description: null,
        type: widget.chartType,
        config:
          typeof widget.queryConfig === 'object' && widget.queryConfig
            ? widget.queryConfig
            : { metric: 'revenue', grouping: 'month' },
        layoutIndex: widget.displayOrder,
      })),
    };
  }

  async metricData(organizationId: string, metric: string, grouping: string) {
    const scope = await this.getOrganizationScope(organizationId);
    if (scope.connectionIds.length === 0) {
      return { data: [] };
    }

    if (metric === 'venture') {
      const rows = await this.queryRows<VentureSummaryRow>(
        `
          SELECT
            coalesce(sum(total_amount), 0) AS total_revenue,
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
        {
          connectionIds: scope.connectionIds,
          organizationId,
          externalOrgIds: scope.externalOrgIds,
        },
      );

      const summary = rows[0];
      const revenue = this.asNumber(summary?.total_revenue ?? 0);
      const openAmount = this.asNumber(summary?.open_amount ?? 0);
      const expenses = openAmount;
      return {
        data: [
          {
            burnRate: expenses,
            runwayMonths: 0,
            cashOnHand: revenue - expenses,
            efficiencyMultiplier: expenses > 0 ? revenue / expenses : 0,
          },
        ],
      };
    }

    if (metric === 'invoices' && grouping === 'status') {
      const grouped = await this.queryRows<StatusRow>(
        `
          SELECT
            status,
            coalesce(sum(total_amount), 0) AS total_amount,
            count() AS total_count
          FROM ${this.analyticsDb}.fact_accounting_invoices
          WHERE connection_id IN ({connectionIds:Array(String)})
            AND (
              tenant_id = {organizationId:String}
              OR org_id IN ({externalOrgIds:Array(String)})
            )
          GROUP BY status
        `,
        {
          connectionIds: scope.connectionIds,
          organizationId,
          externalOrgIds: scope.externalOrgIds,
        },
      );
      return {
        data: grouped.map((row) => ({
          name: row.status,
          value: this.asNumber(row.total_amount),
          count: this.asNumber(row.total_count),
        })),
      };
    }

    if (metric === 'revenue' && grouping === 'org') {
      const grouped = await this.queryRows<RevenueOrgRow>(
        `
          SELECT
            org_name,
            coalesce(sum(total_revenue), 0) AS total_revenue
          FROM ${this.analyticsDb}.revenue_by_month
          WHERE
            tenant_id = {organizationId:String}
            OR org_id IN ({externalOrgIds:Array(String)})
          GROUP BY org_name
          ORDER BY total_revenue DESC
        `,
        {
          organizationId,
          externalOrgIds: scope.externalOrgIds,
        },
      );

      return {
        data: grouped.map((row) => ({
          name: row.org_name || 'Unknown Org',
          value: this.asNumber(row.total_revenue),
        })),
      };
    }

    const trend = await this.queryRows<RevenueTrendRow>(
      `
        SELECT
          month,
          coalesce(sum(total_revenue), 0) AS total_revenue
        FROM ${this.analyticsDb}.revenue_by_month
        WHERE
          tenant_id = {organizationId:String}
          OR org_id IN ({externalOrgIds:Array(String)})
        GROUP BY month
        ORDER BY month ASC
        LIMIT 24
      `,
      {
        organizationId,
        externalOrgIds: scope.externalOrgIds,
      },
    );

    return {
      data: trend.map((row) => {
        const month = new Date(row.month);
        const mm = String(month.getMonth() + 1).padStart(2, '0');
        const yy = String(month.getFullYear()).slice(2);
        return { name: `${mm}/${yy}`, value: this.asNumber(row.total_revenue) };
      }),
    };
  }

  async *query(
    organizationId: string,
    userId: string,
    query: string,
    sessionId?: string,
  ): AsyncGenerator<string> {
    const request = await this.prisma.agentDashboardRequest.create({
      data: {
        organizationId,
        requestedById: userId,
        prompt: query,
        status: 'RUNNING',
      },
    });

    const run = await this.prisma.agentRun.create({
      data: {
        requestId: request.id,
        organizationId,
        status: 'RUNNING',
        startedAt: new Date(),
      },
    });
    const runStartedAt = Date.now();

    const logRunEvent = async (eventType: string, payload?: Record<string, unknown>) => {
      await this.prisma.agentRunEvent.create({
        data: {
          runId: run.id,
          organizationId,
          eventType,
          ...(payload ? { payload: payload as Prisma.InputJsonValue } : {}),
        },
      });
    };

    const session = sessionId
      ? await this.prisma.agentChatSession.findFirst({
          where: { id: sessionId, organizationId, userId },
        })
      : null;

    const currentSession =
      session ||
      (await this.prisma.agentChatSession.create({
        data: { organizationId, userId, title: query.slice(0, 80) },
      }));

    if (!request.agentSessionId) {
      await this.prisma.agentDashboardRequest.update({
        where: { id: request.id },
        data: { agentSessionId: currentSession.id },
      });
    }

    await this.prisma.agentChatMessage.create({
      data: {
        sessionId: currentSession.id,
        organizationId,
        role: 'user',
        content: query,
      },
    });

    const shouldCreateDashboard = /dashboard|chart|kpi|insight/i.test(query);
    let dashboardId: string | null = null;
    let reply =
      'Completed financial analysis. Ask for a dashboard to generate visual insights.';

    try {
      await logRunEvent('QUERY_RECEIVED', {
        sessionId: currentSession.id,
        shouldCreateDashboard,
      });

      if (shouldCreateDashboard) {
        await this.orgContext.assertPermission(
          organizationId,
          userId,
          'CREATE_DASHBOARD',
        );
        await logRunEvent('DASHBOARD_PERMISSION_GRANTED', {
          permission: 'CREATE_DASHBOARD',
        });

        const dashboard = await this.prisma.dashboard.create({
          data: {
            organizationId,
            ownerId: userId,
            title: `Generated Dashboard · ${new Date().toISOString().slice(0, 10)}`,
            description: 'Auto-generated from agent query',
            config: { source: 'agent', query },
            permissions: { shared: false },
          },
        });
        dashboardId = dashboard.id;

        await this.prisma.dashboardWidget.createMany({
          data: [
            {
              organizationId,
              dashboardId: dashboard.id,
              title: 'Revenue by Month',
              chartType: 'line',
              queryConfig: { metric: 'revenue', grouping: 'month' },
              chartConfig: { yAxis: 'amount' },
              displayOrder: 0,
            },
            {
              organizationId,
              dashboardId: dashboard.id,
              title: 'Revenue by Organization',
              chartType: 'bar',
              queryConfig: { metric: 'revenue', grouping: 'org' },
              chartConfig: { yAxis: 'amount' },
              displayOrder: 1,
            },
            {
              organizationId,
              dashboardId: dashboard.id,
              title: 'Invoice Status',
              chartType: 'pie',
              queryConfig: { metric: 'invoices', grouping: 'status' },
              chartConfig: { series: 'amount' },
              displayOrder: 2,
            },
            {
              organizationId,
              dashboardId: dashboard.id,
              title: 'Venture Health',
              chartType: 'metric',
              queryConfig: { metric: 'venture', grouping: 'summary' },
              chartConfig: { cards: 4 },
              displayOrder: 3,
            },
          ],
        });

        reply = `Generated a new dashboard with 4 charts. Dashboard ID: ${dashboardId}.`;
        await logRunEvent('DASHBOARD_GENERATED', { dashboardId });
      }

      await this.prisma.agentDashboardRequest.update({
        where: { id: request.id },
        data: {
          status: 'SUCCEEDED',
          generatedDashboardId: dashboardId,
          completedAt: new Date(),
        },
      });
      await this.prisma.agentRun.update({
        where: { id: run.id },
        data: {
          status: 'SUCCEEDED',
          completedAt: new Date(),
          latencyMs: Date.now() - runStartedAt,
        },
      });

      yield this.chunk('status', { message: 'Processing strategic request...' });
      for (const piece of reply.match(/.{1,40}/g) || [reply]) {
        yield this.chunk('token', { content: piece });
      }

      await this.prisma.agentChatMessage.create({
        data: {
          sessionId: currentSession.id,
          organizationId,
          role: 'assistant',
          content: reply,
        },
      });

      await logRunEvent('QUERY_COMPLETED', {
        sessionId: currentSession.id,
        dashboardId,
      });

      yield this.chunk('done', {
        metrics: {
          sessionId: currentSession.id,
          mode: 'agent',
          totalMs: Date.now() - runStartedAt,
          runId: run.id,
          requestId: request.id,
        },
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Agent request failed unexpectedly.';

      await this.prisma.agentDashboardRequest.update({
        where: { id: request.id },
        data: {
          status: 'FAILED',
          errorCode: 'AGENT_QUERY_FAILED',
          errorMessage: message,
          completedAt: new Date(),
        },
      });

      await this.prisma.agentRun.update({
        where: { id: run.id },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
          latencyMs: Date.now() - runStartedAt,
        },
      });
      await logRunEvent('QUERY_FAILED', { message });

      yield this.chunk('error', {
        message:
          message.includes('Missing required permission')
            ? 'You do not have permission to generate dashboards in this organization.'
            : 'Agent request failed. Please retry.',
      });
    }
  }
}
