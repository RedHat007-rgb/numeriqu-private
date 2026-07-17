import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { OrganizationContextModule } from './modules/org-context/org-context.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { IntegrationsModule as CoreIntegrationsModule } from './integrations/integrations.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { RagModule } from './modules/rag/rag.module';
import { AgentModule } from './modules/agent/agent.module';
import { OrganizationModule } from './modules/organization/organization.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { MessagingModule } from './modules/messaging/messaging.module';
import { AuditModule } from './modules/audit/audit.module';
import { SignalIntelligenceModule } from './modules/signal-intelligence/signal-intelligence.module';
import { ChartEngineModule } from './modules/chart-engine/chart-engine.module';
import { HealthModule } from './health/health.module';
import { OrgModule } from './org/org.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    OrganizationContextModule,
    AuthModule,
    IntegrationsModule,
    CoreIntegrationsModule,
    AnalyticsModule,
    OrganizationModule,
    DashboardModule,
    MessagingModule,
    AuditModule,
    SignalIntelligenceModule,
    ChartEngineModule,
    RagModule,
    AgentModule,
    HealthModule,
    OrgModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
