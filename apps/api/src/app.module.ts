import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { SyncModule } from './sync/sync.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { MetricsModule } from './metrics/metrics.module';
import { QuickbooksModule } from './quickbooks/quickbooks.module';
import { HealthModule } from './health/health.module';
import { IntelligenceModule } from './intelligence/intelligence.module';
import { UserProvisioningService } from './common/services/user-provisioning.service';

import { CommonModule } from './common/common.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    CommonModule, // Now provides UserProvisioningService globally
    DatabaseModule,
    SyncModule,
    IntegrationsModule,
    MetricsModule,
    QuickbooksModule,
    HealthModule,
    IntelligenceModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

