import { Module } from '@nestjs/common';
import { OrgController } from './org.controller';
import { OrgService } from './org.service';

/**
 * OrgModule — Organization lifecycle management.
 *
 * Depends on CommonModule (global) which provides:
 *   - AuditLogService
 *   - UserPermissionsService
 *
 * Routes provided:
 *   GET    /org/members
 *   DELETE /org/members/:userId
 *   POST   /org/invite
 *   GET    /org/invites
 *   DELETE /org/invites/:inviteId
 *   POST   /org/invite/accept
 *   GET    /org/members/:userId/permissions
 *   PATCH  /org/members/:userId/permissions
 *   POST   /org/members/:userId/connections/:connectionId
 *   DELETE /org/members/:userId/connections/:connectionId
 *   GET    /org/audit
 */
@Module({
  controllers: [OrgController],
  providers: [OrgService],
  exports: [OrgService],
})
export class OrgModule {}
