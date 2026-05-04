import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * SupabaseAuthGuard — Production JWT Validation
 *
 * Validates the Bearer token against Supabase Auth.
 * Attaches the authenticated user to the request object.
 *
 * Usage: @UseGuards(SupabaseAuthGuard) on controllers/routes
 */
@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  private readonly logger = new Logger(SupabaseAuthGuard.name);
  private readonly supabase: SupabaseClient;

  constructor() {
    this.supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_KEY!,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      },
    );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers['authorization'];
    const tokenFromHeader =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.replace('Bearer ', '')
        : null;
    const token = tokenFromHeader ?? this.readCookieToken(request.headers?.cookie);

    if (!token) {
      throw new UnauthorizedException('Authentication token is missing');
    }

    try {
      const {
        data: { user },
        error,
      } = await this.supabase.auth.getUser(token);

      if (error || !user) {
        this.logger.warn(`[Auth] Token validation failed: ${error?.message}`);
        throw new UnauthorizedException('Invalid or expired token');
      }

      // Attach user to request for downstream use
      request.user = {
        id: user.id,
        email: user.email,
        metadata: user.user_metadata,
      };

      return true;
    } catch (e: any) {
      if (e instanceof UnauthorizedException) throw e;
      this.logger.error(`[Auth] Unexpected error: ${e.message}`);
      throw new UnauthorizedException('Authentication failed');
    }
  }

  private readCookieToken(cookieHeader?: string): string | null {
    if (!cookieHeader) return null;
    const parts = cookieHeader.split(';');
    for (const part of parts) {
      const [rawKey, ...rawValueParts] = part.split('=');
      if (!rawKey) continue;
      const key = rawKey.trim();
      if (key !== 'numeriqu_access_token') continue;
      const value = rawValueParts.join('=').trim();
      if (!value) return null;
      return decodeURIComponent(value);
    }
    return null;
  }
}
