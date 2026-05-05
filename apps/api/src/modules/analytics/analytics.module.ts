import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { OrganizationContextModule } from '../org-context/org-context.module';
import { FinancialDataModule } from '../../financial-data/financial-data.module';
import { AnalyticsController } from './analytics.controller';

@Module({
  imports: [DatabaseModule, OrganizationContextModule, FinancialDataModule],
  controllers: [AnalyticsController],
})
export class AnalyticsModule {}

