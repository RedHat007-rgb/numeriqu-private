import {
  Controller,
  Post,
  Req,
  Get,
  Body,
  UseGuards,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { IntegrationsService } from './integrations/integrations.service';
import { prisma } from '@repo/db';
import { SupabaseAuthGuard } from './common/guards/supabase-auth.guard';
import { CurrentUser } from './common/decorators/user.decorator';
import type { AuthUser } from './common/decorators/user.decorator';
import { UserProvisioningService } from './common/services/user-provisioning.service';
import { AuditLogService } from './common/services/audit-log.service';
import { OtpService } from './common/services/otp.service';

@Controller()
export class AppController {
  private readonly logger = new Logger(AppController.name);

  constructor(
    private readonly integrations: IntegrationsService,
    private readonly provisioning: UserProvisioningService,
    private readonly auditLog: AuditLogService,
    private readonly otpService: OtpService,
  ) {}

  // ─── AUTH: Profile ──────────────────────────────────────────────────────

  /**
   * GET /auth/me
   * Returns the authenticated user's profile + tenant.
   * First call triggers JIT provisioning (creates user + tenant).
   */
  @Get('auth/me')
  @UseGuards(SupabaseAuthGuard)
  async getMe(@CurrentUser() user: AuthUser, @Req() req: any) {
    const result = await this.provisioning.ensureProvisioned(user.id, user.email);

    this.auditLog.logAsync({
      tenantId: result.tenant.id,
      userId: result.user.id,
      action: 'user.login',
      resource: 'user',
      resourceId: result.user.id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return result;
  }

  /**
   * GET /auth/me/full
   * Returns extended profile with role, permissions, avatar.
   */
  @Get('auth/me/full')
  @UseGuards(SupabaseAuthGuard)
  async getMeFull(@CurrentUser() user: AuthUser) {
    // If not yet provisioned, provision now
    if (!user.tenantId) {
      return this.provisioning.ensureProvisioned(user.id, user.email);
    }

    const dbUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        avatarUrl: true,
        tenant: {
          select: { id: true, name: true, accountType: true, slug: true, plan: true },
        },
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
      return this.provisioning.ensureProvisioned(user.id, user.email);
    }

    return {
      user: {
        id: dbUser.id,
        email: dbUser.email,
        name: dbUser.name,
        role: dbUser.role,
        avatarUrl: dbUser.avatarUrl,
        permissions:
          dbUser.role === 'admin'
            ? { canCreateDashboard: true, canShareDashboard: true, canQueryRag: true, canUseAgent: true }
            : (dbUser.permission ?? {
                canCreateDashboard: false,
                canShareDashboard: false,
                canQueryRag: true,
                canUseAgent: false,
              }),
      },
      tenant: dbUser.tenant,
    };
  }

  // ─── AUTH: OTP (public — no auth guard) ────────────────────────────────

  /**
   * POST /auth/send-otp
   * Generates a hashed 6-digit code and sends via Resend.
   * Rate-limit this endpoint at the infrastructure level (Cloudflare / nginx).
   */
  @Post('auth/send-otp')
  async sendOtp(@Body() body: { email?: string }) {
    if (!body?.email?.includes('@')) {
      throw new BadRequestException('A valid email address is required.');
    }
    await this.otpService.send(body.email.toLowerCase().trim());
    return { message: 'Verification code sent to your email.' };
  }

  /**
   * POST /auth/verify-otp
   * Verifies the OTP, creates the Supabase user (email_confirm: true),
   * and stores accountType + orgName for use on first /auth/me call.
   *
   * After this returns 200, the frontend calls supabase.auth.signInWithPassword().
   * On first /auth/me, the provisioning service creates the Numeriqu user + tenant.
   */
  @Post('auth/verify-otp')
  async verifyOtp(
    @Body()
    body: {
      email?: string;
      code?: string;
      password?: string;
      name?: string;
      accountType?: 'organization';
      orgName?: string;
    },
  ) {
    const { email, code, password } = body;
    if (!email || !code || !password) {
      throw new BadRequestException('email, code, and password are required.');
    }
    if (password.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters.');
    }

    const normalizedEmail = email.toLowerCase().trim();

    await this.otpService.verify(normalizedEmail, code);
    await this.otpService.createVerifiedUser(normalizedEmail, password, body.name);

    // Store signup metadata in Supabase user_metadata so provisioning service can
    // read it on the first /auth/me call.
    // NOTE: provisioning happens JIT on first authenticated request —
    // the accountType and orgName are passed there, not here.
    this.logger.log(
      `[Auth] User created: ${normalizedEmail} accountType=${body.accountType ?? 'organization'}`,
    );

    return {
      message: 'Email verified. Sign in to access your account.',
      accountType: body.accountType ?? 'organization',
    };
  }

  // ─── TEST / DEV ENDPOINTS ───────────────────────────────────────────────

  /**
   * POST /test/trigger-sync
   * Manually triggers a sync for all active connections of the authenticated user.
   * For development use only — remove in production.
   */
  @Post('test/trigger-sync')
  @UseGuards(SupabaseAuthGuard)
  async triggerSync(@CurrentUser() user: AuthUser, @Req() req: any) {
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);

    const provider = req.query.provider as string | undefined;
    const filter: Record<string, unknown> = { isActive: true, tenantId: tenant.id };
    if (provider) filter.provider = provider;

    const connections = await prisma.connection.findMany({ where: filter });

    if (connections.length === 0) {
      return { error: `No active ${provider ?? ''} connections found.` };
    }

    for (const conn of connections) {
      this.integrations
        .startIntegrationSync(
          conn.tenantId,
          conn.userId,
          conn.id,
          conn.provider,
          conn.providerAccountId,
        )
        .catch((e: Error) => this.logger.error(`Sync failed for ${conn.provider}: ${e.message}`));
    }

    return {
      message: `Triggered sync for ${connections.length} connection(s).`,
      connections: connections.map((c) => ({ provider: c.provider, id: c.id })),
    };
  }

  /**
   * GET /test/jobs
   * Returns the last 10 sync jobs for the authenticated user's tenant.
   */
  @Get('test/jobs')
  @UseGuards(SupabaseAuthGuard)
  async checkJobs(@CurrentUser() user: AuthUser) {
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);

    const jobs = await prisma.syncJob.findMany({
      where: { tenantId: tenant.id },
      orderBy: { startedAt: 'desc' },
      take: 10,
      include: { connection: { select: { metadata: true, displayName: true } } },
    });

    return jobs.map((job) => {
      const meta = job.connection?.metadata as Record<string, any> | null;
      const { connection: _c, ...rest } = job;
      return {
        ...rest,
        orgName: job.connection?.displayName || (meta?.orgName as string | undefined) || null,
      };
    });
  }
}
