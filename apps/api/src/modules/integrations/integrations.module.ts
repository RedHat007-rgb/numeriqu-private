import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { OrganizationContextModule } from '../org-context/org-context.module';
import { IntegrationsModule as CoreIntegrationsModule } from '../../integrations/integrations.module';
import { IntegrationsController } from './integrations.controller';

@Module({
  imports: [DatabaseModule, OrganizationContextModule, CoreIntegrationsModule],
  controllers: [IntegrationsController],
})
export class IntegrationsModule {}

