import { Injectable, Inject, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { spawn } from 'child_process';
import * as path from 'path';
import { PRISMA_TOKEN, CLICKHOUSE_ANALYTICS_TOKEN } from '../database/database.module';
import { ClickHouseClient } from '@clickhouse/client';
import type { PrismaClient } from '@repo/db';
import { InlineTransformService } from './inline-transform.service';

export interface SyncJobConfig {
  syncJobId: string;
  tenantId: string;
  userId: string;
  connectionId: string;
  syncWindowStart: Date;
  /** The provider's own org/account identifier (e.g. Xero tenantId, QB realmId) */
  orgId: string;
  /** Human-readable org name fetched during OAuth and stored in connection.metadata */
  orgName: string;
  metadata?: any;
}

const DEFAULT_LOOKBACK_DAYS = Number(
  process.env.DEFAULT_SYNC_LOOKBACK_DAYS || '30',
);

const DBT_DEBOUNCE_MS = 5_000;

@Injectable()
export class SyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SyncService.name);

  private isDbtRunning = false;
  private dbtRunPending = false;
  private dbtDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    @Inject(CLICKHOUSE_ANALYTICS_TOKEN) private readonly chAnalytics: ClickHouseClient,
    private readonly inlineTransform: InlineTransformService,
  ) {}

  /**
   * On startup: 
   * 1. Bootstrap the Gold Layer (Create DB/Tables if missing)
   * 2. Recovery: Fail any orphaned jobs
   */
  async onModuleInit() {
    await this.bootstrapAnalyticsLayer();
    await this.recoverOrphanedJobs();
  }

  private async bootstrapAnalyticsLayer() {
    const db = process.env.CLICKHOUSE_ANALYTICS_DB || 'analytics';
    this.logger.log(`[Bootstrap] Verifying Gold Layer: ${db}`);
    
    try {
      // Helper: All @clickhouse/client responses MUST be consumed to close the socket
      const safeQuery = async (q: string) => {
        const res = await this.chAnalytics.query({ query: q });
        await res.text(); // Use .text() because DDL queries return empty strings, not JSON
      };

      // 1. Ensure Database exists
      await safeQuery(`CREATE DATABASE IF NOT EXISTS ${db}`);
      
      // 2. Ensure Gold Table (Revenue Trends) — org-aware
      await safeQuery(`
        CREATE TABLE IF NOT EXISTS ${db}.revenue_by_month (
          month Date,
          currency String,
          total_revenue Decimal(18,4),
          tenant_id String,
          provider String,
          org_id String DEFAULT '',
          org_name String DEFAULT ''
        ) ENGINE = ReplacingMergeTree()
        ORDER BY (month, currency, tenant_id, provider, org_id)
      `);

      // 3. Ensure Silver Table (Invoices List) — org-aware
      await safeQuery(`
        CREATE TABLE IF NOT EXISTS ${db}.fact_accounting_invoices (
          invoice_id String,
          customer_id String,
          amount Decimal(18,4),
          currency String,
          status String,
          issue_date Date,
          tenant_id String,
          provider String,
          org_id String DEFAULT '',
          org_name String DEFAULT ''
        ) ENGINE = ReplacingMergeTree()
        ORDER BY (issue_date, invoice_id, tenant_id)
      `);

      // 4. Ensure Dimension Table (Chart of Accounts) — org-aware
      await safeQuery(`
        CREATE TABLE IF NOT EXISTS ${db}.dim_accounting_accounts (
          account_id String,
          account_name String,
          account_type String,
          classification String,
          provider String,
          tenant_id String,
          org_id String DEFAULT '',
          org_name String DEFAULT '',
          is_active Bool
        ) ENGINE = ReplacingMergeTree()
        ORDER BY (account_id, tenant_id)
      `);

      // 5. Ensure RAG Context Table (Semantic Search)
      await safeQuery(`
        CREATE TABLE IF NOT EXISTS ${db}.rag_context_invoices (
          invoice_id String,
          text_content String,
          tenant_id String,
          metadata String
        ) ENGINE = ReplacingMergeTree()
        ORDER BY (invoice_id, tenant_id)
      `);

      // 6. Migrate existing tables: safely add org columns if they don't exist yet
      const migrations = [
        `ALTER TABLE ${db}.fact_accounting_invoices ADD COLUMN IF NOT EXISTS org_id String DEFAULT ''`,
        `ALTER TABLE ${db}.fact_accounting_invoices ADD COLUMN IF NOT EXISTS org_name String DEFAULT ''`,
        `ALTER TABLE ${db}.dim_accounting_accounts ADD COLUMN IF NOT EXISTS org_id String DEFAULT ''`,
        `ALTER TABLE ${db}.dim_accounting_accounts ADD COLUMN IF NOT EXISTS org_name String DEFAULT ''`,
        `ALTER TABLE ${db}.revenue_by_month ADD COLUMN IF NOT EXISTS org_id String DEFAULT ''`,
        `ALTER TABLE ${db}.revenue_by_month ADD COLUMN IF NOT EXISTS org_name String DEFAULT ''`,
      ];
      for (const migration of migrations) {
        try { await safeQuery(migration); } catch { /* column may already exist */ }
      }

      this.logger.log(`[Bootstrap] Full Gold Layer (org-aware) mechanized in ${db}`);
    } catch (e: any) {
      this.logger.error(`[Bootstrap] Critical Initialization failure: ${e.message}`);
    }
  }

  private async recoverOrphanedJobs() {
    try {
      const orphaned = await this.prisma.syncJob.findMany({
        where: { status: 'running' },
      });

      if (orphaned.length > 0) {
        this.logger.warn(
          `[Recovery] Found ${orphaned.length} orphaned sync jobs. Marking as failed.`,
        );
        await this.prisma.syncJob.updateMany({
          where: { status: 'running' },
          data: {
            status: 'failed',
            errorDetails: 'Terminated during process restart. Please re-sync.',
            completedAt: new Date(),
          },
        });
      }
    } catch (e: any) {
      this.logger.warn(`[Recovery] Error: ${e.message}`);
    }
  }

  onModuleDestroy() {
    if (this.dbtDebounceTimer) clearTimeout(this.dbtDebounceTimer);
  }

  async createSyncJob(
    config: Omit<SyncJobConfig, 'syncJobId' | 'syncWindowStart'> & {
      provider: string;
    },
  ): Promise<SyncJobConfig> {
    try {
      const overrideWindow = config.metadata?.syncWindowStart
        ? new Date(config.metadata.syncWindowStart)
        : null;
      const lookbackDays =
        typeof config.metadata?.lookbackDays === 'number'
          ? config.metadata.lookbackDays
          : DEFAULT_LOOKBACK_DAYS;
      const fullSync = !overrideWindow;
      const defaultWindow = new Date(
        Date.now() - lookbackDays * 24 * 60 * 60 * 1000,
      );
      const syncWindowStart =
        overrideWindow || (fullSync ? new Date(0) : defaultWindow);

      const newJob = await this.prisma.syncJob.create({
        data: {
          connectionId: config.connectionId,
          tenantId: config.tenantId,
          provider: config.provider,
          status: 'running',
          startedAt: new Date(),
          syncWindowStart: syncWindowStart,
        },
      });

      return {
        syncJobId: newJob.id,
        tenantId: newJob.tenantId,
        userId: config.userId,
        connectionId: newJob.connectionId,
        syncWindowStart: newJob.syncWindowStart!,
        orgId: config.orgId,
        orgName: config.orgName,
        metadata: config.metadata,
      };
    } catch (error) {
      this.logger.error(
        `Error creating sync job for connection ${config.connectionId}`,
        error,
      );
      throw error;
    }
  }

  async completeSyncJob(jobId: string, recordsProcessed: number, orgId?: string, tenantId?: string, provider?: string) {
    try {
      await this.prisma.syncJob.update({
        where: { id: jobId },
        data: {
          status: 'completed',
          completedAt: new Date(),
          recordsProcessed: recordsProcessed,
        },
      });

      // ── Inline Gold Layer Transform ────────────────────────────────────────
      // Fires immediately after ingestion completes — no subprocess, no debounce.
      // Falls back to dbt (scheduleDbtTransformation) if org/tenant context missing.
      if (orgId && tenantId && (provider === 'xero' || provider === 'quickbooks')) {
        this.inlineTransform
          .transformForProvider(tenantId, orgId, provider)
          .catch((err) => this.logger.error(`[Transform] Background transform failed: ${err.message}`));
      } else {
        // Legacy fallback for providers that don't pass orgId yet
        this.scheduleDbtTransformation();
      }
    } catch (error) {
      this.logger.error(`Failed to complete sync job ${jobId}`, error);
      throw error;
    }
  }

  async failSyncJob(jobId: string, errorDetails: string) {
    try {
      await this.prisma.syncJob.update({
        where: { id: jobId },
        data: {
          status: 'failed',
          errorDetails: errorDetails,
          completedAt: new Date(),
        },
      });
    } catch (error) {
      this.logger.error(`Failed to mark sync job ${jobId} as failed`, error);
      throw error;
    }
  }

  /**
   * Debounced dbt trigger — waits 5s after last sync completes before running.
   * Multiple concurrent syncs (QB + Xero finishing together) only trigger dbt once.
   */
  private scheduleDbtTransformation() {
    if (this.dbtDebounceTimer) {
      clearTimeout(this.dbtDebounceTimer);
    }

    this.dbtDebounceTimer = setTimeout(() => {
      this.dbtDebounceTimer = null;
      this.executeDbtTransformation();
    }, DBT_DEBOUNCE_MS);
  }

  /**
   * ROOT CAUSE FIX for dbt transformation not running:
   *
   * 1. Uses spawn() instead of exec() — properly handles stdout/stderr streams
   * 2. Injects env vars directly into child process ENV (bypasses buggy 
   *    `export $(cat .env | xargs)` which breaks on quoted values)
   * 3. Extracts host from CLICKHOUSE_ANALYTICS_URL (already set in API .env)
   *    so dbt always connects to the correct live ClickHouse host
   */
  private executeDbtTransformation() {
    if (this.isDbtRunning) {
      this.dbtRunPending = true;
      this.logger.log('[dbt] Already running — queuing follow-up run.');
      return;
    }

    this.isDbtRunning = true;
    const analyticsPath = path.join(process.cwd(), '../../packages/analytics');
    const logTag = '[dbt]';

    // Extract host from CLICKHOUSE_ANALYTICS_URL: "http://16.170.219.133:8123" → "16.170.219.133"
    const analyticsUrl = process.env.CLICKHOUSE_ANALYTICS_URL!;
    const dbtHost = analyticsUrl.replace(/^https?:\/\//, '').split(':')[0];
    const dbtUser = process.env.CLICKHOUSE_ANALYTICS_USER!;
    const dbtPassword = process.env.CLICKHOUSE_ANALYTICS_PASSWORD || '';
    const dbtDatabase = process.env.CLICKHOUSE_ANALYTICS_DB!;

    this.logger.log(`${logTag} Triggering transformation → ${dbtHost}/${dbtDatabase}`);

    const child = spawn('pnpm', ['run', 'sync'], {
      cwd: analyticsPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Inject directly — no broken xargs/export
        DBT_CLICKHOUSE_HOST: dbtHost,
        DBT_CLICKHOUSE_USER: dbtUser,
        DBT_CLICKHOUSE_PASSWORD: dbtPassword,
        DBT_CLICKHOUSE_DB: dbtDatabase,
        PATH: process.env.PATH || '',
      },
    });

    let stdoutBuf = '';
    let stderrBuf = '';

    child.stdout?.on('data', (d) => { stdoutBuf += d.toString(); });
    child.stderr?.on('data', (d) => { stderrBuf += d.toString(); });

    child.on('close', (code) => {
      this.isDbtRunning = false;

      if (code === 0) {
        this.logger.log(`${logTag} ✓ Transformation completed successfully`);
        if (stdoutBuf) this.logger.debug(stdoutBuf.slice(-800));
      } else {
        this.logger.error(`${logTag} ✗ Transformation FAILED (exit code ${code})`);
        if (stderrBuf) this.logger.error(stderrBuf.slice(-1500));
        if (stdoutBuf) this.logger.debug(stdoutBuf.slice(-800));
      }

      if (this.dbtRunPending) {
        this.dbtRunPending = false;
        this.logger.log(`${logTag} Running queued follow-up transformation...`);
        this.executeDbtTransformation();
      }
    });

    child.on('error', (err) => {
      this.isDbtRunning = false;
      this.logger.error(`${logTag} Failed to start: ${err.message}`);
      this.logger.error(
        `Setup dbt: cd packages/analytics && python3 -m venv dbt_venv && ./dbt_venv/bin/pip install dbt-clickhouse`,
      );
    });
  }
}
