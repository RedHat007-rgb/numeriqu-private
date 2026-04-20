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

    // Special handling      // Journals paged fetch (using direct API for reliability)
    try {
      this.logger.debug(
        `[Xero-Custom] Fetching Journals (Paged via Direct API)...`,
      );
      let offset = 0;
      let moreJournals = true;
      let totalIngested = 0;
      while (moreJournals) {
        try {
          const response = await axios.get(
            'https://api.xero.com/api.xro/2.0/Journals',
            {
              params: { offset },
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Xero-tenant-id': xeroTenantId,
                Accept: 'application/json',
              },
            },
          );

          const journals = response.data.Journals || [];
          if (journals.length === 0) {
            moreJournals = false;
          } else {
            const committed = await this.appendRecords(
              jobDetails,
              'Journals',
              journals,
            );
            totalIngested += committed;
            totalRecords += committed;
            offset += journals.length;
            if (journals.length < 100) moreJournals = false; // Xero default page size is 100
          }
        } catch (error: any) {
          if (error.response?.status === 401) {
            this.logger.warn(
              `[Xero-Custom] Journals fetch bypassed: Scope 'accounting.journals.read' missing from this connection. User re-authorization required for ledger-level data.`,
            );
            moreJournals = false;
          } else {
            const inspected = this.inspectError(error);
            this.logger.error(
              `[Xero-Custom] Failed to fetch Journals: ${inspected.message}`,
            );
            this.logger.error(inspected.details);
            moreJournals = false;
          }
        }
      }
      this.logger.log(
        `[Xero-Custom] Completed Journals sync (Total: ${totalIngested})`,
      );
    } catch (error: any) {
      this.logger.error(
        `[Xero-Custom] Critical failure in Journals sync: ${error.message}`,
      );
    }

    return totalRecords;
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
  }

  private getXeroDatabase(): string {
    return (
      process.env.CLICKHOUSE_XERO_DB ||
      process.env.CLICKHOUSE_DB ||
      'default'
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
