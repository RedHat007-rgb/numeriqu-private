import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';

/**
 * @Roles('admin') — restrict endpoint to admin users only.
 * Use with RolesGuard after SupabaseAuthGuard.
 *
 * @example
 *   @Roles('admin')
 *   @UseGuards(SupabaseAuthGuard, RolesGuard)
 *   @Post('org/invite')
 *   inviteMember(...) {}
 */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
