import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface UserPermissions {
  canCreateDashboard: boolean;
  canShareDashboard: boolean;
  canQueryRag: boolean;
  canUseAgent: boolean;
}

/**
 * The full auth context attached to every request by SupabaseAuthGuard.
 * All controllers should type their @CurrentUser() parameter as AuthUser.
 */
export interface AuthUser {
  id: string;
  email: string;
  name?: string | null;
  tenantId: string | null;
  role: 'admin' | 'member';
  /**
   * null for admins (full access implied).
   * Populated for members from the user_permissions table.
   */
  permissions: UserPermissions | null;
}

/**
 * @CurrentUser() decorator — extracts the authenticated user from the request.
 *
 * Usage:
 *   @Get('profile')
 *   @UseGuards(SupabaseAuthGuard)
 *   getProfile(@CurrentUser() user: AuthUser) { ... }
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
