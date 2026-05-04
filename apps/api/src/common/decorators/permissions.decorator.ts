import { SetMetadata } from '@nestjs/common';
import type { UserPermissions } from './user.decorator';

export const PERMISSION_KEY = 'permission';

/**
 * @RequirePermission('canCreateDashboard') — restrict endpoint to users with the named permission.
 * Admins always pass. Members are checked against their UserPermission record.
 * Use with PermissionsGuard after SupabaseAuthGuard.
 *
 * @example
 *   @RequirePermission('canUseAgent')
 *   @UseGuards(SupabaseAuthGuard, PermissionsGuard)
 *   @Post('agent/query')
 *   runAgent(...) {}
 */
export const RequirePermission = (permission: keyof UserPermissions) =>
  SetMetadata(PERMISSION_KEY, permission);
