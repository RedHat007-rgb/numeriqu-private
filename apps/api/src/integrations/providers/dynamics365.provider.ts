import { Injectable, Logger, Inject } from '@nestjs/common';
import { IntegrationProvider } from '../interfaces/integration-provider.interface';
import { SyncJobConfig } from '../../sync/sync.service';
import { CLICKHOUSE_TOKEN, PRISMA_TOKEN } from '../../database/database.module';
import { CryptoService } from '../../common/crypto.service';
import { ClickHouseClient } from '@clickhouse/client';
import type { PrismaClient } from '@repo/db';
import axios from 'axios';

@Injectable()
export class Dynamics365Provider implements IntegrationProvider {
  private readonly logger = new Logger(Dynamics365Provider.name);

  constructor(
    @Inject(CLICKHOUSE_TOKEN) private readonly clickhouse: ClickHouseClient,
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly crypto: CryptoService,
  ) {}

  async connect(): Promise<void> {
    this.logger.log('Dynamics 365 BC connection setup initiated.');
  }

  async refreshToken(connectionId: string): Promise<void> {
    // Client Credentials flow manages tokens at runtime, no manual refresh needed in DB
    this.logger.log(
      `Dynamics 365 BC uses Client Credentials for connection ${connectionId}`,
    );
  }

  async triggerSync(
    jobDetails: SyncJobConfig,
    ...extraArgs: any[]
  ): Promise<void> {
    const connectionId = jobDetails.connectionId;
    const connection = await this.prisma.connection.findUnique({
      where: { id: connectionId },
    });

    if (!connection || !connection.refreshToken) {
      throw new Error(
        `Dynamics 365 connection ${connectionId} is missing Client Secret / Credentials.`,
      );
    }

    try {
      // 1. Get Decrypted Credentials
      const clientSecret = this.crypto.decrypt(connection.refreshToken);
      const metadata =
        typeof connection.metadata === 'string'
          ? this.crypto.decryptJson(connection.metadata)
          : (connection.metadata as any);

      const { tenantId, clientId, environment, companyId } = metadata;
      const accessToken = await this.getAccessToken(
        tenantId,
        clientId,
        clientSecret,
      );

      // 2. Define High-Value Financial Entities for D365BC
      const endpoints = [
        'accounts',
        'customers',
        'vendors',
        'salesInvoices',
        'purchaseInvoices',
        'bankAccounts',
        'generalLedgerEntries', // Note: Some environments may require custom API for this
      ];

      for (const entity of endpoints) {
        this.logger.log(
          `[D365BC] Ingesting ${entity} for company ${companyId}...`,
        );
        const data = await this.fetchFullCollection(
          tenantId,
          environment,
          companyId,
          entity,
          accessToken,
        );

        // 3. Robust Medallion Streaming to ClickHouse
        await this.streamToClickHouse(connection.tenantId, entity, data);
      }
    } catch (error: any) {
      this.logger.error(`Dynamics 365 Sync Failed: ${error.message}`);
      throw error;
    }
  }

  private async getAccessToken(
    tenantId: string,
    clientId: string,
    clientSecret: string,
  ): Promise<string> {
    const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
    const payload = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
      scope: 'https://api.businesscentral.dynamics.com/.default',
    });

    const res = await axios.post(tokenUrl, payload.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    return res.data.access_token;
  }

  private async fetchFullCollection(
    tenantId: string,
    environment: string,
    companyId: string,
    entity: string,
    token: string,
  ): Promise<any[]> {
    let allRecords: any[] = [];
    let nextUrl = `https://api.businesscentral.dynamics.com/v2.0/${tenantId}/${environment}/api/v2.0/companies(${companyId})/${entity}`;

    while (nextUrl) {
      const res = await axios.get(nextUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
      allRecords = allRecords.concat(res.data.value);
      nextUrl = res.data['@odata.nextLink'] || null;
    }

    return allRecords;
  }

  private async streamToClickHouse(
    internalTenantId: string,
    entity: string,
    data: any[],
  ) {
    if (data.length === 0) return;

    const tableName = `dynamics_raw.tenant_${internalTenantId.replace(/-/g, '_')}_${entity.toLowerCase()}`;

    // Create DB if not exists
    await this.clickhouse.command({
      query: `CREATE DATABASE IF NOT EXISTS dynamics_raw`,
    });

    // Dynamic Schema Creation (Production-grade flexibility)
    const firstRow = data[0];
    const columns = Object.keys(firstRow)
      .map((k) => `\`${k}\` String`)
      .join(', ');

    await this.clickhouse.command({
      query: `CREATE TABLE IF NOT EXISTS ${tableName} (${columns}, _ingested_at DateTime DEFAULT now()) ENGINE = MergeTree() ORDER BY _ingested_at`,
    });

    // Batch Insert (High performance)
    await this.clickhouse.insert({
      table: tableName,
      values: data.map((row) => {
        const sanitized: any = {};
        for (const [k, v] of Object.entries(row)) {
          sanitized[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
        }
        return sanitized;
      }),
      format: 'JSONEachRow',
    });

    this.logger.log(
      `[D365BC] Successfully ingested ${data.length} records into ${tableName}`,
    );
  }
}
