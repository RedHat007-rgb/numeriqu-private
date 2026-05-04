import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { OrganizationContextModule } from '../org-context/org-context.module';
import { RagController } from './rag.controller';
import { RagService } from './rag.service';

@Module({
  imports: [DatabaseModule, OrganizationContextModule],
  controllers: [RagController],
  providers: [RagService],
})
export class RagModule {}

