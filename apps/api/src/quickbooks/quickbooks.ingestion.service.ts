import { Injectable, Inject, Logger } from '@nestjs/common';
import { CLICKHOUSE_QUICKBOOKS_TOKEN } from '../database/database.module';
import { ClickHouseClient } from '@clickhouse/client';
import { SyncJobConfig } from '../sync/sync.service';
import { createQuickBooksClient, QuickBooksClient } from './quickbooks.client';

export class QuickBooksAuthError extends Error {
  public readonly inner?: unknown;

  constructor(message: string, inner?: unknown) {
    super(message);
    this.name = 'QuickBooksAuthError';
    this.inner = inner;
  }
}

type QuickBooksEntity = {
  name: string;
  method: string;
  requiresMetaFilter?: boolean;
};

const QUICKBOOKS_ENTITIES: QuickBooksEntity[] = [
  { name: 'Account', method: 'findAccounts' },
  { name: 'Bill', method: 'findBills' },
  { name: 'BillPayment', method: 'findBillPayments' },
  { name: 'Budget', method: 'findBudgets' },
  { name: 'Class', method: 'findClasses' },
  {
    name: 'CompanyInfo',
    method: 'findCompanyInfos',
    requiresMetaFilter: false,
  },
  {
    name: 'CompanyCurrency',
    method: 'findCompanyCurrencies',
    requiresMetaFilter: false,
  },
  { name: 'CreditMemo', method: 'findCreditMemos' },
  { name: 'Customer', method: 'findCustomers' },
  { name: 'CustomerType', method: 'findCustomerTypes' },
  { name: 'Department', method: 'findDepartments' },
  { name: 'Deposit', method: 'findDeposits' },
  { name: 'Employee', method: 'findEmployees' },
  { name: 'Estimate', method: 'findEstimates' },
  { name: 'Invoice', method: 'findInvoices' },
  { name: 'Item', method: 'findItems' },
  { name: 'JournalCode', method: 'findJournalCodes' },
  { name: 'JournalEntry', method: 'findJournalEntries' },
  { name: 'Payment', method: 'findPayments' },
  { name: 'PaymentMethod', method: 'findPaymentMethods' },
  { name: 'Preferences', method: 'findPreferenceses' },
  { name: 'Purchase', method: 'findPurchases' },
  { name: 'PurchaseOrder', method: 'findPurchaseOrders' },
  { name: 'RefundReceipt', method: 'findRefundReceipts' },
  { name: 'SalesReceipt', method: 'findSalesReceipts' },
  { name: 'TaxAgency', method: 'findTaxAgencies' },
  { name: 'TaxCode', method: 'findTaxCodes' },
  { name: 'TaxRate', method: 'findTaxRates' },
  { name: 'Term', method: 'findTerms' },
  { name: 'TimeActivity', method: 'findTimeActivities' },
  { name: 'Transfer', method: 'findTransfers' },
  { name: 'Vendor', method: 'findVendors' },
  { name: 'VendorCredit', method: 'findVendorCredits' },
  {
    name: 'ExchangeRate',
    method: 'findExchangeRates',
    requiresMetaFilter: false,
  },
];

const ENTITY_TIMEOUT_MS = 30_000;

@Injectable()
export class QuickbooksIngestionService {
  private readonly logger = new Logger(QuickbooksIngestionService.name);
  private readonly schemaReady: Promise<void>;
  private schemaCreationFailed = false;

  constructor(
    @Inject(CLICKHOUSE_QUICKBOOKS_TOKEN)
    private readonly clickhouse: ClickHouseClient,
  ) {
    this.schemaReady = this.ensureTables();
  }

  async runIncrementalSync(
    jobDetails: SyncJobConfig,
    accessToken: string,
    refreshToken: string,
    realmId: string,
  ): Promise<number> {
    this.logger.log(
      `[QuickBooks] Starting ingestion for job ${jobDetails.syncJobId} (since ${jobDetails.syncWindowStart.toISOString()})`,
    );

    const qbClient = createQuickBooksClient({
      consumerKey: process.env.QB_CLIENT_ID || 'fake_client_id',
      consumerSecret: process.env.QB_CLIENT_SECRET || 'fake_client_secret',
      accessToken,
      realmId,
      refreshToken: refreshToken ?? null,
      useSandbox: process.env.QB_ENVIRONMENT !== 'production',
      oauthVersion: '2.0',
      minorVersion: '75',
    });

    await this.schemaReady;

    let totalRecords = 0;
    let skippedEntities = 0;

    for (const entity of QUICKBOOKS_ENTITIES) {
      try {
        const processed = await this.withTimeout(
          this.ingestEntity(jobDetails, qbClient, entity),
          ENTITY_TIMEOUT_MS,
          `QuickBooks entity ${entity.name} timed out after ${ENTITY_TIMEOUT_MS / 1000}s`,
        );
        totalRecords += processed;
        this.logger.debug(
          `[QuickBooks] Completed resource ${entity.name} (${processed} records)`,
        );
      } catch (error: any) {
        if (error instanceof QuickBooksAuthError) throw error;

        skippedEntities++;
        const status = error?.response?.status || error?.status || 'Unknown';
        const detail = error?.response?.data?.fault?.error?.[0]?.Message || error?.message || 'No detail available';

        this.logger.warn(
          `[QuickBooks] Resource ${entity.name} skipped: [${status}] ${detail}`,
        );
      }
    }

    this.logger.log(
      `[QuickBooks] Finished ingestion for job ${jobDetails.syncJobId}. Total records: ${totalRecords}, skipped: ${skippedEntities}`,
    );
    return totalRecords;
  }

  private async ingestEntity(
    jobDetails: SyncJobConfig,
    qbClient: QuickBooksClient,
    entity: QuickBooksEntity,
  ): Promise<number> {
    // Enforce a minimum bound of 2014 for Quickbooks since older dates can trigger a 400 Bad Request on QBOv3 SQL
    const validStart = jobDetails.syncWindowStart < new Date('2014-01-01') 
      ? new Date('2014-01-01T00:00:00Z') 
      : jobDetails.syncWindowStart;
    
    // YYYY-MM-DD format is universally accepted and the safest syntax for node-quickbooks
    const formattedDate = validStart.toISOString().split('T')[0];
    const requiresFilter = entity.requiresMetaFilter !== false;
    const maxResults = 1000;
    let startPosition = 1;
    let processed = 0;

    while (true) {
      const criteria = [
        ...(requiresFilter
          ? [
              {
                field: 'MetaData.LastUpdatedTime',
                operator: '>=',
                value: formattedDate,
              },
            ]
          : []),
        { asc: 'MetaData.LastUpdatedTime' },
        { limit: maxResults },
        { offset: startPosition },
      ];

      const batch = await this.withTimeout(
        this.fetchEntityBatch(
          qbClient,
          entity,
          formattedDate,
          startPosition,
          maxResults,
        ),
        ENTITY_TIMEOUT_MS,
        `QuickBooks batch fetch for ${entity.name} timed out`,
      );

      if (!batch || batch.length === 0) {
        break;
      }

      await this.appendRecords(jobDetails, entity.name, batch);
      processed += batch.length;
      startPosition += maxResults;

      if (batch.length < maxResults) {
        break;
      }
    }

    return processed;
  }

  private fetchEntityBatch(
    qbClient: QuickBooksClient,
    entity: QuickBooksEntity,
    formattedDate: string,
    startPosition: number,
    limit: number,
  ): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const criteria = [
        ...(entity.requiresMetaFilter !== false
          ? [
              {
                field: 'MetaData.LastUpdatedTime',
                operator: '>=',
                value: formattedDate,
              },
            ]
          : []),
        { asc: 'MetaData.LastUpdatedTime' },
        { limit },
        { offset: startPosition },
      ];

      const method = (qbClient as any)[entity.method];
      if (typeof method !== 'function') {
        return reject(
          new Error(`QuickBooks SDK method ${entity.method} not found`),
        );
      }

      method.call(qbClient, criteria, (err: any, response: any) => {
        if (err) {
          if (this.isUnauthorizedError(err)) {
            return reject(
              new QuickBooksAuthError(
                'QuickBooks returned 401 Unauthorized',
                err,
              ),
            );
          }
          return reject(err);
        }

        const items = response?.QueryResponse?.[entity.name] || [];
        if (Array.isArray(items)) {
          resolve(items);
        } else if (items) {
          resolve([items]);
        } else {
          resolve([]);
        }
      });
    });
  }

  private isUnauthorizedError(error: any): boolean {
    const status = error?.response?.status ?? error?.status ?? error?.statusCode ?? null;
    const bodyStatus = error?.response?.data?.status;
    
    if (status === 401 || bodyStatus === 401) return true;
    
    const message = (error?.message || '').toString().toLowerCase();
    const errorDetail = JSON.stringify(error?.response?.data || '').toLowerCase();
    
    return (
      message.includes('401') || 
      message.includes('unauthorized') || 
      errorDetail.includes('invalid_token') ||
      errorDetail.includes('authentication_failed')
    );
  }

  private async appendRecords(
    jobDetails: SyncJobConfig,
    resource: string,
    records: any[],
  ) {
    const prepared = records.map((record) => ({
      tenant_id: jobDetails.tenantId,
      user_id: jobDetails.userId,
      connection_id: jobDetails.connectionId,
      provider: 'quickbooks',
      org_id: jobDetails.orgId,
      org_name: jobDetails.orgName,
      resource,
      source_id: this.extractRecordId(record),
      raw_data: JSON.stringify(record),
      updated_at: this.extractUpdatedAt(record),
      synced_at: this.formatDate(new Date()),
    }));

    const dbName = this.getQuickBooksDatabase();
    await this.clickhouse.insert({
      table: `${dbName}.quickbooks_raw`,
      values: prepared,
      format: 'JSONEachRow',
    });
  }

  private extractRecordId(record: any): string {
    return (
      record?.Id ||
      record?.id ||
      record?.TxnId ||
      (record?.DocNumber ? `${record.DocNumber}` : 'unknown')
    );
  }

  private extractUpdatedAt(record: any): string {
    return this.formatDate(
      record?.MetaData?.LastUpdatedTime ||
        record?.LastUpdatedTime ||
        new Date(),
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
    const dbName = this.getQuickBooksDatabase();
    const qualifiedTable = `${dbName}.quickbooks_raw`;
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

  private getQuickBooksDatabase(): string {
    return (
      process.env.CLICKHOUSE_QUICKBOOKS_DB ||
      process.env.CLICKHOUSE_DB ||
      'quickbooks'
    ).trim();
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
  }

  private async createTableSafely(tableName: string, ddl: string) {
    if (this.schemaCreationFailed) return;
    try {
      await this.clickhouse.command({ query: ddl });
    } catch (error: any) {
      if (error?.code === '497' || error?.type === 'ACCESS_DENIED') {
        this.schemaCreationFailed = true;
        this.logger.warn(
          `[QuickBooks] Access denied when creating ${tableName}. Please create it manually with the expected schema.`,
        );
        return;
      }
      throw error;
    }
  }
}
