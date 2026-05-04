import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { prisma } from '@repo/db';

/**
 * SupabaseAuthGuard — Production JWT Validation + Tenant Context Injection
 *
 * Validates the Bearer token against Supabase Auth.
 * Then enriches the request with the user's tenant, role, and permissions
 * from the Numeriqu database — so every controller downstream gets full context.
 *
 * request.user shape after this guard:
 * {
 *   id: string           — Supabase user UUID
 *   email: string
 *   tenantId: string
 *   role: 'admin' | 'member'
 *   permissions: {       — null for admins (full access implied)
 *     canCreateDashboard: boolean
 *     canShareDashboard: boolean
 *     canQueryRag: boolean
 *     canUseAgent: boolean
 *   } | null
 * }
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

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid Authorization header');
    }

    const token = authHeader.replace('Bearer ', '');

    try {
      // Step 1: Validate JWT with Supabase
      const {
        data: { user: supabaseUser },
        error,
      } = await this.supabase.auth.getUser(token);

      if (error || !supabaseUser) {
        this.logger.warn(`[Auth] Token validation failed: ${error?.message}`);
        throw new UnauthorizedException('Invalid or expired token');
      }

      // Step 2: Load Numeriqu user record (role + tenant)
      const dbUser = await prisma.user.findUnique({
        where: { id: supabaseUser.id },
        select: {
          id: true,
          email: true,
          name: true,
          tenantId: true,
          role: true,
          permission: {
            select: {
              canCreateDashboard: true,
              canShareDashboard: true,
              canQueryRag: true,
              canUseAgent: true,
            },
          },
        },
      });

      if (!dbUser) {
        // User exists in Supabase but not yet provisioned in Numeriqu.
        // Allow through with minimal context — provisioning happens on first /auth/me call.
        request.user = {
          id: supabaseUser.id,
          email: supabaseUser.email ?? '',
          tenantId: null,
          role: 'admin', // default until provisioned
          permissions: null,
        };
        return true;
      }

      // Step 3: Attach full context to request
      request.user = {
        id: dbUser.id,
        email: dbUser.email,
        name: dbUser.name,
        tenantId: dbUser.tenantId,
        role: dbUser.role as 'admin' | 'member',
        // Admins: permissions null (full access implied in guards/services)
        // Members: attach their specific permission flags
        permissions: dbUser.role === 'admin' ? null : (dbUser.permission ?? {
          canCreateDashboard: false,
          canShareDashboard: false,
          canQueryRag: true,
          canUseAgent: false,
        }),
      };

      return true;
    } catch (e: unknown) {
      if (e instanceof UnauthorizedException) throw e;
      const msg = e instanceof Error ? e.message : 'Unknown error';
      this.logger.error(`[Auth] Unexpected error: ${msg}`);
      throw new UnauthorizedException('Authentication failed');
    }
  }
}
