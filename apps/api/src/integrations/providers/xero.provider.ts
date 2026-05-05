import { Injectable, Logger, Inject } from '@nestjs/common';
import { XeroClient } from 'xero-node';
import axios from 'axios';
import { IntegrationProvider } from '../interfaces/integration-provider.interface';
import { SyncJobConfig } from '../../sync/sync.service';
import { XeroIngestionService } from './xero-ingestion.service';
import { PRISMA_TOKEN } from '../../database/database.module';
import { PrismaClient } from '@repo/db';
import { CryptoService } from '../../common/crypto.service';

@Injectable()
export class XeroProvider implements IntegrationProvider {
  private readonly logger = new Logger(XeroProvider.name);

  private static activeRefreshes = new Map<
    string,
    Promise<{ accessToken: string }>
  >();

  constructor(
    private readonly xeroIngestion: XeroIngestionService,
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    private readonly crypto: CryptoService,
  ) {}

  async connect(): Promise<void> {
    this.logger.log('Connecting Xero via proper OAuth flow');
  }

  async refreshToken(
    connectionId: string,
    providerAccountId?: string,
  ): Promise<{ accessToken: string }> {
    // If we have providerAccountId, check for an existing job to deduplicate
    const lockKey = providerAccountId || `conn_${connectionId}`;
    if (XeroProvider.activeRefreshes.has(lockKey)) {
      this.logger.log(`Deduplicating parallel Xero refresh for ${lockKey}`);
      return XeroProvider.activeRefreshes.get(lockKey)!;
    }

    const refreshPromise = (async () => {
      try {
        const connection = await this.prisma.erpConnection.findUnique({
          where: { id: connectionId },
        });

        if (!connection || !connection.refreshTokenEncrypted) {
          throw new Error(
            `Cannot refresh Xero token: Connection or Refresh Token missing for ${connectionId}`,
          );
        }

        const effectiveProviderAccountId =
          providerAccountId || connection.externalOrganizationId;
        const decryptedRefreshToken = this.crypto.decrypt(
          connection.refreshTokenEncrypted,
        );

        this.logger.log(
          `Performing atomic Xero token refresh for Org ${effectiveProviderAccountId} via connection ${connectionId}`,
        );

        const authHeader = Buffer.from(
          `${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`,
        ).toString('base64');

        const response = await axios.post(
          'https://identity.xero.com/connect/token',
          new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: decryptedRefreshToken,
          }).toString(),
          {
            headers: {
              Authorization: `Basic ${authHeader}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
          },
        );

        const { access_token, refresh_token } = response.data;

        // Atomic update for ALL connections sharing the same Xero Org ID
        const updateData: any = {
          accessTokenEncrypted: this.crypto.encrypt(access_token),
        };
        if (refresh_token) {
          updateData.refreshTokenEncrypted = this.crypto.encrypt(refresh_token);
        }

        await this.prisma.erpConnection.updateMany({
          where: {
            provider: 'XERO',
            externalOrganizationId: effectiveProviderAccountId,
          },
          data: updateData,
        });

        this.logger.log(
          `Atomic refresh complete for Org ${effectiveProviderAccountId}. Fresh tokens propagated.`,
        );
        return { accessToken: access_token };
      } finally {
        XeroProvider.activeRefreshes.delete(lockKey);
      }
    })();

    XeroProvider.activeRefreshes.set(lockKey, refreshPromise);
    return refreshPromise;
  }

  async triggerSync(
    jobDetails: SyncJobConfig,
    providerAccountId: string,
  ): Promise<number> {
    // 2. Custom SDK Ingestion Flow (Orchestrated natively)
    try {
      // Always refresh before a full sync to ensure validity
      const { accessToken } = await this.refreshToken(
        jobDetails.connectionId,
        providerAccountId,
      );

      this.logger.log(
        `Triggering custom SDK ingestion for Xero (job: ${jobDetails.syncJobId})`,
      );

      const recordsProcessed = await this.xeroIngestion.runSync(
        jobDetails,
        accessToken,
        providerAccountId,
      );
      return recordsProcessed;
    } catch (error: any) {
      const errorMsg =
        error.response?.body?.Message ||
        error.message ||
        'Unknown Xero SDK Error';
      this.logger.error(`[Xero-Custom] Synchronization failed: ${errorMsg}`);
      throw error;
    }
  }
}
