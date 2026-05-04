import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { OrganizationContextModule } from '../org-context/org-context.module';
import { OrganizationController } from './organization.controller';
import { OrganizationService } from './organization.service';

@Module({
  imports: [DatabaseModule, OrganizationContextModule],
  controllers: [OrganizationController],
  providers: [OrganizationService],
})
export class OrganizationModule {}

