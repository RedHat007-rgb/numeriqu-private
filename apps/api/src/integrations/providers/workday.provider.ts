import { Injectable, Logger, Inject } from '@nestjs/common';
import { IntegrationProvider } from '../interfaces/integration-provider.interface';
import { SyncJobConfig } from '../../sync/sync.service';
import { CLICKHOUSE_TOKEN, PRISMA_TOKEN } from '../../database/database.module';
import { CryptoService } from '../../common/crypto.service';
import { ClickHouseClient } from '@clickhouse/client';
import type { PrismaClient } from '@repo/db';

@Injectable()
export class WorkdayProvider implements IntegrationProvider {
  private readonly logger = new Logger(WorkdayProvider.name);

  constructor(
    @Inject(CLICKHOUSE_TOKEN) private readonly clickhouse: ClickHouseClient,
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly crypto: CryptoService,
  ) {}

  async connect(): Promise<void> {
    // Standard OAuth2 connect flow initiation for Workday
    this.logger.log('Initiating Workday OAuth2 handshake...');
  }

  async refreshToken(connectionId: string): Promise<void> {
    this.logger.log(`Rotating Workday tokens for connection ${connectionId}`);
    // Logic for refreshing non-expiring/expiring ISU tokens
  }

  async triggerSync(
    jobDetails: SyncJobConfig,
    connectionId: string,
  ): Promise<number | void> {
    this.logger.log(
      `[Workday] Starting WQL extraction job: ${jobDetails.syncJobId}`,
    );

    const connection = await this.prisma.connection.findUnique({
      where: { id: connectionId },
    });

    if (!connection || !connection.refreshToken) {
      throw new Error(
        `Workday connection ${connectionId} is missing valid credentials.`,
      );
    }

    try {
      const decryptedRefreshToken = this.crypto.decrypt(
        connection.refreshToken,
      );
      const accessToken = await this.getAccessToken(decryptedRefreshToken);

      let host: string;
      let workdayTenantId: string;

      if (connection.metadata && typeof connection.metadata === 'string') {
        // Decrypt metadata if stored as encrypted string
        const meta = this.crypto.decryptJson(connection.metadata);
        host = meta.host;
        workdayTenantId = connection.providerAccountId;
      } else {
        host = process.env.WORKDAY_HOST!;
        workdayTenantId = process.env.WORKDAY_TENANT_ID!;
      }

      // Production extraction of core Worker and Journal data via WQL
      const queries = {
        workers:
          'SELECT workerID, legalName, workEmail, positionTitle FROM workers',
        journals:
          'SELECT journalEntryID, company, ledger, totalAmount FROM journalEntries',
        purchaseOrders:
          'SELECT purchaseOrderID, documentDate, totalAmount FROM purchaseOrders',
      };

      let totalRecords = 0;

      for (const [entity, query] of Object.entries(queries)) {
        this.logger.log(`[Workday] Extracting ${entity} via WQL...`);
        const data = await this.executeWQL(
          host!,
          workdayTenantId!,
          accessToken,
          query,
        );

        // Stream to ClickHouse raw tables
        await this.streamToClickHouse(connection.tenantId, entity, data);
        totalRecords += data.length;
      }

      this.logger.log(
        `[Workday] Successfully ingested ${totalRecords} records.`,
      );
      return totalRecords;
    } catch (e: any) {
      this.logger.error(`Workday sync failed: ${e.message}`, e.stack);
      throw e;
    }
  }

  private async getAccessToken(refreshToken: string): Promise<string> {
    const host = process.env.WORKDAY_HOST;
    const tenantId = process.env.WORKDAY_TENANT_ID;

    const res = await fetch(`https://${host}/ccx/oauth2/token/${tenantId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: process.env.WORKDAY_CLIENT_ID!,
        client_secret: process.env.WORKDAY_CLIENT_SECRET!,
        refresh_token: refreshToken,
      }),
    });

    if (!res.ok) throw new Error(`Workday Auth Failed: ${await res.text()}`);
    const data = await res.json();
    return data.access_token;
  }

  private async executeWQL(
    host: string,
    tenantId: string,
    token: string,
    query: string,
  ): Promise<any[]> {
    const res = await fetch(`https://${host}/ccx/api/wql/v1/${tenantId}/data`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    });

    if (!res.ok) throw new Error(`WQL Query Failed: ${await res.text()}`);
    const data = await res.json();
    return data.data || [];
  }

  private async streamToClickHouse(
    internalTenantId: string,
    entity: string,
    records: any[],
  ) {
    // In a production environment, this would use a streaming batch writer
    // Here we leverage the DatabaseService clickhouse client
    const tableName = `tenant_${internalTenantId.replace(/-/g, '_')}_workday_${entity}`;

    // Auto-create table if missing (Simple schema inference for prototype)
    if (records.length > 0) {
      const keys = Object.keys(records[0]);
      const columns = keys.map((k) => `\`${k}\` String`).join(', ');

      await this.clickhouse.exec({
        query: `CREATE TABLE IF NOT EXISTS workday.${tableName} (${columns}) ENGINE = MergeTree() ORDER BY tuple()`,
      });

      await this.clickhouse.insert({
        table: `workday.${tableName}`,
        values: records,
        format: 'JSONEachRow',
      });
    }
  }
}
