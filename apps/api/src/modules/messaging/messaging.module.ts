import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { OrganizationContextModule } from '../org-context/org-context.module';
import { MessagingController } from './messaging.controller';
import { MessagingService } from './messaging.service';

@Module({
  imports: [DatabaseModule, OrganizationContextModule],
  controllers: [MessagingController],
  providers: [MessagingService],
})
export class MessagingModule {}

