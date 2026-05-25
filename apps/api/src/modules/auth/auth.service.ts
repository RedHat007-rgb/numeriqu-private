import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Response } from 'express';
import { prisma } from '@repo/db';
import { OtpService } from './otp.service';
import { ResendService } from './resend.service';
import { SupabaseService } from './supabase.service';
import { OrganizationContextService } from '../org-context/org-context.service';

const DEMO_EMAILS = new Set([
  'demo1@numeriqu.com',
  'demo2@numeriqu.com',
  'demo3@numeriqu.com',
  'demo4@numeriqu.com',
  'demo5@numeriqu.com',
]);

const SAMPLE_ORG_SLUG = 'sample-company-2024';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly otpService: OtpService,
    private readonly resendService: ResendService,
    private readonly supabaseService: SupabaseService,
    private readonly organizationContext: OrganizationContextService,
  ) {}

  private normalizeEmail(email: string) {
    return email.trim().toLowerCase();
  }

  private cookieSecure() {
    return process.env.NODE_ENV === 'production';
  }

  private createError(message: string, code: string, status = 400) {
    const traceId = randomUUID();
    const payload = { message, code, traceId };
    this.logger.warn(`[${code}] traceId=${traceId} ${message}`);
    if (status >= 500) {
      throw new InternalServerErrorException(payload);
    }
    throw new BadRequestException(payload);
  }

  async sendOtp(email: string) {
    const normalizedEmail = this.normalizeEmail(email);
    if (!normalizedEmail) {
      this.createError('Email is required.', 'EMAIL_REQUIRED');
    }

    await this.otpService.enforceResendRateLimit(normalizedEmail);
    const otp = this.otpService.generateOtp();
    await this.otpService.storeOtp(normalizedEmail, otp);
    await this.resendService.sendOtpEmail(normalizedEmail, otp);
  }

  async resendOtp(email: string) {
    await this.sendOtp(email);
  }

  clearAuthCookies(response: Response) {
    response.clearCookie('numeriqu_access_token', {
      httpOnly: true,
      secure: this.cookieSecure(),
      sameSite: 'lax',
      path: '/',
    });
    response.clearCookie('numeriqu_refresh_token', {
      httpOnly: true,
      secure: this.cookieSecure(),
      sameSite: 'lax',
      path: '/',
    });
  }

  /** Check if an email belongs to a demo account. */
  isDemoEmail(email: string): boolean {
    return DEMO_EMAILS.has(this.normalizeEmail(email));
  }

  /**
   * Demo login — bypasses OTP entirely.
   * Only works for the 5 fixed demo emails.
   * Automatically adds the user to the shared Sample Company 2024 org.
   */
  async demoLogin({ email, response }: { email: string; response: Response }) {
    const normalized = this.normalizeEmail(email);
    if (!DEMO_EMAILS.has(normalized)) {
      this.createError('Not a demo account.', 'NOT_DEMO');
    }

    // Create / retrieve Supabase session — no OTP required
    const session = await this.supabaseService.createSessionForEmail(normalized);

    // Find the shared sample org
    const sampleOrg = await prisma.organization.findUnique({
      where: { slug: SAMPLE_ORG_SLUG },
    });
    if (!sampleOrg) {
      this.logger.error('[Demo] Sample org not found — run seed:sample-gl first');
      throw new InternalServerErrorException({
        message: 'Demo data not initialized yet. Contact the admin.',
        code: 'NO_SAMPLE_ORG',
      });
    }

    // Ensure demo user is a member of the sample org
    await prisma.organizationMembership.upsert({
      where: {
        organizationId_userId: {
          organizationId: sampleOrg.id,
          userId: session.user.id,
        },
      },
      create: {
        organizationId: sampleOrg.id,
        userId: session.user.id,
        role: 'USER',
        canViewDashboard: true,
        canCreateDashboard: false,
        canShareDashboard: false,
      },
      update: { leftAt: null },
    });

    // Set the same httpOnly cookies as the normal OTP flow
    const secure = this.cookieSecure();
    response.cookie('numeriqu_access_token', session.accessToken, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      maxAge: Math.max(60, session.expiresIn) * 1000,
      path: '/',
    });
    response.cookie('numeriqu_refresh_token', session.refreshToken, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: '/',
    });

    this.logger.log(`[Demo] ${normalized} signed in → org ${sampleOrg.id}`);
    return { user: session.user, orgId: sampleOrg.id };
  }

  async verifyOtpAndCreateSession(params: {
    email: string;
    otp: string;
    response: Response;
    accountType?: 'SOLO' | 'ORGANIZATION';
  }) {
    const { email, otp, response, accountType } = params;
    const normalizedEmail = this.normalizeEmail(email);
    if (!normalizedEmail || !otp) {
      this.createError('Email and OTP are required.', 'INVALID_INPUT');
    }

    await this.otpService.verifyOtp(normalizedEmail, otp);

    const session = await this.supabaseService.createSessionForEmail(normalizedEmail);

    await this.organizationContext.ensureContext(
      {
        id: session.user.id,
        email: normalizedEmail,
      },
      { preferredAccountType: accountType },
    );

    response.cookie('numeriqu_access_token', session.accessToken, {
      httpOnly: true,
      secure: this.cookieSecure(),
      sameSite: 'lax',
      maxAge: Math.max(60, session.expiresIn) * 1000,
      path: '/',
    });
    response.cookie('numeriqu_refresh_token', session.refreshToken, {
      httpOnly: true,
      secure: this.cookieSecure(),
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: '/',
    });

    return {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      user: session.user,
    };
  }
}
