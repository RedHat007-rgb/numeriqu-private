import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { XeroClient } from 'xero-node';
import axios from 'axios';
import { prisma } from '@repo/db';
import type { Request, Response } from 'express';
import { IntegrationsService } from './integrations.service';
import { CryptoService } from '../common/crypto.service';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import type { AuthUser } from '../common/decorators/user.decorator';
import { UserProvisioningService } from '../common/services/user-provisioning.service';

const DEFAULT_XERO_START_DATE =
  process.env.DEFAULT_XERO_START_DATE || '2020-01-01T00:00:00Z';
const QUICKBOOKS_TOKEN_URL =
  'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly integrationsService: IntegrationsService,
    private readonly crypto: CryptoService,
    private readonly provisioning: UserProvisioningService,
  ) { }

  private normalizeStartDateInput(value?: string | string[]): string {
    const raw = Array.isArray(value) ? value[0] : value;
    if (!raw) return DEFAULT_XERO_START_DATE;

    const candidate = raw.includes('T') ? raw : `${raw}T00:00:00Z`;
    const parsed = new Date(candidate);
    if (Number.isNaN(parsed.valueOf())) {
      return DEFAULT_XERO_START_DATE;
    }
    return parsed.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  private getXeroClient(): XeroClient {
    const scopes = process.env.XERO_SCOPES || 'openid profile email offline_access accounting.settings.read accounting.invoices.read accounting.contacts.read';
    return new XeroClient({
      clientId: process.env.XERO_CLIENT_ID!,
      clientSecret: process.env.XERO_CLIENT_SECRET!,
      redirectUris: [process.env.XERO_REDIRECT_URI!],
      scopes: scopes.split(' '),
    });
  }

  private getQuickBooksRedirectUri(): string {
    return (
      process.env.QB_REDIRECT_URI ||
      'http://localhost:3000/auth/quickbooks/callback'
    );
  }

  private persistOAuthContext(res: Response, payload: Record<string, any>) {
    res.cookie('oauth_context', JSON.stringify(payload), {
      maxAge: 900000,
      httpOnly: true,
    });
  }

  private getOAuthContext(req: Request) {
    const cookieStr = req.headers.cookie
      ?.split(';')
      .find((c) => c.trim().startsWith('oauth_context='));
    if (!cookieStr) {
      throw new BadRequestException('OAuth context cookie missing.');
    }
    const payload = JSON.parse(decodeURIComponent(cookieStr.split('=')[1]));
    const { tenantId, userId } = payload;
    if (!tenantId || !userId) {
      throw new BadRequestException('OAuth context invalid.');
    }
    return { tenantId, userId, ...payload };
  }

  @Get('xero/connect')
  async connectXero(@Req() req: Request, @Res() res: Response) {
    const tenantId = req.query.tenantId as string;
    const userId = req.query.userId as string;
    const requestedStartDate = this.normalizeStartDateInput(
      req.query.startDate as string | undefined,
    );

    if (!tenantId || !userId) {
      return res
        .status(400)
        .send('Needs tenantId and userId to start OAuth connection');
    }

    try {
      const xero = this.getXeroClient();
      const consentUrl = await xero.buildConsentUrl();

      this.persistOAuthContext(res, {
        tenantId,
        userId,
        startDate: requestedStartDate,
      });

      this.logger.log(`Redirecting User ${userId} to Xero IdP...`);
      res.redirect(consentUrl);
    } catch (e) {
      this.logger.error('Failed to init Xero oauth', e);
      res
        .status(500)
        .send('We encountered an issue preparing the integration process.');
    }
  }

  @Get('quickbooks/connect')
  async connectQuickBooks(@Req() req: Request, @Res() res: Response) {
    const tenantId = req.query.tenantId as string;
    const userId = req.query.userId as string;
    if (!tenantId || !userId)
      throw new BadRequestException('tenantId and userId are required');

    this.persistOAuthContext(res, { tenantId, userId });

    const url = new URL('https://appcenter.intuit.com/connect/oauth2');
    url.searchParams.set('client_id', process.env.QB_CLIENT_ID || '');
    url.searchParams.set('scope', 'com.intuit.quickbooks.accounting');
    url.searchParams.set('redirect_uri', this.getQuickBooksRedirectUri());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', 'quickbooks');

    res.redirect(url.toString());
  }

  @Get('quickbooks/callback')
  async callbackQuickBooks(@Req() req: Request, @Res() res: Response) {
    try {
      const { code, realmId } = req.query as Record<string, string>;
      const { tenantId, userId } = this.getOAuthContext(req);

      const tokenPayload = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.getQuickBooksRedirectUri(),
      });

      const authHeader = Buffer.from(
        `${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`,
      ).toString('base64');
      const tokenRes = await axios.post(
        QUICKBOOKS_TOKEN_URL,
        tokenPayload.toString(),
        {
          headers: {
            Authorization: `Basic ${authHeader}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );

      // Fetch company name from QB API to tag all future syncs with a human-readable org name
      let orgName = `QB-${realmId}`;
      try {
        const baseUrl = process.env.QB_ENVIRONMENT === 'production'
          ? 'https://quickbooks.api.intuit.com'
          : 'https://sandbox-quickbooks.api.intuit.com';
        const companyRes = await axios.get(
          `${baseUrl}/v3/company/${realmId}/companyinfo/${realmId}`,
          {
            headers: {
              Authorization: `Bearer ${tokenRes.data.access_token}`,
              Accept: 'application/json',
            },
          },
        );
        orgName = companyRes.data?.CompanyInfo?.CompanyName || orgName;
      } catch (e: any) {
        this.logger.warn(`[QB] Could not fetch company name for realm ${realmId}: ${e.message}`);
      }

      // 1. Persist the connection with encrypted tokens + org name in metadata
      const connection = await prisma.connection.upsert({
        where: {
          tenantId_provider_providerAccountId: {
            tenantId,
            provider: 'quickbooks',
            providerAccountId: realmId,
          },
        },
        update: {
          accessToken: this.crypto.encrypt(tokenRes.data.access_token),
          refreshToken: this.crypto.encrypt(tokenRes.data.refresh_token),
          isActive: true,
          metadata: { orgName },
        },
        create: {
          tenantId,
          userId,
          provider: 'quickbooks',
          providerAccountId: realmId,
          accessToken: this.crypto.encrypt(tokenRes.data.access_token),
          refreshToken: this.crypto.encrypt(tokenRes.data.refresh_token),
          isActive: true,
          metadata: { orgName },
        },
      });

      // 2. Trigger sync in background (non-blocking)
      this.integrationsService
        .startIntegrationSync(
          tenantId,
          userId,
          connection.id,
          'quickbooks',
          realmId,
        )
        .catch((err) =>
          this.logger.error('QuickBooks background sync failed', err),
        );

      // 3. Instant redirect to improve UX
      const webAppUrl = process.env.WEB_APP_URL || 'http://localhost:3000';
      res.redirect(`${webAppUrl}/?success=quickbooks_connected`);
    } catch (e) {
      this.logger.error('QuickBooks callback failed', e);
      const webAppUrl = process.env.WEB_APP_URL || 'http://localhost:3000';
      res.redirect(`${webAppUrl}/?error=quickbooks_connection_failed`);
    }
  }

  @Get('xero/callback')
  async callbackXero(@Req() req: Request, @Res() res: Response) {
    try {
      const apiUrl = process.env.API_URL || 'http://localhost:3000';
      const fullUrl = apiUrl + req.url;
      const xero = this.getXeroClient();
      const tokenSet = await xero.apiCallback(fullUrl);
      await xero.updateTenants();

      const {
        tenantId: internalTenantId,
        userId,
        startDate,
      } = this.getOAuthContext(req);

      for (const xtenant of xero.tenants) {
        this.logger.log(
          `[Xero] Processing tenant: ${xtenant.tenantId} (${xtenant.tenantName})`,
        );

        const connection = await prisma.connection.upsert({
          where: {
            tenantId_provider_providerAccountId: {
              tenantId: internalTenantId,
              provider: 'xero',
              providerAccountId: xtenant.tenantId,
            },
          },
          update: {
            accessToken: this.crypto.encrypt(tokenSet.access_token!),
            refreshToken: tokenSet.refresh_token
              ? this.crypto.encrypt(tokenSet.refresh_token)
              : null,
            metadata: { orgName: xtenant.tenantName },
          },
          create: {
            tenantId: internalTenantId,
            userId,
            provider: 'xero',
            providerAccountId: xtenant.tenantId,
            accessToken: this.crypto.encrypt(tokenSet.access_token!),
            refreshToken: tokenSet.refresh_token
              ? this.crypto.encrypt(tokenSet.refresh_token)
              : null,
            metadata: { orgName: xtenant.tenantName },
          },
        });

        // Trigger sync in background (non-blocking)
        this.integrationsService
          .startIntegrationSync(
            internalTenantId,
            userId,
            connection.id,
            'xero',
            xtenant.tenantId,
          )
          .catch((err) =>
            this.logger.error('Xero background sync failed', err),
          );
      }

      const webAppUrl = process.env.WEB_APP_URL || 'http://localhost:3000';
      res.redirect(`${webAppUrl}/?success=xero_connected`);
    } catch (e) {
      this.logger.error('Xero callback failed', e);
      const webAppUrl = process.env.WEB_APP_URL || 'http://localhost:3000';
      res.redirect(`${webAppUrl}/?error=xero_connection_failed`);
    }
  }

  @Post('workday/setup')
  @UseGuards(SupabaseAuthGuard)
  async setupWorkday(@CurrentUser() user: AuthUser, @Body() body: any) {
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);

    const connection = await prisma.connection.upsert({
      where: {
        tenantId_provider_providerAccountId: {
          tenantId: tenant.id,
          provider: 'workday',
          providerAccountId: body.workdayTenantId,
        },
      },
      update: {
        accessToken: 'N/A',
        refreshToken: this.crypto.encrypt(body.refreshToken),
        metadata: this.crypto.encryptJson({ host: body.workdayHost }),
      },
      create: {
        tenantId: tenant.id,
        userId: user.id,
        provider: 'workday',
        providerAccountId: body.workdayTenantId,
        accessToken: 'N/A',
        refreshToken: this.crypto.encrypt(body.refreshToken),
        metadata: this.crypto.encryptJson({ host: body.workdayHost }),
      },
    });

    // Background sync
    this.integrationsService
      .startIntegrationSync(
        tenant.id,
        user.id,
        connection.id,
        'workday',
        connection.id,
      )
      .catch((err) => this.logger.error('Workday background sync failed', err));

    return { status: 'success', connectionId: connection.id };
  }

  @Post('dynamics365/setup')
  @UseGuards(SupabaseAuthGuard)
  async setupDynamics365(
    @CurrentUser() user: AuthUser,
    @Body()
    body: {
      microsoftTenantId: string;
      clientId: string;
      clientSecret: string;
      environment: string;
      companyId: string;
    },
  ) {
    const { tenant } = await this.provisioning.ensureProvisioned(user.id, user.email);
    this.logger.log(
      `Setting up Dynamics 365 for internal tenant ${tenant.id}`,
    );

    // 1. Persist the connection with encrypted Client Secret
    const connection = await prisma.connection.upsert({
      where: {
        tenantId_provider_providerAccountId: {
          tenantId: tenant.id,
          provider: 'dynamics365',
          providerAccountId: body.companyId,
        },
      },
      update: {
        accessToken: 'N/A', // Client credentials flow
        refreshToken: this.crypto.encrypt(body.clientSecret),
        metadata: this.crypto.encryptJson({
          tenantId: body.microsoftTenantId,
          clientId: body.clientId,
          environment: body.environment,
          companyId: body.companyId,
        }),
      },
      create: {
        tenantId: tenant.id,
        userId: user.id,
        provider: 'dynamics365',
        providerAccountId: body.companyId,
        accessToken: 'N/A',
        refreshToken: this.crypto.encrypt(body.clientSecret),
        metadata: this.crypto.encryptJson({
          tenantId: body.microsoftTenantId,
          clientId: body.clientId,
          environment: body.environment,
          companyId: body.companyId,
        }),
      },
    });

    // 2. Trigger sync in background
    this.integrationsService
      .startIntegrationSync(
        tenant.id,
        user.id,
        connection.id,
        'dynamics365',
        connection.id,
      )
      .catch((err) =>
        this.logger.error('Dynamics 365 background sync failed', err),
      );

    return { status: 'success', connectionId: connection.id };
  }
}
