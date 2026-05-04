import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { OrganizationContextModule } from '../org-context/org-context.module';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

@Module({
  imports: [DatabaseModule, OrganizationContextModule],
  controllers: [AuditController],
  providers: [AuditService],
})
export class AuditModule {}
