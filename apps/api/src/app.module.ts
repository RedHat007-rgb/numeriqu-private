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

// ── NEW ARCHITECTURE: Separated Layers ──────────────────────────────────────
import { FinancialDataModule } from './financial-data/financial-data.module';
import { RagModule } from './rag/rag.module';
import { AgentModule } from './agent/agent.module';
import { AnalyticsModule } from './analytics/analytics.module';

// ── LEGACY: Kept for backward compat — will be removed after frontend migration
import { IntelligenceModule } from './intelligence/intelligence.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    CommonModule,      // Auth, provisioning (global)
    DatabaseModule,     // Prisma, ClickHouse (global)

    // ── Shared Data Layer ──
    FinancialDataModule,

    // ── Independent Intelligence Layers ──
    RagModule,          // POST /rag/query — RAG advisor (INDEPENDENT)
    AgentModule,        // POST /agent/query — Strategic agent (INDEPENDENT)
    AnalyticsModule,    // GET /analytics/insights — Chart gallery

    // ── Data Pipeline ──
    SyncModule,
    IntegrationsModule,
    MetricsModule,
    QuickbooksModule,
    HealthModule,

    // ── LEGACY (deprecated — kept for backward compatibility) ──
    // The old /ai/query endpoint still works but routes to the new services.
    // Remove after frontend fully migrates to /rag/query and /agent/query.
    IntelligenceModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
