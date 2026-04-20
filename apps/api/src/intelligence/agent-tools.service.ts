import { Injectable, Inject, Logger } from '@nestjs/common';
import { PRISMA_TOKEN } from '../database/database.module';
import type { PrismaClient } from '@repo/db';
import { FinancialDataService } from './financial-data.service';

/**
 * AgentToolsService — The "Hands" of the Financial AI.
 *
 * Provides concrete implementations for the tools defined in the LLM tool registry.
 * All errors here are caught and formatted for the LLM to understand and explain to the user.
 */
@Injectable()
export class AgentToolsService {
  private readonly logger = new Logger(AgentToolsService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly financialData: FinancialDataService,
  ) {}

  /**
   * PERSIST: Saves a generated graph configuration to the user's dashboard.
   */
  async saveInsightToDashboard(
    tenantId: string,
    params: {
      title: string;
      description?: string;
      type: 'line' | 'bar' | 'pie' | 'metric' | 'table';
      config: any;
      category?: string;
    },
  ) {
    this.logger.log(
      `[Tool:SaveInsight] Creating "${params.title}" for tenant=${tenantId}`,
    );

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

      return {
        success: true,
        insightId: insight.id,
        message: `I've pinned the "${params.title}" chart to your dashboard insights section.`,
      };
    } catch (error: any) {
      this.logger.error(`Failed to save insight: ${error.message}`);
      throw new Error(
        `DATABASE_ERROR: I couldn't save this chart to your dashboard. Please try again or contact support if this persists.`,
      );
    }
  }

  /**
   * EXECUTE: Deep analytical SQL lookup.
   * Fully isolated, read-only, and injected with tenant context.
   */
  async queryFinancialDatabase(
    tenantId: string,
    params: { sql: string; reason: string },
  ) {
    this.logger.log(`[Tool:SQL] Executing analysis for: "${params.reason}"`);

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
      this.logger.error(`[Tool:SQL] Safe SQL failed: ${e.message}`);
      throw new Error(
        `ANALYSIS_FAULT: My investigation encounterd a technical hurdle while querying the live ledger.`,
      );
    }
  }

  /**
   * FETCH: Deep dive into specific financial metrics.
   */
  async fetchSpecificMetrics(
    tenantId: string,
    params: {
      metric: 'revenue' | 'expenses' | 'profit' | 'invoices' | 'cashflow';
      timeRange?: string;
      orgId?: string;
    },
  ) {
    this.logger.debug(
      `[Tool:FetchMetrics] ${params.metric} for tenant=${tenantId}`,
    );

    try {
      // In a real agent, this would call more granular ClickHouse queries.
      // For now, we reuse the high-performance analytics profile.
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
      this.logger.error(`Metric fetch tool failed: ${error.message}`);
      throw new Error(
        `DATA_FETCH_ERROR: I encountered an issue retrieving your ${params.metric} data from the analytics engine.`,
      );
    }
  }
}
