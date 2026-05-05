import { Module } from '@nestjs/common';
import { IntegrationsService } from './integrations.service';
import { QuickBooksProvider } from './providers/quickbooks.provider';
import { XeroProvider } from './providers/xero.provider';
import { WorkdayProvider } from './providers/workday.provider';
import { Dynamics365Provider } from './providers/dynamics365.provider';
import { XeroIngestionService } from './providers/xero-ingestion.service';
import { QuickbooksModule } from '../quickbooks/quickbooks.module';
import { SyncModule } from '../sync/sync.module';
import { AuthController } from './auth.controller';
import { ConnectionsController } from './connections.controller';
import { CryptoService } from '../common/crypto.service';
import { OrganizationContextModule } from '../modules/org-context/org-context.module';

@Module({
  imports: [QuickbooksModule, SyncModule, OrganizationContextModule],
  controllers: [AuthController, ConnectionsController],
  providers: [
    IntegrationsService,
    QuickBooksProvider,
    XeroProvider,
    WorkdayProvider,
    Dynamics365Provider,
    XeroIngestionService,
    CryptoService,
  ],
  exports: [IntegrationsService, XeroIngestionService, CryptoService],
})
export class IntegrationsModule {}
