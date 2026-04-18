import { Module } from '@nestjs/common';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { AgentToolExecutor } from './agent-tool.executor';
import { FinancialDataModule } from '../financial-data/financial-data.module';
import { DatabaseModule } from '../database/database.module';

/**
 * AgentModule — Fully Independent Agent Layer
 *
 * This module functions completely independently of the RAG layer.
 * If RAG is disabled or removed, Agent continues to work.
 *
 * Dependencies:
 *   - FinancialDataModule (shared read-only data)
 *   - DatabaseModule (Prisma for insight persistence)
 *   - CommonModule (auth, provisioning — global)
 */
@Module({
  imports: [FinancialDataModule, DatabaseModule],
  controllers: [AgentController],
  providers: [AgentService, AgentToolExecutor],
  exports: [AgentService],
})
export class AgentModule {}
