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
import type { Prisma, PrismaClient } from '@repo/db';
import { InlineTransformService } from './inline-transform.service';
import {
  buildSfinSemanticCubeDdls,
  SFIN_SEMANTIC_CUBE_VIEWS,
} from '../modules/chart-engine/sfin-semantic-cubes';

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

const INCREMENTAL_SAFETY_LOOKBACK_HOURS = Number(
  process.env.SYNC_SAFETY_LOOKBACK_HOURS || '48',
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
          amount_due           Decimal(18,4)  DEFAULT 0,
          amount_paid          Decimal(18,4)  DEFAULT 0,
          amount_credited      Decimal(18,4)  DEFAULT 0,
          currency             String         DEFAULT '',
          issued_at            Nullable(DateTime),
          due_at               Nullable(DateTime),
          paid_at              Nullable(DateTime),
          status               String         DEFAULT '',
          invoice_type         String         DEFAULT '',
          contact_id           String         DEFAULT '',
          contact_name         String         DEFAULT '',
          updated_at           DateTime       DEFAULT now(),
          synced_at            DateTime       DEFAULT now()
        ) ENGINE = ReplacingMergeTree()
        ORDER BY (tenant_id, org_id, invoice_id)
      `);

      // 3b. Payment applications fact table — needed for accurate collections + as-of balances
      await safeQuery(`
        CREATE TABLE IF NOT EXISTS ${db}.fact_accounting_payment_applications (
          payment_id     String,
          tenant_id      String,
          user_id        String         DEFAULT '',
          connection_id  String         DEFAULT '',
          provider       String         DEFAULT '',
          org_id         String         DEFAULT '',
          org_name       String         DEFAULT '',
          invoice_external_id String     DEFAULT '',
          payment_at     Nullable(DateTime),
          amount         Decimal(18,4)  DEFAULT 0,
          currency       String         DEFAULT '',
          updated_at     DateTime       DEFAULT now(),
          synced_at      DateTime       DEFAULT now()
        ) ENGINE = ReplacingMergeTree()
        ORDER BY (tenant_id, org_id, provider, invoice_external_id, payment_id)
      `);

      // 3c. Journal lines fact table — CFO-grade P&L / margin / expense / vendor / department analytics.
      // Populated by InlineTransformService.upsertFactJournalLines() for both Xero and QuickBooks.
      await safeQuery(`
        CREATE TABLE IF NOT EXISTS ${db}.fact_accounting_journal_lines (
          journal_id      String,
          journal_number  UInt64        DEFAULT 0,
          journal_date    Nullable(DateTime),
          source_type     String        DEFAULT '',
          source_id       String        DEFAULT '',
          line_id         String        DEFAULT '',
          account_id      String        DEFAULT '',
          account_code    String        DEFAULT '',
          account_name    String        DEFAULT '',
          line_amount     Decimal(18,4) DEFAULT 0,
          description     String        DEFAULT '',
          department      String        DEFAULT '',
          class_name      String        DEFAULT '',
          vendor_name     String        DEFAULT '',
          vendor_id       String        DEFAULT '',
          debit_amount    Decimal(18,4) DEFAULT 0,
          credit_amount   Decimal(18,4) DEFAULT 0,
          tenant_id       String,
          user_id         String        DEFAULT '',
          connection_id   String        DEFAULT '',
          provider        String        DEFAULT '',
          org_id          String        DEFAULT '',
          org_name        String        DEFAULT '',
          updated_at      DateTime      DEFAULT now(),
          synced_at       DateTime      DEFAULT now()
        ) ENGINE = ReplacingMergeTree()
        ORDER BY (tenant_id, org_id, provider, journal_id, line_id)
      `);

      // 3d. Cost classification mapping — user-maintained categories for journal lines.
      // This enables queries like "admin expenses" consistently across Power BI + Agents.
      await safeQuery(`
        CREATE TABLE IF NOT EXISTS ${db}.map_account_cost_categories (
          tenant_id        String,
          org_id           String         DEFAULT '',
          provider         LowCardinality(String) DEFAULT '',
          account_code     String         DEFAULT '',
          pnl_group        LowCardinality(String) DEFAULT '',
          opex_category    LowCardinality(String) DEFAULT '',
          cost_nature      LowCardinality(String) DEFAULT '',
          is_admin_cost    UInt8          DEFAULT 0,
          notes            String         DEFAULT '',
          updated_at       DateTime       DEFAULT now(),
          _version         UInt64         MATERIALIZED toUnixTimestamp64Milli(now64())
        ) ENGINE = ReplacingMergeTree(_version)
        ORDER BY (tenant_id, org_id, provider, account_code)
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
        // Payment-derived fields for collections + as-of balances
        `ALTER TABLE ${db}.fact_accounting_invoices ADD COLUMN IF NOT EXISTS amount_due Decimal(18,4) DEFAULT 0`,
        `ALTER TABLE ${db}.fact_accounting_invoices ADD COLUMN IF NOT EXISTS amount_paid Decimal(18,4) DEFAULT 0`,
        `ALTER TABLE ${db}.fact_accounting_invoices ADD COLUMN IF NOT EXISTS amount_credited Decimal(18,4) DEFAULT 0`,
        `ALTER TABLE ${db}.fact_accounting_invoices ADD COLUMN IF NOT EXISTS paid_at Nullable(DateTime)`,
        `ALTER TABLE ${db}.fact_accounting_invoices ADD COLUMN IF NOT EXISTS invoice_type String DEFAULT ''`,
        // Payment applications join key (provider invoice id)
        `ALTER TABLE ${db}.fact_accounting_payment_applications ADD COLUMN IF NOT EXISTS invoice_external_id String DEFAULT ''`,
        // Cost classification mapping evolvability
        `ALTER TABLE ${db}.map_account_cost_categories ADD COLUMN IF NOT EXISTS pnl_group LowCardinality(String) DEFAULT ''`,
        `ALTER TABLE ${db}.map_account_cost_categories ADD COLUMN IF NOT EXISTS opex_category LowCardinality(String) DEFAULT ''`,
        `ALTER TABLE ${db}.map_account_cost_categories ADD COLUMN IF NOT EXISTS cost_nature LowCardinality(String) DEFAULT ''`,
        `ALTER TABLE ${db}.map_account_cost_categories ADD COLUMN IF NOT EXISTS is_admin_cost UInt8 DEFAULT 0`,
        `ALTER TABLE ${db}.map_account_cost_categories ADD COLUMN IF NOT EXISTS notes String DEFAULT ''`,
        `ALTER TABLE ${db}.map_account_cost_categories ADD COLUMN IF NOT EXISTS updated_at DateTime DEFAULT now()`,
        // Dimension columns for department / class / vendor analytics (QB + Xero)
        `ALTER TABLE ${db}.fact_accounting_journal_lines ADD COLUMN IF NOT EXISTS department String DEFAULT ''`,
        `ALTER TABLE ${db}.fact_accounting_journal_lines ADD COLUMN IF NOT EXISTS class_name String DEFAULT ''`,
        `ALTER TABLE ${db}.fact_accounting_journal_lines ADD COLUMN IF NOT EXISTS vendor_name String DEFAULT ''`,
        `ALTER TABLE ${db}.fact_accounting_journal_lines ADD COLUMN IF NOT EXISTS vendor_id String DEFAULT ''`,
        `ALTER TABLE ${db}.fact_accounting_journal_lines ADD COLUMN IF NOT EXISTS debit_amount Decimal(18,4) DEFAULT 0`,
        `ALTER TABLE ${db}.fact_accounting_journal_lines ADD COLUMN IF NOT EXISTS credit_amount Decimal(18,4) DEFAULT 0`,
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

            // If tenant_id is part of the sorting key, ClickHouse forbids updating it.
            // This backfill only matters for very old installs; for modern schemas
            // tenant_id should already be populated at write time.
            const keyCheck = await this.chAnalytics.query({
              query: `SELECT sorting_key FROM system.tables WHERE database = {db:String} AND name = {table:String}`,
              query_params: { db, table: table.replace(`${db}.`, '') },
              format: 'JSONEachRow',
            });
            const keys: any[] = await keyCheck.json();
            const sortingKey = String(keys[0]?.sorting_key ?? '');
            if (/\btenant_id\b/i.test(sortingKey)) continue; // would error with CANNOT_UPDATE_COLUMN
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

      // 8. Convenience views for deterministic "latest" reads + cost categorisation.
      // These are safe even on plain MergeTree deployments.
      try {
        const vJournalLatest = `
          CREATE OR REPLACE VIEW ${db}.v_fact_accounting_journal_lines_latest AS
          SELECT
            tenant_id,
            org_id,
            provider,
            journal_id,
            line_id,
            argMax(journal_number, jl.updated_at)  AS journal_number,
            argMax(journal_date,   jl.updated_at)  AS journal_date,
            argMax(source_type,    jl.updated_at)  AS source_type,
            argMax(source_id,      jl.updated_at)  AS source_id,
            argMax(account_id,     jl.updated_at)  AS account_id,
            argMax(account_code,   jl.updated_at)  AS account_code,
            argMax(account_name,   jl.updated_at)  AS account_name,
            argMax(line_amount,    jl.updated_at)  AS line_amount,
            argMax(debit_amount,   jl.updated_at)  AS debit_amount,
            argMax(credit_amount,  jl.updated_at)  AS credit_amount,
            argMax(description,    jl.updated_at)  AS description,
            argMax(department,     jl.updated_at)  AS department,
            argMax(class_name,     jl.updated_at)  AS class_name,
            argMax(vendor_name,    jl.updated_at)  AS vendor_name,
            argMax(vendor_id,      jl.updated_at)  AS vendor_id,
            argMax(user_id,        jl.updated_at)  AS user_id,
            argMax(connection_id,  jl.updated_at)  AS connection_id,
            argMax(org_name,       jl.updated_at)  AS org_name,
            max(jl.updated_at)                     AS updated_at,
            max(jl.synced_at)                      AS synced_at
          FROM ${db}.fact_accounting_journal_lines AS jl
          GROUP BY tenant_id, org_id, provider, journal_id, line_id
        `;
        try {
          await safeQuery(vJournalLatest);
        } catch {
          await safeQuery(
            vJournalLatest.replace(
              /CREATE\s+OR\s+REPLACE\s+VIEW/i,
              'CREATE VIEW IF NOT EXISTS',
            ),
          );
        }

        const vMapLatest = `
          CREATE OR REPLACE VIEW ${db}.v_map_account_cost_categories_latest AS
          SELECT
            tenant_id,
            org_id,
            provider,
            account_code,
            argMax(pnl_group,     mac.updated_at) AS pnl_group,
            argMax(opex_category, mac.updated_at) AS opex_category,
            argMax(cost_nature,   mac.updated_at) AS cost_nature,
            argMax(is_admin_cost, mac.updated_at) AS is_admin_cost,
            argMax(notes,         mac.updated_at) AS notes,
            max(mac.updated_at)                  AS updated_at
          FROM ${db}.map_account_cost_categories AS mac
          GROUP BY tenant_id, org_id, provider, account_code
        `;
        try {
          await safeQuery(vMapLatest);
        } catch {
          await safeQuery(
            vMapLatest.replace(
              /CREATE\s+OR\s+REPLACE\s+VIEW/i,
              'CREATE VIEW IF NOT EXISTS',
            ),
          );
        }

        const vEnrichedLatest = `
          CREATE OR REPLACE VIEW ${db}.v_fact_accounting_journal_lines_enriched_latest AS
          SELECT
            j.*,
            coalesce(nullIf(m.pnl_group,     ''), '') AS pnl_group,
            coalesce(nullIf(m.opex_category, ''), '') AS opex_category,
            coalesce(nullIf(m.cost_nature,   ''), '') AS cost_nature,
            toUInt8(coalesce(m.is_admin_cost, 0))     AS is_admin_cost
          FROM ${db}.v_fact_accounting_journal_lines_latest AS j
          LEFT JOIN ${db}.v_map_account_cost_categories_latest AS m
            ON m.tenant_id = j.tenant_id
           AND m.org_id    = j.org_id
           AND m.provider  = j.provider
           AND m.account_code = j.account_code
        `;
        try {
          await safeQuery(vEnrichedLatest);
        } catch {
          await safeQuery(
            vEnrichedLatest.replace(
              /CREATE\s+OR\s+REPLACE\s+VIEW/i,
              'CREATE VIEW IF NOT EXISTS',
            ),
          );
        }

        const vUnmapped = `
          CREATE OR REPLACE VIEW ${db}.v_unmapped_cost_category_accounts AS
          SELECT
            j.tenant_id,
            j.org_id,
            j.provider,
            j.account_code,
            argMax(j.account_name, j.updated_at) AS account_name,
            round(sumIf(j.line_amount, j.line_amount > 0), 0) AS total_spend
          FROM ${db}.v_fact_accounting_journal_lines_latest AS j
          LEFT JOIN ${db}.v_map_account_cost_categories_latest AS m
            ON m.tenant_id = j.tenant_id
           AND m.org_id    = j.org_id
           AND m.provider  = j.provider
           AND m.account_code = j.account_code
          WHERE j.account_code != ''
            AND j.journal_date IS NOT NULL
            AND j.line_amount > 0
            AND m.account_code = ''
          GROUP BY j.tenant_id, j.org_id, j.provider, j.account_code
          ORDER BY total_spend DESC
        `;
        try {
          await safeQuery(vUnmapped);
        } catch {
          await safeQuery(
            vUnmapped.replace(
              /CREATE\s+OR\s+REPLACE\s+VIEW/i,
              'CREATE VIEW IF NOT EXISTS',
            ),
          );
        }
      } catch {
        /* views optional — non-fatal */
      }

      // 9. If the registered star-finance schema is present, expose coherent
      // semantic cubes and make the registry point to them. The old registry
      // used narrow monthly views that dropped valid workbook dimensions (for
      // example service_line, aging_bucket, employee grade, and geography), so
      // Astra honestly refused questions even though the source facts existed.
      try {
        const requiredTables = [
          'sfin_fact_general_ledger',
          'sfin_fact_payroll',
          'sfin_fact_operations',
          'sfin_fact_attendance',
          'sfin_fact_accounts_receivable',
          'sfin_fact_accounts_payable',
          'sfin_fact_cash_flow',
          'sfin_fact_trial_balance',
          'sfin_dim_employee',
        ];
        const presentResult = await this.chAnalytics.query({
          query:
            'SELECT count() AS n FROM system.tables ' +
            'WHERE database = {db:String} AND name IN ({tables:Array(String)})',
          query_params: { db, tables: requiredTables },
          format: 'JSONEachRow',
        });
        const [present] = (await presentResult.json()) as Array<{ n: string | number }>;
        if (Number(present?.n ?? 0) === requiredTables.length) {
          const discoverValues = async (table: string, column: string): Promise<string[]> => {
            const result = await this.chAnalytics.query({
              query:
                `SELECT groupUniqArray(toString(${column})) AS values FROM ${db}.${table} ` +
                `WHERE notEmpty(toString(${column}))`,
              format: 'JSONEachRow',
            });
            const [row] = (await result.json()) as Array<{ values?: unknown }>;
            return Array.isArray(row?.values)
              ? row.values.filter((value): value is string => typeof value === 'string')
              : [];
          };
          const [cashFlowCategories, accountSubTypes, glCostCategories] = await Promise.all([
            discoverValues('sfin_fact_cash_flow', 'cash_flow_category'),
            discoverValues('sfin_dim_account', 'account_sub_type'),
            discoverValues('sfin_fact_general_ledger', 'cost_category'),
          ]);
          for (const ddl of buildSfinSemanticCubeDdls(db, {
            cashFlowCategories,
            accountSubTypes,
            glCostCategories,
          })) await safeQuery(ddl);

          const datasets = await this.prisma.dataset.findMany({ where: { kind: 'sfin' } });
          for (const dataset of datasets) {
            const current = (dataset.physicalSchema ?? {}) as Record<string, unknown>;
            await this.prisma.dataset.update({
              where: { id: dataset.id },
              data: {
                physicalSchema: {
                  ...current,
                  cubeViews: [...SFIN_SEMANTIC_CUBE_VIEWS],
                } as Prisma.InputJsonValue,
                introspectedAt: new Date(),
              },
            });
          }
          this.logger.log(
            `[Bootstrap] Registered ${SFIN_SEMANTIC_CUBE_VIEWS.length} star-finance semantic cubes`,
          );
        }
      } catch (error) {
        this.logger.warn(
          `[Bootstrap] Star-finance semantic cubes unavailable: ${(error as Error).message}`,
        );
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
      const fullSync =
        config.metadata?.fullSync === true ||
        config.metadata?.mode === 'FULL' ||
        config.metadata?.syncMode === 'FULL';
      const overrideWindow = config.metadata?.syncWindowStart
        ? new Date(config.metadata.syncWindowStart)
        : null;
      const lookbackDays =
        typeof config.metadata?.lookbackDays === 'number'
          ? config.metadata.lookbackDays
          : DEFAULT_LOOKBACK_DAYS;
      const defaultWindow = new Date(
        Date.now() - lookbackDays * 24 * 60 * 60 * 1000,
      );
      const lastSuccessful = await this.prisma.syncJob.findFirst({
        where: {
          connectionId: config.connectionId,
          status: 'SUCCEEDED',
          completedAt: { not: null },
        },
        orderBy: { completedAt: 'desc' },
        select: { completedAt: true },
      });

      const safetyLookbackHours =
        typeof config.metadata?.safetyLookbackHours === 'number'
          ? config.metadata.safetyLookbackHours
          : INCREMENTAL_SAFETY_LOOKBACK_HOURS;

      const incrementalWindow = lastSuccessful?.completedAt
        ? new Date(
            lastSuccessful.completedAt.getTime() -
              Math.max(0, safetyLookbackHours) * 60 * 60 * 1000,
          )
        : null;

      const syncWindowStart = fullSync
        ? new Date(0)
        : overrideWindow ||
          // Prefer last-successful sync for true incremental behavior.
          // Still clamp to defaultWindow so we don't accidentally request *too much* history
          // if completedAt is missing or far in the past.
          (incrementalWindow && incrementalWindow > defaultWindow
            ? incrementalWindow
            : defaultWindow);

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
