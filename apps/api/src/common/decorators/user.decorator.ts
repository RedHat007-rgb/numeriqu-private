import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * @CurrentUser() decorator — extracts the authenticated user from the request.
 *
 * Usage:
 *   @Get('profile')
 *   @UseGuards(SupabaseAuthGuard)
 *   getProfile(@CurrentUser() user: AuthUser) { ... }
 */
export const CurrentUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);

export interface AuthUser {
  id: string;
  email: string;
  metadata: Record<string, any>;
}
