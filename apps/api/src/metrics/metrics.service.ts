import { Injectable, Inject, Logger } from '@nestjs/common';
import { CLICKHOUSE_ANALYTICS_TOKEN } from '../database/database.module';
import { ClickHouseClient } from '@clickhouse/client';

/**
 * MetricsService — Gold Layer ONLY
 *
 * DESIGN PRINCIPLE:
 * The Bronze→Silver→Gold pipeline exists so the READ path ONLY touches Gold.
 * If Gold is empty, we return empty data — NOT raw fallbacks.
 * The InlineTransformService is responsible for populating Gold after every sync.
 * If Gold is empty, that's a transform bug — not a read-path concern.
 */
@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);
  private readonly dbName: string;

  /** 30s cache to prevent redundant ClickHouse queries from frontend polling */
  private readonly cache = new Map<
    string,
    { data: any[]; expiresAt: number }
  >();
  private readonly CACHE_TTL_MS = 30_000;

  constructor(
    @Inject(CLICKHOUSE_ANALYTICS_TOKEN)
    private readonly clickhouse: ClickHouseClient,
  ) {
    this.dbName = process.env.CLICKHOUSE_ANALYTICS_DB || 'analytics';
  }

  async getRevenueByMonth(tenantId: string) {
    const cached = this.cache.get(`revenue:${tenantId}`);
    if (cached && Date.now() < cached.expiresAt) return cached.data;

    try {
      const result = await this.clickhouse.query({
        query: `
          SELECT
            month,
            currency,
            SUM(total_amount) as amount
          FROM ${this.dbName}.revenue_by_month
          WHERE tenant_id = {tenantId:String}
          GROUP BY month, currency
          ORDER BY month ASC
        `,
        query_params: { tenantId },
        format: 'JSONEachRow',
      });
      const data: any[] = await result.json();

      this.cache.set(`revenue:${tenantId}`, {
        data,
        expiresAt: Date.now() + this.CACHE_TTL_MS,
      });

      if (data.length === 0) {
        this.logger.debug(
          `[Metrics] Gold Layer has no revenue data yet for tenant=${tenantId}. Transformation may be pending.`,
        );
      }

      return data;
    } catch (e: any) {
      this.logger.error(`[Metrics] Revenue query failed: ${e.message}`);
      return [];
    }
  }

  async getInvoices(tenantId: string) {
    try {
      const result = await this.clickhouse.query({
        query: `
          SELECT 
            invoice_id, invoice_number, total_amount, currency, status, issued_at
          FROM ${this.dbName}.fact_accounting_invoices
          WHERE tenant_id = {tenantId:String}
          ORDER BY issued_at DESC
          LIMIT 100
        `,
        query_params: { tenantId },
        format: 'JSONEachRow',
      });
      return await result.json();
    } catch (e: any) {
      this.logger.error(`[Metrics] Invoice query failed: ${e.message}`);
      return [];
    }
  }

  async getXeroExport(tenantId: string, resource?: string): Promise<string> {
    // Export is the ONE place where raw is acceptable — it's an explicit user action
    // to export their raw ingested data, not an analytics query.
    const dbName = process.env.CLICKHOUSE_XERO_DB || 'xero_custom';
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
      this.logger.error(`[Metrics] CSV export failed: ${e.message}`);
      throw e;
    }
  }
}
