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
 * KEY ARCHITECTURE INVARIANT — JSON Key Casing:
 * ─────────────────────────────────────────────
 * xero-node SDK deserializes Xero API responses (PascalCase) into TypeScript
 * model objects with camelCase property names (confirmed from SDK attributeTypeMap).
 * When JSON.stringify(record) is called in XeroIngestionService, the output JSON
 * uses camelCase keys: "total", "status", "invoiceNumber", "currencyCode", "date", etc.
 *
 * All JSONExtract calls MUST use camelCase keys to match. Using PascalCase returns 0/''.
 *
 * EXCEPTION: Account.Class maps to "_class" (underscore prefix) in xero-node
 * because 'class' is a reserved keyword in JavaScript.
 */
@Injectable()
export class InlineTransformService {
  private readonly logger = new Logger(InlineTransformService.name);

  private readonly analyticsDb =
    process.env.CLICKHOUSE_ANALYTICS_DB || 'analytics';
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
    this.logger.log(
      `[Transform] ▶ Starting Gold Layer transform for [${provider.toUpperCase()}] org:${orgId}`,
    );

    try {
      await this.upsertFactInvoices(tenantId, orgId, provider);
      await this.upsertDimAccounts(tenantId, orgId, provider);
      await this.refreshRevenueByMonth(tenantId, orgId, provider);

      const elapsed = Date.now() - start;
      this.logger.log(
        `[Transform] ✅ [${provider.toUpperCase()}] Gold Layer ready in ${elapsed}ms | ` +
          `org: ${orgId} | tenant: ${tenantId}`,
      );
    } catch (e: any) {
      this.logger.error(
        `[Transform] ✗ [${provider.toUpperCase()}] FAILED for org:${orgId} — ${e.message}`,
        e.stack,
      );
      // Non-fatal: raw layer is intact. Next sync will re-trigger.
    }
  }

  /**
   * Upsert fact_accounting_invoices from the raw layer.
   *
   * JSON KEY CASING (from xero-node SDK attributeTypeMap):
   *   invoiceNumber  (baseName: InvoiceNumber)
   *   total          (baseName: Total)
   *   currencyCode   (baseName: CurrencyCode)
   *   date           (baseName: Date)  → JS Date → ISO string via JSON.stringify
   *   dueDate        (baseName: DueDate) → JS Date → ISO string
   *   status         (baseName: Status)
   *   type           (baseName: Type)
   */
  private async upsertFactInvoices(
    tenantId: string,
    orgId: string,
    provider: 'xero' | 'quickbooks',
  ): Promise<void> {
    const dest = `${this.analyticsDb}.fact_accounting_invoices`;

    // Explicit column list — position-safe regardless of table column order
    const COLS = `(
      invoice_id, tenant_id, user_id, connection_id, provider,
      org_id, org_name, invoice_external_id, invoice_number,
      total_amount, currency, issued_at, due_at, status, updated_at, synced_at
    )`;

    let sql: string;

    if (provider === 'xero') {
      sql = `
        INSERT INTO ${dest} ${COLS}
        SELECT
          source_id                                               AS invoice_id,
          tenant_id,
          user_id,
          connection_id,
          'xero'                                                  AS provider,
          org_id,
          org_name,
          source_id                                               AS invoice_external_id,
          JSONExtractString(raw_data, 'invoiceNumber')            AS invoice_number,
          JSONExtractFloat(raw_data, 'total')                     AS total_amount,
          JSONExtractString(raw_data, 'currencyCode')             AS currency,
          parseDateTimeBestEffortOrNull(
            JSONExtractString(raw_data, 'date'))                  AS issued_at,
          parseDateTimeBestEffortOrNull(
            JSONExtractString(raw_data, 'dueDate'))               AS due_at,
          JSONExtractString(raw_data, 'status')                   AS status,
          updated_at,
          synced_at
        FROM ${this.xeroDb}.xero_raw
        WHERE resource = 'Invoices'
          AND tenant_id = '${this.escape(tenantId)}'
          AND org_id    = '${this.escape(orgId)}'
      `;
    } else {
      // QuickBooks: QBO REST API JSON is PascalCase — no SDK re-serialization
      sql = `
        INSERT INTO ${dest} ${COLS}
        SELECT
          source_id                                                   AS invoice_id,
          tenant_id,
          user_id,
          connection_id,
          'quickbooks'                                                AS provider,
          org_id,
          org_name,
          source_id                                                   AS invoice_external_id,
          JSONExtractString(raw_data, 'DocNumber')                    AS invoice_number,
          JSONExtractFloat(raw_data, 'TotalAmt')                      AS total_amount,
          JSONExtractString(raw_data, 'CurrencyRef', 'value')         AS currency,
          parseDateTimeBestEffortOrNull(
            JSONExtractString(raw_data, 'TxnDate'))                   AS issued_at,
          parseDateTimeBestEffortOrNull(
            JSONExtractString(raw_data, 'DueDate'))                   AS due_at,
          JSONExtractString(raw_data, 'EmailStatus')                  AS status,
          updated_at,
          synced_at
        FROM ${this.qbDb}.quickbooks_raw
        WHERE resource = 'Invoice'
          AND tenant_id = '${this.escape(tenantId)}'
          AND org_id    = '${this.escape(orgId)}'
      `;
    }

    await this.chAnalytics.command({ query: sql });
    this.logger.debug(
      `[Transform] fact_accounting_invoices upserted for ${provider}`,
    );
  }

  /**
   * Upsert dim_accounting_accounts.
   */
  private async upsertDimAccounts(
    tenantId: string,
    orgId: string,
    provider: 'xero' | 'quickbooks',
  ): Promise<void> {
    const dest = `${this.analyticsDb}.dim_accounting_accounts`;

    const COLS = `(
      account_id, account_name, account_type, classification,
      provider, tenant_id, org_id, org_name, is_active
    )`;

    let sql: string;
    if (provider === 'xero') {
      sql = `
        INSERT INTO ${dest} ${COLS}
        SELECT
          source_id                                               AS account_id,
          JSONExtractString(raw_data, 'name')                     AS account_name,
          JSONExtractString(raw_data, 'type')                     AS account_type,
          JSONExtractString(raw_data, '_class')                   AS classification,
          'xero'                                                  AS provider,
          tenant_id,
          org_id,
          org_name,
          toBool(1)                                               AS is_active
        FROM ${this.xeroDb}.xero_raw
        WHERE resource = 'Accounts'
          AND tenant_id = '${this.escape(tenantId)}'
          AND org_id    = '${this.escape(orgId)}'
      `;
    } else {
      sql = `
        INSERT INTO ${dest} ${COLS}
        SELECT
          source_id                                               AS account_id,
          JSONExtractString(raw_data, 'Name')                     AS account_name,
          JSONExtractString(raw_data, 'AccountType')              AS account_type,
          JSONExtractString(raw_data, 'Classification')           AS classification,
          'quickbooks'                                            AS provider,
          tenant_id,
          org_id,
          org_name,
          toBool(1)                                               AS is_active
        FROM ${this.qbDb}.quickbooks_raw
        WHERE resource = 'Account'
          AND tenant_id = '${this.escape(tenantId)}'
          AND org_id    = '${this.escape(orgId)}'
      `;
    }

    await this.chAnalytics.command({ query: sql });
    this.logger.debug(
      `[Transform] dim_accounting_accounts upserted for ${provider}`,
    );
  }

  /**
   * Materialize revenue_by_month.
   * Leverages case-insensitive status matching for robustness.
   */
  private async refreshRevenueByMonth(
    tenantId: string,
    orgId: string,
    provider: string,
  ): Promise<void> {
    const dest = `${this.analyticsDb}.revenue_by_month`;
    const src = `${this.analyticsDb}.fact_accounting_invoices`;
    const syncedAt = new Date()
      .toISOString()
      .replace('T', ' ')
      .substring(0, 19);

    // IMPORTANT: Aliases in SELECT must NOT collide with source column names
    // used in WHERE. ClickHouse resolves names before GROUP BY, so
    // `sum(total_amount) as total_amount` + `WHERE total_amount > 0` → ILLEGAL_AGGREGATION.
    const query = `
      INSERT INTO ${dest} (month, total_amount, invoice_count, currency, provider, tenant_id, org_id, org_name, updated_at)
      SELECT
        toStartOfMonth(issued_at)   AS month,
        sum(src.total_amount)       AS agg_total,
        count(*)                    AS agg_count,
        any(currency)               AS agg_currency,
        provider,
        tenant_id,
        org_id,
        org_name,
        '${syncedAt}'               AS updated_at
      FROM ${src} AS src
      WHERE src.tenant_id = '${this.escape(tenantId)}'
        AND src.org_id    = '${this.escape(orgId)}'
        AND src.provider  = '${provider}'
        AND src.issued_at IS NOT NULL
        AND src.total_amount > 0
        AND lower(src.status) IN ('authorised', 'paid', 'closed', 'notset', 'needtosend', 'active', 'open')
      GROUP BY month, provider, tenant_id, org_id, org_name
    `;

    await this.chAnalytics.command({ query });
    this.logger.debug(
      `[Transform] revenue_by_month refreshed for ${provider}/${orgId.slice(0, 8)}`,
    );
  }

  /** Minimal SQL injection guard for tenant/org IDs (UUIDs only in practice). */
  private escape(value: string): string {
    return value.replace(/'/g, "\\'");
  }
}
