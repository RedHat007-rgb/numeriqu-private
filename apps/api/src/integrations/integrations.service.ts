import { Injectable, Logger, Inject } from '@nestjs/common';
import { IntegrationProvider } from './interfaces/integration-provider.interface';
import { QuickBooksProvider } from './providers/quickbooks.provider';
import { XeroProvider } from './providers/xero.provider';
import { WorkdayProvider } from './providers/workday.provider';
import { Dynamics365Provider } from './providers/dynamics365.provider';
import { SyncService, SyncJobConfig } from '../sync/sync.service';
import { PRISMA_TOKEN } from '../database/database.module';
import type { PrismaClient } from '@repo/db';

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  private activeSyncs = new Set<string>();

  constructor(
    private readonly qbProvider: QuickBooksProvider,
    private readonly xeroProvider: XeroProvider,
    private readonly workdayProvider: WorkdayProvider,
    private readonly dynamics365Provider: Dynamics365Provider,
    private readonly syncService: SyncService,
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
  ) {}

  getProvider(providerName: string): IntegrationProvider {
    switch (providerName.toLowerCase()) {
      case 'quickbooks':
        return this.qbProvider;
      case 'xero':
        return this.xeroProvider;
      case 'workday':
        return this.workdayProvider;
      case 'dynamics365':
        return this.dynamics365Provider;
      default:
        throw new Error(
          `Integration provider '${providerName}' is not supported.`,
        );
    }
  }

  async startIntegrationSync(
    tenantId: string,
    userId: string,
    connectionId: string,
    providerStr: string,
    ...providerArgs: any[]
  ) {
    // Advanced: Deterministic Lock Key based on Provider and Account ID if available
    const providerAccountId =
      providerArgs && providerArgs.length > 0 ? providerArgs[0] : null;
    const providerLower = providerStr.toLowerCase();

    let lockKey = connectionId;
    if (
      providerAccountId &&
      (providerLower === 'xero' || providerLower === 'quickbooks')
    ) {
      lockKey = `${providerLower}_org_${providerAccountId}`;
    }

    if (this.activeSyncs.has(lockKey)) {
      this.logger.warn(
        `Synchronization lock active for ${lockKey}. Orchestration deferred to prevent data corruption or credential fragmentation.`,
      );
      return;
    }

    this.activeSyncs.add(lockKey);
    let jobDetails;
    try {
      this.logger.log(
        `Starting sync orchestration for ${providerStr} connection ${connectionId}`,
      );

      const provider = this.getProvider(providerStr);

      // --- Resolve per-org identity from connection metadata ---
      // providerArgs[0] is always the org/account ID (xeroTenantId or QB realmId)
      const orgId: string = providerAccountId || connectionId;
      let orgName: string = orgId; // sensible fallback

      try {
        const conn = await this.prisma.connection.findUnique({
          where: { id: connectionId },
          select: { metadata: true },
        });
        const meta = conn?.metadata as Record<string, any> | null;
        if (meta?.orgName) orgName = meta.orgName as string;
      } catch {
        // Non-fatal — fall back to orgId as name
      }

      // Step 1: Create a Job (now with org identity)
      jobDetails = await this.syncService.createSyncJob({
        tenantId,
        userId,
        connectionId,
        provider: providerStr,
        orgId,
        orgName,
      });

      // Step 2: Trigger Provider Logic
      const recordsProcessed = await provider.triggerSync(
        jobDetails,
        ...providerArgs,
      );

      // Step 3: Job is completed — pass org context for inline transform
      await this.syncService.completeSyncJob(
        jobDetails.syncJobId,
        (recordsProcessed as number) ?? 0,
        orgId,
        tenantId,
        providerStr,
      );
    } catch (error: any) {
      this.logger.error(
        `Error during sync orchestration for ${providerStr}`,
        error,
      );
      if (jobDetails) {
        await this.syncService.failSyncJob(
          jobDetails.syncJobId,
          error?.message ?? 'Unknown error',
        );
      }
    } finally {
      this.activeSyncs.delete(lockKey);
    }
  }
}
