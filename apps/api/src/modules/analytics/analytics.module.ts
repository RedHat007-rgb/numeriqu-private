import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { OrganizationContextModule } from '../org-context/org-context.module';
import { AnalyticsController } from './analytics.controller';

@Module({
  imports: [DatabaseModule, OrganizationContextModule],
  controllers: [AnalyticsController],
})
export class AnalyticsModule {}

