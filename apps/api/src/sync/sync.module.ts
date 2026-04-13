import { Module } from '@nestjs/common';
import { SyncService } from './sync.service';
import { InlineTransformService } from './inline-transform.service';

@Module({
  providers: [SyncService, InlineTransformService],
  exports: [SyncService, InlineTransformService],
})
export class SyncModule {}
