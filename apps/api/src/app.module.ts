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
import { CommonModule } from './common/common.module';
import { OrgModule } from './org/org.module';

// ── Intelligence Layers (ISOLATED — must not cross-import) ─────────────────
import { FinancialDataModule } from './financial-data/financial-data.module';
import { RagModule } from './rag/rag.module';
import { AgentModule } from './agent/agent.module';
import { AnalyticsModule } from './analytics/analytics.module';

// ── LEGACY: kept for backward compat — remove after frontend migration ───────
import { IntelligenceModule } from './intelligence/intelligence.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    // ── Core Infrastructure ──
    CommonModule,       // Auth, provisioning, audit, permissions (global)
    DatabaseModule,     // Prisma, ClickHouse (global)

    // ── Organization Management ──
    OrgModule,          // /org/* — member lifecycle, invites, permissions

    // ── Financial Data Layer ──
    FinancialDataModule,

    // ── AI Intelligence Layers (COMPLETELY ISOLATED) ──
    RagModule,          // POST /rag/*  — RAG chat system
    AgentModule,        // POST /agent/* — Dashboard generation agent

    // ── Dashboard + Analytics ──
    AnalyticsModule,    // GET /analytics/* — chart data, dashboard data

    // ── Data Pipeline ──
    SyncModule,
    IntegrationsModule,
    MetricsModule,
    QuickbooksModule,
    HealthModule,

    // ── LEGACY (deprecated — kept for frontend backward compat) ──
    IntelligenceModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
