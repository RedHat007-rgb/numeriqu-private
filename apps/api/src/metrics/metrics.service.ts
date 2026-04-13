import { Injectable, Inject, Logger } from '@nestjs/common';
import { CLICKHOUSE_ANALYTICS_TOKEN } from '../database/database.module';
import { ClickHouseClient } from '@clickhouse/client';

@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);

  constructor(
    @Inject(CLICKHOUSE_ANALYTICS_TOKEN) private readonly clickhouse: ClickHouseClient,
  ) {}

  async getRevenueByMonth(tenantId: string) {
    const dbName = process.env.CLICKHOUSE_ANALYTICS_DB || 'analytics';
    this.logger.log(`Fetching revenue by month for tenant ${tenantId} from ${dbName}`);
    try {
      const result = await this.clickhouse.query({
        query: `
          SELECT
            month,
            currency,
            SUM(total_revenue) as amount
          FROM ${dbName}.revenue_by_month
          WHERE tenant_id = {tenantId:String}
          GROUP BY month, currency
          ORDER BY month ASC
          LIMIT 500
        `,
        query_params: { tenantId },
        format: 'JSONEachRow',
        clickhouse_settings: {
          max_memory_usage: '536870912', // 512 MB per-query cap
          max_execution_time: 30,        // 30s hard timeout
        },
      });
      return await result.json();
    } catch (e: any) {
      this.logger.warn(`[Metrics] Revenue query degraded: ${e.message}`);
      return []; // Return empty — UI handles gracefully, no crash
    }
  }


  async getInvoices(tenantId: string) {
    const dbName = process.env.CLICKHOUSE_ANALYTICS_DB || 'analytics';
    const result = await this.clickhouse.query({
      query: `
        SELECT 
          invoice_id, customer_id, amount, currency, status, issue_date
        FROM ${dbName}.fact_accounting_invoices
        WHERE tenant_id = {tenantId:String}
        ORDER BY issue_date DESC
        LIMIT 100
      `,
      query_params: { tenantId },
      format: 'JSONEachRow',
    });
    return await result.json();
  }

  async getXeroExport(tenantId: string, resource?: string): Promise<string> {
    this.logger.log(`[Xero-Export] Exporting CSV for tenant ${tenantId}`);

    const dbName = process.env.CLICKHOUSE_XERO_DB || 'default';
    const resourceFilter = resource ? `AND resource = {resource:String}` : '';

    try {
      const result = await this.clickhouse.query({
        query: `
          SELECT 
            resource,
            source_id as id,
            updated_at,
            synced_at,
            raw_data
          FROM ${dbName}.xero_raw
          WHERE tenant_id = {tenantId:String}
          ${resourceFilter}
          ORDER BY updated_at DESC
        `,
        query_params: { tenantId, ...(resource ? { resource } : {}) },
        format: 'CSVWithNames',
      });
      return await result.text();
    } catch (e: any) {
      this.logger.error(`[Xero-Export] Failed to export CSV: ${e.message}`);
      throw e;
    }
  }
}
