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
    // Also remove historical rows where tenant_id was missing (older schema bugs / backfills).
    // This prevents "old invoices re-appearing" across syncs when earlier snapshots were written
    // with tenant_id='' and therefore never matched the normal wipe predicate.
    const widened = (() => {
      const m = whereClause.match(/\btenant_id\s*=\s*'([^']*)'\b/i);
      if (!m) return whereClause;
      const tenantId = m[1] ?? '';
      if (!tenantId) return whereClause;
      // Replace `tenant_id = 'X'` with `(tenant_id = 'X' OR tenant_id = '')`
      return whereClause.replace(
        /\btenant_id\s*=\s*'[^']*'\b/i,
        `(tenant_id = '${tenantId}' OR tenant_id = '')`,
      );
    })();

    await this.chAnalytics.command({
      query: `ALTER TABLE ${table} DELETE WHERE ${widened} SETTINGS mutations_sync = 1`,
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

    const steps = [
      { name: 'upsertFactInvoices',             fn: () => this.upsertFactInvoices(tenantId, orgId, provider) },
      { name: 'upsertFactPaymentApplications',  fn: () => this.upsertFactPaymentApplications(tenantId, orgId, provider) },
      { name: 'upsertFactJournalLines',          fn: () => this.upsertFactJournalLines(tenantId, orgId, provider) },
      { name: 'upsertDimAccounts',               fn: () => this.upsertDimAccounts(tenantId, orgId, provider) },
      { name: 'refreshRevenueByMonth',           fn: () => this.refreshRevenueByMonth(tenantId, orgId, provider) },
      { name: 'upsertDimClients',                fn: () => this.upsertDimClients(tenantId, orgId, provider) },
    ];

    let failed = false;
    for (const step of steps) {
      try {
        await step.fn();
        this.logger.debug(`[Transform] ✓ ${step.name} OK`);
      } catch (e: any) {
        this.logger.error(
          `[Transform] ✗ [${provider.toUpperCase()}] step ${step.name} FAILED for org:${orgId} — ${e.message}`,
          e.stack,
        );
        failed = true;
        // Continue remaining steps so a single bad step doesn't block e.g. journal lines
      }
    }

    const elapsed = Date.now() - start;
    if (!failed) {
      this.logger.log(
        `[Transform] ✅ [${provider.toUpperCase()}] Gold Layer ready in ${elapsed}ms | ` +
          `org: ${orgId} | tenant: ${tenantId}`,
      );
    } else {
      this.logger.warn(
        `[Transform] ⚠ [${provider.toUpperCase()}] Completed with errors in ${elapsed}ms | ` +
          `org: ${orgId} | tenant: ${tenantId}`,
      );
    }
  }

  /**
   * Upsert fact_accounting_journal_lines for Xero and QuickBooks.
   *
   * Xero strategy: prefer raw GL Journals (accounting.journals.read scope),
   * with TrackingCategories mapped to department / class_name.
   * Fallback: derive synthetic P&L lines from ACCREC/ACCPAY invoices.
   *
   * QuickBooks strategy: extract Bill line items (vendor expenses with
   * department/class context) and JournalEntry lines (manual double-entry).
   *
   * All lines carry department, class_name, vendor_name, vendor_id,
   * debit_amount, and credit_amount for full dimensional analytics.
   */
  private async upsertFactJournalLines(
    tenantId: string,
    orgId: string,
    provider: 'xero' | 'quickbooks',
  ): Promise<void> {
    const dest = `${this.analyticsDb}.fact_accounting_journal_lines`;

    const COLS = `(
      journal_id, journal_number, journal_date,
      source_type, source_id, line_id,
      account_id, account_code, account_name,
      line_amount, description,
      department, class_name, vendor_name, vendor_id,
      debit_amount, credit_amount,
      tenant_id, user_id, connection_id, provider,
      org_id, org_name, updated_at, synced_at
    )`;

    if (provider === 'xero') {
      // Wipe only non-ProfitAndLossReport rows (those are managed by the ingestion service)
      await this.wipeSnapshot(
        dest,
        `tenant_id = '${this.escape(tenantId)}' AND org_id = '${this.escape(orgId)}' AND provider = 'xero' AND source_type != 'ProfitAndLossReport'`,
      );

      // ── Try raw GL Journals first (requires accounting.journals.read) ─────
      let rawJournalCount = 0;
      try {
        const result = await this.chXero.query({
          query: `SELECT count() AS cnt FROM ${this.xeroDb}.xero_raw
                  WHERE tenant_id = '${this.escape(tenantId)}'
                    AND org_id    = '${this.escape(orgId)}'
                    AND resource IN ('Journals','ManualJournals')`,
          format: 'JSONEachRow',
        });
        const rows = await result.json() as { cnt: string }[];
        rawJournalCount = Number(rows[0]?.cnt ?? 0);
      } catch {
        rawJournalCount = 0;
      }

      if (rawJournalCount > 0) {
        await this.chAnalytics.command({ query: `
          INSERT INTO ${dest} ${COLS}
          SELECT
            coalesce(
              nullIf(JSONExtractString(raw_data, 'JournalID'), ''),
              nullIf(JSONExtractString(raw_data, 'journalID'), ''),
              nullIf(JSONExtractString(raw_data, 'ManualJournalID'), ''),
              nullIf(JSONExtractString(raw_data, 'manualJournalID'), ''),
              source_id
            ) AS journal_id,
            toUInt64OrZero(coalesce(
              nullIf(JSONExtractString(raw_data, 'JournalNumber'), ''),
              toString(JSONExtractInt(raw_data, 'JournalNumber'))
            )) AS journal_number,
            parseDateTimeBestEffortOrNull(coalesce(
              nullIf(JSONExtractString(raw_data, 'JournalDate'), ''),
              nullIf(JSONExtractString(raw_data, 'journalDate'), ''),
              nullIf(JSONExtractString(raw_data, 'Date'), '')
            )) AS journal_date,
            resource AS source_type, source_id,
            toString(cityHash64(line_raw)) AS line_id,
            coalesce(nullIf(JSONExtractString(line_raw,'AccountID'),''), nullIf(JSONExtractString(line_raw,'accountID'),'')) AS account_id,
            coalesce(nullIf(JSONExtractString(line_raw,'AccountCode'),''), nullIf(JSONExtractString(line_raw,'accountCode'),'')) AS account_code,
            coalesce(nullIf(JSONExtractString(line_raw,'AccountName'),''), nullIf(JSONExtractString(line_raw,'accountName'),'')) AS account_name,
            toDecimal64OrZero(coalesce(
              nullIf(JSONExtractString(line_raw,'LineAmount'),''),
              toString(JSONExtractFloat(line_raw,'LineAmount'))
            ), 4) AS line_amount,
            coalesce(nullIf(JSONExtractString(line_raw,'Description'),''), nullIf(JSONExtractString(raw_data,'Narration'),'')) AS description,
            coalesce(
              nullIf(JSONExtractString(arrayElement(JSONExtractArrayRaw(line_raw,'TrackingCategories'),1),'Option'),''),
              nullIf(JSONExtractString(arrayElement(JSONExtractArrayRaw(line_raw,'trackingCategories'),1),'option'),''),
              nullIf(JSONExtractString(arrayElement(JSONExtractArrayRaw(line_raw,'trackingCategories'),1),'Option'),''),
              ''
            ) AS department,
            coalesce(
              nullIf(JSONExtractString(arrayElement(JSONExtractArrayRaw(line_raw,'TrackingCategories'),2),'Option'),''),
              nullIf(JSONExtractString(arrayElement(JSONExtractArrayRaw(line_raw,'trackingCategories'),2),'option'),''),
              nullIf(JSONExtractString(arrayElement(JSONExtractArrayRaw(line_raw,'trackingCategories'),2),'Option'),''),
              ''
            ) AS class_name,
            '' AS vendor_name,
            '' AS vendor_id,
            if(line_amount > 0, line_amount, toDecimal64(0,4)) AS debit_amount,
            if(line_amount < 0, -line_amount, toDecimal64(0,4)) AS credit_amount,
            tenant_id, user_id, connection_id, 'xero' AS provider, org_id, org_name, updated_at, synced_at
          FROM (
            SELECT source_id, any(tenant_id) AS tenant_id, any(user_id) AS user_id,
              any(connection_id) AS connection_id, any(org_id) AS org_id, any(org_name) AS org_name,
              resource, argMax(raw_data, r.updated_at) AS raw_data,
              max(r.updated_at) AS updated_at, max(r.synced_at) AS synced_at
            FROM ${this.xeroDb}.xero_raw AS r
            WHERE tenant_id = '${this.escape(tenantId)}' AND org_id = '${this.escape(orgId)}'
              AND resource IN ('Journals','ManualJournals')
            GROUP BY source_id, resource
          )
          ARRAY JOIN if(
            length(JSONExtractArrayRaw(raw_data,'JournalLines')) > 0,
            JSONExtractArrayRaw(raw_data,'JournalLines'),
            JSONExtractArrayRaw(raw_data,'journalLines')
          ) AS line_raw
        `});
        this.logger.debug(`[Transform] Xero fact_accounting_journal_lines upserted from GL Journals`);
        return;
      }

      // ── Fallback: derive P&L from ACCREC / ACCPAY invoices ────────────────
      this.logger.debug(`[Transform] No Xero GL Journals — deriving P&L from invoices`);

      const baseWhere = `
        tenant_id = '${this.escape(tenantId)}'
        AND org_id = '${this.escape(orgId)}'
        AND provider = 'xero'
        AND lowerUTF8(status) NOT IN ('voided','deleted','draft')
        AND total_amount > 0
      `;

      await this.chAnalytics.command({ query: `
        INSERT INTO ${dest} ${COLS}
        SELECT
          invoice_id, 0, issued_at,
          'InvoiceRevenue', invoice_id, concat(invoice_id, '_rev'),
          '', 'REVENUE', 'Sales Revenue',
          -total_amount,
          concat('Revenue — ', coalesce(nullIf(contact_name,''), 'Client')),
          '', '', '', '',
          toDecimal64(0,4), toDecimal64(total_amount,4),
          tenant_id, user_id, connection_id, provider, org_id, org_name,
          updated_at, updated_at
        FROM ${this.analyticsDb}.fact_accounting_invoices
        WHERE ${baseWhere} AND invoice_type = 'ACCREC'
      `});

      await this.chAnalytics.command({ query: `
        INSERT INTO ${dest} ${COLS}
        SELECT
          invoice_id, 0, issued_at,
          'InvoiceExpense', invoice_id, concat(invoice_id, '_exp'),
          '', 'EXPENSE', coalesce(nullIf(contact_name,''), 'Operating Expenses'),
          total_amount,
          concat('Expense — ', coalesce(nullIf(contact_name,''), 'Supplier')),
          '', '',
          coalesce(nullIf(contact_name,''), ''), '',
          toDecimal64(total_amount,4), toDecimal64(0,4),
          tenant_id, user_id, connection_id, provider, org_id, org_name,
          updated_at, updated_at
        FROM ${this.analyticsDb}.fact_accounting_invoices
        WHERE ${baseWhere} AND invoice_type = 'ACCPAY'
      `});

      this.logger.debug(`[Transform] Xero journal lines derived from ACCREC/ACCPAY invoices`);
      return;
    }

    // ── QuickBooks ────────────────────────────────────────────────────────────
    await this.wipeSnapshot(
      dest,
      `tenant_id = '${this.escape(tenantId)}' AND org_id = '${this.escape(orgId)}' AND provider = 'quickbooks'`,
    );

    // ── QB Bills → expense journal lines with vendor + department + class ────
    try {
      await this.chAnalytics.command({ query: `
        INSERT INTO ${dest} ${COLS}
        SELECT
          source_id                                                                        AS journal_id,
          0                                                                                AS journal_number,
          parseDateTimeBestEffortOrNull(JSONExtractString(raw_data, 'TxnDate'))            AS journal_date,
          'Bill'                                                                           AS source_type,
          source_id                                                                        AS source_id,
          toString(cityHash64(concat(source_id, line_raw)))                               AS line_id,
          JSONExtractString(line_raw, 'AccountBasedExpenseLineDetail', 'AccountRef', 'value') AS account_id,
          JSONExtractString(line_raw, 'AccountBasedExpenseLineDetail', 'AccountRef', 'value') AS account_code,
          JSONExtractString(line_raw, 'AccountBasedExpenseLineDetail', 'AccountRef', 'name')  AS account_name,
          toDecimal64(JSONExtractFloat(line_raw, 'Amount'), 4)                            AS line_amount,
          concat('Bill — ', JSONExtractString(raw_data, 'VendorRef', 'name'))             AS description,
          coalesce(
            nullIf(JSONExtractString(raw_data, 'DepartmentRef', 'name'), ''),
            nullIf(JSONExtractString(line_raw, 'AccountBasedExpenseLineDetail', 'DepartmentRef', 'name'), ''),
            ''
          )                                                                                AS department,
          coalesce(
            nullIf(JSONExtractString(line_raw, 'AccountBasedExpenseLineDetail', 'ClassRef', 'name'), ''),
            ''
          )                                                                                AS class_name,
          JSONExtractString(raw_data, 'VendorRef', 'name')                                AS vendor_name,
          JSONExtractString(raw_data, 'VendorRef', 'value')                               AS vendor_id,
          toDecimal64(JSONExtractFloat(line_raw, 'Amount'), 4)                            AS debit_amount,
          toDecimal64(0, 4)                                                                AS credit_amount,
          tenant_id, user_id, connection_id, 'quickbooks' AS provider, org_id, org_name, updated_at, synced_at
        FROM (
          SELECT
            source_id,
            any(tenant_id) AS tenant_id,
            any(user_id) AS user_id,
            any(connection_id) AS connection_id,
            any(org_id) AS org_id,
            any(org_name) AS org_name,
            argMax(raw_data, r.updated_at) AS raw_data,
            max(r.updated_at) AS updated_at,
            max(r.synced_at) AS synced_at
          FROM ${this.qbDb}.quickbooks_raw AS r
          WHERE resource = 'Bill'
            AND tenant_id = '${this.escape(tenantId)}'
            AND org_id    = '${this.escape(orgId)}'
          GROUP BY source_id
        )
        ARRAY JOIN JSONExtractArrayRaw(raw_data, 'Line') AS line_raw
        WHERE JSONExtractString(line_raw, 'DetailType') = 'AccountBasedExpenseLineDetail'
          AND JSONExtractFloat(line_raw, 'Amount') > 0
      `});
      this.logger.debug(`[Transform] QB Bills → fact_accounting_journal_lines OK`);
    } catch (e: any) {
      this.logger.warn(`[Transform] QB Bills extraction failed: ${e?.message}`);
    }

    // ── QB JournalEntry → double-entry journal lines ──────────────────────────
    try {
      await this.chAnalytics.command({ query: `
        INSERT INTO ${dest} ${COLS}
        SELECT
          source_id                                                                                AS journal_id,
          toUInt64OrZero(JSONExtractString(raw_data, 'DocNumber'))                                 AS journal_number,
          parseDateTimeBestEffortOrNull(JSONExtractString(raw_data, 'TxnDate'))                    AS journal_date,
          'JournalEntry'                                                                           AS source_type,
          source_id                                                                                AS source_id,
          toString(cityHash64(concat(source_id, line_raw)))                                       AS line_id,
          JSONExtractString(line_raw, 'JournalEntryLineDetail', 'AccountRef', 'value')             AS account_id,
          JSONExtractString(line_raw, 'JournalEntryLineDetail', 'AccountRef', 'value')             AS account_code,
          JSONExtractString(line_raw, 'JournalEntryLineDetail', 'AccountRef', 'name')              AS account_name,
          if(
            JSONExtractString(line_raw, 'JournalEntryLineDetail', 'PostingType') = 'Debit',
            toDecimal64(JSONExtractFloat(line_raw, 'Amount'), 4),
            -toDecimal64(JSONExtractFloat(line_raw, 'Amount'), 4)
          )                                                                                        AS line_amount,
          coalesce(nullIf(JSONExtractString(raw_data, 'PrivateNote'), ''),
                   nullIf(JSONExtractString(raw_data, 'Memo'), ''), '')                           AS description,
          coalesce(
            nullIf(JSONExtractString(line_raw, 'JournalEntryLineDetail', 'DepartmentRef', 'name'), ''),
            nullIf(JSONExtractString(raw_data, 'DepartmentRef', 'name'), ''),
            ''
          )                                                                                        AS department,
          coalesce(
            nullIf(JSONExtractString(line_raw, 'JournalEntryLineDetail', 'ClassRef', 'name'), ''),
            ''
          )                                                                                        AS class_name,
          coalesce(
            nullIf(JSONExtractString(line_raw, 'JournalEntryLineDetail', 'Entity', 'Name'), ''),
            ''
          )                                                                                        AS vendor_name,
          ''                                                                                       AS vendor_id,
          if(
            JSONExtractString(line_raw, 'JournalEntryLineDetail', 'PostingType') = 'Debit',
            toDecimal64(JSONExtractFloat(line_raw, 'Amount'), 4),
            toDecimal64(0, 4)
          )                                                                                        AS debit_amount,
          if(
            JSONExtractString(line_raw, 'JournalEntryLineDetail', 'PostingType') = 'Credit',
            toDecimal64(JSONExtractFloat(line_raw, 'Amount'), 4),
            toDecimal64(0, 4)
          )                                                                                        AS credit_amount,
          tenant_id, user_id, connection_id, 'quickbooks' AS provider, org_id, org_name, updated_at, synced_at
        FROM (
          SELECT
            source_id,
            any(tenant_id) AS tenant_id,
            any(user_id) AS user_id,
            any(connection_id) AS connection_id,
            any(org_id) AS org_id,
            any(org_name) AS org_name,
            argMax(raw_data, r.updated_at) AS raw_data,
            max(r.updated_at) AS updated_at,
            max(r.synced_at) AS synced_at
          FROM ${this.qbDb}.quickbooks_raw AS r
          WHERE resource = 'JournalEntry'
            AND tenant_id = '${this.escape(tenantId)}'
            AND org_id    = '${this.escape(orgId)}'
          GROUP BY source_id
        )
        ARRAY JOIN JSONExtractArrayRaw(raw_data, 'Line') AS line_raw
        WHERE JSONExtractString(line_raw, 'DetailType') = 'JournalEntryLineDetail'
          AND JSONExtractFloat(line_raw, 'Amount') > 0
      `});
      this.logger.debug(`[Transform] QB JournalEntries → fact_accounting_journal_lines OK`);
    } catch (e: any) {
      this.logger.warn(`[Transform] QB JournalEntry extraction failed: ${e?.message}`);
    }

    // ── QB Purchases → additional expense lines (credit card / cash expenses) ─
    try {
      await this.chAnalytics.command({ query: `
        INSERT INTO ${dest} ${COLS}
        SELECT
          source_id                                                                           AS journal_id,
          0                                                                                   AS journal_number,
          parseDateTimeBestEffortOrNull(JSONExtractString(raw_data, 'TxnDate'))               AS journal_date,
          'Purchase'                                                                          AS source_type,
          source_id                                                                           AS source_id,
          toString(cityHash64(concat(source_id, line_raw)))                                  AS line_id,
          JSONExtractString(line_raw, 'AccountBasedExpenseLineDetail', 'AccountRef', 'value') AS account_id,
          JSONExtractString(line_raw, 'AccountBasedExpenseLineDetail', 'AccountRef', 'value') AS account_code,
          JSONExtractString(line_raw, 'AccountBasedExpenseLineDetail', 'AccountRef', 'name')  AS account_name,
          toDecimal64(JSONExtractFloat(line_raw, 'Amount'), 4)                               AS line_amount,
          coalesce(nullIf(JSONExtractString(raw_data, 'PrivateNote'), ''),
                   nullIf(JSONExtractString(raw_data, 'PaymentType'), ''), '')               AS description,
          coalesce(
            nullIf(JSONExtractString(raw_data, 'DepartmentRef', 'name'), ''),
            nullIf(JSONExtractString(line_raw, 'AccountBasedExpenseLineDetail', 'DepartmentRef', 'name'), ''),
            ''
          )                                                                                   AS department,
          coalesce(
            nullIf(JSONExtractString(line_raw, 'AccountBasedExpenseLineDetail', 'ClassRef', 'name'), ''),
            ''
          )                                                                                   AS class_name,
          coalesce(nullIf(JSONExtractString(raw_data, 'EntityRef', 'name'), ''), '')         AS vendor_name,
          coalesce(nullIf(JSONExtractString(raw_data, 'EntityRef', 'value'), ''), '')        AS vendor_id,
          toDecimal64(JSONExtractFloat(line_raw, 'Amount'), 4)                               AS debit_amount,
          toDecimal64(0, 4)                                                                   AS credit_amount,
          tenant_id, user_id, connection_id, 'quickbooks' AS provider, org_id, org_name, updated_at, synced_at
        FROM (
          SELECT
            source_id,
            any(tenant_id) AS tenant_id,
            any(user_id) AS user_id,
            any(connection_id) AS connection_id,
            any(org_id) AS org_id,
            any(org_name) AS org_name,
            argMax(raw_data, r.updated_at) AS raw_data,
            max(r.updated_at) AS updated_at,
            max(r.synced_at) AS synced_at
          FROM ${this.qbDb}.quickbooks_raw AS r
          WHERE resource = 'Purchase'
            AND tenant_id = '${this.escape(tenantId)}'
            AND org_id    = '${this.escape(orgId)}'
          GROUP BY source_id
        )
        ARRAY JOIN JSONExtractArrayRaw(raw_data, 'Line') AS line_raw
        WHERE JSONExtractString(line_raw, 'DetailType') = 'AccountBasedExpenseLineDetail'
          AND JSONExtractFloat(line_raw, 'Amount') > 0
      `});
      this.logger.debug(`[Transform] QB Purchases → fact_accounting_journal_lines OK`);
    } catch (e: any) {
      this.logger.warn(`[Transform] QB Purchases extraction failed: ${e?.message}`);
    }

    this.logger.debug(`[Transform] QB fact_accounting_journal_lines complete for org:${orgId.slice(0,8)}`);
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
            argMax(raw_data, r.updated_at) AS raw_data,
            max(r.updated_at) AS updated_at,
            max(r.synced_at) AS synced_at
          FROM ${this.xeroDb}.xero_raw AS r
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
            argMax(raw_data, r.updated_at) AS raw_data,
            max(r.updated_at) AS updated_at,
            max(r.synced_at) AS synced_at
          FROM ${this.qbDb}.quickbooks_raw AS r
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
          argMax(raw_data, r.updated_at) AS raw_data,
          max(r.updated_at) AS updated_at,
          max(r.synced_at) AS synced_at
        FROM ${this.xeroDb}.xero_raw AS r
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
