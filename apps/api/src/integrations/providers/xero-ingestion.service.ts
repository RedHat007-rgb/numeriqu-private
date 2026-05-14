import { Injectable, Inject, Logger } from '@nestjs/common';
import axios from 'axios';
import { CLICKHOUSE_XERO_TOKEN } from '../../database/database.module';
import { ClickHouseClient } from '@clickhouse/client';
import { SyncJobConfig } from '../../sync/sync.service';
import { XeroClient, AccountingApi } from 'xero-node';

@Injectable()
export class XeroIngestionService {
  private readonly logger = new Logger(XeroIngestionService.name);
  private readonly schemaReady: Promise<void>;
  private schemaCreationFailed = false;

  constructor(
    @Inject(CLICKHOUSE_XERO_TOKEN)
    private readonly clickhouse: ClickHouseClient,
  ) {
    this.schemaReady = this.ensureTables();
  }

  async runSync(
    jobDetails: SyncJobConfig,
    accessToken: string,
    xeroTenantId: string,
  ): Promise<number> {
    this.logger.log(
      `[Xero-Custom] Starting custom ingestion for tenant ${jobDetails.tenantId} (Org: ${xeroTenantId})`,
    );

    const xero = new XeroClient({
      clientId: process.env.XERO_CLIENT_ID || '',
      clientSecret: process.env.XERO_CLIENT_SECRET || '',
      redirectUris: [
        process.env.XERO_REDIRECT_URI ||
          'http://localhost:3000/auth/xero/callback',
      ],
    });

    xero.setTokenSet({ access_token: accessToken });

    await this.schemaReady;

    const ifModifiedDate = jobDetails.syncWindowStart
      ? new Date(jobDetails.syncWindowStart)
      : undefined;

    const entities = [
      {
        name: 'Accounts',
        dataKey: 'accounts',
        fetch: () => xero.accountingApi.getAccounts(xeroTenantId),
      },
      {
        name: 'Invoices',
        dataKey: 'invoices',
        fetch: () =>
          xero.accountingApi.getInvoices(xeroTenantId, ifModifiedDate),
      },
      {
        name: 'Contacts',
        dataKey: 'contacts',
        fetch: () =>
          xero.accountingApi.getContacts(xeroTenantId, ifModifiedDate),
      },
      {
        name: 'BankTransactions',
        dataKey: 'bankTransactions',
        fetch: () =>
          xero.accountingApi.getBankTransactions(xeroTenantId, ifModifiedDate),
      },
      {
        name: 'ManualJournals',
        dataKey: 'manualJournals',
        fetch: () =>
          xero.accountingApi.getManualJournals(xeroTenantId, ifModifiedDate),
      },
      {
        name: 'Payments',
        dataKey: 'payments',
        fetch: () =>
          xero.accountingApi.getPayments(xeroTenantId, ifModifiedDate),
      },
      {
        name: 'CreditNotes',
        dataKey: 'creditNotes',
        fetch: () =>
          xero.accountingApi.getCreditNotes(xeroTenantId, ifModifiedDate),
      },
      {
        name: 'PurchaseOrders',
        dataKey: 'purchaseOrders',
        fetch: () =>
          xero.accountingApi.getPurchaseOrders(xeroTenantId, ifModifiedDate),
      },
      {
        name: 'Quotes',
        dataKey: 'quotes',
        fetch: () => xero.accountingApi.getQuotes(xeroTenantId, ifModifiedDate),
      },
      {
        name: 'Items',
        dataKey: 'items',
        fetch: () => xero.accountingApi.getItems(xeroTenantId, ifModifiedDate),
      },
      {
        name: 'TaxRates',
        dataKey: 'taxRates',
        fetch: () => xero.accountingApi.getTaxRates(xeroTenantId),
      },
      {
        name: 'TrackingCategories',
        dataKey: 'trackingCategories',
        fetch: () => xero.accountingApi.getTrackingCategories(xeroTenantId),
      },
      {
        name: 'BrandingThemes',
        dataKey: 'brandingThemes',
        fetch: () => xero.accountingApi.getBrandingThemes(xeroTenantId),
      },
      {
        name: 'Organisation',
        dataKey: 'organisations',
        fetch: () => xero.accountingApi.getOrganisations(xeroTenantId),
      },
      {
        name: 'Currencies',
        dataKey: 'currencies',
        fetch: () => xero.accountingApi.getCurrencies(xeroTenantId),
      },
      {
        name: 'BankTransfers',
        dataKey: 'bankTransfers',
        fetch: () =>
          xero.accountingApi.getBankTransfers(xeroTenantId, ifModifiedDate),
      },
      {
        name: 'BatchPayments',
        dataKey: 'batchPayments',
        fetch: () =>
          xero.accountingApi.getBatchPayments(xeroTenantId, ifModifiedDate),
      },
      {
        name: 'Budgets',
        dataKey: 'budgets',
        fetch: () => xero.accountingApi.getBudgets(xeroTenantId),
      },
      {
        name: 'ContactGroups',
        dataKey: 'contactGroups',
        fetch: () => xero.accountingApi.getContactGroups(xeroTenantId),
      },
      {
        name: 'Employees',
        dataKey: 'employees',
        fetch: () =>
          xero.accountingApi.getEmployees(xeroTenantId, ifModifiedDate),
      },
      {
        name: 'ExpenseClaims',
        dataKey: 'expenseClaims',
        fetch: () =>
          xero.accountingApi.getExpenseClaims(xeroTenantId, ifModifiedDate),
      },
      {
        name: 'Overpayments',
        dataKey: 'overpayments',
        fetch: () =>
          xero.accountingApi.getOverpayments(xeroTenantId, ifModifiedDate),
      },
      {
        name: 'Prepayments',
        dataKey: 'prepayments',
        fetch: () =>
          xero.accountingApi.getPrepayments(xeroTenantId, ifModifiedDate),
      },
      {
        name: 'Receipts',
        dataKey: 'receipts',
        fetch: () =>
          xero.accountingApi.getReceipts(xeroTenantId, ifModifiedDate),
      },
      {
        name: 'RepeatingInvoices',
        dataKey: 'repeatingInvoices',
        fetch: () => xero.accountingApi.getRepeatingInvoices(xeroTenantId),
      },
      {
        name: 'Users',
        dataKey: 'users',
        fetch: () => xero.accountingApi.getUsers(xeroTenantId, ifModifiedDate),
      },
    ];

    let totalRecords = 0;

    for (const entity of entities) {
      try {
        this.logger.debug(`[Xero-Custom] Starting fetch for: ${entity.name}`);
        const response = await (entity.fetch() as any);
        const data = response.body[entity.dataKey] || [];

        if (Array.isArray(data)) {
          if (data.length > 0) {
            const committed = await this.appendRecords(
              jobDetails,
              entity.name,
              data,
            );
            totalRecords += committed;
            this.logger.log(
              `[Xero-Custom] SUCCESS: Synced ${data.length} records for ${entity.name} (Committed: ${committed})`,
            );
          } else {
            this.logger.log(
              `[Xero-Custom] SKIP: No records found for ${entity.name} in this sync window.`,
            );
          }
        } else {
          this.logger.warn(
            `[Xero-Custom] UNEXPECTED: Response for ${entity.name} was not an array.`,
          );
        }
      } catch (error: any) {
        if (
          error.response?.status === 401 ||
          error.response?.status === 403 ||
          error.response?.statusCode === 401 ||
          error.response?.statusCode === 403
        ) {
          this.logger.error(
            `[Xero-Custom] PERMISSION DENIED: ${entity.name} failed with status ${error.response?.status || error.response?.statusCode}. Check OAuth scopes!`,
          );
        } else {
          const inspected = this.inspectError(error);
          this.logger.error(
            `[Xero-Custom] FAILED: ${entity.name} sync interrupted: ${inspected.message}`,
            inspected.details,
          );
        }
      }
    }

    // P&L Report → synthetic journal lines
    // Xero's raw Journals endpoint requires accounting.journals.read (unavailable on new apps).
    // Instead we fetch the P&L Report which uses accounting.reports.read (already granted) and
    // convert each account row + month period into a synthetic journal line entry so all
    // existing P&L / expense / margin / EBITDA chart queries work without changes.
    try {
      this.logger.debug(`[Xero-Custom] Fetching P&L Report (24 months)...`);
      const reportRows = await this.fetchPnlReportLines(
        accessToken,
        xeroTenantId,
        jobDetails,
      );
      if (reportRows.length > 0) {
        const analyticsDb = process.env.CLICKHOUSE_ANALYTICS_DB || 'analytics';
        // Wipe previous P&L report rows for this org so re-syncs are idempotent
        const esc = (s: string) => s.replace(/'/g, "\\'");
        await this.clickhouse.command({
          query: `ALTER TABLE ${analyticsDb}.fact_accounting_journal_lines
                  DELETE WHERE tenant_id = '${esc(jobDetails.tenantId)}'
                    AND org_id = '${esc(jobDetails.orgId)}'
                    AND source_type = 'ProfitAndLossReport'
                  SETTINGS mutations_sync = 1`,
        });
        await this.clickhouse.insert({
          table: `${analyticsDb}.fact_accounting_journal_lines`,
          values: reportRows,
          format: 'JSONEachRow',
        });
        totalRecords += reportRows.length;
        this.logger.log(
          `[Xero-Custom] P&L Report → ${reportRows.length} synthetic journal lines committed`,
        );
      } else {
        this.logger.warn(`[Xero-Custom] P&L Report returned no rows`);
      }
    } catch (error: any) {
      this.logger.error(
        `[Xero-Custom] P&L Report sync failed: ${error.message}`,
      );
    }

    return totalRecords;
  }

  // ── P&L Report → synthetic journal lines ─────────────────────────────────

  private async fetchPnlReportLines(
    accessToken: string,
    xeroTenantId: string,
    jobDetails: SyncJobConfig,
  ): Promise<Record<string, unknown>[]> {
    // Fetch 24 months of P&L, monthly granularity
    const response = await axios.get(
      'https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss',
      {
        params: { periods: 24, timeframe: 'MONTH', standardLayout: true },
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Xero-tenant-id': xeroTenantId,
          Accept: 'application/json',
        },
        timeout: 30000,
      },
    );

    const report = response.data?.Reports?.[0];
    if (!report) return [];

    // Extract column headers → month labels (skip first "Account" column)
    const headerRow = report.Rows?.find((r: any) => r.RowType === 'Header');
    const headers: string[] = (headerRow?.Cells ?? [])
      .slice(1)
      .map((c: any) => c.Value as string);

    // Parse a date string like "Jan 2026" → ISO date "2026-01-01"
    const parseMonthLabel = (label: string): string | null => {
      const months: Record<string, string> = {
        Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
        Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
      };
      const m = label?.trim().match(/^([A-Za-z]{3})\s+(\d{4})$/);
      if (!m) return null;
      const month = months[m[1] ?? ''];
      return month ? `${m[2]}-${month}-01` : null;
    };

    const periodDates = headers.map(parseMonthLabel);
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const rows: Record<string, unknown>[] = [];

    // Xero P&L section titles map to account type categories
    const sectionTypeMap: Record<string, string> = {
      'Income': 'REVENUE',
      'Revenue': 'REVENUE',
      'Sales': 'REVENUE',
      'Cost of Sales': 'COGS',
      'Less Cost of Sales': 'COGS',
      'Direct Costs': 'COGS',
      'Operating Expenses': 'OPEX',
      'Less Operating Expenses': 'OPEX',
      'Expenses': 'OPEX',
      'Other Income': 'OTHER_INCOME',
      'Other Expenses': 'OTHER_EXPENSE',
      'Depreciation': 'DEPRECIATION',
    };

    const walkSection = (section: any, sectionTitle: string) => {
      const accountType = sectionTypeMap[sectionTitle] ?? 'OPEX';
      for (const row of section.Rows ?? []) {
        if (row.RowType !== 'Row') continue;
        const cells: any[] = row.Cells ?? [];
        const accountName: string = cells[0]?.Value ?? 'Unknown';
        const accountId: string =
          cells[0]?.Attributes?.find((a: any) => a.Id === 'account')?.Value ?? '';

        cells.slice(1).forEach((cell: any, idx: number) => {
          const dateStr = periodDates[idx];
          if (!dateStr) return;
          const rawAmt = String(cell?.Value ?? '0').replace(/,/g, '');
          const amount = parseFloat(rawAmt);
          if (!Number.isFinite(amount) || amount === 0) return;

          // Sign convention: revenue is negative (credit), expenses positive (debit)
          // Xero reports expenses as positive values in the P&L
          const lineAmount =
            accountType === 'REVENUE' ? -Math.abs(amount) : Math.abs(amount);

          rows.push({
            journal_id: `pnl_${jobDetails.orgId}_${dateStr}_${accountId || accountName}`,
            journal_number: 0,
            journal_date: `${dateStr} 00:00:00`,
            source_type: 'ProfitAndLossReport',
            source_id: `pnl_${dateStr}`,
            line_id: `${jobDetails.orgId}_${dateStr}_${accountId || accountName}`,
            account_id: accountId,
            account_code: accountType,
            account_name: accountName,
            line_amount: lineAmount,
            description: `${sectionTitle} — ${accountName}`,
            tenant_id: jobDetails.tenantId,
            user_id: jobDetails.userId,
            connection_id: jobDetails.connectionId,
            provider: 'xero',
            org_id: jobDetails.orgId,
            org_name: jobDetails.orgName,
            updated_at: now,
            synced_at: now,
          });
        });
      }
    };

    for (const section of report.Rows ?? []) {
      if (section.RowType !== 'Section') continue;
      walkSection(section, section.Title ?? '');
    }

    return rows;
  }

  private async appendRecords(
    jobDetails: SyncJobConfig,
    resource: string,
    records: any[],
  ): Promise<number> {
    const prepared = records
      .map((record) => ({
        tenant_id: jobDetails.tenantId,
        user_id: jobDetails.userId,
        connection_id: jobDetails.connectionId,
        provider: 'xero',
        org_id: jobDetails.orgId,
        org_name: jobDetails.orgName,
        resource,
        source_id: this.extractRecordId(record),
        raw_data: JSON.stringify(record),
        updated_at: this.extractUpdatedAt(record),
        synced_at: this.formatDate(new Date()),
      }))
      .filter((r) => r.source_id !== 'unknown');

    if (prepared.length === 0) return 0;

    const dbName = this.getXeroDatabase();
    await this.clickhouse.insert({
      table: `${dbName}.xero_raw`,
      values: prepared,
      format: 'JSONEachRow',
    });
    return prepared.length;
  }

  private extractRecordId(record: any): string {
    return (
      record.AccountID ||
      record.accountID ||
      record.InvoiceID ||
      record.invoiceID ||
      record.ContactID ||
      record.contactID ||
      record.BankTransactionID ||
      record.bankTransactionID ||
      record.ManualJournalID ||
      record.manualJournalID ||
      record.JournalID ||
      record.journalID ||
      record.PaymentID ||
      record.paymentID ||
      record.CreditNoteID ||
      record.creditNoteID ||
      record.PurchaseOrderID ||
      record.purchaseOrderID ||
      record.QuoteID ||
      record.quoteID ||
      record.ItemID ||
      record.itemID ||
      record.TaxType ||
      record.taxType ||
      record.TrackingCategoryID ||
      record.trackingCategoryID ||
      record.BrandingThemeID ||
      record.brandingThemeID ||
      record.OrganisationID ||
      record.organisationID ||
      record.Code ||
      record.code ||
      record.BankTransferID ||
      record.bankTransferID ||
      record.BatchPaymentID ||
      record.batchPaymentID ||
      record.BudgetID ||
      record.budgetID ||
      record.ContactGroupID ||
      record.contactGroupID ||
      record.EmployeeID ||
      record.employeeID ||
      record.ExpenseClaimID ||
      record.expenseClaimID ||
      record.OverpaymentID ||
      record.overpaymentID ||
      record.PrepaymentID ||
      record.prepaymentID ||
      record.ReceiptID ||
      record.receiptID ||
      record.RepeatingInvoiceID ||
      record.repeatingInvoiceID ||
      record.UserID ||
      record.userID ||
      'unknown'
    );
  }

  private extractUpdatedAt(record: any): string {
    return this.formatDate(record.UpdatedDateUTC || record.Date || new Date());
  }

  private formatDate(value: Date | string | undefined): string {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.valueOf())) {
      return new Date().toISOString().replace('T', ' ').substring(0, 19);
    }
    return date.toISOString().replace('T', ' ').substring(0, 19);
  }

  private async ensureTables() {
    const dbName = this.getXeroDatabase();
    const qualifiedTable = `${dbName}.xero_raw`;

    await this.createTableSafely(
      qualifiedTable,
      `
        CREATE TABLE IF NOT EXISTS ${qualifiedTable} (
          tenant_id String,
          user_id String,
          connection_id String,
          provider String,
          org_id String DEFAULT '',
          org_name String DEFAULT '',
          resource String,
          source_id String,
          raw_data String,
          updated_at DateTime,
          synced_at DateTime
        )
        ENGINE = MergeTree()
        ORDER BY (tenant_id, org_id, resource, updated_at)
      `,
    );

    // Add columns to existing tables (safe for already-created tables)
    await this.createTableSafely(
      qualifiedTable,
      `ALTER TABLE ${qualifiedTable} ADD COLUMN IF NOT EXISTS org_id String DEFAULT ''`,
    );
    await this.createTableSafely(
      qualifiedTable,
      `ALTER TABLE ${qualifiedTable} ADD COLUMN IF NOT EXISTS org_name String DEFAULT ''`,
    );
    // Schema rename migration: tables created before this version used
    // `organization_id` as the column name; all code now uses `tenant_id`.
    // The ORDER BY key column cannot be renamed in ClickHouse, so we ADD the
    // new column and backfill from the old one.
    //
    // These two statements are intentionally wrapped in their own try/catch so
    // that on a FRESH install (where `organization_id` never existed) the error
    // is silently ignored and startup is not blocked.
    try {
      await this.clickhouse.command({
        query: `ALTER TABLE ${qualifiedTable} ADD COLUMN IF NOT EXISTS tenant_id String DEFAULT ''`,
      });
    } catch { /* non-fatal: column may already exist */ }

    try {
      await this.clickhouse.command({
        query: `ALTER TABLE ${qualifiedTable} UPDATE tenant_id = organization_id WHERE tenant_id = ''`,
      });
    } catch { /* non-fatal: organization_id may not exist on fresh installs */ }
  }

  private getXeroDatabase(): string {
    return (
      process.env.CLICKHOUSE_XERO_DB ||
      process.env.CLICKHOUSE_DB ||
      'xero_custom'
    ).trim();
  }

  private inspectError(error: any) {
    const isAxiosError = !!error.isAxiosError || !!error.response?.config;

    return {
      message: isAxiosError
        ? error.response?.data?.Message || error.message
        : error.response?.body?.Message ||
          error.message ||
          'Unknown Xero SDK Error',
      details: {
        type: isAxiosError ? 'AxiosNetworkError' : 'XeroSDKError',
        statusCode: error.response?.status || error.response?.statusCode,
        data: error.response?.data || error.response?.body,
        path: error.config?.url || error.response?.config?.url,
        stack: error.stack?.split('\n').slice(0, 3).join('\n'), // Clean stack
      },
    };
  }

  private async createTableSafely(tableName: string, ddl: string) {
    if (this.schemaCreationFailed) return;
    try {
      await this.clickhouse.command({ query: ddl });
    } catch (error: any) {
      if (error?.code === '497' || error?.type === 'ACCESS_DENIED') {
        this.schemaCreationFailed = true;
        this.logger.warn(
          `[Xero-Custom] Access denied when creating ${tableName}.`,
        );
        return;
      }
      throw error;
    }
  }
}
