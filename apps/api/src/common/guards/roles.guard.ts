import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { AuthUser } from '../decorators/user.decorator';

/**
 * RolesGuard — Admin-only endpoint enforcement.
 *
 * Usage:
 *   @Roles('admin')
 *   @UseGuards(SupabaseAuthGuard, RolesGuard)
 *   @Post('dashboards')
 *   createDashboard(...) {}
 *
 * Must be used AFTER SupabaseAuthGuard (which populates request.user).
 * If no @Roles() decorator is present, the guard passes through.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No @Roles() decorator — route is open to all authenticated users
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const request = context.switchToHttp().getRequest();
    const user: AuthUser = request.user;

    if (!user) {
      throw new ForbiddenException('Authentication required.');
    }

    const hasRole = requiredRoles.includes(user.role);

    if (!hasRole) {
      throw new ForbiddenException(
        'You do not have permission to perform this action. Admin access required.',
      );
    }

    return true;
  }
}
