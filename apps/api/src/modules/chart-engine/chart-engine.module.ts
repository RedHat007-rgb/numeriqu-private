import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { OrganizationContextModule } from '../org-context/org-context.module';
import { ChartEngineController } from './chart-engine.controller';
import { ChartEngineService } from './chart-engine.service';

/**
 * Autonomous Chart Engine module. Registered in AppModule but INERT until an org
 * is enabled via CHART_ENGINE_NEW_ORGS (see engine-router.ts). Introspection is
 * admin-triggered; nothing here changes existing chart behaviour.
 */
@Module({
  imports: [DatabaseModule, OrganizationContextModule],
  controllers: [ChartEngineController],
  providers: [ChartEngineService],
  exports: [ChartEngineService],
})
export class ChartEngineModule {}
