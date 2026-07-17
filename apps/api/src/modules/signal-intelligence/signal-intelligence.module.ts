import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { OrganizationContextModule } from '../org-context/org-context.module';
import { FinancialDataModule } from '../../financial-data/financial-data.module';
import { SignalIntelligenceController } from './signal-intelligence.controller';
import { SignalIntelligenceService } from './signal-intelligence.service';

@Module({
  imports: [DatabaseModule, OrganizationContextModule, FinancialDataModule],
  controllers: [SignalIntelligenceController],
  providers: [SignalIntelligenceService],
  exports: [SignalIntelligenceService],
})
export class SignalIntelligenceModule {}
