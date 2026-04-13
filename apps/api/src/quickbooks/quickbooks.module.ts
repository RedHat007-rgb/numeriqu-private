import { Module } from '@nestjs/common';
import { QuickbooksIngestionService } from './quickbooks.ingestion.service';

@Module({
  providers: [QuickbooksIngestionService],
  exports: [QuickbooksIngestionService],
})
export class QuickbooksModule {}
