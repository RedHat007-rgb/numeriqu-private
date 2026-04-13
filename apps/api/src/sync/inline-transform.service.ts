import { Injectable, Inject, Logger } from '@nestjs/common';
import { ClickHouseClient } from '@clickhouse/client';
import {
  CLICKHOUSE_ANALYTICS_TOKEN,
  CLICKHOUSE_XERO_TOKEN,
  CLICKHOUSE_QUICKBOOKS_TOKEN,
} from '../database/database.module';

/**
 * InlineTransformService — Sub-Second Gold Layer Transformation
 *
 * Replaces the dbt subprocess with native ClickHouse INSERT...SELECT queries
 * executed directly in the Node.js process. No subprocess fork overhead,
 * no 5s debounce, no 8.5s dbt runtime.
 *
 * Architecture:
 *   Raw Layer (xero_custom.xero_raw / quickbooks.quickbooks_raw)
 *     → [INSERT INTO...SELECT via ClickHouse client] →
 *   Gold Layer (analytics.fact_accounting_invoices, analytics.revenue_by_month)
 *
 * Target SLA: < 1 second per tenant per provider.
 */
@Injectable()
export class InlineTransformService {
  private readonly logger = new Logger(InlineTransformService.name);

  private readonly analyticsDb = process.env.CLICKHOUSE_ANALYTICS_DB || 'analytics';
  private readonly xeroDb = process.env.CLICKHOUSE_XERO_DB || 'xero_custom';
  private readonly qbDb = 'quickbooks';

  constructor(
    @Inject(CLICKHOUSE_ANALYTICS_TOKEN)
    private readonly chAnalytics: ClickHouseClient,
    @Inject(CLICKHOUSE_XERO_TOKEN)
    private readonly chXero: ClickHouseClient,
    @Inject(CLICKHOUSE_QUICKBOOKS_TOKEN)
    private readonly chQb: ClickHouseClient,
  ) {}

  /**
   * Run end-to-end transformation for a single tenant + provider sync.
   * Called directly after ingestion completes — no debounce, no subprocess.
   */
  async transformForProvider(
    tenantId: string,
    orgId: string,
    provider: 'xero' | 'quickbooks',
  ): Promise<void> {
    const start = Date.now();
    const startTime = new Date().toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    this.logger.log(
      `[Transform] ▶ Starting Gold Layer transform for [${provider.toUpperCase()}] org:${orgId} at ${startTime}`,
    );

    try {
      await this.upsertFactInvoices(tenantId, orgId, provider);
      await this.upsertRevenueByMonth(tenantId, orgId, provider);

      const elapsed = Date.now() - start;
      const completedAt = new Date().toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      this.logger.log(
        `[Transform] ✅ [${provider.toUpperCase()}] Gold Layer ready — ` +
        `completed at ${completedAt} in ${elapsed}ms | ` +
        `org: ${orgId} | tenant: ${tenantId}`,
      );
    } catch (e: any) {
      const failedAt = new Date().toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      this.logger.error(
        `[Transform] ✗ [${provider.toUpperCase()}] FAILED at ${failedAt} for org:${orgId} — ${e.message}`,
      );
      // Non-fatal: data is already in raw layer. Next sync will re-trigger transform.
    }
  }

  /**
   * Upsert fact_accounting_invoices using native ClickHouse SQL.
   * Translates stg_xero_invoices.sql + stg_qb_invoices.sql + fact_accounting_invoices.sql
   * into a single INSERT INTO...SELECT statement per provider.
   */
  private async upsertFactInvoices(
    tenantId: string,
    orgId: string,
    provider: 'xero' | 'quickbooks',
  ): Promise<void> {
    const dest = `${this.analyticsDb}.fact_accounting_invoices`;

    let selectSql: string;

    if (provider === 'xero') {
      selectSql = `
        INSERT INTO ${dest}
        SELECT
          generateUUIDv4()                                      AS invoice_id,
          tenant_id,
          user_id,
          connection_id,
          'xero'                                                AS provider,
          org_id,
          org_name,
          source_id                                             AS invoice_external_id,
          JSONExtractString(raw_data, 'invoiceNumber')          AS invoice_number,
          JSONExtractFloat(raw_data, 'total')                   AS total_amount,
          JSONExtractString(raw_data, 'currencyCode')           AS currency,
          parseDateTimeBestEffortOrNull(
            JSONExtractString(raw_data, 'date'))                AS issued_at,
          parseDateTimeBestEffortOrNull(
            JSONExtractString(raw_data, 'dueDate'))             AS due_at,
          JSONExtractString(raw_data, 'status')                 AS status,
          updated_at,
          synced_at
        FROM ${this.xeroDb}.xero_raw
        WHERE resource = 'Invoices'
          AND tenant_id = '${this.escape(tenantId)}'
          AND org_id    = '${this.escape(orgId)}'
      `;
    } else {
      selectSql = `
        INSERT INTO ${dest}
        SELECT
          generateUUIDv4()                                          AS invoice_id,
          tenant_id,
          user_id,
          connection_id,
          'quickbooks'                                              AS provider,
          org_id,
          org_name,
          source_id                                                 AS invoice_external_id,
          JSONExtractString(raw_data, 'DocNumber')                  AS invoice_number,
          JSONExtractFloat(raw_data, 'TotalAmt')                    AS total_amount,
          JSONExtractString(raw_data, 'CurrencyRef', 'value')       AS currency,
          parseDateTimeBestEffortOrNull(
            JSONExtractString(raw_data, 'TxnDate'))                 AS issued_at,
          parseDateTimeBestEffortOrNull(
            JSONExtractString(raw_data, 'DueDate'))                 AS due_at,
          JSONExtractString(raw_data, 'EmailStatus')                AS status,
          updated_at,
          synced_at
        FROM ${this.qbDb}.quickbooks_raw
        WHERE resource = 'Invoice'
          AND tenant_id = '${this.escape(tenantId)}'
          AND org_id    = '${this.escape(orgId)}'
      `;
    }

    await this.chAnalytics.command({ query: selectSql });
    this.logger.debug(`[Transform] fact_accounting_invoices INSERT...SELECT done for ${provider}`);
  }

  /**
   * Rebuild revenue_by_month aggregation for this tenant+org+provider slice.
   * Overwrites only the rows belonging to this org (idempotent via ReplacingMergeTree).
   */
  private async upsertRevenueByMonth(
    tenantId: string,
    orgId: string,
    provider: 'xero' | 'quickbooks',
  ): Promise<void> {
    const dest = `${this.analyticsDb}.revenue_by_month`;
    const src  = `${this.analyticsDb}.fact_accounting_invoices`;

    const sql = `
      INSERT INTO ${dest}
      SELECT
        toStartOfMonth(issued_at)       AS month,
        currency,
        sum(total_amount)               AS total_revenue,
        tenant_id,
        provider,
        org_id,
        org_name
      FROM ${src}
      WHERE tenant_id = '${this.escape(tenantId)}'
        AND org_id    = '${this.escape(orgId)}'
        AND provider  = '${provider}'
        AND issued_at IS NOT NULL
        AND status IN ('AUTHORISED', 'PAID', 'Paid', 'Closed', 'NotSet', 'NeedToSend')
      GROUP BY month, currency, tenant_id, provider, org_id, org_name
    `;

    await this.chAnalytics.command({ query: sql });
    this.logger.debug(`[Transform] revenue_by_month INSERT...SELECT done for ${provider}`);
  }

  /** Minimal SQL injection guard for tenant/org IDs (UUIDs only in practice). */
  private escape(value: string): string {
    return value.replace(/'/g, "\\'");
  }
}
