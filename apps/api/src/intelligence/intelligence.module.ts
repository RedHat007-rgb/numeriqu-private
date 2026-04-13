import { Module } from '@nestjs/common';
import { IntelligenceController } from './intelligence.controller';
import { IntelligenceService } from './intelligence.service';
import { FinancialDataService } from './financial-data.service';
import { ContextCacheService } from './context-cache.service';

@Module({
  controllers: [IntelligenceController],
  providers: [IntelligenceService, FinancialDataService, ContextCacheService],
  exports: [IntelligenceService, ContextCacheService],
})
export class IntelligenceModule {}
