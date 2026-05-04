import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSION_KEY } from '../decorators/permissions.decorator';
import type { AuthUser, UserPermissions } from '../decorators/user.decorator';

/**
 * PermissionsGuard — Granular permission enforcement for member users.
 *
 * Admins always pass (their permissions field is null, meaning full access).
 * Members are checked against their UserPermission record.
 *
 * Usage:
 *   @RequirePermission('canCreateDashboard')
 *   @UseGuards(SupabaseAuthGuard, PermissionsGuard)
 *   @Post('dashboards')
 *   createDashboard(...) {}
 *
 * Must be used AFTER SupabaseAuthGuard.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPermission = this.reflector.getAllAndOverride<keyof UserPermissions>(
      PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No @RequirePermission() decorator — no permission check needed
    if (!requiredPermission) return true;

    const request = context.switchToHttp().getRequest();
    const user: AuthUser = request.user;

    if (!user) {
      throw new ForbiddenException('Authentication required.');
    }

    // Admins always pass — null permissions = full access
    if (user.role === 'admin' || user.permissions === null) {
      return true;
    }

    // Check the specific permission flag for this member
    const hasPermission = user.permissions[requiredPermission] === true;

    if (!hasPermission) {
      throw new ForbiddenException(
        `You do not have permission to perform this action. ` +
          `Contact your organization admin to request access.`,
      );
    }

    return true;
  }
}
