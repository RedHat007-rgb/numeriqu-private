import { Module } from '@nestjs/common';
import { RagController } from './rag.controller';
import { RagService } from './rag.service';
import { RagContextCacheService } from './rag-context-cache.service';
import { FinancialDataModule } from '../financial-data/financial-data.module';
import { OrganizationContextModule } from '../modules/org-context/org-context.module';

@Module({
  imports: [FinancialDataModule, OrganizationContextModule],
  controllers: [RagController],
  providers: [RagService, RagContextCacheService],
  exports: [RagService, RagContextCacheService],
})
export class RagModule {}
