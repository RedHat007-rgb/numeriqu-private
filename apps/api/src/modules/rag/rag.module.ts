import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { OrganizationContextModule } from '../org-context/org-context.module';
import { ChartEngineModule } from '../chart-engine/chart-engine.module';
import { RagController } from './rag.controller';
import { RagService } from './rag.service';
import { PrismModelGateway } from './prism-model.gateway';
import { PrismRuntimeService } from './prism-runtime.service';
import { PrismWorkloadService } from './prism-workload.service';
import { PrismJobsService } from './prism-jobs.service';
import { PrismJobsController } from './prism-jobs.controller';
import { PrismBriefingWorker } from './prism-briefing.worker';
import { PrismProactiveService } from './prism-proactive.service';
import { PrismProactiveController } from './prism-proactive.controller';
import { PrismScenarioService } from './prism-scenario.service';
import { PrismActionService } from './prism-action.service';
import { PrismDecisionController } from './prism-decision.controller';

@Module({
  imports: [DatabaseModule, OrganizationContextModule, ChartEngineModule],
  controllers: [
    RagController,
    PrismJobsController,
    PrismProactiveController,
    PrismDecisionController,
  ],
  providers: [
    RagService,
    PrismModelGateway,
    PrismRuntimeService,
    PrismWorkloadService,
    PrismJobsService,
    PrismBriefingWorker,
    PrismProactiveService,
    PrismScenarioService,
    PrismActionService,
  ],
  exports: [PrismJobsService, PrismBriefingWorker],
})
export class RagModule {}
