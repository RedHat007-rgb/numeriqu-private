import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { OrganizationContextModule } from './modules/org-context/org-context.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { RagModule } from './modules/rag/rag.module';
import { AgentModule } from './modules/agent/agent.module';
import { OrganizationModule } from './modules/organization/organization.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { MessagingModule } from './modules/messaging/messaging.module';
import { AuditModule } from './modules/audit/audit.module';
import { HealthModule } from './health/health.module';
<<<<<<< HEAD
import { CommonModule } from './common/common.module';

// ── NEW ARCHITECTURE: Separated Layers ──────────────────────────────────────
import { FinancialDataModule } from './financial-data/financial-data.module';
import { RagModule } from './rag/rag.module';
import { AgentModule } from './agent/agent.module';
import { AnalyticsModule } from './analytics/analytics.module';

// ── LEGACY: Kept for backward compat — will be removed after frontend migration
import { IntelligenceModule } from './intelligence/intelligence.module';
import { OrgModule } from './org/org.module';
=======
>>>>>>> eaaa37d75d30a98bb3c86fa7be02d7a7e7e7c104

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
<<<<<<< HEAD
    CommonModule, // Auth, provisioning (global)
    DatabaseModule, // Prisma, ClickHouse (global)

    // ── Shared Data Layer ──
    FinancialDataModule,

    // ── Independent Intelligence Layers ──
    RagModule, // POST /rag/query — RAG advisor (INDEPENDENT)
    AgentModule, // POST /agent/query — Strategic agent (INDEPENDENT)
    AnalyticsModule, // GET /analytics/insights — Chart gallery

    // ── Organization & Membership ──
    OrgModule,

    // ── Data Pipeline ──
    SyncModule,
=======
    DatabaseModule,
    OrganizationContextModule,
    AuthModule,
>>>>>>> eaaa37d75d30a98bb3c86fa7be02d7a7e7e7c104
    IntegrationsModule,
    AnalyticsModule,
    OrganizationModule,
    DashboardModule,
    MessagingModule,
    AuditModule,
    RagModule,
    AgentModule,
    HealthModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
