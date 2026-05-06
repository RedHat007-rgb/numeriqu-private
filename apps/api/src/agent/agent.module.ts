import { Module } from '@nestjs/common';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { AgentToolExecutor } from './agent-tool.executor';
import { FinancialDataModule } from '../financial-data/financial-data.module';
import { DatabaseModule } from '../database/database.module';
import { OrganizationContextModule } from '../modules/org-context/org-context.module';

@Module({
  imports: [FinancialDataModule, DatabaseModule, OrganizationContextModule],
  controllers: [AgentController],
  providers: [AgentService, AgentToolExecutor],
  exports: [AgentService],
})
export class AgentModule {}
