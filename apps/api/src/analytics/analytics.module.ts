import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { InsightsCompatController } from './insights-compat.controller';
import { DatabaseModule } from '../database/database.module';
import { FinancialDataModule } from '../financial-data/financial-data.module';

/**
 * AnalyticsModule — Insights Gallery + Executive Dashboard Data
 *
 * Registers both the new /analytics/* and legacy /insights/* controllers.
 * Imports FinancialDataModule for the dashboard aggregation endpoint.
 */
@Module({
  imports: [DatabaseModule, FinancialDataModule],
  controllers: [AnalyticsController, InsightsCompatController],
})
export class AnalyticsModule {}
