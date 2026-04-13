import { SyncJobConfig } from '../../sync/sync.service';

export interface IntegrationProvider {
  connect(): Promise<void>;
  refreshToken(connectionId: string): Promise<any>;
  triggerSync(
    jobDetails: SyncJobConfig,
    ...extraArgs: any[]
  ): Promise<number | void>;
}
