import { Module } from '@nestjs/common';
import { FinancialDataService } from './financial-data.service';
import { DatabaseModule } from '../database/database.module';

/**
 * FinancialDataModule — Shared Read-Only Data Layer
 *
 * This module owns all ClickHouse + Prisma queries that produce financial metrics.
 * Both RAG and Agent modules import this module but NEVER modify each other's state.
 *
 * DESIGN INVARIANT: This module exposes ONLY read-only services.
 * Write operations (sync, transform) remain in the SyncModule.
 */
@Module({
  imports: [DatabaseModule],
  providers: [FinancialDataService],
  exports: [FinancialDataService],
})
export class FinancialDataModule {}
