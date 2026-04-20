import { Module } from '@nestjs/common';
import { IntelligenceController } from './intelligence.controller';
import { InsightsController } from './insights.controller';
import { IntelligenceService } from './intelligence.service';
import { FinancialDataService } from './financial-data.service';
import { ContextCacheService } from './context-cache.service';
import { AgentToolsService } from './agent-tools.service';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [DatabaseModule],
  controllers: [IntelligenceController, InsightsController],
  providers: [
    IntelligenceService,
    FinancialDataService,
    ContextCacheService,
    AgentToolsService,
  ],
  exports: [IntelligenceService, ContextCacheService],
})
export class IntelligenceModule {}
