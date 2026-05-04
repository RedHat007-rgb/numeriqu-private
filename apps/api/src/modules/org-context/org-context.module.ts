import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { OrganizationContextService } from './org-context.service';

@Module({
  imports: [DatabaseModule],
  providers: [OrganizationContextService],
  exports: [OrganizationContextService],
})
export class OrganizationContextModule {}

