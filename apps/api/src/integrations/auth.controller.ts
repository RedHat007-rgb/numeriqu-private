import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Logger,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { XeroClient } from 'xero-node';
import axios from 'axios';
import { prisma } from '@repo/db';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { Request, Response } from 'express';
import { IntegrationsService } from './integrations.service';
import { CryptoService } from '../common/crypto.service';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import type { AuthUser } from '../common/decorators/user.decorator';
import { OrganizationContextService } from '../modules/org-context/org-context.service';

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
    private readonly orgContext: OrganizationContextService,
  ) {}

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

  /**
   * Create a XeroClient with an optional OIDC state value.
   * When `state` is provided, the SDK uses it for OIDC state verification
   * in apiCallback(). BOTH connect and callback must use the SAME state.
   */
  private getXeroClient(state?: string): XeroClient {
    const scopes =
      process.env.XERO_SCOPES ||
      // NOTE: When scopes change, users must reconnect Xero to grant the new permissions.
      'openid profile email offline_access accounting.settings.read accounting.contacts.read accounting.invoices.read accounting.payments.read accounting.banktransactions.read accounting.manualjournals.read accounting.journals.read accounting.reports.read';
    return new XeroClient({
      clientId: process.env.XERO_CLIENT_ID!,
      clientSecret: process.env.XERO_CLIENT_SECRET!,
      redirectUris: [process.env.XERO_REDIRECT_URI!],
      scopes: scopes.split(' '),
      ...(state ? { state } : {}),
    });
  }

  private getQuickBooksRedirectUri(): string {
    return (
      process.env.QB_REDIRECT_URI ||
      'http://localhost:3000/auth/quickbooks/callback'
    );
  }

  /**
   * FILE-BASED OAuth State Store
   *
   * WHY FILE-BASED instead of in-memory Map?
   * Dev servers hot-reload on file changes, clearing in-memory state.
   * The OAuth flow takes 5-15 seconds (user authorizes on Xero's site),
   * which is more than enough for a hot-reload to wipe the Map.
   *
   * In production, replace this with Redis or a DB table.
   * For now, a JSON file in .oauth-states/ survives restarts.
   */
  private readonly STATES_DIR = join(process.cwd(), '.oauth-states');
  private readonly STATE_TTL_MS = 15 * 60 * 1000; // 15 min

  private persistOAuthState(
    payload: Record<string, any>,
    customKey?: string,
  ): string {
    if (!existsSync(this.STATES_DIR))
      mkdirSync(this.STATES_DIR, { recursive: true });

    const stateToken = customKey || randomUUID();
    const filePath = join(this.STATES_DIR, `${stateToken}.json`);
    writeFileSync(
      filePath,
      JSON.stringify({
        data: payload,
        expiresAt: Date.now() + this.STATE_TTL_MS,
      }),
    );
    this.logger.debug(
      `[OAuth] State persisted to disk: ${stateToken.slice(0, 8)}...`,
    );
    return stateToken;
  }

  private consumeOAuthState(stateToken: string): Record<string, any> {
    if (!stateToken) {
      throw new BadRequestException(
        'Authorization session expired. Please try connecting again.',
      );
    }

    const filePath = join(this.STATES_DIR, `${stateToken}.json`);
    if (!existsSync(filePath)) {
      this.logger.warn(
        `[OAuth] State file not found for token: ${stateToken.slice(0, 8)}...`,
      );
      throw new BadRequestException(
        'Authorization session expired. Please try connecting again.',
      );
    }

    try {
      const raw = readFileSync(filePath, 'utf-8');
      const entry = JSON.parse(raw);

      // Cleanup: delete the file (single-use token)
      try {
        require('fs').unlinkSync(filePath);
      } catch {}

      if (Date.now() > entry.expiresAt) {
        throw new BadRequestException(
          'Authorization session expired. Please try connecting again.',
        );
      }

      const { tenantId, userId } = entry.data;
      if (
        !tenantId ||
        tenantId === 'undefined' ||
        !userId ||
        userId === 'undefined'
      ) {
        throw new BadRequestException(
          'Authorization context is invalid. Please log in again and retry.',
        );
      }
      return entry.data;
    } catch (e: any) {
      if (e instanceof BadRequestException) throw e;
      this.logger.error(`[OAuth] Failed to read state file: ${e.message}`);
      throw new BadRequestException(
        'Authorization session expired. Please try connecting again.',
      );
    }
  }

  @Post('xero/connect')
  @UseGuards(SupabaseAuthGuard)
  async connectXero(
    @CurrentUser() user: AuthUser,
    @Body() body: any,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const { organization } = await this.orgContext.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );
    const requestedStartDate = this.normalizeStartDateInput(body.startDate);

    try {
      // Generate our own state token for OIDC verification
      const oauthState = randomUUID();

      // Create XeroClient WITH the state — so apiCallback() can verify it
      const xero = this.getXeroClient(oauthState);
      const consentUrl = await xero.buildConsentUrl();

      // Store our context keyed by the same state token
      this.persistOAuthState(
        {
          tenantId: organization.id,
          userId: user.id,
          startDate: requestedStartDate,
        },
        oauthState,
      );

      return { url: consentUrl };
    } catch (e) {
      this.logger.error('Failed to init Xero oauth', e);
      throw new BadRequestException('Could not prepare Xero authorization.');
    }
  }

  @Post('quickbooks/connect')
  @UseGuards(SupabaseAuthGuard)
  async connectQuickBooks(
    @CurrentUser() user: AuthUser,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const { organization } = await this.orgContext.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );

    // Persist state server-side
    const stateToken = this.persistOAuthState({
      tenantId: organization.id,
      userId: user.id,
    });

    const url = new URL('https://appcenter.intuit.com/connect/oauth2');
    url.searchParams.set('client_id', process.env.QB_CLIENT_ID || '');
    url.searchParams.set('scope', 'com.intuit.quickbooks.accounting');
    url.searchParams.set('redirect_uri', this.getQuickBooksRedirectUri());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', stateToken);

    return { url: url.toString() };
  }

  /**
   * @deprecated — No longer needed. State is persisted server-side via oauthStates map.
   * Kept for backward compat but is a no-op.
   */
  @Post('persist-context')
  @UseGuards(SupabaseAuthGuard)
  async persistContext(@Res() res: Response) {
    return res.json({ success: true });
  }

  @Get('quickbooks/callback')
  async callbackQuickBooks(@Req() req: Request, @Res() res: Response) {
    const webAppUrl = process.env.WEB_APP_URL || 'http://localhost:3010';
    try {
      const { code, realmId, state } = req.query as Record<string, string>;
      const { tenantId, userId } = this.consumeOAuthState(state);

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
        const baseUrl =
          process.env.QB_ENVIRONMENT === 'production'
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
        this.logger.warn(
          `[QB] Could not fetch company name for realm ${realmId}: ${e.message}`,
        );
      }

      // 1. Persist the connection with encrypted tokens + org name in metadata
      const connection = await prisma.erpConnection.upsert({
        where: {
          organizationId_provider_externalOrganizationId: {
            organizationId: tenantId,
            provider: 'QUICKBOOKS',
            externalOrganizationId: realmId,
          },
        },
        update: {
          accessTokenEncrypted: this.crypto.encrypt(tokenRes.data.access_token),
          refreshTokenEncrypted: this.crypto.encrypt(tokenRes.data.refresh_token),
          status: 'ACTIVE',
          displayName: orgName,
          metadata: { orgName },
        },
        create: {
          organizationId: tenantId,
          createdById: userId,
          provider: 'QUICKBOOKS',
          externalOrganizationId: realmId,
          accessTokenEncrypted: this.crypto.encrypt(tokenRes.data.access_token),
          refreshTokenEncrypted: this.crypto.encrypt(tokenRes.data.refresh_token),
          status: 'ACTIVE',
          displayName: orgName,
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

      res.redirect(`${webAppUrl}/dashboard/integrations?success=quickbooks_connected`);
    } catch (e: any) {
      this.logger.error('QuickBooks callback failed', e);
      const userError =
        e.status === 400
          ? encodeURIComponent(e.response?.message || 'Connection expired')
          : 'quickbooks_connection_failed';
      res.redirect(`${webAppUrl}/dashboard/integrations?error=${userError}`);
    }
  }

  @Get('xero/callback')
  async callbackXero(@Req() req: Request, @Res() res: Response) {
    const webAppUrl = process.env.WEB_APP_URL || 'http://localhost:3010';
    try {
      const { state } = req.query as Record<string, string>;

      // Consume our context FIRST (before apiCallback, so we fail fast on expired state)
      const {
        tenantId: internalTenantId,
        userId,
        startDate,
      } = this.consumeOAuthState(state);

      // Create XeroClient with the SAME state for OIDC verification
      const apiUrl = process.env.API_URL || 'http://localhost:3000';
      const fullUrl = apiUrl + req.url;
      const xero = this.getXeroClient(state);
      const tokenSet = await xero.apiCallback(fullUrl);
      await xero.updateTenants();

      for (const xtenant of xero.tenants) {
        this.logger.log(
          `[Xero] Processing tenant: ${xtenant.tenantId} (${xtenant.tenantName})`,
        );

        const connection = await prisma.erpConnection.upsert({
          where: {
            organizationId_provider_externalOrganizationId: {
              organizationId: internalTenantId,
              provider: 'XERO',
              externalOrganizationId: xtenant.tenantId,
            },
          },
          update: {
            accessTokenEncrypted: this.crypto.encrypt(tokenSet.access_token!),
            refreshTokenEncrypted: tokenSet.refresh_token
              ? this.crypto.encrypt(tokenSet.refresh_token)
              : null,
            status: 'ACTIVE',
            displayName: xtenant.tenantName,
            metadata: { orgName: xtenant.tenantName },
          },
          create: {
            organizationId: internalTenantId,
            createdById: userId,
            provider: 'XERO',
            externalOrganizationId: xtenant.tenantId,
            accessTokenEncrypted: this.crypto.encrypt(tokenSet.access_token!),
            refreshTokenEncrypted: tokenSet.refresh_token
              ? this.crypto.encrypt(tokenSet.refresh_token)
              : null,
            status: 'ACTIVE',
            displayName: xtenant.tenantName,
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

      res.redirect(`${webAppUrl}/dashboard/integrations?success=xero_connected`);
    } catch (e: any) {
      this.logger.error('Xero callback failed', e);
      const userError =
        e.status === 400
          ? encodeURIComponent(e.response?.message || 'Connection expired')
          : 'xero_connection_failed';
      res.redirect(`${webAppUrl}/dashboard/integrations?error=${userError}`);
    }
  }

  @Post('workday/setup')
  @UseGuards(SupabaseAuthGuard)
  async setupWorkday(
    @CurrentUser() user: AuthUser,
    @Body() body: any,
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const { organization } = await this.orgContext.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );

    const connection = await prisma.erpConnection.upsert({
      where: {
        organizationId_provider_externalOrganizationId: {
          organizationId: organization.id,
          provider: 'WORKDAY',
          externalOrganizationId: body.workdayTenantId,
        },
      },
      update: {
        accessTokenEncrypted: 'N/A',
        refreshTokenEncrypted: this.crypto.encrypt(body.refreshToken),
        status: 'ACTIVE',
        metadata: this.crypto.encryptJson({ host: body.workdayHost }),
      },
      create: {
        organizationId: organization.id,
        createdById: user.id,
        provider: 'WORKDAY',
        externalOrganizationId: body.workdayTenantId,
        accessTokenEncrypted: 'N/A',
        refreshTokenEncrypted: this.crypto.encrypt(body.refreshToken),
        status: 'ACTIVE',
        metadata: this.crypto.encryptJson({ host: body.workdayHost }),
      },
    });

    // Background sync
    this.integrationsService
      .startIntegrationSync(
        organization.id,
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
    @Headers('x-organization-id') organizationId?: string,
  ) {
    const { organization } = await this.orgContext.ensureContext(
      { id: user.id, email: user.email },
      { organizationId },
    );
    this.logger.log(`Setting up Dynamics 365 for organization ${organization.id}`);

    // 1. Persist the connection with encrypted Client Secret
    const connection = await prisma.erpConnection.upsert({
      where: {
        organizationId_provider_externalOrganizationId: {
          organizationId: organization.id,
          provider: 'DYNAMICS365',
          externalOrganizationId: body.companyId,
        },
      },
      update: {
        accessTokenEncrypted: 'N/A', // Client credentials flow
        refreshTokenEncrypted: this.crypto.encrypt(body.clientSecret),
        status: 'ACTIVE',
        metadata: this.crypto.encryptJson({
          tenantId: body.microsoftTenantId,
          clientId: body.clientId,
          environment: body.environment,
          companyId: body.companyId,
        }),
      },
      create: {
        organizationId: organization.id,
        createdById: user.id,
        provider: 'DYNAMICS365',
        externalOrganizationId: body.companyId,
        accessTokenEncrypted: 'N/A',
        refreshTokenEncrypted: this.crypto.encrypt(body.clientSecret),
        status: 'ACTIVE',
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
        organization.id,
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
