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

  private async wipeSnapshot(table: string, whereClause: string): Promise<void> {
    // ClickHouse mutations are async by default; for sync we wait for completion so inserts
    // don't interleave with old rows and cause visible duplicates.
    await this.chAnalytics.command({
      query: `ALTER TABLE ${table} DELETE WHERE ${whereClause} SETTINGS mutations_sync = 1`,
    });
  }

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
      await this.upsertFactPaymentApplications(tenantId, orgId, provider);
      await this.upsertDimAccounts(tenantId, orgId, provider);
      await this.refreshRevenueByMonth(tenantId, orgId, provider);
      await this.upsertDimClients(tenantId, orgId, provider);

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
    await this.wipeSnapshot(
      dest,
      `tenant_id = '${this.escape(tenantId)}' AND org_id = '${this.escape(orgId)}' AND provider = '${provider}'`,
    );

    // Explicit column list — position-safe regardless of table column order
    const COLS = `(
      invoice_id, tenant_id, user_id, connection_id, provider,
      org_id, org_name, invoice_external_id, invoice_number,
      total_amount, amount_due, amount_paid, amount_credited,
      currency, issued_at, due_at, paid_at, status, invoice_type,
      contact_id, contact_name, updated_at, synced_at
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
          JSONExtractFloat(raw_data, 'amountDue')                 AS amount_due,
          JSONExtractFloat(raw_data, 'amountPaid')                AS amount_paid,
          JSONExtractFloat(raw_data, 'amountCredited')            AS amount_credited,
          JSONExtractString(raw_data, 'currencyCode')             AS currency,
          parseDateTimeBestEffortOrNull(
            JSONExtractString(raw_data, 'date'))                  AS issued_at,
          parseDateTimeBestEffortOrNull(
            JSONExtractString(raw_data, 'dueDate'))               AS due_at,
          parseDateTimeBestEffortOrNull(
            JSONExtractString(raw_data, 'fullyPaidOnDate'))       AS paid_at,
          JSONExtractString(raw_data, 'status')                   AS status,
          JSONExtractString(raw_data, 'type')                     AS invoice_type,
	          coalesce(
	            nullIf(JSONExtractString(raw_data, 'contact', 'contactID'), ''),
	            nullIf(JSONExtractString(raw_data, 'contact', 'contactId'), ''),
	            nullIf(JSONExtractString(raw_data, 'Contact', 'ContactID'), ''),
	            nullIf(JSONExtractString(raw_data, 'Contact', 'contactID'), ''),
	            nullIf(JSONExtractString(raw_data, 'Contact', 'contactId'), '')
	          )                                                     AS contact_id,
	          coalesce(
	            nullIf(JSONExtractString(raw_data, 'contact', 'name'), ''),
	            nullIf(JSONExtractString(raw_data, 'contact', 'Name'), ''),
	            nullIf(JSONExtractString(raw_data, 'Contact', 'Name'), ''),
	            nullIf(JSONExtractString(raw_data, 'Contact', 'name'), '')
	          )                                                     AS contact_name,
          updated_at,
          synced_at
        FROM (
          SELECT
            source_id,
            any(tenant_id) AS tenant_id,
            any(user_id) AS user_id,
            any(connection_id) AS connection_id,
            any(org_id) AS org_id,
            any(org_name) AS org_name,
            argMax(raw_data, updated_at) AS raw_data,
            max(updated_at) AS updated_at,
            max(synced_at) AS synced_at
          FROM ${this.xeroDb}.xero_raw
          WHERE resource = 'Invoices'
            AND tenant_id = '${this.escape(tenantId)}'
            AND org_id    = '${this.escape(orgId)}'
          GROUP BY source_id
        )
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
          JSONExtractFloat(raw_data, 'Balance')                       AS amount_due,
          (JSONExtractFloat(raw_data, 'TotalAmt') -
            JSONExtractFloat(raw_data, 'Balance'))                    AS amount_paid,
          0                                                           AS amount_credited,
          JSONExtractString(raw_data, 'CurrencyRef', 'value')         AS currency,
          parseDateTimeBestEffortOrNull(
            JSONExtractString(raw_data, 'TxnDate'))                   AS issued_at,
          parseDateTimeBestEffortOrNull(
            JSONExtractString(raw_data, 'DueDate'))                   AS due_at,
          NULL                                                        AS paid_at,
          if(JSONExtractFloat(raw_data, 'Balance') <= 0, 'paid', 'authorised') AS status,
          ''                                                          AS invoice_type,
          JSONExtractString(raw_data, 'CustomerRef', 'value')  AS contact_id,
          JSONExtractString(raw_data, 'CustomerRef', 'name')   AS contact_name,
          updated_at,
          synced_at
        FROM (
          SELECT
            source_id,
            any(tenant_id) AS tenant_id,
            any(user_id) AS user_id,
            any(connection_id) AS connection_id,
            any(org_id) AS org_id,
            any(org_name) AS org_name,
            argMax(raw_data, updated_at) AS raw_data,
            max(updated_at) AS updated_at,
            max(synced_at) AS synced_at
          FROM ${this.qbDb}.quickbooks_raw
          WHERE resource = 'Invoice'
            AND tenant_id = '${this.escape(tenantId)}'
            AND org_id    = '${this.escape(orgId)}'
          GROUP BY source_id
        )
      `;
    }

    await this.chAnalytics.command({ query: sql });
    this.logger.debug(
      `[Transform] fact_accounting_invoices upserted for ${provider}`,
    );
  }

  /**
   * Upsert payment applications (invoice-level allocations) for collections + as-of balances.
   *
   * For Xero Payments, raw_data contains:
   *   invoice.invoiceID, paymentID, date, amount, currencyRate, etc (camelCase keys via xero-node).
   *
   * For QuickBooks, payments require allocation expansion (not implemented yet).
   */
  private async upsertFactPaymentApplications(
    tenantId: string,
    orgId: string,
    provider: 'xero' | 'quickbooks',
  ): Promise<void> {
    if (provider !== 'xero') return;

    const dest = `${this.analyticsDb}.fact_accounting_payment_applications`;
    await this.wipeSnapshot(
      dest,
      `tenant_id = '${this.escape(tenantId)}' AND org_id = '${this.escape(orgId)}' AND provider = 'xero'`,
    );

    const COLS = `(
      payment_id, tenant_id, user_id, connection_id, provider,
      org_id, org_name, invoice_external_id, payment_at, amount, currency,
      updated_at, synced_at
    )`;

    const sql = `
      INSERT INTO ${dest} ${COLS}
      SELECT
        source_id                                             AS payment_id,
        tenant_id,
        user_id,
        connection_id,
        'xero'                                                AS provider,
        org_id,
        org_name,
        JSONExtractString(raw_data, 'invoice', 'invoiceID')    AS invoice_external_id,
        parseDateTimeBestEffortOrNull(
          JSONExtractString(raw_data, 'date'))                 AS payment_at,
        JSONExtractFloat(raw_data, 'amount')                   AS amount,
        ''                                                     AS currency,
        updated_at,
        synced_at
      FROM (
        SELECT
          source_id,
          any(tenant_id) AS tenant_id,
          any(user_id) AS user_id,
          any(connection_id) AS connection_id,
          any(org_id) AS org_id,
          any(org_name) AS org_name,
          argMax(raw_data, updated_at) AS raw_data,
          max(updated_at) AS updated_at,
          max(synced_at) AS synced_at
        FROM ${this.xeroDb}.xero_raw
        WHERE resource = 'Payments'
          AND tenant_id = '${this.escape(tenantId)}'
          AND org_id    = '${this.escape(orgId)}'
          AND JSONExtractString(raw_data, 'invoice', 'invoiceID') != ''
        GROUP BY source_id
      )
    `;

    await this.chAnalytics.command({ query: sql });
    this.logger.debug(
      `[Transform] fact_accounting_payment_applications upserted for ${provider}`,
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
    await this.wipeSnapshot(
      dest,
      `tenant_id = '${this.escape(tenantId)}' AND org_id = '${this.escape(orgId)}' AND provider = '${provider}'`,
    );

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
        FROM (
          SELECT
            source_id,
            any(tenant_id) AS tenant_id,
            any(org_id) AS org_id,
            any(org_name) AS org_name,
            argMax(raw_data, updated_at) AS raw_data
          FROM ${this.xeroDb}.xero_raw
          WHERE resource = 'Accounts'
            AND tenant_id = '${this.escape(tenantId)}'
            AND org_id    = '${this.escape(orgId)}'
          GROUP BY source_id
        )
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
        FROM (
          SELECT
            source_id,
            any(tenant_id) AS tenant_id,
            any(org_id) AS org_id,
            any(org_name) AS org_name,
            argMax(raw_data, updated_at) AS raw_data
          FROM ${this.qbDb}.quickbooks_raw
          WHERE resource = 'Account'
            AND tenant_id = '${this.escape(tenantId)}'
            AND org_id    = '${this.escape(orgId)}'
          GROUP BY source_id
        )
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
    await this.wipeSnapshot(
      dest,
      `tenant_id = '${this.escape(tenantId)}' AND org_id = '${this.escape(orgId)}' AND provider = '${provider}'`,
    );
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

  /**
   * Materialise dim_clients from fact_accounting_invoices.
   *
   * One row per (tenant_id, org_id, provider, contact_id).
   * ReplacingMergeTree(_version) ensures each sync fully overwrites the
   * previous snapshot — no stale rows accumulate.
   *
   * Status classification (matches both Xero and QuickBooks statuses):
   *   PAID / closed   → counts as revenue (cash collected)
   *   AUTHORISED / SENT / NEEDTOSEND + not past due_at → outstanding (healthy AR)
   *   AUTHORISED / SENT / NEEDTOSEND + past due_at     → overdue (collection risk)
   *   DRAFT           → pipeline (not yet committed)
   */
  private async upsertDimClients(
    tenantId: string,
    orgId: string,
    provider: string,
  ): Promise<void> {
    const dest = `${this.analyticsDb}.dim_clients`;
    const src  = `${this.analyticsDb}.fact_accounting_invoices`;
    await this.wipeSnapshot(
      dest,
      `tenant_id = '${this.escape(tenantId)}' AND org_id = '${this.escape(orgId)}' AND provider = '${provider}'`,
    );

    const syncedAt = new Date()
      .toISOString()
      .replace('T', ' ')
      .substring(0, 19);

    const query = `
      INSERT INTO ${dest} (
        client_id, client_name, provider, tenant_id, org_id, org_name, currency,
        total_invoiced, total_revenue, total_outstanding, total_overdue,
        invoice_count, paid_count, outstanding_count, overdue_count, draft_count,
        avg_invoice_amount, first_invoice_date, last_invoice_date, updated_at
      )
      SELECT
        contact_id                                                                   AS client_id,
        any(contact_name)                                                            AS client_name,
        provider,
        tenant_id,
        org_id,
        any(org_name)                                                                AS org_name,
        any(currency)                                                                AS currency,

        /* ── Lifetime billing ────────────────────────────────────────────── */
        coalesce(sum(total_amount), 0)                                               AS total_invoiced,

        /* Revenue = cash already collected */
        coalesce(sumIf(total_amount,
          lowerUTF8(status) IN ('paid', 'voided', 'closed', 'active', 'open')), 0)  AS total_revenue,

        /* Outstanding = authorised/sent but not yet past the due date */
        coalesce(sumIf(total_amount,
          lowerUTF8(status) IN ('authorised', 'sent', 'needtosend', 'notset')
          AND (due_at IS NULL OR due_at >= now())), 0)                               AS total_outstanding,

        /* Overdue = authorised/sent AND past the due date */
        coalesce(sumIf(total_amount,
          lowerUTF8(status) IN ('authorised', 'sent', 'needtosend', 'notset')
          AND due_at IS NOT NULL AND due_at < now()), 0)                             AS total_overdue,

        /* ── Volume counts ───────────────────────────────────────────────── */
        count(*)                                                                     AS invoice_count,
        countIf(lowerUTF8(status) IN ('paid', 'voided', 'closed', 'active', 'open')) AS paid_count,
        countIf(lowerUTF8(status) IN ('authorised', 'sent', 'needtosend', 'notset')
          AND (due_at IS NULL OR due_at >= now()))                                   AS outstanding_count,
        countIf(lowerUTF8(status) IN ('authorised', 'sent', 'needtosend', 'notset')
          AND due_at IS NOT NULL AND due_at < now())                                 AS overdue_count,
        countIf(lowerUTF8(status) = 'draft')                                        AS draft_count,

        /* ── Averages ────────────────────────────────────────────────────── */
        coalesce(avg(total_amount), 0)                                               AS avg_invoice_amount,

        /* ── Activity window ─────────────────────────────────────────────── */
        min(toDate(issued_at))                                                       AS first_invoice_date,
        max(toDate(issued_at))                                                       AS last_invoice_date,

        '${syncedAt}'                                                                AS updated_at

      FROM ${src}
      WHERE tenant_id = '${this.escape(tenantId)}'
        AND org_id    = '${this.escape(orgId)}'
        AND contact_id != ''
      GROUP BY contact_id, provider, tenant_id, org_id
    `;

    await this.chAnalytics.command({ query });
    this.logger.debug(
      `[Transform] dim_clients materialised for ${provider}/${orgId.slice(0, 8)}`,
    );
  }

  /** Minimal SQL injection guard for tenant/org IDs (UUIDs only in practice). */
  private escape(value: string): string {
    return value.replace(/'/g, "\\'");
  }
}
