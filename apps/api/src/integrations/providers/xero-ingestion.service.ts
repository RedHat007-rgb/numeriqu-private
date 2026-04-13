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
      redirectUris: [process.env.XERO_REDIRECT_URI || 'http://localhost:3000/auth/xero/callback'],
    });

    xero.setTokenSet({ access_token: accessToken });

    await this.schemaReady;

    const ifModifiedDate = jobDetails.syncWindowStart ? new Date(jobDetails.syncWindowStart) : undefined;

    const entities = [
      { name: 'Accounts', fetch: () => xero.accountingApi.getAccounts(xeroTenantId) },
      { name: 'Invoices', fetch: () => xero.accountingApi.getInvoices(xeroTenantId, ifModifiedDate) },
      { name: 'Contacts', fetch: () => xero.accountingApi.getContacts(xeroTenantId, ifModifiedDate) },
      { name: 'BankTransactions', fetch: () => xero.accountingApi.getBankTransactions(xeroTenantId, ifModifiedDate) },
      { name: 'ManualJournals', fetch: () => xero.accountingApi.getManualJournals(xeroTenantId, ifModifiedDate) },
      { name: 'Payments', fetch: () => xero.accountingApi.getPayments(xeroTenantId, ifModifiedDate) },
      { name: 'CreditNotes', fetch: () => xero.accountingApi.getCreditNotes(xeroTenantId, ifModifiedDate) },
      { name: 'PurchaseOrders', fetch: () => xero.accountingApi.getPurchaseOrders(xeroTenantId, ifModifiedDate) },
      { name: 'Quotes', fetch: () => xero.accountingApi.getQuotes(xeroTenantId, ifModifiedDate) },
      { name: 'Items', fetch: () => xero.accountingApi.getItems(xeroTenantId, ifModifiedDate) },
      { name: 'TaxRates', fetch: () => xero.accountingApi.getTaxRates(xeroTenantId) },
      { name: 'TrackingCategories', fetch: () => xero.accountingApi.getTrackingCategories(xeroTenantId) },
      { name: 'BrandingThemes', fetch: () => xero.accountingApi.getBrandingThemes(xeroTenantId) },
      { name: 'Organisation', fetch: () => xero.accountingApi.getOrganisations(xeroTenantId) },
      { name: 'Currencies', fetch: () => xero.accountingApi.getCurrencies(xeroTenantId) },
    ];

    let totalRecords = 0;

    for (const entity of entities) {
      try {
        this.logger.debug(`[Xero-Custom] Fetching ${entity.name}...`);
        const response = await (entity.fetch() as any);
        const data = response.body[entity.name.toLowerCase()] || response.body[entity.name] || [];
        
        if (Array.isArray(data) && data.length > 0) {
          const committed = await this.appendRecords(jobDetails, entity.name, data);
          totalRecords += committed;
          this.logger.log(`[Xero-Custom] Ingested ${data.length} records for ${entity.name} (Committed: ${committed})`);
        }
      } catch (error: any) {
        if (error.response?.status === 401 || error.response?.status === 403 || error.response?.statusCode === 401 || error.response?.statusCode === 403) {
          this.logger.warn(`[Xero-Custom] ${entity.name} bypassed (Missing Scope or Permission)`);
        } else {
          const inspected = this.inspectError(error);
          this.logger.error(`[Xero-Custom] Failed to fetch ${entity.name}: ${inspected.message}`, inspected.details);
        }
      }
    }

    // Special handling      // Journals paged fetch (using direct API for reliability)
    try {
      this.logger.debug(`[Xero-Custom] Fetching Journals (Paged via Direct API)...`);
      let offset = 0;
      let moreJournals = true;
      let totalIngested = 0;
      while (moreJournals) {
        try {
          const response = await axios.get('https://api.xero.com/api.xro/2.0/Journals', {
            params: { offset },
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Xero-tenant-id': xeroTenantId,
              'Accept': 'application/json'
            }
          });
          
          const journals = response.data.Journals || [];
          if (journals.length === 0) {
            moreJournals = false;
          } else {
            const committed = await this.appendRecords(jobDetails, 'Journals', journals);
            totalIngested += committed;
            totalRecords += committed;
            offset += journals.length;
            if (journals.length < 100) moreJournals = false; // Xero default page size is 100
          }
        } catch (error: any) {
          if (error.response?.status === 401) {
            this.logger.warn(`[Xero-Custom] Journals fetch bypassed: Scope 'accounting.journals.read' missing from this connection. User re-authorization required for ledger-level data.`);
            moreJournals = false;
          } else {
            const inspected = this.inspectError(error);
            this.logger.error(`[Xero-Custom] Failed to fetch Journals: ${inspected.message}`);
            this.logger.error(inspected.details);
            moreJournals = false;
          }
        }
      }
      this.logger.log(`[Xero-Custom] Completed Journals sync (Total: ${totalIngested})`);
    } catch (error: any) {
      this.logger.error(`[Xero-Custom] Critical failure in Journals sync: ${error.message}`);
    }

    return totalRecords;
  }

  private async appendRecords(
    jobDetails: SyncJobConfig,
    resource: string,
    records: any[],
  ): Promise<number> {
    const prepared = records.map((record) => ({
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
    })).filter(r => r.source_id !== 'unknown');

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
      record.AccountID || record.accountID ||
      record.InvoiceID || record.invoiceID ||
      record.ContactID || record.contactID ||
      record.BankTransactionID || record.bankTransactionID ||
      record.ManualJournalID || record.manualJournalID ||
      record.JournalID || record.journalID ||
      record.PaymentID || record.paymentID ||
      record.CreditNoteID || record.creditNoteID ||
      record.PurchaseOrderID || record.purchaseOrderID ||
      record.QuoteID || record.quoteID ||
      record.ItemID || record.itemID ||
      record.TaxType || record.taxType ||
      record.TrackingCategoryID || record.trackingCategoryID ||
      record.BrandingThemeID || record.brandingThemeID ||
      record.OrganisationID || record.organisationID ||
      record.Code || record.code ||
      'unknown'
    );
  }

  private extractUpdatedAt(record: any): string {
    return this.formatDate(
      record.UpdatedDateUTC || record.Date || new Date(),
    );
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
    await this.createTableSafely(qualifiedTable, `ALTER TABLE ${qualifiedTable} ADD COLUMN IF NOT EXISTS org_id String DEFAULT ''`);
    await this.createTableSafely(qualifiedTable, `ALTER TABLE ${qualifiedTable} ADD COLUMN IF NOT EXISTS org_name String DEFAULT ''`);
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
        ? (error.response?.data?.Message || error.message)
        : (error.response?.body?.Message || error.message || 'Unknown Xero SDK Error'),
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
