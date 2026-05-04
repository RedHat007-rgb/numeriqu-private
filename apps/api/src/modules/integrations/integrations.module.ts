import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { OrganizationContextModule } from '../org-context/org-context.module';
import { IntegrationsController } from './integrations.controller';

@Module({
  imports: [DatabaseModule, OrganizationContextModule],
  controllers: [IntegrationsController],
})
export class IntegrationsModule {}

