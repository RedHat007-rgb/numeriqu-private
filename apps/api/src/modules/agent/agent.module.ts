import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { OrganizationContextModule } from '../org-context/org-context.module';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';

@Module({
  imports: [DatabaseModule, OrganizationContextModule],
  controllers: [AgentController],
  providers: [AgentService],
})
export class AgentModule {}

