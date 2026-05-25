import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Logger,
  Post,
  Req,
  Res,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { IsEmail, IsIn, IsOptional, IsString, Length } from 'class-validator';
import { XeroClient } from 'xero-node';
import axios from 'axios';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@repo/db';
import { PRISMA_TOKEN } from '../../database/database.module';
import { AuthService } from './auth.service';
import { CryptoService } from '../../common/crypto.service';
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard';
import { CurrentUser } from '../../common/decorators/user.decorator';
import type { AuthUser } from '../../common/decorators/user.decorator';
import { OrganizationContextService } from '../org-context/org-context.service';

class SendOtpDto {
  @IsEmail()
  email!: string;
}

class VerifyOtpDto {
  @IsEmail()
  email!: string;

  @IsString()
  @Length(6, 6)
  otp!: string;

  @IsOptional()
  @IsIn(['SOLO', 'ORGANIZATION'])
  accountType?: 'SOLO' | 'ORGANIZATION';
}

const DEFAULT_XERO_START_DATE =
  process.env.DEFAULT_XERO_START_DATE || '2020-01-01T00:00:00Z';
const QUICKBOOKS_TOKEN_URL =
  'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

@Controller('auth')
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: false,
    transform: true,
  }),
)
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  private readonly STATES_DIR = join(process.cwd(), '.oauth-states');
  private readonly STATE_TTL_MS = 15 * 60 * 1000;

  constructor(
    private readonly authService: AuthService,
    private readonly organizationContext: OrganizationContextService,
    private readonly crypto: CryptoService,
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
  ) {}

  // ── OTP flow ────────────────────────────────────────────────────────────────

  @Post('send-otp')
  @HttpCode(200)
  async sendOtp(@Body() body: SendOtpDto) {
    await this.authService.sendOtp(body.email);
    return { success: true };
  }

  @Post('resend-otp')
  @HttpCode(200)
  async resendOtp(@Body() body: SendOtpDto) {
    await this.authService.resendOtp(body.email);
    return { success: true };
  }

  @Post('verify-otp')
  @HttpCode(200)
  async verifyOtp(
    @Body() body: VerifyOtpDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.authService.verifyOtpAndCreateSession({
      email: body.email,
      otp: body.otp,
      response,
      accountType: body.accountType,
    });
  }

  @Post('demo-login')
  @HttpCode(200)
  async demoLogin(
    @Body() body: { email: string },
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.authService.demoLogin({ email: body.email ?? '', response });
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) response: Response) {
    this.authService.clearAuthCookies(response);
    return { success: true };
  }

  @Get('me')
  @UseGuards(SupabaseAuthGuard)
  async me(
    @CurrentUser() user: AuthUser,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.organizationContext.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );
    return {
      user: {
        id: context.user.id,
        email: context.user.email,
      },
      tenant: {
        id: context.organization.id,
        name: context.organization.name,
        accountType: context.organization.accountType,
        createdAt: context.organization.createdAt.toISOString(),
      },
    };
  }

  // ── OAuth state helpers (file-based, survives hot-reload) ───────────────────

  private persistOAuthState(payload: Record<string, unknown>, customKey?: string): string {
    if (!existsSync(this.STATES_DIR)) mkdirSync(this.STATES_DIR, { recursive: true });
    const key = customKey || randomUUID();
    writeFileSync(
      join(this.STATES_DIR, `${key}.json`),
      JSON.stringify({ data: payload, expiresAt: Date.now() + this.STATE_TTL_MS }),
    );
    return key;
  }

  private consumeOAuthState(token: string): Record<string, unknown> {
    if (!token) throw new BadRequestException('Authorization session expired. Please try connecting again.');
    const filePath = join(this.STATES_DIR, `${token}.json`);
    if (!existsSync(filePath)) throw new BadRequestException('Authorization session expired. Please try connecting again.');
    const entry = JSON.parse(readFileSync(filePath, 'utf-8'));
    try { require('fs').unlinkSync(filePath); } catch { /* ignore */ }
    if (Date.now() > entry.expiresAt) throw new BadRequestException('Authorization session expired. Please try connecting again.');
    const { organizationId, userId } = entry.data as Record<string, string>;
    if (!organizationId || organizationId === 'undefined' || !userId || userId === 'undefined') {
      throw new BadRequestException('Authorization context is invalid. Please log in again and retry.');
    }
    return entry.data as Record<string, unknown>;
  }

  // ── Xero OAuth ──────────────────────────────────────────────────────────────

  private getXeroClient(state?: string): XeroClient {
    const scopes =
      process.env.XERO_SCOPES ||
      'openid profile email offline_access accounting.settings.read accounting.contacts.read accounting.invoices.read accounting.payments.read accounting.banktransactions.read accounting.manualjournals.read';
    return new XeroClient({
      clientId: process.env.XERO_CLIENT_ID!,
      clientSecret: process.env.XERO_CLIENT_SECRET!,
      redirectUris: [process.env.XERO_REDIRECT_URI!],
      scopes: scopes.split(' '),
      ...(state ? { state } : {}),
    });
  }

  @Post('xero/connect')
  @UseGuards(SupabaseAuthGuard)
  async connectXero(
    @CurrentUser() user: AuthUser,
    @Body() body: any,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.organizationContext.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );
    const oauthState = randomUUID();
    const xero = this.getXeroClient(oauthState);
    const consentUrl = await xero.buildConsentUrl();
    this.persistOAuthState(
      { organizationId: context.organization.id, userId: context.user.id, startDate: body?.startDate || DEFAULT_XERO_START_DATE },
      oauthState,
    );
    return { url: consentUrl };
  }

  @Get('xero/callback')
  async callbackXero(@Req() req: Request, @Res() res: Response) {
    const webAppUrl = process.env.WEB_APP_URL || 'http://localhost:3010';
    try {
      const { state } = req.query as Record<string, string>;
      const { organizationId, userId } = this.consumeOAuthState(state) as { organizationId: string; userId: string };

      const apiUrl = process.env.API_URL || 'http://localhost:3000';
      const xero = this.getXeroClient(state);
      const tokenSet = await xero.apiCallback(apiUrl + req.url);
      await xero.updateTenants();

      for (const xtenant of xero.tenants) {
        this.logger.log(`[Xero] Connecting tenant: ${xtenant.tenantId} (${xtenant.tenantName})`);
        await this.prisma.erpConnection.upsert({
          where: {
            organizationId_provider_externalOrganizationId: {
              organizationId,
              provider: 'XERO',
              externalOrganizationId: xtenant.tenantId,
            },
          },
          update: {
            accessTokenEncrypted: this.crypto.encrypt(tokenSet.access_token!),
            refreshTokenEncrypted: tokenSet.refresh_token ? this.crypto.encrypt(tokenSet.refresh_token) : null,
            tokenExpiresAt: tokenSet.expires_at ? new Date(tokenSet.expires_at * 1000) : null,
            status: 'ACTIVE',
            displayName: xtenant.tenantName,
          },
          create: {
            organizationId,
            provider: 'XERO',
            externalOrganizationId: xtenant.tenantId,
            displayName: xtenant.tenantName,
            accessTokenEncrypted: this.crypto.encrypt(tokenSet.access_token!),
            refreshTokenEncrypted: tokenSet.refresh_token ? this.crypto.encrypt(tokenSet.refresh_token) : null,
            tokenExpiresAt: tokenSet.expires_at ? new Date(tokenSet.expires_at * 1000) : null,
            status: 'ACTIVE',
            createdById: userId,
          },
        });
      }

      res.redirect(`${webAppUrl}/dashboard?success=xero_connected`);
    } catch (e: any) {
      this.logger.error('Xero callback failed', e);
      const msg = e instanceof BadRequestException
        ? encodeURIComponent((e.getResponse() as any)?.message || 'Connection expired')
        : 'xero_connection_failed';
      res.redirect(`${webAppUrl}/dashboard?error=${msg}`);
    }
  }

  // ── QuickBooks OAuth ────────────────────────────────────────────────────────

  private getQuickBooksRedirectUri(): string {
    return process.env.QB_REDIRECT_URI || 'http://localhost:3000/auth/quickbooks/callback';
  }

  @Post('quickbooks/connect')
  @UseGuards(SupabaseAuthGuard)
  async connectQuickBooks(
    @CurrentUser() user: AuthUser,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const context = await this.organizationContext.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );
    const stateToken = this.persistOAuthState({ organizationId: context.organization.id, userId: context.user.id });

    const url = new URL('https://appcenter.intuit.com/connect/oauth2');
    url.searchParams.set('client_id', process.env.QB_CLIENT_ID || '');
    url.searchParams.set('scope', 'com.intuit.quickbooks.accounting');
    url.searchParams.set('redirect_uri', this.getQuickBooksRedirectUri());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', stateToken);

    return { url: url.toString() };
  }

  @Get('quickbooks/callback')
  async callbackQuickBooks(@Req() req: Request, @Res() res: Response) {
    const webAppUrl = process.env.WEB_APP_URL || 'http://localhost:3010';
    try {
      const { code, realmId, state } = req.query as Record<string, string>;
      const { organizationId, userId } = this.consumeOAuthState(state) as { organizationId: string; userId: string };

      const authHeader = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
      const tokenRes = await axios.post(
        QUICKBOOKS_TOKEN_URL,
        new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.getQuickBooksRedirectUri() }).toString(),
        { headers: { Authorization: `Basic ${authHeader}`, 'Content-Type': 'application/x-www-form-urlencoded' } },
      );

      let displayName = `QB-${realmId}`;
      try {
        const baseUrl = process.env.QB_ENVIRONMENT === 'production'
          ? 'https://quickbooks.api.intuit.com'
          : 'https://sandbox-quickbooks.api.intuit.com';
        const companyRes = await axios.get(`${baseUrl}/v3/company/${realmId}/companyinfo/${realmId}`, {
          headers: { Authorization: `Bearer ${tokenRes.data.access_token}`, Accept: 'application/json' },
        });
        displayName = companyRes.data?.CompanyInfo?.CompanyName || displayName;
      } catch (e: any) {
        this.logger.warn(`[QB] Could not fetch company name for realm ${realmId}: ${e.message}`);
      }

      const expiresIn: number = tokenRes.data.expires_in ?? 3600;
      await this.prisma.erpConnection.upsert({
        where: {
          organizationId_provider_externalOrganizationId: {
            organizationId,
            provider: 'QUICKBOOKS',
            externalOrganizationId: realmId,
          },
        },
        update: {
          accessTokenEncrypted: this.crypto.encrypt(tokenRes.data.access_token),
          refreshTokenEncrypted: this.crypto.encrypt(tokenRes.data.refresh_token),
          tokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
          status: 'ACTIVE',
          displayName,
        },
        create: {
          organizationId,
          provider: 'QUICKBOOKS',
          externalOrganizationId: realmId,
          displayName,
          accessTokenEncrypted: this.crypto.encrypt(tokenRes.data.access_token),
          refreshTokenEncrypted: this.crypto.encrypt(tokenRes.data.refresh_token),
          tokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
          status: 'ACTIVE',
          createdById: userId,
        },
      });

      res.redirect(`${webAppUrl}/dashboard?success=quickbooks_connected`);
    } catch (e: any) {
      this.logger.error('QuickBooks callback failed', e);
      const msg = e instanceof BadRequestException
        ? encodeURIComponent((e.getResponse() as any)?.message || 'Connection expired')
        : 'quickbooks_connection_failed';
      res.redirect(`${webAppUrl}/dashboard?error=${msg}`);
    }
  }
}
