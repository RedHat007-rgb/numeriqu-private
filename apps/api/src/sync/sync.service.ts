import {
  Injectable,
  Inject,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { spawn } from 'child_process';
import * as path from 'path';
import {
  PRISMA_TOKEN,
  CLICKHOUSE_ANALYTICS_TOKEN,
} from '../database/database.module';
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
    @Inject(CLICKHOUSE_ANALYTICS_TOKEN)
    private readonly chAnalytics: ClickHouseClient,
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
      // Column names match exactly what InlineTransformService writes.
      await safeQuery(`
        CREATE TABLE IF NOT EXISTS ${db}.fact_accounting_invoices (
          invoice_id           String,
          tenant_id            String,
          user_id              String         DEFAULT '',
          connection_id        String         DEFAULT '',
          provider             String         DEFAULT '',
          org_id               String         DEFAULT '',
          org_name             String         DEFAULT '',
          invoice_external_id  String         DEFAULT '',
          invoice_number       String         DEFAULT '',
          total_amount         Decimal(18,4)  DEFAULT 0,
          currency             String         DEFAULT '',
          issued_at            Nullable(DateTime),
          due_at               Nullable(DateTime),
          status               String         DEFAULT '',
          updated_at           DateTime       DEFAULT now(),
          synced_at            DateTime       DEFAULT now()
        ) ENGINE = ReplacingMergeTree()
        ORDER BY (tenant_id, org_id, invoice_id)
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

      // 6. Migrate existing tables — repairs old schema and adds all columns that
      //    InlineTransformService writes but the original DDL was missing.
      const migrations = [
        // ═══════════════════════════════════════════════════════════════════
        // CRITICAL: Convert ALL ID columns from UUID → String.
        // Xero uses UUIDs, but QuickBooks uses numeric IDs (e.g., "16").
        // String handles both. These are idempotent — safe to re-run.
        // ═══════════════════════════════════════════════════════════════════
        `ALTER TABLE ${db}.fact_accounting_invoices MODIFY COLUMN invoice_id String`,
        `ALTER TABLE ${db}.dim_accounting_accounts MODIFY COLUMN account_id String`,
        // Core column additions for fact_accounting_invoices
        `ALTER TABLE ${db}.fact_accounting_invoices ADD COLUMN IF NOT EXISTS user_id String DEFAULT ''`,
        `ALTER TABLE ${db}.fact_accounting_invoices ADD COLUMN IF NOT EXISTS connection_id String DEFAULT ''`,
        `ALTER TABLE ${db}.fact_accounting_invoices ADD COLUMN IF NOT EXISTS invoice_external_id String DEFAULT ''`,
        `ALTER TABLE ${db}.fact_accounting_invoices ADD COLUMN IF NOT EXISTS invoice_number String DEFAULT ''`,
        `ALTER TABLE ${db}.fact_accounting_invoices ADD COLUMN IF NOT EXISTS total_amount Decimal(18,4) DEFAULT 0`,
        `ALTER TABLE ${db}.fact_accounting_invoices ADD COLUMN IF NOT EXISTS issued_at Nullable(DateTime)`,
        `ALTER TABLE ${db}.fact_accounting_invoices ADD COLUMN IF NOT EXISTS due_at Nullable(DateTime)`,
        `ALTER TABLE ${db}.fact_accounting_invoices ADD COLUMN IF NOT EXISTS updated_at DateTime DEFAULT now()`,
        `ALTER TABLE ${db}.fact_accounting_invoices ADD COLUMN IF NOT EXISTS synced_at DateTime DEFAULT now()`,
        // Org-awareness columns
        `ALTER TABLE ${db}.fact_accounting_invoices ADD COLUMN IF NOT EXISTS org_id String DEFAULT ''`,
        `ALTER TABLE ${db}.fact_accounting_invoices ADD COLUMN IF NOT EXISTS org_name String DEFAULT ''`,
        `ALTER TABLE ${db}.dim_accounting_accounts ADD COLUMN IF NOT EXISTS org_id String DEFAULT ''`,
        `ALTER TABLE ${db}.dim_accounting_accounts ADD COLUMN IF NOT EXISTS org_name String DEFAULT ''`,
        `ALTER TABLE ${db}.revenue_by_month ADD COLUMN IF NOT EXISTS org_id String DEFAULT ''`,
        `ALTER TABLE ${db}.revenue_by_month ADD COLUMN IF NOT EXISTS org_name String DEFAULT ''`,
        `ALTER TABLE ${db}.revenue_by_month ADD COLUMN IF NOT EXISTS total_amount Decimal(18,4) DEFAULT 0`,
        `ALTER TABLE ${db}.revenue_by_month ADD COLUMN IF NOT EXISTS invoice_count UInt64 DEFAULT 0`,
        `ALTER TABLE ${db}.revenue_by_month ADD COLUMN IF NOT EXISTS updated_at DateTime DEFAULT now()`,
        `ALTER TABLE ${db}.revenue_by_month ADD COLUMN IF NOT EXISTS currency String DEFAULT ''`,
        // ═══════════════════════════════════════════════════════════════════
        // Schema rename migration: tables were originally created with
        // `organization_id` but all code now uses `tenant_id`.
        // ORDER BY key columns cannot be renamed, so we add tenant_id as a
        // new column and backfill from organization_id via a background mutation.
        // ═══════════════════════════════════════════════════════════════════
        `ALTER TABLE ${db}.fact_accounting_invoices ADD COLUMN IF NOT EXISTS tenant_id String DEFAULT ''`,
        `ALTER TABLE ${db}.revenue_by_month ADD COLUMN IF NOT EXISTS tenant_id String DEFAULT ''`,
        `ALTER TABLE ${db}.dim_accounting_accounts ADD COLUMN IF NOT EXISTS tenant_id String DEFAULT ''`,
        // Contact / client columns for client revenue analysis
        `ALTER TABLE ${db}.fact_accounting_invoices ADD COLUMN IF NOT EXISTS contact_id String DEFAULT ''`,
        `ALTER TABLE ${db}.fact_accounting_invoices ADD COLUMN IF NOT EXISTS contact_name String DEFAULT ''`,
      ];

      // ── dim_clients: one materialised row per client per entity ─────────────
      // Populated by InlineTransformService.upsertDimClients() on every sync.
      // ReplacingMergeTree(_version) allows idempotent upserts: each sync
      // overwrites the previous row for the same (tenant_id, org_id, provider,
      // client_id) via monotonically increasing _version.
      await safeQuery(`
        CREATE TABLE IF NOT EXISTS ${db}.dim_clients (
          client_id            String,
          client_name          String         DEFAULT '',
          provider             LowCardinality(String) DEFAULT '',
          tenant_id            String,
          org_id               String         DEFAULT '',
          org_name             String         DEFAULT '',
          currency             String         DEFAULT '',
          -- Lifetime billing across all invoice statuses
          total_invoiced       Float64        DEFAULT 0,
          -- Revenue = PAID / VOIDED / CLOSED invoices only
          total_revenue        Float64        DEFAULT 0,
          -- Outstanding = AUTHORISED/SENT not yet past due
          total_outstanding    Float64        DEFAULT 0,
          -- Overdue = AUTHORISED/SENT past the due date
          total_overdue        Float64        DEFAULT 0,
          -- Volume counts
          invoice_count        UInt32         DEFAULT 0,
          paid_count           UInt32         DEFAULT 0,
          outstanding_count    UInt32         DEFAULT 0,
          overdue_count        UInt32         DEFAULT 0,
          draft_count          UInt32         DEFAULT 0,
          -- Averages
          avg_invoice_amount   Float64        DEFAULT 0,
          -- Activity window
          first_invoice_date   Nullable(Date),
          last_invoice_date    Nullable(Date),
          -- Housekeeping
          updated_at           DateTime       DEFAULT now(),
          _version             UInt64         MATERIALIZED toUnixTimestamp64Milli(now64())
        ) ENGINE = ReplacingMergeTree(_version)
        ORDER BY (tenant_id, org_id, provider, client_id)
        SETTINGS index_granularity = 8192
      `);
      for (const migration of migrations) {
        try {
          await safeQuery(migration);
        } catch {
          /* column may already exist or incompatible type — safe to ignore */
        }
      }

      // Backfill tenant_id from organization_id only if the old column exists.
      // On fresh installs organization_id never existed — skip silently.
      const orgIdBackfills = [
        `ALTER TABLE ${db}.fact_accounting_invoices UPDATE tenant_id = organization_id WHERE tenant_id = ''`,
        `ALTER TABLE ${db}.revenue_by_month UPDATE tenant_id = organization_id WHERE tenant_id = ''`,
        `ALTER TABLE ${db}.dim_accounting_accounts UPDATE tenant_id = organization_id WHERE tenant_id = ''`,
      ];
      for (const backfill of orgIdBackfills) {
        try {
          // Check if organization_id column exists before running the backfill mutation.
          // On fresh installs this column does not exist and the UPDATE would log a
          // misleading ClickHouseError — suppress it completely.
          const table = backfill.match(/ALTER TABLE (\S+)/)?.[1] ?? '';
          if (table) {
            const colCheck = await this.chAnalytics.query({
              query: `SELECT name FROM system.columns WHERE table = {table:String} AND name = 'organization_id' AND database = {db:String}`,
              query_params: { table: table.replace(`${db}.`, ''), db },
              format: 'JSONEachRow',
            });
            const cols: any[] = await colCheck.json();
            if (cols.length === 0) continue; // column absent — skip silently
          }
          await safeQuery(backfill);
        } catch {
          /* non-fatal — organization_id may not exist on this install */
        }
      }

      // 7. One-time cleanup: purge stale rows written by the previous broken transform.
      //    Those rows had total_amount=0 and status='' because JSONExtract was using
      //    PascalCase keys on camelCase JSON (xero-node SDK serializes camelCase).
      //    ClickHouse mutations are async — they run in background and are safe to fire here.
      try {
        await safeQuery(
          `ALTER TABLE ${db}.fact_accounting_invoices DELETE WHERE total_amount = 0 AND status = ''`,
        );
        this.logger.log(
          `[Bootstrap] Stale zero-amount rows scheduled for cleanup`,
        );
      } catch {
        /* mutation may not be supported on this CH edition — non-fatal */
      }

      this.logger.log(
        `[Bootstrap] Full Gold Layer (org-aware) mechanized in ${db}`,
      );
    } catch (e: any) {
      this.logger.error(
        `[Bootstrap] Critical Initialization failure: ${e.message}`,
      );
    }
  }

  private async recoverOrphanedJobs() {
    try {
      const orphaned = await this.prisma.syncJob.findMany({
        where: { status: 'RUNNING' },
      });

      if (orphaned.length > 0) {
        this.logger.warn(
          `[Recovery] Found ${orphaned.length} orphaned sync jobs. Marking as failed.`,
        );
        await this.prisma.syncJob.updateMany({
          where: { status: 'RUNNING' },
          data: {
            status: 'FAILED',
            errorMessage: 'Terminated during restart.',
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
          organizationId: config.tenantId,
          triggerType: 'MANUAL',
          status: 'RUNNING',
          startedAt: new Date(),
        },
      });

      return {
        syncJobId: newJob.id,
        tenantId: newJob.organizationId,
        userId: config.userId,
        connectionId: newJob.connectionId,
        syncWindowStart: syncWindowStart,
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

  async completeSyncJob(
    jobId: string,
    recordsProcessed: number,
    orgId?: string,
    tenantId?: string,
    provider?: string,
  ) {
    try {
      await this.prisma.syncJob.update({
        where: { id: jobId },
        data: {
          status: 'SUCCEEDED',
          completedAt: new Date(),
          recordsWritten: recordsProcessed,
        },
      });

      // ── Inline Gold Layer Transform ────────────────────────────────────────
      // Fires immediately after ingestion completes — no subprocess, no debounce.
      // Falls back to dbt (scheduleDbtTransformation) if org/tenant context missing.
      if (
        orgId &&
        tenantId &&
        (provider === 'xero' || provider === 'quickbooks')
      ) {
        this.inlineTransform
          .transformForProvider(tenantId, orgId, provider)
          .catch((err) =>
            this.logger.error(
              `[Transform] Background transform failed: ${err.message}`,
            ),
          );
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
          status: 'FAILED',
          errorMessage: errorDetails,
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

    this.logger.log(
      `${logTag} Triggering transformation → ${dbtHost}/${dbtDatabase}`,
    );

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

    child.stdout?.on('data', (d) => {
      stdoutBuf += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderrBuf += d.toString();
    });

    child.on('close', (code) => {
      this.isDbtRunning = false;

      if (code === 0) {
        this.logger.log(`${logTag} ✓ Transformation completed successfully`);
        if (stdoutBuf) this.logger.debug(stdoutBuf.slice(-800));
      } else {
        this.logger.error(
          `${logTag} ✗ Transformation FAILED (exit code ${code})`,
        );
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
