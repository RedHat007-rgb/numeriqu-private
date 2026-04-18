import { Module } from '@nestjs/common';
import { RagController } from './rag.controller';
import { RagService } from './rag.service';
import { RagContextCacheService } from './rag-context-cache.service';
import { FinancialDataModule } from '../financial-data/financial-data.module';

/**
 * RagModule — Fully Independent RAG Layer
 *
 * This module functions completely independently of the Agent layer.
 * If the Agent module is disabled or removed, RAG continues to work.
 *
 * Dependencies:
 *   - FinancialDataModule (shared read-only data)
 *   - CommonModule (auth, provisioning — global)
 *   - DatabaseModule (Prisma, ClickHouse — global)
 */
@Module({
  imports: [FinancialDataModule],
  controllers: [RagController],
  providers: [RagService, RagContextCacheService],
  exports: [RagService, RagContextCacheService],
})
export class RagModule {}
