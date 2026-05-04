import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { DatabaseModule } from '../database/database.module';
import { FinancialDataModule } from '../financial-data/financial-data.module';

/**
 * AnalyticsModule — Dashboard CRUD + Financial Data Endpoints
 *
 * Provides:
 *   GET  /analytics/dashboards       — list dashboards (role-aware)
 *   GET  /analytics/dashboards/:id   — get one dashboard
 *   POST /analytics/dashboards       — create dashboard
 *   PATCH /analytics/dashboards/:id  — update/publish dashboard
 *   DELETE /analytics/dashboards/:id — delete dashboard
 *   POST /analytics/dashboards/:id/share — share with member
 *   GET  /analytics/insights         — legacy compat (returns dashboards)
 *   GET  /analytics/dashboard        — KPI + chart data
 *   GET  /analytics/trend            — monthly trend
 *   GET  /analytics/invoices         — invoice list
 *
 * NOTE: InsightsCompatController removed — functionality merged into AnalyticsController.
 */
@Module({
  imports: [DatabaseModule, FinancialDataModule],
  controllers: [AnalyticsController],
})
export class AnalyticsModule {}
