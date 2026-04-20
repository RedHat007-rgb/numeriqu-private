import { Injectable, Inject, Logger } from '@nestjs/common';
import { PRISMA_TOKEN } from '../database/database.module';
import type { PrismaClient } from '@repo/db';
import { FinancialDataService } from '../financial-data/financial-data.service';

/**
 * AgentToolExecutor — The "Hands" of the Strategic Agent
 *
 * Implements all tools the Agent can invoke via [COMMAND:] blocks.
 * Fully isolated from RAG — RAG service never calls this.
 */
@Injectable()
export class AgentToolExecutor {
  private readonly logger = new Logger(AgentToolExecutor.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly financialData: FinancialDataService,
  ) {}

  /**
   * SAVE_INSIGHT: Persist a chart configuration to the user's dashboard.
   */
  async generateDashboard(
    tenantId: string,
    userId: string,
    params: {
      title: string;
      description?: string;
      charts: any[];
    },
  ) {
    this.logger.log(
      `[Agent:Exec] Starting Orchestration: "${params.title}" for tenant=${tenantId} user=${userId}`,
    );

    if (
      !params.charts ||
      !Array.isArray(params.charts) ||
      params.charts.length === 0
    ) {
      this.logger.warn(
        `[Agent:Exec] Dashboard creation aborted: No charts provided in payload.`,
      );
      throw new Error(
        'VALIDATION_ERROR: Dashboard must contain at least one chart.',
      );
    }

    try {
      // Create the dashboard with nested charts in a single transaction
      const dashboard = await this.prisma.dashboard.create({
        data: {
          tenantId,
          userId,
          title: params.title,
          description:
            params.description || 'Strategic insights curated by AI.',
          charts: {
            create: params.charts.map((chart, idx) => ({
              title: chart.title || 'Insight Segment',
              description: chart.description || '',
              type: chart.type || 'line',
              config: chart.config || {},
              layoutIndex: idx,
            })),
          },
        },
        include: { charts: true }, // Return with charts for logging
      });

      this.logger.log(
        `[Agent:Exec] Orchestration Successful: Dashboard ID ${dashboard.id} with ${dashboard.charts.length} components.`,
      );

      return {
        success: true,
        dashboardId: dashboard.id,
        message: `Strategic Dashboard "${params.title}" has been successfully orchestrated and pinned.`,
      };
    } catch (error: any) {
      this.logger.error(`[Agent:Exec] Orchestration Failed: ${error.message}`);
      if (error.code === 'P2003') {
        throw new Error(
          'PERSISTENCE_ERROR: Invalid Tenant or User association.',
        );
      }
      throw new Error(`DATABASE_ERROR: ${error.message}`);
    }
  }

  /**
   * SAVE_INSIGHT: Legacy persistence for single independent charts.
   */
  async saveInsightToDashboard(
    tenantId: string,
    params: {
      title: string;
      description?: string;
      type: string;
      config: any;
      category?: string;
    },
  ) {
    this.logger.log(`[Agent:SaveInsight] Creating legacy "${params.title}"`);
    try {
      const insight = await this.prisma.insight.create({
        data: {
          tenantId,
          title: params.title,
          description: params.description,
          type: params.type,
          config: params.config,
          category: params.category ?? 'general',
          pinned: true,
        },
      });
      return { success: true, insightId: insight.id };
    } catch (e: any) {
      this.logger.error(`[Agent:SaveInsight] Failed: ${e.message}`);
      throw new Error(`DATABASE_ERROR: Could not save chart.`);
    }
  }

  /**
   * QUERY_SQL: Execute a tenant-scoped, read-only SQL query against Gold Layer.
   */
  async queryFinancialDatabase(
    tenantId: string,
    params: { sql: string; reason: string },
  ) {
    this.logger.log(`[Agent:SQL] Executing: "${params.reason}"`);

    try {
      const rows = await this.financialData.executeScopedQuery(
        tenantId,
        params.sql,
      );
      return {
        success: true,
        data: rows,
        count: rows.length,
        executionReason: params.reason,
      };
    } catch (e: any) {
      this.logger.error(`[Agent:SQL] Failed: ${e.message}`);
      throw new Error(`ANALYSIS_FAULT: Query failed during investigation.`);
    }
  }

  /**
   * FETCH_METRICS: Deep dive into specific financial metrics.
   */
  async fetchSpecificMetrics(
    tenantId: string,
    params: {
      metric: 'revenue' | 'expenses' | 'profit' | 'invoices' | 'cashflow';
    },
  ) {
    this.logger.debug(
      `[Agent:FetchMetrics] ${params.metric} for tenant=${tenantId}`,
    );

    try {
      const profile = await this.financialData.getFinancialProfile(tenantId);

      switch (params.metric) {
        case 'revenue':
          return {
            data: profile.revenue,
            trend: await this.financialData.getMonthlyRevenueTrend(tenantId),
          };
        case 'expenses':
          return { data: profile.expenses };
        case 'invoices':
          return { data: profile.invoiceStats };
        default:
          return { data: profile };
      }
    } catch (error: any) {
      this.logger.error(`[Agent:FetchMetrics] Failed: ${error.message}`);
      throw new Error(
        `DATA_FETCH_ERROR: Could not retrieve ${params.metric} data.`,
      );
    }
  }
}
