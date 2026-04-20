import { Injectable, Logger, Inject } from '@nestjs/common';
import { IntegrationProvider } from '../interfaces/integration-provider.interface';
import { SyncJobConfig } from '../../sync/sync.service';
import {
  QuickbooksIngestionService,
  QuickBooksAuthError,
} from '../../quickbooks/quickbooks.ingestion.service';
import { createQuickBooksClient } from '../../quickbooks/quickbooks.client';
import { PRISMA_TOKEN } from '../../database/database.module';
import { PrismaClient } from '@repo/db';
import { CryptoService } from '../../common/crypto.service';

@Injectable()
export class QuickBooksProvider implements IntegrationProvider {
  private readonly logger = new Logger(QuickBooksProvider.name);

  constructor(
    private readonly qbIngestion: QuickbooksIngestionService,
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly crypto: CryptoService,
  ) {}

  connect(): Promise<void> {
    this.logger.log('Starting Quickbooks OAuth 2.0 flow...');
    return Promise.resolve();
  }

  refreshToken(connectionId: string): Promise<void> {
    this.logger.log(
      `Refreshing Quickbooks token for connection ${connectionId}`,
    );
    return Promise.resolve();
  }

  async triggerSync(
    jobDetails: SyncJobConfig,
    ...extraArgs: any[]
  ): Promise<number> {
    const realmId = extraArgs[0];
    const internalTenantId = jobDetails.tenantId;

    const connection = await this.prisma.connection.findUnique({
      where: { id: jobDetails.connectionId },
    });

    if (!connection) throw new Error('QuickBooks connection not found in DB');

    // Robustly handle encrypted metadata
    let metadata: any = {};
    if (connection.metadata) {
      metadata =
        typeof connection.metadata === 'string'
          ? this.crypto.decryptJson(connection.metadata)
          : connection.metadata;
    }

    // Native custom ingestion flow: Proactive Refresh ensures zero 401s during the loop
    let accessToken = connection.accessToken
      ? this.crypto.decrypt(connection.accessToken)
      : extraArgs[1];
    let refreshToken = connection.refreshToken
      ? this.crypto.decrypt(connection.refreshToken)
      : extraArgs[2];

    this.logger.log(
      `Performing proactive credential rotation for QuickBooks ID: ${realmId}`,
    );
    const refreshed = await this.refreshConnectionTokens(
      jobDetails.connectionId,
      realmId,
      accessToken,
      refreshToken,
    );
    if (refreshed) {
      accessToken = refreshed.accessToken;
      refreshToken = refreshed.refreshToken;
    }

    this.logger.log(
      `Triggering high-integrity native ingestion for QuickBooks (Job: ${jobDetails.syncJobId})`,
    );
    return await this.qbIngestion.runIncrementalSync(
      jobDetails,
      accessToken,
      refreshToken,
      realmId,
    );
  }

  private async refreshConnectionTokens(
    connectionId: string,
    realmId: string,
    accessToken: string,
    refreshToken?: string,
  ): Promise<{ accessToken: string; refreshToken: string } | null> {
    if (!refreshToken) return null;

    const qbClient = createQuickBooksClient({
      consumerKey: process.env.QB_CLIENT_ID || '',
      consumerSecret: process.env.QB_CLIENT_SECRET || '',
      accessToken,
      realmId,
      refreshToken,
      useSandbox: process.env.QB_ENVIRONMENT !== 'production',
      oauthVersion: '2.0',
      minorVersion: '75',
    });

    try {
      const refreshed = await new Promise<{
        accessToken: string;
        refreshToken: string;
      }>((resolve, reject) => {
        qbClient.refreshAccessToken((err) => {
          if (err) return reject(err);
          const token = qbClient.token;
          const rToken = qbClient.refreshToken;
          if (!token || !rToken)
            return reject(new Error('Empty tokens after refresh'));
          resolve({ accessToken: token, refreshToken: rToken });
        });
      });

      // Securely store the newly rotated tokens (encrypted)
      await this.prisma.connection.update({
        where: { id: connectionId },
        data: {
          accessToken: this.crypto.encrypt(refreshed.accessToken),
          refreshToken: this.crypto.encrypt(refreshed.refreshToken),
        },
      });

      return refreshed;
    } catch (refreshError: any) {
      this.logger.error(
        'Failed to refresh QuickBooks token',
        refreshError?.message,
      );
      return null;
    }
  }
}
