import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { PrismaClient, Prisma } from '@repo/db';
import {
  CLICKHOUSE_ANALYTICS_TOKEN,
  PRISMA_TOKEN,
} from '../../database/database.module';
import type { ClickHouseClient } from '@clickhouse/client';
import { OrganizationContextService } from '../org-context/org-context.service';
import { parseQuerySpec, type QuerySpec, type TimeRange } from './query-spec';
import {
  injectTenantScopePredicate,
  rewriteRelativeNowToAsOf,
  sqlUsesNowOrToday,
  validateDynamicSql,
} from './dynamic-sql';
import {
  getLlmProviderLabel,
  resolveLlmRuntimeConfig,
  type LlmProvider,
} from '../../common/llm/llm-config';
import {
  CATALOG,
  catalogPromptText,
  compileSpec,
  type ChartSpec,
} from './chart-spec';
import {
  EBPO_DIMENSIONS,
  EBPO_MEASURES,
  EBPO_VIEWS,
  compileEbpoSpec,
  ebpoCatalogPromptText,
  resolveEbpoViewMulti,
} from './chart-spec-ebpo';
import {
  PLANNER_SYSTEM,
  PLANNER_SCHEMA,
  EDITOR_SYSTEM,
  SPEC_PLANNER_SYSTEM,
  SPEC_EDITOR_SYSTEM,
  SMART_SQL_EDITOR_SYSTEM,
  EDITOR_SCHEMA,
  ANALYTICS_SCHEMA_CONTEXT,
  DYNAMIC_SQL_SYSTEM,
  SMART_SQL_PLANNER_SYSTEM,
} from './agent-prompts';
import { VALID_WIDGETS } from './agent-widget-catalog';
import type {
  OrgScope,
  MembershipRole,
  PivotAxis,
  ChartType,
  ToolResult,
  AgentPlan,
  SmartPlanResult,
  DashboardEditPlan,
  DeleteChartTarget,
  DisplayHints,
  SecondMeasure,
  FollowUpTransform,
  UnsupportedFeature,
  ActiveDashboard,
  ChartTurnMode,
  ChartTurnWidgetSnapshot,
  ChartTurnMetadata,
  QueryIntent,
  ClarificationPrompt,
  ExplicitChartConstraints,
  ClientResolution,
  EntityResolution,
} from './agent.types';

// ─── Types ────────────────────────────────────────────────────────────────────

// --- domain types extracted to ./agent.types.ts ---

const SAFE_QUERY = { max_memory_usage: '536870912', max_execution_time: 20 };

// Single ceiling for all heavy LLM chat completions (planner / editor / smart-SQL).
// Health-check pings to /api/tags keep their own short (2.5–5s) timeouts. This
// constant replaces the prior ad-hoc 300_000 (5 min) and 120_000 ceilings so a
// single hung completion can no longer stall a request for minutes. Note: this is
// a CEILING, not a latency target — real latency wins come from caching/parallelism.
const LLM_CHAT_TIMEOUT_MS = 120 * 1000;

// ─── Valid widget configurations ─────────────────────────────────────────────
// These are the ONLY supported metric+grouping pairs the agent can use.

// ─── Complete chart vocabulary — every (type, metric, grouping) pair the
// system can serve. Ollama picks freely from this list; the frontend renders any.
// --- VALID_WIDGETS extracted to ./agent-widget-catalog.ts ---

// ─── Planning Prompt — minimal for fast Ollama inference ─────────────────────
// Small context + small output = fast response, no timeouts.

// ─── Planner Prompt — Ollama is the sole dashboard architect.
// It receives live data context + full chart vocabulary and decides freely.
// NO hardcoded chart selection happens before this prompt runs.

// --- LLM prompt + schema constants extracted to ./agent-prompts.ts ---

// ─── AgentService ─────────────────────────────────────────────────────────────

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly OLLAMA_URL: string;
  private readonly OLLAMA_MODEL: string;
  private readonly llmProvider: LlmProvider;
  private readonly analyticsDb: string;
  private analyticsSchemaEnsured = false;
  private analyticsSchemaEnsurePromise: Promise<void> | null = null;
  private readonly smartPlanCache = new Map<
    string,
    { result: SmartPlanResult; at: number }
  >();
  private readonly asOfCache = new Map<
    string,
    { asOfIso: string | null; expiresAt: number }
  >();
  private readonly SMART_PLAN_CACHE_TTL_MS = 10 * 60 * 1000;

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    @Inject(CLICKHOUSE_ANALYTICS_TOKEN)
    private readonly clickhouse: ClickHouseClient,
    private readonly orgContext: OrganizationContextService,
  ) {
    const llm = resolveLlmRuntimeConfig('llama3:latest');
    this.llmProvider = llm.provider;
    this.OLLAMA_URL = llm.url;
    this.OLLAMA_MODEL = llm.model;
    this.analyticsDb = process.env.CLICKHOUSE_ANALYTICS_DB || 'analytics';
  }

  private scopeKey(scope: OrgScope): string {
    const orgs = (scope.externalOrgIds ?? []).slice().sort().join(',');
    return `${scope.tenantId}::${orgs}`;
  }

  private isStaleAsOf(asOfIso: string): boolean {
    // If data is materially in the past, treat asOf as the "now" anchor for demo/stale datasets.
    // This avoids empty "last N months" and nonsensical "everything is overdue" in seeded sample data.
    const d = new Date(`${asOfIso}T00:00:00Z`);
    if (Number.isNaN(d.valueOf())) return false;
    const ageDays = (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
    return ageDays >= 45;
  }

  private async resolveAsOfIso(scope: OrgScope): Promise<string | null> {
    if (!scope.externalOrgIds || scope.externalOrgIds.length === 0) return null;
    const key = this.scopeKey(scope);
    const cached = this.asOfCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.asOfIso;

    try {
      const rows = await this.queryRows<{ as_of: string | null }>(
        `SELECT
           formatDateTime(max(max_dt), '%Y-%m-%d') AS as_of
         FROM (
           SELECT max(issued_at) AS max_dt
           FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
           WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})
             AND issued_at IS NOT NULL
           UNION ALL
           SELECT max(journal_date) AS max_dt
           FROM ${this.analyticsDb}.v_fact_accounting_journal_lines_latest
           WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})
             AND journal_date IS NOT NULL
           UNION ALL
           SELECT toDateTime(max(date)) AS max_dt
           FROM ${this.analyticsDb}.sample_gl_dump
           WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})
             AND date IS NOT NULL
         )`,
        { tenantId: scope.tenantId, externalOrgIds: scope.externalOrgIds },
      );
      const asOfIso = (rows?.[0]?.as_of ?? null) || null;
      this.asOfCache.set(key, {
        asOfIso,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });
      return asOfIso;
    } catch {
      this.asOfCache.set(key, {
        asOfIso: null,
        expiresAt: Date.now() + 2 * 60 * 1000,
      });
      return null;
    }
  }

  private detectUnsupportedOrAmbiguousAsk(
    queryText: string,
    hasRichDataset = false,
  ): ClarificationPrompt | null {
    const q = String(queryText ?? '')
      .trim()
      .toLowerCase();
    if (!q) return null;

    // If the user already RESOLVED the budget question (e.g. clicked
    // "Show actuals only (no budget)"), the answer text still contains the word
    // "budget" — do NOT re-ask, or we loop forever. Treat any explicit
    // proceed-without-budget phrasing as resolved.
    const budgetResolved =
      /\b(actuals?\s+only|ignore\s+budget|without\s+budget|no\s+budget|exclude\s+budget|skip\s+budget|proceed\s+with\s+actuals)\b/i.test(
        q,
      );

    // Likewise, "skip forecasting / historical only" is a resolution, not a new
    // forecast request.
    const forecastResolved =
      /\b(no\s+forecast|skip\s+forecast(?:ing)?|without\s+forecast|historical\s+(?:only|actuals))\b/i.test(
        q,
      );

    // Budget / plan / target / variance needs a budget dataset.
    if (
      !budgetResolved &&
      /\b(budget|budgeted|plan\b|planned|target|variance|vs\.?\s*budget|plan\s+vs\s+actual|actuals?\s+vs\s+plan)\b/i.test(
        q,
      )
    ) {
      return {
        reason: 'BUDGET_DATA_REQUIRED',
        question:
          "This dataset has no budget or plan data, so I can't compute budget variance — only actuals are available. How would you like to proceed?",
        options: [
          {
            label: 'Show actuals only (no budget)',
            value:
              'Proceed with actuals only (ignore budget/plan) and build the best possible dashboard from available ClickHouse data.',
          },
          {
            label: 'Wait for budget upload',
            value:
              'I will upload/provide a budget table (by month + account/department) and then re-run this variance analysis.',
          },
        ],
      };
    }

    // Forecasting is possible, but requires choosing a method + horizon.
    if (
      !forecastResolved &&
      /\b(forecast|projection|projected|predict|prediction|what[- ]if|scenario)\b/i.test(
        q,
      )
    ) {
      return {
        reason: 'FORECAST_METHOD_REQUIRED',
        question:
          'Forecasting needs a method + horizon. What kind of forecast do you want?',
        options: [
          {
            label: 'Simple trend forecast',
            value:
              'Forecast next 3 months using a simple trend on historical monthly revenue (invoices/journals).',
          },
          {
            label: 'No forecast (historical only)',
            value:
              'Skip forecasting and only show historical actuals with trends and drivers.',
          },
        ],
      };
    }

    // Headcount / employee-level data is not in this system.
    // (Skipped for rich datasets like EBPO, which DO have employee data.)
    if (
      !hasRichDataset &&
      /\b(headcount|head\s+count|employee\s+count|number\s+of\s+employees|fte\b|workforce\s+size|staff\s+count|staffing\s+level|employees\s+per|per\s+employee|employee[-\s]level|hiring|recruitment|attrition|turnover\s+rate)\b/i.test(
        q,
      )
    ) {
      return {
        reason: 'HEADCOUNT_DATA_UNAVAILABLE',
        question:
          'Employee headcount data is not available in this system. What would you like to see instead?',
        options: [
          {
            label: 'Show payroll expenses by month',
            value:
              'Show monthly payroll and salary expenses trend from our expense data.',
          },
          {
            label: 'Show expenses by department',
            value:
              'Show total expenses broken down by department (Admin, Operations, Sales).',
          },
        ],
      };
    }

    // Regional / geographic data is not in this system.
    // (Skipped for rich datasets like EBPO, which DO have region/country data.)
    if (
      !hasRichDataset &&
      /\b(region\b|regional|geographic|geography|by\s+city|by\s+country|by\s+state|by\s+office|office\s+location|location[-\s]wise|across\s+(regions|locations|offices)|spending\s+(distribution|by)\s+(region|location|office))\b/i.test(
        q,
      )
    ) {
      return {
        reason: 'REGIONAL_DATA_UNAVAILABLE',
        question:
          'Regional or geographic location data is not available in this system. What would you like to see instead?',
        options: [
          {
            label: 'Show expenses by department',
            value:
              'Show total expenses broken down by department (Admin, Operations, Sales).',
          },
          {
            label: 'Show expenses by vendor',
            value: 'Show vendor spend breakdown ranking.',
          },
        ],
      };
    }

    // Working capital / recurring vs one-time needs data we do not have.
    // (Skipped for rich datasets like EBPO, which DO have AR/AP/cash data.)
    if (
      !hasRichDataset &&
      /\b(working\s+capital\s+expense|recurring\s+vs\.?\s+one[-\s]time|one[-\s]time\s+vs\.?\s+recurring)\b/i.test(
        q,
      )
    ) {
      return {
        reason: 'WORKING_CAPITAL_DATA_UNAVAILABLE',
        question:
          'Recurring vs one-time expense categorisation is not available in this system. What would you like instead?',
        options: [
          {
            label: 'Show expenses by account name',
            value: 'Show total expenses ranked by account name.',
          },
          {
            label: 'Show expense trend by month',
            value: 'Show monthly operating expense trend.',
          },
        ],
      };
    }

    const unsupportedFeature = this.detectUnsupportedFeature(q);
    if (unsupportedFeature) {
      return {
        reason: unsupportedFeature.reason,
        question: `${unsupportedFeature.label} is not currently supported. What would you like me to do instead?`,
        options: [
          {
            label: unsupportedFeature.alternativeLabel,
            value: unsupportedFeature.alternativeValue,
          },
          {
            label: 'Show as a table',
            value: 'Show the data as a detailed table.',
          },
        ],
      };
    }

    return null;
  }

  private detectUnsupportedFeature(queryText: string): UnsupportedFeature | null {
    const q = String(queryText ?? '').toLowerCase();
    if (!q.trim()) return null;

    if (/\bbox\s*plot\b|\bbox\s*chart\b|\bviolin\s*plot\b/.test(q)) {
      return {
        reason: 'CHART_TYPE_UNSUPPORTED',
        label: 'Box plots / violin plots',
        alternativeLabel: 'Show as a ranked horizontal bar chart',
        alternativeValue:
          'Show the same data as a ranked horizontal bar chart sorted by value.',
      };
    }
    if (/\bdecomposition\s+tree\b|\bdecomp\s+tree\b/.test(q)) {
      return {
        reason: 'CHART_TYPE_UNSUPPORTED',
        label: 'Decomposition trees',
        alternativeLabel: 'Show as a treemap',
        alternativeValue: 'Show the breakdown as a treemap visualization.',
      };
    }
    if (/\bsun\s*burst\b|\bsunburst\b|\btree\s*ring\b|\btreering\b/.test(q)) {
      return {
        reason: 'CHART_TYPE_UNSUPPORTED',
        label: 'Sunburst / tree-ring charts',
        alternativeLabel: 'Show as a treemap',
        alternativeValue:
          'Show the same hierarchy as a treemap, which is the supported hierarchical visual.',
      };
    }
    if (/\bsparklines?\b|\bspark\s*lines?\b/.test(q)) {
      return {
        reason: 'CHART_TYPE_UNSUPPORTED',
        label: 'Sparklines inside matrix cells',
        alternativeLabel: 'Show as matrix plus trend chart',
        alternativeValue:
          'Show the matrix totals and add a separate line chart for the monthly trend.',
      };
    }
    if (/\b3-?d\b|\brotat(?:e|ing|ion)\b|\bspinning\b|\bspin\b/.test(q)) {
      return {
        reason: 'CHART_TYPE_UNSUPPORTED',
        label: '3D / rotating charts',
        alternativeLabel: 'Keep the flat 2D chart',
        alternativeValue:
          'Keep the standard flat 2D chart — 3D/rotating rendering is not supported.',
      };
    }
    if (/\b(animated|animation|animate|play\s+axis|play\s+button)\b/.test(q)) {
      return {
        reason: 'INTERACTIVE_FEATURE_UNSUPPORTED',
        label: 'Animated chart playback',
        alternativeLabel: 'Show as monthly trend',
        alternativeValue:
          'Show the data as a static monthly trend chart with all months visible.',
      };
    }
    if (
      /\b(dropdown|drop\s*down|filter\s+control|slicer|interactive\s+filter|drill\s*down|click\s+to\s+filter)\b/.test(
        q,
      )
    ) {
      return {
        reason: 'INTERACTIVE_FEATURE_UNSUPPORTED',
        label: 'Interactive filters / slicers',
        alternativeLabel: 'Show filtered static chart',
        alternativeValue:
          'Build a static chart using the requested filter or show separate series for each category.',
      };
    }
    return null;
  }

  // General missing-DATA boundary. The sample dataset is a single fiscal year of
  // general-ledger transactions + a trial balance — it has NO budget/plan/forecast/
  // target, no prior year, no region/geography, no customer/market segment, no
  // headcount, no cash-flow statement. Follow-ups that need those must be refused
  // clearly (never answered with fabricated columns). Returns a ready refusal
  // message, or null when the ask is satisfiable from real data.
  private detectUnavailableData(queryText: string, hasEbpo = false): string | null {
    const q = String(queryText ?? '').toLowerCase();
    if (!q.trim()) return null;

    const tail =
      ' This dataset has a single year of general-ledger transactions and a trial balance — I left the chart unchanged.';

    // Genuinely absent in BOTH datasets — budget/forecast/target are not recorded
    // anywhere (EBPO holds actuals only, no plan/target tables).
    if (/\b(budget|budgeted|plan(?:ned)?\s+(?:vs|versus|amount|figure)|vs\.?\s*plan|over\/under\s+budget)\b/.test(q))
      return `I can't add a budget comparison — there's no budget or plan data in this dataset, only actuals.${tail}`;
    if (/\b(forecast|projection|projected|run\s*rate\s+forecast|expected\s+future|predict(?:ed|ion)?|next\s+\d+\s+(?:months|quarters))\b/.test(q))
      return `I can't add a forecast — this dataset only holds recorded actuals, with no forward-looking or projection data.${tail}`;
    if (/\b(target|goal|quota|benchmark\s+target|against\s+target|vs\.?\s*target|performance\s+against)\b/.test(q))
      return `I can't compare against targets — there are no target or goal figures in this dataset.${tail}`;

    // The categories below DO exist in the EBPO dataset (multi-year data, cash-flow
    // statement, headcount/per-employee metrics, region/country, industry segments).
    // Only the single-year GL sample lacks them, so skip these refusals for EBPO and
    // let the data-aware editor build them.
    if (!hasEbpo) {
      if (/\b(year[\s-]*over[\s-]*year|yoy|year[\s-]*on[\s-]*year|prior[\s-]*year|previous\s+year|last\s+year|vs\.?\s*\d{4})\b/.test(q))
        return `I can't add a year-over-year or prior-year comparison — this dataset only covers a single year, so there's no earlier period to compare against.${tail}`;
      if (/\b(region|regional|geograph|country|countries|location|territory|by\s+state|by\s+city|map\b)\b/.test(q))
        return `I can't break this down by region or geography — there's no location/region field in this dataset.${tail}`;
      if (/\b(segment|customer\s+segment|market\s+segment|tier|cohort|persona|industry\s+vertical)\b/.test(q))
        return `I can't split this by segment — there's no customer or market-segment field in this dataset.${tail}`;
      if (/\b(headcount|head\s+count|fte|employee\s+count|number\s+of\s+employees|staff\s+count|per\s+employee)\b/.test(q))
        return `I can't add headcount or per-employee metrics — there's no employee/headcount data in this dataset.${tail}`;
      if (/\b(cash\s*flow|cash\s+runway|runway|burn\s+rate|liquidity\s+forecast|months\s+of\s+(?:operating|opex|cash))\b/.test(q))
        return `I can't compute cash flow or runway — this dataset has GL transactions and balances, not a cash-flow statement.${tail}`;
    }

    return null;
  }

  private async ensureAnalyticsSchema(): Promise<void> {
    if (this.analyticsSchemaEnsured) return;
    if (this.analyticsSchemaEnsurePromise)
      return this.analyticsSchemaEnsurePromise;

    this.analyticsSchemaEnsurePromise = (async () => {
      const db = this.analyticsDb;
      const safeDDL = async (query: string) => {
        const res = await this.clickhouse.query({ query });
        await res.text();
      };

      try {
        await safeDDL(`CREATE DATABASE IF NOT EXISTS ${db}`);

        // Ensure critical tables exist (Agent can run even if SyncService isn't loaded).
        await safeDDL(`
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

        await safeDDL(`
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

        await safeDDL(`
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

        await safeDDL(`
          CREATE TABLE IF NOT EXISTS ${db}.dim_clients (
            client_id            String,
            client_name          String         DEFAULT '',
            provider             LowCardinality(String) DEFAULT '',
            tenant_id            String,
            org_id               String         DEFAULT '',
            org_name             String         DEFAULT '',
            currency             String         DEFAULT '',
            total_invoiced       Float64        DEFAULT 0,
            total_revenue        Float64        DEFAULT 0,
            total_outstanding    Float64        DEFAULT 0,
            total_overdue        Float64        DEFAULT 0,
            invoice_count        UInt64         DEFAULT 0,
            paid_count           UInt64         DEFAULT 0,
            outstanding_count    UInt64         DEFAULT 0,
            overdue_count        UInt64         DEFAULT 0,
            draft_count          UInt64         DEFAULT 0,
            avg_invoice_amount   Float64        DEFAULT 0,
            first_invoice_date   Date           DEFAULT toDate('1970-01-01'),
            last_invoice_date    Date           DEFAULT toDate('1970-01-01'),
            updated_at           DateTime       DEFAULT now()
          ) ENGINE = ReplacingMergeTree()
          ORDER BY (tenant_id, org_id, provider, client_id)
        `);

        await safeDDL(`
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

        // Column add-migrations for older deployments.
        const migrations = [
          `ALTER TABLE ${db}.fact_accounting_invoices ADD COLUMN IF NOT EXISTS contact_id String DEFAULT ''`,
          `ALTER TABLE ${db}.fact_accounting_invoices ADD COLUMN IF NOT EXISTS contact_name String DEFAULT ''`,
          `ALTER TABLE ${db}.fact_accounting_invoices ADD COLUMN IF NOT EXISTS invoice_type String DEFAULT ''`,
          `ALTER TABLE ${db}.fact_accounting_invoices ADD COLUMN IF NOT EXISTS org_id String DEFAULT ''`,
          `ALTER TABLE ${db}.fact_accounting_invoices ADD COLUMN IF NOT EXISTS org_name String DEFAULT ''`,
          `ALTER TABLE ${db}.fact_accounting_invoices ADD COLUMN IF NOT EXISTS amount_due Decimal(18,4) DEFAULT 0`,
          `ALTER TABLE ${db}.fact_accounting_invoices ADD COLUMN IF NOT EXISTS amount_paid Decimal(18,4) DEFAULT 0`,
          `ALTER TABLE ${db}.fact_accounting_invoices ADD COLUMN IF NOT EXISTS amount_credited Decimal(18,4) DEFAULT 0`,
          `ALTER TABLE ${db}.fact_accounting_invoices ADD COLUMN IF NOT EXISTS paid_at Nullable(DateTime)`,
          `ALTER TABLE ${db}.fact_accounting_payment_applications ADD COLUMN IF NOT EXISTS invoice_external_id String DEFAULT ''`,
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
        for (const q of migrations) await safeDDL(q);

        // FINAL is not supported on plain MergeTree, and even on ReplacingMergeTree it may
        // still return duplicates until merges complete. Create "latest" views that are
        // safe and deterministic across table engines.
        await safeDDL(`
          CREATE VIEW IF NOT EXISTS ${db}.v_fact_accounting_invoices_latest AS
          SELECT
            tenant_id,
            org_id,
            provider,
            invoice_id,
            argMax(user_id, updated_at)             AS user_id,
            argMax(connection_id, updated_at)       AS connection_id,
            argMax(org_name, updated_at)            AS org_name,
            argMax(invoice_external_id, updated_at) AS invoice_external_id,
            argMax(invoice_number, updated_at)      AS invoice_number,
            argMax(total_amount, updated_at)        AS total_amount,
            argMax(amount_due, updated_at)          AS amount_due,
            argMax(amount_paid, updated_at)         AS amount_paid,
            argMax(amount_credited, updated_at)     AS amount_credited,
            argMax(currency, updated_at)            AS currency,
            argMax(issued_at, updated_at)           AS issued_at,
            argMax(due_at, updated_at)              AS due_at,
            argMax(paid_at, updated_at)             AS paid_at,
            argMax(status, updated_at)              AS status,
            argMax(invoice_type, updated_at)        AS invoice_type,
            argMax(contact_id, updated_at)          AS contact_id,
            argMax(contact_name, updated_at)        AS contact_name
          FROM ${db}.fact_accounting_invoices
          GROUP BY tenant_id, org_id, provider, invoice_id
        `);

        await safeDDL(`
          CREATE VIEW IF NOT EXISTS ${db}.v_dim_clients_latest AS
          SELECT
            tenant_id,
            org_id,
            provider,
            client_id,
            argMax(client_name, updated_at)        AS client_name,
            argMax(org_name, updated_at)           AS org_name,
            argMax(currency, updated_at)           AS currency,
            argMax(total_invoiced, updated_at)     AS total_invoiced,
            argMax(total_revenue, updated_at)      AS total_revenue,
            argMax(total_outstanding, updated_at)  AS total_outstanding,
            argMax(total_overdue, updated_at)      AS total_overdue,
            argMax(invoice_count, updated_at)      AS invoice_count,
            argMax(paid_count, updated_at)         AS paid_count,
            argMax(outstanding_count, updated_at)  AS outstanding_count,
            argMax(overdue_count, updated_at)      AS overdue_count,
            argMax(draft_count, updated_at)        AS draft_count,
            argMax(avg_invoice_amount, updated_at) AS avg_invoice_amount,
            argMax(first_invoice_date, updated_at) AS first_invoice_date,
            argMax(last_invoice_date, updated_at)  AS last_invoice_date
          FROM ${db}.dim_clients
          GROUP BY tenant_id, org_id, provider, client_id
        `);

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
            argMax(description,    jl.updated_at)  AS description,
            argMax(department,     jl.updated_at)  AS department,
            argMax(class_name,     jl.updated_at)  AS class_name,
            argMax(vendor_name,    jl.updated_at)  AS vendor_name,
            argMax(vendor_id,      jl.updated_at)  AS vendor_id,
            argMax(debit_amount,   jl.updated_at)  AS debit_amount,
            argMax(credit_amount,  jl.updated_at)  AS credit_amount,
            argMax(user_id,        jl.updated_at)  AS user_id,
            argMax(connection_id,  jl.updated_at)  AS connection_id,
            argMax(org_name,       jl.updated_at)  AS org_name,
            max(jl.updated_at)                     AS updated_at,
            max(jl.synced_at)                      AS synced_at
          FROM ${db}.fact_accounting_journal_lines AS jl
          GROUP BY tenant_id, org_id, provider, journal_id, line_id
        `;
        try {
          await safeDDL(vJournalLatest);
        } catch {
          await safeDDL(
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
          await safeDDL(vMapLatest);
        } catch {
          await safeDDL(
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
          await safeDDL(vEnrichedLatest);
        } catch {
          await safeDDL(
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
          await safeDDL(vUnmapped);
        } catch {
          await safeDDL(
            vUnmapped.replace(
              /CREATE\s+OR\s+REPLACE\s+VIEW/i,
              'CREATE VIEW IF NOT EXISTS',
            ),
          );
        }

        this.analyticsSchemaEnsured = true;
      } catch (err: any) {
        // Non-fatal: queries may still work if schema already exists; otherwise caller will see a query error.
        this.logger.warn(
          `[Agent] Analytics schema ensure failed: ${err?.message ?? err}`,
        );
      }
    })().finally(() => {
      this.analyticsSchemaEnsurePromise = null;
    });

    return this.analyticsSchemaEnsurePromise;
  }

  // ─── Health ───────────────────────────────────────────────────────────────

  async health() {
    let ollamaOnline = false;
    try {
      const res = await fetch(`${this.OLLAMA_URL}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      ollamaOnline = res.ok;
    } catch {
      /* offline */
    }

    const backendLabel = getLlmProviderLabel(this.llmProvider);

    return {
      status: ollamaOnline ? 'operational' : 'degraded',
      advisory: ollamaOnline
        ? `NumeriQ Agent Layer ready — ${backendLabel}: ${this.OLLAMA_MODEL}`
        : `${backendLabel} offline — check ${this.OLLAMA_URL}`,
      mode: 'agentic-tool-use',
      ollama: ollamaOnline,
      provider: this.llmProvider,
      backendUrl: this.OLLAMA_URL,
      model: this.OLLAMA_MODEL,
    };
  }

  // ─── Session Management ───────────────────────────────────────────────────

  async listSessions(organizationId: string, userId: string) {
    const sessions = await this.prisma.agentChatSession.findMany({
      where: { organizationId, userId },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      include: { _count: { select: { messages: true } } },
    });
    return sessions.map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
      messageCount: s._count.messages,
    }));
  }

  async getSession(organizationId: string, userId: string, sessionId: string) {
    const session = await this.prisma.agentChatSession.findFirst({
      where: { id: sessionId, organizationId, userId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!session) return null;
    return {
      id: session.id,
      title: session.title,
      messages: session.messages.map((m) => ({
        role: m.role.toLowerCase(),
        content: m.content,
        metadata: m.metadata ?? null,
      })),
    };
  }

  // ─── Latest Dashboard ─────────────────────────────────────────────────────

  async latestDashboard(organizationId: string, userId: string) {
    const dashboard = await this.prisma.dashboard.findFirst({
      where: { organizationId, ownerId: userId, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      include: { widgets: { orderBy: { displayOrder: 'asc' } } },
    });
    return dashboard ? this.serializeDashboard(dashboard) : null;
  }

  async dashboardForSession(
    organizationId: string,
    userId: string,
    sessionId: string,
  ) {
    const req = await this.prisma.agentDashboardRequest.findFirst({
      where: {
        organizationId,
        requestedById: userId,
        agentSessionId: sessionId,
        generatedDashboardId: { not: null },
      },
      orderBy: [{ completedAt: 'desc' }, { updatedAt: 'desc' }],
      select: { generatedDashboardId: true },
    });
    if (!req?.generatedDashboardId) return null;

    const dashboard = await this.prisma.dashboard.findFirst({
      where: {
        id: req.generatedDashboardId,
        organizationId,
        ownerId: userId,
        deletedAt: null,
      },
      include: { widgets: { orderBy: { displayOrder: 'asc' } } },
    });
    return dashboard ? this.serializeDashboard(dashboard) : null;
  }

  private serializeDashboard(dashboard: any) {
    return {
      id: dashboard.id,
      title: dashboard.title,
      description: dashboard.description,
      charts: (dashboard.widgets ?? []).map((w: any) => ({
        id: w.id,
        title: w.title,
        description: (w.chartConfig as any)?.description ?? null,
        type: w.chartType,
        config:
          typeof w.queryConfig === 'object' && w.queryConfig
            ? (w.queryConfig as Record<string, unknown>)
            : { metric: 'revenue', grouping: 'month' },
        layoutIndex: w.displayOrder,
      })),
    };
  }

  // ─── Metric Data ──────────────────────────────────────────────────────────

  private metricMonthKey(date: Date): string {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  private parseMetricRowDate(row: Record<string, unknown>): Date | null {
    const candidates = [
      row.period_date,
      row.month_start,
      row.date,
      row.name,
      row.month,
      row.period,
    ];

    for (const raw of candidates) {
      const text = String(raw ?? '').trim();
      if (!text) continue;

      const iso = text.match(/^((?:19|20)\d{2})-(\d{1,2})(?:-\d{1,2})?/);
      if (iso) return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, 1));

      const monthYear = text.match(/^([A-Za-z]{3,9})\s+((?:19|20)\d{2})$/);
      if (monthYear) {
        const month = [
          'jan',
          'feb',
          'mar',
          'apr',
          'may',
          'jun',
          'jul',
          'aug',
          'sep',
          'oct',
          'nov',
          'dec',
        ].indexOf((monthYear[1] ?? '').slice(0, 3).toLowerCase());
        if (month >= 0) return new Date(Date.UTC(Number(monthYear[2]), month, 1));
      }

      const short = text.match(/^(\d{1,2})\/(\d{2}|\d{4})$/);
      if (short) {
        const month = Number(short[1]);
        const rawYear = Number(short[2]);
        const year = rawYear < 100 ? 2000 + rawYear : rawYear;
        if (month >= 1 && month <= 12) return new Date(Date.UTC(year, month - 1, 1));
      }

      const quarter = text.match(/^Q[1-4]\s+((?:19|20)\d{2})$/i);
      if (quarter) return new Date(Date.UTC(Number(quarter[1]), 0, 1));

      const year = text.match(/^((?:19|20)\d{2})$/);
      if (year) return new Date(Date.UTC(Number(year[1]), 0, 1));
    }

    return null;
  }

  private formatMonthKeyForNotice(key: string): string {
    const [y, m] = key.split('-').map(Number);
    if (!y || !m) return key;
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(y, m - 1, 1)));
  }

  private labelTimeRange(range?: TimeRange): string {
    if (!range || range.kind === 'ALL_TIME') return 'all time';
    if (range.kind === 'LAST_N_MONTHS') return `last ${range.months} months`;
    if (range.kind === 'LAST_N_DAYS') return `last ${range.days} days`;
    if (range.kind === 'LAST_N_WEEKS') return `last ${range.weeks} weeks`;
    if (range.kind === 'LAST_N_QUARTERS') return `last ${range.quarters} quarters`;
    if (range.kind === 'LAST_N_YEARS') return `last ${range.years} years`;
    if (range.kind === 'BETWEEN_DATES') return `${range.start} to ${range.end}`;
    if (range.kind === 'SINCE_DATE') return `since ${range.start}`;
    return range.kind.toLowerCase();
  }

  private requestedMonthBounds(range?: TimeRange): { start: string; end: string } | null {
    if (!range || range.kind === 'ALL_TIME') return null;
    const now = new Date();
    const currentMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const key = (date: Date) => this.metricMonthKey(date);
    if (range.kind === 'MTD') return { start: key(currentMonth), end: key(currentMonth) };
    if (range.kind === 'QTD') {
      const quarterMonth = Math.floor(now.getUTCMonth() / 3) * 3;
      return {
        start: key(new Date(Date.UTC(now.getUTCFullYear(), quarterMonth, 1))),
        end: key(currentMonth),
      };
    }
    if (range.kind === 'YTD') {
      return {
        start: key(new Date(Date.UTC(now.getUTCFullYear(), 0, 1))),
        end: key(currentMonth),
      };
    }
    if (range.kind === 'LAST_N_MONTHS') {
      return {
        start: key(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - Math.max(1, range.months) + 1, 1))),
        end: key(currentMonth),
      };
    }
    if (range.kind === 'LAST_N_QUARTERS') {
      const months = Math.max(1, range.quarters) * 3;
      return {
        start: key(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months + 1, 1))),
        end: key(currentMonth),
      };
    }
    if (range.kind === 'LAST_N_YEARS') {
      return {
        start: key(new Date(Date.UTC(now.getUTCFullYear() - Math.max(1, range.years) + 1, 0, 1))),
        end: key(currentMonth),
      };
    }
    if (range.kind === 'LAST_N_WEEKS' || range.kind === 'LAST_N_DAYS') {
      const days = range.kind === 'LAST_N_WEEKS' ? Math.max(1, range.weeks) * 7 : Math.max(1, range.days);
      const start = new Date(now);
      start.setUTCDate(start.getUTCDate() - days + 1);
      return {
        start: key(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))),
        end: key(currentMonth),
      };
    }
    if (range.kind === 'SINCE_DATE') return { start: range.start.slice(0, 7), end: key(currentMonth) };
    if (range.kind === 'BETWEEN_DATES') return { start: range.start.slice(0, 7), end: range.end.slice(0, 7) };
    return null;
  }

  private applyRequestedRangeToRows(
    rows: Record<string, unknown>[],
    range?: TimeRange,
  ): {
    data: Record<string, unknown>[];
    rangeNotice?: string;
    requestedRangeLabel?: string;
    availableRange?: { start: string; end: string };
  } {
    const dated = rows
      .map((row) => ({ row, date: this.parseMetricRowDate(row) }))
      .filter((item): item is { row: Record<string, unknown>; date: Date } => !!item.date);
    if (dated.length === 0) return { data: rows };

    const months = dated.map((item) => this.metricMonthKey(item.date)).sort();
    const availableRange = { start: months[0]!, end: months[months.length - 1]! };
    const bounds = this.requestedMonthBounds(range);
    if (!bounds) return { data: rows, availableRange };

    const data = dated
      .filter((item) => {
        const month = this.metricMonthKey(item.date);
        return month >= bounds.start && month <= bounds.end;
      })
      .map((item) => item.row);
    const requestedRangeLabel = this.labelTimeRange(range);
    const availableLabel = `${this.formatMonthKeyForNotice(availableRange.start)} to ${this.formatMonthKeyForNotice(availableRange.end)}`;

    if (data.length === 0) {
      return {
        data,
        requestedRangeLabel,
        availableRange,
        rangeNotice: `No data is available for ${requestedRangeLabel}. Available data runs from ${availableLabel}.`,
      };
    }

    if (availableRange.end < bounds.end) {
      return {
        data,
        requestedRangeLabel,
        availableRange,
        rangeNotice: `Showing available data through ${this.formatMonthKeyForNotice(availableRange.end)}. Available data runs from ${availableLabel}.`,
      };
    }

    return { data, requestedRangeLabel, availableRange };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // LEGACY DETERMINISTIC PLANNER (metricData + generatePlan + selectWidgetsForQuery)
  // ────────────────────────────────────────────────────────────────────────────
  // This block is the pre-catalog, hardcoded (metric × grouping) SQL builder. It is
  // NO LONGER the primary path — the spec/catalog planner (generateSpecPlan +
  // chart-spec*.ts) serves ~100% of normal traffic (validated: 0 rescues / 52 Qs).
  // It is intentionally KEPT because it is load-bearing in two ways (see
  // AGENT_ARCHITECTURE.md → "Legacy planner"): (1) LLM-offline graceful degradation,
  // and (2) the per-edit tool plan. Do NOT delete without reworking those paths and
  // deciding the offline-resilience product question. Gated/observable via
  // AGENT_LEGACY_FALLBACK + the `served=legacy` log.
  // ════════════════════════════════════════════════════════════════════════════
  async metricData(
    organizationId: string,
    role: MembershipRole,
    metric: string,
    grouping: string,
    range?: TimeRange,
    providerHint?: string,
    clientName?: string,
    clientNames?: string[],
    orgId?: string,
    breakdown?: string,
    topN?: number,
    widgetId?: string,
  ) {
    await this.ensureAnalyticsSchema();
    const scope = await this.getOrgScope(organizationId, role, orgId);
    if (scope.externalOrgIds.length === 0) return { data: [] };

    const asOfIso = await this.resolveAsOfIso(scope);
    const asOfExpr =
      asOfIso && this.isStaleAsOf(asOfIso)
        ? `toDateTime('${asOfIso} 23:59:59')`
        : 'now()';

    // Dynamic SQL widget — look up stored SQL from the widget's queryConfig and execute it
    if (metric === 'dynamic' && widgetId) {
      try {
        const widget = await this.prisma.dashboardWidget.findFirst({
          where: { id: widgetId, organizationId },
          select: { queryConfig: true, chartType: true },
        });
        const cfg = widget?.queryConfig as Record<string, unknown> | null;
        const sql = typeof cfg?.dynamicSql === 'string' ? cfg.dynamicSql : null;
        if (sql) {
          const chartType = (widget?.chartType ?? null) as ChartType | null;
          const data = await this.executeDynamicSql(sql, scope, {
            chartType: chartType ?? undefined,
          });
          return this.applyRequestedRangeToRows(data, range);
        }
      } catch (err: any) {
        this.logger.warn(
          `[Agent:Dynamic] widgetId=${widgetId} SQL exec failed: ${err.message}`,
        );
      }
      return { data: [] };
    }
    // Enforce member scoping on read endpoints too: never mix entities for non-admins.
    if (role !== 'ADMIN' && !orgId && scope.externalOrgIds.length > 1)
      return { data: [] };
    const time = this.timeWhereOn('issued_at', range, asOfExpr);
    const provider = providerHint
      ? `AND lowerUTF8(provider) = {provider:String}`
      : '';
    const providerParam = providerHint
      ? { provider: providerHint.toLowerCase() }
      : {};
    const normalizedClientNames =
      Array.isArray(clientNames) && clientNames.length > 0
        ? clientNames
            .map((c) => String(c ?? '').trim())
            .filter(Boolean)
            .slice(0, 5)
        : null;

    const clientNamesLower =
      normalizedClientNames && normalizedClientNames.length > 0
        ? normalizedClientNames
            .map((c) => c.toLowerCase())
            .filter(Boolean)
            .slice(0, 5)
        : null;

    const client =
      !normalizedClientNames && clientName
        ? `AND lowerUTF8(contact_name) = {clientName:String}`
        : '';
    const clientParam =
      !normalizedClientNames && clientName
        ? { clientName: clientName.toLowerCase() }
        : {};
    const clientListFact = clientNamesLower
      ? `AND lowerUTF8(coalesce(nullIf(contact_name, ''), 'Unknown Client')) IN ({clientNames:Array(String)})`
      : '';
    const clientListDim = clientNamesLower
      ? `AND lowerUTF8(coalesce(nullIf(client_name, ''), 'Unknown Client')) IN ({clientNames:Array(String)})`
      : '';
    const clientListParam = clientNamesLower
      ? { clientNames: clientNamesLower }
      : {};
    const entity = orgId ? `AND org_id = {orgId:String}` : '';
    const entityParam = orgId ? { orgId } : {};
    const rangeEndExpr = (() => {
      if (
        range?.kind === 'BETWEEN_DATES' &&
        /^\d{4}-\d{2}-\d{2}$/.test(range.end)
      ) {
        return `toDateTime('${range.end} 23:59:59')`;
      }
      return asOfExpr;
    })();
    const requestedTopN = (() => {
      if (typeof topN !== 'number' || !Number.isFinite(topN)) return null;
      const n = Math.floor(topN);
      if (n <= 0) return null;
      return Math.max(1, Math.min(50, n));
    })();

    // For Xero, the Invoices endpoint contains both sales (ACCREC) and bills (ACCPAY).
    // We prefer ACCREC, but older ingestions may have blank invoice_type; don't exclude all data in that case.
    const arFilter = `AND total_amount > 0 AND (provider != 'xero' OR invoice_type = '' OR lowerUTF8(invoice_type) = 'accrec')`;

    if (metric === 'venture') {
      const rows = await this.queryRows<any>(
        `SELECT
           coalesce(sum(total_amount), 0) AS total_revenue,
           coalesce(sumIf(total_amount, lowerUTF8(status) NOT IN ('paid','closed')), 0) AS open_amount
         FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
         WHERE org_id IN ({externalOrgIds:Array(String)})
           ${provider}
           ${client}
           ${clientListFact}
           ${entity}
           ${time}`,
        {
          externalOrgIds: scope.externalOrgIds,
          ...providerParam,
          ...clientParam,
          ...clientListParam,
          ...entityParam,
        },
      );
      const r = rows[0] ?? {};
      const revenue = this.num(r.total_revenue);
      const open = this.num(r.open_amount);
      return {
        data: [
          {
            burnRate: open,
            runwayMonths:
              open > 0 ? Math.round((revenue / open) * 10) / 10 : 99,
            cashOnHand: revenue - open,
            efficiencyMultiplier:
              open > 0 ? Math.round((revenue / open) * 100) / 100 : 0,
          },
        ],
      };
    }

    // ── top5_revenue_share/summary ───────────────────────────────────────────
    if (metric === 'top5_revenue_share' && grouping === 'summary') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      try {
        const rows = await this.queryRows<any>(
          `WITH invoices AS (
           SELECT
             invoice_external_id,
             coalesce(nullIf(contact_name, ''), 'Unknown') AS client_name,
             contact_id AS client_id,
             issued_at,
             provider,
             invoice_type
           FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
           WHERE org_id IN ({externalOrgIds:Array(String)})
             ${provider}
             ${time}
             ${arFilter}
             AND issued_at IS NOT NULL
         )
         SELECT
           i.client_name,
           i.client_id,
           sum(p.amount) AS total_collected
         FROM ${this.analyticsDb}.fact_accounting_payment_applications p
         INNER JOIN invoices i ON i.invoice_external_id = p.invoice_external_id
         WHERE p.org_id IN ({externalOrgIds:Array(String)})
           AND p.payment_at IS NOT NULL
           AND p.payment_at <= ${rangeEndExpr}
           AND p.invoice_external_id != ''
         GROUP BY i.client_name, i.client_id
         ORDER BY total_collected DESC
         LIMIT 500`,
          { externalOrgIds: scope.externalOrgIds, ...providerParam },
        );

        const totals = rows
          .map((r) => ({
            name: String(r.client_name ?? 'Unknown'),
            value: this.num(r.total_collected),
          }))
          .filter((r) => r.value > 0);

        const total = totals.reduce((s, r) => s + r.value, 0);
        const top5 = totals.slice(0, 5).reduce((s, r) => s + r.value, 0);
        const pct = total > 0 ? (top5 / total) * 100 : 0;
        return { data: [{ value: Math.round(pct * 10) / 10 }] };
      } catch {
        const rows = await this.queryRows<any>(
          `SELECT total_revenue
           FROM ${this.analyticsDb}.v_dim_clients_latest
           WHERE org_id IN ({externalOrgIds:Array(String)}) AND client_name != ''
           ORDER BY total_revenue DESC LIMIT 100`,
          { externalOrgIds: scope.externalOrgIds },
        );
        const values = rows
          .map((r) => this.num(r.total_revenue))
          .filter((v) => v > 0);
        const total = values.reduce((s, v) => s + v, 0);
        const top5 = values.slice(0, 5).reduce((s, v) => s + v, 0);
        const pct = total > 0 ? (top5 / total) * 100 : 0;
        return { data: [{ value: Math.round(pct * 10) / 10 }] };
      }
    }

    // ── collected_vs_outstanding/summary ─────────────────────────────────────
    if (metric === 'collected_vs_outstanding' && grouping === 'summary') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      try {
        const rows = await this.queryRows<any>(
          `WITH invoices AS (
           SELECT
             invoice_external_id,
             toDecimal64(total_amount, 4) AS total_amount,
             issued_at,
             due_at,
             provider,
             invoice_type
           FROM ${this.analyticsDb}.fact_accounting_invoices
           WHERE org_id IN ({externalOrgIds:Array(String)})
             ${provider}
             ${time}
             ${arFilter}
             AND issued_at IS NOT NULL
         ),
         paid AS (
           SELECT
             invoice_external_id,
             sum(amount) AS paid_to_date
           FROM ${this.analyticsDb}.fact_accounting_payment_applications
           WHERE org_id IN ({externalOrgIds:Array(String)})
             AND payment_at IS NOT NULL
             AND payment_at <= ${rangeEndExpr}
             AND invoice_external_id != ''
           GROUP BY invoice_external_id
         )
         SELECT
           sum(i.total_amount) AS total_invoiced,
           sum(ifNull(p.paid_to_date, toDecimal64(0, 4))) AS total_collected,
           sum(greatest(i.total_amount - ifNull(p.paid_to_date, toDecimal64(0, 4)), toDecimal64(0, 4))) AS total_outstanding
         FROM invoices i
         LEFT JOIN paid p ON p.invoice_external_id = i.invoice_external_id`,
          { externalOrgIds: scope.externalOrgIds },
        );

        const r = rows[0] ?? {};
        const totalInvoiced = this.num(r.total_invoiced);
        const totalCollected = this.num(r.total_collected);
        const totalOutstanding = this.num(r.total_outstanding);

        const collectedPct =
          totalInvoiced > 0 ? (totalCollected / totalInvoiced) * 100 : 0;
        const outstandingPct =
          totalInvoiced > 0 ? (totalOutstanding / totalInvoiced) * 100 : 0;

        return {
          data: [
            {
              value: Math.round(collectedPct * 10) / 10,
              outstandingPct: Math.round(outstandingPct * 10) / 10,
            },
          ],
        };
      } catch {
        const rows = await this.queryRows<any>(
          `SELECT
             sum(total_invoiced) AS total_invoiced,
             sum(total_revenue) AS total_collected,
             sum(total_outstanding) AS total_outstanding
           FROM ${this.analyticsDb}.v_dim_clients_latest
           WHERE org_id IN ({externalOrgIds:Array(String)})`,
          { externalOrgIds: scope.externalOrgIds },
        );
        const r = rows[0] ?? {};
        const totalInvoiced = this.num(r.total_invoiced);
        const totalCollected = this.num(r.total_collected);
        const totalOutstanding = this.num(r.total_outstanding);
        const collectedPct =
          totalInvoiced > 0 ? (totalCollected / totalInvoiced) * 100 : 0;
        const outstandingPct =
          totalInvoiced > 0 ? (totalOutstanding / totalInvoiced) * 100 : 0;
        return {
          data: [
            {
              value: Math.round(collectedPct * 10) / 10,
              outstandingPct: Math.round(outstandingPct * 10) / 10,
            },
          ],
        };
      }
    }

    if (metric === 'avg_invoice' && grouping === 'month') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           formatDateTime(toStartOfMonth(issued_at), '%m/%y') AS month,
           toStartOfMonth(issued_at) AS month_start,
           coalesce(avg(abs(total_amount)), 0) AS avg_invoice
         FROM ${this.analyticsDb}.fact_accounting_invoices
		       WHERE org_id IN ({externalOrgIds:Array(String)})
		        ${provider}
		        ${client}
		        ${clientListFact}
		        ${time}
		        ${arFilter}
		        AND issued_at IS NOT NULL
         GROUP BY month, month_start
         ORDER BY month_start ASC
         LIMIT 24`,
        {
          externalOrgIds: scope.externalOrgIds,
          ...providerParam,
          ...clientParam,
        },
      );
      return {
        data: rows.map((r) => ({
          name: r.month as string,
          value: this.num(r.avg_invoice),
        })),
      };
    }

    if (metric === 'invoices' && grouping === 'status') {
      const rows = await this.queryRows<any>(
        `SELECT status, coalesce(sum(total_amount), 0) AS total_amount, count() AS total_count
         FROM ${this.analyticsDb}.fact_accounting_invoices
         WHERE org_id IN ({externalOrgIds:Array(String)})
           ${provider}
           ${client}
           ${time}
         GROUP BY status ORDER BY total_amount DESC`,
        {
          externalOrgIds: scope.externalOrgIds,
          ...providerParam,
          ...clientParam,
        },
      );
      return {
        data: rows.map((r) => ({
          name: r.status as string,
          value: this.num(r.total_amount),
          count: this.num(r.total_count),
        })),
      };
    }

    if (metric === 'invoices' && grouping === 'list') {
      const rows = await this.queryRows<any>(
        `SELECT
	           formatDateTime(issued_at, '%Y-%m-%d') AS issued_date,
	           formatDateTime(due_at,   '%Y-%m-%d') AS due_date,
	           invoice_number,
	           coalesce(nullIf(contact_name, ''), 'Unknown') AS contact_name,
	           status,
	           round(total_amount, 2) AS total_amount,
	           coalesce(nullIf(org_name, ''), org_id) AS org_name,
	           provider,
	           currency
	         FROM ${this.analyticsDb}.fact_accounting_invoices
	         WHERE org_id IN ({externalOrgIds:Array(String)})
	           ${provider}
	           ${client}
	           ${time}
	         ORDER BY issued_at DESC
	         LIMIT 50`,
        {
          externalOrgIds: scope.externalOrgIds,
          ...providerParam,
          ...clientParam,
        },
      );
      return { data: rows };
    }

    // ── payment_days/list (table) ────────────────────────────────────────────
    if (metric === 'payment_days' && grouping === 'list') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `WITH invoices AS (
	           SELECT
	             invoice_external_id,
	             invoice_number,
	             issued_at,
	             due_at,
	             paid_at,
	             coalesce(nullIf(contact_name, ''), 'Unknown') AS client_name,
	             coalesce(nullIf(org_name, ''), org_id) AS org_name,
	             provider,
	             currency,
	             toDecimal64(total_amount, 4) AS total_amount
	           FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
	           WHERE org_id IN ({externalOrgIds:Array(String)})
	             ${provider}
	             ${client}
	             ${clientListFact}
	             ${entity}
	             ${time}
	             ${arFilter}
	             AND issued_at IS NOT NULL
	             AND invoice_external_id != ''
	         ),
	         paid_apps AS (
	           SELECT
	             invoice_external_id,
	             max(payment_at) AS last_paid_at,
	             sum(amount) AS paid_to_date
	           FROM ${this.analyticsDb}.fact_accounting_payment_applications
	           WHERE org_id IN ({externalOrgIds:Array(String)})
	             ${entity}
	             AND payment_at IS NOT NULL
	             AND payment_at <= ${rangeEndExpr}
	             AND invoice_external_id != ''
	           GROUP BY invoice_external_id
	         ),
	         joined AS (
	           SELECT
	             i.*,
	             coalesce(p.last_paid_at, i.paid_at) AS resolved_paid_at,
	             ifNull(p.paid_to_date, toDecimal64(0, 4)) AS paid_to_date
	           FROM invoices i
	           LEFT JOIN paid_apps p ON p.invoice_external_id = i.invoice_external_id
	         )
	         SELECT
	           client_name,
	           org_name,
	           provider,
	           currency,
	           invoice_number,
	           formatDateTime(issued_at, '%Y-%m-%d') AS issued_date,
	           formatDateTime(resolved_paid_at, '%Y-%m-%d') AS paid_date,
	           round(toFloat64(total_amount), 2) AS total_amount,
	           dateDiff('day', toDate(issued_at), toDate(resolved_paid_at)) AS days_to_pay
	         FROM joined
	         WHERE resolved_paid_at IS NOT NULL
	           AND days_to_pay >= 0
	         ORDER BY resolved_paid_at DESC
	         LIMIT 200`,
        {
          externalOrgIds: scope.externalOrgIds,
          ...providerParam,
          ...clientParam,
          ...clientListParam,
          ...entityParam,
        },
      );
      return { data: rows };
    }

    // ── dso/month (line) ─────────────────────────────────────────────────────
    if (metric === 'dso' && grouping === 'month') {
      if (scope.externalOrgIds.length === 0) return { data: [] };

      // Explicit client comparison: pivot DSO trend per selected clients
      if (
        breakdown === 'client' &&
        normalizedClientNames &&
        normalizedClientNames.length >= 2
      ) {
        const explicitClients = normalizedClientNames
          .map((c) => c.toLowerCase())
          .filter(Boolean)
          .slice(0, 5);

        const rows = await this.queryRows<any>(
          `WITH invoices AS (
             SELECT
               invoice_external_id,
               issued_at,
               paid_at,
               coalesce(nullIf(contact_name, ''), 'Unknown') AS client_name,
               lowerUTF8(coalesce(nullIf(contact_name, ''), 'Unknown')) AS client_name_lower
             FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
             WHERE org_id IN ({externalOrgIds:Array(String)})
               ${provider}
               ${clientListFact}
               ${entity}
               ${time}
               ${arFilter}
               AND issued_at IS NOT NULL
               AND invoice_external_id != ''
               AND client_name_lower IN ({clientNames:Array(String)})
           ),
           paid_apps AS (
             SELECT
               invoice_external_id,
               max(payment_at) AS last_paid_at
             FROM ${this.analyticsDb}.fact_accounting_payment_applications
             WHERE org_id IN ({externalOrgIds:Array(String)})
               ${entity}
               AND payment_at IS NOT NULL
               AND payment_at <= ${rangeEndExpr}
               AND invoice_external_id != ''
             GROUP BY invoice_external_id
           ),
           joined AS (
             SELECT
               i.client_name,
               i.client_name_lower,
               i.invoice_external_id,
               i.issued_at,
               coalesce(p.last_paid_at, i.paid_at) AS resolved_paid_at
             FROM invoices i
             LEFT JOIN paid_apps p ON p.invoice_external_id = i.invoice_external_id
           )
           SELECT
             formatDateTime(toStartOfMonth(issued_at), '%m/%y') AS month,
             toStartOfMonth(issued_at) AS month_start,
             client_name,
             avg(dateDiff('day', toDate(issued_at), toDate(resolved_paid_at))) AS avg_days_to_pay,
             count() AS paid_invoice_count
           FROM joined
           WHERE resolved_paid_at IS NOT NULL
             AND resolved_paid_at >= issued_at
           GROUP BY month, month_start, client_name
           ORDER BY month_start ASC, client_name ASC
           LIMIT 240`,
          {
            externalOrgIds: scope.externalOrgIds,
            ...providerParam,
            ...clientListParam,
            ...entityParam,
            clientNames: explicitClients,
          },
        );

        const map = new Map<string, any>();
        for (const r of rows) {
          const key = String(r.month);
          const existing = map.get(key) ?? { name: key };
          existing[String(r.client_name)] =
            Math.round(this.num(r.avg_days_to_pay) * 10) / 10;
          map.set(key, existing);
        }
        return { data: Array.from(map.values()) };
      }

      const rows = await this.queryRows<any>(
        `WITH invoices AS (
	           SELECT
	             invoice_external_id,
	             issued_at,
	             paid_at
	           FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
	           WHERE org_id IN ({externalOrgIds:Array(String)})
	             ${provider}
	             ${client}
	             ${clientListFact}
	             ${entity}
	             ${time}
	             ${arFilter}
	             AND issued_at IS NOT NULL
	             AND invoice_external_id != ''
	         ),
	         paid_apps AS (
	           SELECT
	             invoice_external_id,
	             max(payment_at) AS last_paid_at
	           FROM ${this.analyticsDb}.fact_accounting_payment_applications
	           WHERE org_id IN ({externalOrgIds:Array(String)})
	             ${entity}
	             AND payment_at IS NOT NULL
	             AND payment_at <= ${rangeEndExpr}
	             AND invoice_external_id != ''
	           GROUP BY invoice_external_id
	         ),
	         joined AS (
	           SELECT
	             i.invoice_external_id,
	             i.issued_at,
	             coalesce(p.last_paid_at, i.paid_at) AS resolved_paid_at
	           FROM invoices i
	           LEFT JOIN paid_apps p ON p.invoice_external_id = i.invoice_external_id
	         )
	         SELECT
	           formatDateTime(toStartOfMonth(issued_at), '%m/%y') AS month,
	           toStartOfMonth(issued_at) AS month_start,
	           avg(dateDiff('day', toDate(issued_at), toDate(resolved_paid_at))) AS avg_days_to_pay,
	           count() AS paid_invoice_count
	         FROM joined
	         WHERE resolved_paid_at IS NOT NULL
	           AND resolved_paid_at >= issued_at
	         GROUP BY month, month_start
	         ORDER BY month_start ASC
	         LIMIT 36`,
        {
          externalOrgIds: scope.externalOrgIds,
          ...providerParam,
          ...clientParam,
          ...clientListParam,
          ...entityParam,
        },
      );
      return {
        data: rows.map((r) => ({
          name: r.month as string,
          value: Math.round(this.num(r.avg_days_to_pay) * 10) / 10,
          count: this.num(r.paid_invoice_count),
        })),
      };
    }

    // ── payment_days/bucket (bar histogram) ──────────────────────────────────
    if (metric === 'payment_days' && grouping === 'bucket') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `WITH invoices AS (
	           SELECT
	             invoice_external_id,
	             issued_at,
	             paid_at
	           FROM ${this.analyticsDb}.fact_accounting_invoices
	           WHERE org_id IN ({externalOrgIds:Array(String)})
	             ${provider}
	             ${client}
	             ${time}
	             ${arFilter}
	             AND issued_at IS NOT NULL
	             AND invoice_external_id != ''
	         ),
	         paid_apps AS (
	           SELECT
	             invoice_external_id,
	             max(payment_at) AS last_paid_at
	           FROM ${this.analyticsDb}.fact_accounting_payment_applications
	           WHERE org_id IN ({externalOrgIds:Array(String)})
	             AND payment_at IS NOT NULL
	             AND payment_at <= ${rangeEndExpr}
	             AND invoice_external_id != ''
	           GROUP BY invoice_external_id
	         ),
	         joined AS (
	           SELECT
	             i.invoice_external_id,
	             i.issued_at,
	             coalesce(p.last_paid_at, i.paid_at) AS resolved_paid_at
	           FROM invoices i
	           LEFT JOIN paid_apps p ON p.invoice_external_id = i.invoice_external_id
	         ),
	         calc AS (
	           SELECT
	             dateDiff('day', toDate(issued_at), toDate(resolved_paid_at)) AS days_to_pay
	           FROM joined
	           WHERE resolved_paid_at IS NOT NULL
	             AND resolved_paid_at >= issued_at
	         )
	         SELECT
	           multiIf(
	             days_to_pay <= 7,   '0-7',
	             days_to_pay <= 14,  '8-14',
	             days_to_pay <= 30,  '15-30',
	             days_to_pay <= 60,  '31-60',
	             '60+'
	           ) AS bucket,
	           count() AS invoice_count
	         FROM calc
	         GROUP BY bucket
	         ORDER BY
	           multiIf(bucket='0-7',1,bucket='8-14',2,bucket='15-30',3,bucket='31-60',4,5) ASC`,
        {
          externalOrgIds: scope.externalOrgIds,
          ...providerParam,
          ...clientParam,
        },
      );
      return {
        data: rows.map((r) => ({
          name: r.bucket as string,
          value: this.num(r.invoice_count),
        })),
      };
    }

    // ── invoice_amount/bucket (invoice size histogram) ───────────────────────
    if (metric === 'invoice_amount' && grouping === 'bucket') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `WITH scoped AS (
           SELECT
             abs(toFloat64(total_amount)) AS amount
		             FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
		             WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})
		               ${provider}
		               ${client}
		               ${entity}
		               ${time}
		               ${arFilter}
             AND issued_at IS NOT NULL
         )
         SELECT
           multiIf(
             amount < 100, '0-99',
             amount < 500, '100-499',
             amount < 1000, '500-999',
             amount < 5000, '1K-4.9K',
             amount < 10000, '5K-9.9K',
             amount < 50000, '10K-49.9K',
             '50K+'
           ) AS bucket,
           count() AS invoice_count
         FROM scoped
         GROUP BY bucket
         ORDER BY
           multiIf(bucket='0-99',1,bucket='100-499',2,bucket='500-999',3,bucket='1K-4.9K',4,bucket='5K-9.9K',5,bucket='10K-49.9K',6,7) ASC`,
        {
          externalOrgIds: scope.externalOrgIds,
          ...providerParam,
          ...clientParam,
          ...entityParam,
        },
      );
      return {
        data: rows.map((r) => ({
          name: String(r.bucket ?? ''),
          value: this.num(r.invoice_count),
        })),
      };
    }

    // ── top_invoices/list (table) ────────────────────────────────────────────
    if (metric === 'top_invoices' && grouping === 'list') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           coalesce(nullIf(org_name, ''), org_id) AS org_name,
           provider,
           currency,
           coalesce(nullIf(contact_name, ''), 'Unknown') AS client_name,
           invoice_number,
           formatDateTime(issued_at, '%Y-%m-%d') AS issued_date,
           status,
           round(toFloat64(total_amount), 2) AS total_amount
         FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
	         WHERE org_id IN ({externalOrgIds:Array(String)})
	           ${provider}
	           ${client}
	           ${entity}
	           ${time}
	           ${arFilter}
	           AND issued_at IS NOT NULL
	         ORDER BY abs(total_amount) DESC
	         LIMIT ${requestedTopN ?? 10}`,
        {
          externalOrgIds: scope.externalOrgIds,
          ...providerParam,
          ...clientParam,
          ...entityParam,
        },
      );
      return { data: rows };
    }

    // ── invoice_value/invoice_type (pie) ─────────────────────────────────────
    if (metric === 'invoice_value' && grouping === 'invoice_type') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           coalesce(nullIf(invoice_type, ''), 'Unknown') AS invoice_type,
           round(sum(abs(total_amount)), 0) AS total_value
         FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
         WHERE org_id IN ({externalOrgIds:Array(String)})
           ${provider}
           ${client}
           ${entity}
           ${time}
           AND issued_at IS NOT NULL
         GROUP BY invoice_type
         ORDER BY total_value DESC
         LIMIT 12`,
        {
          externalOrgIds: scope.externalOrgIds,
          ...providerParam,
          ...clientParam,
          ...entityParam,
        },
      );
      return {
        data: rows.map((r) => ({
          name: String(r.invoice_type ?? ''),
          value: this.num(r.total_value),
        })),
      };
    }

    // ── transaction_value/journal_type (pie) ─────────────────────────────────
    if (metric === 'transaction_value' && grouping === 'journal_type') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const jTbl = `${this.analyticsDb}.v_fact_accounting_journal_lines_enriched_latest`;
      const jTime = this.timeWhereOn('journal_date', range);
      const rows = await this.queryRows<any>(
        `SELECT
           coalesce(nullIf(source_type, ''), 'Other') AS journal_type,
           round(sum(abs(line_amount)), 0) AS total_value
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})
           ${entity}
           ${jTime}
           AND journal_date IS NOT NULL
         GROUP BY journal_type
         ORDER BY total_value DESC
         LIMIT 12`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      return {
        data: rows.map((r) => ({
          name: String(r.journal_type ?? ''),
          value: this.num(r.total_value),
        })),
      };
    }

    // ── transaction_value/currency (donut/pie) ───────────────────────────────
    if (metric === 'transaction_value' && grouping === 'currency') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           coalesce(nullIf(currency, ''), 'Unknown') AS currency,
           round(sum(abs(total_amount)), 0) AS total_value
         FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
         WHERE org_id IN ({externalOrgIds:Array(String)})
           ${provider}
           ${client}
           ${entity}
           ${time}
           ${arFilter}
           AND issued_at IS NOT NULL
         GROUP BY currency
         ORDER BY total_value DESC
         LIMIT 12`,
        {
          externalOrgIds: scope.externalOrgIds,
          ...providerParam,
          ...clientParam,
          ...entityParam,
        },
      );
      return {
        data: rows.map((r) => ({
          name: String(r.currency ?? ''),
          value: this.num(r.total_value),
        })),
      };
    }

    // ── invoice_amount/time (scatter) ────────────────────────────────────────
    if (metric === 'invoice_amount' && grouping === 'time') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           formatDateTime(toDate(issued_at), '%Y-%m-%d') AS date,
           round(toFloat64(abs(total_amount)), 2) AS amount
         FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
         WHERE org_id IN ({externalOrgIds:Array(String)})
           ${provider}
           ${client}
           ${entity}
           ${time}
           ${arFilter}
           AND issued_at IS NOT NULL
         ORDER BY issued_at ASC
         LIMIT 600`,
        {
          externalOrgIds: scope.externalOrgIds,
          ...providerParam,
          ...clientParam,
          ...entityParam,
        },
      );
      return {
        data: rows.map((r) => ({
          date: String(r.date ?? ''),
          amount: this.num(r.amount),
        })),
      };
    }

    // ── overdue/aging (table) ────────────────────────────────────────────────
    if (metric === 'overdue' && grouping === 'aging') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `WITH invoices AS (
           SELECT
             invoice_external_id,
             invoice_number,
             coalesce(nullIf(contact_name, ''), 'Unknown') AS contact_name,
             coalesce(nullIf(org_name, ''), org_id) AS org_name,
             provider,
             currency,
             toDecimal64(total_amount, 4) AS total_amount,
             issued_at,
             due_at,
             invoice_type
           FROM ${this.analyticsDb}.fact_accounting_invoices
           WHERE org_id IN ({externalOrgIds:Array(String)})
             ${time}
             ${arFilter}
             AND issued_at IS NOT NULL
         ),
         paid AS (
           SELECT
             invoice_external_id,
             sum(amount) AS paid_to_date
           FROM ${this.analyticsDb}.fact_accounting_payment_applications
           WHERE org_id IN ({externalOrgIds:Array(String)})
             AND payment_at IS NOT NULL
             AND payment_at <= ${rangeEndExpr}
             AND invoice_external_id != ''
           GROUP BY invoice_external_id
         ),
         per_invoice AS (
           SELECT
             i.*,
             greatest(i.total_amount - ifNull(p.paid_to_date, toDecimal64(0, 4)), toDecimal64(0, 4)) AS balance
           FROM invoices i
           LEFT JOIN paid p ON p.invoice_external_id = i.invoice_external_id
         )
         SELECT
           formatDateTime(issued_at, '%Y-%m-%d') AS issued_date,
           formatDateTime(due_at,   '%Y-%m-%d') AS due_date,
           invoice_number,
           contact_name,
           org_name,
           provider,
           currency,
           round(toFloat64(balance), 2) AS outstanding_amount,
           dateDiff('day', toDate(due_at), toDate(${rangeEndExpr})) AS days_overdue,
           multiIf(
             dateDiff('day', toDate(due_at), toDate(${rangeEndExpr})) <= 30, '0-30',
             dateDiff('day', toDate(due_at), toDate(${rangeEndExpr})) <= 60, '31-60',
             '60+'
           ) AS aging_bucket
         FROM per_invoice
         WHERE due_at IS NOT NULL
           AND due_at < ${rangeEndExpr}
           AND balance > 0
         ORDER BY days_overdue DESC
         LIMIT 200`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return { data: rows };
    }

    if (metric === 'invoices' && grouping === 'org') {
      const rows = await this.queryRows<any>(
        `SELECT coalesce(org_name, org_id) AS org_name, count() AS total_count, coalesce(sum(total_amount), 0) AS total_amount
         FROM ${this.analyticsDb}.fact_accounting_invoices
         WHERE org_id IN ({externalOrgIds:Array(String)})
           ${provider}
           ${entity}
           ${time}
         GROUP BY org_name, org_id ORDER BY total_count DESC LIMIT 10`,
        {
          externalOrgIds: scope.externalOrgIds,
          ...providerParam,
          ...entityParam,
        },
      );
      return {
        data: rows.map((r) => ({
          name: (r.org_name as string) || 'Unknown',
          value: this.num(r.total_count),
        })),
      };
    }

    if (metric === 'revenue' && grouping === 'org') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT coalesce(org_name, org_id) AS org_name, coalesce(sum(total_amount), 0) AS total_revenue
         FROM ${this.analyticsDb}.fact_accounting_invoices
         WHERE org_id IN ({externalOrgIds:Array(String)})
           ${provider}
           ${entity}
           ${time}
           ${arFilter}
           AND issued_at IS NOT NULL
         GROUP BY org_name, org_id ORDER BY total_revenue DESC LIMIT 10`,
        {
          externalOrgIds: scope.externalOrgIds,
          ...providerParam,
          ...entityParam,
        },
      );
      return {
        data: rows.map((r) => ({
          name: (r.org_name as string) || 'Unknown',
          value: this.num(r.total_revenue),
        })),
      };
    }

    if (metric === 'revenue' && grouping === 'provider') {
      const rows = await this.queryRows<any>(
        `SELECT provider, coalesce(sum(total_amount), 0) AS total_revenue
         FROM ${this.analyticsDb}.fact_accounting_invoices
         WHERE org_id IN ({externalOrgIds:Array(String)})
           ${provider}
           ${entity}
           ${time}
           ${arFilter}
           AND issued_at IS NOT NULL
         GROUP BY provider ORDER BY total_revenue DESC`,
        {
          externalOrgIds: scope.externalOrgIds,
          ...providerParam,
          ...entityParam,
        },
      );
      return {
        data: rows.map((r) => ({
          name: (r.provider as string) || 'Unknown',
          value: this.num(r.total_revenue),
        })),
      };
    }

    if (metric === 'invoice_count' && grouping === 'month') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           formatDateTime(toStartOfMonth(issued_at), '%m/%y') AS month,
           toStartOfMonth(issued_at) AS month_start,
           count() AS invoice_count
         FROM ${this.analyticsDb}.fact_accounting_invoices
         WHERE org_id IN ({externalOrgIds:Array(String)})
           ${provider}
           ${entity}
           ${time}
           ${arFilter}
           AND issued_at IS NOT NULL
         GROUP BY month, month_start ORDER BY month_start ASC LIMIT 24`,
        {
          externalOrgIds: scope.externalOrgIds,
          ...providerParam,
          ...entityParam,
        },
      );
      return {
        data: rows.map((r) => ({
          name: r.month as string,
          value: this.num(r.invoice_count),
        })),
      };
    }

    // ── revenue/month ─────────────────────────────────────────────────────────
    if (metric === 'revenue' && grouping === 'month') {
      if (scope.externalOrgIds.length === 0) return { data: [] };

      // Multi-series client breakdown (either explicit clients OR top-N clients).
      // Output rows: { name: "MM/YY", "<Client A>": 123, "<Client B>": 456 }
      if (breakdown === 'client') {
        const explicitClients =
          normalizedClientNames && normalizedClientNames.length >= 2
            ? normalizedClientNames
                .map((c) => c.toLowerCase())
                .filter(Boolean)
                .slice(0, 5)
            : null;
        const n =
          explicitClients && explicitClients.length >= 2
            ? explicitClients.length
            : Number.isFinite(topN as number)
              ? Math.max(1, Math.min(5, Math.floor(topN as number)))
              : 2;

        const rows = await this.queryRows<any>(
          `WITH scoped AS (
             SELECT
               toStartOfMonth(issued_at) AS month_start,
               formatDateTime(toStartOfMonth(issued_at), '%m/%y') AS month,
               coalesce(nullIf(contact_name, ''), 'Unknown Client') AS client_name,
               lowerUTF8(coalesce(nullIf(contact_name, ''), 'Unknown Client')) AS client_name_lower,
               sumIf(total_amount, lowerUTF8(status) IN ('paid','voided','closed','active','open')) AS collected
             FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
             WHERE org_id IN ({externalOrgIds:Array(String)})
               ${provider}
               ${client}
               ${clientListFact}
               ${entity}
               ${time}
               ${arFilter}
               AND issued_at IS NOT NULL
             GROUP BY month_start, month, client_name, client_name_lower
           ),
           top_clients AS (
             SELECT client_name_lower
             FROM scoped
             GROUP BY client_name_lower
             ORDER BY sum(collected) DESC
             LIMIT ${n}
           )
           SELECT
             month,
             month_start,
             client_name,
             collected
           FROM scoped
           WHERE ${
             explicitClients && explicitClients.length >= 2
               ? `client_name_lower IN ({clientNames:Array(String)})`
               : `client_name_lower IN (SELECT client_name_lower FROM top_clients)`
           }
           ORDER BY month_start ASC, client_name ASC`,
          {
            externalOrgIds: scope.externalOrgIds,
            ...providerParam,
            ...clientParam,
            ...clientListParam,
            ...entityParam,
            ...(explicitClients ? { clientNames: explicitClients } : {}),
          },
        );

        const map = new Map<string, any>();
        for (const r of rows) {
          const key = String(r.month);
          const existing = map.get(key) ?? { name: key };
          existing[String(r.client_name)] = this.num(r.collected);
          map.set(key, existing);
        }
        return { data: Array.from(map.values()) };
      }

      // Default single-series revenue trend
      const rows = await this.queryRows<any>(
        `SELECT
           formatDateTime(toStartOfMonth(issued_at), '%m/%y') AS month,
           toStartOfMonth(issued_at) AS month_start,
           coalesce(sum(total_amount), 0) AS total_revenue
         FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
         WHERE org_id IN ({externalOrgIds:Array(String)})
           ${provider}
           ${client}
           ${entity}
           ${time}
           ${arFilter}
           AND issued_at IS NOT NULL
         GROUP BY month, month_start
         ORDER BY month_start ASC
         LIMIT 36`,
        {
          externalOrgIds: scope.externalOrgIds,
          ...providerParam,
          ...clientParam,
          ...clientListParam,
          ...entityParam,
        },
      );
      return {
        data: rows.map((r) => ({
          name: r.month as string,
          value: this.num(r.total_revenue),
        })),
      };
    }

    if (metric === 'overdue' && grouping === 'month') {
      if (scope.externalOrgIds.length === 0) return { data: [] };

      // Client breakdown (explicit client list only): returns multi-series rows:
      // { name: "MM/YY", "<Client A>": 123, "<Client B>": 456 }
      if (
        breakdown === 'client' &&
        normalizedClientNames &&
        normalizedClientNames.length >= 2
      ) {
        const explicitClients = normalizedClientNames
          .map((c) => c.toLowerCase())
          .filter(Boolean)
          .slice(0, 5);

        const rows = await this.queryRows<any>(
          `WITH invoices AS (
             SELECT
               invoice_external_id,
               coalesce(nullIf(contact_name, ''), 'Unknown Client') AS client_name,
               lowerUTF8(coalesce(nullIf(contact_name, ''), 'Unknown Client')) AS client_name_lower,
               toDecimal64(total_amount, 4) AS total_amount,
               issued_at,
               due_at
             FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
             WHERE org_id IN ({externalOrgIds:Array(String)})
               ${provider}
               ${client}
               ${clientListFact}
               ${entity}
               ${time}
               ${arFilter}
               AND issued_at IS NOT NULL
           ),
           pay_by_month AS (
             SELECT
               invoice_external_id,
               toStartOfMonth(payment_at) AS month_start,
               sum(amount) AS paid_this_month
             FROM ${this.analyticsDb}.fact_accounting_payment_applications
             WHERE org_id IN ({externalOrgIds:Array(String)})
               ${entity}
               AND payment_at IS NOT NULL
               AND payment_at <= ${rangeEndExpr}
               AND invoice_external_id != ''
             GROUP BY invoice_external_id, month_start
           ),
           grid AS (
             SELECT
               i.invoice_external_id,
               i.client_name,
               i.client_name_lower,
               i.total_amount,
               i.due_at,
               i.month_start
             FROM (
               SELECT
                 invoice_external_id,
                 client_name,
                 client_name_lower,
                 total_amount,
                 due_at,
                 addMonths(toStartOfMonth(issued_at), m) AS month_start
               FROM invoices
               ARRAY JOIN range(
                 0,
                 dateDiff('month', toStartOfMonth(issued_at), toStartOfMonth(${rangeEndExpr})) + 1
               ) AS m
             ) i
           ),
           joined AS (
             SELECT
               g.invoice_external_id,
               g.client_name,
               g.client_name_lower,
               g.total_amount,
               g.due_at,
               g.month_start,
               ifNull(p.paid_this_month, toDecimal64(0, 4)) AS paid_this_month
             FROM grid g
             LEFT JOIN pay_by_month p
               ON p.invoice_external_id = g.invoice_external_id
              AND p.month_start = g.month_start
           ),
           calc AS (
             SELECT
               invoice_external_id,
               client_name,
               client_name_lower,
               month_start,
               due_at,
               total_amount,
               sum(paid_this_month) OVER (
                 PARTITION BY invoice_external_id
                 ORDER BY month_start ASC
                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
               ) AS paid_to_date,
               greatest(total_amount - paid_to_date, toDecimal64(0, 4)) AS outstanding_balance,
               if(due_at IS NOT NULL AND due_at < addMonths(month_start, 1),
                 greatest(total_amount - paid_to_date, toDecimal64(0, 4)),
                 toDecimal64(0, 4)
               ) AS overdue_balance
             FROM joined
           )
           SELECT
             formatDateTime(month_start, '%m/%y') AS month,
             month_start,
             client_name,
             sum(overdue_balance) AS overdue_amount
           FROM calc
           WHERE client_name_lower IN ({clientNames:Array(String)})
           GROUP BY month, month_start, client_name
           ORDER BY month_start ASC, client_name ASC
           LIMIT 240`,
          {
            externalOrgIds: scope.externalOrgIds,
            ...providerParam,
            ...clientParam,
            ...clientListParam,
            ...entityParam,
            clientNames: explicitClients,
          },
        );

        const map = new Map<string, any>();
        for (const r of rows) {
          const key = String(r.month);
          const existing = map.get(key) ?? { name: key };
          existing[String(r.client_name)] = this.num(r.overdue_amount);
          map.set(key, existing);
        }
        return { data: Array.from(map.values()) };
      }

      const rows = await this.queryRows<any>(
        `WITH invoices AS (
           SELECT
             invoice_external_id,
             toDecimal64(total_amount, 4) AS total_amount,
             issued_at,
             due_at
           FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
           WHERE org_id IN ({externalOrgIds:Array(String)})
             ${provider}
             ${client}
             ${clientListFact}
             ${entity}
             ${time}
             ${arFilter}
             AND issued_at IS NOT NULL
         ),
         pay_by_month AS (
           SELECT
             invoice_external_id,
             toStartOfMonth(payment_at) AS month_start,
             sum(amount) AS paid_this_month
           FROM ${this.analyticsDb}.fact_accounting_payment_applications
           WHERE org_id IN ({externalOrgIds:Array(String)})
             ${entity}
             AND payment_at IS NOT NULL
             AND payment_at <= ${rangeEndExpr}
             AND invoice_external_id != ''
           GROUP BY invoice_external_id, month_start
         ),
         grid AS (
           SELECT
             i.invoice_external_id,
             i.total_amount,
             i.due_at,
             addMonths(toStartOfMonth(i.issued_at), m) AS month_start
           FROM invoices i
           ARRAY JOIN range(
             0,
             dateDiff('month', toStartOfMonth(i.issued_at), toStartOfMonth(${rangeEndExpr})) + 1
           ) AS m
         ),
         joined AS (
           SELECT
             g.invoice_external_id,
             g.total_amount,
             g.due_at,
             g.month_start,
             ifNull(p.paid_this_month, toDecimal64(0, 4)) AS paid_this_month
           FROM grid g
           LEFT JOIN pay_by_month p
             ON p.invoice_external_id = g.invoice_external_id
            AND p.month_start = g.month_start
         ),
         calc AS (
           SELECT
             invoice_external_id,
             month_start,
             due_at,
             total_amount,
             sum(paid_this_month) OVER (
               PARTITION BY invoice_external_id
               ORDER BY month_start ASC
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
             ) AS paid_to_date,
             greatest(total_amount - paid_to_date, toDecimal64(0, 4)) AS outstanding_balance,
             if(due_at IS NOT NULL AND due_at < addMonths(month_start, 1),
               greatest(total_amount - paid_to_date, toDecimal64(0, 4)),
               toDecimal64(0, 4)
             ) AS overdue_balance
           FROM joined
         )
         SELECT
           formatDateTime(month_start, '%m/%y') AS month,
           month_start,
           sum(overdue_balance) AS overdue_amount,
           uniqIf(invoice_external_id, overdue_balance > 0) AS overdue_count
         FROM calc
         GROUP BY month, month_start
         ORDER BY month_start ASC
         LIMIT 36`,
        {
          externalOrgIds: scope.externalOrgIds,
          ...providerParam,
          ...clientParam,
          ...clientListParam,
          ...entityParam,
        },
      );
      return {
        data: rows.map((r) => ({
          name: r.month as string,
          value: this.num(r.overdue_amount),
          count: this.num(r.overdue_count),
        })),
      };
    }

    if (metric === 'revenue' && grouping === 'client') {
      if (scope.externalOrgIds.length === 0) return { data: [] };

      // Fast path: for all-time client revenue breakdown, prefer gold dim_clients
      // (more reliable client naming than raw invoice contact fields).
      if (!time.trim() && !clientName) {
        const rows = await this.queryRows<any>(
          `SELECT
	             coalesce(nullIf(client_name, ''), nullIf(client_id, ''), 'Unknown Client') AS client_name,
	             sum(total_revenue) AS total_collected,
	             sum(total_invoiced) AS total_invoiced,
	             sum(total_outstanding) AS total_outstanding,
	             sum(total_overdue) AS total_overdue,
	             sum(invoice_count) AS invoice_count,
	             sum(overdue_count) AS overdue_count,
	             avg(avg_invoice_amount) AS avg_invoice_amount
		           FROM ${this.analyticsDb}.v_dim_clients_latest
		           WHERE org_id IN ({externalOrgIds:Array(String)})
		             ${clientListDim}
		             ${entity}
		           GROUP BY client_name
		           ORDER BY total_collected DESC
		           LIMIT ${requestedTopN ?? 30}`,
          {
            externalOrgIds: scope.externalOrgIds,
            ...clientListParam,
            ...entityParam,
          },
        );
        if (rows.length > 0) {
          return {
            data: rows.map((r) => ({
              name: r.client_name as string,
              value: this.num(r.total_collected),
              invoiceCount: this.num(r.invoice_count),
              overdueCount: this.num(r.overdue_count),
              outstanding: this.num(r.total_outstanding),
              overdue: this.num(r.total_overdue),
              avgInvoice: this.num(r.avg_invoice_amount),
              totalInvoiced: this.num(r.total_invoiced),
            })),
          };
        }
      }

      try {
        const rows = await this.queryRows<any>(
          `WITH invoices AS (
	           SELECT
	             invoice_external_id,
             coalesce(nullIf(contact_name, ''), 'Unknown Client') AS client_name,
             contact_id AS client_id,
             toDecimal64(total_amount, 4) AS total_amount,
             issued_at,
             due_at
		           FROM ${this.analyticsDb}.fact_accounting_invoices
		           WHERE org_id IN ({externalOrgIds:Array(String)})
		             ${provider}
		             ${client}
		             ${clientListFact}
		             ${entity}
		             ${time}
		             ${arFilter}
		             AND issued_at IS NOT NULL
	         ),
         paid AS (
           SELECT
             invoice_external_id,
             sum(amount) AS paid_to_date,
             max(payment_at) AS last_paid_at
	           FROM ${this.analyticsDb}.fact_accounting_payment_applications
	           WHERE org_id IN ({externalOrgIds:Array(String)})
	             ${entity}
	             AND payment_at IS NOT NULL
	             AND payment_at <= ${rangeEndExpr}
	             AND invoice_external_id != ''
	           GROUP BY invoice_external_id
         ),
         per_invoice AS (
           SELECT
             i.client_name,
             i.client_id,
             i.total_amount,
             i.due_at,
             ifNull(p.paid_to_date, toDecimal64(0, 4)) AS paid_to_date,
             greatest(i.total_amount - ifNull(p.paid_to_date, toDecimal64(0, 4)), toDecimal64(0, 4)) AS balance
           FROM invoices i
           LEFT JOIN paid p ON p.invoice_external_id = i.invoice_external_id
         )
         SELECT
           client_name,
           client_id,
           sum(total_amount) AS total_invoiced,
           sum(paid_to_date) AS total_collected,
           sumIf(balance, due_at IS NULL OR due_at >= ${rangeEndExpr}) AS total_outstanding,
           sumIf(balance, due_at IS NOT NULL AND due_at < ${rangeEndExpr}) AS total_overdue,
           count() AS invoice_count,
           countIf(balance > 0 AND due_at IS NOT NULL AND due_at < ${rangeEndExpr}) AS overdue_count,
           avg(toFloat64(total_amount)) AS avg_invoice_amount
         FROM per_invoice
         GROUP BY client_name, client_id
	         ORDER BY total_collected DESC
	         LIMIT 15`,
          {
            externalOrgIds: scope.externalOrgIds,
            ...providerParam,
            ...clientParam,
            ...clientListParam,
            ...entityParam,
          },
        );

        return {
          data: rows.map((r) => ({
            name: r.client_name as string,
            value: this.num(r.total_collected),
            invoiceCount: this.num(r.invoice_count),
            overdueCount: this.num(r.overdue_count),
            outstanding: this.num(r.total_outstanding),
            overdue: this.num(r.total_overdue),
            avgInvoice: this.num(r.avg_invoice_amount),
            totalInvoiced: this.num(r.total_invoiced),
          })),
        };
      } catch {
        // Compatibility fallback when fact table lacks contact columns: return lifetime dim_clients.
        const rows = await this.queryRows<any>(
          `SELECT
             coalesce(nullIf(client_name, ''), 'Unknown Client') AS client_name,
             client_id,
             total_revenue,
             invoice_count,
             overdue_count,
             total_outstanding,
             total_overdue,
             avg_invoice_amount
	           FROM ${this.analyticsDb}.v_dim_clients_latest
	           WHERE org_id IN ({externalOrgIds:Array(String)})
	             ${clientListDim}
	             AND client_name != ''
	           ORDER BY total_revenue DESC LIMIT 15`,
          { externalOrgIds: scope.externalOrgIds, ...clientListParam },
        );
        return {
          data: rows.map((r) => ({
            name: r.client_name as string,
            value: this.num(r.total_revenue),
            invoiceCount: this.num(r.invoice_count),
            overdueCount: this.num(r.overdue_count),
            outstanding: this.num(r.total_outstanding),
            overdue: this.num(r.total_overdue),
            avgInvoice: this.num(r.avg_invoice_amount),
            totalInvoiced: 0,
          })),
        };
      }
    }

    if (metric === 'invoices' && grouping === 'client') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      if (time.trim()) {
        try {
          const rows = await this.queryRows<any>(
            `SELECT
               coalesce(nullIf(contact_name, ''), 'Unknown Client') AS client_name,
               contact_id AS client_id,
               count() AS invoice_count,
               coalesce(sum(abs(total_amount)), 0) AS total_invoiced
             FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
             WHERE org_id IN ({externalOrgIds:Array(String)})
               ${time}
               ${clientListFact}
               ${arFilter}
               AND issued_at IS NOT NULL
             GROUP BY client_name, client_id
             ORDER BY invoice_count DESC LIMIT 15`,
            { externalOrgIds: scope.externalOrgIds, ...clientListParam },
          );
          return {
            data: rows.map((r) => ({
              name: r.client_name as string,
              value: this.num(r.invoice_count),
              totalAmount: this.num(r.total_invoiced),
            })),
          };
        } catch {
          // Fall back to lifetime client dimension if fact lacks contact columns.
          const rows = await this.queryRows<any>(
            `SELECT
               coalesce(nullIf(client_name, ''), 'Unknown Client') AS client_name,
               client_id,
               invoice_count,
               total_invoiced
             FROM ${this.analyticsDb}.v_dim_clients_latest
             WHERE org_id IN ({externalOrgIds:Array(String)})
               ${clientListDim}
               AND client_name != ''
             ORDER BY invoice_count DESC LIMIT 15`,
            { externalOrgIds: scope.externalOrgIds, ...clientListParam },
          );
          return {
            data: rows.map((r) => ({
              name: r.client_name as string,
              value: this.num(r.invoice_count),
              totalAmount: this.num(r.total_invoiced),
            })),
          };
        }
      }
      const rows = await this.queryRows<any>(
        `SELECT
           coalesce(nullIf(client_name, ''), 'Unknown Client') AS client_name,
           client_id,
           invoice_count,
           total_invoiced
         FROM ${this.analyticsDb}.v_dim_clients_latest
         WHERE org_id IN ({externalOrgIds:Array(String)})
           ${clientListDim}
           AND client_name != ''
         ORDER BY invoice_count DESC LIMIT 15`,
        { externalOrgIds: scope.externalOrgIds, ...clientListParam },
      );
      return {
        data: rows.map((r) => ({
          name: r.client_name as string,
          value: this.num(r.invoice_count),
          totalAmount: this.num(r.total_invoiced),
        })),
      };
    }

    // ── outstanding/month ──────────────────────────────────────────────────────
    if (metric === 'outstanding' && grouping === 'month') {
      if (scope.externalOrgIds.length === 0) return { data: [] };

      // Client breakdown (explicit client list only): returns multi-series rows:
      // { name: "MM/YY", "<Client A>": 123, "<Client B>": 456 }
      if (
        breakdown === 'client' &&
        normalizedClientNames &&
        normalizedClientNames.length >= 2
      ) {
        const explicitClients = normalizedClientNames
          .map((c) => c.toLowerCase())
          .filter(Boolean)
          .slice(0, 5);

        const rows = await this.queryRows<any>(
          `WITH invoices AS (
             SELECT
               invoice_external_id,
               coalesce(nullIf(contact_name, ''), 'Unknown Client') AS client_name,
               lowerUTF8(coalesce(nullIf(contact_name, ''), 'Unknown Client')) AS client_name_lower,
               toDecimal64(total_amount, 4) AS total_amount,
               issued_at,
               due_at
             FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
             WHERE org_id IN ({externalOrgIds:Array(String)})
               ${provider}
               ${client}
               ${clientListFact}
               ${entity}
               ${time}
               ${arFilter}
               AND issued_at IS NOT NULL
           ),
           pay_by_month AS (
             SELECT
               invoice_external_id,
               toStartOfMonth(payment_at) AS month_start,
               sum(amount) AS paid_this_month
             FROM ${this.analyticsDb}.fact_accounting_payment_applications
             WHERE org_id IN ({externalOrgIds:Array(String)})
               ${entity}
               AND payment_at IS NOT NULL
               AND payment_at <= ${rangeEndExpr}
               AND invoice_external_id != ''
             GROUP BY invoice_external_id, month_start
           ),
           grid AS (
             SELECT
               i.invoice_external_id,
               i.client_name,
               i.client_name_lower,
               i.total_amount,
               i.month_start,
               i.due_at
             FROM (
               SELECT
                 invoice_external_id,
                 client_name,
                 client_name_lower,
                 total_amount,
                 due_at,
                 addMonths(toStartOfMonth(issued_at), m) AS month_start
               FROM invoices
               ARRAY JOIN range(
                 0,
                 dateDiff('month', toStartOfMonth(issued_at), toStartOfMonth(${rangeEndExpr})) + 1
               ) AS m
             ) i
           ),
           joined AS (
             SELECT
               g.invoice_external_id,
               g.client_name,
               g.client_name_lower,
               g.total_amount,
               g.due_at,
               g.month_start,
               ifNull(p.paid_this_month, toDecimal64(0, 4)) AS paid_this_month
             FROM grid g
             LEFT JOIN pay_by_month p
               ON p.invoice_external_id = g.invoice_external_id
              AND p.month_start = g.month_start
           ),
           calc AS (
             SELECT
               invoice_external_id,
               client_name,
               client_name_lower,
               month_start,
               total_amount,
               sum(paid_this_month) OVER (
                 PARTITION BY invoice_external_id
                 ORDER BY month_start ASC
                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
               ) AS paid_to_date,
               greatest(total_amount - paid_to_date, toDecimal64(0, 4)) AS outstanding_balance
             FROM joined
           )
           SELECT
             formatDateTime(month_start, '%m/%y') AS month,
             month_start,
             client_name,
             sum(outstanding_balance) AS outstanding_amount
           FROM calc
           WHERE client_name_lower IN ({clientNames:Array(String)})
           GROUP BY month, month_start, client_name
           ORDER BY month_start ASC, client_name ASC
           LIMIT 240`,
          {
            externalOrgIds: scope.externalOrgIds,
            ...providerParam,
            ...clientParam,
            ...clientListParam,
            ...entityParam,
            clientNames: explicitClients,
          },
        );

        const map = new Map<string, any>();
        for (const r of rows) {
          const key = String(r.month);
          const existing = map.get(key) ?? { name: key };
          existing[String(r.client_name)] = this.num(r.outstanding_amount);
          map.set(key, existing);
        }
        return { data: Array.from(map.values()) };
      }

      const rows = await this.queryRows<any>(
        `WITH invoices AS (
           SELECT
             invoice_external_id,
             toDecimal64(total_amount, 4) AS total_amount,
             issued_at,
             due_at
           FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
           WHERE org_id IN ({externalOrgIds:Array(String)})
             ${provider}
             ${client}
             ${clientListFact}
             ${entity}
             ${time}
             ${arFilter}
             AND issued_at IS NOT NULL
         ),
         pay_by_month AS (
           SELECT
             invoice_external_id,
             toStartOfMonth(payment_at) AS month_start,
             sum(amount) AS paid_this_month
           FROM ${this.analyticsDb}.fact_accounting_payment_applications
           WHERE org_id IN ({externalOrgIds:Array(String)})
             ${entity}
             AND payment_at IS NOT NULL
             AND payment_at <= ${rangeEndExpr}
             AND invoice_external_id != ''
           GROUP BY invoice_external_id, month_start
         ),
         grid AS (
           SELECT
             i.invoice_external_id,
             i.total_amount,
             i.due_at,
             addMonths(toStartOfMonth(i.issued_at), m) AS month_start
           FROM invoices i
           ARRAY JOIN range(
             0,
             dateDiff('month', toStartOfMonth(i.issued_at), toStartOfMonth(${rangeEndExpr})) + 1
           ) AS m
         ),
         joined AS (
           SELECT
             g.invoice_external_id,
             g.total_amount,
             g.due_at,
             g.month_start,
             ifNull(p.paid_this_month, toDecimal64(0, 4)) AS paid_this_month
           FROM grid g
           LEFT JOIN pay_by_month p
             ON p.invoice_external_id = g.invoice_external_id
            AND p.month_start = g.month_start
         ),
         calc AS (
           SELECT
             invoice_external_id,
             month_start,
             total_amount,
             sum(paid_this_month) OVER (
               PARTITION BY invoice_external_id
               ORDER BY month_start ASC
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
             ) AS paid_to_date,
             greatest(total_amount - paid_to_date, toDecimal64(0, 4)) AS outstanding_balance
           FROM joined
         )
         SELECT
           formatDateTime(month_start, '%m/%y') AS month,
           month_start,
           sum(outstanding_balance) AS outstanding_amount
         FROM calc
         GROUP BY month, month_start
         ORDER BY month_start ASC
         LIMIT 36`,
        {
          externalOrgIds: scope.externalOrgIds,
          ...providerParam,
          ...clientParam,
          ...clientListParam,
          ...entityParam,
        },
      );
      return {
        data: rows.map((r) => ({
          name: r.month as string,
          value: this.num(r.outstanding_amount),
        })),
      };
    }

    // ── paid/month ────────────────────────────────────────────────────────────
    if (metric === 'paid' && grouping === 'month') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `WITH invoices AS (
	           SELECT invoice_external_id
	           FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
	           WHERE org_id IN ({externalOrgIds:Array(String)})
	             ${provider}
	             ${client}
	             ${clientListFact}
	             ${entity}
	             ${time}
	             ${arFilter}
	             AND issued_at IS NOT NULL
	         )
	         SELECT
	           formatDateTime(toStartOfMonth(p.payment_at), '%m/%y') AS month,
	           toStartOfMonth(p.payment_at) AS month_start,
	           sum(p.amount) AS paid_amount
	         FROM ${this.analyticsDb}.fact_accounting_payment_applications p
	         INNER JOIN invoices i ON i.invoice_external_id = p.invoice_external_id
	         WHERE p.org_id IN ({externalOrgIds:Array(String)})
	           ${entity}
	           AND p.payment_at IS NOT NULL
	           AND p.payment_at <= ${rangeEndExpr}
	           AND p.invoice_external_id != ''
	         GROUP BY month, month_start
	         ORDER BY month_start ASC
	         LIMIT 36`,
        {
          externalOrgIds: scope.externalOrgIds,
          ...providerParam,
          ...clientParam,
          ...clientListParam,
          ...entityParam,
        },
      );
      return {
        data: rows.map((r) => ({
          name: r.month as string,
          value: this.num(r.paid_amount),
        })),
      };
    }

    // ── collection_rate/month ────────────────────────────────────────────────
    if (metric === 'collection_rate' && grouping === 'month') {
      if (scope.externalOrgIds.length === 0) return { data: [] };

      const invoicedRows = await this.queryRows<any>(
        `SELECT
           toStartOfMonth(issued_at) AS month_start,
           formatDateTime(toStartOfMonth(issued_at), '%m/%y') AS month,
           sum(total_amount) AS invoiced_amount
         FROM ${this.analyticsDb}.fact_accounting_invoices
         WHERE org_id IN ({externalOrgIds:Array(String)})
           ${time}
           ${arFilter}
           AND issued_at IS NOT NULL
         GROUP BY month_start, month
         ORDER BY month_start ASC
         LIMIT 36`,
        { externalOrgIds: scope.externalOrgIds },
      );

      const paidRows = await this.queryRows<any>(
        `WITH invoices AS (
           SELECT invoice_external_id
           FROM ${this.analyticsDb}.fact_accounting_invoices
           WHERE org_id IN ({externalOrgIds:Array(String)})
             ${time}
             ${arFilter}
             AND issued_at IS NOT NULL
         )
         SELECT
           toStartOfMonth(p.payment_at) AS month_start,
           formatDateTime(toStartOfMonth(p.payment_at), '%m/%y') AS month,
           sum(p.amount) AS paid_amount
         FROM ${this.analyticsDb}.fact_accounting_payment_applications p
         INNER JOIN invoices i ON i.invoice_external_id = p.invoice_external_id
         WHERE p.org_id IN ({externalOrgIds:Array(String)})
           AND p.payment_at IS NOT NULL
           AND p.payment_at <= ${rangeEndExpr}
           AND p.invoice_external_id != ''
         GROUP BY month_start, month
         ORDER BY month_start ASC
         LIMIT 36`,
        { externalOrgIds: scope.externalOrgIds },
      );

      const invoicedByMonth = new Map<
        string,
        { month: string; invoiced: number }
      >();
      for (const r of invoicedRows) {
        const k = String(r.month_start ?? '');
        invoicedByMonth.set(k, {
          month: String(r.month ?? ''),
          invoiced: this.num(r.invoiced_amount),
        });
      }

      const paidByMonth = new Map<string, { month: string; paid: number }>();
      for (const r of paidRows) {
        const k = String(r.month_start ?? '');
        paidByMonth.set(k, {
          month: String(r.month ?? ''),
          paid: this.num(r.paid_amount),
        });
      }

      const keys = Array.from(
        new Set([...invoicedByMonth.keys(), ...paidByMonth.keys()]),
      )
        .filter(Boolean)
        .sort();

      return {
        data: keys.map((k) => {
          const inv = invoicedByMonth.get(k);
          const pay = paidByMonth.get(k);
          const invoiced = inv?.invoiced ?? 0;
          const paid = pay?.paid ?? 0;
          const pct = invoiced > 0 ? (paid / invoiced) * 100 : 0;
          return {
            name: inv?.month || pay?.month || k,
            value: Math.round(pct * 10) / 10,
            paid: Math.round(paid),
            invoiced: Math.round(invoiced),
          };
        }),
      };
    }

    // ── mom_growth/month ─────────────────────────────────────────────────────
    if (metric === 'mom_growth' && grouping === 'month') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           toStartOfMonth(issued_at) AS month_start,
           formatDateTime(toStartOfMonth(issued_at), '%m/%y') AS month,
           sum(total_amount) AS revenue
         FROM ${this.analyticsDb}.fact_accounting_invoices
         WHERE org_id IN ({externalOrgIds:Array(String)})
           ${time}
           ${arFilter}
           AND issued_at IS NOT NULL
         GROUP BY month_start, month
         ORDER BY month_start ASC
         LIMIT 36`,
        { externalOrgIds: scope.externalOrgIds },
      );

      let prev = 0;
      const out = rows.map((r) => {
        const cur = this.num(r.revenue);
        const pct = prev > 0 ? ((cur - prev) / prev) * 100 : 0;
        prev = cur;
        return {
          name: String(r.month ?? ''),
          value: Math.round(pct * 10) / 10,
          revenue: Math.round(cur),
        };
      });
      return { data: out };
    }

    // ── revenue_cumulative/month ─────────────────────────────────────────────
    if (metric === 'revenue_cumulative' && grouping === 'month') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           toStartOfMonth(issued_at) AS month_start,
           formatDateTime(toStartOfMonth(issued_at), '%m/%y') AS month,
           round(sum(total_amount), 0) AS revenue
         FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
         WHERE org_id IN ({externalOrgIds:Array(String)})
           ${provider}
           ${client}
           ${entity}
           ${time}
           ${arFilter}
           AND issued_at IS NOT NULL
         GROUP BY month_start, month
         ORDER BY month_start ASC
         LIMIT 36`,
        {
          externalOrgIds: scope.externalOrgIds,
          ...providerParam,
          ...clientParam,
          ...entityParam,
        },
      );
      let running = 0;
      const out = rows.map((r) => {
        const cur = this.num(r.revenue);
        running += cur;
        return {
          name: String(r.month ?? ''),
          value: Math.round(running),
          revenue: Math.round(cur),
        };
      });
      return { data: out };
    }

    // ── debits_credits/month ─────────────────────────────────────────────────
    if (metric === 'debits_credits' && grouping === 'month') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const jTbl = `${this.analyticsDb}.v_fact_accounting_journal_lines_enriched_latest`;
      const jTime = this.timeWhereOn('journal_date', range);
      const rows = await this.queryRows<any>(
        `SELECT
           toStartOfMonth(journal_date) AS month_start,
           formatDateTime(toStartOfMonth(journal_date), '%m/%y') AS month,
           round(sumIf(line_amount, line_amount > 0), 0) AS debits,
           round(sumIf(-line_amount, line_amount < 0), 0) AS credits
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})
           ${entity}
           ${jTime}
           AND journal_date IS NOT NULL
         GROUP BY month_start, month
         ORDER BY month_start ASC
         LIMIT 36`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      return {
        data: rows.map((r) => ({
          name: String(r.month ?? ''),
          Debits: this.num(r.debits),
          Credits: this.num(r.credits),
        })),
      };
    }

    // ── net_position/month ───────────────────────────────────────────────────
    if (metric === 'net_position' && grouping === 'month') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const jTbl = `${this.analyticsDb}.v_fact_accounting_journal_lines_enriched_latest`;
      const jTime = this.timeWhereOn('journal_date', range);
      const rows = await this.queryRows<any>(
        `SELECT
           toStartOfMonth(journal_date) AS month_start,
           formatDateTime(toStartOfMonth(journal_date), '%m/%y') AS month,
           round(sumIf(line_amount, line_amount > 0), 0) AS debits,
           round(sumIf(-line_amount, line_amount < 0), 0) AS credits
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})
           ${entity}
           ${jTime}
           AND journal_date IS NOT NULL
         GROUP BY month_start, month
         ORDER BY month_start ASC
         LIMIT 36`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      return {
        data: rows.map((r) => {
          const debits = this.num(r.debits);
          const credits = this.num(r.credits);
          return {
            name: String(r.month ?? ''),
            value: Math.round(credits - debits),
            Debits: Math.round(debits),
            Credits: Math.round(credits),
          };
        }),
      };
    }

    // ── running_balance/month ────────────────────────────────────────────────
    // Cumulative net position (credits - debits) starting from zero.
    if (metric === 'running_balance' && grouping === 'month') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const jTbl = `${this.analyticsDb}.v_fact_accounting_journal_lines_enriched_latest`;
      const jTime = this.timeWhereOn('journal_date', range);
      const rows = await this.queryRows<any>(
        `SELECT
           toStartOfMonth(journal_date) AS month_start,
           formatDateTime(toStartOfMonth(journal_date), '%m/%y') AS month,
           round(sumIf(line_amount, line_amount > 0), 0) AS debits,
           round(sumIf(-line_amount, line_amount < 0), 0) AS credits
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})
           ${entity}
           ${jTime}
           AND journal_date IS NOT NULL
         GROUP BY month_start, month
         ORDER BY month_start ASC
         LIMIT 36`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      let running = 0;
      const out = rows.map((r) => {
        const net = this.num(r.credits) - this.num(r.debits);
        running += net;
        return {
          name: String(r.month ?? ''),
          value: Math.round(running),
          net: Math.round(net),
        };
      });
      return { data: out };
    }

    // ── revenue/quarter (line variant) ────────────────────────────────────────
    if (metric === 'revenue' && grouping === 'quarter') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           concat('Q', toString(toQuarter(issued_at)), ' ', toString(toYear(issued_at))) AS quarter,
           toStartOfQuarter(issued_at)                                                   AS quarter_start,
           coalesce(sum(total_amount), 0)                                                AS total_revenue
	           FROM ${this.analyticsDb}.fact_accounting_invoices
	           WHERE org_id IN ({externalOrgIds:Array(String)})
	             ${entity}
	             ${time}
	             ${clientListFact}
	             ${arFilter}
	             AND issued_at IS NOT NULL
         GROUP BY quarter, quarter_start ORDER BY quarter_start ASC LIMIT 12`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      return {
        data: rows.map((r) => ({
          name: r.quarter as string,
          value: this.num(r.total_revenue),
        })),
      };
    }

    // ── outstanding/org and overdue/org ───────────────────────────────────────
    if (metric === 'outstanding' && grouping === 'org') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `WITH invoices AS (
           SELECT
             invoice_external_id,
             coalesce(org_name, org_id) AS org_name,
             toDecimal64(total_amount, 4) AS total_amount,
             issued_at,
             due_at,
             provider,
             invoice_type
           FROM ${this.analyticsDb}.fact_accounting_invoices
           WHERE org_id IN ({externalOrgIds:Array(String)})
             ${entity}
             ${time}
             ${arFilter}
             AND issued_at IS NOT NULL
         ),
         paid AS (
           SELECT
             invoice_external_id,
             sum(amount) AS paid_to_date
           FROM ${this.analyticsDb}.fact_accounting_payment_applications
           WHERE org_id IN ({externalOrgIds:Array(String)})
             AND payment_at IS NOT NULL
             AND payment_at <= ${rangeEndExpr}
             AND invoice_external_id != ''
           GROUP BY invoice_external_id
         ),
         per_invoice AS (
           SELECT
             i.org_name,
             i.due_at,
             greatest(i.total_amount - ifNull(p.paid_to_date, toDecimal64(0, 4)), toDecimal64(0, 4)) AS balance
           FROM invoices i
           LEFT JOIN paid p ON p.invoice_external_id = i.invoice_external_id
         )
         SELECT
           org_name,
           sumIf(balance, due_at IS NULL OR due_at >= ${rangeEndExpr}) AS outstanding
         FROM per_invoice
         GROUP BY org_name
         ORDER BY outstanding DESC
         LIMIT 10`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      return {
        data: rows.map((r) => ({
          name: (r.org_name as string) || 'Unknown',
          value: this.num(r.outstanding),
        })),
      };
    }

    if (metric === 'overdue' && grouping === 'org') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `WITH invoices AS (
           SELECT
             invoice_external_id,
             coalesce(org_name, org_id) AS org_name,
             toDecimal64(total_amount, 4) AS total_amount,
             issued_at,
             due_at,
             provider,
             invoice_type
           FROM ${this.analyticsDb}.fact_accounting_invoices
           WHERE org_id IN ({externalOrgIds:Array(String)})
             ${entity}
             ${time}
             ${arFilter}
             AND issued_at IS NOT NULL
         ),
         paid AS (
           SELECT
             invoice_external_id,
             sum(amount) AS paid_to_date
           FROM ${this.analyticsDb}.fact_accounting_payment_applications
           WHERE org_id IN ({externalOrgIds:Array(String)})
             AND payment_at IS NOT NULL
             AND payment_at <= ${rangeEndExpr}
             AND invoice_external_id != ''
           GROUP BY invoice_external_id
         ),
         per_invoice AS (
           SELECT
             i.org_name,
             i.due_at,
             greatest(i.total_amount - ifNull(p.paid_to_date, toDecimal64(0, 4)), toDecimal64(0, 4)) AS balance
           FROM invoices i
           LEFT JOIN paid p ON p.invoice_external_id = i.invoice_external_id
         )
         SELECT
           org_name,
           sumIf(balance, due_at IS NOT NULL AND due_at < ${rangeEndExpr}) AS overdue
         FROM per_invoice
         GROUP BY org_name
         ORDER BY overdue DESC
         LIMIT 10`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      return {
        data: rows.map((r) => ({
          name: (r.org_name as string) || 'Unknown',
          value: this.num(r.overdue),
        })),
      };
    }

    // ── total_invoiced/client ─────────────────────────────────────────────────
    if (metric === 'total_invoiced' && grouping === 'client') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      if (time.trim()) {
        try {
          const rows = await this.queryRows<any>(
            `SELECT
               coalesce(nullIf(contact_name, ''), 'Unknown') AS client_name,
               contact_id AS client_id,
               coalesce(sum(abs(total_amount)), 0) AS total_invoiced,
               count() AS invoice_count
             FROM ${this.analyticsDb}.fact_accounting_invoices
             WHERE org_id IN ({externalOrgIds:Array(String)})
               ${entity}
               ${time}
               ${clientListFact}
               ${arFilter}
               AND issued_at IS NOT NULL
             GROUP BY client_name, client_id
             ORDER BY total_invoiced DESC LIMIT 15`,
            {
              externalOrgIds: scope.externalOrgIds,
              ...clientListParam,
              ...entityParam,
            },
          );
          return {
            data: rows.map((r) => ({
              name: r.client_name as string,
              value: this.num(r.total_invoiced),
              invoiceCount: this.num(r.invoice_count),
            })),
          };
        } catch {
          const rows = await this.queryRows<any>(
            `SELECT coalesce(nullIf(client_name, ''), 'Unknown') AS client_name, client_id, total_invoiced, invoice_count
             FROM ${this.analyticsDb}.v_dim_clients_latest
             WHERE org_id IN ({externalOrgIds:Array(String)})
               ${entity}
               ${clientListDim}
               AND client_name != ''
             ORDER BY total_invoiced DESC LIMIT 15`,
            {
              externalOrgIds: scope.externalOrgIds,
              ...clientListParam,
              ...entityParam,
            },
          );
          return {
            data: rows.map((r) => ({
              name: r.client_name as string,
              value: this.num(r.total_invoiced),
              invoiceCount: this.num(r.invoice_count),
            })),
          };
        }
      }
      const rows = await this.queryRows<any>(
        `SELECT coalesce(nullIf(client_name, ''), 'Unknown') AS client_name, client_id, total_invoiced, invoice_count
         FROM ${this.analyticsDb}.v_dim_clients_latest
         WHERE org_id IN ({externalOrgIds:Array(String)})
           ${entity}
           ${clientListDim}
           AND client_name != ''
         ORDER BY total_invoiced DESC LIMIT 15`,
        {
          externalOrgIds: scope.externalOrgIds,
          ...clientListParam,
          ...entityParam,
        },
      );
      return {
        data: rows.map((r) => ({
          name: r.client_name as string,
          value: this.num(r.total_invoiced),
          invoiceCount: this.num(r.invoice_count),
        })),
      };
    }

    // ── avg_invoice/client ────────────────────────────────────────────────────
    if (metric === 'avg_invoice' && grouping === 'client') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      if (time.trim()) {
        try {
          const rows = await this.queryRows<any>(
            `SELECT
               coalesce(nullIf(contact_name, ''), 'Unknown') AS client_name,
               contact_id AS client_id,
               coalesce(avg(abs(total_amount)), 0) AS avg_invoice_amount,
               count() AS invoice_count
             FROM ${this.analyticsDb}.fact_accounting_invoices
             WHERE org_id IN ({externalOrgIds:Array(String)})
               ${entity}
               ${time}
               ${clientListFact}
               ${arFilter}
               AND issued_at IS NOT NULL
             GROUP BY client_name, client_id
             HAVING invoice_count > 0
             ORDER BY avg_invoice_amount DESC LIMIT 15`,
            {
              externalOrgIds: scope.externalOrgIds,
              ...clientListParam,
              ...entityParam,
            },
          );
          return {
            data: rows.map((r) => ({
              name: r.client_name as string,
              value: this.num(r.avg_invoice_amount),
              invoiceCount: this.num(r.invoice_count),
            })),
          };
        } catch {
          const rows = await this.queryRows<any>(
            `SELECT coalesce(nullIf(client_name, ''), 'Unknown') AS client_name, client_id, avg_invoice_amount, invoice_count
             FROM ${this.analyticsDb}.v_dim_clients_latest
             WHERE org_id IN ({externalOrgIds:Array(String)})
               ${entity}
               ${clientListDim}
               AND client_name != '' AND invoice_count > 0
             ORDER BY avg_invoice_amount DESC LIMIT 15`,
            {
              externalOrgIds: scope.externalOrgIds,
              ...clientListParam,
              ...entityParam,
            },
          );
          return {
            data: rows.map((r) => ({
              name: r.client_name as string,
              value: this.num(r.avg_invoice_amount),
              invoiceCount: this.num(r.invoice_count),
            })),
          };
        }
      }
      const rows = await this.queryRows<any>(
        `SELECT coalesce(nullIf(client_name, ''), 'Unknown') AS client_name, client_id, avg_invoice_amount, invoice_count
         FROM ${this.analyticsDb}.v_dim_clients_latest
         WHERE org_id IN ({externalOrgIds:Array(String)})
           ${entity}
           ${clientListDim}
           AND client_name != '' AND invoice_count > 0
         ORDER BY avg_invoice_amount DESC LIMIT 15`,
        {
          externalOrgIds: scope.externalOrgIds,
          ...clientListParam,
          ...entityParam,
        },
      );
      return {
        data: rows.map((r) => ({
          name: r.client_name as string,
          value: this.num(r.avg_invoice_amount),
          invoiceCount: this.num(r.invoice_count),
        })),
      };
    }

    // ── paid/client ───────────────────────────────────────────────────────────
    if (metric === 'paid' && grouping === 'client') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      try {
        const rows = await this.queryRows<any>(
          `WITH invoices AS (
           SELECT
             invoice_external_id,
             coalesce(nullIf(contact_name, ''), 'Unknown') AS client_name,
             contact_id AS client_id,
             toDecimal64(total_amount, 4) AS total_amount,
             issued_at,
             due_at
           FROM ${this.analyticsDb}.fact_accounting_invoices
           WHERE org_id IN ({externalOrgIds:Array(String)})
             ${entity}
             ${time}
             ${clientListFact}
             ${arFilter}
             AND issued_at IS NOT NULL
         ),
         paid AS (
           SELECT
             invoice_external_id,
             sum(amount) AS paid_to_date
           FROM ${this.analyticsDb}.fact_accounting_payment_applications
           WHERE org_id IN ({externalOrgIds:Array(String)})
             ${entity}
             AND payment_at IS NOT NULL
             AND payment_at <= ${rangeEndExpr}
             AND invoice_external_id != ''
           GROUP BY invoice_external_id
         ),
         per_invoice AS (
           SELECT
             i.client_name,
             i.client_id,
             i.total_amount,
             ifNull(p.paid_to_date, toDecimal64(0, 4)) AS paid_to_date,
             greatest(i.total_amount - ifNull(p.paid_to_date, toDecimal64(0, 4)), toDecimal64(0, 4)) AS balance
           FROM invoices i
           LEFT JOIN paid p ON p.invoice_external_id = i.invoice_external_id
         )
         SELECT
           client_name,
           client_id,
           sum(paid_to_date) AS paid_amount,
           countIf(balance = 0 AND paid_to_date > 0) AS paid_count
         FROM per_invoice
         GROUP BY client_name, client_id
         ORDER BY paid_amount DESC
         LIMIT 15`,
          {
            externalOrgIds: scope.externalOrgIds,
            ...clientListParam,
            ...entityParam,
          },
        );
        return {
          data: rows.map((r) => ({
            name: r.client_name as string,
            value: this.num(r.paid_amount),
            paidCount: this.num(r.paid_count),
          })),
        };
      } catch {
        const rows = await this.queryRows<any>(
          `SELECT
             coalesce(nullIf(client_name, ''), 'Unknown') AS client_name,
             client_id,
             total_revenue AS paid_amount,
             paid_count
           FROM ${this.analyticsDb}.v_dim_clients_latest
           WHERE org_id IN ({externalOrgIds:Array(String)})
             ${entity}
             ${clientListDim}
             AND client_name != ''
           ORDER BY paid_amount DESC LIMIT 15`,
          {
            externalOrgIds: scope.externalOrgIds,
            ...clientListParam,
            ...entityParam,
          },
        );
        return {
          data: rows.map((r) => ({
            name: r.client_name as string,
            value: this.num(r.paid_amount),
            paidCount: this.num(r.paid_count),
          })),
        };
      }
    }

    // ── collection_rate/client ───────────────────────────────────────────────
    if (metric === 'collection_rate' && grouping === 'client') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      try {
        const rows = await this.queryRows<any>(
          `WITH invoices AS (
           SELECT
             invoice_external_id,
             coalesce(nullIf(contact_name, ''), 'Unknown') AS client_name,
             contact_id AS client_id,
             toDecimal64(total_amount, 4) AS total_amount,
             issued_at
           FROM ${this.analyticsDb}.fact_accounting_invoices
           WHERE org_id IN ({externalOrgIds:Array(String)})
             ${entity}
             ${time}
             ${arFilter}
             AND issued_at IS NOT NULL
         ),
         paid AS (
           SELECT
             invoice_external_id,
             sum(amount) AS paid_to_date
           FROM ${this.analyticsDb}.fact_accounting_payment_applications
           WHERE org_id IN ({externalOrgIds:Array(String)})
             ${entity}
             AND payment_at IS NOT NULL
             AND payment_at <= ${rangeEndExpr}
             AND invoice_external_id != ''
           GROUP BY invoice_external_id
         ),
         per_invoice AS (
           SELECT
             i.client_name,
             i.client_id,
             i.total_amount,
             ifNull(p.paid_to_date, toDecimal64(0, 4)) AS paid_to_date
           FROM invoices i
           LEFT JOIN paid p ON p.invoice_external_id = i.invoice_external_id
         )
         SELECT
           client_name,
           client_id,
           sum(total_amount) AS total_invoiced,
           sum(paid_to_date) AS total_collected
         FROM per_invoice
         GROUP BY client_name, client_id
	         HAVING total_invoiced > 0
	         ORDER BY total_invoiced DESC
	         LIMIT 15`,
          {
            externalOrgIds: scope.externalOrgIds,
            ...clientListParam,
            ...entityParam,
          },
        );
        return {
          data: rows.map((r) => ({
            name: r.client_name as string,
            value:
              Math.round(
                (this.num(r.total_collected) /
                  Math.max(1, this.num(r.total_invoiced))) *
                  100 *
                  10,
              ) / 10,
          })),
        };
      } catch {
        const rows = await this.queryRows<any>(
          `SELECT
             coalesce(nullIf(client_name, ''), 'Unknown') AS client_name,
             total_invoiced,
             total_revenue
	           FROM ${this.analyticsDb}.v_dim_clients_latest
	           WHERE org_id IN ({externalOrgIds:Array(String)})
	             ${entity}
	             ${clientListDim}
	             AND client_name != '' AND total_invoiced > 0
	           ORDER BY total_invoiced DESC LIMIT 15`,
          {
            externalOrgIds: scope.externalOrgIds,
            ...clientListParam,
            ...entityParam,
          },
        );
        return {
          data: rows.map((r) => ({
            name: r.client_name as string,
            value:
              Math.round(
                (this.num(r.total_revenue) /
                  Math.max(1, this.num(r.total_invoiced))) *
                  100 *
                  10,
              ) / 10,
          })),
        };
      }
    }

    // ── overdue_rate/client ──────────────────────────────────────────────────
    if (metric === 'overdue_rate' && grouping === 'client') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      try {
        const rows = await this.queryRows<any>(
          `WITH invoices AS (
           SELECT
             invoice_external_id,
             coalesce(nullIf(contact_name, ''), 'Unknown') AS client_name,
             contact_id AS client_id,
             toDecimal64(total_amount, 4) AS total_amount,
             issued_at,
             due_at
	           FROM ${this.analyticsDb}.fact_accounting_invoices
	           WHERE org_id IN ({externalOrgIds:Array(String)})
	             ${entity}
	             ${time}
	             ${clientListFact}
	             ${arFilter}
	             AND issued_at IS NOT NULL
	         ),
         paid AS (
           SELECT
             invoice_external_id,
             sum(amount) AS paid_to_date
	           FROM ${this.analyticsDb}.fact_accounting_payment_applications
	           WHERE org_id IN ({externalOrgIds:Array(String)})
	             ${entity}
	             AND payment_at IS NOT NULL
	             AND payment_at <= ${rangeEndExpr}
	             AND invoice_external_id != ''
           GROUP BY invoice_external_id
         ),
         per_invoice AS (
           SELECT
             i.client_name,
             i.client_id,
             i.total_amount,
             i.due_at,
             greatest(i.total_amount - ifNull(p.paid_to_date, toDecimal64(0, 4)), toDecimal64(0, 4)) AS balance
           FROM invoices i
           LEFT JOIN paid p ON p.invoice_external_id = i.invoice_external_id
         )
         SELECT
           client_name,
           client_id,
           sum(total_amount) AS total_invoiced,
           sumIf(balance, due_at IS NOT NULL AND due_at < ${rangeEndExpr}) AS total_overdue
         FROM per_invoice
         GROUP BY client_name, client_id
	         HAVING total_invoiced > 0
	         ORDER BY total_overdue DESC
	         LIMIT 15`,
          {
            externalOrgIds: scope.externalOrgIds,
            ...clientListParam,
            ...entityParam,
          },
        );
        return {
          data: rows.map((r) => ({
            name: r.client_name as string,
            value:
              Math.round(
                (this.num(r.total_overdue) /
                  Math.max(1, this.num(r.total_invoiced))) *
                  100 *
                  10,
              ) / 10,
          })),
        };
      } catch {
        const rows = await this.queryRows<any>(
          `SELECT
             coalesce(nullIf(client_name, ''), 'Unknown') AS client_name,
             total_invoiced,
             total_overdue
	           FROM ${this.analyticsDb}.v_dim_clients_latest
	           WHERE org_id IN ({externalOrgIds:Array(String)})
	             ${clientListDim}
	             AND client_name != '' AND total_invoiced > 0
	           ORDER BY total_overdue DESC LIMIT 15`,
          { externalOrgIds: scope.externalOrgIds, ...clientListParam },
        );
        return {
          data: rows.map((r) => ({
            name: r.client_name as string,
            value:
              Math.round(
                (this.num(r.total_overdue) /
                  Math.max(1, this.num(r.total_invoiced))) *
                  100 *
                  10,
              ) / 10,
          })),
        };
      }
    }

    // ── outstanding/client (pie variant — same data as bar) ──────────────────
    if (metric === 'outstanding' && grouping === 'client') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      // If no time window is requested, prefer the pre-aggregated gold dimension.
      if (!time.trim()) {
        const rows = await this.queryRows<any>(
          `SELECT
	             coalesce(nullIf(client_name, ''), nullIf(client_id, ''), 'Unknown Client') AS client_name,
	             client_id,
	             total_outstanding,
	             outstanding_count,
	             total_overdue
	           FROM ${this.analyticsDb}.v_dim_clients_latest
	           WHERE org_id IN ({externalOrgIds:Array(String)})
	             ${orgId ? `AND org_id = {orgId:String}` : ''}
	             ${clientListDim}
	             AND (total_outstanding > 0 OR total_overdue > 0)
	           ORDER BY total_outstanding DESC LIMIT 15`,
          {
            externalOrgIds: scope.externalOrgIds,
            ...clientListParam,
            ...(orgId ? { orgId } : {}),
          },
        );
        return {
          data: rows.map((r) => ({
            name: r.client_name as string,
            value: this.num(r.total_outstanding),
            overdueAmount: this.num(r.total_overdue),
            outstandingCount: this.num(r.outstanding_count),
          })),
        };
      }
      try {
        const rows = await this.queryRows<any>(
          `WITH invoices AS (
           SELECT
             invoice_external_id,
             coalesce(nullIf(contact_name, ''), 'Unknown Client') AS client_name,
             contact_id AS client_id,
             toDecimal64(total_amount, 4) AS total_amount,
             issued_at,
             due_at
	           FROM ${this.analyticsDb}.fact_accounting_invoices
	           WHERE org_id IN ({externalOrgIds:Array(String)})
	             ${entity}
	             ${time}
	             ${clientListFact}
	             ${arFilter}
	             AND issued_at IS NOT NULL
	         ),
         paid AS (
           SELECT
             invoice_external_id,
             sum(amount) AS paid_to_date
	           FROM ${this.analyticsDb}.fact_accounting_payment_applications
	           WHERE org_id IN ({externalOrgIds:Array(String)})
	             ${entity}
	             AND payment_at IS NOT NULL
	             AND payment_at <= ${rangeEndExpr}
	             AND invoice_external_id != ''
           GROUP BY invoice_external_id
         ),
         per_invoice AS (
           SELECT
             i.client_name,
             i.client_id,
             i.due_at,
             greatest(i.total_amount - ifNull(p.paid_to_date, toDecimal64(0, 4)), toDecimal64(0, 4)) AS balance
           FROM invoices i
           LEFT JOIN paid p ON p.invoice_external_id = i.invoice_external_id
         )
         SELECT
           client_name,
           client_id,
           sumIf(balance, due_at IS NULL OR due_at >= ${rangeEndExpr}) AS total_outstanding,
           countIf(balance > 0 AND (due_at IS NULL OR due_at >= ${rangeEndExpr})) AS outstanding_count,
           sumIf(balance, due_at IS NOT NULL AND due_at < ${rangeEndExpr}) AS total_overdue
         FROM per_invoice
         GROUP BY client_name, client_id
	         HAVING (total_outstanding > 0 OR total_overdue > 0)
	         ORDER BY total_outstanding DESC
	         LIMIT 15`,
          {
            externalOrgIds: scope.externalOrgIds,
            ...clientListParam,
            ...entityParam,
          },
        );
        return {
          data: rows.map((r) => ({
            name: r.client_name as string,
            value: this.num(r.total_outstanding),
            overdueAmount: this.num(r.total_overdue),
            outstandingCount: this.num(r.outstanding_count),
          })),
        };
      } catch {
        const rows = await this.queryRows<any>(
          `SELECT
             coalesce(nullIf(client_name, ''), 'Unknown Client') AS client_name,
             client_id,
             total_outstanding,
             outstanding_count,
             total_overdue
	           FROM ${this.analyticsDb}.v_dim_clients_latest
	           WHERE org_id IN ({externalOrgIds:Array(String)})
	             ${clientListDim}
	             AND client_name != ''
	             AND (total_outstanding > 0 OR total_overdue > 0)
	           ORDER BY total_outstanding DESC LIMIT 15`,
          { externalOrgIds: scope.externalOrgIds, ...clientListParam },
        );
        return {
          data: rows.map((r) => ({
            name: r.client_name as string,
            value: this.num(r.total_outstanding),
            overdueAmount: this.num(r.total_overdue),
            outstandingCount: this.num(r.outstanding_count),
          })),
        };
      }
    }

    if (metric === 'overdue' && grouping === 'client') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      // If no time window is requested, prefer the pre-aggregated gold dimension.
      if (!time.trim()) {
        const rows = await this.queryRows<any>(
          `SELECT
	             coalesce(nullIf(client_name, ''), nullIf(client_id, ''), 'Unknown Client') AS client_name,
	             client_id,
	             total_overdue,
	             overdue_count,
	             total_outstanding
	           FROM ${this.analyticsDb}.v_dim_clients_latest
	           WHERE org_id IN ({externalOrgIds:Array(String)})
	             ${orgId ? `AND org_id = {orgId:String}` : ''}
	             ${clientListDim}
	             AND total_overdue > 0
	           ORDER BY total_overdue DESC LIMIT 15`,
          {
            externalOrgIds: scope.externalOrgIds,
            ...clientListParam,
            ...(orgId ? { orgId } : {}),
          },
        );
        return {
          data: rows.map((r) => ({
            name: r.client_name as string,
            value: this.num(r.total_overdue),
            overdueCount: this.num(r.overdue_count),
            outstandingAmount: this.num(r.total_outstanding),
          })),
        };
      }
      try {
        const rows = await this.queryRows<any>(
          `WITH invoices AS (
           SELECT
             invoice_external_id,
             coalesce(nullIf(contact_name, ''), 'Unknown Client') AS client_name,
             contact_id AS client_id,
             toDecimal64(total_amount, 4) AS total_amount,
             issued_at,
             due_at
	           FROM ${this.analyticsDb}.fact_accounting_invoices
	           WHERE org_id IN ({externalOrgIds:Array(String)})
	             ${entity}
	             ${time}
	             ${clientListFact}
	             ${arFilter}
	             AND issued_at IS NOT NULL
	         ),
         paid AS (
           SELECT
             invoice_external_id,
             sum(amount) AS paid_to_date
	           FROM ${this.analyticsDb}.fact_accounting_payment_applications
	           WHERE org_id IN ({externalOrgIds:Array(String)})
	             ${entity}
	             AND payment_at IS NOT NULL
	             AND payment_at <= ${rangeEndExpr}
	             AND invoice_external_id != ''
           GROUP BY invoice_external_id
         ),
         per_invoice AS (
           SELECT
             i.client_name,
             i.client_id,
             i.due_at,
             greatest(i.total_amount - ifNull(p.paid_to_date, toDecimal64(0, 4)), toDecimal64(0, 4)) AS balance
           FROM invoices i
           LEFT JOIN paid p ON p.invoice_external_id = i.invoice_external_id
         )
         SELECT
           client_name,
           client_id,
           sumIf(balance, due_at IS NOT NULL AND due_at < ${rangeEndExpr}) AS total_overdue,
           countIf(balance > 0 AND due_at IS NOT NULL AND due_at < ${rangeEndExpr}) AS overdue_count,
           sumIf(balance, due_at IS NULL OR due_at >= ${rangeEndExpr}) AS total_outstanding
         FROM per_invoice
         GROUP BY client_name, client_id
	         HAVING total_overdue > 0
	         ORDER BY total_overdue DESC
	         LIMIT 15`,
          {
            externalOrgIds: scope.externalOrgIds,
            ...clientListParam,
            ...entityParam,
          },
        );
        return {
          data: rows.map((r) => ({
            name: r.client_name as string,
            value: this.num(r.total_overdue),
            overdueCount: this.num(r.overdue_count),
            outstandingAmount: this.num(r.total_outstanding),
          })),
        };
      } catch {
        const rows = await this.queryRows<any>(
          `SELECT
             coalesce(nullIf(client_name, ''), 'Unknown Client') AS client_name,
             client_id,
             total_overdue,
             overdue_count,
             total_outstanding
	           FROM ${this.analyticsDb}.v_dim_clients_latest
	           WHERE org_id IN ({externalOrgIds:Array(String)})
	             ${clientListDim}
	             AND client_name != ''
	             AND total_overdue > 0
	           ORDER BY total_overdue DESC LIMIT 15`,
          { externalOrgIds: scope.externalOrgIds, ...clientListParam },
        );
        return {
          data: rows.map((r) => ({
            name: r.client_name as string,
            value: this.num(r.total_overdue),
            overdueCount: this.num(r.overdue_count),
            outstandingAmount: this.num(r.total_outstanding),
          })),
        };
      }
    }

    // ─── Journal-lines helpers ────────────────────────────────────────────────
    // All journal queries use journal_date (not issued_at).
    const jTime = this.timeWhereOn('journal_date', range);

    // Balance-sheet account exclusion: omit AR, AP, cash, equity, GST etc.
    // from P&L aggregations so only income-statement accounts remain.
    const BS_EXCL = `
      AND NOT (
           lowerUTF8(account_name) LIKE '%receivable%'
        OR lowerUTF8(account_name) LIKE '%payable%'
        OR lowerUTF8(account_name) LIKE '%cash%'
        OR lowerUTF8(account_name) LIKE '%bank%'
        OR lowerUTF8(account_name) LIKE '%loan%'
        OR lowerUTF8(account_name) LIKE '%mortgage%'
        OR lowerUTF8(account_name) LIKE '%retained%'
        OR lowerUTF8(account_name) LIKE '%equity%'
        OR lowerUTF8(account_name) LIKE '%capital%'
        OR lowerUTF8(account_name) LIKE '%rounding%'
        OR lowerUTF8(account_name) LIKE '%suspense%'
        OR lowerUTF8(account_name) LIKE '%clearing%'
        OR lowerUTF8(account_name) LIKE '%prepaid%'
        OR lowerUTF8(account_name) LIKE '%deposit%'
        OR lowerUTF8(account_name) LIKE '%inventory%'
        OR lowerUTF8(account_name) LIKE '%gst%'
        OR lowerUTF8(account_name) LIKE '%vat%'
        OR lowerUTF8(account_name) LIKE '%tax payable%'
        OR lowerUTF8(account_name) LIKE '%tax liability%'
        OR lowerUTF8(account_name) LIKE '%opening balance%'
      )`;

    // COGS account pattern: direct costs, materials, subcontractors etc.
    const COGS_MATCH = `(
         lowerUTF8(account_name) LIKE '%cost of%'
      OR lowerUTF8(account_name) LIKE '%cogs%'
      OR lowerUTF8(account_name) LIKE '%direct cost%'
      OR lowerUTF8(account_name) LIKE '%direct labour%'
      OR lowerUTF8(account_name) LIKE '%direct labor%'
      OR lowerUTF8(account_name) LIKE '%cost of goods%'
      OR lowerUTF8(account_name) LIKE '%cost of sales%'
      OR lowerUTF8(account_name) LIKE '%cost of revenue%'
      OR lowerUTF8(account_name) LIKE '%raw material%'
      OR lowerUTF8(account_name) LIKE '%subcontract%'
      OR lowerUTF8(account_name) LIKE '%production%'
    )`;

    // Depreciation / amortisation accounts (added back for EBITDA).
    const DA_MATCH = `(
         lowerUTF8(account_name) LIKE '%depreciation%'
      OR lowerUTF8(account_name) LIKE '%amortisation%'
      OR lowerUTF8(account_name) LIKE '%amortization%'
    )`;

    const jDb = this.analyticsDb;
    const jTbl = `${jDb}.v_fact_accounting_journal_lines_enriched_latest`;
    const tbTbl = `${jDb}.sample_trial_balance`;
    const glTbl = `${jDb}.sample_gl_dump`;

    // ── expense/month (line or bar) ───────────────────────────────────────────
    if (metric === 'expense' && grouping === 'month') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      // Primary: sample_gl_dump ALL debits by month (Power BI "Monthly Spend Trend" = Total Debits)
      const glMonthRows = await this.queryRows<any>(
        `SELECT
           formatDateTime(toStartOfMonth(date), '%b %y') AS month,
           toStartOfMonth(date) AS month_start,
           round(sum(toFloat64(debit)), 0) AS total_expense
         FROM ${glTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})
           AND toFloat64(debit) > 0 AND date IS NOT NULL
         GROUP BY month, month_start
         ORDER BY month_start ASC LIMIT 36`,
        { externalOrgIds: scope.externalOrgIds },
      );
      if (glMonthRows.length > 0) {
        return {
          data: (glMonthRows as any[]).map((r) => ({
            name: String(r.month),
            value: this.num(r.total_expense),
          })),
        };
      }
      // Fallback: journal lines for non-sample orgs
      const rows = await this.queryRowsWithTimeFallback<any>(
        (t) => `SELECT
           formatDateTime(toStartOfMonth(journal_date), '%m/%y') AS month,
           toStartOfMonth(journal_date) AS month_start,
           round(sum(line_amount), 0) AS total_expense
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})
           ${entity}
           AND line_amount > 0
           AND journal_date IS NOT NULL
           ${t}
           ${BS_EXCL}
         GROUP BY month, month_start
         ORDER BY month_start ASC
         LIMIT 36`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
        jTime,
      );
      return {
        data: rows.map((r) => ({
          name: r.month as string,
          value: this.num(r.total_expense),
        })),
      };
    }

    // ── expense/quarter (bar) ─────────────────────────────────────────────────
    if (metric === 'expense' && grouping === 'quarter') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           concat('Q', toString(toQuarter(journal_date)), ' ', toString(toYear(journal_date))) AS quarter,
           toStartOfQuarter(journal_date) AS quarter_start,
           round(sum(line_amount), 0) AS total_expense
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})
           ${entity}
           AND line_amount > 0
           AND journal_date IS NOT NULL
           ${jTime}
           ${BS_EXCL}
         GROUP BY quarter, quarter_start
         ORDER BY quarter_start ASC
         LIMIT 16`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      return {
        data: rows.map((r) => ({
          name: r.quarter as string,
          value: this.num(r.total_expense),
        })),
      };
    }

    // ── expense/account (bar or pie) ──────────────────────────────────────────
    if (metric === 'expense' && grouping === 'account') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const limit = (() => {
        const n =
          typeof topN === 'number' && Number.isFinite(topN)
            ? Math.floor(topN)
            : 20;
        return Math.max(3, Math.min(50, n));
      })();
      const rows = await this.queryRows<any>(
        `SELECT
           coalesce(nullIf(account_name, ''), 'Unknown Account') AS account_name,
           round(sum(line_amount), 0) AS total_expense
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})
           ${entity}
           AND line_amount > 0
           AND journal_date IS NOT NULL
           AND account_name != ''
           ${jTime}
           ${BS_EXCL}
         GROUP BY account_name
         HAVING total_expense > 0
         ORDER BY total_expense DESC
         LIMIT ${limit}`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      return {
        data: rows.map((r) => ({
          name: r.account_name as string,
          value: this.num(r.total_expense),
        })),
      };
    }

    // ── expense/category (bar or pie) — user-defined cost categories ─────────
    if (metric === 'expense' && grouping === 'category') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const limit = (() => {
        const n =
          typeof topN === 'number' && Number.isFinite(topN)
            ? Math.floor(topN)
            : 20;
        return Math.max(3, Math.min(50, n));
      })();
      const rows = await this.queryRows<any>(
        `SELECT
           coalesce(nullIf(opex_category, ''), 'Unmapped') AS category,
           round(sum(line_amount), 0) AS total_expense
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})
           ${entity}
           AND line_amount > 0
           AND journal_date IS NOT NULL
           ${jTime}
           ${BS_EXCL}
         GROUP BY category
         HAVING total_expense > 0
         ORDER BY total_expense DESC
         LIMIT ${limit}`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      return {
        data: rows.map((r) => ({
          name: String(r.category ?? ''),
          value: this.num(r.total_expense),
        })),
      };
    }

    // ── admin_expense/month (line or bar) — mapped Admin costs only ──────────
    if (metric === 'admin_expense' && grouping === 'month') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           formatDateTime(toStartOfMonth(journal_date), '%m/%y') AS month,
           toStartOfMonth(journal_date) AS month_start,
           round(sum(line_amount), 0) AS total_admin_expense
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})
           ${entity}
           AND line_amount > 0
           AND journal_date IS NOT NULL
           ${jTime}
           ${BS_EXCL}
           AND (is_admin_cost = 1 OR lowerUTF8(opex_category) = 'admin')
         GROUP BY month, month_start
         ORDER BY month_start ASC
         LIMIT 36`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      return {
        data: rows.map((r) => ({
          name: String(r.month ?? ''),
          value: this.num(r.total_admin_expense),
        })),
      };
    }

    // ── admin_expense/account (bar) — top Admin accounts ────────────────────
    if (metric === 'admin_expense' && grouping === 'account') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const limit = (() => {
        const n =
          typeof topN === 'number' && Number.isFinite(topN)
            ? Math.floor(topN)
            : 20;
        return Math.max(3, Math.min(50, n));
      })();
      const rows = await this.queryRows<any>(
        `SELECT
           coalesce(nullIf(account_name, ''), 'Unknown Account') AS account_name,
           round(sum(line_amount), 0) AS total_admin_expense
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})
           ${entity}
           AND line_amount > 0
           AND journal_date IS NOT NULL
           AND account_name != ''
           ${jTime}
           ${BS_EXCL}
           AND (is_admin_cost = 1 OR lowerUTF8(opex_category) = 'admin')
         GROUP BY account_name
         HAVING total_admin_expense > 0
         ORDER BY total_admin_expense DESC
         LIMIT ${limit}`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      return {
        data: rows.map((r) => ({
          name: String(r.account_name ?? ''),
          value: this.num(r.total_admin_expense),
        })),
      };
    }

    // ── admin_expense/list (table) — most recent Admin transactions ──────────
    if (metric === 'admin_expense' && grouping === 'list') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           formatDateTime(journal_date, '%Y-%m-%d') AS date,
           account_name,
           account_code,
           coalesce(nullIf(description, ''), source_type) AS description,
           round(line_amount, 2) AS amount,
           opex_category,
           cost_nature
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity}
           AND line_amount > 0
           AND journal_date IS NOT NULL
           ${jTime} ${BS_EXCL}
           AND (is_admin_cost = 1 OR lowerUTF8(opex_category) = 'admin')
         ORDER BY journal_date DESC, line_amount DESC
         LIMIT 200`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      return {
        data: rows.map((r: any) => ({
          date: String(r.date),
          account: String(r.account_name),
          accountCode: String(r.account_code),
          category: String(r.opex_category || ''),
          costNature: String(r.cost_nature || ''),
          description: String(r.description),
          amount: this.num(r.amount),
        })),
      };
    }

    // ── opex/account (bar) — operating expenses excluding COGS ───────────────
    if (metric === 'opex' && grouping === 'account') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           coalesce(nullIf(account_name, ''), 'Unknown Account') AS account_name,
           round(sum(line_amount), 0) AS total_opex
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})
           ${entity}
           AND line_amount > 0
           AND journal_date IS NOT NULL
           AND account_name != ''
           ${jTime}
           ${BS_EXCL}
           AND NOT ${COGS_MATCH}
         GROUP BY account_name
         HAVING total_opex > 0
         ORDER BY total_opex DESC
         LIMIT 20`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      return {
        data: rows.map((r) => ({
          name: r.account_name as string,
          value: this.num(r.total_opex),
        })),
      };
    }

    // ── cogs/account (bar) — cost of goods / direct costs only ───────────────
    if (metric === 'cogs' && grouping === 'account') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           coalesce(nullIf(account_name, ''), 'Unknown Account') AS account_name,
           round(sum(line_amount), 0) AS total_cogs
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})
           ${entity}
           AND line_amount > 0
           AND journal_date IS NOT NULL
           AND account_name != ''
           ${jTime}
           AND ${COGS_MATCH}
         GROUP BY account_name
         HAVING total_cogs > 0
         ORDER BY total_cogs DESC
         LIMIT 20`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      return {
        data: rows.map((r) => ({
          name: r.account_name as string,
          value: this.num(r.total_cogs),
        })),
      };
    }

    // ── net_income/month (line or bar) ────────────────────────────────────────
    if (metric === 'net_income' && grouping === 'month') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      // Primary: sample_gl_dump — monthly net income = annual rev / 12 - monthly (COGS + OpEx)
      const glMonthlyRows = await this.queryRows<any>(
        `SELECT
           formatDateTime(toStartOfMonth(date), '%b %y') AS month,
           toStartOfMonth(date) AS month_start,
           round(sumIf(toFloat64(debit), account_type = 'Cost of Goods Sold'), 0) AS cogs,
           round(sumIf(toFloat64(debit), account_type = 'Expense'), 0) AS opex
         FROM ${glTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) AND date IS NOT NULL
         GROUP BY month, month_start
         ORDER BY month_start ASC`,
        { externalOrgIds: scope.externalOrgIds },
      );
      if (glMonthlyRows.length > 0) {
        const annualRevRows = await this.queryRows<any>(
          `SELECT round(abs(sumIf(toFloat64(net_balance), account_type = 'Income')), 0) AS rev FROM ${tbTbl} WHERE org_id IN ({externalOrgIds:Array(String)})`,
          { externalOrgIds: scope.externalOrgIds },
        );
        const annualRev = this.num((annualRevRows[0] as any)?.rev ?? 0);
        const monthCount = glMonthlyRows.length || 12;
        const monthlyRev = Math.round(annualRev / monthCount);
        return {
          data: (glMonthlyRows as any[])
            .map((r) => ({
              name: String(r.month),
              value: Math.round(
                monthlyRev - this.num(r.cogs) - this.num(r.opex),
              ),
              _sort: String(r.month_start),
            }))
            .sort((a, b) => a._sort.localeCompare(b._sort))
            .map(({ _sort: _s, ...rest }) => rest),
        };
      }
      // Fallback: invoices + journal lines
      const [revRows, expRows] = await Promise.all([
        this.queryRows<any>(
          `SELECT
             toStartOfMonth(issued_at) AS month_start,
             formatDateTime(toStartOfMonth(issued_at), '%m/%y') AS month,
             round(sum(total_amount), 0) AS rev
           FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
           WHERE org_id IN ({externalOrgIds:Array(String)})
             ${entity} ${time} ${arFilter}
             AND issued_at IS NOT NULL
           GROUP BY month_start, month`,
          { externalOrgIds: scope.externalOrgIds, ...entityParam },
        ),
        this.queryRows<any>(
          `SELECT
             toStartOfMonth(journal_date) AS month_start,
             formatDateTime(toStartOfMonth(journal_date), '%m/%y') AS month,
             round(sum(line_amount), 0) AS exp
           FROM ${jTbl}
           WHERE org_id IN ({externalOrgIds:Array(String)})
             ${entity}
             AND line_amount > 0
             AND journal_date IS NOT NULL
             ${jTime}
             ${BS_EXCL}
           GROUP BY month_start, month`,
          { externalOrgIds: scope.externalOrgIds, ...entityParam },
        ),
      ]);
      const expMap = new Map<string, { exp: number; month: string }>(
        expRows.map((r: any) => [
          String(r.month_start),
          { exp: this.num(r.exp), month: String(r.month ?? '') },
        ]),
      );
      return {
        data: revRows
          .map((r: any) => {
            const key = String(r.month_start);
            const rev = this.num(r.rev);
            const exp = expMap.get(key)?.exp ?? 0;
            return {
              name: String(r.month ?? ''),
              value: Math.round(rev - exp),
              _sort: key,
            };
          })
          .sort((a: any, b: any) =>
            String(a._sort).localeCompare(String(b._sort)),
          )
          .map(({ _sort: _s, ...rest }: any) => rest),
      };
    }

    // ── net_income/quarter (bar) ──────────────────────────────────────────────
    if (metric === 'net_income' && grouping === 'quarter') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const [revRows, expRows] = await Promise.all([
        this.queryRows<any>(
          `SELECT
             concat('Q', toString(toQuarter(issued_at)), ' ', toString(toYear(issued_at))) AS quarter,
             toStartOfQuarter(issued_at) AS quarter_start,
             round(sum(total_amount), 0) AS rev
           FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
           WHERE org_id IN ({externalOrgIds:Array(String)})
             ${entity} ${time} ${arFilter}
             AND issued_at IS NOT NULL
           GROUP BY quarter, quarter_start`,
          { externalOrgIds: scope.externalOrgIds, ...entityParam },
        ),
        this.queryRows<any>(
          `SELECT
             concat('Q', toString(toQuarter(journal_date)), ' ', toString(toYear(journal_date))) AS quarter,
             toStartOfQuarter(journal_date) AS quarter_start,
             round(sum(line_amount), 0) AS exp
           FROM ${jTbl}
           WHERE org_id IN ({externalOrgIds:Array(String)})
             ${entity}
             AND line_amount > 0
             AND journal_date IS NOT NULL
             ${jTime}
             ${BS_EXCL}
           GROUP BY quarter, quarter_start`,
          { externalOrgIds: scope.externalOrgIds, ...entityParam },
        ),
      ]);
      const expMap = new Map<string, number>(
        expRows.map((r: any) => [String(r.quarter), this.num(r.exp)]),
      );
      return {
        data: revRows
          .map((r: any) => ({
            name: String(r.quarter),
            value: Math.round(
              this.num(r.rev) - (expMap.get(String(r.quarter)) ?? 0),
            ),
            _qs: String(r.quarter_start),
          }))
          .sort((a: any, b: any) => a._qs.localeCompare(b._qs))
          .map(({ _qs: _qs, ...rest }: any) => rest),
      };
    }

    // ── gross_profit/month (line) — revenue minus COGS ───────────────────────
    if (metric === 'gross_profit' && grouping === 'month') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      // Gross Profit = Net Income + OpEx (monthly from gl_dump) = Revenue - COGS.
      // COGS doesn't have monthly gl_dump entries — use annual from trial_balance
      // and distribute: GP/month = (annual_rev - annual_cogs) / 12.
      // Monthly variation comes from OpEx (gl_dump has monthly Expense entries).
      const glOpexRows = await this.queryRows<any>(
        `SELECT formatDateTime(toStartOfMonth(date), '%b %y') AS month,
                toStartOfMonth(date) AS month_start,
                round(sumIf(toFloat64(debit), account_type = 'Expense'), 0) AS opex
         FROM ${glTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) AND date IS NOT NULL
         GROUP BY month, month_start ORDER BY month_start ASC`,
        { externalOrgIds: scope.externalOrgIds },
      );
      if (glOpexRows.length > 0) {
        const [annualRows] = await Promise.all([
          this.queryRows<any>(
            `SELECT round(abs(sumIf(toFloat64(net_balance), account_type = 'Income')), 0) AS rev,
                    round(sumIf(toFloat64(net_balance), account_type = 'Cost of Goods Sold'), 0) AS cogs
             FROM ${tbTbl} WHERE org_id IN ({externalOrgIds:Array(String)})`,
            { externalOrgIds: scope.externalOrgIds },
          ),
        ]);
        const annualRev = this.num((annualRows[0] as any)?.rev ?? 0);
        const annualCogs = this.num((annualRows[0] as any)?.cogs ?? 0);
        const annualGP = annualRev - annualCogs;
        const n = glOpexRows.length || 12;
        const avgMonthlyGP = Math.round(annualGP / n);
        // Adjust monthly by OpEx deviation from average to show variation
        const avgOpex = Math.round(
          glOpexRows.reduce((s: number, r: any) => s + this.num(r.opex), 0) / n,
        );
        return {
          data: (glOpexRows as any[])
            .map((r) => {
              const opexDev = Math.round(this.num(r.opex)) - avgOpex;
              return {
                name: String(r.month),
                value: avgMonthlyGP - opexDev,
                _s: String(r.month_start),
              };
            })
            .sort((a, b) => a._s.localeCompare(b._s))
            .map(({ _s, ...rest }) => rest),
        };
      }
      // Fallback: journal lines
      const [revRows, cogsRows] = await Promise.all([
        this.queryRows<any>(
          `SELECT toStartOfMonth(issued_at) AS month_start, round(sum(total_amount), 0) AS rev
           FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
           WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${time} ${arFilter} AND issued_at IS NOT NULL
           GROUP BY month_start`,
          { externalOrgIds: scope.externalOrgIds, ...entityParam },
        ),
        this.queryRows<any>(
          `SELECT toStartOfMonth(journal_date) AS month_start, round(sum(line_amount), 0) AS cogs
           FROM ${jTbl}
           WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity}
             AND line_amount > 0 AND journal_date IS NOT NULL ${jTime}
             AND ${COGS_MATCH}
           GROUP BY month_start`,
          { externalOrgIds: scope.externalOrgIds, ...entityParam },
        ),
      ]);
      const cogsMap = new Map<string, number>(
        cogsRows.map((r: any) => [String(r.month_start), this.num(r.cogs)]),
      );
      return {
        data: revRows
          .map((r: any) => ({
            name: String(r.month_start),
            value: Math.round(
              this.num(r.rev) - (cogsMap.get(String(r.month_start)) ?? 0),
            ),
          }))
          .sort((a: any, b: any) => a.name.localeCompare(b.name)),
      };
    }

    // ── gross_margin_pct/month (line) — gross profit % ───────────────────────
    if (metric === 'gross_margin_pct' && grouping === 'month') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      // Use sample_gl_dump for monthly COGS + sample_trial_balance for annual revenue.
      const glCogsRows2 = await this.queryRows<any>(
        `SELECT formatDateTime(toStartOfMonth(date), '%b %y') AS month,
                toStartOfMonth(date) AS month_start,
                round(sumIf(toFloat64(debit), account_type = 'Cost of Goods Sold'), 0) AS cogs
         FROM ${glTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) AND date IS NOT NULL
         GROUP BY month, month_start ORDER BY month_start ASC`,
        { externalOrgIds: scope.externalOrgIds },
      );
      if (glCogsRows2.length > 0) {
        const annualRevRows2 = await this.queryRows<any>(
          `SELECT round(abs(sumIf(toFloat64(net_balance), account_type = 'Income')), 0) AS rev FROM ${tbTbl} WHERE org_id IN ({externalOrgIds:Array(String)})`,
          { externalOrgIds: scope.externalOrgIds },
        );
        const annualRev2 = this.num((annualRevRows2[0] as any)?.rev ?? 0);
        const monthlyRev2 = Math.round(annualRev2 / (glCogsRows2.length || 12));
        return {
          data: (glCogsRows2 as any[])
            .map((r) => {
              const rev = monthlyRev2;
              const cogs = Math.round(this.num(r.cogs));
              return {
                name: String(r.month),
                value:
                  rev > 0 ? Math.round(((rev - cogs) / rev) * 1000) / 10 : 0,
                _s: String(r.month_start),
              };
            })
            .sort((a, b) => a._s.localeCompare(b._s))
            .map(({ _s, ...rest }) => rest),
        };
      }
      // Fallback: invoices + journal lines
      const [revRowsGM, cogsRowsGM] = await Promise.all([
        this.queryRows<any>(
          `SELECT toStartOfMonth(issued_at) AS month_start, round(sum(total_amount), 0) AS rev
           FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
           WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${time} ${arFilter} AND issued_at IS NOT NULL
           GROUP BY month_start`,
          { externalOrgIds: scope.externalOrgIds, ...entityParam },
        ),
        this.queryRows<any>(
          `SELECT toStartOfMonth(journal_date) AS month_start, round(sum(line_amount), 0) AS cogs
           FROM ${jTbl}
           WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity}
             AND line_amount > 0 AND journal_date IS NOT NULL ${jTime} AND ${COGS_MATCH}
           GROUP BY month_start`,
          { externalOrgIds: scope.externalOrgIds, ...entityParam },
        ),
      ]);
      const cogsMapGM = new Map<string, number>(
        cogsRowsGM.map((r: any) => [String(r.month_start), this.num(r.cogs)]),
      );
      return {
        data: revRowsGM
          .map((r: any) => {
            const rev = this.num(r.rev);
            const cogs = cogsMapGM.get(String(r.month_start)) ?? 0;
            return {
              name: String(r.month_start),
              value: rev > 0 ? Math.round(((rev - cogs) / rev) * 1000) / 10 : 0,
            };
          })
          .sort((a: any, b: any) => a.name.localeCompare(b.name)),
      };
    }

    // ── net_margin_pct/month (line) — net income % ───────────────────────────
    if (metric === 'net_margin_pct' && grouping === 'month') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      // Use sample_gl_dump for monthly expenses + sample_trial_balance for annual revenue.
      const glExpRowsNM = await this.queryRows<any>(
        `SELECT formatDateTime(toStartOfMonth(date), '%b %y') AS month,
                toStartOfMonth(date) AS month_start,
                round(sumIf(toFloat64(debit), account_type IN ('Cost of Goods Sold','Expense')), 0) AS total_exp
         FROM ${glTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) AND date IS NOT NULL
         GROUP BY month, month_start ORDER BY month_start ASC`,
        { externalOrgIds: scope.externalOrgIds },
      );
      if (glExpRowsNM.length > 0) {
        const annualRevRowsNM = await this.queryRows<any>(
          `SELECT round(abs(sumIf(toFloat64(net_balance), account_type = 'Income')), 0) AS rev FROM ${tbTbl} WHERE org_id IN ({externalOrgIds:Array(String)})`,
          { externalOrgIds: scope.externalOrgIds },
        );
        const annualRevNM = this.num((annualRevRowsNM[0] as any)?.rev ?? 0);
        const monthlyRevNM = Math.round(
          annualRevNM / (glExpRowsNM.length || 12),
        );
        return {
          data: (glExpRowsNM as any[])
            .map((r) => {
              const rev = monthlyRevNM;
              const exp = Math.round(this.num(r.total_exp));
              return {
                name: String(r.month),
                value:
                  rev > 0 ? Math.round(((rev - exp) / rev) * 1000) / 10 : 0,
                _s: String(r.month_start),
              };
            })
            .sort((a, b) => a._s.localeCompare(b._s))
            .map(({ _s, ...rest }) => rest),
        };
      }
      const [revRows, expRows] = await Promise.all([
        this.queryRows<any>(
          `SELECT toStartOfMonth(issued_at) AS month_start, round(sum(total_amount), 0) AS rev
           FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
           WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${time} ${arFilter} AND issued_at IS NOT NULL
           GROUP BY month_start`,
          { externalOrgIds: scope.externalOrgIds, ...entityParam },
        ),
        this.queryRows<any>(
          `SELECT toStartOfMonth(journal_date) AS month_start, round(sum(line_amount), 0) AS exp
           FROM ${jTbl}
           WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity}
             AND line_amount > 0 AND journal_date IS NOT NULL ${jTime} ${BS_EXCL}
           GROUP BY month_start`,
          { externalOrgIds: scope.externalOrgIds, ...entityParam },
        ),
      ]);
      const expMap = new Map<string, number>(
        expRows.map((r: any) => [String(r.month_start), this.num(r.exp)]),
      );
      return {
        data: revRows
          .map((r: any) => {
            const rev = this.num(r.rev);
            const exp = expMap.get(String(r.month_start)) ?? 0;
            return {
              name: String(r.month_start),
              value: rev > 0 ? Math.round(((rev - exp) / rev) * 1000) / 10 : 0,
            };
          })
          .sort((a: any, b: any) => a.name.localeCompare(b.name)),
      };
    }

    // ── ebitda/month (line) — net income + depreciation/amortisation ─────────
    if (metric === 'ebitda' && grouping === 'month') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const [revRows, expRows, daRows] = await Promise.all([
        this.queryRows<any>(
          `SELECT toStartOfMonth(issued_at) AS month_start, round(sum(total_amount), 0) AS rev
           FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
           WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${time} ${arFilter} AND issued_at IS NOT NULL
           GROUP BY month_start`,
          { externalOrgIds: scope.externalOrgIds, ...entityParam },
        ),
        this.queryRows<any>(
          `SELECT toStartOfMonth(journal_date) AS month_start, round(sum(line_amount), 0) AS exp
           FROM ${jTbl}
           WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity}
             AND line_amount > 0 AND journal_date IS NOT NULL ${jTime} ${BS_EXCL}
           GROUP BY month_start`,
          { externalOrgIds: scope.externalOrgIds, ...entityParam },
        ),
        this.queryRows<any>(
          `SELECT toStartOfMonth(journal_date) AS month_start, round(sum(line_amount), 0) AS da
           FROM ${jTbl}
           WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity}
             AND line_amount > 0 AND journal_date IS NOT NULL ${jTime}
             AND ${DA_MATCH}
           GROUP BY month_start`,
          { externalOrgIds: scope.externalOrgIds, ...entityParam },
        ),
      ]);
      const expMap = new Map<string, number>(
        expRows.map((r: any) => [String(r.month_start), this.num(r.exp)]),
      );
      const daMap = new Map<string, number>(
        daRows.map((r: any) => [String(r.month_start), this.num(r.da)]),
      );
      return {
        data: revRows
          .map((r: any) => {
            const key = String(r.month_start);
            const rev = this.num(r.rev);
            const exp = expMap.get(key) ?? 0;
            const da = daMap.get(key) ?? 0;
            return { name: key, value: Math.round(rev - exp + da) };
          })
          .sort((a: any, b: any) => a.name.localeCompare(b.name)),
      };
    }

    // ── revenue_vs_expense/month (line) — dual series ─────────────────────────
    if (metric === 'revenue_vs_expense' && grouping === 'month') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      // Primary: sample_gl_dump — Revenue = Income credits, Expense = Expense type debits
      // (GL dump has no Income entries; use Expense debits only for the expense side)
      const glCombinedRows = await this.queryRows<any>(
        `SELECT
           formatDateTime(toStartOfMonth(date), '%b %y') AS month,
           toStartOfMonth(date) AS month_start,
           round(sumIf(toFloat64(debit), account_type = 'Expense'), 0) AS exp,
           round(sumIf(toFloat64(debit), account_type = 'Cost of Goods Sold'), 0) AS cogs
         FROM ${glTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) AND date IS NOT NULL
         GROUP BY month, month_start
         ORDER BY month_start ASC`,
        { externalOrgIds: scope.externalOrgIds },
      );
      if (glCombinedRows.length > 0) {
        // Distribute annual revenue evenly across months (GL dump has no monthly revenue)
        const annualRevRows = await this.queryRows<any>(
          `SELECT round(abs(sumIf(toFloat64(net_balance), account_type = 'Income')), 0) AS rev FROM ${tbTbl} WHERE org_id IN ({externalOrgIds:Array(String)})`,
          { externalOrgIds: scope.externalOrgIds },
        );
        const annualRev = this.num((annualRevRows[0] as any)?.rev ?? 0);
        const monthCount = glCombinedRows.length || 12;
        const monthlyRev = Math.round(annualRev / monthCount);
        return {
          data: (glCombinedRows as any[])
            .map((r) => ({
              name: String(r.month),
              Revenue: monthlyRev,
              Expense: this.num(r.exp) + this.num(r.cogs),
              _sort: String(r.month_start),
            }))
            .sort((a, b) => a._sort.localeCompare(b._sort))
            .map(({ _sort: _s, ...rest }) => rest),
        };
      }
      // Fallback: invoices + journal lines
      const [revRows, expRows] = await Promise.all([
        this.queryRows<any>(
          `SELECT
             formatDateTime(toStartOfMonth(issued_at), '%m/%y') AS month,
             toStartOfMonth(issued_at) AS month_start,
             round(sum(total_amount), 0) AS rev
           FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
           WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${time} ${arFilter} AND issued_at IS NOT NULL
           GROUP BY month, month_start`,
          { externalOrgIds: scope.externalOrgIds, ...entityParam },
        ),
        this.queryRows<any>(
          `SELECT
             formatDateTime(toStartOfMonth(journal_date), '%m/%y') AS month,
             toStartOfMonth(journal_date) AS month_start,
             round(sum(line_amount), 0) AS exp
           FROM ${jTbl}
           WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity}
             AND line_amount > 0 AND journal_date IS NOT NULL ${jTime} ${BS_EXCL}
           GROUP BY month, month_start`,
          { externalOrgIds: scope.externalOrgIds, ...entityParam },
        ),
      ]);
      const map = new Map<string, any>();
      for (const r of revRows)
        map.set(String(r.month), {
          name: String(r.month),
          Revenue: this.num(r.rev),
          Expense: 0,
          _sort: String(r.month_start),
        });
      for (const r of expRows) {
        const key = String(r.month);
        const existing = map.get(key) ?? { name: key, Revenue: 0, _sort: key };
        existing.Expense = this.num(r.exp);
        map.set(key, existing);
      }
      return {
        data: Array.from(map.values())
          .sort((a, b) => a._sort.localeCompare(b._sort))
          .map(({ _sort: _s, ...rest }) => rest),
      };
    }

    // ── balance_sheet/summary — total assets, liabilities, equity from trial balance ──
    // Mirrors Power BI DAX exactly:
    //   TotalAssets = SUM(net_balance) WHERE type IN {Bank,AR,OCA,Fixed,OA}  (no ABS — assets have +ve net)
    //   TotalLiab   = ABS(SUM(net_balance)) WHERE type IN {AP,OCL,LTL}
    //   TotalEquity = ABS(SUM(net_balance)) WHERE type = Equity
    if (metric === 'balance_sheet' && grouping === 'summary') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const bsRows = await this.queryRows<any>(
        `SELECT
           round(sumIf(toFloat64(net_balance), account_type IN ('Bank','Accounts Receivable','Other Current Asset','Fixed Asset','Other Asset')), 0) AS total_assets,
           round(abs(sumIf(toFloat64(net_balance), account_type IN ('Accounts Payable','Other Current Liability','Long Term Liability'))), 0) AS total_liabilities,
           round(abs(sumIf(toFloat64(net_balance), account_type = 'Equity')), 0) AS total_equity
         FROM ${tbTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})`,
        { externalOrgIds: scope.externalOrgIds },
      );
      const totalAssets = this.num((bsRows[0] as any)?.total_assets ?? 0);
      const totalLiab = this.num((bsRows[0] as any)?.total_liabilities ?? 0);
      const totalEquity = this.num((bsRows[0] as any)?.total_equity ?? 0);
      return {
        data: [
          { name: 'Total Assets', value: totalAssets },
          { name: 'Total Liabilities', value: totalLiab },
          { name: 'Total Equity', value: totalEquity },
        ],
      };
    }

    // ── assets/breakdown — asset accounts from trial balance ─────────────────
    // Mirrors Power BI DAX: Total Assets = SUM(net_balance) per account_type — NO ABS per row
    // Fixed Assets net of depreciation: SUM(+85k+62k+38.5k-45.2k) = 140,300 (not 230,700)
    if (
      metric === 'assets' &&
      (grouping === 'account_type' ||
        grouping === 'account' ||
        grouping === 'breakdown' ||
        grouping === 'summary')
    ) {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT account_type AS name, round(sum(toFloat64(net_balance)), 0) AS value
         FROM ${tbTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})
           AND account_type IN ('Bank','Accounts Receivable','Other Current Asset','Fixed Asset','Other Asset')
         GROUP BY account_type
         HAVING round(sum(toFloat64(net_balance)), 0) > 0
         ORDER BY value DESC LIMIT 10`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return {
        data: rows.map((r: any) => ({
          name: String(r.name),
          value: this.num(r.value),
        })),
      };
    }

    // ── liabilities/breakdown — liability accounts from trial balance ─────────
    // Mirrors Power BI DAX: Total Liabilities = ABS(SUM(net_balance)) per account_type
    if (
      metric === 'liabilities' &&
      (grouping === 'account_type' ||
        grouping === 'account' ||
        grouping === 'breakdown' ||
        grouping === 'summary')
    ) {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT account_type AS name, round(abs(sum(toFloat64(net_balance))), 0) AS value
         FROM ${tbTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})
           AND account_type IN ('Accounts Payable','Other Current Liability','Long Term Liability')
         GROUP BY account_type
         HAVING round(abs(sum(toFloat64(net_balance))), 0) > 0
         ORDER BY value DESC LIMIT 10`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return {
        data: rows.map((r: any) => ({
          name: String(r.name),
          value: this.num(r.value),
        })),
      };
    }

    // ── equity/breakdown — equity accounts from trial balance ─────────────────
    if (
      metric === 'equity' &&
      (grouping === 'account_type' ||
        grouping === 'account' ||
        grouping === 'breakdown' ||
        grouping === 'summary')
    ) {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT account_name AS name, round(abs(toFloat64(net_balance)), 0) AS value
         FROM ${tbTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})
           AND account_type = 'Equity' AND abs(toFloat64(net_balance)) > 0
         ORDER BY value DESC LIMIT 20`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return {
        data: rows.map((r: any) => ({
          name: String(r.name),
          value: this.num(r.value),
        })),
      };
    }

    // ── trial_balance/summary — full trial balance table ──────────────────────
    if (
      metric === 'trial_balance' &&
      (grouping === 'summary' || grouping === 'list')
    ) {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT account_number, account_name, account_type,
                round(toFloat64(debit), 2) AS debit,
                round(toFloat64(credit), 2) AS credit,
                round(toFloat64(net_balance), 2) AS net_balance
         FROM ${tbTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})
         ORDER BY account_type, account_number LIMIT 100`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return {
        data: rows.map((r: any) => ({
          accountNumber: String(r.account_number),
          name: String(r.account_name),
          type: String(r.account_type),
          debit: this.num(r.debit),
          credit: this.num(r.credit),
          balance: this.num(r.net_balance),
        })),
      };
    }

    // ── income/breakdown — income + COGS accounts from trial balance ──────────
    if (
      metric === 'income' &&
      (grouping === 'breakdown' ||
        grouping === 'account' ||
        grouping === 'summary')
    ) {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT account_name AS name, round(abs(toFloat64(net_balance)), 0) AS value, account_type
         FROM ${tbTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})
           AND account_type IN ('Income','Cost of Goods Sold')
           AND abs(toFloat64(net_balance)) > 0
         ORDER BY account_type ASC, value DESC LIMIT 30`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return {
        data: rows.map((r: any) => ({
          name: String(r.name),
          value: this.num(r.value),
          type: String(r.account_type),
        })),
      };
    }

    // ── account_type/breakdown — any account type breakdown from trial balance ─
    if (
      metric === 'account_type' &&
      (grouping === 'breakdown' ||
        grouping === 'summary' ||
        grouping === 'account')
    ) {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT account_type AS name, round(sum(abs(toFloat64(net_balance))), 0) AS value
         FROM ${tbTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})
         GROUP BY account_type
         ORDER BY value DESC LIMIT 20`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return {
        data: rows.map((r: any) => ({
          name: String(r.name),
          value: this.num(r.value),
        })),
      };
    }

    // ── gl_dump/detail — full GL dump from sample_gl_dump ─────────────────────
    if (
      metric === 'gl_dump' &&
      (grouping === 'detail' || grouping === 'list')
    ) {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           toString(date) AS date,
           transaction_id,
           journal_type,
           account_number,
           account_name,
           account_type,
           vendor_customer,
           description,
           round(toFloat64(debit), 2) AS debit,
           round(toFloat64(credit), 2) AS credit,
           department,
           class
         FROM ${glTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})
         ORDER BY date ASC LIMIT 500`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return {
        data: rows.map((r: any) => ({
          date: String(r.date),
          transactionId: String(r.transaction_id),
          journalType: String(r.journal_type),
          accountNumber: String(r.account_number),
          name: String(r.account_name),
          accountType: String(r.account_type),
          vendor: String(r.vendor_customer),
          description: String(r.description),
          debit: this.num(r.debit),
          credit: this.num(r.credit),
          department: String(r.department),
          class: String(r.class),
        })),
      };
    }

    // ── pl/summary (table/waterfall) — full P&L from sample_trial_balance ──────
    if (metric === 'pl' && grouping === 'summary') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      // Use sample_trial_balance as authoritative source (exact Excel data)
      const [tbSummary, tbAccounts] = await Promise.all([
        this.queryRows<any>(
          `SELECT
             round(abs(sumIf(toFloat64(net_balance), account_type = 'Income')), 0) AS total_revenue,
             round(sumIf(toFloat64(net_balance), account_type = 'Cost of Goods Sold'), 0) AS total_cogs,
             round(sumIf(toFloat64(net_balance), account_type = 'Expense'), 0) AS total_expenses
           FROM ${tbTbl}
           WHERE org_id IN ({externalOrgIds:Array(String)})`,
          { externalOrgIds: scope.externalOrgIds },
        ),
        this.queryRows<any>(
          `SELECT account_name,
                  account_type,
                  round(abs(toFloat64(net_balance)), 0) AS amount,
                  multiIf(account_type = 'Income', 'Revenue',
                          account_type = 'Cost of Goods Sold', 'Cost of Sales',
                          account_type = 'Expense', 'Operating Expense', 'Other') AS category
           FROM ${tbTbl}
           WHERE org_id IN ({externalOrgIds:Array(String)})
             AND account_type IN ('Income','Cost of Goods Sold','Expense')
             AND abs(toFloat64(net_balance)) > 0
           ORDER BY category ASC, amount DESC LIMIT 50`,
          { externalOrgIds: scope.externalOrgIds },
        ),
      ]);
      const totalRevenue = this.num((tbSummary[0] as any)?.total_revenue ?? 0);
      const totalCogs = this.num((tbSummary[0] as any)?.total_cogs ?? 0);
      const totalOpex = this.num((tbSummary[0] as any)?.total_expenses ?? 0);
      const grossProfit = totalRevenue - totalCogs;
      const netIncome = grossProfit - totalOpex;
      const rows: Array<{ name: string; value: number }> = [
        { name: 'Revenue', value: totalRevenue },
        ...(totalCogs > 0
          ? [{ name: 'Cost of Goods Sold', value: -totalCogs }]
          : []),
        { name: 'Gross Profit', value: grossProfit },
        ...(totalOpex > 0
          ? [{ name: 'Operating Expenses', value: -totalOpex }]
          : []),
        { name: 'Net Income', value: netIncome },
      ].filter((r) => r.value !== 0);
      void tbAccounts; // available for future table variant
      return { data: rows };
    }

    // ── expense/list (table) — detailed expense entries ───────────────────────
    if (metric === 'expense' && grouping === 'list') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           formatDateTime(journal_date, '%Y-%m-%d') AS date,
           account_name,
           coalesce(nullIf(description, ''), source_type) AS description,
           round(line_amount, 2) AS amount
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity}
           AND line_amount > 0 AND journal_date IS NOT NULL
           ${jTime} ${BS_EXCL}
         ORDER BY journal_date DESC, line_amount DESC
         LIMIT 100`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      return {
        data: rows.map((r: any) => ({
          date: String(r.date),
          account: String(r.account_name),
          description: String(r.description),
          amount: this.num(r.amount),
        })),
      };
    }

    // ── gl_transactions/list (table) — all journal lines ──────────────────────
    if (metric === 'gl_transactions' && grouping === 'list') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           formatDateTime(journal_date, '%Y-%m-%d') AS date,
           journal_number,
           account_code,
           account_name,
           coalesce(nullIf(description, ''), source_type) AS description,
           round(line_amount, 2) AS amount,
           if(line_amount > 0, 'Debit', 'Credit') AS type,
           opex_category,
           cost_nature
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity}
           AND journal_date IS NOT NULL ${jTime}
         ORDER BY journal_date DESC, abs(line_amount) DESC
         LIMIT 200`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      return {
        data: rows.map((r: any) => ({
          date: String(r.date),
          journalNumber: this.num(r.journal_number),
          accountCode: String(r.account_code),
          account: String(r.account_name),
          description: String(r.description),
          amount: Math.abs(this.num(r.amount)),
          type: String(r.type),
          category: String(r.opex_category ?? ''),
          costNature: String(r.cost_nature ?? ''),
        })),
      };
    }

    // ── pl_summary/summary (metric tile) — P&L KPIs from sample_trial_balance ──
    if (metric === 'pl_summary' && grouping === 'summary') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const tbRows = await this.queryRows<any>(
        `SELECT
           round(abs(sumIf(toFloat64(net_balance), account_type = 'Income')), 0) AS total_revenue,
           round(sumIf(toFloat64(net_balance), account_type = 'Cost of Goods Sold'), 0) AS total_cogs,
           round(sumIf(toFloat64(net_balance), account_type = 'Expense'), 0) AS total_expenses
         FROM ${tbTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})`,
        { externalOrgIds: scope.externalOrgIds },
      );
      const rev = this.num((tbRows[0] as any)?.total_revenue ?? 0);
      const cogs = this.num((tbRows[0] as any)?.total_cogs ?? 0);
      const exp = this.num((tbRows[0] as any)?.total_expenses ?? 0);
      const gp = rev - cogs;
      const ni = gp - exp;
      return {
        data: [
          { label: 'Total Revenue', value: rev, format: 'currency' },
          { label: 'Total Expenses', value: exp + cogs, format: 'currency' },
          { label: 'Gross Profit', value: gp, format: 'currency' },
          { label: 'Net Income', value: ni, format: 'currency' },
          {
            label: 'Gross Margin',
            value: rev > 0 ? Math.round((gp / rev) * 1000) / 10 : 0,
            format: 'percent',
          },
          {
            label: 'Net Margin',
            value: rev > 0 ? Math.round((ni / rev) * 1000) / 10 : 0,
            format: 'percent',
          },
        ],
      };
    }

    // ── pl_comparison/summary (bar — side-by-side P&L comparison) ───────────
    if (metric === 'pl_comparison' && grouping === 'summary') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const tbRows = await this.queryRows<any>(
        `SELECT
           round(abs(sumIf(toFloat64(net_balance), account_type = 'Income')), 0) AS total_revenue,
           round(sumIf(toFloat64(net_balance), account_type = 'Cost of Goods Sold'), 0) AS total_cogs,
           round(sumIf(toFloat64(net_balance), account_type = 'Expense'), 0) AS total_expenses
         FROM ${tbTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})`,
        { externalOrgIds: scope.externalOrgIds },
      );
      const rev = this.num((tbRows[0] as any)?.total_revenue ?? 0);
      const cogs = this.num((tbRows[0] as any)?.total_cogs ?? 0);
      const exp = this.num((tbRows[0] as any)?.total_expenses ?? 0);
      const gp = rev - cogs;
      const totalExpenses = exp + cogs;
      const ni = gp - totalExpenses;
      return {
        data: [
          { name: 'Revenue', value: rev },
          { name: 'Gross Profit', value: gp },
          { name: 'Expenses', value: totalExpenses },
          { name: 'Net Income', value: ni },
        ],
      };
    }

    // ── expense_summary/summary (metric tile) — expense KPIs from trial_balance ─
    if (metric === 'expense_summary' && grouping === 'summary') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const [expRows, topRows] = await Promise.all([
        this.queryRows<any>(
          `SELECT
             round(sumIf(toFloat64(net_balance), account_type = 'Cost of Goods Sold'), 0) AS total_cogs,
             round(sumIf(toFloat64(net_balance), account_type = 'Expense'), 0) AS total_opex
           FROM ${tbTbl}
           WHERE org_id IN ({externalOrgIds:Array(String)})`,
          { externalOrgIds: scope.externalOrgIds },
        ),
        this.queryRows<any>(
          `SELECT account_name, round(abs(toFloat64(net_balance)), 0) AS amt
           FROM ${tbTbl}
           WHERE org_id IN ({externalOrgIds:Array(String)})
             AND account_type IN ('Expense','Cost of Goods Sold')
           ORDER BY amt DESC LIMIT 1`,
          { externalOrgIds: scope.externalOrgIds },
        ),
      ]);
      const totalCogs = this.num((expRows[0] as any)?.total_cogs ?? 0);
      const totalOpex = this.num((expRows[0] as any)?.total_opex ?? 0);
      const totalExp = totalCogs + totalOpex;
      const topAcct = String((topRows[0] as any)?.account_name ?? 'N/A');
      const topAmt = this.num((topRows[0] as any)?.amt ?? 0);
      return {
        data: [
          { label: 'Total Expenses', value: totalExp, format: 'currency' },
          {
            label: 'Cost of Sales (COGS)',
            value: totalCogs,
            format: 'currency',
          },
          { label: 'Operating Expenses', value: totalOpex, format: 'currency' },
          {
            label: 'Largest Expense',
            value: topAmt,
            format: 'currency',
            note: topAcct,
          },
        ],
      };
    }

    // ── revenue_cumulative/month ─────────────────────────────────────────────
    if (metric === 'revenue_cumulative' && grouping === 'month') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           formatDateTime(toStartOfMonth(issued_at), '%m/%y') AS month,
           toStartOfMonth(issued_at) AS month_start,
           coalesce(sum(total_amount), 0) AS monthly_revenue
         FROM ${this.analyticsDb}.fact_accounting_invoices
         WHERE org_id IN ({externalOrgIds:Array(String)})
           ${time} ${arFilter} AND issued_at IS NOT NULL
         GROUP BY month, month_start ORDER BY month_start ASC LIMIT 36`,
        { externalOrgIds: scope.externalOrgIds },
      );
      let cumulative = 0;
      return {
        data: rows.map((r: any) => {
          cumulative += this.num(r.monthly_revenue);
          return {
            name: String(r.month ?? ''),
            value: Math.round(cumulative),
            monthly: Math.round(this.num(r.monthly_revenue)),
          };
        }),
      };
    }

    // ── invoice_value/invoice_type (pie/donut — ACCREC vs ACCPAY split) ──────
    if (metric === 'invoice_value' && grouping === 'invoice_type') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           invoice_type AS name,
           round(sum(total_amount), 0) AS value
         FROM ${this.analyticsDb}.fact_accounting_invoices
         WHERE org_id IN ({externalOrgIds:Array(String)}) ${time}
           AND invoice_external_id != ''
         GROUP BY invoice_type ORDER BY value DESC`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return {
        data: rows.map((r: any) => ({
          name: String(r.name ?? ''),
          value: this.num(r.value),
        })),
      };
    }

    // ── transaction_value/source_type (pie/donut — journal source breakdown) ─
    if (metric === 'transaction_value' && grouping === 'source_type') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const jTbl = `${this.analyticsDb}.v_fact_accounting_journal_lines_enriched_latest`;
      const jTime = this.timeWhereOn('journal_date', range);
      const rows = await this.queryRows<any>(
        `SELECT
           coalesce(nullIf(source_type, ''), 'OTHER') AS name,
           round(abs(sum(toFloat64(line_amount))), 0) AS value
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) ${jTime}
         GROUP BY name ORDER BY value DESC`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return {
        data: rows.map((r: any) => ({
          name: String(r.name ?? ''),
          value: this.num(r.value),
        })),
      };
    }

    // ── transaction_value/currency (pie/donut) ────────────────────────────────
    if (metric === 'transaction_value' && grouping === 'currency') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           coalesce(nullIf(currency, ''), 'UNKNOWN') AS name,
           round(sum(total_amount), 0) AS value
         FROM ${this.analyticsDb}.fact_accounting_invoices
         WHERE org_id IN ({externalOrgIds:Array(String)}) ${time}
           AND invoice_external_id != ''
         GROUP BY name ORDER BY value DESC`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return {
        data: rows.map((r: any) => ({
          name: String(r.name ?? ''),
          value: this.num(r.value),
        })),
      };
    }

    // ── accounts/classification (pie/donut — P&L vs Balance Sheet) ──────────
    if (metric === 'accounts' && grouping === 'classification') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const jTbl = `${this.analyticsDb}.v_fact_accounting_journal_lines_enriched_latest`;
      const acctTbl = `${this.analyticsDb}.dim_accounting_accounts`;
      const jTime = this.timeWhereOn('journal_date', range);
      const rows = await this.queryRows<any>(
        `SELECT
           coalesce(a.classification, 'Unknown') AS name,
           round(abs(sum(toFloat64(j.line_amount))), 0) AS value
         FROM ${jTbl} j
         LEFT JOIN ${acctTbl} a
           ON a.account_id = j.account_id
          AND a.org_id     = j.org_id
          AND a.provider   = j.provider
         WHERE j.org_id IN ({externalOrgIds:Array(String)}) ${jTime}
         GROUP BY name ORDER BY value DESC`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return {
        data: rows.map((r: any) => ({
          name: String(r.name ?? ''),
          value: this.num(r.value),
        })),
      };
    }

    // ── accounts/active_status (pie — active vs inactive accounts) ───────────
    if (metric === 'accounts' && grouping === 'active_status') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           if(is_active, 'Active', 'Inactive') AS name,
           count() AS value
         FROM ${this.analyticsDb}.dim_accounting_accounts
         WHERE org_id IN ({externalOrgIds:Array(String)})
         GROUP BY name ORDER BY value DESC`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return {
        data: rows.map((r: any) => ({
          name: String(r.name ?? ''),
          value: this.num(r.value),
        })),
      };
    }

    // ── top_invoices/value (bar/horizontal_bar — top 10 by amount) ───────────
    if (metric === 'top_invoices' && grouping === 'value') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           coalesce(nullIf(invoice_number, ''), invoice_external_id) AS name,
           total_amount AS value,
           coalesce(contact_name, '') AS client,
           status
         FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
         WHERE org_id IN ({externalOrgIds:Array(String)}) ${time}
           AND invoice_external_id != '' ${arFilter} AND total_amount > 0
         ORDER BY total_amount DESC LIMIT 10`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return {
        data: rows.map((r: any) => ({
          name: String(r.name ?? ''),
          value: this.num(r.value),
          client: String(r.client ?? ''),
          status: String(r.status ?? ''),
        })),
      };
    }

    // ── invoice_amount/bucket (histogram — distribution of invoice sizes) ─────
    if (metric === 'invoice_amount' && grouping === 'bucket') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           multiIf(
             total_amount < 1000,    '$0–1K',
             total_amount < 5000,    '$1K–5K',
             total_amount < 10000,   '$5K–10K',
             total_amount < 25000,   '$10K–25K',
             total_amount < 50000,   '$25K–50K',
             total_amount < 100000,  '$50K–100K',
             '$100K+'
           ) AS bucket,
           multiIf(
             total_amount < 1000,    1,
             total_amount < 5000,    2,
             total_amount < 10000,   3,
             total_amount < 25000,   4,
             total_amount < 50000,   5,
             total_amount < 100000,  6, 7
           ) AS bucket_order,
           count() AS invoice_count
         FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
         WHERE org_id IN ({externalOrgIds:Array(String)}) ${time}
           AND invoice_external_id != '' ${arFilter} AND total_amount > 0
         GROUP BY bucket, bucket_order ORDER BY bucket_order ASC`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return {
        data: rows.map((r: any) => ({
          name: String(r.bucket ?? ''),
          value: this.num(r.invoice_count),
        })),
      };
    }

    // ── expense_by_type/source (bar — expenses ranked by source type) ─────────
    if (metric === 'expense_by_type' && grouping === 'source') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const jTbl = `${this.analyticsDb}.v_fact_accounting_journal_lines_enriched_latest`;
      const jTime = this.timeWhereOn('journal_date', range);
      const rows = await this.queryRows<any>(
        `SELECT
           coalesce(nullIf(source_type, ''), 'OTHER') AS name,
           round(abs(sum(toFloat64(line_amount))), 0) AS value
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) ${jTime}
         GROUP BY name ORDER BY value DESC`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return {
        data: rows.map((r: any) => ({
          name: String(r.name ?? ''),
          value: this.num(r.value),
        })),
      };
    }

    // ── expense_by_type/month (stacked_bar — monthly expenses by source type) ─
    if (metric === 'expense_by_type' && grouping === 'month') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const jTbl = `${this.analyticsDb}.v_fact_accounting_journal_lines_enriched_latest`;
      const jTime = this.timeWhereOn('journal_date', range);
      const rows = await this.queryRows<any>(
        `SELECT
           formatDateTime(toStartOfMonth(journal_date), '%m/%y') AS month,
           toStartOfMonth(journal_date) AS month_start,
           coalesce(nullIf(source_type, ''), 'OTHER') AS source_type,
           round(abs(sum(toFloat64(line_amount))), 0) AS amount
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) ${jTime}
           AND journal_date IS NOT NULL
         GROUP BY month, month_start, source_type
         ORDER BY month_start ASC, amount DESC`,
        { externalOrgIds: scope.externalOrgIds },
      );
      const monthMap = new Map<string, Record<string, unknown>>();
      const sortMap = new Map<string, string>();
      for (const r of rows) {
        const m = String(r.month ?? '');
        if (!monthMap.has(m)) {
          monthMap.set(m, { name: m });
          sortMap.set(m, String(r.month_start ?? ''));
        }
        (monthMap.get(m) as any)[String(r.source_type)] = this.num(r.amount);
      }
      return {
        data: [...monthMap.entries()]
          .sort(([a], [b]) =>
            (sortMap.get(a) ?? '').localeCompare(sortMap.get(b) ?? ''),
          )
          .map(([, v]) => v),
      };
    }

    // ── pl_accounts/account (bar — P&L accounts by total amount) ─────────────
    if (metric === 'pl_accounts' && grouping === 'account') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const jTbl = `${this.analyticsDb}.v_fact_accounting_journal_lines_enriched_latest`;
      const acctTbl = `${this.analyticsDb}.dim_accounting_accounts`;
      const jTime = this.timeWhereOn('journal_date', range);
      const rows = await this.queryRows<any>(
        `SELECT
           j.account_name AS name,
           round(abs(sum(toFloat64(j.line_amount))), 0) AS value
         FROM ${jTbl} j
         LEFT JOIN ${acctTbl} a
           ON a.account_id = j.account_id
          AND a.org_id     = j.org_id
          AND a.provider   = j.provider
         WHERE j.org_id IN ({externalOrgIds:Array(String)}) ${jTime}
           AND (a.classification = 'ProfitAndLoss' OR j.source_type IN ('EXPENSE','PAYROLL','TRAVEL'))
         GROUP BY name ORDER BY value DESC LIMIT 15`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return {
        data: rows.map((r: any) => ({
          name: String(r.name ?? ''),
          value: this.num(r.value),
        })),
      };
    }

    // ── bs_accounts/account (bar — Balance Sheet accounts by total amount) ────
    if (metric === 'bs_accounts' && grouping === 'account') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const jTbl = `${this.analyticsDb}.v_fact_accounting_journal_lines_enriched_latest`;
      const acctTbl = `${this.analyticsDb}.dim_accounting_accounts`;
      const jTime = this.timeWhereOn('journal_date', range);
      const rows = await this.queryRows<any>(
        `SELECT
           j.account_name AS name,
           round(abs(sum(toFloat64(j.line_amount))), 0) AS value
         FROM ${jTbl} j
         LEFT JOIN ${acctTbl} a
           ON a.account_id = j.account_id
          AND a.org_id     = j.org_id
          AND a.provider   = j.provider
         WHERE j.org_id IN ({externalOrgIds:Array(String)}) ${jTime}
           AND a.classification = 'BalanceSheet'
         GROUP BY name ORDER BY value DESC LIMIT 15`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return {
        data: rows.map((r: any) => ({
          name: String(r.name ?? ''),
          value: this.num(r.value),
        })),
      };
    }

    // ── accounts_by_type/classification (bar — total by account classification)
    if (metric === 'accounts_by_type' && grouping === 'classification') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const jTbl = `${this.analyticsDb}.v_fact_accounting_journal_lines_enriched_latest`;
      const acctTbl = `${this.analyticsDb}.dim_accounting_accounts`;
      const jTime = this.timeWhereOn('journal_date', range);
      const rows = await this.queryRows<any>(
        `SELECT
           coalesce(a.classification, 'Unknown') AS name,
           round(abs(sum(toFloat64(j.line_amount))), 0) AS value
         FROM ${jTbl} j
         LEFT JOIN ${acctTbl} a
           ON a.account_id = j.account_id
          AND a.org_id     = j.org_id
          AND a.provider   = j.provider
         WHERE j.org_id IN ({externalOrgIds:Array(String)}) ${jTime}
         GROUP BY name ORDER BY value DESC`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return {
        data: rows.map((r: any) => ({
          name: String(r.name ?? ''),
          value: this.num(r.value),
        })),
      };
    }

    // ── bubble/clients/revenue_invoices_avg ────────────────────────────────────
    if (metric === 'clients' && grouping === 'revenue_invoices_avg') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           coalesce(nullIf(contact_name, ''), 'Unknown') AS name,
           round(sum(total_amount), 0) AS revenue,
           count() AS invoice_count,
           round(avg(total_amount), 0) AS avg_invoice
         FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
         WHERE org_id IN ({externalOrgIds:Array(String)}) ${time}
           AND invoice_external_id != '' ${arFilter} AND total_amount > 0
         GROUP BY name ORDER BY revenue DESC LIMIT 20`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return {
        data: rows.map((r: any) => ({
          name: String(r.name ?? ''),
          x: this.num(r.revenue),
          y: this.num(r.invoice_count),
          z: this.num(r.avg_invoice),
          revenue: this.num(r.revenue),
          invoices: this.num(r.invoice_count),
          avgInvoice: this.num(r.avg_invoice),
        })),
      };
    }

    // ── gauge/financial_health/summary ────────────────────────────────────────
    if (metric === 'financial_health' && grouping === 'summary') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const jTbl = `${this.analyticsDb}.v_fact_accounting_journal_lines_enriched_latest`;
      const [invRows, expRows] = await Promise.all([
        this.queryRows<any>(
          `SELECT
             coalesce(sum(total_amount), 0) AS total_revenue,
             coalesce(sumIf(total_amount, lowerUTF8(status) IN ('paid','closed')), 0) AS collected,
             coalesce(sumIf(total_amount, due_at IS NOT NULL AND due_at < now()), 0) AS overdue_amount
           FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
           WHERE org_id IN ({externalOrgIds:Array(String)}) ${time}
             AND invoice_external_id != '' ${arFilter} AND total_amount > 0`,
          { externalOrgIds: scope.externalOrgIds },
        ),
        this.queryRows<any>(
          `SELECT round(abs(sum(toFloat64(line_amount))), 0) AS total_expenses
           FROM ${jTbl} WHERE org_id IN ({externalOrgIds:Array(String)})`,
          { externalOrgIds: scope.externalOrgIds },
        ),
      ]);
      const revenue = this.num((invRows[0] as any)?.total_revenue ?? 0);
      const collected = this.num((invRows[0] as any)?.collected ?? 0);
      const overdue = this.num((invRows[0] as any)?.overdue_amount ?? 0);
      const expenses = this.num((expRows[0] as any)?.total_expenses ?? 0);
      const collectionRate = revenue > 0 ? (collected / revenue) * 100 : 0;
      const overdueRatio = revenue > 0 ? (overdue / revenue) * 100 : 0;
      const netMargin =
        revenue > 0 ? ((revenue - expenses) / revenue) * 100 : 50;
      const score = Math.max(
        0,
        Math.min(
          100,
          Math.round(
            collectionRate * 0.4 +
              Math.max(0, 100 - overdueRatio * 2) * 0.3 +
              Math.max(0, Math.min(100, netMargin)) * 0.3,
          ),
        ),
      );
      return {
        data: [
          {
            name: 'Financial Health',
            value: score,
            revenue: Math.round(revenue),
            collected: Math.round(collected),
            overdue: Math.round(overdue),
            expenses: Math.round(expenses),
            collectionRate: Math.round(collectionRate),
            label:
              score >= 80
                ? 'Excellent'
                : score >= 60
                  ? 'Good'
                  : score >= 40
                    ? 'Fair'
                    : 'Needs Attention',
          },
        ],
      };
    }

    // ── kpi/summary/overview (multi-KPI cards) ────────────────────────────────
    if (metric === 'summary' && grouping === 'overview') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      // Use sample_trial_balance for authoritative P&L figures
      const [tbRows, invRows] = await Promise.all([
        this.queryRows<any>(
          `SELECT
             round(abs(sumIf(toFloat64(net_balance), account_type = 'Income')), 0) AS total_revenue,
             round(sumIf(toFloat64(net_balance), account_type = 'Cost of Goods Sold'), 0) AS total_cogs,
             round(sumIf(toFloat64(net_balance), account_type = 'Expense'), 0) AS total_opex
           FROM ${this.analyticsDb}.sample_trial_balance
           WHERE org_id IN ({externalOrgIds:Array(String)})`,
          { externalOrgIds: scope.externalOrgIds },
        ),
        this.queryRows<any>(
          `SELECT
             count() AS invoice_count,
             round(avg(total_amount), 0) AS avg_invoice,
             round(sumIf(total_amount, due_at IS NOT NULL AND due_at < now()), 0) AS overdue
           FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
           WHERE org_id IN ({externalOrgIds:Array(String)}) ${time}
             AND invoice_external_id != '' ${arFilter} AND total_amount > 0`,
          { externalOrgIds: scope.externalOrgIds },
        ),
      ]);
      const revenue = this.num((tbRows[0] as any)?.total_revenue ?? 0);
      const cogs = this.num((tbRows[0] as any)?.total_cogs ?? 0);
      const opex = this.num((tbRows[0] as any)?.total_opex ?? 0);
      const expenses = cogs + opex;
      const netProfit = revenue - expenses;
      const invoiceCount = this.num((invRows[0] as any)?.invoice_count ?? 0);
      const avgInvoice = this.num((invRows[0] as any)?.avg_invoice ?? 0);
      const overdue = this.num((invRows[0] as any)?.overdue ?? 0);
      return {
        data: [
          {
            label: 'Total Revenue',
            value: revenue,
            format: 'currency',
            icon: 'revenue',
          },
          {
            label: 'Total Expenses',
            value: expenses,
            format: 'currency',
            icon: 'expenses',
          },
          {
            label: 'Net Profit',
            value: netProfit,
            format: 'currency',
            icon: 'profit',
          },
          {
            label: 'Avg Invoice Value',
            value: avgInvoice,
            format: 'currency',
            icon: 'invoice',
          },
          {
            label: 'Invoice Count',
            value: invoiceCount,
            format: 'number',
            icon: 'count',
          },
          {
            label: 'Overdue Amount',
            value: overdue,
            format: 'currency',
            icon: 'overdue',
          },
        ],
      };
    }

    // ── heatmap/revenue_expense/month ─────────────────────────────────────────
    if (metric === 'revenue_expense' && grouping === 'month') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const jTbl = `${this.analyticsDb}.v_fact_accounting_journal_lines_enriched_latest`;
      const jTime = this.timeWhereOn('journal_date', range);
      const [revRows, expRows] = await Promise.all([
        this.queryRows<any>(
          `SELECT formatDateTime(toStartOfMonth(issued_at), '%b %y') AS month,
             toStartOfMonth(issued_at) AS month_start,
             round(sum(total_amount), 0) AS value
           FROM ${this.analyticsDb}.fact_accounting_invoices
           WHERE org_id IN ({externalOrgIds:Array(String)}) ${time} ${arFilter} AND issued_at IS NOT NULL
           GROUP BY month, month_start ORDER BY month_start ASC LIMIT 24`,
          { externalOrgIds: scope.externalOrgIds },
        ),
        this.queryRows<any>(
          `SELECT formatDateTime(toStartOfMonth(journal_date), '%b %y') AS month,
             toStartOfMonth(journal_date) AS month_start,
             round(abs(sum(toFloat64(line_amount))), 0) AS value
           FROM ${jTbl}
           WHERE org_id IN ({externalOrgIds:Array(String)}) ${jTime} AND journal_date IS NOT NULL
           GROUP BY month, month_start ORDER BY month_start ASC LIMIT 24`,
          { externalOrgIds: scope.externalOrgIds },
        ),
      ]);
      const revMap = new Map(
        revRows.map((r: any) => [
          String(r.month),
          { value: this.num(r.value), sort: String(r.month_start) },
        ]),
      );
      const expMap = new Map(
        expRows.map((r: any) => [
          String(r.month),
          { value: this.num(r.value), sort: String(r.month_start) },
        ]),
      );
      const months = [...new Set([...revMap.keys(), ...expMap.keys()])].sort(
        (a, b) =>
          (revMap.get(a)?.sort ?? expMap.get(a)?.sort ?? '').localeCompare(
            revMap.get(b)?.sort ?? expMap.get(b)?.sort ?? '',
          ),
      );
      return {
        data: months.map((m) => ({
          name: m,
          Revenue: revMap.get(m)?.value ?? 0,
          Expenses: expMap.get(m)?.value ?? 0,
          Net: (revMap.get(m)?.value ?? 0) - (expMap.get(m)?.value ?? 0),
        })),
      };
    }

    // ── expense/department (bar, pie, treemap, donut) ────────────────────────
    // Falls back to account_name grouping when department data is not populated.
    if (metric === 'expense' && grouping === 'department') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      // Use sample_gl_dump for exact department data (Admin, Operations, Sales only — no Finance)
      // Power BI "Spend by Department" = _measures.Total Debits = SUM(gl_dump[Debit])
      // ALL debits, NO account_type filter → Admin=374,580 Operations=716,470 Sales=216,196
      const deptRows = await this.queryRows<any>(
        `SELECT
           department AS name,
           round(sum(toFloat64(debit)), 0) AS value
         FROM ${glTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})
           AND department != '' AND toFloat64(debit) > 0
         GROUP BY department HAVING value > 0
         ORDER BY value DESC LIMIT 20`,
        { externalOrgIds: scope.externalOrgIds },
      );
      if (deptRows.length > 0) {
        return {
          data: deptRows.map((r: any) => ({
            name: String(r.name),
            value: this.num(r.value),
          })),
        };
      }
      // Fallback to journal lines if gl_dump has no data
      const fallbackRows = await this.queryRows<any>(
        `SELECT
           department AS name,
           round(sum(line_amount), 0) AS value
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${jTime}
           AND line_amount > 0 AND journal_date IS NOT NULL AND department != '' ${BS_EXCL}
         GROUP BY name HAVING value > 0
         ORDER BY value DESC LIMIT 20`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      return {
        data: fallbackRows.map((r: any) => ({
          name: String(r.name),
          value: this.num(r.value),
        })),
      };
    }

    // ── expense/class (bar, pie, treemap) ─────────────────────────────────────
    if (metric === 'expense' && grouping === 'class') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      // Use sample_gl_dump for exact class data (General, Marketing, Product)
      // Power BI "Spend by Class" = _measures.Total Debits = SUM(gl_dump[Debit])
      // ALL debits, NO account_type filter
      const classRows = await this.queryRows<any>(
        `SELECT
           class AS name,
           round(sum(toFloat64(debit)), 0) AS value
         FROM ${glTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})
           AND class != '' AND toFloat64(debit) > 0
         GROUP BY class HAVING value > 0
         ORDER BY value DESC LIMIT 20`,
        { externalOrgIds: scope.externalOrgIds },
      );
      if (classRows.length > 0) {
        return {
          data: classRows.map((r: any) => ({
            name: String(r.name),
            value: this.num(r.value),
          })),
        };
      }
      // Fallback to journal lines if gl_dump has no class data
      const fallbackRows = await this.queryRows<any>(
        `SELECT
           class_name AS name,
           round(sum(line_amount), 0) AS value
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${jTime}
           AND line_amount > 0 AND journal_date IS NOT NULL AND class_name != '' ${BS_EXCL}
         GROUP BY name HAVING value > 0
         ORDER BY value DESC LIMIT 20`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      return {
        data: fallbackRows.map((r: any) => ({
          name: String(r.name),
          value: this.num(r.value),
        })),
      };
    }

    // ── expense/vendor (horizontal_bar, pareto, table, scatter) ──────────────
    // Primary: sample_gl_dump.vendor_customer (exact Excel data, 24 real vendors)
    if (metric === 'expense' && grouping === 'vendor') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const limit = Math.max(5, Math.min(50, requestedTopN ?? 20));
      // Power BI: Total Vendor Spend = SUM(gl_dump[Debit]) — ALL debits, NO account_type filter
      // Includes Payroll ($280,596), COGS suppliers, and Expense vendors → total 1,307,246
      const glVendorRows = await this.queryRows<any>(
        `SELECT
           vendor_customer AS name,
           round(sum(toFloat64(debit)), 0) AS value,
           count() AS transaction_count,
           round(avg(toFloat64(debit)), 0) AS avg_amount
         FROM ${glTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})
           AND vendor_customer != '' AND toFloat64(debit) > 0
         GROUP BY vendor_customer HAVING value > 0
         ORDER BY value DESC LIMIT ${limit}`,
        { externalOrgIds: scope.externalOrgIds },
      );
      if (glVendorRows.length > 0) {
        return {
          data: glVendorRows.map((r: any) => ({
            name: String(r.name),
            value: this.num(r.value),
            transactions: this.num(r.transaction_count),
            avgAmount: this.num(r.avg_amount),
          })),
        };
      }
      // Fallback: journal lines vendor data
      const vendorRows = await this.queryRowsWithTimeFallback<any>(
        (t) => `SELECT
           vendor_name AS name,
           round(sum(line_amount), 0) AS value,
           count() AS transaction_count,
           round(avg(line_amount), 0) AS avg_amount
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${t}
           AND line_amount > 0 AND journal_date IS NOT NULL AND vendor_name != '' ${BS_EXCL}
         GROUP BY name HAVING value > 0
         ORDER BY value DESC LIMIT ${limit}`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
        jTime,
      );
      if (vendorRows.length > 0) {
        return {
          data: vendorRows.map((r: any) => ({
            name: String(r.name),
            value: this.num(r.value),
            transactions: this.num(r.transaction_count),
            avgAmount: this.num(r.avg_amount),
          })),
        };
      }
      return { data: [], _noVendorData: true } as any;
    }

    // ── revenue/account | revenue/category (bar, pie) ───────────────────────
    // Mirrors Power BI DAX exactly: use sample_trial_balance credit column per account name
    // Product Sales=980,400  Service Revenue=215,600  Consulting=87,300  Other Income=12,800
    if (
      metric === 'revenue' &&
      (grouping === 'account' ||
        grouping === 'category' ||
        grouping === 'account_name')
    ) {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      // Primary: sample_trial_balance credit column — exact match to Power BI
      const tbRevRows = await this.queryRows<any>(
        `SELECT account_name AS name, round(toFloat64(credit), 0) AS value
         FROM ${tbTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})
           AND account_type = 'Income' AND toFloat64(credit) > 0
         ORDER BY value DESC LIMIT 20`,
        { externalOrgIds: scope.externalOrgIds },
      );
      if (tbRevRows.length > 0) {
        return {
          data: tbRevRows.map((r: any) => ({
            name: String(r.name),
            value: this.num(r.value),
          })),
        };
      }
      // Fallback: journal lines (for non-sample orgs)
      const revRows = await this.queryRows<any>(
        `SELECT
           account_name AS name,
           round(abs(sum(line_amount)), 0) AS value
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${jTime}
           AND source_type = 'REV' AND journal_date IS NOT NULL AND account_name != ''
         GROUP BY name HAVING value > 0
         ORDER BY value DESC LIMIT 20`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      if (revRows.length > 0) {
        return {
          data: revRows.map((r: any) => ({
            name: String(r.name),
            value: this.num(r.value),
          })),
        };
      }
      const fallbackRows = await this.queryRows<any>(
        `SELECT account_name AS name, round(abs(sum(line_amount)), 0) AS value
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${jTime}
           AND line_amount < 0 AND journal_date IS NOT NULL AND account_name != ''
           AND (lowerUTF8(account_name) LIKE '%revenue%' OR lowerUTF8(account_name) LIKE '%income%'
             OR lowerUTF8(account_name) LIKE '%product sales%' OR lowerUTF8(account_name) LIKE '%consulting%')
           AND lowerUTF8(account_name) NOT LIKE '%payable%'
           AND lowerUTF8(account_name) NOT LIKE '%accrued%'
           AND lowerUTF8(account_name) NOT LIKE '%payroll%'
         GROUP BY name HAVING value > 0 ORDER BY value DESC LIMIT 20`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      return {
        data: fallbackRows.map((r: any) => ({
          name: String(r.name),
          value: this.num(r.value),
        })),
      };
    }

    // ── revenue/department (bar, pie) ─────────────────────────────────────────
    if (metric === 'revenue' && grouping === 'department') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const deptRows = await this.queryRows<any>(
        `SELECT
           COALESCE(NULLIF(department,''),'Other') AS name,
           round(abs(sum(line_amount)), 0) AS value
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${jTime}
           AND source_type = 'REV' AND journal_date IS NOT NULL
         GROUP BY COALESCE(NULLIF(department,''),'Other') HAVING value > 0
         ORDER BY value DESC LIMIT 20`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      return {
        data: deptRows.map((r: any) => ({
          name: String(r.name),
          value: this.num(r.value),
        })),
      };
    }

    // ── net_income/department (bar, waterfall) ────────────────────────────────
    if (metric === 'net_income' && grouping === 'department') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const deptRows = await this.queryRows<any>(
        `SELECT
           department AS name,
           round(sumIf(abs(line_amount), line_amount < 0), 0) AS revenue,
           round(sumIf(line_amount, line_amount > 0), 0) AS expenses,
           round(sumIf(abs(line_amount), line_amount < 0) - sumIf(line_amount, line_amount > 0), 0) AS value
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${jTime}
           AND journal_date IS NOT NULL AND department != '' ${BS_EXCL}
         GROUP BY name
         ORDER BY value DESC LIMIT 20`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      return {
        data: deptRows.map((r: any) => ({
          name: String(r.name),
          value: this.num(r.value),
          revenue: this.num(r.revenue),
          expenses: this.num(r.expenses),
        })),
      };
    }

    // ── debits_credits/account_type (stacked_bar) ─────────────────────────────
    // Derives debit/credit from line_amount sign (never uses stored debit_amount/credit_amount
    // which may be zero for older/seeded data). Groups by account classification derived
    // from account_name patterns.
    if (metric === 'debits_credits' && grouping === 'account_type') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           multiIf(
             lowerUTF8(account_name) LIKE '%payroll%' OR lowerUTF8(account_name) LIKE '%salary%' OR lowerUTF8(account_name) LIKE '%salaries%' OR lowerUTF8(account_name) LIKE '%wages%', 'Payroll',
             lowerUTF8(account_name) LIKE '%receivable%' OR lowerUTF8(account_name) LIKE '%payable%', 'AR/AP',
             lowerUTF8(account_name) LIKE '%revenue%' OR lowerUTF8(account_name) LIKE '%income%' OR lowerUTF8(account_name) LIKE '%product sales%' OR lowerUTF8(account_name) LIKE '%consulting%' OR lowerUTF8(account_name) LIKE '%service fee%', 'Revenue',
             lowerUTF8(account_name) LIKE '%cost of%' OR lowerUTF8(account_name) LIKE '%cogs%' OR lowerUTF8(account_name) LIKE '%direct labor%' OR lowerUTF8(account_name) LIKE '%freight%' OR lowerUTF8(account_name) LIKE '%shipping%', 'Cost of Sales',
             lowerUTF8(account_name) LIKE '%depreciation%' OR lowerUTF8(account_name) LIKE '%amortiz%', 'Depreciation',
             lowerUTF8(account_name) LIKE '%tax%', 'Tax',
             lowerUTF8(account_name) LIKE '%cash%' OR lowerUTF8(account_name) LIKE '%bank%', 'Cash & Bank',
             lowerUTF8(account_name) LIKE '%equity%' OR lowerUTF8(account_name) LIKE '%retained%' OR lowerUTF8(account_name) LIKE '%capital%', 'Equity',
             account_name = '', 'Unknown',
             'Operating Expenses'
           ) AS name,
           round(sumIf(toFloat64(line_amount),  line_amount > 0), 0) AS debits,
           round(sumIf(-toFloat64(line_amount), line_amount < 0), 0) AS credits
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${jTime}
           AND journal_date IS NOT NULL AND account_name != ''
         GROUP BY name
         HAVING (debits + credits) > 0
         ORDER BY (debits + credits) DESC LIMIT 12`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      return {
        data: rows.map((r: any) => ({
          name: String(r.name),
          Debits: this.num(r.debits),
          Credits: this.num(r.credits),
          value: this.num(r.debits) + this.num(r.credits),
        })),
      };
    }

    // ── expense/month_department (stacked_bar — multi-series by department) ───
    if (metric === 'expense' && grouping === 'month_department') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      // Prefer sample_gl_dump when it has data:
      // - It's the authoritative source for the sample company.
      // - It guarantees the real department list (Admin/Operations/Sales) and prevents
      //   synthetic departments (e.g. Finance) from showing up via journal-line fallbacks.
      //
      // When the request is "last N months", anchor the window to the latest date
      // present in the dataset (not "now") so sample data still produces a trend.
      const maxDateRows = await this.queryRows<any>(
        `SELECT max(date) AS max_date
         FROM ${glTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) AND date IS NOT NULL`,
        { externalOrgIds: scope.externalOrgIds },
      );

      const maxDate = String((maxDateRows[0] as any)?.max_date ?? '').slice(
        0,
        10,
      );
      const hasMaxDate = /^\d{4}-\d{2}-\d{2}$/.test(maxDate);

      const isoDate = (d: Date) =>
        `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
          d.getUTCDate(),
        ).padStart(2, '0')}`;

      const addMonthsUtc = (yyyyMmDd: string, deltaMonths: number) => {
        const [y, m, day] = yyyyMmDd.split('-').map((n) => Number(n));
        const base = new Date(Date.UTC(y, (m ?? 1) - 1, day ?? 1));
        base.setUTCMonth(base.getUTCMonth() + deltaMonths);
        return isoDate(base);
      };

      const startOfMonthUtc = (yyyyMmDd: string) => {
        const [y, m] = yyyyMmDd.split('-').map((n) => Number(n));
        return isoDate(new Date(Date.UTC(y, (m ?? 1) - 1, 1)));
      };

      const startOfQuarterUtc = (yyyyMmDd: string) => {
        const [y, m] = yyyyMmDd.split('-').map((n) => Number(n));
        const quarterStartMonth = Math.floor(((m ?? 1) - 1) / 3) * 3 + 1; // 1,4,7,10
        return isoDate(new Date(Date.UTC(y, quarterStartMonth - 1, 1)));
      };

      const startOfYearUtc = (yyyyMmDd: string) => {
        const [y] = yyyyMmDd.split('-').map((n) => Number(n));
        return isoDate(new Date(Date.UTC(y, 0, 1)));
      };

      const glTimeParts: string[] = [];
      const glParams: Record<string, unknown> = {
        externalOrgIds: scope.externalOrgIds,
      };

      if (hasMaxDate && range?.kind) {
        if (range.kind === 'BETWEEN_DATES') {
          glTimeParts.push(
            'AND date >= toDate({start:String}) AND date <= toDate({end:String})',
          );
          glParams.start = range.start;
          glParams.end = range.end;
        } else if (range.kind === 'SINCE_DATE') {
          glTimeParts.push(
            'AND date >= toDate({start:String}) AND date <= toDate({end:String})',
          );
          glParams.start = range.start;
          glParams.end = maxDate;
        } else if (range.kind === 'LAST_N_DAYS') {
          glTimeParts.push(
            'AND date >= addDays(toDate({end:String}), -{days:Int32}) AND date <= toDate({end:String})',
          );
          glParams.end = maxDate;
          glParams.days = Math.max(1, Math.min(3650, range.days));
        } else if (range.kind === 'LAST_N_WEEKS') {
          glTimeParts.push(
            'AND date >= addDays(toDate({end:String}), -{days:Int32}) AND date <= toDate({end:String})',
          );
          glParams.end = maxDate;
          glParams.days = Math.max(1, Math.min(520, range.weeks)) * 7;
        } else if (range.kind === 'LAST_N_MONTHS') {
          const months = Math.max(1, Math.min(240, range.months));
          glTimeParts.push(
            'AND date >= toDate({start:String}) AND date <= toDate({end:String})',
          );
          glParams.end = maxDate;
          glParams.start = addMonthsUtc(maxDate, -months);
        } else if (range.kind === 'LAST_N_QUARTERS') {
          const quarters = Math.max(1, Math.min(80, range.quarters));
          glTimeParts.push(
            'AND date >= toDate({start:String}) AND date <= toDate({end:String})',
          );
          glParams.end = maxDate;
          glParams.start = addMonthsUtc(maxDate, -(quarters * 3));
        } else if (range.kind === 'LAST_N_YEARS') {
          const years = Math.max(1, Math.min(30, range.years));
          glTimeParts.push(
            'AND date >= toDate({start:String}) AND date <= toDate({end:String})',
          );
          glParams.end = maxDate;
          glParams.start = addMonthsUtc(maxDate, -(years * 12));
        } else if (range.kind === 'MTD') {
          glTimeParts.push(
            'AND date >= toDate({start:String}) AND date <= toDate({end:String})',
          );
          glParams.end = maxDate;
          glParams.start = startOfMonthUtc(maxDate);
        } else if (range.kind === 'QTD') {
          glTimeParts.push(
            'AND date >= toDate({start:String}) AND date <= toDate({end:String})',
          );
          glParams.end = maxDate;
          glParams.start = startOfQuarterUtc(maxDate);
        } else if (range.kind === 'YTD') {
          glTimeParts.push(
            'AND date >= toDate({start:String}) AND date <= toDate({end:String})',
          );
          glParams.end = maxDate;
          glParams.start = startOfYearUtc(maxDate);
        }
      }

      const glTime = glTimeParts.length
        ? `\n           ${glTimeParts.join('\n           ')}`
        : '';
      // Power BI "Monthly spend by Department" uses _measures.Total Debits = SUM(gl_dump[Debit])
      // ALL debits, NO account_type filter (includes Inventory, Payroll, Expenses)
      const glRows = await this.queryRows<any>(
        `SELECT
           formatDateTime(toStartOfMonth(date), '%b %y') AS month,
           toStartOfMonth(date) AS month_start,
           department AS dept,
           round(sum(toFloat64(debit)), 0) AS value
         FROM ${glTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})
           AND department != ''
           AND toFloat64(debit) > 0
           AND date IS NOT NULL
           ${glTime}
         GROUP BY month, month_start, dept
         HAVING value > 0
         ORDER BY month_start ASC, value DESC`,
        glParams,
      );

      const rows = glRows.length
        ? glRows
        : await this.queryRows<any>(
            `SELECT
               formatDateTime(toStartOfMonth(journal_date), '%b %y') AS month,
               toStartOfMonth(journal_date) AS month_start,
               coalesce(nullIf(department, ''), 'Unassigned') AS dept,
               round(sum(line_amount), 0) AS value
             FROM ${jTbl}
             WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${jTime}
               AND line_amount > 0 AND journal_date IS NOT NULL ${BS_EXCL}
             GROUP BY month, month_start, dept
             ORDER BY month_start ASC, value DESC`,
            { externalOrgIds: scope.externalOrgIds, ...entityParam },
          );
      // pivot: [{month, Dept1: val, Dept2: val, ...}]
      const monthMap = new Map<string, { sort: string; [key: string]: any }>();
      const depts = new Set<string>();
      for (const r of rows as any[]) {
        const m = String(r.month);
        if (!monthMap.has(m)) monthMap.set(m, { sort: String(r.month_start) });
        monthMap.get(m)![String(r.dept)] = this.num(r.value);
        depts.add(String(r.dept));
      }
      const data = [...monthMap.entries()]
        .sort(([, a], [, b]) => a.sort.localeCompare(b.sort))
        .map(([month, vals]) => {
          const row: Record<string, any> = { name: month };
          for (const d of depts) row[d] = vals[d] ?? 0;
          return row;
      });
      return { data, keys: [...depts] };
    }

    // ── expense/department_vendor (matrix — departments as rows, vendors as cols) ─────────
    if (metric === 'expense' && grouping === 'department_vendor') {
      return this.buildExpensePivot('department', 'vendor', scope, entityParam, range, 40);
    }

    // ── generic expense pivots for heatmap/matrix/line comparisons ──────────
    if (metric === 'expense') {
      const pivotGroupings = new Set([
        'month_account',
        'account_month',
        'account_department',
        'department_account',
        'department_class',
        'class_department',
        'vendor_department',
        'vendor_month',
        'account_vendor',
        'vendor_account',
        'class_month',
      ]);
      if (pivotGroupings.has(grouping)) {
        const [rowAxis, colAxis] = grouping.split('_') as [PivotAxis, PivotAxis];
        return this.buildExpensePivot(rowAxis, colAxis, scope, entityParam, range);
      }
    }

    // ── expense/month_vendor (multi-series line — top vendors by month) ─────────
    if (metric === 'expense' && grouping === 'month_vendor') {
      return this.buildExpensePivot('month', 'vendor', scope, entityParam, range, 24);
    }

    // ── vendor_transactions/vendor (scatter, bubble) — falls back to account ───
    if (metric === 'vendor_transactions' && grouping === 'vendor') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const glVendorRows = await this.queryRows<any>(
        `SELECT
           vendor_customer AS name,
           round(sum(toFloat64(debit)), 0) AS total_spend,
           count() AS transaction_count,
           round(avg(toFloat64(debit)), 0) AS avg_transaction
         FROM ${glTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})
           AND vendor_customer != '' AND toFloat64(debit) > 0
         GROUP BY vendor_customer
         HAVING total_spend > 0
         ORDER BY total_spend DESC LIMIT 40`,
        { externalOrgIds: scope.externalOrgIds },
      );
      if (glVendorRows.length > 0) {
        return {
          data: glVendorRows.map((r: any) => ({
            name: String(r.name),
            x: this.num(r.total_spend),
            y: this.num(r.transaction_count),
            z: this.num(r.avg_transaction),
            value: this.num(r.total_spend),
          })),
        };
      }
      const vendorRows = await this.queryRows<any>(
        `SELECT
           vendor_name AS name,
           round(sum(line_amount), 0) AS total_spend,
           count() AS transaction_count,
           round(avg(line_amount), 0) AS avg_transaction
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${jTime}
           AND line_amount > 0 AND journal_date IS NOT NULL AND vendor_name != '' ${BS_EXCL}
         GROUP BY name HAVING total_spend > 0
         ORDER BY total_spend DESC LIMIT 30`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      if (vendorRows.length === 0)
        return { data: [], _noVendorData: true } as any;
      return {
        data: (vendorRows as any[]).map((r: any) => ({
          name: String(r.name),
          x: this.num(r.transaction_count),
          y: this.num(r.total_spend),
          z: this.num(r.avg_transaction),
          totalSpend: this.num(r.total_spend),
          transactions: this.num(r.transaction_count),
          avgTransaction: this.num(r.avg_transaction),
        })),
      };
    }

    // ── expense/account_type (bar, pie) — derived from account_name patterns ──
    if (metric === 'expense' && grouping === 'account_type') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           multiIf(
             lowerUTF8(account_name) LIKE '%cost of%' OR lowerUTF8(account_name) LIKE '%cogs%', 'Cost of Sales',
             lowerUTF8(account_name) LIKE '%payroll%' OR lowerUTF8(account_name) LIKE '%salary%' OR lowerUTF8(account_name) LIKE '%wages%', 'Payroll',
             lowerUTF8(account_name) LIKE '%rent%' OR lowerUTF8(account_name) LIKE '%lease%', 'Rent & Facilities',
             lowerUTF8(account_name) LIKE '%marketing%' OR lowerUTF8(account_name) LIKE '%advertising%', 'Marketing',
             lowerUTF8(account_name) LIKE '%software%' OR lowerUTF8(account_name) LIKE '%subscription%' OR lowerUTF8(account_name) LIKE '%saas%', 'Software',
             lowerUTF8(account_name) LIKE '%travel%' OR lowerUTF8(account_name) LIKE '%entertainment%', 'Travel & Entertainment',
             lowerUTF8(account_name) LIKE '%depreciation%' OR lowerUTF8(account_name) LIKE '%amortiz%', 'Depreciation',
             lowerUTF8(account_name) LIKE '%insurance%', 'Insurance',
             lowerUTF8(account_name) LIKE '%tax%', 'Tax',
             account_name = '', 'Unknown',
             'Other Expenses'
           ) AS name,
           round(sum(line_amount), 0) AS value
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${jTime}
           AND line_amount > 0 AND journal_date IS NOT NULL ${BS_EXCL}
         GROUP BY name
         HAVING value > 0
         ORDER BY value DESC LIMIT 15`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      return {
        data: rows.map((r: any) => ({
          name: String(r.name),
          value: this.num(r.value),
        })),
      };
    }

    // ── vendor_count/vendor (bar) — falls back to account when no vendor data ──
    if (metric === 'vendor_count' && grouping === 'vendor') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const glVendorRows = await this.queryRows<any>(
        `SELECT vendor_customer AS name, count() AS value
         FROM ${glTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})
           AND vendor_customer != '' AND toFloat64(debit) > 0
         GROUP BY vendor_customer
         ORDER BY value DESC LIMIT 40`,
        { externalOrgIds: scope.externalOrgIds },
      );
      if (glVendorRows.length > 0) {
        return {
          data: (glVendorRows as any[]).map((r: any) => ({
            name: String(r.name),
            value: this.num(r.value),
          })),
        };
      }
      const vendorRows = await this.queryRows<any>(
        `SELECT vendor_name AS name, count() AS value
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${jTime}
           AND line_amount > 0 AND journal_date IS NOT NULL AND vendor_name != ''
         GROUP BY name ORDER BY value DESC LIMIT 20`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      if (vendorRows.length === 0)
        return { data: [], _noVendorData: true } as any;
      return {
        data: (vendorRows as any[]).map((r: any) => ({
          name: String(r.name),
          value: this.num(r.value),
        })),
      };
    }

    // ── vendor_count/month_vendor — monthly transaction activity by vendor ───
    if (metric === 'vendor_count' && grouping === 'month_vendor') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           formatDateTime(toStartOfMonth(date), '%b %y') AS month,
           toStartOfMonth(date) AS month_start,
           vendor_customer AS vendor,
           count() AS value
         FROM ${glTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})
           AND date IS NOT NULL
           AND vendor_customer != ''
           AND toFloat64(debit) > 0
         GROUP BY month, month_start, vendor
         HAVING value > 0
         ORDER BY month_start ASC, value DESC`,
        { externalOrgIds: scope.externalOrgIds },
      );
      if (rows.length === 0) return { data: [], _noVendorData: true } as any;
      const totals = new Map<string, number>();
      for (const r of rows as any[]) {
        const vendor = String(r.vendor);
        totals.set(vendor, (totals.get(vendor) ?? 0) + this.num(r.value));
      }
      const vendors = Array.from(totals.entries())
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 24)
        .map(([vendor]) => vendor);
      const monthMap = new Map<string, { sort: string; [key: string]: any }>();
      for (const r of rows as any[]) {
        const vendor = String(r.vendor);
        if (!vendors.includes(vendor)) continue;
        const month = String(r.month);
        if (!monthMap.has(month)) monthMap.set(month, { sort: String(r.month_start) });
        monthMap.get(month)![vendor] = this.num(r.value);
      }
      const data = [...monthMap.entries()]
        .sort(([, a], [, b]) => a.sort.localeCompare(b.sort))
        .map(([month, vals]) => {
          const row: Record<string, any> = { name: month };
          for (const vendor of vendors) row[vendor] = vals[vendor] ?? 0;
          return row;
        });
      return { data, keys: vendors };
    }

    // ── net_income/month_department (stacked_bar — multi-series P&L) ─────────
    if (metric === 'net_income' && grouping === 'month_department') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           formatDateTime(toStartOfMonth(journal_date), '%b %y') AS month,
           toStartOfMonth(journal_date) AS month_start,
           coalesce(nullIf(department, ''), 'Unassigned') AS dept,
           round(
             sumIf(abs(line_amount), line_amount < 0) - sumIf(line_amount, line_amount > 0),
             0
           ) AS value
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${jTime}
           AND journal_date IS NOT NULL ${BS_EXCL}
         GROUP BY month, month_start, dept
         ORDER BY month_start ASC`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      const monthMap = new Map<string, { sort: string; [key: string]: any }>();
      const depts = new Set<string>();
      for (const r of rows as any[]) {
        const m = String(r.month);
        if (!monthMap.has(m)) monthMap.set(m, { sort: String(r.month_start) });
        monthMap.get(m)![String(r.dept)] = this.num(r.value);
        depts.add(String(r.dept));
      }
      const data = [...monthMap.entries()]
        .sort(([, a], [, b]) => a.sort.localeCompare(b.sort))
        .map(([month, vals]) => {
          const row: Record<string, any> = { name: month };
          for (const d of depts) row[d] = vals[d] ?? 0;
          return row;
        });
      return { data, keys: [...depts] };
    }

    // ── expense/month_class (multi-series line/stacked_bar by class) ────────
    if (metric === 'expense' && grouping === 'month_class') {
      return this.buildExpensePivot('month', 'class', scope, entityParam, range, 10);
    }

    // ── expense/dept_class (stacked bar: dept × class breakdown) ────────────
    if (metric === 'expense' && grouping === 'dept_class') {
      return this.buildExpensePivot('department', 'class', scope, entityParam, range, 10);
    }

    // ── expense/dept_stats (scatter: dept total spend vs vendor count) ───────
    if (metric === 'expense' && grouping === 'dept_stats') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           coalesce(nullIf(department, ''), 'Unassigned') AS name,
           round(sum(line_amount), 0) AS total_spend,
           countDistinct(vendor_name) AS vendor_count,
           count() AS transaction_count
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${jTime}
           AND line_amount > 0 AND journal_date IS NOT NULL ${BS_EXCL}
         GROUP BY name
         HAVING total_spend > 0
         ORDER BY total_spend DESC LIMIT 20`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      return {
        data: (rows as any[]).map((r: any) => ({
          name: String(r.name),
          x: this.num(r.vendor_count),
          y: this.num(r.total_spend),
          z: this.num(r.transaction_count),
          totalSpend: this.num(r.total_spend),
          vendorCount: this.num(r.vendor_count),
          transactions: this.num(r.transaction_count),
        })),
      };
    }

    // ── revenue_vs_expense/department (dept-level comparison stacked/bar) ───
    if (metric === 'revenue_vs_expense' && grouping === 'department') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const [expRows, revJRows] = await Promise.all([
        this.queryRows<any>(
          `SELECT coalesce(nullIf(department, ''), 'Unassigned') AS dept,
                  round(sum(line_amount), 0) AS expenses
           FROM ${jTbl}
           WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${jTime}
             AND line_amount > 0 AND journal_date IS NOT NULL ${BS_EXCL}
           GROUP BY dept HAVING expenses > 0`,
          { externalOrgIds: scope.externalOrgIds, ...entityParam },
        ),
        this.queryRows<any>(
          `SELECT coalesce(nullIf(department, ''), 'Unassigned') AS dept,
                  round(sum(abs(line_amount)), 0) AS revenue
           FROM ${jTbl}
           WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${jTime}
             AND line_amount < 0 AND journal_date IS NOT NULL
             AND (lowerUTF8(account_name) LIKE '%revenue%'
               OR lowerUTF8(account_name) LIKE '%income%'
               OR lowerUTF8(account_name) LIKE '%product sales%'
               OR lowerUTF8(account_name) LIKE '%consulting%'
               OR lowerUTF8(account_name) LIKE '%service revenue%')
           GROUP BY dept HAVING revenue > 0`,
          { externalOrgIds: scope.externalOrgIds, ...entityParam },
        ),
      ]);
      const revMap = new Map<string, number>(
        (revJRows as any[]).map((r: any) => [
          String(r.dept),
          this.num(r.revenue),
        ]),
      );
      return {
        data: (expRows as any[]).map((r: any) => ({
          name: String(r.dept),
          Expenses: this.num(r.expenses),
          Revenue: revMap.get(String(r.dept)) ?? 0,
        })),
        keys: ['Expenses', 'Revenue'],
      };
    }

    // ── net_margin/month (line) — (revenue - expenses) / revenue × 100 ──────
    if (metric === 'net_margin' && grouping === 'month') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const [revRows, expRows] = await Promise.all([
        this.queryRows<any>(
          `SELECT toStartOfMonth(journal_date) AS month_start,
                  round(sum(abs(line_amount)), 0) AS rev
           FROM ${jTbl}
           WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${jTime}
             AND line_amount < 0 AND journal_date IS NOT NULL
             AND (lowerUTF8(account_name) LIKE '%revenue%'
               OR lowerUTF8(account_name) LIKE '%income%'
               OR lowerUTF8(account_name) LIKE '%product sales%'
               OR lowerUTF8(account_name) LIKE '%consulting%'
               OR lowerUTF8(account_name) LIKE '%service revenue%')
           GROUP BY month_start`,
          { externalOrgIds: scope.externalOrgIds, ...entityParam },
        ),
        this.queryRows<any>(
          `SELECT toStartOfMonth(journal_date) AS month_start,
                  round(sum(line_amount), 0) AS exp
           FROM ${jTbl}
           WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${jTime}
             AND line_amount > 0 AND journal_date IS NOT NULL ${BS_EXCL}
           GROUP BY month_start`,
          { externalOrgIds: scope.externalOrgIds, ...entityParam },
        ),
      ]);
      const expMap = new Map<string, number>(
        (expRows as any[]).map((r: any) => [
          String(r.month_start),
          this.num(r.exp),
        ]),
      );
      return {
        data: (revRows as any[])
          .map((r: any) => {
            const rev = this.num(r.rev);
            const exp = expMap.get(String(r.month_start)) ?? 0;
            return {
              name: String(r.month_start),
              value: rev > 0 ? Math.round(((rev - exp) / rev) * 1000) / 10 : 0,
            };
          })
          .sort((a: any, b: any) => a.name.localeCompare(b.name)),
      };
    }

    // ── expense_ratio/month (line) — total expenses / revenue × 100 ─────────
    if (metric === 'expense_ratio' && grouping === 'month') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const [revRows, expRows] = await Promise.all([
        this.queryRows<any>(
          `SELECT toStartOfMonth(journal_date) AS month_start,
                  round(sum(abs(line_amount)), 0) AS rev
           FROM ${jTbl}
           WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${jTime}
             AND line_amount < 0 AND journal_date IS NOT NULL
             AND (lowerUTF8(account_name) LIKE '%revenue%'
               OR lowerUTF8(account_name) LIKE '%income%'
               OR lowerUTF8(account_name) LIKE '%product sales%'
               OR lowerUTF8(account_name) LIKE '%consulting%'
               OR lowerUTF8(account_name) LIKE '%service revenue%')
           GROUP BY month_start`,
          { externalOrgIds: scope.externalOrgIds, ...entityParam },
        ),
        this.queryRows<any>(
          `SELECT toStartOfMonth(journal_date) AS month_start,
                  round(sum(line_amount), 0) AS exp
           FROM ${jTbl}
           WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${jTime}
             AND line_amount > 0 AND journal_date IS NOT NULL ${BS_EXCL}
           GROUP BY month_start`,
          { externalOrgIds: scope.externalOrgIds, ...entityParam },
        ),
      ]);
      const expMap = new Map<string, number>(
        (expRows as any[]).map((r: any) => [
          String(r.month_start),
          this.num(r.exp),
        ]),
      );
      return {
        data: (revRows as any[])
          .map((r: any) => {
            const rev = this.num(r.rev);
            const exp = expMap.get(String(r.month_start)) ?? 0;
            return {
              name: String(r.month_start),
              value: rev > 0 ? Math.round((exp / rev) * 1000) / 10 : 0,
            };
          })
          .sort((a: any, b: any) => a.name.localeCompare(b.name)),
      };
    }

    // ── assets/account_type (donut/pie) ─────────────────────────────────────
    if (metric === 'assets' && grouping === 'account_type') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           multiIf(
             lowerUTF8(account_name) LIKE '%cash%' OR lowerUTF8(account_name) LIKE '%bank%', 'Cash & Bank',
             lowerUTF8(account_name) LIKE '%receivable%', 'Accounts Receivable',
             lowerUTF8(account_name) LIKE '%inventory%', 'Inventory',
             lowerUTF8(account_name) LIKE '%prepaid%', 'Prepaid Expenses',
             lowerUTF8(account_name) LIKE '%deposit%', 'Deposits',
             lowerUTF8(account_name) LIKE '%equipment%' OR lowerUTF8(account_name) LIKE '%property%' OR lowerUTF8(account_name) LIKE '%vehicle%', 'Fixed Assets',
             lowerUTF8(account_name) LIKE '%depreciation%', 'Accumulated Depreciation',
             'Other Assets'
           ) AS name,
           round(sum(abs(line_amount)), 0) AS value
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${jTime}
           AND journal_date IS NOT NULL
           AND (lowerUTF8(account_name) LIKE '%cash%' OR lowerUTF8(account_name) LIKE '%bank%'
             OR lowerUTF8(account_name) LIKE '%receivable%'
             OR lowerUTF8(account_name) LIKE '%inventory%'
             OR lowerUTF8(account_name) LIKE '%prepaid%'
             OR lowerUTF8(account_name) LIKE '%deposit%'
             OR lowerUTF8(account_name) LIKE '%equipment%'
             OR lowerUTF8(account_name) LIKE '%property%'
             OR lowerUTF8(account_name) LIKE '%vehicle%'
             OR lowerUTF8(account_name) LIKE '%depreciation%')
         GROUP BY name HAVING value > 0
         ORDER BY value DESC LIMIT 12`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      return {
        data: (rows as any[]).map((r: any) => ({
          name: String(r.name),
          value: this.num(r.value),
        })),
      };
    }

    // ── liabilities/account_type (donut/pie) ─────────────────────────────────
    if (metric === 'liabilities' && grouping === 'account_type') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           multiIf(
             lowerUTF8(account_name) LIKE '%accounts payable%' OR lowerUTF8(account_name) LIKE '%trade creditor%', 'Accounts Payable',
             lowerUTF8(account_name) LIKE '%accrued%', 'Accrued Liabilities',
             lowerUTF8(account_name) LIKE '%loan%' OR lowerUTF8(account_name) LIKE '%mortgage%' OR lowerUTF8(account_name) LIKE '%debt%', 'Loans & Debt',
             lowerUTF8(account_name) LIKE '%gst%' OR lowerUTF8(account_name) LIKE '%vat%' OR lowerUTF8(account_name) LIKE '%tax payable%', 'Tax Liabilities',
             lowerUTF8(account_name) LIKE '%deferred%', 'Deferred Revenue',
             lowerUTF8(account_name) LIKE '%credit card%', 'Credit Cards',
             'Other Liabilities'
           ) AS name,
           round(sum(abs(line_amount)), 0) AS value
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${jTime}
           AND journal_date IS NOT NULL
           AND (lowerUTF8(account_name) LIKE '%payable%'
             OR lowerUTF8(account_name) LIKE '%accrued%'
             OR lowerUTF8(account_name) LIKE '%loan%'
             OR lowerUTF8(account_name) LIKE '%mortgage%'
             OR lowerUTF8(account_name) LIKE '%debt%'
             OR lowerUTF8(account_name) LIKE '%gst%'
             OR lowerUTF8(account_name) LIKE '%vat%'
             OR lowerUTF8(account_name) LIKE '%tax payable%'
             OR lowerUTF8(account_name) LIKE '%deferred%'
             OR lowerUTF8(account_name) LIKE '%credit card%')
         GROUP BY name HAVING value > 0
         ORDER BY value DESC LIMIT 12`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      return {
        data: (rows as any[]).map((r: any) => ({
          name: String(r.name),
          value: this.num(r.value),
        })),
      };
    }

    // ── accounts/account_type (treemap) — all accounts by GL category ───────
    if (metric === 'accounts' && grouping === 'account_type') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           multiIf(
             lowerUTF8(account_name) LIKE '%payroll%' OR lowerUTF8(account_name) LIKE '%salary%' OR lowerUTF8(account_name) LIKE '%salaries%' OR lowerUTF8(account_name) LIKE '%wages%', 'Payroll',
             lowerUTF8(account_name) LIKE '%receivable%' OR lowerUTF8(account_name) LIKE '%payable%', 'AR/AP',
             lowerUTF8(account_name) LIKE '%revenue%' OR lowerUTF8(account_name) LIKE '%income%' OR lowerUTF8(account_name) LIKE '%product sales%' OR lowerUTF8(account_name) LIKE '%consulting%', 'Revenue',
             lowerUTF8(account_name) LIKE '%cost of%' OR lowerUTF8(account_name) LIKE '%cogs%' OR lowerUTF8(account_name) LIKE '%direct labor%' OR lowerUTF8(account_name) LIKE '%freight%', 'Cost of Sales',
             lowerUTF8(account_name) LIKE '%cash%' OR lowerUTF8(account_name) LIKE '%bank%', 'Cash & Bank',
             lowerUTF8(account_name) LIKE '%equity%' OR lowerUTF8(account_name) LIKE '%retained%' OR lowerUTF8(account_name) LIKE '%capital%', 'Equity',
             lowerUTF8(account_name) LIKE '%loan%' OR lowerUTF8(account_name) LIKE '%mortgage%' OR lowerUTF8(account_name) LIKE '%debt%', 'Loans & Debt',
             lowerUTF8(account_name) LIKE '%depreciation%' OR lowerUTF8(account_name) LIKE '%amortiz%', 'Depreciation',
             'Operating Expenses'
           ) AS name,
           round(sum(abs(line_amount)), 0) AS value
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${jTime}
           AND journal_date IS NOT NULL AND account_name != ''
         GROUP BY name HAVING value > 0
         ORDER BY value DESC LIMIT 15`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      return {
        data: (rows as any[]).map((r: any) => ({
          name: String(r.name),
          value: this.num(r.value),
        })),
      };
    }

    // ── debits/account_type (bar) — top account types by debit volume ────────
    if (metric === 'debits' && grouping === 'account_type') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           multiIf(
             lowerUTF8(account_name) LIKE '%payroll%' OR lowerUTF8(account_name) LIKE '%salary%' OR lowerUTF8(account_name) LIKE '%salaries%' OR lowerUTF8(account_name) LIKE '%wages%', 'Payroll',
             lowerUTF8(account_name) LIKE '%cost of%' OR lowerUTF8(account_name) LIKE '%cogs%' OR lowerUTF8(account_name) LIKE '%direct labor%', 'Cost of Sales',
             lowerUTF8(account_name) LIKE '%receivable%' OR lowerUTF8(account_name) LIKE '%payable%', 'AR/AP',
             lowerUTF8(account_name) LIKE '%rent%' OR lowerUTF8(account_name) LIKE '%lease%', 'Rent & Facilities',
             lowerUTF8(account_name) LIKE '%marketing%' OR lowerUTF8(account_name) LIKE '%advertising%', 'Marketing',
             lowerUTF8(account_name) LIKE '%software%' OR lowerUTF8(account_name) LIKE '%subscription%', 'Software',
             lowerUTF8(account_name) LIKE '%travel%' OR lowerUTF8(account_name) LIKE '%entertainment%', 'Travel & Ent.',
             lowerUTF8(account_name) LIKE '%depreciation%' OR lowerUTF8(account_name) LIKE '%amortiz%', 'Depreciation',
             'Other'
           ) AS name,
           round(sum(line_amount), 0) AS value
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${jTime}
           AND line_amount > 0 AND journal_date IS NOT NULL AND account_name != ''
         GROUP BY name HAVING value > 0
         ORDER BY value DESC LIMIT 12`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      return {
        data: (rows as any[]).map((r: any) => ({
          name: String(r.name),
          value: this.num(r.value),
        })),
      };
    }

    // ── credits/account_type (bar) — top account types by credit volume ──────
    if (metric === 'credits' && grouping === 'account_type') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           multiIf(
             lowerUTF8(account_name) LIKE '%revenue%' OR lowerUTF8(account_name) LIKE '%income%' OR lowerUTF8(account_name) LIKE '%product sales%' OR lowerUTF8(account_name) LIKE '%consulting%', 'Revenue',
             lowerUTF8(account_name) LIKE '%receivable%', 'AR Collections',
             lowerUTF8(account_name) LIKE '%payable%', 'AP Settlements',
             lowerUTF8(account_name) LIKE '%loan%' OR lowerUTF8(account_name) LIKE '%credit%', 'Financing',
             lowerUTF8(account_name) LIKE '%equity%' OR lowerUTF8(account_name) LIKE '%retained%', 'Equity',
             lowerUTF8(account_name) LIKE '%cash%' OR lowerUTF8(account_name) LIKE '%bank%', 'Cash & Bank',
             'Other Credits'
           ) AS name,
           round(sum(abs(line_amount)), 0) AS value
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${jTime}
           AND line_amount < 0 AND journal_date IS NOT NULL AND account_name != ''
         GROUP BY name HAVING value > 0
         ORDER BY value DESC LIMIT 12`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      return {
        data: (rows as any[]).map((r: any) => ({
          name: String(r.name),
          value: this.num(r.value),
        })),
      };
    }

    // ── debits_credits/account (scatter) — per-account debit vs credit ───────
    if (metric === 'debits_credits' && grouping === 'account') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           coalesce(nullIf(account_name, ''), 'Unknown') AS name,
           round(sumIf(toFloat64(line_amount), line_amount > 0), 0) AS debits,
           round(sumIf(abs(toFloat64(line_amount)), line_amount < 0), 0) AS credits
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${jTime}
           AND journal_date IS NOT NULL AND account_name != ''
         GROUP BY name
         HAVING debits > 0 OR credits > 0
         ORDER BY debits DESC LIMIT 30`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      return {
        data: (rows as any[]).map((r: any) => ({
          name: String(r.name),
          x: this.num(r.debits),
          y: this.num(r.credits),
          debits: this.num(r.debits),
          credits: this.num(r.credits),
        })),
      };
    }

    // ── Dynamic SQL fallback — any unrecognized metric/grouping ──────────────
    // When no hardcoded handler matches, ask Ollama to write the ClickHouse SQL.
    {
      const dynamicSql = await this.generateDynamicMetricSql(
        metric,
        grouping,
        scope,
        range,
      );
      if (dynamicSql) {
        try {
          const data = await this.executeDynamicSql(dynamicSql, scope);
          return { data };
        } catch (err: any) {
          this.logger.warn(
            `[Agent:DynamicFallback] metric=${metric} grouping=${grouping} sql_error=${err.message}`,
          );
        }
      }
    }

    // Last-resort: revenue by month
    if (scope.externalOrgIds.length === 0) return { data: [] };
    const rows = await this.queryRows<any>(
      `SELECT
	         formatDateTime(toStartOfMonth(issued_at), '%m/%y') AS month,
	         toStartOfMonth(issued_at) AS month_start,
	         coalesce(sum(total_amount), 0) AS total_revenue
	       FROM ${this.analyticsDb}.fact_accounting_invoices
	       WHERE org_id IN ({externalOrgIds:Array(String)})
	        ${provider}
	        ${client}
	        ${time}
	        ${arFilter}
	        AND issued_at IS NOT NULL
	       GROUP BY month, month_start
	       ORDER BY month_start ASC
	       LIMIT 36`,
      {
        externalOrgIds: scope.externalOrgIds,
        ...providerParam,
        ...clientParam,
        ...entityParam,
      },
    );
    return {
      data: rows.map((r) => ({
        name: r.month as string,
        value: this.num(r.total_revenue),
      })),
    };
  }

  // ─── Main Agent Query Loop ────────────────────────────────────────────────

  async *query(
    organizationId: string,
    userId: string,
    role: MembershipRole,
    userQuery: string,
    sessionId?: string,
  ): AsyncGenerator<string> {
    const runStartedAt = Date.now();
    let queryText = userQuery;
    let spec = parseQuerySpec(queryText);

    // ── Session setup (first, so we can link the request) ──────────────────
    const existingSession = sessionId
      ? await this.prisma.agentChatSession.findFirst({
          where: { id: sessionId, organizationId, userId },
        })
      : null;
    const currentSession =
      existingSession ??
      (await this.prisma.agentChatSession.create({
        data: { organizationId, userId, title: userQuery.slice(0, 80) },
      }));

    // ── Audit trail setup ──────────────────────────────────────────────────
    const request = await this.prisma.agentDashboardRequest.create({
      data: {
        organizationId,
        requestedById: userId,
        agentSessionId: currentSession.id,
        prompt: userQuery,
        status: 'RUNNING',
      },
    });
    const run = await this.prisma.agentRun.create({
      data: {
        requestId: request.id,
        organizationId,
        status: 'RUNNING',
        startedAt: new Date(),
      },
    });
    const logEvent = async (
      eventType: string,
      payload?: Record<string, unknown>,
    ) => {
      try {
        await this.prisma.agentRunEvent.create({
          data: {
            runId: run.id,
            organizationId,
            eventType,
            ...(payload ? { payload: payload as Prisma.InputJsonValue } : {}),
          },
        });
      } catch {
        /* non-critical */
      }
    };

    await this.prisma.agentChatMessage.create({
      data: {
        sessionId: currentSession.id,
        organizationId,
        role: 'user',
        content: userQuery,
      },
    });

    try {
      // If the user answered a prior clarification with "1/2/3", map it to a scoped directive
      // and preserve the original query context (time windows, chart constraints, etc).
      const lastAssistant = await this.prisma.agentChatMessage.findFirst({
        where: {
          sessionId: currentSession.id,
          organizationId,
          role: 'assistant',
        },
        orderBy: { createdAt: 'desc' },
      });
      const selection = this.extractSelectedOptionFromPriorClarification(
        queryText,
        lastAssistant?.content ?? null,
      );
      if (selection) {
        const recentUsers = await this.prisma.agentChatMessage.findMany({
          where: {
            sessionId: currentSession.id,
            organizationId,
            role: 'user',
          },
          orderBy: { createdAt: 'desc' },
          take: 2,
        });
        const previousUserQuery =
          recentUsers.length >= 2 ? recentUsers[1]!.content : null;
        const base = previousUserQuery?.trim() ? previousUserQuery.trim() : '';
        const combined = base ? `${base}\n${selection}` : selection;
        queryText = combined;
        spec = parseQuerySpec(queryText);
      }

      // If the user clicked a clarification quick-action like "Use client: X" or "Use entity: Y",
      // preserve the original query (time window, chart constraints) by merging it in.
      // Also fire for short follow-up messages (e.g., "Compare revenue month by month") that
      // could be the final step of a multi-step client selection flow — the prior "Use client A/B:"
      // directives need to be merged in so the dashboard builder sees them.
      const isDirectiveMessage =
        /^\s*use\s+(client|entity)(?:\s+(?:a|b|1|2))?\s*:/i.test(queryText);
      const mightBeCompareFollowUp =
        !isDirectiveMessage &&
        !spec.wantsTopClients &&
        (/\b(compare|comparison)\b/i.test(queryText) ||
          (/\b(revenue|outstanding|overdue|dso|month|chart|bar|line)\b/i.test(
            queryText,
          ) &&
            queryText.trim().split(/\s+/).length <= 20));
      if (isDirectiveMessage || mightBeCompareFollowUp) {
        const recentUsers = await this.prisma.agentChatMessage.findMany({
          where: {
            sessionId: currentSession.id,
            organizationId,
            role: 'user',
          },
          orderBy: { createdAt: 'desc' },
          take: 40,
        });
        const prior = recentUsers
          .slice(1) // exclude current message
          .map((m) => String(m.content ?? '').trim())
          .filter(Boolean);

        // Collect the latest directives across the recent session history.
        // Important: don't stop scanning at the first non-directive user message.
        // Users often (a) answer "Use entity: ..." then (b) restate the question,
        // which would otherwise drop the entity directive and cause endless re-prompts.
        const priorDirectives: string[] = [];
        const baseCandidates: string[] = [];
        for (const t of prior) {
          if (/^\d+$/.test(t)) continue;
          if (/^\s*use\s+(client|entity)(?:\s+(?:a|b|1|2))?\s*:/i.test(t)) {
            priorDirectives.push(t);
            continue;
          }
          baseCandidates.push(t);
        }

        const normalize = (s: string) => s.trim().toLowerCase();
        const base = (() => {
          if (baseCandidates.length === 0) return null;
          const score = (s: string) => {
            const t = s.trim();
            if (!t) return -1e9;
            let sc = t.length;
            // Prefer "real questions" over single names / acknowledgements.
            if (/\?/.test(t)) sc += 30;
            if (
              /\b(last|past|since|between|from|compare|revenue|overdue|outstanding|collections|payment|days|invoice|client|entity|dashboard|chart|graph|table|bar|line)\b/i.test(
                t,
              )
            )
              sc += 60;
            if (/^\s*use\s+/i.test(t)) sc -= 200;
            if (t.split(/\s+/).length < 3) sc -= 40;
            return sc;
          };
          return baseCandidates.sort((a, b) => score(b) - score(a))[0] ?? null;
        })();

        // Merge directives while keeping only the *latest* directive per key.
        // This prevents loops where old "Use client A: ..." persists above the new pick.
        const mergeWithLatestDirectives = (lines: string[]): string[] => {
          const baseLines: string[] = [];
          const directivesByKey = new Map<string, string>();

          const directiveKey = (line: string): string | null => {
            const m = line.match(
              /^\s*use\s+(entity|client)(?:\s+(a|b|1|2))?\s*:/i,
            );
            if (!m) return null;
            const kind = (m[1] ?? '').toLowerCase();
            const slotRaw = (m[2] ?? '').toLowerCase();
            const slot =
              slotRaw === '1' ? 'a' : slotRaw === '2' ? 'b' : slotRaw || '';
            return `${kind}${slot ? `_${slot}` : ''}`;
          };

          for (const rawLine of lines) {
            const line = String(rawLine ?? '').trim();
            if (!line) continue;
            if (/^\d+$/.test(line)) continue;
            const key = directiveKey(line);
            if (key) {
              // Keep the first (most recent) directive we encounter for each key.
              if (!directivesByKey.has(key)) directivesByKey.set(key, line);
              continue;
            }
            // Keep only the most recent "base" query line (the first non-directive we see
            // when scanning from most-recent to oldest in the caller).
            if (baseLines.length === 0) baseLines.push(line);
          }

          // Emit: base, then directives in stable order, then any non-duplicate extra lines.
          const directiveOrder = [
            'entity',
            'client',
            'client_a',
            'client_b',
          ] as const;
          const orderedDirectives = directiveOrder
            .map((k) => directivesByKey.get(k))
            .filter(Boolean) as string[];

          const out: string[] = [];
          const seen = new Set<string>();
          const pushUniq = (l: string) => {
            const k = normalize(l);
            if (seen.has(k)) return;
            seen.add(k);
            out.push(l.trim());
          };

          for (const l of baseLines) pushUniq(l);
          for (const l of orderedDirectives) pushUniq(l);
          return out;
        };

        const merged = mergeWithLatestDirectives([
          // Scan from most-recent to oldest so mergeWithLatestDirectives sees the latest base.
          queryText.trim(),
          ...priorDirectives,
          ...(base ? [base] : []),
        ]);
        if (merged.length >= 2) {
          queryText = merged.join('\n');
          spec = parseQuerySpec(queryText);
        }
      }

      // ── Detect intent and gather context ──────────────────────────────────
      const activeDashboard = await this.getActiveSessionDashboard(
        currentSession.id,
        organizationId,
      );
      const intent = this.detectIntent(queryText, !!activeDashboard);
      const conversationHistory = await this.getConversationHistory(
        currentSession.id,
        organizationId,
      );

      yield this.chunk('intent', {
        intent,
        activeDashboardId: activeDashboard?.id ?? null,
        activeDashboardTitle: activeDashboard?.title ?? null,
      });

      // If the previous turn in this session ended by asking the user a
      // clarification (NEEDS_INPUT), this message is the ANSWER. Do not run the
      // hardcoded clarification gates again — otherwise an answer that echoes a
      // trigger word (e.g. "...ignore budget/plan...") loops forever.
      const priorRequest = await this.prisma.agentDashboardRequest.findFirst({
        where: {
          agentSessionId: currentSession.id,
          organizationId,
          id: { not: request.id },
        },
        orderBy: { createdAt: 'desc' },
        select: { status: true },
      });
      const wasAwaitingClarification = priorRequest?.status === 'NEEDS_INPUT';

      // Resolve the org scope once up front — needed both for the dataset probe
      // below and for live introspection later.
      const scope = await this.getOrgScope(organizationId, role);

      // Datasets like the EBPO sample org carry employees, regions, AR/AP, cash
      // flow and working-capital data. The hardcoded "missing-dataset" gates
      // (headcount/regional/working-capital) would wrongly refuse those, so probe
      // whether this org has the rich EBPO dataset and relax the gates if so.
      const hasEbpoDataset = await this.orgHasEbpoData(scope);

      // These hardcoded "missing-dataset" gates (budget/forecast/headcount/etc.)
      // are CREATE-oriented. On an EDIT the chart's subject is already
      // established, and the SQL-first editor's verify→repair loop is the honest
      // safety net (it keeps the original chart when a rewrite can't be
      // satisfied). Running the gates on edits only causes false positives
      // (e.g. renaming a chart to "Q3 Plan Review" trips the budget regex), so
      // skip them for edits — same policy getClarificationPrompt already uses.
      const unsupported =
        wasAwaitingClarification || intent === 'EDIT_DASHBOARD'
          ? null
          : this.detectUnsupportedOrAmbiguousAsk(queryText, hasEbpoDataset);
      if (unsupported) {
        await logEvent('NEEDS_INPUT', { reason: unsupported.reason });

        const questionText = [
          unsupported.question,
          '',
          ...unsupported.options.map((o, i) => `${i + 1}) ${o.label}`),
        ].join('\n');

        await this.prisma.agentChatMessage.create({
          data: {
            sessionId: currentSession.id,
            organizationId,
            role: 'assistant',
            content: questionText,
          },
        });

        await this.prisma.agentDashboardRequest.update({
          where: { id: request.id },
          data: { status: 'NEEDS_INPUT', completedAt: new Date() },
        });
        await this.prisma.agentRun.update({
          where: { id: run.id },
          data: {
            status: 'NEEDS_INPUT',
            completedAt: new Date(),
            latencyMs: Date.now() - runStartedAt,
          },
        });

        yield this.chunk(
          'clarify',
          unsupported as unknown as Record<string, unknown>,
        );
        yield this.chunk('done', {
          metrics: {
            sessionId: currentSession.id,
            intent,
            needsInput: true,
            reason: unsupported.reason,
          },
        });
        return;
      }

      // ── PHASE 1: Planning ──────────────────────────────────────────────
      yield this.chunk('status', {
        message:
          intent === 'EDIT_DASHBOARD'
            ? 'Analyzing your dashboard edit request...'
            : 'Analyzing your request and building execution plan...',
      });
      yield this.chunk('phase', {
        phase: 'planning',
        label:
          intent === 'EDIT_DASHBOARD'
            ? 'Dashboard Edit Planning'
            : 'Strategic Planning',
      });

      await logEvent('PLANNING_START', {
        query: queryText.slice(0, 200),
        intent,
      });

      // Fetch live data context so Ollama can make data-aware chart decisions.
      // (scope was already resolved above for the dataset probe.)
      const compareClients = this.extractCompareClients(queryText);

      // ── Client resolver (avoid wrong charts when user names a company) ─────
      if (intent !== 'EDIT_DASHBOARD') {
        // If the user asks about clients but did not scope to an entity, and multiple entities exist,
        // ask once. Mixing clients across entities is almost always wrong.
        if (
          !spec.entityFilter &&
          /\b(client|clients|customer|customers|contact|contacts)\b/i.test(
            queryText,
          ) &&
          scope.externalOrgIds.length > 1 &&
          !/\buse\s+entity\s*:/i.test(queryText)
        ) {
          const options = (
            await this.listEntitiesForScope(
              scope.tenantId,
              scope.connectionIds,
              spec.providerHint,
            )
          ).slice(0, 8);

          if (options.length >= 2) {
            const clarification: ClarificationPrompt = {
              reason: 'ENTITY_REQUIRED_FOR_CLIENTS',
              question: 'Which entity should I use for this client analysis?',
              options: options.map((o) => ({
                label: o.orgName,
                value: `Use entity: ${o.orgName}`,
              })),
            };

            await logEvent('NEEDS_INPUT', { reason: clarification.reason });

            const questionText = [
              clarification.question,
              '',
              ...clarification.options.map((o, i) => {
                const detail =
                  o.value && o.value !== o.label ? ` — ${o.value}` : '';
                return `${i + 1}) ${o.label}${detail}`;
              }),
            ].join('\n');

            await this.prisma.agentChatMessage.create({
              data: {
                sessionId: currentSession.id,
                organizationId,
                role: 'assistant',
                content: questionText,
              },
            });

            await this.prisma.agentDashboardRequest.update({
              where: { id: request.id },
              data: { status: 'NEEDS_INPUT', completedAt: new Date() },
            });
            await this.prisma.agentRun.update({
              where: { id: run.id },
              data: {
                status: 'NEEDS_INPUT',
                completedAt: new Date(),
                latencyMs: Date.now() - runStartedAt,
              },
            });

            yield this.chunk(
              'clarify',
              clarification as unknown as Record<string, unknown>,
            );
            yield this.chunk('done', {
              metrics: {
                sessionId: currentSession.id,
                intent,
                needsInput: true,
                reason: clarification.reason,
              },
            });
            return;
          }
        }

        const entityResolution = await this.resolveEntityFilter(
          queryText,
          scope,
          spec.providerHint,
        );
        if (entityResolution.status === 'ambiguous') {
          const clarification: ClarificationPrompt = {
            reason: 'ENTITY_AMBIGUOUS',
            question: `Which entity did you mean by "${entityResolution.mention}"?`,
            options: entityResolution.candidates.slice(0, 5).map((c) => ({
              label: c.orgName,
              value: `Use entity: ${c.orgName}`,
            })),
          };

          await logEvent('NEEDS_INPUT', { reason: clarification.reason });

          const questionText = [
            clarification.question,
            '',
            ...clarification.options.map((o, i) => `${i + 1}) ${o.label}`),
          ].join('\n');

          await this.prisma.agentChatMessage.create({
            data: {
              sessionId: currentSession.id,
              organizationId,
              role: 'assistant',
              content: questionText,
            },
          });

          await this.prisma.agentDashboardRequest.update({
            where: { id: request.id },
            data: { status: 'NEEDS_INPUT', completedAt: new Date() },
          });
          await this.prisma.agentRun.update({
            where: { id: run.id },
            data: {
              status: 'NEEDS_INPUT',
              completedAt: new Date(),
              latencyMs: Date.now() - runStartedAt,
            },
          });

          yield this.chunk(
            'clarify',
            clarification as unknown as Record<string, unknown>,
          );
          yield this.chunk('done', {
            metrics: {
              sessionId: currentSession.id,
              intent,
              needsInput: true,
              reason: clarification.reason,
            },
          });
          return;
        }
        if (entityResolution.status === 'resolved') {
          spec = {
            ...spec,
            entityFilter: {
              orgId: entityResolution.orgId,
              orgName: entityResolution.orgName,
              orgNameLower: entityResolution.orgNameLower,
            },
          };
        }

        // Enforce member scoping: non-admin users must pick exactly one entity.
        if (role !== 'ADMIN' && !spec.entityFilter) {
          const entities = await this.listEntitiesForScope(
            scope.tenantId,
            scope.connectionIds,
            spec.providerHint,
          );

          if (entities.length === 1) {
            spec = {
              ...spec,
              entityFilter: {
                orgId: entities[0]!.orgId,
                orgName: entities[0]!.orgName,
                orgNameLower: entities[0]!.orgName.toLowerCase(),
              },
            };
          } else if (entities.length > 1) {
            const clarification: ClarificationPrompt = {
              reason: 'ENTITY_REQUIRED',
              question:
                'Which entity should I use for this analysis? (Members are entity-scoped.)',
              options: entities.slice(0, 8).map((e) => ({
                label: e.orgName,
                // Use the human name in the quick-action so users don't see opaque ids.
                // resolveEntityFilter() can map this back to org_id deterministically via prisma.
                value: `Use entity: ${e.orgName}`,
              })),
            };

            await logEvent('NEEDS_INPUT', { reason: clarification.reason });

            const questionText = [
              clarification.question,
              '',
              ...clarification.options.map((o, i) => `${i + 1}) ${o.label}`),
            ].join('\n');

            await this.prisma.agentChatMessage.create({
              data: {
                sessionId: currentSession.id,
                organizationId,
                role: 'assistant',
                content: questionText,
              },
            });

            await this.prisma.agentDashboardRequest.update({
              where: { id: request.id },
              data: { status: 'NEEDS_INPUT', completedAt: new Date() },
            });
            await this.prisma.agentRun.update({
              where: { id: run.id },
              data: {
                status: 'NEEDS_INPUT',
                completedAt: new Date(),
                latencyMs: Date.now() - runStartedAt,
              },
            });

            yield this.chunk(
              'clarify',
              clarification as unknown as Record<string, unknown>,
            );
            yield this.chunk('done', {
              metrics: {
                sessionId: currentSession.id,
                intent,
                needsInput: true,
                reason: clarification.reason,
              },
            });
            return;
          }
        }

        // ── Compare 2 specific clients (interactive selection) ─────────────
        // If user asked to compare clients but didn't specify which 2, ask for them.
        const wantsCompareClients =
          /\bcompare\b/i.test(queryText) &&
          /\b(client|clients|customer|customers|contact|contacts)\b/i.test(
            queryText,
          ) &&
          !spec.wantsTopClients;

        if (wantsCompareClients) {
          const lines = queryText.split('\n').map((l) => l.trim());
          const directiveA =
            lines
              .map((l) =>
                l
                  .match(/^use\s+client\s+(?:a|1)\s*[:\-]\s*(.+)$/i)?.[1]
                  ?.trim(),
              )
              .filter(Boolean)
              .slice(-1)[0] ?? null;
          const directiveB =
            lines
              .map((l) =>
                l
                  .match(/^use\s+client\s+(?:b|2)\s*[:\-]\s*(.+)$/i)?.[1]
                  ?.trim(),
              )
              .filter(Boolean)
              .slice(-1)[0] ?? null;

          const inferred = this.extractCompareClients(queryText);
          // If the user explicitly chose B (but not A), don't treat it as A.
          const clientA =
            directiveA ?? (directiveB ? null : (inferred?.[0] ?? null));
          const clientB = directiveB ?? inferred?.[1] ?? null;

          const hasA = Boolean(clientA);
          const hasB = Boolean(clientB);

          // If they want to compare clients but didn't specify *what* to compare,
          // ask once to avoid guessing (and generating irrelevant charts).
          const hasCompareMetricSignal =
            /\b(revenue|sales|invoiced|billed|paid|collected|outstanding|overdue|aging|ar\b|dso|payment|days\s+to\s+pay|payment\s+days)\b/i.test(
              queryText,
            );
          if (hasA && hasB && !hasCompareMetricSignal) {
            const clarification: ClarificationPrompt = {
              reason: 'COMPARE_CLIENT_METRIC_REQUIRED',
              question: 'What should I compare between these clients?',
              options: [
                {
                  label: 'Revenue (monthly)',
                  value: 'Compare revenue month by month in a bar chart.',
                },
                {
                  label: 'Outstanding vs overdue (monthly)',
                  value:
                    'Compare outstanding and overdue month by month in a bar chart.',
                },
                {
                  label: 'Payment speed (DSO, monthly)',
                  value:
                    'Compare average days-to-pay by month in a line chart.',
                },
              ],
            };

            await logEvent('NEEDS_INPUT', { reason: clarification.reason });
            const questionText = [
              clarification.question,
              '',
              ...clarification.options.map((o, i) => `${i + 1}) ${o.label}`),
            ].join('\n');

            await this.prisma.agentChatMessage.create({
              data: {
                sessionId: currentSession.id,
                organizationId,
                role: 'assistant',
                content: questionText,
              },
            });

            await this.prisma.agentDashboardRequest.update({
              where: { id: request.id },
              data: { status: 'NEEDS_INPUT', completedAt: new Date() },
            });
            await this.prisma.agentRun.update({
              where: { id: run.id },
              data: {
                status: 'NEEDS_INPUT',
                completedAt: new Date(),
                latencyMs: Date.now() - runStartedAt,
              },
            });

            yield this.chunk(
              'clarify',
              clarification as unknown as Record<string, unknown>,
            );
            yield this.chunk('done', {
              metrics: {
                sessionId: currentSession.id,
                intent,
                needsInput: true,
                reason: clarification.reason,
              },
            });
            return;
          }

          // We require entity scoping for client comparisons.
          const scopeForPick: OrgScope =
            spec.entityFilter?.orgId &&
            scope.externalOrgIds.includes(spec.entityFilter.orgId)
              ? {
                  tenantId: scope.tenantId,
                  connectionIds: scope.connectionIds,
                  externalOrgIds: [spec.entityFilter.orgId],
                }
              : scope;

          if (scopeForPick.externalOrgIds.length > 0 && (!hasA || !hasB)) {
            const rows = await this.queryRows<any>(
              `SELECT
                 coalesce(nullIf(client_name, ''), '') AS client_name,
                 sum(total_invoiced) AS total_invoiced
               FROM ${this.analyticsDb}.v_dim_clients_latest
               WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})
                 AND client_name != ''
               GROUP BY client_name
               ORDER BY total_invoiced DESC
               LIMIT 25`,
              {
                tenantId: scopeForPick.tenantId,
                externalOrgIds: scopeForPick.externalOrgIds,
              },
            );
            const clients = rows
              .map((r) => String(r.client_name ?? '').trim())
              .filter(Boolean)
              .slice(0, 20);

            if (clients.length >= 2) {
              if (!hasA) {
                const clarification: ClarificationPrompt = {
                  reason: 'COMPARE_CLIENT_PICK_A',
                  question:
                    'Pick the first client to compare (or type a name):',
                  options: clients.slice(0, 6).map((name) => ({
                    label: name,
                    value: `Use client A: ${name}`,
                  })),
                };
                await logEvent('NEEDS_INPUT', { reason: clarification.reason });

                const questionText = [
                  clarification.question,
                  '',
                  ...clarification.options.map(
                    (o, i) => `${i + 1}) ${o.label}`,
                  ),
                ].join('\n');

                await this.prisma.agentChatMessage.create({
                  data: {
                    sessionId: currentSession.id,
                    organizationId,
                    role: 'assistant',
                    content: questionText,
                  },
                });

                await this.prisma.agentDashboardRequest.update({
                  where: { id: request.id },
                  data: { status: 'NEEDS_INPUT', completedAt: new Date() },
                });
                await this.prisma.agentRun.update({
                  where: { id: run.id },
                  data: {
                    status: 'NEEDS_INPUT',
                    completedAt: new Date(),
                    latencyMs: Date.now() - runStartedAt,
                  },
                });

                yield this.chunk(
                  'clarify',
                  clarification as unknown as Record<string, unknown>,
                );
                yield this.chunk('done', {
                  metrics: {
                    sessionId: currentSession.id,
                    intent,
                    needsInput: true,
                    reason: clarification.reason,
                  },
                });
                return;
              }

              if (hasA && !hasB) {
                const a = String(clientA ?? '').trim();
                const options = clients.filter(
                  (c) => c.toLowerCase() !== a.toLowerCase(),
                );
                const clarification: ClarificationPrompt = {
                  reason: 'COMPARE_CLIENT_PICK_B',
                  question:
                    'Pick the second client to compare (or type a name):',
                  options: options.slice(0, 6).map((name) => ({
                    label: name,
                    value: `Use client B: ${name}`,
                  })),
                };
                await logEvent('NEEDS_INPUT', { reason: clarification.reason });

                const questionText = [
                  clarification.question,
                  '',
                  ...clarification.options.map(
                    (o, i) => `${i + 1}) ${o.label}`,
                  ),
                ].join('\n');

                await this.prisma.agentChatMessage.create({
                  data: {
                    sessionId: currentSession.id,
                    organizationId,
                    role: 'assistant',
                    content: questionText,
                  },
                });

                await this.prisma.agentDashboardRequest.update({
                  where: { id: request.id },
                  data: { status: 'NEEDS_INPUT', completedAt: new Date() },
                });
                await this.prisma.agentRun.update({
                  where: { id: run.id },
                  data: {
                    status: 'NEEDS_INPUT',
                    completedAt: new Date(),
                    latencyMs: Date.now() - runStartedAt,
                  },
                });

                yield this.chunk(
                  'clarify',
                  clarification as unknown as Record<string, unknown>,
                );
                yield this.chunk('done', {
                  metrics: {
                    sessionId: currentSession.id,
                    intent,
                    needsInput: true,
                    reason: clarification.reason,
                  },
                });
                return;
              }
            }
          }
        }

        // Do NOT force a single-client selection when the user is asking to compare
        // top-N clients (or multiple clients). In those cases the dashboard should
        // include a client breakdown, not a client filter.
        const clientMention = this.extractClientMention(queryText);
        const mentionsClientWords = /\b(client|customer|contact)\b/i.test(
          queryText,
        );
        const entityNameNorm = spec.entityFilter?.orgName
          ? this.normalizeEntityName(spec.entityFilter.orgName)
          : null;
        const clientMentionNorm = clientMention
          ? this.normalizeEntityName(clientMention)
          : null;

        const shouldResolveSingleClient =
          !!clientMention &&
          !spec.wantsTopClients &&
          !/\bcompare\b/i.test(queryText) &&
          !/\btop\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:clients|customers|contacts)\b/i.test(
            queryText,
          ) &&
          // If we already resolved an entity and the "client mention" is identical to the entity name
          // (common: "do this for <entity>"), don't force a client selection.
          !(
            !mentionsClientWords &&
            entityNameNorm &&
            clientMentionNorm &&
            entityNameNorm === clientMentionNorm
          );

        const scopeForClient: OrgScope =
          spec.entityFilter?.orgId &&
          scope.externalOrgIds.includes(spec.entityFilter.orgId)
            ? {
                tenantId: scope.tenantId,
                connectionIds: scope.connectionIds,
                externalOrgIds: [spec.entityFilter.orgId],
              }
            : scope;

        const clientResolution = shouldResolveSingleClient
          ? await this.resolveClientFilter(queryText, scopeForClient)
          : ({ status: 'none' } as ClientResolution);
        if (clientResolution.status === 'ambiguous') {
          const clarification: ClarificationPrompt = {
            reason: 'CLIENT_AMBIGUOUS',
            question: `Which client did you mean by "${clientResolution.mention}"?`,
            options: clientResolution.candidates.slice(0, 5).map((c) => ({
              label: c.clientName,
              value: `Use client: ${c.clientName}`,
            })),
          };

          await logEvent('NEEDS_INPUT', { reason: clarification.reason });

          const questionText = [
            clarification.question,
            '',
            ...clarification.options.map((o, i) => `${i + 1}) ${o.label}`),
          ].join('\n');

          await this.prisma.agentChatMessage.create({
            data: {
              sessionId: currentSession.id,
              organizationId,
              role: 'assistant',
              content: questionText,
            },
          });

          await this.prisma.agentDashboardRequest.update({
            where: { id: request.id },
            data: { status: 'NEEDS_INPUT', completedAt: new Date() },
          });
          await this.prisma.agentRun.update({
            where: { id: run.id },
            data: {
              status: 'NEEDS_INPUT',
              completedAt: new Date(),
              latencyMs: Date.now() - runStartedAt,
            },
          });

          yield this.chunk(
            'clarify',
            clarification as unknown as Record<string, unknown>,
          );
          yield this.chunk('done', {
            metrics: {
              sessionId: currentSession.id,
              intent,
              needsInput: true,
              reason: clarification.reason,
            },
          });
          return;
        }
        if (clientResolution.status === 'resolved') {
          spec = {
            ...spec,
            clientFilter: {
              name: clientResolution.clientName,
              nameLower: clientResolution.clientNameLower,
            },
          };
        }
      }

      const dataContext = await this.getDataContext(
        organizationId,
        scope,
        spec.timeRange,
        spec.clientFilter ?? undefined,
        spec.entityFilter ?? undefined,
      );

      // ── HYBRID MODE: Ask 1 question only when ambiguity blocks correctness ──
      // Skip when the user is answering a prior clarification (avoid re-asking).
      const clarification = wasAwaitingClarification
        ? null
        : this.getClarificationPrompt(queryText, intent);
      if (clarification) {
        await logEvent('NEEDS_INPUT', { reason: clarification.reason });

        const questionText = [
          clarification.question,
          '',
          ...clarification.options.map((o, i) => `${i + 1}) ${o.label}`),
        ].join('\n');

        await this.prisma.agentChatMessage.create({
          data: {
            sessionId: currentSession.id,
            organizationId,
            role: 'assistant',
            content: questionText,
          },
        });

        await this.prisma.agentDashboardRequest.update({
          where: { id: request.id },
          data: { status: 'NEEDS_INPUT', completedAt: new Date() },
        });
        await this.prisma.agentRun.update({
          where: { id: run.id },
          data: {
            status: 'NEEDS_INPUT',
            completedAt: new Date(),
            latencyMs: Date.now() - runStartedAt,
          },
        });

        yield this.chunk(
          'clarify',
          clarification as unknown as Record<string, unknown>,
        );
        yield this.chunk('done', {
          metrics: {
            sessionId: currentSession.id,
            intent,
            needsInput: true,
            reason: clarification.reason,
          },
        });
        return;
      }

      // Generate plans in parallel when editing (need both a tool plan and an edit diff)
      let plan: AgentPlan;
      let editPlan: DashboardEditPlan | null = null;

      if (intent === 'EDIT_DASHBOARD' && activeDashboard) {
        // The edit itself comes from generateEditPlan. The legacy generatePlan used to
        // run here too, only to supply tools_to_execute (data for the brief); we now
        // derive those tools from the existing dashboard's widgets — the same helper the
        // modern create path uses — so the edit path no longer depends on the legacy
        // planner. (We're editing, not creating, so should_generate_dashboard=false.)
        editPlan = await this.generateEditPlan(
          activeDashboard,
          queryText,
          scope,
          spec.timeRange,
          conversationHistory,
        );
        const editTools = this.deriveToolsFromWidgets(
          activeDashboard.widgets.map((w) => ({
            type: (w.chartType || 'bar') as ChartType,
            metric: String((w.queryConfig as any)?.metric ?? 'dynamic'),
            grouping: String((w.queryConfig as any)?.grouping ?? 'dynamic'),
          })),
          queryText,
        );
        plan = {
          tools_to_execute: editTools,
          should_generate_dashboard: false,
          dashboard: { title: '', description: '', widgets: [] },
          analysis_focus: queryText,
        };
      } else {
        // ── PRIMARY: SQL-first structured planner ───────────────────────────
        // Returns build / clarify / no_data — never a guessed chart. Only when
        // the planner is unavailable (null) do we fall back to the vocabulary
        // planner.
        const smartResult: SmartPlanResult | null =
          scope.externalOrgIds.length > 0
            ? await this.generateSmartPlan(
                queryText,
                scope,
                spec.timeRange,
                conversationHistory,
              )
            : null;

        // The planner asked a focused question — surface it and stop.
        if (smartResult?.kind === 'clarify') {
          const clr = smartResult.clarification;
          await logEvent('NEEDS_INPUT', { reason: clr.reason });

          const questionText = [
            clr.question,
            '',
            ...clr.options.map((o, i) => `${i + 1}) ${o.label}`),
          ].join('\n');

          await this.prisma.agentChatMessage.create({
            data: {
              sessionId: currentSession.id,
              organizationId,
              role: 'assistant',
              content: questionText,
            },
          });
          await this.prisma.agentDashboardRequest.update({
            where: { id: request.id },
            data: { status: 'NEEDS_INPUT', completedAt: new Date() },
          });
          await this.prisma.agentRun.update({
            where: { id: run.id },
            data: {
              status: 'NEEDS_INPUT',
              completedAt: new Date(),
              latencyMs: Date.now() - runStartedAt,
            },
          });

          yield this.chunk(
            'clarify',
            clr as unknown as Record<string, unknown>,
          );
          yield this.chunk('done', {
            metrics: {
              sessionId: currentSession.id,
              intent,
              needsInput: true,
              reason: clr.reason,
            },
          });
          return;
        }

        // The data genuinely is not available — say so honestly, build nothing.
        // BUT: first try the vocabulary planner as a safety net. The smart SQL
        // planner can hallucinate "no_data" for questions the vocabulary planner
        // CAN answer (e.g. class breakdown, scatter for dept stats). If the
        // vocabulary planner produces a non-empty dashboard for this query, use
        // it instead of surfacing the incorrect "no data" message.
        if (smartResult?.kind === 'no_data') {
          // The spec/catalog path could not model this and the data genuinely is not
          // available → surface it honestly, build nothing. (The legacy vocab/metricData
          // rescue was validated redundant — 0 rescues across 52 representative questions,
          // incl. the documented legacy-only cases — and has been removed.)
          await logEvent('NO_DATA', {
            message: smartResult.message.slice(0, 200),
          });
          await this.prisma.agentChatMessage.create({
            data: {
              sessionId: currentSession.id,
              organizationId,
              role: 'assistant',
              content: smartResult.message,
            },
          });
          await this.prisma.agentDashboardRequest.update({
            where: { id: request.id },
            data: { status: 'SUCCEEDED', completedAt: new Date() },
          });
          await this.prisma.agentRun.update({
            where: { id: run.id },
            data: {
              status: 'SUCCEEDED',
              completedAt: new Date(),
              latencyMs: Date.now() - runStartedAt,
            },
          });
          for (const part of this.chunkText(smartResult.message, 24)) {
            yield this.chunk('token', { content: part });
          }
          yield this.chunk('done', {
            metrics: {
              sessionId: currentSession.id,
              intent,
              noData: true,
            },
          });
          return;
        }

        if (smartResult?.kind === 'build') {
          plan = smartResult.plan;
        } else {
          // Planner unavailable (LLM offline, or it failed to return a usable plan).
          // Product decision (AGENT_ARCHITECTURE.md → offline mode): surface an honest
          // "temporarily unavailable" rather than the legacy deterministic planner,
          // whose output is GL-only and can be subtly wrong — worse than an honest
          // retry for a finance tool. Previously-seen questions are already served
          // correctly by the plan cache (which runs BEFORE the LLM ping), so this only
          // affects genuinely-new questions during an outage.
          const offlineMsg =
            'Analysis is temporarily unavailable — the AI service could not be reached. Your data is unaffected; please try again in a moment.';
          this.logger.warn(
            `[planner] served=offline-error query=${JSON.stringify(queryText.slice(0, 80))}`,
          );
          await logEvent('LLM_UNAVAILABLE', { query: queryText.slice(0, 100) });
          await this.prisma.agentChatMessage.create({
            data: {
              sessionId: currentSession.id,
              organizationId,
              role: 'assistant',
              content: offlineMsg,
            },
          });
          await this.prisma.agentDashboardRequest.update({
            where: { id: request.id },
            data: { status: 'FAILED', completedAt: new Date() },
          });
          await this.prisma.agentRun.update({
            where: { id: run.id },
            data: {
              status: 'FAILED',
              completedAt: new Date(),
              latencyMs: Date.now() - runStartedAt,
            },
          });
          for (const part of this.chunkText(offlineMsg, 24)) {
            yield this.chunk('token', { content: part });
          }
          yield this.chunk('done', {
            metrics: {
              sessionId: currentSession.id,
              intent,
              unavailable: true,
            },
          });
          return;
        }
      }

      await logEvent('PLAN_GENERATED', {
        tools: plan.tools_to_execute,
        intent,
        hasEditPlan: !!editPlan,
      });

      for (const tool of plan.tools_to_execute) {
        yield this.chunk('tool_call', { tool, label: this.toolLabel(tool) });
      }

      // ── PHASE 2: Tool Execution ────────────────────────────────────────
      yield this.chunk('phase', {
        phase: 'execution',
        label: 'Gathering Financial Intelligence',
      });
      yield this.chunk('status', {
        message: `Executing ${plan.tools_to_execute.length} data queries in parallel...`,
      });

      const toolResults = await this.executeTools(
        plan.tools_to_execute,
        scope,
        spec,
      );

      for (const result of toolResults) {
        await logEvent('TOOL_EXECUTED', {
          tool: result.tool,
          rowCount: result.rowCount,
        });
        yield this.chunk('tool_result', {
          tool: result.tool,
          label: this.toolLabel(result.tool),
          rowCount: result.rowCount,
          preview: this.buildToolPreview(result),
        });
      }

      // ── PHASE 3: Dashboard Create or Edit ────────────────────────────
      let dashboardId: string | null = null;
      let dashboardTitle = '';
      let actualWidgetCount = 0;
      let chartTurnMetadata: ChartTurnMetadata | null = null;

      if (intent === 'EDIT_DASHBOARD' && activeDashboard && editPlan?.refusal) {
        // Layer D: the follow-up can't be satisfied from the data — say so
        // clearly and leave the existing dashboard untouched (no silent no-op).
        await logEvent('EDIT_REFUSED', {
          reason: editPlan.refusal.slice(0, 120),
        });
        await this.prisma.agentChatMessage.create({
          data: {
            sessionId: currentSession.id,
            organizationId,
            role: 'assistant',
            content: editPlan.refusal,
          },
        });
        await this.prisma.agentDashboardRequest.update({
          where: { id: request.id },
          data: { status: 'SUCCEEDED', completedAt: new Date() },
        });
        await this.prisma.agentRun.update({
          where: { id: run.id },
          data: {
            status: 'SUCCEEDED',
            completedAt: new Date(),
            latencyMs: Date.now() - runStartedAt,
          },
        });
        for (const part of this.chunkText(editPlan.refusal, 24)) {
          yield this.chunk('token', { content: part });
        }
        yield this.chunk('done', {
          metrics: { sessionId: currentSession.id, intent, refused: true },
        });
        return;
      }

      if (intent === 'EDIT_DASHBOARD' && activeDashboard && editPlan) {
        yield this.chunk('phase', {
          phase: 'dashboard',
          label: 'Applying Dashboard Changes',
        });
        yield this.chunk('status', { message: 'Updating your dashboard...' });

        try {
          const updated = await this.applyDashboardEdit(
            activeDashboard.id,
            editPlan,
            organizationId,
            spec,
          );
          dashboardId = updated.id;
          dashboardTitle = updated.title;
          actualWidgetCount = updated.widgetCount;
          const widgetSnapshots = await this.buildChartTurnWidgetSnapshots(
            organizationId,
            role,
            updated.widgets,
          );
          const versionNumber = await this.nextChartTurnVersion(
            currentSession.id,
            organizationId,
          );
          chartTurnMetadata = {
            kind: 'chart_turn',
            mode: 'edit',
            versionNumber,
            previousVersionNumber: versionNumber > 1 ? versionNumber - 1 : null,
            sessionId: currentSession.id,
            dashboardId,
            dashboardTitle,
            widgetCount: actualWidgetCount,
            prompt: queryText,
            summary: this.describeChartTurnSummary({
              mode: 'edit',
              dashboardTitle,
              widgetSnapshots,
              rawSummary: editPlan.summary,
            }),
            widgetSnapshots,
            intent,
          };

          await logEvent('DASHBOARD_UPDATED', {
            dashboardId,
            summary: editPlan.summary,
            versionNumber: (chartTurnMetadata as ChartTurnMetadata).versionNumber,
          });
          yield this.chunk('dashboard_updated', {
            dashboardId,
            title: updated.title,
            summary: editPlan.summary,
            widgetCount: updated.widgetCount,
            chartTurn: chartTurnMetadata as ChartTurnMetadata,
          });
          yield this.chunk('system', { action: 'DASHBOARD_REFRESH' });
        } catch (editErr: any) {
          this.logger.warn(
            `[Agent:Edit] Edit failed — ${editErr.message}. Falling back to create.`,
          );
          // Fall through and let synthesis continue without dashboard update
        }
      } else if (plan.should_generate_dashboard) {
        yield this.chunk('phase', {
          phase: 'dashboard',
          label: 'Designing Your Dashboard',
        });
        yield this.chunk('status', {
          message: 'Generating intelligent dashboard layout...',
        });

        try {
          const finalDashboardTitle = this.normalizeDashboardTitle(
            plan.dashboard.title,
            queryText,
          );
          const dashboard = await this.prisma.dashboard.create({
            data: {
              organizationId,
              ownerId: userId,
              title: finalDashboardTitle,
              description:
                plan.dashboard.description ||
                'AI-generated strategic intelligence dashboard',
              config: {
                source: 'agent',
                query: queryText,
                model: this.OLLAMA_MODEL,
              } as Prisma.InputJsonValue,
              permissions: { shared: false } as Prisma.InputJsonValue,
            },
          });
          dashboardId = dashboard.id;
          dashboardTitle = dashboard.title;

          const widgets = this.applyPieDonutLabelModeToWidgets(
            plan.dashboard.widgets.length > 0
              ? plan.dashboard.widgets
              : this.queryAwareFallbackWidgets(queryText),
            queryText,
          );

          const compareClients = this.extractCompareClients(queryText);
          const hasExplicitClientPairDirective =
            /\buse\s+clients?\s*:/i.test(queryText) ||
            /\buse\s+client\s+(?:a|b|1|2)\s*:/i.test(queryText);
          const shouldUseCompareClients =
            Array.isArray(compareClients) &&
            compareClients.length >= 2 &&
            // If the user explicitly picked A/B (or provided "use clients:"), always honor it,
            // even if the original question mentioned "top N".
            (hasExplicitClientPairDirective ||
              (/\bcompare\b/i.test(queryText) &&
                /\b(client|clients|customer|customers|contact|contacts)\b/i.test(
                  queryText,
                ) &&
                !spec.wantsTopClients));

          // For any dynamic widgets, generate SQL now (before createMany)
          const scope = await this.getOrgScope(
            organizationId,
            role,
            spec.entityFilter?.orgId,
          );
          const widgetDataList = await Promise.all(
            widgets.map(async (w) => {
              const wantsClientPair =
                shouldUseCompareClients &&
                Array.isArray(compareClients) &&
                compareClients.length >= 2;

              const applyClientPair =
                wantsClientPair &&
                (() => {
                  if (w.grouping === 'client') return true;
                  if (w.grouping !== 'month') return false;
                  return ['revenue', 'overdue', 'outstanding', 'dso'].includes(
                    String(w.metric ?? '').toLowerCase(),
                  );
                })();

              const clientBreakdownMetrics = [
                'revenue',
                'overdue',
                'outstanding',
                'dso',
                'paid',
              ];
              const breakdown =
                w.grouping === 'month' &&
                clientBreakdownMetrics.includes(
                  String(w.metric ?? '').toLowerCase(),
                ) &&
                (wantsClientPair || spec.wantsTopClients)
                  ? 'client'
                  : ((w as any)?.breakdown ?? null);

              // Smart plan widgets carry pre-generated SQL (_sql field).
              // Fallback: if metric=dynamic but no _sql, generate SQL now.
              let dynamicSql: string | null = (w as any)._sql ?? null;
              if (!dynamicSql && w.metric === 'dynamic') {
                const intent = (w as any)._dynamicIntent ?? `${w.title} chart`;
                dynamicSql = await this.generateDynamicSql(
                  intent,
                  w.title,
                  scope,
                  spec.timeRange,
                ).catch(() => null);
              }

              // Widgets from the smart SQL planner always use metric='dynamic'.
              const effectiveMetric = dynamicSql ? 'dynamic' : w.metric;
              const effectiveGrouping = dynamicSql ? 'query' : w.grouping;

              return {
                organizationId,
                dashboardId: dashboard.id,
                title: w.title,
                chartType: w.type,
                queryConfig: {
                  metric: effectiveMetric,
                  grouping: effectiveGrouping,
                  timeRange: spec.timeRange ?? null,
                  providerHint: spec.providerHint ?? null,
                  clientName: spec.clientFilter?.name ?? null,
                  clientNames: applyClientPair ? compareClients : null,
                  orgId: spec.entityFilter?.orgId ?? null,
                  orgName: spec.entityFilter?.orgName ?? null,
                  breakdown: dynamicSql ? null : breakdown,
                  display: (w as any)?.display ?? null,
                  topN: dynamicSql
                    ? null
                    : applyClientPair
                      ? null
                      : breakdown === 'client' && spec.wantsTopClients
                        ? typeof (w as any)?.topN === 'number'
                          ? (w as any).topN
                          : (spec.topN ?? 2)
                        : ((w as any)?.topN ?? null),
                  ...(dynamicSql ? { dynamicSql } : {}),
                  // Phase 3: persist the ChartSpec so a follow-up is a delta on it.
                  ...((w as any)?._spec ? { spec: (w as any)._spec } : {}),
                  ...((w as any)?.xAxisLabel
                    ? { xAxisLabel: (w as any).xAxisLabel }
                    : {}),
                  ...((w as any)?.yAxisLabel
                    ? { yAxisLabel: (w as any).yAxisLabel }
                    : {}),
                } as Prisma.InputJsonValue,
                chartConfig: {
                  description: w.description,
                } as Prisma.InputJsonValue,
                displayOrder: w.display_order,
              };
            }),
          );

          await this.prisma.dashboardWidget.createMany({
            data: widgetDataList,
          });

          const persistedWidgets = await this.prisma.dashboardWidget.findMany({
            where: { dashboardId: dashboard.id },
            orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
          });
          const widgetSnapshots = await this.buildChartTurnWidgetSnapshots(
            organizationId,
            role,
            persistedWidgets.map((w) => ({
              id: w.id,
              title: w.title,
              chartType: w.chartType,
              queryConfig: w.queryConfig as Record<string, unknown>,
              chartConfig: w.chartConfig as Record<string, unknown>,
              displayOrder: w.displayOrder,
            })),
          );
          const versionNumber = await this.nextChartTurnVersion(
            currentSession.id,
            organizationId,
          );
          chartTurnMetadata = {
            kind: 'chart_turn',
            mode: 'create',
            versionNumber,
            previousVersionNumber: null,
            sessionId: currentSession.id,
            dashboardId: dashboard.id,
            dashboardTitle: dashboard.title,
            widgetCount: widgetSnapshots.length,
            prompt: queryText,
            summary: this.describeChartTurnSummary({
              mode: 'create',
              dashboardTitle: dashboard.title,
              widgetSnapshots,
              rawSummary: plan.dashboard.description || 'Dashboard generated',
            }),
            widgetSnapshots,
            intent,
          };

          // Link request to the generated dashboard
          await this.prisma.agentDashboardRequest.update({
            where: { id: request.id },
            data: { generatedDashboardId: dashboard.id },
          });

          actualWidgetCount = widgets.length;
          await logEvent('DASHBOARD_CREATED', {
            dashboardId,
            widgetCount: widgets.length,
            versionNumber: (chartTurnMetadata as ChartTurnMetadata).versionNumber,
          });
          yield this.chunk('dashboard_created', {
            dashboardId,
            title: dashboard.title,
            description: plan.dashboard.description,
            widgetCount: widgets.length,
            chartTurn: chartTurnMetadata as ChartTurnMetadata,
          });
          yield this.chunk('system', { action: 'DASHBOARD_REFRESH' });
        } catch (permErr: any) {
          this.logger.warn(
            `[Agent:Dashboard] Creation failed: ${permErr.message}`,
          );
          yield this.chunk('dashboard_skipped', {
            reason: permErr.message?.includes('permission')
              ? 'Dashboard creation requires elevated permissions. Contact your admin.'
              : 'Dashboard generation encountered an issue.',
          });
        }
      }

      // ── PHASE 4: Synthesis Streaming ──────────────────────────────────
      yield this.chunk('phase', {
        phase: 'synthesis',
        label: 'Synthesizing Intelligence Brief',
      });
      yield this.chunk('status', {
        message: 'Composing your financial intelligence brief...',
      });

      // Brief is composed deterministically (no LLM hop → no hallucination). The
      // SYNTHESIZER_SYSTEM prompt remains in agent-prompts.ts for a future opt-in
      // "LLM rewrite" mode; the dead message-builder wiring was removed.
      const fullResponse = this.composeDeterministicBrief(
        spec,
        toolResults,
        plan,
        {
          intent,
          dashboardTitle,
          widgetCount: actualWidgetCount,
          editSummary: chartTurnMetadata?.summary ?? editPlan?.summary ?? null,
        },
      );

      let tokenCount = 0;
      for (const part of this.chunkText(fullResponse, 24)) {
        yield this.chunk('token', { content: part });
        tokenCount++;
      }

      // ── Persist and complete ───────────────────────────────────────────
      await this.prisma.agentChatMessage.create({
        data: {
          sessionId: currentSession.id,
          organizationId,
          role: 'assistant',
          content: fullResponse.trim() || 'Analysis complete.',
          ...(chartTurnMetadata
            ? { metadata: chartTurnMetadata as Prisma.InputJsonValue }
            : {}),
        },
      });

      await this.prisma.agentDashboardRequest.update({
        where: { id: request.id },
        data: { status: 'SUCCEEDED', completedAt: new Date() },
      });
      await this.prisma.agentRun.update({
        where: { id: run.id },
        data: {
          status: 'SUCCEEDED',
          completedAt: new Date(),
          latencyMs: Date.now() - runStartedAt,
        },
      });

      await logEvent('SYNTHESIS_COMPLETE', {
        tokens: tokenCount,
        dashboardId,
        intent,
      });

      yield this.chunk('done', {
        metrics: {
          sessionId: currentSession.id,
          mode: 'agent',
          totalMs: Date.now() - runStartedAt,
          tokens: tokenCount,
          runId: run.id,
          requestId: request.id,
          dashboardId,
          toolsExecuted: plan.tools_to_execute.length,
          model: 'deterministic',
          intent,
        },
      });
    } catch (error: any) {
      const message =
        error instanceof Error ? error.message : 'Agent failed unexpectedly.';
      this.logger.error(`[Agent:Fatal] ${message}`);

      await this.prisma.agentDashboardRequest
        .update({
          where: { id: request.id },
          data: {
            status: 'FAILED',
            errorCode: 'AGENT_QUERY_FAILED',
            errorMessage: message,
            completedAt: new Date(),
          },
        })
        .catch(() => {});
      await this.prisma.agentRun
        .update({
          where: { id: run.id },
          data: {
            status: 'FAILED',
            completedAt: new Date(),
            latencyMs: Date.now() - runStartedAt,
          },
        })
        .catch(() => {});

      let userMessage: string;
      if (
        message === 'AI_ENGINE_OFFLINE' ||
        message?.includes('ECONNREFUSED')
      ) {
        userMessage =
          '**AI engine is starting up.** Financial data has been gathered — please try again in a moment.';
      } else if (message === 'AI_TIMEOUT') {
        userMessage = '**Analysis timed out.** Try a more focused question.';
      } else if (message?.includes('permission')) {
        userMessage =
          '**Permission required.** You need dashboard creation permissions. Contact your org admin.';
      } else {
        userMessage = '**Agent encountered an error.** Please try again.';
      }

      yield this.chunk('error', { message: userMessage });
    }
  }

  // ─── Intent Detection ─────────────────────────────────────────────────────

  private detectIntent(
    query: string,
    hasActiveDashboard: boolean,
  ): QueryIntent {
    if (!hasActiveDashboard) return 'CREATE_DASHBOARD';

    const q = query.toLowerCase();

    const EDIT_SIGNALS = [
      /\b(change|modify|update|edit|alter|adjust|switch|turn|convert|transform)\b/,
      /\b(add|include|insert|put|append)\s+(a\s+)?(chart|graph|widget|line|bar|pie|metric|visualization)/,
      /\b(remove|delete|drop|hide|take\s+out|get\s+rid\s+of)\s+(the\s+)?(chart|graph|widget|line|bar|pie|metric)/,
      /\b(make\s+it|make\s+the|replace\s+the|rename|retitle|relabel)\b/,
      /\b(instead\s+of|swap|flip)\b/,
      /\b(can\s+you\s+add|can\s+you\s+remove|can\s+you\s+change|can\s+you\s+update)\b/,
    ];

    const CREATE_SIGNALS = [
      /\b(create|build|generate|design|make\s+a|give\s+me\s+a)\s+(new\s+)?(dashboard|report|board)/,
      /\bnew\s+dashboard\b/,
      /\bfresh\s+(start|dashboard|view)\b/,
      /\bstart\s+over\b/,
      /\bfrom\s+scratch\b/,
      /\bdifferent\s+dashboard\b/,
    ];

    const editScore = EDIT_SIGNALS.filter((p) => p.test(q)).length;
    const createScore = CREATE_SIGNALS.filter((p) => p.test(q)).length;

    if (createScore > 0 && createScore >= editScore) return 'CREATE_DASHBOARD';
    if (editScore > 0) return 'EDIT_DASHBOARD';

    // If the user is asking a fresh question that explicitly requests a chart/table output,
    // prefer creating a new dashboard rather than mutating the last one.
    const asksForChart =
      /\b(chart|graph|barchart|bar\s*chart|line\s*chart|pie\s*chart|table)\b/.test(
        q,
      ) || /\b(as|in)\s+a?\s*(bar|line|pie)\s*chart\b/.test(q);
    if (asksForChart) return hasActiveDashboard ? 'EDIT_DASHBOARD' : 'CREATE_DASHBOARD';

    // Active dashboard exists + no signals → default to edit (follow-up refinement).
    return 'EDIT_DASHBOARD';
  }

  // ─── Active Dashboard Lookup ──────────────────────────────────────────────

  private async getActiveSessionDashboard(
    sessionId: string,
    organizationId: string,
  ): Promise<ActiveDashboard | null> {
    const latestRequest = await this.prisma.agentDashboardRequest.findFirst({
      where: {
        agentSessionId: sessionId,
        organizationId,
        status: 'SUCCEEDED',
        generatedDashboardId: { not: null },
      },
      orderBy: { completedAt: 'desc' },
      include: {
        generatedDashboard: {
          include: { widgets: { orderBy: { displayOrder: 'asc' } } },
        },
      },
    });

    const dashboard = latestRequest?.generatedDashboard;
    if (!dashboard || dashboard.deletedAt) return null;

    return {
      id: dashboard.id,
      title: dashboard.title,
      widgets: dashboard.widgets.map((w) => ({
        id: w.id,
        title: w.title,
        chartType: w.chartType,
        queryConfig: w.queryConfig,
        displayOrder: w.displayOrder,
      })),
    };
  }

  /**
   * Deletes a single chart from a session's live dashboard via the chart header
   * control. Unlike the chat-driven delete, the target is identified by its real
   * widget id (the header button is attached to one specific card), so there is
   * no title-collision ambiguity to resolve. The widget is matched against the
   * CURRENT live dashboard — a stale id (e.g. a chart only visible via the
   * previous-version fallback, no longer live) is rejected rather than silently
   * removing the wrong chart. Removal is applied as a new chart version so it
   * stays consistent with chat edits: history is preserved and recoverable.
   */
  async deleteSessionChart(
    sessionId: string,
    organizationId: string,
    role: MembershipRole,
    widgetId: string,
  ): Promise<{
    dashboardId: string;
    versionNumber: number;
    widgetCount: number;
    summary: string;
    removedTitle: string;
  }> {
    const activeDashboard = await this.getActiveSessionDashboard(
      sessionId,
      organizationId,
    );
    if (!activeDashboard) {
      throw new HttpException(
        'No live dashboard found for this session.',
        HttpStatus.NOT_FOUND,
      );
    }

    const index = activeDashboard.widgets.findIndex((w) => w.id === widgetId);
    if (index === -1) {
      // The card is no longer part of the live dashboard (e.g. it was only
      // showing through the previous-version fallback). Reject instead of
      // deleting a same-positioned but different live chart.
      throw new HttpException(
        'This chart is no longer in the live dashboard, so it cannot be deleted.',
        HttpStatus.CONFLICT,
      );
    }

    const removedTitle = activeDashboard.widgets[index]!.title;
    const summary = `Removed ${removedTitle}. Previous chart versions remain in the history.`;
    const editPlan: DashboardEditPlan = {
      summary,
      add: [],
      remove_indices: [index],
      modify: [],
    };

    const updated = await this.applyDashboardEdit(
      activeDashboard.id,
      editPlan,
      organizationId,
    );
    const widgetSnapshots = await this.buildChartTurnWidgetSnapshots(
      organizationId,
      role,
      updated.widgets,
    );
    const versionNumber = await this.nextChartTurnVersion(
      sessionId,
      organizationId,
    );
    const chartTurnMetadata: ChartTurnMetadata = {
      kind: 'chart_turn',
      mode: 'edit',
      versionNumber,
      previousVersionNumber: versionNumber > 1 ? versionNumber - 1 : null,
      sessionId,
      dashboardId: updated.id,
      dashboardTitle: updated.title,
      widgetCount: updated.widgetCount,
      prompt: `Deleted “${removedTitle}” from the dashboard.`,
      summary: this.describeChartTurnSummary({
        mode: 'edit',
        dashboardTitle: updated.title,
        widgetSnapshots,
        rawSummary: summary,
      }),
      widgetSnapshots,
      intent: 'EDIT_DASHBOARD',
    };

    await this.prisma.agentChatMessage.create({
      data: {
        sessionId,
        organizationId,
        role: 'assistant',
        content: summary,
        metadata: chartTurnMetadata as unknown as Prisma.InputJsonValue,
      },
    });

    return {
      dashboardId: updated.id,
      versionNumber,
      widgetCount: updated.widgetCount,
      summary,
      removedTitle,
    };
  }

  // ─── Conversation History ────────────────────────────────────────────────

  private async getConversationHistory(
    sessionId: string,
    organizationId: string,
  ): Promise<string> {
    const messages = await this.prisma.agentChatMessage.findMany({
      where: { sessionId, organizationId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    if (messages.length <= 1) return '(No prior conversation in this session)';

    return messages
      .reverse()
      .slice(0, -1) // Exclude the current user message (just persisted)
      .map((m) => {
        const role = m.role.toUpperCase();
        const preview =
          m.content.length > 180 ? m.content.slice(0, 180) + '...' : m.content;
        const chartLine =
          role === 'ASSISTANT'
            ? this.formatChartTurnHistoryLine((m as any).metadata ?? null)
            : null;
        return chartLine ? `${role}: ${preview}\n${chartLine}` : `${role}: ${preview}`;
      })
      .join('\n');
  }

  private formatChartTurnHistoryLine(metadata: unknown): string | null {
    if (!metadata || typeof metadata !== 'object') return null;
    const record = metadata as Partial<ChartTurnMetadata>;
    if (record.kind !== 'chart_turn') return null;

    const widgetTitles = Array.isArray(record.widgetSnapshots)
      ? record.widgetSnapshots
          .slice(0, 3)
          .map((w) => `${w.title} [${w.chartType}]`)
          .join(' | ')
      : '';

    return [
      `CHART v${record.versionNumber ?? '?'}: ${record.dashboardTitle ?? 'Dashboard'}`,
      `MODE=${record.mode ?? 'create'}; WIDGETS=${record.widgetCount ?? 0}`,
      record.previousVersionNumber
        ? `PREVIOUS=v${record.previousVersionNumber}`
        : null,
      record.summary ? `SUMMARY=${record.summary}` : null,
      widgetTitles ? `DETAILS=${widgetTitles}` : null,
    ]
      .filter(Boolean)
      .join(' | ');
  }

  private describeChartTurnSummary(input: {
    mode: ChartTurnMode;
    dashboardTitle: string;
    widgetSnapshots: ChartTurnWidgetSnapshot[];
    rawSummary: string;
  }): string {
    const primaryWidget = input.widgetSnapshots[0];
    const chartType = this.humanizeChartType(primaryWidget?.chartType);
    const chartLabel = chartType ?? 'chart';
    // The summary the user sees is the CHANGE itself — never internal mechanics
    // ("new version", "preserved in chat"). Strip trailing punctuation so it
    // composes cleanly with the surrounding sentence.
    const clean = input.rawSummary.trim().replace(/\s+/g, ' ').replace(/[.\s]+$/, '');

    if (input.mode === 'edit') {
      return clean || `Updated the ${chartLabel}`;
    }
    return clean || `Built a ${chartLabel}`;
  }

  private humanizeChartType(chartType?: string): string | null {
    const value = String(chartType ?? '').trim().toLowerCase();
    if (!value) return null;
    if (value === 'donut' || value === 'pie') return `${value} chart`;
    if (value === 'stacked_bar') return 'stacked bar chart';
    if (value === 'horizontal_bar') return 'horizontal bar chart';
    if (value === 'heatmap' || value === 'matrix' || value === 'treemap') return value;
    if (value === 'line' || value === 'bar' || value === 'area' || value === 'scatter') {
      return `${value} chart`;
    }
    return `${value} chart`;
  }

  private async buildChartTurnWidgetSnapshots(
    organizationId: string,
    role: MembershipRole,
    widgets: Array<{
      id?: string;
      title: string;
      chartType: string;
      queryConfig: Record<string, unknown>;
      chartConfig: Record<string, unknown>;
      displayOrder: number;
    }>,
  ): Promise<ChartTurnWidgetSnapshot[]> {
    const MAX_SNAPSHOT_ROWS = 100;

    const snapshots = await Promise.all(
      widgets.map(async (widget) => {
        const metric = String(widget.queryConfig.metric ?? '').trim();
        const grouping = String(widget.queryConfig.grouping ?? '').trim();
        const timeRange = (widget.queryConfig.timeRange ?? null) as TimeRange | null;
        const providerHint = (widget.queryConfig.providerHint ?? null) as
          | string
          | null;
        const clientName = (widget.queryConfig.clientName ?? null) as string | null;
        const clientNames = Array.isArray(widget.queryConfig.clientNames)
          ? (widget.queryConfig.clientNames as string[])
          : null;
        const orgId = (widget.queryConfig.orgId ?? null) as string | null;
        const breakdown = (widget.queryConfig.breakdown ?? null) as string | null;
        const topNRaw = widget.queryConfig.topN ?? null;
        const topN =
          typeof topNRaw === 'number'
            ? topNRaw
            : typeof topNRaw === 'string' && topNRaw.trim()
              ? Number(topNRaw)
              : null;

        if (!metric || !grouping) {
          return {
            ...widget,
            chartConfig: {
              ...(widget.chartConfig ?? {}),
              display: (widget.queryConfig as any)?.display ?? null,
            },
            dataSnapshot: [],
            dataSnapshotTruncated: false,
          };
        }

        try {
          const result = await this.metricData(
            organizationId,
            role,
            metric,
            grouping,
            timeRange ?? undefined,
            providerHint ?? undefined,
            clientName ?? undefined,
            clientNames ?? undefined,
            orgId ?? undefined,
            breakdown ?? undefined,
            Number.isFinite(topN ?? NaN) ? (topN as number) : undefined,
            widget.id,
          );
          const data = Array.isArray(result.data) ? result.data : [];
          return {
            ...widget,
            chartConfig: {
              ...(widget.chartConfig ?? {}),
              display: (widget.queryConfig as any)?.display ?? null,
            },
            dataSnapshot: data.slice(0, MAX_SNAPSHOT_ROWS) as Array<
              Record<string, unknown>
            >,
            dataSnapshotTruncated: data.length > MAX_SNAPSHOT_ROWS,
            rangeNotice: result.rangeNotice ?? null,
            requestedRangeLabel: result.requestedRangeLabel ?? null,
            availableRange: result.availableRange ?? null,
          };
        } catch (err: any) {
          this.logger.warn(
            `[Agent:ChartSnapshot] Failed to snapshot widget "${widget.title}": ${err.message}`,
          );
          return {
            ...widget,
            chartConfig: {
              ...(widget.chartConfig ?? {}),
              display: (widget.queryConfig as any)?.display ?? null,
            },
            dataSnapshot: [],
            dataSnapshotTruncated: false,
          };
        }
      }),
    );

    return snapshots.sort(
      (a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0),
    );
  }

  private applyPieDonutLabelModeToWidgets(
    widgets: any[],
    query: string,
  ): any[] {
    const wantsValueLabels =
      /\b(whole\s+values?|values?\s+instead\s+of\s+percent(?:age|ages)?|remove\s+percent(?:age|ages)?|show\s+values?|raw\s+values?)\b/i.test(
        query,
      ) ||
      /\bneed\s+values?\b/i.test(query) ||
      /\babsolute\s+values?\b/i.test(query) ||
      /\bnumbers?\s+instead\s+of\s+percent(?:age|ages)?\b/i.test(query) ||
      /\bwithout\s+percent(?:age|ages)?\b/i.test(query) ||
      /\bno\s+percent(?:age|ages)?\b/i.test(query) ||
      /\bpercentage\s+to\s+values?\b/i.test(query) ||
      /\bpercent(?:age|ages)?\s+to\s+values?\b/i.test(query);
    const wantsPercentLabels =
      /\bpercent(?:age|ages)?\s+to\s+percent(?:age|ages)?\b/i.test(query) ||
      /\bshow\s+percent(?:age|ages)?\b/i.test(query) ||
      /\bpercent(?:age|ages)?\s+labels?\b/i.test(query) ||
      /\bpercent(?:age|ages)?\s+values?\b/i.test(query) ||
      /\bshow\s+percent(?:age|ages)?\s+in\s+the\s+chart\b/i.test(query);

    const labelMode = wantsValueLabels ? 'value' : wantsPercentLabels ? 'percent' : null;
    if (!labelMode) return widgets;

    return widgets.map((widget) => {
      const chartType = String(widget.type ?? '').toLowerCase();
      if (chartType !== 'pie' && chartType !== 'donut') return widget;
      const existingDisplay =
        widget.display && typeof widget.display === 'object' && !Array.isArray(widget.display)
          ? (widget.display as Record<string, unknown>)
          : {};
      return {
        ...widget,
        display: {
          ...existingDisplay,
          labelMode,
        },
      };
    });
  }

  private async nextChartTurnVersion(
    sessionId: string,
    organizationId: string,
  ): Promise<number> {
    const assistantMessages = await this.prisma.agentChatMessage.findMany({
      where: {
        sessionId,
        organizationId,
        role: 'assistant',
      },
      select: { metadata: true },
      orderBy: { createdAt: 'asc' },
    });

    const chartTurns = assistantMessages.filter((message) => {
      const metadata = message.metadata;
      return (
        metadata &&
        typeof metadata === 'object' &&
        (metadata as Partial<ChartTurnMetadata>).kind === 'chart_turn'
      );
    });

    return chartTurns.length + 1;
  }

  private extractSelectedOptionFromPriorClarification(
    userQuery: string,
    priorAssistantMessage: string | null,
  ): string | null {
    const q = userQuery.trim();
    if (!/^\d+$/.test(q)) return null;
    const n = Number(q);
    if (!Number.isFinite(n) || n < 1 || n > 9) return null;
    if (!priorAssistantMessage) return null;

    // We format clarifications as:
    // Question
    //
    // 1) Option label
    // 2) Option label
    const lines = priorAssistantMessage.split('\n').map((l) => l.trim());
    const line = lines.find((l) => new RegExp(`^${n}\\)\\s+`).test(l));
    if (!line) return null;
    const picked = line.replace(new RegExp(`^${n}\\)\\s+`), '').trim() || null;
    if (!picked) return null;

    const header = (lines[0] ?? '').toLowerCase();
    // Preserve the "meaning" of the selection so resolvers can apply it without
    // losing the original query context (time windows, chart constraints).
    if (
      header.includes('which entity') ||
      header.includes('entity should i use')
    )
      return `Use entity: ${picked}`;
    if (
      header.includes('which client') ||
      header.includes('client did you mean')
    )
      return `Use client: ${picked}`;
    if (header.includes('first client')) return `Use client A: ${picked}`;
    if (header.includes('second client')) return `Use client B: ${picked}`;
    return picked;
  }

  private extractCompareClients(raw: string): string[] | null {
    const s = String(raw ?? '').trim();
    if (!s) return null;

    // ── Explicit selections from UI quick-actions ─────────────────────────
    const explicitList = s.match(/^\s*use\s+clients?\s*[:\-]\s*(.+?)\s*$/i);
    if (explicitList?.[1]) {
      const parts = explicitList[1]
        .split(/\s*(?:,|;|\||\band\b|\bvs\b|\bversus\b)\s*/i)
        .map((p) => p.trim())
        .filter(Boolean);
      const uniq = Array.from(new Set(parts.map((p) => p.toLowerCase())))
        .map((k) => parts.find((p) => p.toLowerCase() === k)!)
        .filter(Boolean);
      return uniq.length >= 2 ? uniq.slice(0, 2) : null;
    }

    const pickA = s.match(/^\s*use\s+client\s+(?:a|1)\s*[:\-]\s*(.+?)\s*$/i);
    const pickB = s.match(/^\s*use\s+client\s+(?:b|2)\s*[:\-]\s*(.+?)\s*$/i);
    const a = pickA?.[1]?.trim();
    const b = pickB?.[1]?.trim();
    if (a || b) return [a, b].filter(Boolean) as string[];

    // Try to find directives anywhere in a multi-line merged query
    const lines = s.split('\n').map((l) => l.trim());
    const a2 = lines
      .map((l) =>
        l.match(/^use\s+client\s+(?:a|1)\s*[:\-]\s*(.+)$/i)?.[1]?.trim(),
      )
      .filter(Boolean)
      .slice(-1)[0];
    const b2 = lines
      .map((l) =>
        l.match(/^use\s+client\s+(?:b|2)\s*[:\-]\s*(.+)$/i)?.[1]?.trim(),
      )
      .filter(Boolean)
      .slice(-1)[0];
    if (a2 || b2) return [a2, b2].filter(Boolean) as string[];

    // Heuristic: quoted pair "X" vs "Y"
    const quoted = Array.from(s.matchAll(/["“”']([^"“”']{2,80})["“”']/g)).map(
      (m) => (m[1] ?? '').trim(),
    );
    if (quoted.length >= 2) return [quoted[0]!, quoted[1]!];

    // ── Heuristic: "X vs Y" without the word "compare" ────────────────────
    {
      const compact = s.replace(/\s+/g, ' ').trim();
      const vsMatch = compact.match(
        /(.+?)\s+(?:vs\.?|versus)\s+(.+?)(?:\s+(?:in|for|from|over|during|within|last|past|since|between|as\s+a|as\s+an|by)\b|$)/i,
      );
      if (vsMatch?.[1] && vsMatch?.[2]) {
        const clean = (x: string) =>
          x
            .replace(/\bclients?\b/gi, '')
            .replace(/\bcustomers?\b/gi, '')
            .replace(/\bcontacts?\b/gi, '')
            .trim();
        const a3 = clean(vsMatch[1]);
        const b3 = clean(vsMatch[2]);
        if (a3 && b3 && a3.length >= 2 && b3.length >= 2) return [a3, b3];
      }
    }

    // ── Heuristic: unquoted "compare X vs Y" / "compare X and Y" ──────────
    // Keep conservative: stop at scope/time/metric introducers so we don't
    // treat "revenue for last 6 months" as a client name.
    const compact = s.replace(/\s+/g, ' ').trim();
    const tailFromCompare = compact.match(/\bcompare\b\s+(.+)$/i)?.[1]?.trim();
    if (tailFromCompare) {
      const stopMatch = tailFromCompare.match(
        /\b(?:in|for|from|over|during|within|last|past|since|between|as\s+a|as\s+an|by)\b/i,
      );
      const segment = stopMatch
        ? tailFromCompare.slice(0, Math.max(0, stopMatch.index ?? 0)).trim()
        : tailFromCompare;

      const parts = segment
        .split(/\s*(?:vs\.?|versus|and|&)\s*/i)
        .map((p) => p.trim())
        .filter(Boolean);

      if (parts.length >= 2) {
        const clean = (x: string) =>
          x
            .replace(/\bclients?\b/gi, '')
            .replace(/\bcustomers?\b/gi, '')
            .replace(/\bcontacts?\b/gi, '')
            .trim();
        const a3 = clean(parts[0]!);
        const b3 = clean(parts[1]!);
        if (a3 && b3 && a3.length >= 2 && b3.length >= 2) return [a3, b3];
      }
    }

    return null;
  }

  // ─── Deterministic Widget Selection ──────────────────────────────────────
  // Fallback-only widget selection.
  // Keep this intentionally minimal to avoid "preloaded dashboards" when the
  // planner is unavailable.

  private selectWidgetsForQuery(
    query: string,
    activeDashboard?: ActiveDashboard | null,
  ): AgentPlan['dashboard']['widgets'] {
    const q = query.toLowerCase();
    const has = (r: RegExp) => r.test(q);
    const spec = parseQuerySpec(query);
    const compareClients = this.extractCompareClients(query);
    const wantsCompareClients =
      /\bcompare\b/i.test(query) &&
      /\b(client|clients|customer|customers|contact|contacts)\b/i.test(query) &&
      !spec.wantsTopClients &&
      Array.isArray(compareClients) &&
      compareClients.length >= 2;

    type W = AgentPlan['dashboard']['widgets'][number];
    const mk = (
      title: string,
      description: string,
      type: ChartType,
      metric: string,
      grouping: string,
      order: number,
      extra?: Pick<W, 'breakdown' | 'topN'>,
    ): W => ({
      title,
      description,
      type,
      metric,
      grouping,
      ...(extra ?? {}),
      display_order: order,
    });

    const parseTopN = (): number | null => {
      const m = q.match(/\btop\s+(\d+)\b/);
      if (m?.[1]) {
        const n = Number(m[1]);
        if (Number.isFinite(n)) return Math.max(1, Math.min(5, Math.floor(n)));
      }
      const words: Record<string, number> = {
        one: 1,
        two: 2,
        three: 3,
        four: 4,
        five: 5,
      };
      const w = q.match(/\btop\s+(one|two|three|four|five)\b/);
      if (w?.[1]) return words[w[1]] ?? null;
      return null;
    };

    const executiveDashboardWidgets = (): W[] => [
      mk(
        'Executive KPIs',
        'Revenue, expenses, net profit, invoice count, and AR health',
        'kpi',
        'summary',
        'overview',
        0,
      ),
      mk(
        'Balance Sheet Position',
        'Assets, liabilities, and equity from the trial balance',
        'bar',
        'balance_sheet',
        'summary',
        1,
      ),
      mk(
        'P&L Waterfall — Revenue to Net Income',
        'Revenue → COGS → gross profit → operating expenses → net income',
        'waterfall',
        'pl',
        'summary',
        2,
      ),
      mk(
        'Net Income Trend',
        'Monthly net income from revenue less COGS and operating expenses',
        'line',
        'net_income',
        'month',
        3,
      ),
      mk(
        'Top Expense Accounts',
        'Largest expense accounts ranked by spend',
        'bar',
        'expense',
        'account',
        4,
      ),
      mk(
        'Revenue by Account',
        'Income source breakdown by GL account',
        'bar',
        'revenue',
        'account',
        5,
      ),
    ];

    const hasExecutiveDashboardIntent =
      has(/\b(dashboard|report|overview|summary|scorecard|board\s+pack|pack|suite)\b/) &&
      has(/\b(cfo|executive|financial\s+position|operating\s+performance|profitability|liquidity|cash\s+position|financial\s+health|balance\s+sheet|p&l|income\s+statement|net\s+income)\b/);

    if (hasExecutiveDashboardIntent) {
      return executiveDashboardWidgets();
    }

    // ── Explicit chart instruction mode ─────────────────────────────────────
    // If the user provides explicit “Create a X chart …” lines (common in specs),
    // honor them deterministically. This reduces reliance on the LLM and makes
    // behavior stable for generic “chart builder” prompts.
    {
      const explicitLines = query
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .filter((l) => /^(?:[-*]\s*)?(create|make|build|generate)\b/i.test(l));

      if (explicitLines.length > 0) {
        const widgets: W[] = [];
        for (const line of explicitLines.slice(0, 8)) {
          const lower = line.toLowerCase();
          const wants = (r: RegExp) => r.test(lower);

          const requestedType = ((): W['type'] => {
            // UI currently renders “gauge” requests best as a KPI/metric tile.
            if (wants(/gauge/)) return 'metric';
            if (wants(/heat\s*map|heatmap/)) return 'heatmap';
            if (wants(/matrix/)) return 'matrix';
            if (wants(/waterfall/)) return 'waterfall';
            if (wants(/pareto/)) return 'pareto';
            if (wants(/treemap/)) return 'treemap';
            if (wants(/scatter/)) return 'scatter';
            if (wants(/donut\s+chart|doughnut\s+chart/)) return 'donut';
            if (wants(/combo\s+chart|combination\s+chart/)) return 'combo';
            if (wants(/area\s+chart/)) return 'area';
            if (wants(/stacked\s+(bar|column)/)) return 'stacked_bar';
            if (wants(/clustered\s+(bar|column)/)) return 'bar';
            if (wants(/ranked\s+bar|horizontal\s+bar/)) return 'horizontal_bar';
            if (wants(/(bar|column)\s+chart/)) return 'bar';
            if (wants(/pie\s+chart/)) return 'pie';
            if (wants(/line\s+chart/)) return 'line';
            return 'line';
          })();

          const wantsValueLabels =
            wants(/whole\s+values?|values?\s+instead\s+of\s+percent(?:age|ages)?/) ||
            wants(/remove\s+percent(?:age|ages)?/) ||
            wants(/show\s+values?/) ||
            wants(/need\s+values?/) ||
            wants(/absolute\s+values?/) ||
            wants(/raw\s+values?/) ||
            wants(/numbers?\s+instead\s+of\s+percent(?:age|ages)?/) ||
            wants(/without\s+percent(?:age|ages)?/) ||
            wants(/no\s+percent(?:age|ages)?/) ||
            wants(/percentage\s+to\s+values?/) ||
            wants(/percent(?:age|ages)?\s+to\s+values?/);
          const wantsPercentLabels =
            wants(/percent(?:age|ages)?\s+to\s+percent(?:age|ages)?/) ||
            wants(/show\s+percent(?:age|ages)?/) ||
            wants(/percent(?:age|ages)?\s+labels?/) ||
            wants(/percent(?:age|ages)?\s+values?/);
          const display: W['display'] | undefined =
            wants(/donut/) ||
            wantsValueLabels ||
            wantsPercentLabels ||
            (wants(/highlight/) && wants(/highest|lowest|max|min/))
              ? {
                  donut: wants(/donut/),
                  highlightMaxMin:
                    wants(/highlight/) && wants(/highest|lowest|max|min/),
                  labelMode: wantsValueLabels
                    ? 'value'
                    : wantsPercentLabels
                      ? 'percent'
                      : undefined,
                }
              : undefined;

          const metricGrouping = ((): {
            metric: string;
            grouping: string;
          } | null => {
            // Gauge-style “financial health” defaults to a KPI summary.
            if (
              wants(/gauge|health/) &&
              wants(/revenue|expense|balance|profit|net/)
            )
              return { metric: 'pl_summary', grouping: 'summary' };

            // Revenue by month
            if (
              wants(/revenue/) &&
              wants(/\bby\s+month\b|\bmonthly\b|\beach\s+month\b/)
            )
              return { metric: 'revenue', grouping: 'month' };

            // Month-over-month revenue growth %
            if (
              wants(/month[-\s]?over[-\s]?month|mom\b/) &&
              wants(/revenue|growth/)
            )
              return { metric: 'mom_growth', grouping: 'month' };

            // Cumulative revenue
            if (wants(/cumulative/) && wants(/revenue|sales|income/))
              return { metric: 'revenue_cumulative', grouping: 'month' };

            // Revenue vs expenses comparison
            if (
              wants(/compare|comparing/) &&
              wants(/revenue/) &&
              wants(/expense/)
            )
              return { metric: 'revenue_vs_expense', grouping: 'month' };
            if (wants(/heatmap/) && wants(/revenue/) && wants(/expense/))
              return { metric: 'revenue_vs_expense', grouping: 'month' };
            if (
              wants(/heatmap/) &&
              wants(/expense|spend/) &&
              wants(/department|dept/) &&
              wants(/month|months|trend|time/)
            )
              return { metric: 'expense', grouping: 'month_department' };
            if (
              wants(/matrix/) &&
              wants(/expense|spend/) &&
              wants(/department|dept/) &&
              wants(/vendor|supplier/)
            )
              return { metric: 'expense', grouping: 'department_vendor' };

            // Net position (credits - debits)
            if (
              wants(
                /net\s+monthly|net\s+position|credits?\s*-\s*debits?|debits?\s*-\s*credits?/,
              ) ||
              (wants(/credits?/) && wants(/debits?/))
            )
              return { metric: 'net_position', grouping: 'month' };

            // Running balance
            if (wants(/running\s+balance|balance\s+trend/))
              return { metric: 'running_balance', grouping: 'month' };

            // Debits vs credits
            if (wants(/\bdebits?\b/) || wants(/\bcredits?\b/))
              return { metric: 'debits_credits', grouping: 'month' };

            // Invoice type split
            if (wants(/invoice\s+type|invoice\s+types/))
              return { metric: 'invoice_value', grouping: 'invoice_type' };

            // Journal/source type split (AP/AR/EX)
            if (wants(/journal\s+type|source\s+type|\bap\b|\bar\b|\bex\b/))
              return { metric: 'transaction_value', grouping: 'journal_type' };

            // Invoice value by month (column chart phrasing)
            if (
              wants(/invoice\s+value/) &&
              wants(/\bby\s+month\b|\bmonthly\b|\beach\s+month\b/)
            )
              return { metric: 'revenue', grouping: 'month' };

            // Invoice count by month
            if (wants(/number\s+of\s+invoices|invoice\s+count/))
              return { metric: 'invoice_count', grouping: 'month' };

            // Average invoice value by month
            if (wants(/average\s+invoice/))
              return { metric: 'avg_invoice', grouping: 'month' };

            // Invoice amount histogram/distribution
            if (wants(/histogram|distribution|bucket/) && wants(/invoice/))
              return { metric: 'invoice_amount', grouping: 'bucket' };

            // Top invoices / transactions
            if (wants(/\btop\b/) && wants(/invoice|invoices|transaction/))
              return { metric: 'top_invoices', grouping: 'list' };

            // Expenses
            if (wants(/expenses?/) && wants(/\bby\s+month\b|\bmonthly\b/))
              return { metric: 'expense', grouping: 'month' };
            if (wants(/expenses?/) && wants(/account/))
              return { metric: 'expense', grouping: 'account' };

            return null;
          })();

          if (!metricGrouping) continue;

          const type: W['type'] = (() => {
            // Some metrics are only meaningful in specific visual forms.
            if (metricGrouping.metric === 'top_invoices') return 'table';
            if (
              requestedType === 'waterfall' &&
              metricGrouping.metric === 'net_position'
            )
              return 'waterfall';
            if (
              requestedType === 'stacked_bar' &&
              metricGrouping.metric === 'debits_credits'
            )
              return 'stacked_bar';
            // For “net position” explicitly requested as line, allow line as well.
            if (
              metricGrouping.metric === 'net_position' &&
              requestedType !== 'waterfall'
            )
              return requestedType === 'bar' ? 'bar' : 'line';
            return requestedType;
          })();

          const title = (() => {
            if (metricGrouping.metric === 'pl_summary')
              return 'Financial Health (KPI Summary)';
            if (metricGrouping.metric === 'revenue') return 'Monthly Revenue';
            if (metricGrouping.metric === 'mom_growth')
              return 'MoM Revenue Growth %';
            if (metricGrouping.metric === 'revenue_cumulative')
              return 'Cumulative Revenue';
            if (metricGrouping.metric === 'revenue_vs_expense')
              return 'Revenue vs Expenses';
            if (metricGrouping.metric === 'net_position')
              return 'Net Monthly Position';
            if (metricGrouping.metric === 'running_balance')
              return 'Running Balance';
            if (metricGrouping.metric === 'debits_credits')
              return 'Debits vs Credits';
            if (metricGrouping.metric === 'invoice_value')
              return 'Invoice Value by Type';
            if (metricGrouping.metric === 'transaction_value')
              return 'Transaction Value by Journal Type';
            if (metricGrouping.metric === 'invoice_count')
              return 'Invoice Count Trend';
            if (metricGrouping.metric === 'avg_invoice')
              return 'Average Invoice Value';
            if (metricGrouping.metric === 'invoice_amount')
              return 'Invoice Amount Distribution';
            if (metricGrouping.metric === 'top_invoices') return 'Top Invoices';
            if (
              metricGrouping.metric === 'expense' &&
              metricGrouping.grouping === 'month'
            )
              return 'Monthly Expenses';
            if (
              metricGrouping.metric === 'expense' &&
              metricGrouping.grouping === 'account'
            )
              return 'Top Expense Accounts';
            return `${metricGrouping.metric} (${metricGrouping.grouping})`;
          })();

          const description = line
            .replace(/^(?:[-*]\s*)?(create|make|build|generate)\s+/i, '')
            .trim();

          const topFromLine = (() => {
            const m = lower.match(/\btop\s+(\d+)\b/);
            if (!m?.[1]) return null;
            const n = Number(m[1]);
            if (!Number.isFinite(n)) return null;
            return Math.max(1, Math.min(50, Math.floor(n)));
          })();

          const extra = topFromLine
            ? ({ topN: topFromLine } as const)
            : undefined;

          widgets.push({
            ...mk(
              title,
              description,
              type,
              metricGrouping.metric,
              metricGrouping.grouping,
              widgets.length,
              extra,
            ),
            ...(display ? { display } : {}),
          });
        }

        if (widgets.length > 0) return widgets;
      }
    }

    // ── Cumulative / running totals ──────────────────────────────────────────
    if (has(/\bcumulative\b|\brunning\s+total\b/)) {
      if (has(/revenue|sales|income/)) {
        return [
          mk(
            'Cumulative Revenue',
            'Running total of revenue over time',
            'area',
            'revenue_cumulative',
            'month',
            0,
          ),
        ];
      }
    }

    // ── Running balance / net position ───────────────────────────────────────
    if (
      has(/running\s+balance|balance\s+trend|cash\s+position|net\s+position/)
    ) {
      const wantsWaterfall = has(/waterfall/);
      if (wantsWaterfall) {
        return [
          mk(
            'Net Monthly Position (Waterfall)',
            'Credits minus debits by month, visualized as a waterfall progression',
            'waterfall',
            'net_position',
            'month',
            0,
          ),
        ];
      }
      return [
        mk(
          'Running Balance Trend',
          'Cumulative net position over time (credits minus debits)',
          'line',
          'running_balance',
          'month',
          0,
        ),
        mk(
          'Debits vs Credits',
          'Monthly debits and credits from journal lines',
          'stacked_bar',
          'debits_credits',
          'month',
          1,
        ),
      ];
    }

    // ── Debit/credit breakdown ───────────────────────────────────────────────
    if (has(/\bdebits?\b|\bcredits?\b/)) {
      return [
        mk(
          'Debits vs Credits',
          'Monthly debits and credits from journal lines',
          has(/stacked/) ? 'stacked_bar' : 'bar',
          'debits_credits',
          'month',
          0,
        ),
      ];
    }

    // ── Invoice type / journal type / currency splits ────────────────────────
    if (has(/invoice\s+type|type\s+of\s+invoice/)) {
      return [
        mk(
          'Invoice Value by Type',
          'Total invoice value split by invoice type',
          'pie',
          'invoice_value',
          'invoice_type',
          0,
        ),
      ];
    }
    if (has(/journal\s+type|ap\b|ar\b|source\s+type/)) {
      return [
        mk(
          'Transaction Value by Journal Type',
          'Total journal value split by source type (AP/AR/EX/other)',
          'pie',
          'transaction_value',
          'journal_type',
          0,
        ),
      ];
    }
    if (has(/currency|currencies|fx|foreign\s+exchange/)) {
      return [
        mk(
          'Transaction Value by Currency',
          'Total transaction value split by currency',
          'pie',
          'transaction_value',
          'currency',
          0,
        ),
      ];
    }

    // ── Invoice size distribution / top invoices / outliers ──────────────────
    if (has(/histogram|distribution|bucket/) && has(/invoice/)) {
      return [
        mk(
          'Invoice Amount Distribution',
          'Histogram of invoice amounts to identify typical transaction sizes',
          'bar',
          'invoice_amount',
          'bucket',
          0,
        ),
      ];
    }
    if (has(/top\s+\d+|highest.?value|largest/) && has(/invoice/)) {
      return [
        mk(
          'Top Invoices by Value',
          'Highest-value invoices in the selected period',
          'table',
          'top_invoices',
          'list',
          0,
        ),
      ];
    }
    if (
      has(/scatter|outlier/) &&
      has(/invoice\s+amount|invoice\s+value|amount/)
    ) {
      return [
        mk(
          'Invoice Amount vs Date',
          'Scatter plot to identify large or unusual invoices over time',
          'scatter',
          'invoice_amount',
          'time',
          0,
        ),
      ];
    }

    // ── EBITDA focus ─────────────────────────────────────────────────────────
    if (has(/\bebitda\b/)) {
      return [
        mk(
          'EBITDA Trend',
          'Monthly EBITDA (net income + depreciation/amortisation add-back)',
          'line',
          'ebitda',
          'month',
          0,
        ),
        mk(
          'P&L KPI Summary',
          'Revenue, Expenses, Gross Profit, Net Income, Margins',
          'metric',
          'pl_summary',
          'summary',
          1,
        ),
        mk(
          'Revenue vs Expenses',
          'Revenue and total expenses on the same timeline',
          'line',
          'revenue_vs_expense',
          'month',
          2,
        ),
      ];
    }

    // ── Margin analysis focus ────────────────────────────────────────────────
    if (
      has(
        /gross\s+margin|net\s+margin|margin\s+analysis|margin\s+trend|gross\s+profit|markup/,
      )
    ) {
      return [
        mk(
          'Gross Margin % Trend',
          'Monthly gross margin percentage (revenue minus COGS)',
          'line',
          'gross_margin_pct',
          'month',
          0,
        ),
        mk(
          'Net Margin % Trend',
          'Monthly net margin percentage (revenue minus all expenses)',
          'line',
          'net_margin_pct',
          'month',
          1,
        ),
        mk(
          'P&L KPI Summary',
          'Revenue, Expenses, Gross Profit, Net Income, Margins',
          'metric',
          'pl_summary',
          'summary',
          2,
        ),
      ];
    }

    // ── P&L / income statement / net income focus ───────────────────────────
    if (
      has(
        /p&l|pl\b|profit\s+and\s+loss|income\s+statement|net\s+income|net\s+profit/,
      ) ||
      (has(/profit|loss|profitability/) && !has(/overdue|ar\b|receivable/))
    ) {
      const chartType: 'line' | 'bar' = has(/bar\s+chart|bar\s+graph|\bbar\b/)
        ? 'bar'
        : 'line';
      return [
        mk(
          'P&L Statement',
          'Full income statement: Revenue, COGS, OPEX, Net Income by account',
          'table',
          'pl',
          'summary',
          0,
        ),
        mk(
          'P&L KPI Summary',
          'Revenue, Expenses, Gross Profit, Net Income, Gross Margin %, Net Margin %',
          'metric',
          'pl_summary',
          'summary',
          1,
        ),
        mk(
          'Net Income Trend',
          'Monthly net income (revenue minus all GL expenses)',
          chartType,
          'net_income',
          'month',
          2,
        ),
      ];
    }

    // ── Expense / OPEX / cost breakdown focus ────────────────────────────────
    if (
      has(
        /expense|expenses|opex|operating\s+expense|cost\s+breakdown|spending|spend|overheads?/,
      )
    ) {
      const chartType: 'bar' | 'pie' = has(/pie\s+chart|pie\s+graph|\bpie\b/)
        ? 'pie'
        : 'bar';
      const w: W[] = [
        mk(
          'Top Expenses by GL Account',
          'Expense accounts ranked by total spend',
          chartType,
          'expense',
          'account',
          0,
        ),
        mk(
          'Expense Trend',
          'Monthly total expense trend from GL journals',
          'line',
          'expense',
          'month',
          1,
        ),
        mk(
          'Expense KPI Summary',
          'Total Expenses, COGS, OPEX, largest expense account',
          'metric',
          'expense_summary',
          'summary',
          2,
        ),
      ];
      if (has(/cogs|cost\s+of\s+goods|cost\s+of\s+sales|direct\s+cost/)) {
        w.push(
          mk(
            'COGS by Account',
            'Direct cost accounts ranked by spend',
            'bar',
            'cogs',
            'account',
            3,
          ),
        );
      }
      if (has(/opex|operating\s+expense/) && !has(/only|just/)) {
        w.push(
          mk(
            'OPEX by Account',
            'Operating expense accounts (excluding COGS)',
            'bar',
            'opex',
            'account',
            4,
          ),
        );
      }
      return w;
    }

    // ── GL / journal / ledger focus ──────────────────────────────────────────
    if (
      has(
        /journal|journals|gl\b|general\s+ledger|journal\s+lines?|gl\s+entries|ledger\s+entries/,
      )
    ) {
      return [
        mk(
          'GL Journal Entries',
          'All journal lines with debit/credit type, account, journal number',
          'table',
          'gl_transactions',
          'list',
          0,
        ),
        mk(
          'Top Expenses by Account',
          'Expense accounts from journal lines ranked by spend',
          'bar',
          'expense',
          'account',
          1,
        ),
      ];
    }

    // ── Payment speed / days-to-pay focus ───────────────────────────────────
    if (
      has(
        /days?\s+(to\s+pay|after)|payment\s+days|paid\s+after|invoice\s+date.*paid|dso|issue[sd]?\s*(?:→|to)\s*paid|issued.*paid|convert.*issued.*paid/,
      )
    ) {
      const w: W[] = [
        mk(
          'Invoice Payment Days',
          'Days from invoice issue date → paid date',
          'table',
          'payment_days',
          'list',
          0,
        ),
      ];
      if (has(/trend|month|monthly|over\s+time|line\s+chart|line\s+graph/)) {
        w.push(
          mk(
            'DSO Trend',
            'Average days-to-pay by month (issued date)',
            'line',
            'dso',
            'month',
            1,
          ),
        );
      }
      if (has(/distribution|histogram|bucket/)) {
        w.push(
          mk(
            'Payment Speed Distribution',
            'Histogram of days-to-pay buckets',
            'bar',
            'payment_days',
            'bucket',
            2,
          ),
        );
      }
      return w;
    }

    // ── 0. Audit / list / drilldown focus ────────────────────────────────────
    if (
      has(
        /audit|list|show\b|detail|transaction|invoice\s+list|recent\s+invoice/,
      )
    ) {
      return [
        mk(
          'Recent Invoices Ledger',
          'Latest invoices for audit and drill-down',
          'table',
          'invoices',
          'list',
          0,
        ),
      ];
    }

    // ── 0. Client / customer / contact focus ─────────────────────────────────
    if (
      has(
        /client|customer|contact|who.*paid|who.*bought|best.*client|top.*client|top.*customer/,
      )
    ) {
      // Compare two specific clients: prefer a simple, explicit comparison chart.
      if (
        wantsCompareClients &&
        has(/\b(revenue|sales|invoiced|billed|collected|paid)\b/) &&
        has(
          /month|monthly|month[-\s]?wise|trend|over\s+time|last\s+\d+\s+months?/,
        )
      ) {
        return [
          mk(
            'Client Revenue Comparison',
            'Monthly invoiced revenue for the selected clients',
            has(/line\s+chart|line\s+graph/) ? 'line' : 'bar',
            'revenue',
            'month',
            0,
            { breakdown: 'client' },
          ),
        ];
      }

      if (
        wantsCompareClients &&
        has(/\b(outstanding|overdue|aging|ar\b|receivable|past.?due)\b/) &&
        has(
          /month|monthly|month[-\s]?wise|trend|over\s+time|last\s+\d+\s+months?/,
        )
      ) {
        const metric = has(/\boverdue|past.?due|aging\b/)
          ? 'overdue'
          : 'outstanding';
        return [
          mk(
            `Client ${metric === 'overdue' ? 'Overdue' : 'Outstanding'} Comparison`,
            `Monthly ${metric} balance for the selected clients`,
            'bar',
            metric,
            'month',
            0,
            { breakdown: 'client' },
          ),
        ];
      }

      if (
        wantsCompareClients &&
        has(
          /dso|days?\s+to\s+pay|payment\s+days|issued.*paid|convert.*issued.*paid/,
        ) &&
        has(/month|monthly|trend|over\s+time|line\s+chart/)
      ) {
        return [
          mk(
            'Client Payment Speed (DSO) Comparison',
            'Average days-to-pay by month for the selected clients',
            'line',
            'dso',
            'month',
            0,
            { breakdown: 'client' },
          ),
        ];
      }

      // Month-wise trend for top N clients (grouped bars)
      if (
        has(
          /month|monthly|month[-\s]?wise|over\s+time|trend|last\s+\d+\s+months?/,
        )
      ) {
        const n = parseTopN() ?? (has(/\btop\s+two\b|\btop\s+2\b/) ? 2 : null);
        if (n) {
          return [
            mk(
              `Top ${n} Clients — Revenue by Month`,
              'Month-wise invoiced revenue for your top clients (grouped bars)',
              'bar',
              'revenue',
              'month',
              0,
              { breakdown: 'client', topN: n },
            ),
          ];
        }
      }

      // Overdue-heavy client query → show risk first
      if (has(/overdue|owe|debt|late|past.?due|risk|collect/)) {
        return [
          mk(
            'Overdue Exposure by Client',
            'How much each client has past their due date — collection risk',
            'bar',
            'overdue',
            'client',
            0,
          ),
        ];
      }
      // Compare / ranking query → show revenue + volume + overdue
      if (
        has(/compar|rank|vs\b|versus|benchmark|against|best|worst|top|bottom/)
      ) {
        return [
          mk(
            'Client Revenue Ranking',
            'Total paid revenue per client — who drives your top line',
            'bar',
            'revenue',
            'client',
            0,
          ),
        ];
      }
      // Default client intelligence dashboard
      return [
        mk(
          'Top Clients by Revenue',
          'Total paid revenue per client — who drives your top line',
          'bar',
          'revenue',
          'client',
          0,
        ),
      ];
    }

    // ── 1. Overdue / AR / collection focus ───────────────────────────────────
    if (has(/overdue|aging|ar\b|receivable|collect|bad.?debt|payment.?risk/)) {
      return [
        mk(
          'Overdue AR Accumulation Trend',
          'Monthly overdue build-up — collection risk signal',
          'line',
          'overdue',
          'month',
          0,
        ),
      ];
    }

    // ── 2. Burn / runway / cash / venture focus ───────────────────────────────
    if (
      has(/burn|runway|cash|venture|fund|raise|investor|rule.?of.?40|survival/)
    ) {
      return [
        mk(
          'Venture Health Metrics',
          'Burn, runway, cash-on-hand, efficiency',
          'metric',
          'venture',
          'summary',
          0,
        ),
      ];
    }

    // ── 3. Quarterly analysis ─────────────────────────────────────────────────
    if (has(/quarter|q[1-4]\b|qoq|quarter.?over.?quarter|quarterly/)) {
      return [
        mk(
          'Quarterly Revenue Cadence',
          'Quarter-by-quarter revenue trend',
          'bar',
          'revenue',
          'quarter',
          0,
        ),
      ];
    }

    // ── 4. Entity / concentration / comparison focus ──────────────────────────
    if (
      has(
        /entity|entiti|concentrat|org\b|compan|which.*(most|top|best|worst)|top.*entit|who.*contribut/,
      )
    ) {
      return [
        mk(
          'Entity Revenue Concentration',
          'Revenue by entity',
          'bar',
          'revenue',
          'org',
          0,
        ),
      ];
    }

    // ── 5. Invoice volume / activity focus ───────────────────────────────────
    if (
      has(
        /invoice.?vol|invoice.?count|activity.?vol|number.?of.?invoice|how.?many.?invoice/,
      )
    ) {
      return [
        mk(
          'Invoice Volume Trend',
          'Monthly invoice count',
          'line',
          'invoice_count',
          'month',
          0,
        ),
      ];
    }

    // ── 6. Provider / ERP / source system focus ───────────────────────────────
    if (
      has(
        /provider|erp|xero|quickbooks|netsuite|source.?system|which.?system|integration/,
      )
    ) {
      return [
        mk(
          'Revenue by ERP Provider',
          'Revenue split across accounting integrations',
          'pie',
          'revenue',
          'provider',
          0,
        ),
      ];
    }

    // ── 7. Invoice health / AR portfolio / status focus ──────────────────────
    if (
      has(
        /invoice.?health|ar.?health|portfolio|paid.*unpaid|open.*invoice|status|collection.?rate|dso/,
      )
    ) {
      return [
        mk(
          'Invoice Portfolio Health',
          'Paid vs open vs overdue',
          'pie',
          'invoices',
          'status',
          0,
        ),
      ];
    }

    // ── 8. Revenue trend / growth / trajectory focus ─────────────────────────
    if (
      has(
        /revenue.?trend|revenue.?growth|revenue.?trajectory|growth.?trend|mom\b|month.?over.?month|yoy|year.?over.?year|revenue.?momentum|sales.?trend/,
      )
    ) {
      return [
        mk(
          'Revenue Trend',
          'Monthly revenue trend',
          'line',
          'revenue',
          'month',
          0,
        ),
      ];
    }

    // ── 9. Board / CFO / executive / comprehensive overview ──────────────────
    if (
      has(
        /board|cfo|executive|overview|health.?check|full.?analysis|comprehensive|complete|summary/,
      )
    ) {
      return [
        mk(
          'Revenue Trend',
          'Monthly revenue trend',
          'line',
          'revenue',
          'month',
          0,
        ),
      ];
    }

    // ── 10. General revenue / income / sales focus ───────────────────────────
    if (has(/revenue|income|sales|earning|arr|mrr|total.?revenue/)) {
      return [
        mk(
          'Revenue Trend',
          'Monthly revenue trend',
          'line',
          'revenue',
          'month',
          0,
        ),
      ];
    }

    // ── 11. Default — broad financial analysis ────────────────────────────────
    return [
      mk(
        'Revenue Trend',
        'Monthly revenue trend',
        'line',
        'revenue',
        'month',
        0,
      ),
    ];
  }

  // ─── Query-Aware Fallback Widgets (kept for edit plan validation only) ────

  private deriveQueryTitle(query: string): string {
    const q = query.toLowerCase();
    const has = (r: RegExp) => r.test(q);

    if (has(/client|customer|contact/)) return 'Top Client Revenue Analysis';
    if (has(/overdue|receivable|ar\b|aging|collection/))
      return 'Overdue AR & Collection Risk Analysis';
    if (has(/burn|runway|cash.*hand|cash.*flow/))
      return 'Cash Burn Rate & Runway Analysis';
    if (has(/quarter|q[1-4]\b|quarterly/))
      return 'Quarterly Revenue Performance';
    if (has(/entity|entities|concentrat|org\b/))
      return 'Entity Revenue Concentration Risk';
    if (has(/invoice.*vol|activity.*vol|volume/))
      return 'Invoice Volume & Activity Trends';
    if (has(/provider|erp|xero|quickbooks/))
      return 'ERP Provider Revenue Breakdown';
    if (has(/growth|trend|trajectory|momentum/))
      return 'Revenue Growth Trajectory';
    if (has(/revenue|income|sales/)) return 'Revenue Performance Analysis';
    if (has(/invoice|ar\b|receivable/)) return 'Invoice Portfolio Health';
    if (has(/board|cfo|overview|health|executive/))
      return 'Executive Financial Intelligence';
    if (has(/profit|margin|efficiency/))
      return 'Profitability & Efficiency Analysis';

    // Last resort: use first meaningful words from query
    const words = query.trim().split(/\s+/).slice(0, 6).join(' ');
    return words.length > 8
      ? words.charAt(0).toUpperCase() + words.slice(1)
      : 'Financial Analysis';
  }

  private buildPivotDashboardTitle(
    pivotType: ChartType,
    rowAxis: PivotAxis,
    colAxis: PivotAxis,
  ): string {
    const label = (axis: PivotAxis): string =>
      axis
        .split('_')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');

    if (pivotType === 'line') {
      return `Monthly ${label(colAxis)} Spend Trend`;
    }

    if (pivotType === 'treemap') {
      return `${label(rowAxis)} / ${label(colAxis)} Spend`;
    }

    if (pivotType === 'matrix') {
      return `${label(rowAxis)} by ${label(colAxis)} Matrix`;
    }

    return `${label(rowAxis)} by ${label(colAxis)} Heatmap`;
  }

  private normalizeDashboardTitle(
    candidate: string | null | undefined,
    query: string,
  ): string {
    const cleaned = String(candidate ?? '').replace(/\s+/g, ' ').trim();
    if (!cleaned) return this.deriveQueryTitle(query);

    const queryCleaned = query.replace(/\s+/g, ' ').trim().toLowerCase();
    const titleCleaned = cleaned.toLowerCase();
    const promptLike = /^(can you|could you|please|build|create|give me|show me|i[' ]?d like|i want)/i.test(
      cleaned,
    );

    if (promptLike || titleCleaned === queryCleaned) {
      return this.deriveQueryTitle(query);
    }

    return cleaned.slice(0, 100);
  }

  // ─── Dashboard → Session Lookup ───────────────────────────────────────────

  async getDashboardSession(
    dashboardId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ sessionId: string; sessionTitle: string } | null> {
    const request = await this.prisma.agentDashboardRequest.findFirst({
      where: {
        generatedDashboardId: dashboardId,
        organizationId,
      },
      include: {
        agentSession: true,
      },
      orderBy: { completedAt: 'desc' },
    });

    if (!request?.agentSession) return null;
    if (request.agentSession.userId !== userId) return null;

    return {
      sessionId: request.agentSession.id,
      sessionTitle: request.agentSession.title ?? 'Agent Session',
    };
  }

  // thin alias — all callers now route through selectWidgetsForQuery
  private queryAwareFallbackWidgets(
    query: string,
  ): AgentPlan['dashboard']['widgets'] {
    return this.selectWidgetsForQuery(query);
  }

  // ─── Deterministic fallback tool selection ───────────────────────────────
  // Used only when Ollama fails both attempts.

  private selectToolsForQuery(query: string): string[] {
    const q = query.toLowerCase();
    const has = (r: RegExp) => r.test(q);
    const tools = new Set<string>([
      'financial_summary',
      'revenue_trend',
      'invoice_breakdown',
    ]);
    if (has(/entity|entities|org\b|compan|concentrat|who|which/))
      tools.add('entity_comparison');
    if (has(/burn|runway|cash|venture|fund|raise|investor/))
      tools.add('venture_metrics');
    if (has(/client|customer|contact/)) {
      tools.add('client_financial_profile');
      tools.add('client_breakdown');
    }
    if (has(/board|cfo|overview|comprehensive|executive/)) {
      tools.add('entity_comparison');
      tools.add('venture_metrics');
    }
    return Array.from(tools);
  }

  // ─── Live Data Context — pre-flight summary given to Ollama before planning ──
  // Runs fast parallel ClickHouse queries so the LLM sees real numbers and can
  // make data-aware chart decisions (e.g. "12 clients with $45K overdue → show overdue chart").

  private async getDataContext(
    organizationId: string,
    scope?: OrgScope,
    range?: TimeRange,
    clientFilter?: { name: string; nameLower: string },
    entityFilter?: { orgId: string; orgName: string; orgNameLower: string },
  ): Promise<string> {
    try {
      const resolvedScope =
        scope ?? (await this.getOrgScope(organizationId, 'ADMIN'));
      if (resolvedScope.connectionIds.length === 0)
        return 'No ERP connections found.';

      const orgIds =
        resolvedScope.externalOrgIds.length > 0
          ? resolvedScope.externalOrgIds
          : ['__none__'];
      const tenantId = resolvedScope.tenantId;
      const time = this.timeWhereOn('issued_at', range);
      const client = clientFilter
        ? `AND lowerUTF8(contact_name) = {clientName:String}`
        : '';
      const clientDim = clientFilter
        ? `AND lowerUTF8(client_name) = {clientName:String}`
        : '';
      const clientParam = clientFilter
        ? { clientName: clientFilter.nameLower }
        : {};
      const entity = entityFilter ? `AND org_id = {orgId:String}` : '';
      const entityParam = entityFilter ? { orgId: entityFilter.orgId } : {};

      const [summary, topClients, entities, journalCtx] =
        await Promise.allSettled([
          this.queryRows<any>(
            `SELECT
	             count()                                                                AS total_invoices,
	             round(coalesce(sum(total_amount), 0), 0)                              AS total_revenue,
             formatDateTime(min(issued_at), '%Y-%m')                               AS date_from,
             formatDateTime(max(issued_at), '%Y-%m')                               AS date_to,
             round(coalesce(sumIf(total_amount,
               lowerUTF8(status) IN ('authorised','sent','needtosend','notset')
               AND (due_at IS NULL OR due_at >= now())), 0), 0)                    AS total_outstanding,
             round(coalesce(sumIf(total_amount,
               lowerUTF8(status) IN ('authorised','sent','needtosend','notset')
               AND due_at IS NOT NULL AND due_at < now()), 0), 0)                  AS total_overdue
		           FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
		           WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})
		             ${client}
		             ${entity}
		             AND issued_at IS NOT NULL
		             ${time}`,
            {
              tenantId,
              externalOrgIds: orgIds,
              ...clientParam,
              ...entityParam,
            },
          ),
          this.queryRows<any>(
            `SELECT client_name, round(total_invoiced, 0) AS billed, round(total_overdue, 0) AS overdue
	           FROM ${this.analyticsDb}.v_dim_clients_latest
	           WHERE tenant_id = {tenantId:String} AND org_id IN ({orgIds:Array(String)}) AND client_name != ''
	           ${clientDim}
	           ${entityFilter ? `AND org_id = {orgId:String}` : ''}
	           ORDER BY total_invoiced DESC
	           LIMIT ${clientFilter ? 1 : 5}`,
            { tenantId, orgIds, ...clientParam, ...entityParam },
          ),
          this.queryRows<any>(
            `SELECT coalesce(org_name, org_id) AS org_name, count() AS invoice_count
		           FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
		           WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})
		             ${client}
		             ${entity}
		             ${time}
		           GROUP BY org_name ORDER BY invoice_count DESC LIMIT 5`,
            {
              tenantId,
              externalOrgIds: orgIds,
              ...clientParam,
              ...entityParam,
            },
          ),
          // Journal lines context — expenses, P&L signals
          this.queryRows<any>(
            `SELECT
             round(sum(line_amount), 0) AS total_expenses,
             round(sumIf(line_amount,
               lowerUTF8(account_name) LIKE '%cost of%' OR lowerUTF8(account_name) LIKE '%cogs%'
               OR lowerUTF8(account_name) LIKE '%direct cost%' OR lowerUTF8(account_name) LIKE '%cost of goods%'
               OR lowerUTF8(account_name) LIKE '%cost of sales%' OR lowerUTF8(account_name) LIKE '%subcontract%'
             ), 0) AS total_cogs,
             count(DISTINCT account_name) AS expense_account_count,
             count(DISTINCT journal_id)   AS journal_count
           FROM ${this.analyticsDb}.v_fact_accounting_journal_lines_enriched_latest
           WHERE tenant_id = {tenantId:String} AND org_id IN ({orgIds:Array(String)})
             ${entityFilter ? `AND org_id = {orgId:String}` : ''}
             AND line_amount > 0
             AND journal_date IS NOT NULL
             AND NOT (
               lowerUTF8(account_name) LIKE '%receivable%' OR lowerUTF8(account_name) LIKE '%payable%'
               OR lowerUTF8(account_name) LIKE '%cash%'    OR lowerUTF8(account_name) LIKE '%bank%'
               OR lowerUTF8(account_name) LIKE '%loan%'    OR lowerUTF8(account_name) LIKE '%retained%'
               OR lowerUTF8(account_name) LIKE '%equity%'  OR lowerUTF8(account_name) LIKE '%capital%'
               OR lowerUTF8(account_name) LIKE '%gst%'     OR lowerUTF8(account_name) LIKE '%vat%'
               OR lowerUTF8(account_name) LIKE '%rounding%'
             )`,
            { tenantId, orgIds, ...entityParam },
          ).catch(() => [] as any[]),
        ]);

      const s =
        (summary.status === 'fulfilled' ? summary.value[0] : null) ?? {};
      const clients = topClients.status === 'fulfilled' ? topClients.value : [];
      const ents = entities.status === 'fulfilled' ? entities.value : [];
      const jCtx =
        (journalCtx.status === 'fulfilled' ? journalCtx.value[0] : null) ?? {};

      const clientCount = clients.length;
      const topStr = clients
        .map(
          (c: any) =>
            `${c.client_name} ($${this.fmtK(this.num(c.billed))}${this.num(c.overdue) > 0 ? `, $${this.fmtK(this.num(c.overdue))} overdue` : ''})`,
        )
        .join('; ');
      const entStr = ents
        .map((e: any) => e.org_name)
        .filter(Boolean)
        .join(', ');

      const totalRev = this.num(s.total_revenue);
      const totalExp = this.num(jCtx.total_expenses ?? 0);
      const totalCogs = this.num(jCtx.total_cogs ?? 0);
      const journalCount = this.num(jCtx.journal_count ?? 0);
      const expAccountCount = this.num(jCtx.expense_account_count ?? 0);
      const netIncome = totalRev - totalExp;
      const grossProfit = totalRev - totalCogs;
      const hasJournalData = journalCount > 0;

      const plLines = hasJournalData
        ? [
            `- GL Journals: ${journalCount} entries | Expense Accounts: ${expAccountCount}`,
            `- Total Expenses: $${this.fmtK(totalExp)} | COGS: $${this.fmtK(totalCogs)} | OPEX: $${this.fmtK(totalExp - totalCogs)}`,
            `- Gross Profit: $${this.fmtK(grossProfit)}${totalRev > 0 ? ` (${Math.round((grossProfit / totalRev) * 100)}% margin)` : ''} | Net Income: $${this.fmtK(netIncome)}${totalRev > 0 ? ` (${Math.round((netIncome / totalRev) * 100)}% margin)` : ''}`,
          ]
        : [
            `- GL Journals: no journal lines synced yet (P&L/expense charts need Xero journal sync)`,
          ];

      return [
        `LIVE DATA CONTEXT:`,
        ...(clientFilter ? [`- Client scope: ${clientFilter.name}`] : []),
        ...(entityFilter ? [`- Entity scope: ${entityFilter.orgName}`] : []),
        `- Invoices: ${this.num(s.total_invoices)} total | Period: ${s.date_from ?? '?'} to ${s.date_to ?? '?'}`,
        `- Revenue: $${this.fmtK(this.num(s.total_revenue))} | Outstanding: $${this.fmtK(this.num(s.total_outstanding))} | Overdue: $${this.fmtK(this.num(s.total_overdue))}`,
        `- Clients: ${clientCount}${topStr ? ` | Top: ${topStr}` : ''}`,
        `- Entities: ${entStr || 'None connected'}`,
        ...plLines,
      ].join('\n');
    } catch {
      return '(Data context unavailable — proceed based on query intent)';
    }
  }

  private fmtK(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
    return String(Math.round(n));
  }

  // ─── EBPO live introspection ──────────────────────────────────────────────
  // For the EBPO sample org, feed the planner the REAL dimension values + a KPI
  // snapshot from the v_ebpo_* semantic views, so it writes accurate SQL against
  // those views and matches the reference dashboard with zero guessing. Returns
  // null when the org has no EBPO data (caller then uses GL introspection).
  private async introspectEbpoSchema(
    scope: OrgScope,
    db: string,
    params: { tenantId: string; externalOrgIds: string[] },
    orgWhere: string,
  ): Promise<string | null> {
    let range: any;
    try {
      const r = await this.queryRows<any>(
        `SELECT formatDateTime(min(period_date), '%Y-%m') AS from_d,
                formatDateTime(max(period_date), '%Y-%m') AS to_d,
                count() AS n
         FROM ${db}.v_ebpo_revenue_monthly WHERE ${orgWhere}`,
        params,
      );
      range = r?.[0];
    } catch {
      return null;
    }
    if (!range || this.num(range.n) === 0) return null;

    const distinct = async (col: string, view: string, extra = ''): Promise<string[]> => {
      try {
        const rows = await this.queryRows<any>(
          `SELECT DISTINCT ${col} AS v FROM ${db}.${view}
           WHERE ${orgWhere} AND ${col} != '' ${extra} ORDER BY v LIMIT 30`,
          params,
        );
        return rows.map((r) => String(r.v)).filter(Boolean);
      } catch {
        return [];
      }
    };

    const [
      businessUnits,
      contractTypes,
      industries,
      departments,
      countries,
      arBuckets,
      deliveryCenters,
      regions,
      glAccounts,
      topClients,
      topVendors,
      kpi,
    ] = await Promise.all([
      distinct('business_unit', 'v_ebpo_revenue_by_business_unit'),
      distinct('contract_type', 'v_ebpo_revenue_by_business_unit'),
      distinct('industry', 'v_ebpo_revenue_by_client'),
      distinct('department', 'v_ebpo_payroll_monthly'),
      distinct('country', 'v_ebpo_payroll_monthly'),
      distinct('aging_bucket', 'v_ebpo_ar_aging'),
      distinct('delivery_center', 'v_ebpo_operations_monthly'),
      distinct('region', 'v_ebpo_operations_monthly'),
      distinct('account_name', 'v_ebpo_gl_monthly'),
      this.queryRows<any>(
        `SELECT client_name, round(sum(total_revenue_usd), 0) AS rev
         FROM ${db}.v_ebpo_revenue_by_client WHERE ${orgWhere}
         GROUP BY client_name ORDER BY rev DESC LIMIT 12`,
        params,
      ).catch(() => [] as any[]),
      this.queryRows<any>(
        `SELECT vendor_name, round(sum(outstanding_balance_usd), 0) AS bal
         FROM ${db}.v_ebpo_ap_aging WHERE ${orgWhere} AND vendor_name != ''
         GROUP BY vendor_name ORDER BY bal DESC LIMIT 12`,
        params,
      ).catch(() => [] as any[]),
      this.queryRows<any>(
        `SELECT total_revenue_usd, gross_margin_pct, total_payroll_usd,
                ar_outstanding_usd, ap_outstanding_usd, free_cash_flow_usd,
                cash_balance_usd, dso_days, dpo_days, sla_compliance_pct,
                csat_pct, utilization_pct, formatDateTime(period_date, '%Y-%m') AS period
         FROM ${db}.v_ebpo_kpi_monthly WHERE ${orgWhere}
         ORDER BY period_date DESC LIMIT 1`,
        params,
      ).catch(() => [] as any[]),
    ]);

    const lines: string[] = [];
    lines.push(
      'LIVE DATASET: EBPO Enterprise BPO (use ONLY the v_ebpo_* semantic views below — this org has NO sample_gl_dump / sample_trial_balance / invoice data).',
    );
    lines.push(
      `• Period coverage: ${range.from_d} → ${range.to_d} (${this.num(range.n)} monthly rows). Revenue/cost/margin in USD.`,
    );
    const k = (kpi as any[])?.[0];
    if (k) {
      lines.push(
        `• Latest KPI snapshot (${k.period}): revenue $${this.fmtK(this.num(k.total_revenue_usd))}, ` +
          `gross margin ${this.num(k.gross_margin_pct).toFixed(1)}%, payroll $${this.fmtK(this.num(k.total_payroll_usd))}, ` +
          `AR $${this.fmtK(this.num(k.ar_outstanding_usd))}, AP $${this.fmtK(this.num(k.ap_outstanding_usd))}, ` +
          `free cash flow $${this.fmtK(this.num(k.free_cash_flow_usd))}, cash $${this.fmtK(this.num(k.cash_balance_usd))}, ` +
          `DSO ${this.num(k.dso_days).toFixed(0)}d, DPO ${this.num(k.dpo_days).toFixed(0)}d, ` +
          `SLA ${this.num(k.sla_compliance_pct).toFixed(1)}%, CSAT ${this.num(k.csat_pct).toFixed(1)}%, util ${this.num(k.utilization_pct).toFixed(1)}%`,
      );
    }
    if (businessUnits.length) lines.push(`• Business units: ${businessUnits.join(', ')}`);
    if (contractTypes.length) lines.push(`• Contract types: ${contractTypes.join(', ')}`);
    if (industries.length) lines.push(`• Client industries: ${industries.join(', ')}`);
    if ((topClients as any[]).length) {
      lines.push(
        `• Top clients by revenue: ${(topClients as any[])
          .map((c) => `${c.client_name} ($${this.fmtK(this.num(c.rev))})`)
          .join(' | ')}`,
      );
    }
    if (departments.length) lines.push(`• Payroll departments: ${departments.join(', ')}`);
    if (countries.length) lines.push(`• Countries: ${countries.join(', ')}`);
    if (deliveryCenters.length) lines.push(`• Delivery centers: ${deliveryCenters.join(', ')}`);
    if (regions.length) lines.push(`• Regions: ${regions.join(', ')}`);
    if (arBuckets.length) lines.push(`• AR/AP aging buckets: ${arBuckets.join(', ')}`);
    if ((topVendors as any[]).length) {
      lines.push(
        `• Top AP vendors by outstanding: ${(topVendors as any[])
          .map((v) => `${v.vendor_name} ($${this.fmtK(this.num(v.bal))})`)
          .join(' | ')}`,
      );
    }
    if (glAccounts.length) lines.push(`• GL account names: ${glAccounts.slice(0, 20).join(', ')}`);
    lines.push(
      'VIEWS (all require: tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})): ' +
        'v_ebpo_kpi_monthly, v_ebpo_revenue_monthly (includes revenue_yoy_pct — pre-computed YoY growth %, null for the first 12 months; use it directly for YoY-growth charts), v_ebpo_revenue_by_client, v_ebpo_revenue_by_business_unit, ' +
        'v_ebpo_revenue_by_business_unit_monthly (period_date + business_unit + contract_type + revenue/cost/margin — use for monthly revenue by business unit, monthly gross-margin heatmaps, and monthly revenue mix), ' +
        'v_ebpo_revenue_by_client_contract (client_name + contract_type + business_unit + total_revenue_usd + gross_margin_pct — use for revenue by client broken down/stacked by contract type), ' +
        'v_ebpo_revenue_by_client_contract_monthly (period_date + client_name + contract_type + business_unit — use for monthly revenue by contract type/client), ' +
        'v_ebpo_payroll_monthly (use sum(total_overtime_usd) for overtime cost and sum(total_payroll_usd)/sum(employee_count) for payroll cost per employee), ' +
        'v_ebpo_employee_headcount (department + country + delivery_center + grade + employee_count — use for employee-count charts), ' +
        'v_ebpo_department_efficiency_monthly (department + month + revenue_per_employee_usd + cost_per_employee_usd), ' +
        'v_ebpo_business_unit_efficiency (business_unit + revenue_per_employee_usd), ' +
        'v_ebpo_delivery_center_efficiency_monthly (delivery_center + allocated_revenue_usd + revenue_per_employee_usd + utilization_pct), ' +
        'v_ebpo_client_revenue_collection (client revenue/margin + collection_rate_pct), ' +
        'v_ebpo_salary_by_dept_grade (department + grade + avg_monthly_salary_usd + employee_count — use for avg-salary heatmap/matrix by department x grade), ' +
        'v_ebpo_gl_monthly, v_ebpo_trial_balance_monthly (opening/closing/debit/credit/net movement by account and month), v_ebpo_ar_aging, v_ebpo_ap_aging, v_ebpo_operations_monthly (calls, tickets, avg_aht_minutes, SLA, CSAT, utilization), ' +
        'v_ebpo_cash_flow_monthly, v_ebpo_fixed_assets_by_center (asset_cost, accumulated_depreciation, net_book_value, depreciation_pct by delivery_center and asset_type). ' +
        'Group time series by period_date (already a Date). Output shape: x/category column AS name, metric AS value (or sumIf pivots for multi-series).',
    );
    return lines.join('\n');
  }

  // Probe: does this org carry the rich EBPO dataset (employees, regions, AR/AP,
  // cash flow, payroll)? Used both to relax the missing-dataset clarification
  // gates and to route introspection to the EBPO semantic views.
  private async orgHasEbpoData(scope: OrgScope): Promise<boolean> {
    if (scope.externalOrgIds.length === 0) return false;
    try {
      const rows = await this.queryRows<any>(
        `SELECT count() AS n FROM ${this.analyticsDb}.v_ebpo_revenue_monthly
         WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})
         LIMIT 1`,
        { tenantId: scope.tenantId, externalOrgIds: scope.externalOrgIds },
      );
      return this.num(rows?.[0]?.n) > 0;
    } catch {
      return false;
    }
  }

  // ─── Live schema introspection — feeds real dimension values to the SQL planner
  private async introspectLiveSchema(scope: OrgScope): Promise<string> {
    if (scope.externalOrgIds.length === 0) return '';
    const db = this.analyticsDb;
    const params = {
      tenantId: scope.tenantId,
      externalOrgIds: scope.externalOrgIds,
    };
    const orgWhere = `tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})`;

    // EBPO sample org → use the dedicated semantic-view introspection so the
    // planner writes SQL against v_ebpo_* and matches the reference dashboard.
    // (GL-shaped introspection below returns nothing for an EBPO-only org.)
    const ebpoContext = await this.introspectEbpoSchema(scope, db, params, orgWhere);
    if (ebpoContext) return ebpoContext;

    try {
      const [
        dateRange,
        departments,
        vendors,
        expenseAccts,
        revenueAccts,
        jTypes,
        invoiceSummary,
        topClients,
        tbSummary,
        tbAccounts,
        glDepts,
        glClasses,
        glVendors,
        glJournalTypes,
        glMonthlyDept,
        glDateRange,
      ] = await Promise.allSettled([
        // ── Journal lines (v_fact) ──────────────────────────────────────────────
        this.queryRows<any>(
          `SELECT formatDateTime(min(journal_date), '%Y-%m') AS from_d,
                  formatDateTime(max(journal_date), '%Y-%m') AS to_d,
                  count() AS cnt
           FROM ${db}.v_fact_accounting_journal_lines_latest
           WHERE ${orgWhere} AND journal_date IS NOT NULL`,
          params,
        ),
        this.queryRows<any>(
          `SELECT DISTINCT COALESCE(NULLIF(department,''),'(none)') AS dept
           FROM ${db}.v_fact_accounting_journal_lines_latest
           WHERE ${orgWhere} AND department != ''
           ORDER BY dept LIMIT 20`,
          params,
        ),
        this.queryRows<any>(
          `SELECT COALESCE(NULLIF(vendor_name,''),'Other') AS vname,
                  round(sum(toFloat64(line_amount)), 0) AS spend
           FROM ${db}.v_fact_accounting_journal_lines_latest
           WHERE ${orgWhere} AND source_type IN ('OPEX','COGS') AND vendor_name != ''
             AND lowerUTF8(vendor_name) NOT IN ('payroll')
           GROUP BY vname ORDER BY spend DESC LIMIT 12`,
          params,
        ),
        this.queryRows<any>(
          `SELECT account_name,
                  round(sum(toFloat64(line_amount)), 0) AS total
           FROM ${db}.v_fact_accounting_journal_lines_latest
           WHERE ${orgWhere} AND source_type IN ('OPEX','COGS') AND account_name != ''
           GROUP BY account_name ORDER BY total DESC LIMIT 15`,
          params,
        ),
        this.queryRows<any>(
          `SELECT account_name,
                  round(abs(sum(toFloat64(line_amount))), 0) AS total
           FROM ${db}.v_fact_accounting_journal_lines_latest
           WHERE ${orgWhere} AND source_type = 'REV' AND account_name != ''
           GROUP BY account_name ORDER BY total DESC LIMIT 10`,
          params,
        ),
        this.queryRows<any>(
          `SELECT DISTINCT source_type
           FROM ${db}.v_fact_accounting_journal_lines_latest
           WHERE ${orgWhere} AND source_type != ''
           ORDER BY source_type LIMIT 15`,
          params,
        ),
        this.queryRows<any>(
          `SELECT count() AS inv_count,
                  round(coalesce(sum(total_amount), 0), 0) AS inv_revenue,
                  formatDateTime(min(issued_at), '%Y-%m') AS from_d,
                  formatDateTime(max(issued_at), '%Y-%m') AS to_d
           FROM ${db}.v_fact_accounting_invoices_latest
           WHERE ${orgWhere} AND issued_at IS NOT NULL AND total_amount > 0`,
          params,
        ),
        this.queryRows<any>(
          `SELECT client_name, round(total_invoiced, 0) AS billed
           FROM ${db}.v_dim_clients_latest
           WHERE ${orgWhere} AND client_name != ''
           ORDER BY total_invoiced DESC LIMIT 8`,
          params,
        ),
        // ── sample_trial_balance (authoritative P&L / Balance Sheet totals) ────
        this.queryRows<any>(
          `SELECT
             round(abs(sumIf(toFloat64(net_balance), account_type = 'Income')), 0) AS revenue,
             round(sumIf(toFloat64(net_balance), account_type = 'Cost of Goods Sold'), 0) AS cogs,
             round(sumIf(toFloat64(net_balance), account_type = 'Expense'), 0) AS opex,
             round(sumIf(toFloat64(net_balance), account_type IN ('Bank','Accounts Receivable','Other Current Asset','Fixed Asset','Other Asset')), 0) AS total_assets,
             round(abs(sumIf(toFloat64(net_balance), account_type IN ('Accounts Payable','Other Current Liability','Long Term Liability'))), 0) AS total_liabilities,
             round(abs(sumIf(toFloat64(net_balance), account_type = 'Equity')), 0) AS total_equity
           FROM ${db}.sample_trial_balance
           WHERE ${orgWhere}`,
          params,
        ),
        this.queryRows<any>(
          `SELECT account_type, account_name, round(abs(toFloat64(net_balance)), 0) AS balance
           FROM ${db}.sample_trial_balance
           WHERE ${orgWhere}
           ORDER BY account_type, balance DESC LIMIT 46`,
          params,
        ),
        // ── sample_gl_dump (exact department / class / vendor data) ─────────────
        // Power BI "Spend by Dept" = ALL debits (Admin=374,580, Ops=716,470, Sales=216,196)
        this.queryRows<any>(
          `SELECT department, round(sum(toFloat64(debit)), 0) AS spend
           FROM ${db}.sample_gl_dump
           WHERE ${orgWhere} AND department != '' AND toFloat64(debit) > 0
           GROUP BY department ORDER BY spend DESC LIMIT 10`,
          params,
        ),
        this.queryRows<any>(
          `SELECT class, round(sum(toFloat64(debit)), 0) AS spend
           FROM ${db}.sample_gl_dump
           WHERE ${orgWhere} AND class != ''
           GROUP BY class ORDER BY spend DESC LIMIT 10`,
          params,
        ),
        this.queryRows<any>(
          // Power BI Total Vendor Spend = SUM(debit) ALL types — no account_type filter
          `SELECT vendor_customer AS vname, round(sum(toFloat64(debit)), 0) AS spend
           FROM ${db}.sample_gl_dump
           WHERE ${orgWhere} AND vendor_customer != '' AND toFloat64(debit) > 0
           GROUP BY vendor_customer ORDER BY spend DESC LIMIT 15`,
          params,
        ),
        this.queryRows<any>(
          `SELECT DISTINCT journal_type FROM ${db}.sample_gl_dump WHERE ${orgWhere} ORDER BY journal_type LIMIT 10`,
          params,
        ),
        // Monthly dept totals from gl_dump (for accurate monthly pivot examples)
        this.queryRows<any>(
          `SELECT formatDateTime(toStartOfMonth(date), '%b %Y') AS month,
                  department,
                  round(sum(toFloat64(debit)), 0) AS spend
           FROM ${db}.sample_gl_dump
           WHERE ${orgWhere} AND department != '' AND toFloat64(debit) > 0
           GROUP BY toStartOfMonth(date), department
           ORDER BY toStartOfMonth(date) ASC, spend DESC LIMIT 48`,
          params,
        ),
        // Date range from gl_dump
        this.queryRows<any>(
          `SELECT formatDateTime(min(date), '%Y-%m') AS from_d,
                  formatDateTime(max(date), '%Y-%m') AS to_d
           FROM ${db}.sample_gl_dump WHERE ${orgWhere} AND date IS NOT NULL`,
          params,
        ),
      ]);

      const dr = dateRange.status === 'fulfilled' ? dateRange.value[0] : null;
      const depts =
        departments.status === 'fulfilled'
          ? departments.value.map((r: any) => r.dept).filter(Boolean)
          : [];
      const vends = vendors.status === 'fulfilled' ? vendors.value : [];
      const expAs =
        expenseAccts.status === 'fulfilled' ? expenseAccts.value : [];
      const revAs =
        revenueAccts.status === 'fulfilled' ? revenueAccts.value : [];
      const jtps =
        jTypes.status === 'fulfilled'
          ? jTypes.value.map((r: any) => r.source_type).filter(Boolean)
          : [];
      const inv =
        invoiceSummary.status === 'fulfilled' ? invoiceSummary.value[0] : null;
      const clts = topClients.status === 'fulfilled' ? topClients.value : [];
      const tb = tbSummary.status === 'fulfilled' ? tbSummary.value[0] : null;
      const tbAc = tbAccounts.status === 'fulfilled' ? tbAccounts.value : [];
      const glDs = glDepts.status === 'fulfilled' ? glDepts.value : [];
      const glCs = glClasses.status === 'fulfilled' ? glClasses.value : [];
      const glVs = glVendors.status === 'fulfilled' ? glVendors.value : [];
      const glJts =
        glJournalTypes.status === 'fulfilled'
          ? glJournalTypes.value.map((r: any) => r.journal_type).filter(Boolean)
          : [];
      const glMD =
        glMonthlyDept.status === 'fulfilled' ? glMonthlyDept.value : [];
      const glDR =
        glDateRange.status === 'fulfilled' ? glDateRange.value[0] : null;

      const lines: string[] = [
        'LIVE DATA CONTEXT — use these real values in SQL and chart titles:',
      ];

      // ── Trial Balance P&L totals (authoritative) ──────────────────────────────
      if (tb) {
        const rev = this.num(tb.revenue);
        const cogs = this.num(tb.cogs);
        const opex = this.num(tb.opex);
        const gp = rev - cogs;
        const ni = gp - opex;
        lines.push(
          `• AUTHORITATIVE P&L (from sample_trial_balance): Revenue=$${this.fmtK(rev)} | COGS=$${this.fmtK(cogs)} | Operating Expenses=$${this.fmtK(opex)} | Gross Profit=$${this.fmtK(gp)} | Net Income=$${this.fmtK(ni)}`,
        );
        lines.push(
          `• AUTHORITATIVE Balance Sheet: Total Assets=$${this.fmtK(this.num(tb.total_assets))} | Total Liabilities=$${this.fmtK(this.num(tb.total_liabilities))} | Total Equity=$${this.fmtK(this.num(tb.total_equity))}`,
        );
      }

      // ── Trial Balance accounts by type ────────────────────────────────────────
      if (tbAc.length > 0) {
        const byType = new Map<
          string,
          Array<{ name: string; balance: number }>
        >();
        for (const r of tbAc) {
          const at = String(r.account_type);
          if (!byType.has(at)) byType.set(at, []);
          byType
            .get(at)!
            .push({
              name: String(r.account_name),
              balance: this.num(r.balance),
            });
        }
        const typeLines: string[] = [];
        for (const [at, accts] of byType.entries()) {
          typeLines.push(
            `${at}: ${accts
              .slice(0, 5)
              .map((a) => `${a.name} ($${this.fmtK(a.balance)})`)
              .join(', ')}`,
          );
        }
        lines.push(
          `• sample_trial_balance account types → ${typeLines.join(' | ')}`,
        );
      }

      // ── GL dump context ────────────────────────────────────────────────────────
      if (glDR) {
        lines.push(
          `• sample_gl_dump date range: ${glDR.from_d} → ${glDR.to_d} — USE THESE DATES for time filtering`,
        );
      }
      if (glDs.length > 0) {
        const ds = glDs
          .map((r: any) => `${r.department} ($${this.fmtK(this.num(r.spend))})`)
          .join(', ');
        lines.push(
          `• sample_gl_dump departments (EXACT names, NO Finance): ${ds}`,
        );
      }
      if (glCs.length > 0) {
        const cs = glCs
          .map((r: any) => `${r.class} ($${this.fmtK(this.num(r.spend))})`)
          .join(', ');
        lines.push(`• sample_gl_dump classes (EXACT names): ${cs}`);
      }
      if (glVs.length > 0) {
        const vs = glVs
          .slice(0, 12)
          .map((r: any) => `${r.vname} ($${this.fmtK(this.num(r.spend))})`)
          .join(' | ');
        lines.push(`• Top vendors (sample_gl_dump.vendor_customer): ${vs}`);
      }
      if (glJts.length > 0) {
        lines.push(`• sample_gl_dump journal_type values: ${glJts.join(', ')}`);
      }
      // Monthly department breakdown (last 3 months sample for LLM context)
      if (glMD.length > 0) {
        const byMonth = new Map<string, Record<string, number>>();
        for (const r of glMD) {
          const m = String(r.month);
          if (!byMonth.has(m)) byMonth.set(m, {});
          byMonth.get(m)![String(r.department)] = this.num(r.spend);
        }
        const months = Array.from(byMonth.keys()).slice(-3);
        const deptNames = [
          ...new Set(glMD.map((r: any) => String(r.department))),
        ];
        if (months.length > 0) {
          const sample = months
            .map((m) => {
              const row = byMonth.get(m)!;
              const cols = deptNames
                .map((d) => `${d}=$${this.fmtK(row[d] ?? 0)}`)
                .join(', ');
              return `${m}: ${cols}`;
            })
            .join(' | ');
          lines.push(
            `• Monthly dept spend from sample_gl_dump (use sumIf pivot, ONE chart): ${sample}`,
          );
        }
        lines.push(
          `• Dept column names for SQL: ${deptNames.map((d) => d.toLowerCase().replace(/\s+/g, '_')).join(', ')}`,
        );
      }

      // ── Journal lines / invoice context ───────────────────────────────────────
      if (dr?.cnt > 0)
        lines.push(
          `• GL journal entries: ${dr.cnt} rows | Period: ${dr.from_d} → ${dr.to_d}`,
        );
      if (this.num(inv?.inv_count) > 0)
        lines.push(
          `• Invoices: ${inv.inv_count} total | Revenue: $${this.fmtK(this.num(inv.inv_revenue))} | Period: ${inv.from_d} → ${inv.to_d}`,
        );
      if (depts.length > 0)
        lines.push(
          `• Departments in journal lines (use exact names): ${depts.join(', ')}`,
        );
      if (jtps.length > 0)
        lines.push(`• Journal source_type values: ${jtps.join(', ')}`);
      if (expAs.length > 0) {
        const top = expAs
          .slice(0, 10)
          .map(
            (a: any) => `${a.account_name} ($${this.fmtK(this.num(a.total))})`,
          )
          .join(' | ');
        lines.push(
          `• Top expense accounts (source_type IN ('OPEX','COGS'), line_amount > 0): ${top}`,
        );
      }
      if (revAs.length > 0) {
        const top = revAs
          .slice(0, 8)
          .map(
            (a: any) => `${a.account_name} ($${this.fmtK(this.num(a.total))})`,
          )
          .join(' | ');
        lines.push(
          `• Revenue accounts (source_type = 'REV', use abs(line_amount)): ${top}`,
        );
      }
      if (vends.length > 0) {
        const top = vends
          .slice(0, 10)
          .map((v: any) => `${v.vname} ($${this.fmtK(this.num(v.spend))})`)
          .join(' | ');
        lines.push(`• Top vendors in journal lines (secondary): ${top}`);
      }
      if (clts.length > 0) {
        const top = clts
          .slice(0, 6)
          .map(
            (c: any) => `${c.client_name} ($${this.fmtK(this.num(c.billed))})`,
          )
          .join(' | ');
        lines.push(`• Top clients by invoiced: ${top}`);
      }

      return lines.join('\n');
    } catch {
      return '';
    }
  }

  // ─── Smart SQL planner — primary agent path ──────────────────────────────────
  // Introspects live ClickHouse data, then has the LLM write exact SQL for each
  // chart. Every widget returned has _sql set and metric='dynamic'.
  // Returns a structured outcome: build / clarify / no_data. Returns null ONLY
  // when the planner itself is unavailable (Ollama offline) so callers can fall
  // back. A confident "build", an honest "no_data", and a focused "clarify" are
  // all valid first-class results — never a guessed chart.
  // ─── Phase 2: spec-first planner ────────────────────────────────────────────
  // Instead of free-writing SQL, the LLM emits a small ChartSpec chosen ONLY from
  // the catalog; compileSpec turns it into deterministic, scoped SQL. The model
  // cannot reference a column that doesn't exist, and a request needing
  // unavailable data is refused by catalog lookup. Returns a SmartPlanResult so it
  // slots into the existing create path; null = unavailable → caller falls back.
  // Chart classes the spec compiler faithfully models (measure × dimension ×
  // optional breakdown). Anything else — multi-widget dashboards, waterfall,
  // treemap hierarchies, sunburst — must defer
  // to the proven legacy planner rather than risk a confident wrong chart.
  private static readonly SPEC_SUPPORTED_TYPES: ReadonlySet<string> = new Set([
    'bar',
    'horizontal_bar',
    'line',
    'area',
    'pie',
    'donut',
    'heatmap',
    'matrix',
    'stacked_bar',
    'stacked_area',
    // Single-dimension treemap = name+value (compiler models it). A 2-level
    // (breakdown) treemap hierarchy is still deferred — see the breakdown guard.
    'treemap',
    // Combo / dual-axis — used for multi-measure specs (measures[]) where one
    // series renders as bars and the rest as lines.
    'combo',
    // Scatter / bubble — measure-vs-measure(-vs-size) per point, produced from a
    // multi-measure spec (measures[]) emitting name/x/y/z columns.
    'scatter',
    'bubble',
    // Single-widget scorecards: multi-measure specs with no dimension compile to
    // name/value KPI rows. Multi-widget dashboards still defer to the legacy path.
    'kpi',
  ]);

  // A treemap with a breakdown is a 2-level hierarchy the compiler doesn't model
  // (it would emit a WIDE pivot, not a hierarchy) — defer those to legacy.
  private specCanModelChart(spec: ChartSpec): boolean {
    const ct = String(spec.chartType ?? '').toLowerCase();
    if (!AgentService.SPEC_SUPPORTED_TYPES.has(ct)) return false;
    if (ct === 'treemap' && spec.breakdown) return false;
    if (ct === 'kpi' && spec.dimension) return false;
    return true;
  }

  // Decline (→ legacy fallback) when the REQUEST is for a multi-widget dashboard
  // or a chart type the spec compiler doesn't model.
  private specModeCanHandle(query: string): boolean {
    const q = String(query ?? '').toLowerCase();
    const wantsSingleScorecard = /\b(scorecard|kpis?|kpi\s+cards?)\b/.test(q);
    if (
      /\b(dashboard|executive|c-?suite|board\s+deck|multiple\s+charts|several\s+charts|set\s+of\s+charts|a\s+few\s+charts)\b/.test(
        q,
      ) &&
      !wantsSingleScorecard
    )
      return false;
    // scatter/bubble ARE handled by the spec compiler now (multi-measure x/y/z), so
    // they're no longer deferred. Waterfall and gauge/funnel/sunburst remain legacy.
    if (
      /\b(waterfall|sun\s*burst|gauge|funnel)\b/.test(
        q,
      )
    )
      return false;
    return true;
  }

  private async buildEbpoScorecardPlan(
    query: string,
    scope: OrgScope,
  ): Promise<SmartPlanResult | null> {
    const scorecardMeasures = this.detectEbpoScorecardMeasures(query);
    if (scorecardMeasures.length === 0) return null;
    const spec: ChartSpec = {
      measure: scorecardMeasures[0],
      measures: scorecardMeasures,
      dimension: '',
      chartType: 'kpi',
    };
    if (!this.specCanModelChart(spec)) return null;
    const runRows = (sql: string) =>
      this.queryRows<Record<string, unknown>>(sql, {
        tenantId: scope.tenantId,
        externalOrgIds: scope.externalOrgIds,
      });
    const compiled = await compileEbpoSpec(spec, this.analyticsDb, runRows);
    if (!compiled.ok) return null;
    const check = await this.executeDynamicSqlChecked(compiled.sql, scope, {
      chartType: 'kpi',
    }).catch(() => null);
    if (!check || check.error || check.rows.length === 0) return null;

    const title = /\bscorecard\b/i.test(query) ? 'EBPO Scorecard' : 'EBPO KPI Cards';
    this.logger.log(
      `[SpecPlan:EBPO-scorecard] built "${title}" from measures ${scorecardMeasures.join(',')}`,
    );
    return {
      kind: 'build',
      plan: {
        tools_to_execute: [],
        should_generate_dashboard: true,
        dashboard: {
          title,
          description: '',
          widgets: [
            {
              title,
              description: '',
              type: 'kpi',
              metric: 'dynamic',
              grouping: 'dynamic',
              display_order: 0,
              _sql: compiled.sql,
              _spec: spec,
              display: {
                valueFormat: compiled.measure.format,
                ...(typeof (compiled.measure as { decimals?: number }).decimals === 'number'
                  ? { valueDecimals: (compiled.measure as { decimals?: number }).decimals }
                  : {}),
              },
            } as any,
          ],
        },
        analysis_focus: query,
      },
    };
  }

  // Deterministic EBPO create path for the specific CFO/capacity questions the
  // workbook asks over and over. This is intentionally catalog-backed: every
  // branch resolves to a real catalog measure or a transparent derived formula
  // built from existing views, so it can run without the model and still match
  // Power BI.
  private async buildEbpoSemanticPlan(
    query: string,
    scope: OrgScope,
  ): Promise<SmartPlanResult | null> {
    type SmartPlanWidget = AgentPlan['dashboard']['widgets'][number];
    const qLow = query.toLowerCase();
    const forcedChartType = this.parseExplicitChartConstraints(query)?.requiredTypes?.[0] as
      | ChartType
      | undefined;
    const runRows = (sql: string) =>
      this.queryRows<Record<string, unknown>>(sql, {
        tenantId: scope.tenantId,
        externalOrgIds: scope.externalOrgIds,
      });
    const build = async (
      spec: ChartSpec,
      title: string,
      description: string,
    ): Promise<SmartPlanResult | null> => {
      const compiled = await compileEbpoSpec(spec, this.analyticsDb, runRows);
      if (!compiled.ok) return null;
      const chartType = (spec.chartType ?? 'bar') as ChartType;
      const check = await this.executeDynamicSqlChecked(compiled.sql, scope, {
        chartType,
      }).catch(() => null);
      if (!check || check.error || check.rows.length === 0) return null;
      if (this.detectBadChartShape(check.rows, chartType)) return null;
      return {
        kind: 'build',
        plan: {
          tools_to_execute: [],
          should_generate_dashboard: true,
          dashboard: {
            title,
            description,
            widgets: [
              {
                title: title.slice(0, 80),
                description,
                type: chartType,
                metric: 'dynamic',
                grouping: 'dynamic',
                display_order: 0,
                _sql: compiled.sql,
                _spec: spec,
                display: {
                  valueFormat: compiled.measure.format,
                  ...(typeof (compiled.measure as { decimals?: number }).decimals === 'number'
                    ? { valueDecimals: (compiled.measure as { decimals?: number }).decimals }
                    : {}),
                },
              } as any,
            ],
          },
          analysis_focus: query,
        },
      };
    };

    if (
      /\b(dashboard|overview|summary|scorecard|kpi)\b/.test(qLow) &&
      /\b(liquidity|profitability|efficiency|cash\s+conversion|cash\s+position|employee\s+efficiency)\b/.test(
        qLow,
      )
    ) {
      const widgets: SmartPlanWidget[] = [];
      const buildWidget = async (
        spec: ChartSpec,
        title: string,
        description: string,
      ) => {
        const built = await build(spec, title, description);
        if (!built || built.kind !== 'build') return null;
        return built.plan.dashboard.widgets[0] ?? null;
      };
      if (/\bliquidity\b|\bcash\s+position\b/.test(qLow)) {
        const liquidity = await buildWidget(
          {
            measure: 'cash_balance',
            measures: ['cash_balance', 'working_capital', 'ar_outstanding', 'ap_outstanding'],
            dimension: '',
            chartType: 'kpi',
          },
          'Liquidity Snapshot',
          'Cash balance, working capital, receivables, and payables',
        );
        if (liquidity) widgets.push(liquidity);
      }
      if (/\bprofitability\b/.test(qLow)) {
        const profitability = await buildWidget(
          {
            measure: 'gross_margin_pct',
            measures: [
              'gross_margin_pct',
              'ebitda_style_margin_pct',
              'free_cash_flow',
              'total_revenue',
              'total_cost',
            ],
            dimension: '',
            chartType: 'kpi',
          },
          'Profitability Snapshot',
          'Gross margin, EBITDA-style margin, revenue, and cost',
        );
        if (profitability) widgets.push(profitability);
      }
      if (/\befficiency\b|\bemployee\s+efficiency\b/.test(qLow)) {
        const efficiency = await buildWidget(
          {
            measure: 'revenue_per_employee',
            measures: ['revenue_per_employee', 'cost_per_employee'],
            dimension: '',
            chartType: 'kpi',
          },
          'Employee Efficiency Snapshot',
          'Revenue per employee and cost per employee',
        );
        if (efficiency) widgets.push(efficiency);
      }
      if (/\bcash\s+conversion\b/.test(qLow)) {
        const cashConversion = await buildWidget(
          {
            measure: 'operating_cf_to_revenue_pct',
            measures: ['operating_cf_to_revenue_pct', 'payroll_to_revenue_pct'],
            dimension: '',
            chartType: 'kpi',
          },
          'Cash Conversion Snapshot',
          'Operating cash flow and payroll as a percentage of revenue',
        );
        if (cashConversion) widgets.push(cashConversion);
      }
      if (widgets.length >= 2) {
        return {
          kind: 'build',
          plan: {
            tools_to_execute: [],
            should_generate_dashboard: true,
            dashboard: {
              title: 'EBPO Executive Dashboard',
              description: 'Liquidity, profitability, efficiency, and cash conversion from verified EBPO measures',
              widgets,
            },
            analysis_focus: query,
          },
        };
      }
    }

    const explicitTypes = this.parseExplicitChartConstraints(query)?.requiredTypes ?? [];
    const chartType =
      (explicitTypes[0] as ChartType | undefined) ??
      (/\b(heat\s*map|heatmap|matrix|treemap)\b/.test(qLow)
        ? (/matrix/.test(qLow) ? 'matrix' : /\btreemap\b/.test(qLow) ? 'treemap' : 'heatmap')
        : /\bscatter\b/.test(qLow)
          ? 'scatter'
          : /\bbubble\b/.test(qLow)
            ? 'bubble'
            : /\bcombo\b/.test(qLow)
              ? 'combo'
              : /\bwaterfall\b/.test(qLow)
                ? 'waterfall'
                : /\bline\b/.test(qLow)
                  ? 'line'
                  : /\bbar\b|\bcolumn\b/.test(qLow)
                    ? 'bar'
                  : null);
    if (/\bbox\s+plot\b/.test(qLow)) {
      return {
        kind: 'no_data',
        message:
          'I cannot build a box plot from the current EBPO chart vocabulary. The underlying salary data can be shown as bars, heatmaps, or matrices instead.',
      } as SmartPlanResult;
    }
    const measureIds = this.detectEbpoMeasureMentions(query);
    const uniqueMeasures = [...new Set(measureIds)];
    const detectDims = (): { dimension: string; breakdown?: string | null } | null => {
      const dimChecks: Array<[string, RegExp]> = [
        ['delivery_center', /\bdelivery\s+center\b/],
        ['business_unit', /\bbusiness\s+unit\b/],
        ['department', /\bdepartment\b|\bdept\b/],
        ['country', /\bcountry\b/],
        ['region', /\bregion\b/],
        ['client', /\bclient\b|\bcustomer\b/],
        ['vendor', /\bvendor\b|\bsupplier\b/],
        ['asset_type', /\basset\s+type\b/],
        ['grade', /\bgrade\b/],
        ['contract_type', /\bcontract\s+type\b/],
        ['aging_bucket', /\baging\s+bucket\b|\bbucket\b/],
        ['account', /\baccount\b|\bgl\b/],
      ];
      const temporal =
        /\bmonth\b|\bmonthly\b|\bover\s+time\b|\btrend\b|\bthis\s+year\b|\bytd\b/.test(qLow);
      const hits = dimChecks
        .map(([d, rx]) => ({ d, idx: qLow.search(rx) }))
        .filter((x) => x.idx >= 0)
        .sort((a, b) => a.idx - b.idx)
        .map((x) => x.d);
      if (chartType === 'heatmap' || chartType === 'matrix') {
        if (temporal && hits.length > 0) {
          const other = hits.find((d) => d !== 'month') ?? hits[0]!;
          return { dimension: 'month', breakdown: other };
        }
        if (hits.length >= 2) return { dimension: hits[0]!, breakdown: hits[1]! };
      }
      if (temporal) return { dimension: 'month' };
      if (hits.length > 0) return { dimension: hits[0]! };
      return null;
    };
    const axes = detectDims();
    if (chartType && uniqueMeasures.length > 0 && axes) {
      const spec: ChartSpec = {
        measure: uniqueMeasures[0]!,
        dimension: axes.dimension,
        chartType,
        ...(uniqueMeasures.length > 1 ? { measures: uniqueMeasures } : {}),
        ...(axes.breakdown ? { breakdown: axes.breakdown } : {}),
      };
      const built = await build(
        spec,
        `${(uniqueMeasures[0] ?? 'EBPO').replace(/_/g, ' ')} by ${axes.dimension.replace(/_/g, ' ')}`,
        query.slice(0, 160),
      );
      if (built) return built;
    }

    if (
      /\bcash\s+conversion\b|\boperating\s+cash\s+flow\s+divided\s+by\s+revenue\b|\bocf\b.*\brevenue\b/.test(
        qLow,
      )
    ) {
      const built = await build(
        {
          measure: 'operating_cf_to_revenue_pct',
          dimension: 'month',
          chartType: forcedChartType ?? 'line',
        },
        'Monthly Cash Conversion',
        'Operating cash flow divided by revenue by month',
      );
      if (built) return built;
    }

    if (
      /\brevenue\s+per\s+employee\b/.test(qLow) &&
      /\bdepartment\b/.test(qLow) &&
      /\bmonth\b/.test(qLow)
    ) {
      const built = await build(
        {
          measure: 'revenue_per_employee',
          dimension: 'month',
          breakdown: 'department',
          chartType: 'heatmap',
        },
        'Revenue per Employee by Department and Month',
        'Department revenue per employee over time',
      );
      if (built) return built;
    }

    if (
      /\bebitda[\s-]*style\s+margin\b|\brevenue\s+minus\s+cost\s+minus\s+payroll\b/.test(
        qLow,
      )
    ) {
      const built = await build(
        {
          measure: 'ebitda_style_margin_pct',
          dimension: 'month',
          chartType: forcedChartType ?? 'bar',
        },
        'Monthly EBITDA-style Margin',
        'EBITDA-style margin from revenue minus cost minus payroll',
      );
      if (built) return built;
    }

    if (/\bnet\s+working\s+capital\b|\bworking\s+capital\b/.test(qLow)) {
      const built = await build(
        {
          measure: 'working_capital',
          dimension: 'month',
          chartType: forcedChartType ?? 'line',
        },
        'Monthly Working Capital',
        'Working capital by month',
      );
      if (built) return built;
    }

    if (/\brevenue\s+per\s+delivery\s+center\b/.test(qLow)) {
      const built = await build(
        {
          measure: 'allocated_revenue',
          dimension: 'delivery_center',
          chartType: forcedChartType ?? 'bar',
        },
        'Revenue by Delivery Center',
        'Allocated revenue by delivery center',
      );
      if (built) return built;
    }

    if (/\bcost[\s-]*to[\s-]*income\b|\btotal\s+cost\s+divided\s+by\s+revenue\b/.test(qLow)) {
      const built = await build(
        {
          measure: 'cost_to_income_pct',
          dimension: 'month',
          chartType: forcedChartType ?? 'bar',
        },
        'Monthly Cost-to-Income Ratio',
        'Cost-to-income ratio by month',
      );
      if (built) return built;
    }

    if (
      /\bcash\s+balance\b/.test(qLow) &&
      /\boutstanding\s+receivables?\b/.test(qLow) &&
      /\bmonth\b/.test(qLow)
    ) {
      const measures = ['cash_balance', 'ar_outstanding'];
      if (/\boutstanding\s+payables?\b/.test(qLow)) measures.push('ap_outstanding');
      const built = await build(
        {
          measure: measures[0]!,
          measures,
          dimension: 'month',
          chartType: 'line',
        },
        'Monthly Cash Balance and Receivables',
        'Cash balance with outstanding receivables by month',
      );
      if (built) return built;
    }

    if (/\bpayroll\s+cost\s+per\s+employee\b|\bcost\s+per\s+employee\b/.test(qLow)) {
      const dim =
        /\bcountry\b/.test(qLow) ? 'country' : /\bdepartment\b/.test(qLow) ? 'department' : null;
      if (dim) {
        const built = await build(
          {
            measure: 'cost_per_employee',
            dimension: dim,
            chartType: forcedChartType ?? 'bar',
          },
          'Cost per Employee',
          `Cost per employee by ${dim}`,
        );
        if (built) return built;
      }
    }

    return null;
  }

  // Plan cache: normalized question → the catalog spec it produced. Lets repeat
  // questions skip the LLM entirely (latency + cost), and — critically — lets the
  // agent still answer PREVIOUSLY-SEEN questions correctly when the LLM is offline,
  // by replaying the cached spec through the deterministic compiler (no hallucination,
  // works for GL and EBPO). A hit still re-runs ClickHouse, so the data is always
  // fresh; only the LLM step is skipped. Keyed by org-type (GL/EBPO use different
  // catalogs). See AGENT_ARCHITECTURE.md → "offline mode".
  private readonly specPlanCache = new Map<
    string,
    { spec: ChartSpec; title: string; useEbpo: boolean; at: number }
  >();
  private readonly SPEC_CACHE_TTL_MS = 30 * 60 * 1000;

  private specCacheKey(query: string, useEbpo: boolean): string {
    return `${useEbpo ? 'ebpo' : 'gl'}:${query.trim().toLowerCase().replace(/\s+/g, ' ')}`;
  }

  private smartPlanCacheKey(
    query: string,
    scope: OrgScope,
    range?: TimeRange,
    conversationHistory?: string,
  ): string {
    const orgs = (scope.externalOrgIds ?? []).slice().sort().join(',');
    const history = conversationHistory
      ? conversationHistory.trim().slice(0, 400).replace(/\s+/g, ' ')
      : '';
    const rangeKey = range ? JSON.stringify(range) : '';
    return [
      scope.tenantId,
      orgs,
      query.trim().toLowerCase().replace(/\s+/g, ' '),
      rangeKey,
      history,
    ].join('::');
  }

  private getCachedSmartPlan(cacheKey: string): SmartPlanResult | null {
    const cached = this.smartPlanCache.get(cacheKey);
    if (!cached) return null;
    if (Date.now() - cached.at > this.SMART_PLAN_CACHE_TTL_MS) {
      this.smartPlanCache.delete(cacheKey);
      return null;
    }
    return structuredClone(cached.result);
  }

  private setCachedSmartPlan(cacheKey: string, result: SmartPlanResult): void {
    this.smartPlanCache.set(cacheKey, {
      result: structuredClone(result),
      at: Date.now(),
    });
  }

  private async generateSpecPlan(
    query: string,
    scope: OrgScope,
    conversationHistory?: string,
    hasEbpoHint?: boolean,
  ): Promise<SmartPlanResult | null> {
    try {
      if (scope.externalOrgIds.length === 0) return null;
      // Only handle the chart classes the compiler models; defer the rest.
      if (!this.specModeCanHandle(query)) return null;
      // Dataset-aware: EBPO orgs use the EBPO catalog/compiler; everything else
      // uses the GL catalog. Both are CLOSED catalogs the LLM can only select from,
      // so neither can hallucinate columns.
      const useEbpo =
        hasEbpoHint ?? (await this.orgHasEbpoData(scope).catch(() => false));

      // Plan-cache fast path: replay a previously-built spec for this exact question.
      // Placed BEFORE the LLM ping so it also serves when the LLM is unreachable.
      const cacheKey = this.specCacheKey(query, useEbpo);
      const cachedSpec = this.specPlanCache.get(cacheKey);
      if (cachedSpec && Date.now() - cachedSpec.at < this.SPEC_CACHE_TTL_MS) {
        const replay = await this.specToPlan(
          cachedSpec.spec,
          cachedSpec.title,
          cachedSpec.useEbpo,
          scope,
          query,
        );
        if (replay) {
          this.logger.log(
            `[planner] served=spec-cache source=catalog query=${JSON.stringify(query.slice(0, 80))}`,
          );
          return replay;
        }
        this.specPlanCache.delete(cacheKey); // stale: no longer compiles / no data
      }

      const ping = await fetch(`${this.OLLAMA_URL}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      }).catch(() => null);
      if (!ping?.ok) return null;

      const history =
        conversationHistory && !conversationHistory.includes('(No prior')
          ? `\nCONVERSATION SO FAR:\n${conversationHistory.slice(0, 600)}\n`
          : '';
      const catalogText = useEbpo ? ebpoCatalogPromptText() : catalogPromptText();
      const userMsg = `${catalogText}\n${history}\nUSER REQUEST: "${query}"\nReturn the JSON now.`;

      const resp = await fetch(`${this.OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({
          model: this.OLLAMA_MODEL,
          messages: [
            { role: 'system', content: SPEC_PLANNER_SYSTEM },
            { role: 'user', content: userMsg },
          ],
          stream: false,
          options: { temperature: 0.05, num_predict: 600 },
        }),
      });
      if (!resp.ok) return null;
      const body = (await resp.json()) as { message?: { content?: string } };
      const raw = (body.message?.content ?? '').replace(/```json|```/g, '').trim();
      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch (parseErr: any) {
        const repaired = await this.repairPlannerJsonViaLLM(
          SPEC_PLANNER_SYSTEM,
          userMsg,
          raw,
          parseErr?.message ?? 'Invalid JSON from planner',
        );
        if (!repaired) return null;
        try {
          parsed = JSON.parse(repaired);
        } catch {
          const m = repaired.match(/\{[\s\S]*\}/);
          if (!m) return null;
          parsed = JSON.parse(m[0]);
        }
      }

      // ADDITIVE, NOT REPLACING: spec mode only OWNS a result when it can
      // confidently build the requested chart. For anything it can't model — the
      // model declined, the dimension/measure isn't catalogued, an unmodeled chart
      // type, or the compile can't satisfy it — DEFER (return null) so the proven
      // legacy planner handles it (including its own honest refusals). Never
      // short-circuit legacy with a spec-mode refusal/no_data.
      if (typeof parsed?.refusal === 'string' && parsed.refusal.trim() && !parsed?.spec)
        return null;
      const spec = parsed?.spec as ChartSpec | undefined;
      if (!spec || typeof spec !== 'object') return null;
      if (!this.specCanModelChart(spec)) return null;

      const title = typeof parsed?.title === 'string' ? parsed.title : '';
      const builtPlan = await this.specToPlan(spec, title, useEbpo, scope, query);
      if (!builtPlan) return null;
      // Cache only specs that actually built with data, so the offline/replay path
      // never serves a spec that can't produce a chart.
      this.specPlanCache.set(cacheKey, { spec, title, useEbpo, at: Date.now() });
      if (builtPlan.kind === 'build') {
        this.logger.log(
          `[SpecPlan] built "${builtPlan.plan.dashboard.title}" from spec ${JSON.stringify(spec).slice(0, 120)}`,
        );
      }
      return builtPlan;
    } catch (err: any) {
      this.logger.warn(`[SpecPlan] failed: ${err?.message ?? err}`);
      return null;
    }
  }

  // Deterministic tail of the spec planner: compile a catalog spec to SQL, verify it
  // returns data, and shape the build plan. Shared by the live LLM path and the
  // plan-cache / offline-replay path so both produce identical, correct output.
  private async specToPlan(
    spec: ChartSpec,
    title: string,
    useEbpo: boolean,
    scope: OrgScope,
    query: string,
  ): Promise<SmartPlanResult | null> {
    const runRows = (sql: string) =>
      this.queryRows<Record<string, unknown>>(sql, {
        tenantId: scope.tenantId,
        externalOrgIds: scope.externalOrgIds,
      });
    const compiled = useEbpo
      ? await compileEbpoSpec(spec, this.analyticsDb, runRows)
      : await compileSpec(spec, this.analyticsDb, runRows);
    if (!compiled.ok) return null;

    // Verify the compiled SQL actually returns data before claiming a build.
    const chartType = (spec.chartType ?? 'bar') as ChartType;
    const check = await this.executeDynamicSqlChecked(compiled.sql, scope, {
      chartType,
    }).catch(() => null);
    if (!check || check.error || check.rows.length === 0) return null;

    const finalTitle = (title || compiled.measure.label).slice(0, 80);
    return {
      kind: 'build',
      plan: {
        tools_to_execute: [],
        should_generate_dashboard: true,
        dashboard: {
          title: finalTitle,
          description: '',
          widgets: [
            {
              title: finalTitle,
              description: '',
              type: chartType,
              metric: 'dynamic',
              grouping: 'dynamic',
              display_order: 0,
              _sql: compiled.sql,
              _spec: spec,
              // Carry the measure's unit so the web formats values correctly
              // (percent measures render as % not $).
              display: {
                valueFormat: compiled.measure.format,
                ...(typeof (compiled.measure as { decimals?: number }).decimals === 'number'
                  ? { valueDecimals: (compiled.measure as { decimals?: number }).decimals }
                  : {}),
              },
            } as any,
          ],
        },
        analysis_focus: query,
      },
    };
  }

  private async repairPlannerJsonViaLLM(
    systemPrompt: string,
    userPrompt: string,
    rawOutput: string,
    errorMessage: string,
  ): Promise<string | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      const resp = await fetch(`${this.OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.OLLAMA_MODEL,
          messages: [
            {
              role: 'system',
              content:
                `${systemPrompt}\n\nYou are repairing malformed JSON from a planner. ` +
                'Return only valid JSON and preserve the original intent. Do not add prose.',
            },
            {
              role: 'user',
              content:
                `ORIGINAL PROMPT:\n${userPrompt}\n\n` +
                `INVALID OUTPUT:\n${rawOutput}\n\n` +
                `ERROR:\n${errorMessage}\n\n` +
                'Return the corrected JSON only.',
            },
          ],
          stream: false,
          options: { temperature: 0.05, num_predict: 1200, num_ctx: 8192 },
        }),
      }).catch(() => null);
      clearTimeout(timer);
      if (!resp?.ok) return null;
      const body = (await resp.json()) as { message?: { content?: string } };
      const repaired = (body.message?.content ?? '')
        .replace(/```json|```/g, '')
        .trim();
      return repaired || null;
    } catch {
      return null;
    }
  }

  private async generateSmartPlan(
    query: string,
    scope: OrgScope,
    range?: TimeRange,
    conversationHistory?: string,
  ): Promise<SmartPlanResult | null> {
    const cacheKey = this.smartPlanCacheKey(
      query,
      scope,
      range,
      conversationHistory,
    );
    const cachedPlan = this.getCachedSmartPlan(cacheKey);
    if (cachedPlan) {
      this.logger.log(
        `[planner] served=smart-cache source=memory query=${JSON.stringify(query.slice(0, 80))}`,
      );
      return cachedPlan;
    }

    // Spec-first is now the default: the model produces a closed ChartSpec, the
    // deterministic compiler turns it into SQL, and the cache absorbs exact repeats.
    const specPlan = await this.generateSpecPlan(
      query,
      scope,
      conversationHistory,
    ).catch(() => null);
    if (specPlan) {
      this.logger.log(
        `[planner] served=spec source=catalog query=${JSON.stringify(query.slice(0, 80))}`,
      );
      this.setCachedSmartPlan(cacheKey, specPlan);
      return specPlan;
    }
    try {
      // Verify Ollama is reachable before doing the expensive introspection
      const ping = await fetch(`${this.OLLAMA_URL}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      }).catch(() => null);
      if (!ping?.ok) return null;

      const liveContext = await this.introspectLiveSchema(scope);

      const q = query.toLowerCase();
      // If the user names exactly one chart type ("a line chart", "a scatter plot"),
      // the answer should be exactly 1 chart — never multiple charts for one dimensional
      // request. Multi-series belongs INSIDE a single chart using sumIf pivot columns.
      const hasSingleExplicitType =
        !!this.parseExplicitChartConstraints(query)?.requiredTypes?.length &&
        !/\b(multiple|several|various|different|all|each|3|4|5|6)\s+(charts?|graphs?|plots?)\b/i.test(
          q,
        ) &&
        !/\b(dashboard|report|board.pack|pack|suite|deep.dive)\b/.test(q);
      const maxCharts =
        /\b(dashboard|report|board.pack|pack|suite|deep.dive)\b/.test(q)
          ? 6
          : hasSingleExplicitType
            ? 1
            : /\b(multiple|several|all)\s+(charts?|graphs?)\b/i.test(q)
              ? 4
              : 2;

      const timeHint = range
        ? `Time filter requested: ${JSON.stringify(range)} — apply the equivalent WHERE clause on journal_date or issued_at`
        : '';

      const historySnippet =
        conversationHistory && !conversationHistory.includes('(No prior')
          ? `\nCONVERSATION CONTEXT:\n${conversationHistory.slice(0, 800)}`
          : '';

      const userMsg = [
        liveContext,
        timeHint,
        historySnippet,
        `\nUSER REQUEST: "${query}"`,
        `First decide the verdict (build / clarify / no_data). Only on "build", generate up to ${maxCharts} chart(s), each with a precise SQL query using the REAL data values shown above plus accurate xAxisLabel/yAxisLabel. If any named subject is not an exact match to the LIVE DATA above, or the request is ambiguous, return "clarify". If the data genuinely does not exist, return "no_data". Never guess.`,
      ]
        .filter(Boolean)
        .join('\n');

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), LLM_CHAT_TIMEOUT_MS);

      const response = await fetch(`${this.OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.OLLAMA_MODEL,
          messages: [
            { role: 'system', content: SMART_SQL_PLANNER_SYSTEM },
            { role: 'user', content: userMsg },
          ],
          stream: false,
          options: {
            temperature: 0.05,
            num_predict: 4000,
            num_ctx: 16384,
          },
        }),
      });
      clearTimeout(timer);

      if (!response.ok) return null;

      const body = (await response.json()) as {
        message?: { content?: string };
      };
      const raw = (body.message?.content ?? '')
        .replace(/```json|```/g, '')
        .trim();

      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch (parseErr: any) {
        const repaired = await this.repairPlannerJsonViaLLM(
          SMART_SQL_PLANNER_SYSTEM,
          userMsg,
          raw,
          parseErr?.message ?? 'Invalid JSON from planner',
        );
        if (!repaired) return null;
        try {
          parsed = JSON.parse(repaired);
        } catch {
          const jsonMatch = repaired.match(/\{[\s\S]*\}/);
          if (!jsonMatch) return null;
          parsed = JSON.parse(jsonMatch[0]);
        }
      }

      const verdict = String(parsed?.verdict ?? '')
        .toLowerCase()
        .trim();

      // Guard: the model sometimes leaks raw SQL into user-facing text (it reads
      // "restatement the planner can run as-is" as "write SQL"). NEVER show SQL
      // or query placeholders in chat.
      const looksLikeSql = (s: string): boolean =>
        /\bSELECT\b[\s\S]*\bFROM\b/i.test(s) ||
        /\{(?:externalOrgIds|tenantId|asOf)\s*:/i.test(s) ||
        /\b(sumIf|formatDateTime|toStartOf|toFloat64|GROUP\s+BY)\b/i.test(s);

      // ── CLARIFY ───────────────────────────────────────────────────────────
      if (verdict === 'clarify' && parsed?.clarification?.question) {
        const question = String(parsed.clarification.question)
          .slice(0, 200)
          .trim();
        const rawOpts = Array.isArray(parsed.clarification.options)
          ? parsed.clarification.options
          : [];
        const options = rawOpts
          .map((o: any) => {
            const label = String(o?.label ?? '')
              .slice(0, 80)
              .trim();
            let value = String(o?.value ?? o?.label ?? '')
              .slice(0, 300)
              .trim();
            // If the model put SQL in the natural-language value, fall back to
            // the label so the resubmitted query is plain language, not SQL.
            if (looksLikeSql(value)) value = label;
            return { label, value };
          })
          .filter(
            (o: { label: string; value: string }) =>
              o.label && o.value && !looksLikeSql(o.label),
          )
          .slice(0, 4);
        // Only surface the clarification if the question and options are clean.
      if (options.length >= 1 && !looksLikeSql(question)) {
        this.logger.log(`[SmartPlan] CLARIFY for: "${query.slice(0, 80)}"`);
        const result: SmartPlanResult = {
          kind: 'clarify',
          clarification: {
            reason: 'PLANNER_NEEDS_INPUT',
            question,
            options,
          },
        };
        this.setCachedSmartPlan(cacheKey, result);
        return result;
      }
        // Malformed/SQL-tainted clarify — fall through to build/none.
      }

      // ── NO DATA ───────────────────────────────────────────────────────────
      if (verdict === 'no_data' && parsed?.message) {
        const message = String(parsed.message).slice(0, 600).trim();
      if (!looksLikeSql(message)) {
        this.logger.log(`[SmartPlan] NO_DATA for: "${query.slice(0, 80)}"`);
        const result: SmartPlanResult = { kind: 'no_data', message };
        this.setCachedSmartPlan(cacheKey, result);
        return result;
      }
        // SQL-tainted message — fall through rather than show SQL to the user.
      }

      // ── BUILD ─────────────────────────────────────────────────────────────
      if (
        verdict === 'build' &&
        (!parsed?.charts ||
          !Array.isArray(parsed.charts) ||
          parsed.charts.length === 0)
      ) {
        const repaired = await this.repairPlannerJsonViaLLM(
          SMART_SQL_PLANNER_SYSTEM,
          userMsg,
          raw,
          'Planner returned build without a usable charts array',
        );
        if (repaired) {
          try {
            parsed = JSON.parse(repaired);
          } catch {
            const jsonMatch = repaired.match(/\{[\s\S]*\}/);
            if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
          }
        }
      }

      if (
        !parsed?.charts ||
        !Array.isArray(parsed.charts) ||
        parsed.charts.length === 0
      )
        return null;

      // If the user EXPLICITLY named a chart type ("create a heatmap", "as a pie
      // chart"), honor it — never silently substitute a different type. Applies
      // when exactly one type was requested.
      const explicitTypes =
        this.parseExplicitChartConstraints(query)?.requiredTypes;
      const forcedType: ChartType | null =
        explicitTypes && explicitTypes.length === 1 ? explicitTypes[0]! : null;

      const widgets: Array<
        AgentPlan['dashboard']['widgets'][number] & { _sql?: string }
      > = [];

      for (let i = 0; i < parsed.charts.length; i++) {
        const c = parsed.charts[i];
        if (!c?.type || !c?.title) continue;

        const chartType = (() => {
          const valid: ChartType[] = [
            'line',
            'bar',
            'pie',
            'donut',
            'metric',
            'kpi',
            'table',
            'area',
            'combo',
            'treemap',
            'scatter',
            'stacked_bar',
            'waterfall',
            'histogram',
            'horizontal_bar',
            'pareto',
            'gauge',
            'bubble',
            'heatmap',
            'matrix',
          ];
          // Explicit user request wins over the model's pick.
          if (forcedType) return forcedType;
          return valid.includes(c.type as ChartType)
            ? (c.type as ChartType)
            : 'bar';
        })();

        // KPI cards: route to the vocabulary planner's built-in handler which
        // returns { label, value, format, icon } — the format the frontend KPI
        // renderer expects. Dynamic SQL cannot easily produce this shape.
        if (chartType === 'kpi') {
          widgets.push({
            title: String(c.title ?? '').slice(0, 80),
            description: String(
              c.description ?? 'Key financial performance indicators',
            ),
            type: 'kpi',
            metric: 'summary',
            grouping: 'overview',
            display_order: i,
          } as any);
          continue;
        }

        // Waterfall charts without SQL fall back to the legacy P&L vocabulary
        // widget. SQL-backed waterfall charts must keep the planner SQL because
        // EBPO prompts often ask for cash-flow or monthly movement waterfalls.
        if (chartType === 'waterfall' && !String(c.sql ?? '').trim()) {
          const wtitle = String(
            c.title ?? 'P&L Waterfall — Revenue to Net Income',
          ).slice(0, 80);
          widgets.push({
            title: wtitle,
            description: String(
              c.description ??
                'Revenue → COGS → Gross Profit → OpEx → Net Income',
            ),
            type: 'waterfall',
            metric: 'pl',
            grouping: 'summary',
            display_order: i,
          } as any);
          continue;
        }

        // P&L summary metric/table charts: route to pl_summary vocab handler to avoid
        // LLM calculating wrong net income from raw journal lines.
        // Triggered when a metric/table chart title mentions revenue+income or P&L totals.
        const plSummaryKeywords =
          /\b(revenue.*net\s+income|net\s+income.*revenue|p&l\s+summary|income\s+statement|financial\s+summary|total\s+revenue.*total|gross\s+profit.*net)\b/i;
        if (
          (chartType === 'metric' || chartType === 'table') &&
          plSummaryKeywords.test(c.title ?? query)
        ) {
          widgets.push({
            title: String(c.title ?? 'P&L Summary').slice(0, 80),
            description: String(
              c.description ?? 'Revenue, Gross Profit, Net Income, Margins',
            ),
            type: 'metric',
            metric: 'pl_summary',
            grouping: 'summary',
            display_order: i,
          } as any);
          continue;
        }

        // Margin / gross profit charts without SQL route to vocab handlers.
        // SQL-backed charts keep planner SQL so rich semantic datasets such as
        // EBPO use their own revenue/cost/margin views instead of sample GL data.
        const marginKeywords =
          /\b(gross\s+profit|gross\s+margin|net\s+margin|margin\s+%|margin\s+percent)\b/i;
        if (
          !String(c.sql ?? '').trim() &&
          (chartType === 'line' ||
            chartType === 'bar' ||
            chartType === 'area') &&
          marginKeywords.test(c.title ?? query)
        ) {
          const isGrossMarginPct =
            /gross\s+margin\s*%|gross\s+margin\s+percent/i.test(
              c.title ?? query,
            );
          const isNetMargin = /net\s+margin/i.test(c.title ?? query);
          const vocabMetric = isNetMargin
            ? 'net_margin_pct'
            : isGrossMarginPct
              ? 'gross_margin_pct'
              : 'gross_profit';
          widgets.push({
            title:
              String(c.title ?? '').slice(0, 80) ||
              `Monthly ${vocabMetric.replace(/_/g, ' ')} Trend`,
            description: String(c.description ?? ''),
            type: chartType,
            metric: vocabMetric,
            grouping: 'month',
            display_order: i,
          } as any);
          continue;
        }

        if (!c?.sql) continue;

        let sql: string | null = null;
        try {
          sql = this.validateAndScopeDynamicSql(
            String(c.sql).trim().replace(/;+$/, ''),
            scope,
            { chartType },
          );
        } catch (e: any) {
          this.logger.warn(`[SmartPlan] Widget ${i} SQL invalid: ${e.message}`);
          continue;
        }

        // Axis labels — omit for chart types where axes are meaningless.
        const axisless: ChartType[] = [
          'metric',
          'kpi',
          'gauge',
          'pie',
          'donut',
          'treemap',
          'heatmap',
          'matrix',
        ];
        const wantsAxes = !axisless.includes(chartType);
        const xAxisLabel =
          wantsAxes && c.xAxisLabel
            ? String(c.xAxisLabel).slice(0, 60).trim()
            : undefined;
        const yAxisLabel =
          wantsAxes && c.yAxisLabel
            ? String(c.yAxisLabel).slice(0, 60).trim()
            : undefined;

        widgets.push({
          title: String(c.title ?? '').slice(0, 80),
          description: String(c.description ?? ''),
          type: chartType,
          metric: 'dynamic',
          grouping: 'query',
          ...(xAxisLabel ? { xAxisLabel } : {}),
          ...(yAxisLabel ? { yAxisLabel } : {}),
          display_order: i,
          _sql: sql,
        } as any);
      }

      // Percent-unit charts (gross margin %, growth %, SLA %…) must carry
      // display.valueFormat='percent'. The frontend only reads that for metric="dynamic"
      // and otherwise defaults to dollars — the root cause of "% shown as $".
      for (const w of widgets as any[]) {
        const vf = this.inferPercentFormat(w.yAxisLabel, w.title);
        if (vf && !w.display?.valueFormat) {
          w.display = { ...(w.display ?? {}), valueFormat: vf };
        }
      }

      if (widgets.length === 0) return null;

      // ── VERIFY DATA BEFORE CLAIMING SUCCESS ───────────────────────────────
      // Execute each chart's SQL now and keep only the ones that actually return
      // rows. A chart that renders empty while the chat says "Built your
      // dashboard" is exactly the failure the user hits with e.g. "revenue of
      // top vendors" (vendors have spend, not revenue → 0 rows). Be honest.
      const verified = await Promise.all(
        widgets.map(async (w) => {
          // KPI and waterfall vocabulary widgets have no dynamic SQL — always "ok".
          if (
            w.metric === 'summary' &&
            w.grouping === 'overview' &&
            w.type === 'kpi'
          ) {
            return { w, ok: true };
          }
          if (
            w.metric === 'pl' &&
            w.grouping === 'summary' &&
            w.type === 'waterfall'
          ) {
            return { w, ok: true };
          }
          // Margin vocab widgets (gross_profit, gross_margin_pct, net_margin_pct)
          if (
            ['gross_profit', 'gross_margin_pct', 'net_margin_pct'].includes(
              w.metric,
            ) &&
            w.grouping === 'month'
          ) {
            return { w, ok: true };
          }
          // P&L summary vocab widget
          if (w.metric === 'pl_summary' && w.grouping === 'summary') {
            return { w, ok: true };
          }
          // Monthly dept breakdown vocab widget
          if (w.metric === 'expense' && w.grouping === 'month_department') {
            return { w, ok: true };
          }

          const sql0 = (w as any)._sql as string;
          if (!sql0) return { w, ok: false };
          const r1 = await this.executeDynamicSqlChecked(sql0, scope, {
            chartType: w.type,
          });

          // Determine what (if anything) is wrong and recoverable.
          // - SQL error → recoverable via self-repair.
          // - ran fine, has rows, but the chart SHAPE is wrong (e.g. duplicate
          //   x-axis labels because the wrong dimension was used as the label) →
          //   also recoverable via self-repair with a shape hint.
          // - ran fine, 0 rows, no error → genuinely empty, not fixable.
          let problem: string | null = null;
          if (r1.error) problem = r1.error;
          else if (r1.rows.length === 0) return { w, ok: false };
          else problem = this.detectBadChartShape(r1.rows, w.type);

          if (!problem) return { w, ok: true };

          // Attempt ONE self-repair with the error/shape hint.
          const repaired = await this.repairSqlViaLLM(
            sql0,
            problem,
            liveContext,
          );
          if (!repaired) return { w, ok: false };
          let scoped: string;
          try {
            scoped = this.validateAndScopeDynamicSql(repaired, scope, {
              chartType: w.type,
            });
          } catch (e: any) {
            this.logger.warn(
              `[SmartPlan] self-repair produced invalid SQL: ${e?.message ?? e}`,
            );
            return { w, ok: false };
          }
          const r2 = await this.executeDynamicSqlChecked(scoped, scope, {
            chartType: w.type,
          });
          if (
            r2.rows.length > 0 &&
            !this.detectBadChartShape(r2.rows, w.type)
          ) {
            (w as any)._sql = scoped;
            this.logger.log(
              `[SmartPlan] self-repair SUCCEEDED for "${w.title}"`,
            );
            return { w, ok: true };
          }
          this.logger.warn(
            `[SmartPlan] self-repair did not yield a clean chart for "${w.title}"`,
          );
          return { w, ok: false };
        }),
      );
      const nonEmpty = verified.filter((v) => v.ok).map((v) => v.w);

      if (nonEmpty.length === 0) {
        this.logger.log(
          `[SmartPlan] BUILD produced only empty charts → NO_DATA for: "${query.slice(0, 80)}"`,
        );
        const result: SmartPlanResult = {
          kind: 'no_data',
          message:
            `Sorry, I wasn't able to generate this chart — the data needed to answer "${String(parsed.title ?? query).slice(0, 60)}" ` +
            `doesn't appear to be available in this dataset. ` +
            `This can happen when the requested dimension (e.g. a specific vendor, department, or metric) doesn't exist in the data, ` +
            `or when the time window is outside the available range. ` +
            `Please try rephrasing your question or ask for a different chart — I'm happy to help with expenses, vendor spend, department breakdowns, revenue, or P&L analysis.`,
        };
        this.setCachedSmartPlan(cacheKey, result);
        return result;
      }

      // Re-number display order after dropping empties.
      const finalWidgets = nonEmpty.map((w, i) => ({ ...w, display_order: i }));

      this.logger.log(
        `[SmartPlan] BUILD — ${finalWidgets.length}/${widgets.length} SQL-backed charts returned data for: "${query.slice(0, 80)}"`,
      );

      const result: SmartPlanResult = {
        kind: 'build',
        plan: {
          tools_to_execute: [],
          should_generate_dashboard: true,
          dashboard: {
            title: String(parsed.title ?? query).slice(0, 100),
            description: 'Real-time dashboard built from live ClickHouse data',
            widgets: finalWidgets as AgentPlan['dashboard']['widgets'],
          },
          analysis_focus: query,
        },
      };
      this.setCachedSmartPlan(cacheKey, result);
      return result;
    } catch (err: any) {
      this.logger.warn(`[SmartPlan] Failed: ${err?.message ?? err}`);
      return null;
    }
  }

  private extractClientMention(raw: string): string | null {
    const s = raw.trim();
    if (!s) return null;

    // Explicit scoping: "Use client: X" / "client: X"
    const explicit = s.match(
      /\b(?:client|customer|contact)\s*[:\-]?\s*([A-Za-z0-9&.,\-() ]{2,80})/i,
    );
    if (explicit?.[1]) {
      const chunk = explicit[1]
        .replace(/\b(as to|regarding|on|about)\b/i, ' ')
        .replace(
          /\b(invoice|invoices|payment|payments|revenue|trend|days|overdue|outstanding|ar|aging)\b/gi,
          ' ',
        )
        .trim();
      // Guard: phrases like "client information" are not a client name.
      if (
        /\b(info|information|details|data|list|breakdown|comparison)\b/i.test(
          chunk,
        )
      ) {
        return null;
      }
      return chunk.length >= 2 ? chunk : null;
    }

    // Prefer quoted entity names: for "Umixity LLC" ...
    const quoted = s.match(/["“”']([^"“”']{2,80})["“”']/);
    if (quoted?.[1]) return quoted[1].trim();

    // Common patterns: "for X", "for client X", "about client X"
    // IMPORTANT: we intentionally do NOT treat "in X" as a client mention — "in <name>"
    // is far more often an entity/integration scope (Xero org / QB company).
    const m =
      s.match(
        /\bfor\s+(?:the\s+)?(?:client|customer|contact)?\s*([A-Za-z0-9&.,\-() _]{2,80})/i,
      ) ??
      s.match(
        /\babout\s+(?:the\s+)?(?:client|customer|contact)?\s*([A-Za-z0-9&.,\-() _]{2,80})/i,
      );
    if (m?.[1]) {
      const chunk = m[1]
        .replace(/\b(as to|regarding|on|about)\b/i, ' ')
        .replace(
          /\b(invoice|invoices|payment|payments|revenue|trend|days|overdue|outstanding|ar|aging)\b/gi,
          ' ',
        )
        .trim();
      // Guard: "for last 6 months ..." is a time window, not a client name.
      if (
        /\b(last|past|previous|recent|lately|since|from|between|ytd|mtd|qtd)\b/i.test(
          chunk,
        ) ||
        /\b\d+\s+(day|days|week|weeks|month|months|quarter|quarters|year|years)\b/i.test(
          chunk,
        )
      ) {
        return null;
      }
      return chunk.length >= 2 ? chunk : null;
    }

    // As a last resort: if query starts with a proper noun + LLC/Inc/etc.
    const suffix = s.match(
      /^([A-Za-z0-9&.,\-() _]{2,80})\s+\b(llc|inc|ltd|corp|corporation|co)\b/i,
    );
    if (suffix?.[0]) return suffix[0].trim();

    return null;
  }

  private extractEntityMention(raw: string): string | null {
    const s = raw.trim();
    if (!s) return null;

    // Explicit scoping: "Use entity: X" / "entity: X" (org_id or org name)
    const explicitScope = s.match(
      /\b(?:use\s+)?(?:entity|org|organisation|organization|company|integration)\s*[:\-]?\s*([A-Za-z0-9&.,\-() _]{2,120})/i,
    );
    if (explicitScope?.[1]) return explicitScope[1].trim();

    // If the user explicitly says "entity/org/company/integration", treat the following phrase as entity scope.
    const explicit = s.match(
      /\b(?:entity|org|organisation|organization|company|integration)\s*[:\-]?\s*([A-Za-z0-9&.,\-() _]{2,80})/i,
    );
    if (explicit?.[1]) return explicit[1].trim();

    // Common scoping pattern: "... of <entity name>" (e.g. "revenue of Arvion Services Sdn Bhd")
    const ofScope = s.match(
      /\bof\s+(?:the\s+)?(?:entity|org|company|integration)?\s*([A-Za-z0-9&.,\-() _]{2,80})/i,
    );
    if (ofScope?.[1]) {
      const chunk = ofScope[1]
        .replace(/\b(as to|regarding|on|about)\b/i, ' ')
        .replace(
          /\b(client|customer|contact|invoice|invoices|payment|payments|revenue|trend|days|overdue|outstanding|ar|aging)\b/gi,
          ' ',
        )
        .trim();
      return chunk.length >= 2 ? chunk : null;
    }

    // Common scoping pattern: "... in <entity name>"
    const inScope = s.match(
      /\bin\s+(?:the\s+)?(?:entity|org|company|integration)?\s*([A-Za-z0-9&.,\-() _]{2,80})/i,
    );
    if (inScope?.[1]) {
      const chunk = inScope[1]
        .replace(/\b(as to|regarding|on|about)\b/i, ' ')
        .replace(
          /\b(client|customer|contact|invoice|invoices|payment|payments|revenue|trend|days|overdue|outstanding|ar|aging)\b/gi,
          ' ',
        )
        .trim();
      return chunk.length >= 2 ? chunk : null;
    }

    // "revenue for <entity>" / "for <entity>" — prefer entity scope when not explicitly a client.
    const forScope = s.match(
      /\bfor\s+(?:the\s+)?(?:entity|org|company|integration)?\s*([A-Za-z0-9&.,\-() _]{2,80})/i,
    );
    if (forScope?.[1]) {
      // "for <name>" is ambiguous (client vs entity). We treat it as an entity scope when:
      // 1) The phrase appears at the END of the query (common: "… do this for <entity>"), OR
      // 2) The query explicitly says "entity/org/company/integration", OR
      // 3) The query does not mention clients/customers/contacts at all.
      const appearsAtEnd = (() => {
        const idx = s.toLowerCase().lastIndexOf(forScope[0].toLowerCase());
        if (idx < 0) return false;
        const tail = s.slice(idx + forScope[0].length).trim();
        return tail.length === 0 || /^[.?!]+$/.test(tail);
      })();

      const explicitEntityWord =
        /\b(entity|org|organisation|organization|company|integration)\b/i.test(
          s,
        );
      const mentionsClientWords = /\b(client|customer|contact)\b/i.test(s);

      if (!appearsAtEnd && !explicitEntityWord && mentionsClientWords)
        return null;

      const chunk = forScope[1]
        .replace(/\b(as to|regarding|on|about)\b/i, ' ')
        .replace(
          /\b(invoice|invoices|payment|payments|revenue|trend|days|overdue|outstanding|ar|aging)\b/gi,
          ' ',
        )
        .trim();
      return chunk.length >= 2 ? chunk : null;
    }

    return null;
  }

  private scoreEntityContainedInQuery(
    queryNorm: string,
    candidateNorm: string,
  ): number {
    if (!queryNorm || !candidateNorm) return 0;
    if (queryNorm === candidateNorm) return 1;

    const qTokens = queryNorm.split(' ').filter(Boolean);
    const cTokens = candidateNorm.split(' ').filter(Boolean);
    if (cTokens.length === 0) return 0;
    const qSet = new Set(qTokens);
    let covered = 0;
    for (const t of new Set(cTokens)) if (qSet.has(t)) covered++;
    const coverage = covered / Math.max(1, new Set(cTokens).size);
    const containsBoost = queryNorm.includes(candidateNorm) ? 0.2 : 0;
    return Math.min(1, coverage + containsBoost);
  }

  private normalizeEntityName(name: string): string {
    const lower = (name ?? '').toLowerCase();
    const cleaned = lower
      .replace(/[\u2018\u2019\u201C\u201D]/g, "'")
      .replace(/[^a-z0-9\s&]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const stop = new Set([
      'llc',
      'inc',
      'ltd',
      'co',
      'corp',
      'corporation',
      'company',
      'the',
      'and',
      '&',
    ]);

    const tokens = cleaned.split(' ').filter((t) => t && !stop.has(t));
    return tokens.join(' ');
  }

  private isOpaqueEntityLabel(name: string): boolean {
    const s = String(name ?? '').trim();
    if (!s) return true;
    // UUID-ish or long numeric IDs are not user-friendly entity labels.
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
    )
      return true;
    if (/^\d{8,}$/.test(s)) return true;
    return false;
  }

  private async listEntitiesForScope(
    tenantId: string,
    connectionIds: string[],
    providerHint?: 'xero' | 'quickbooks',
  ): Promise<Array<{ orgId: string; orgName: string; provider: string }>> {
    if (connectionIds.length === 0) return [];

    const connRows = await this.prisma.erpConnection.findMany({
      where: { id: { in: connectionIds }, status: 'ACTIVE' },
      select: {
        externalOrganizationId: true,
        displayName: true,
        metadata: true,
        provider: true,
      },
    });

    const base = connRows
      .map((r) => {
        const orgId = String(r.externalOrganizationId ?? '').trim();
        const meta = (r.metadata as Record<string, any>) || {};
        const orgName = String(
          r.displayName ??
            meta.orgName ??
            meta.companyName ??
            meta.companyId ??
            orgId,
        ).trim();
        const provider = String(r.provider ?? '')
          .toLowerCase()
          .trim();
        return { orgId, orgName, provider };
      })
      .filter(
        (r) =>
          r.orgId &&
          (!providerHint || r.provider === String(providerHint).toLowerCase()),
      );

    // Try to replace opaque ids with human org names from live invoice data.
    const opaqueOrgIds = base
      .filter((b) => this.isOpaqueEntityLabel(b.orgName))
      .map((b) => b.orgId);

    if (opaqueOrgIds.length > 0) {
      try {
        const rows = await this.queryRows<any>(
          `SELECT
             org_id,
             any(coalesce(nullIf(org_name, ''), org_id)) AS org_name,
             sum(abs(toFloat64(total_amount))) AS total_amount
           FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
           WHERE tenant_id = {tenantId:String} AND org_id IN ({orgIds:Array(String)})
           GROUP BY org_id
           ORDER BY total_amount DESC
           LIMIT 500`,
          { tenantId, orgIds: opaqueOrgIds },
        );
        const map = new Map<string, string>();
        for (const r of rows) {
          const id = String(r.org_id ?? '').trim();
          const name = String(r.org_name ?? '').trim();
          if (id && name && !this.isOpaqueEntityLabel(name)) map.set(id, name);
        }
        for (const e of base) {
          const better = map.get(e.orgId);
          if (better) e.orgName = better;
        }
      } catch {
        // Non-fatal — keep prisma-derived names
      }
    }

    // De-dup by orgId, prefer non-opaque name if present.
    const merged = base.reduce((acc, cur) => {
      const existing = acc.get(cur.orgId);
      if (!existing) acc.set(cur.orgId, cur);
      else if (
        this.isOpaqueEntityLabel(existing.orgName) &&
        !this.isOpaqueEntityLabel(cur.orgName)
      )
        acc.set(cur.orgId, cur);
      return acc;
    }, new Map<string, { orgId: string; orgName: string; provider: string }>());

    return Array.from(merged.values());
  }

  private scoreEntityNameMatch(
    mentionNorm: string,
    candidateNorm: string,
  ): number {
    if (!mentionNorm || !candidateNorm) return 0;
    if (mentionNorm === candidateNorm) return 1;

    const mTokens = mentionNorm.split(' ').filter(Boolean);
    const cTokens = candidateNorm.split(' ').filter(Boolean);
    const mSet = new Set(mTokens);
    const cSet = new Set(cTokens);

    let intersection = 0;
    for (const t of mSet) if (cSet.has(t)) intersection++;
    const union = new Set([...mSet, ...cSet]).size || 1;
    const jaccard = intersection / union;

    const prefixBoost =
      candidateNorm.startsWith(mentionNorm) ||
      mentionNorm.startsWith(candidateNorm)
        ? 0.15
        : 0;
    const containsBoost =
      candidateNorm.includes(mentionNorm) || mentionNorm.includes(candidateNorm)
        ? 0.1
        : 0;

    return Math.min(1, jaccard + prefixBoost + containsBoost);
  }

  private async resolveClientFilter(
    query: string,
    scope: OrgScope,
  ): Promise<ClientResolution> {
    const mention = this.extractClientMention(query);
    if (!mention) return { status: 'none' };

    if (scope.externalOrgIds.length === 0) return { status: 'none' };
    const mentionNorm = this.normalizeEntityName(mention);
    if (!mentionNorm) return { status: 'none' };

    const candidates = await this.queryRows<any>(
      `SELECT
         coalesce(nullIf(client_name, ''), '') AS client_name,
         sum(total_invoiced) AS total_invoiced
       FROM ${this.analyticsDb}.v_dim_clients_latest
       WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})
         AND client_name != ''
       GROUP BY client_name
       ORDER BY total_invoiced DESC
       LIMIT 500`,
      { tenantId: scope.tenantId, externalOrgIds: scope.externalOrgIds },
    );

    const scored = candidates
      .map((c: any) => {
        const clientName = String(c.client_name ?? '').trim();
        const score = this.scoreEntityNameMatch(
          mentionNorm,
          this.normalizeEntityName(clientName),
        );
        return { clientName, score };
      })
      .filter((c) => c.clientName && c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);

    if (scored.length === 0) return { status: 'none' };

    const best = scored[0]!;
    const second = scored[1];
    const confident =
      best.score >= 0.82 && (!second || best.score - second.score >= 0.08);

    if (confident) {
      return {
        status: 'resolved',
        mention,
        clientName: best.clientName,
        clientNameLower: best.clientName.toLowerCase(),
        score: best.score,
      };
    }

    return { status: 'ambiguous', mention, candidates: scored };
  }

  private async resolveEntityFilter(
    query: string,
    scope: OrgScope,
    providerHint?: 'xero' | 'quickbooks',
  ): Promise<EntityResolution> {
    if (scope.connectionIds.length === 0) return { status: 'none' };

    // Prefer Prisma connections list (stable even if invoices are empty / not yet synced),
    // but enrich opaque ids with org_name from live invoice data when possible.
    const connCandidates = await this.listEntitiesForScope(
      scope.tenantId,
      scope.connectionIds,
      providerHint,
    );

    const extractedMention = this.extractEntityMention(query);
    // If the user directly provided an org_id ("Use entity: <id>"), short-circuit resolution.
    if (extractedMention) {
      const cleaned = extractedMention.replace(/[.?!]+$/, '').trim();
      const direct = connCandidates.find((c) => c.orgId === cleaned);
      if (direct) {
        return {
          status: 'resolved',
          mention: extractedMention,
          orgId: direct.orgId,
          orgName: direct.orgName,
          orgNameLower: direct.orgName.toLowerCase(),
          score: 1,
        };
      }
    }
    const mentionFromQuery = (() => {
      if (extractedMention) return extractedMention;
      const queryNorm = this.normalizeEntityName(query);
      if (!queryNorm) return null;

      const scored = connCandidates
        .map((c) => ({
          orgId: c.orgId,
          orgName: c.orgName,
          score: this.scoreEntityContainedInQuery(
            queryNorm,
            this.normalizeEntityName(c.orgName),
          ),
        }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);

      const best = scored[0];
      const second = scored[1];
      const confident =
        !!best &&
        best.score >= 0.88 &&
        (!second || best.score - second.score >= 0.08);
      return confident ? best.orgName : null;
    })();

    const mention = mentionFromQuery;
    if (!mention) return { status: 'none' };

    const mentionNorm = this.normalizeEntityName(mention);
    if (!mentionNorm) return { status: 'none' };

    const connScored = connCandidates
      .map((c) => ({
        orgId: c.orgId,
        orgName: c.orgName,
        score: this.scoreEntityNameMatch(
          mentionNorm,
          this.normalizeEntityName(c.orgName),
        ),
      }))
      .filter((r) => r.orgId && r.orgName && r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    // Fallback to ClickHouse names (may include org_name variants from ingestion).
    await this.ensureAnalyticsSchema();
    const providerFilter = providerHint
      ? `AND provider = {provider:String}`
      : '';
    const factRows = await this.queryRows<any>(
      `SELECT
         org_id,
         any(coalesce(nullIf(org_name, ''), org_id)) AS org_name,
         sum(abs(total_amount)) AS total_amount
       FROM ${this.analyticsDb}.fact_accounting_invoices
       WHERE org_id IN ({externalOrgIds:Array(String)})
         ${providerFilter}
         AND org_id != ''
       GROUP BY org_id
       ORDER BY total_amount DESC
       LIMIT 200`,
      {
        externalOrgIds: scope.externalOrgIds,
        ...(providerHint ? { provider: providerHint } : {}),
      },
    );

    const factScored = factRows
      .map((r: any) => {
        const orgId = String(r.org_id ?? '').trim();
        const orgName = String(r.org_name ?? orgId).trim();
        const score = this.scoreEntityNameMatch(
          mentionNorm,
          this.normalizeEntityName(orgName),
        );
        return { orgId, orgName, score };
      })
      .filter((r) => r.orgId && r.orgName && r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    const merged = [...connScored, ...factScored].reduce((acc, cur) => {
      const existing = acc.get(cur.orgId);
      if (!existing || cur.score > existing.score) acc.set(cur.orgId, cur);
      return acc;
    }, new Map<string, { orgId: string; orgName: string; score: number }>());

    const scored = Array.from(merged.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    if (scored.length === 0) return { status: 'none' };

    const best = scored[0]!;
    const second = scored[1];
    const confident =
      best.score >= 0.82 && (!second || best.score - second.score >= 0.08);

    if (confident) {
      return {
        status: 'resolved',
        mention,
        orgId: best.orgId,
        orgName: best.orgName,
        orgNameLower: best.orgName.toLowerCase(),
        score: best.score,
      };
    }

    return {
      status: 'ambiguous',
      mention,
      candidates: scored.map((c) => ({
        orgId: c.orgId,
        orgName: c.orgName,
        score: c.score,
      })),
    };
  }

  private parseExplicitChartConstraints(
    query: string,
  ): ExplicitChartConstraints | null {
    const q = query.toLowerCase();
    const requiredTypes: ChartType[] = [];

    const addType = (t: ChartType) => {
      if (!requiredTypes.includes(t)) requiredTypes.push(t);
    };

    const hasComboRequest =
      /\bcombo\s+charts?\b|\bcombination\s+charts?\b/.test(q);
    if (hasComboRequest) addType('combo');

    if (
      !hasComboRequest &&
      /\bline\s*charts?\b|\bline\s*graphs?\b|\bline\b/.test(q) &&
      /\bchart\b|\bgraph\b/.test(q)
    )
      addType('line');
    if (/\bstacked\s+column(?:s)?\b|\bstacked\s+bar\s*charts?\b|\bstacked\s+bars?\b/.test(q))
      addType('stacked_bar');
    if (
      /\barea\s*charts?\b|\barea\s*graphs?\b|\barea\b/.test(q) &&
      /\bchart\b|\bgraph\b/.test(q)
    )
      addType('area');
    if (/\bhorizontal\s+bars?\b|\branked\s+bars?\b|\branked\s+bar\s*charts?\b/.test(q))
      addType('horizontal_bar');
    if (
      /\bbar\s*charts?\b|\bbarcharts?\b|\bbar\s*graphs?\b|\bcolumn\s*charts?\b|\bcolumn\s*graphs?\b|\bstacked\s+bars?\b/.test(
        q,
      ) &&
      !/\bhorizontal\s+bars?\b|\branked\s+bars?\b|\branked\s+bar\s*charts?\b|\bstacked\s+column(?:s)?\b|\bstacked\s+bar\s*charts?\b|\bstacked\s+bars?\b/.test(q)
    )
      addType(
        /\bstacked\s+bar\s*charts?\b|\bstacked\s+bars?\b/.test(q)
          ? 'stacked_bar'
          : 'bar',
      );
    if (/\bpie\s+charts?\b|\bpie\s+graphs?\b/.test(q)) addType('pie');
    if (/\bdonut\b|\bdoughnut\b|\bring\s+charts?\b/.test(q)) addType('donut');
    if (/\btable\b|\btables\b|\btabular\b/.test(q)) addType('table');
    if (/\bmetric\s+tile\b|\bmetric\b/.test(q) && /\btile\b/.test(q))
      addType('metric');
    if (/\bwaterfall\s+charts?\b|\bwaterfall\b/.test(q))
      addType('waterfall');
    if (/\btreemap\b/.test(q)) addType('treemap');
    if (/\bscatter\s*plots?\b|\bscatter\b/.test(q)) addType('scatter');
    if (/\bheat\s*maps?\b|\bheatmaps?\b/.test(q)) addType('heatmap');
    if (/\bmatrix\b/.test(q)) addType('matrix');
    if (/\bhistograms?\b/.test(q)) addType('histogram');
    if (/\bpareto\b/.test(q)) addType('pareto');
    if (/\bgauges?\b/.test(q)) addType('gauge');
    if (/\bbubble\s*charts?\b|\bbubble\s*plots?\b|\bbubble\b/.test(q))
      addType('bubble');
    if (
      /\bkpi\s+cards?\b|\bkpi\s+tiles?\b|\bkpi\s+dashboard\b|\bkpi\b.*\bcard\b|\bmetric\s+cards?\b|\bcard\s+dashboard\b/.test(
        q,
      )
    )
      addType('kpi');
    if (/\bscorecard\b/.test(q)) addType('kpi');
    if (/\bclustered\s+(bars?|columns?)\b/.test(q)) addType('bar');

    const countMatch =
      q.match(
        /\b(?:only|just|exactly)\s+(\d+)\s+(?:charts?|graphs?|widgets?)\b/,
      ) ?? q.match(/\b(\d+)\s+(?:charts?|graphs?|widgets?)\s+only\b/);
    const exactCount = countMatch ? Number(countMatch[1]) : undefined;

    // "as a bar chart" / "as a line chart" implies a single chart.
    const asSingle =
      /\bas\s+a\s+bar\s+chart\b|\bas\s+a\s+line\s+chart\b|\bas\s+a\s+pie\s+chart\b|\bas\s+a\s+table\b/.test(
        q,
      );

    const out: ExplicitChartConstraints = {};
    if (Number.isFinite(exactCount))
      out.exactCount = Math.max(1, Math.min(8, Math.floor(exactCount!)));
    else if (asSingle && requiredTypes.length > 0) out.exactCount = 1;
    if (requiredTypes.length > 0) out.requiredTypes = requiredTypes;

    // "in bar chart" / "in barchart" also implies a single chart.
    const inSingle =
      /\bin\s+a?\s*bar\s*chart\b|\bin\s+barchart\b/.test(q) ||
      /\bin\s+a?\s*line\s*chart\b|\bin\s+linechart\b/.test(q) ||
      /\bin\s+a?\s*pie\s*chart\b|\bin\s+piechart\b/.test(q) ||
      /\bin\s+a?\s*table\b/.test(q);
    if (!out.exactCount && inSingle && requiredTypes.length > 0)
      out.exactCount = 1;

    return out.exactCount || out.requiredTypes ? out : null;
  }

  private detectPureChartTypeEditRequest(editRequest: string): ChartType | null {
    const explicitTypes =
      this.parseExplicitChartConstraints(editRequest)?.requiredTypes ?? [];
    if (explicitTypes.length !== 1) return null;

    // A recognized DATA transform (normalize, growth %, variance, moving average,
    // reference line, second axis…) takes precedence — "replace spend with MoM
    // growth % in that table" must NOT be treated as a pure switch to a table.
    if (this.detectFollowUpTransform(editRequest)) return null;

    const q = editRequest.toLowerCase();
    const hasEditVerb =
      /\b(switch|change|convert|replace|turn|make|set|update|transform|swap)\b/.test(
        q,
      );
    const hasBroadScopeHint =
      /\b(add|remove|delete|also|and|plus|another|new|additional|instead of|as well as)\b/.test(
        q,
      );

    if (!hasEditVerb || hasBroadScopeHint) return null;
    return explicitTypes[0] ?? null;
  }

  // ─── Plan Generation — Ollama is the sole dashboard architect ───────────────
  // Ollama sees live data context + full chart vocabulary and decides freely.
  // selectWidgetsForQuery is only called if Ollama completely fails.

  // --- legacy generatePlan() (vocab/metricData planner) DELETED: its 3 roles in
  // --- query() were retired (no_data rescue validated redundant; offline →
  // --- honest error + plan cache; edit tools → deriveToolsFromWidgets). ---

  // High-precision percent-format inference for metric="dynamic" charts built from
  // LLM SQL (which, unlike the catalog path, carry no measure.format). Returns
  // 'percent' ONLY on an explicit percentage signal and never when an explicit USD/$
  // unit is present, so it can never mislabel a currency chart. The LLM already states
  // the unit in yAxisLabel (e.g. "Gross Margin (%)", "MoM Growth (%)").
  private inferPercentFormat(
    ...labels: Array<string | undefined>
  ): 'percent' | null {
    const s = labels.filter(Boolean).join(' ').toLowerCase();
    if (!s) return null;
    if (/\busd\b|\(\s*\$\s*\)|dollars?/.test(s)) return null; // explicit currency → leave as-is
    if (/%|\bpercent(age)?\b|\bsla\b|\bcsat\b|utili[sz]ation/.test(s)) return 'percent';
    return null;
  }

  private deriveToolsFromWidgets(
    widgets: Array<{
      type: ChartType;
      metric: string;
      grouping: string;
      breakdown?: 'client';
    }>,
    query: string,
  ): string[] {
    const tools = new Set<string>();

    for (const w of widgets) {
      if (w.metric === 'venture' || w.type === 'metric')
        tools.add('venture_metrics');
      if (w.grouping === 'month' || w.grouping === 'quarter')
        tools.add('revenue_trend');
      if (w.grouping === 'org' || w.grouping === 'provider')
        tools.add('entity_comparison');
      if (w.metric === 'invoices' || w.grouping === 'status')
        tools.add('invoice_breakdown');
      const wantsClientData =
        w.grouping === 'client' || (w.breakdown && w.breakdown === 'client');
      if (wantsClientData) {
        tools.add('client_financial_profile');
        tools.add('client_breakdown');
      }
    }

    // Always include a lightweight summary so synthesis can anchor quickly.
    tools.add('financial_summary');

    // Safety: if the query clearly asks about clients/top clients, ensure client tools are present
    // even if the widget model expressed it via titles/intent rather than `grouping`/`breakdown`.
    const spec = parseQuerySpec(query);
    if (
      spec.wantsTopClients ||
      /\b(client|clients|customer|customers|contact|contacts)\b/i.test(query)
    ) {
      tools.add('client_financial_profile');
      tools.add('client_breakdown');
    }

    const inferred = Array.from(tools);
    // If inference yields nothing (shouldn't), fall back to deterministic intent-based tool selection.
    return inferred.length > 0 ? inferred : this.selectToolsForQuery(query);
  }

  private scorePlannedDashboard(
    query: string,
    widgets: Array<{
      type: ChartType;
      metric: string;
      grouping: string;
    }>,
  ): number {
    const q = query.toLowerCase();
    const has = (r: RegExp) => r.test(q);

    let score = 0;

    // Prefer minimal dashboards unless the query implies multiple views.
    // We deliberately avoid forcing a 4+ widget "pack" for single-question asks.
    score += Math.min(widgets.length, 8) * 8;

    // Diversity across visualization types.
    const types = new Set(
      widgets.map((w) => (w.type === 'area' ? 'line' : w.type)),
    );
    if (types.has('line')) score += 8;
    if (types.has('bar')) score += 8;
    if (types.has('pie')) score += 6;
    if (types.has('metric')) score += 4;
    if (types.has('table')) score += 3;

    // Query-intent alignment (cheap, deterministic heuristic scoring).
    if (has(/\brevenue\b|\bsales\b/))
      score += widgets.filter((w) => w.metric === 'revenue').length * 10;
    if (has(/\bpaid\b|\bcollected\b|\bcash\b/))
      score +=
        widgets.filter(
          (w) => w.metric === 'paid' || w.metric === 'collection_rate',
        ).length * 6;
    if (has(/client|customer|contact/))
      score += widgets.filter((w) => w.grouping === 'client').length * 6;
    if (has(/overdue|aging|ar\b|receivable|collect|past.?due/)) {
      score +=
        widgets.filter(
          (w) => w.metric === 'overdue' || w.metric === 'overdue_rate',
        ).length * 8;
      score += widgets.filter((w) => w.grouping === 'status').length * 3;
    }
    if (has(/trend|growth|momentum|mom\b|yoy|month/))
      score +=
        widgets.filter((w) => w.type === 'line' || w.type === 'area').length *
        5;
    if (has(/quarter|q[1-4]\b|qoq|quarterly/))
      score += widgets.filter((w) => w.grouping === 'quarter').length * 6;
    if (has(/entity|org\b|entities|compare|versus|vs\b|concentration/))
      score += widgets.filter((w) => w.grouping === 'org').length * 5;
    if (has(/provider|erp|xero|quickbooks|qbo|netsuite|integration/))
      score += widgets.filter((w) => w.grouping === 'provider').length * 7;
    if (has(/audit|list|show|detail|transaction/))
      score += widgets.filter((w) => w.type === 'table').length * 8;
    if (has(/runway|burn|cash|venture|investor|fundraise/))
      score +=
        widgets.filter((w) => w.type === 'metric' || w.metric === 'venture')
          .length * 6;

    // P&L / net income
    if (
      has(
        /p&l|pl\b|profit\s+and\s+loss|income\s+statement|net\s+income|net\s+profit/,
      )
    )
      score +=
        widgets.filter((w) =>
          ['net_income', 'pl', 'pl_summary'].includes(w.metric),
        ).length * 12;

    // Expense / OPEX / cost
    if (
      has(
        /expense|expenses|opex|operating\s+expense|cost\s+breakdown|spending|spend|overheads?|cogs|cost\s+of\s+goods|cost\s+of\s+sales|direct\s+cost/,
      )
    )
      score +=
        widgets.filter((w) =>
          ['expense', 'opex', 'cogs', 'expense_summary'].includes(w.metric),
        ).length * 12;

    // Margin analysis
    if (has(/gross\s+margin|net\s+margin|margin|profitability|gross\s+profit/))
      score +=
        widgets.filter((w) =>
          [
            'gross_margin_pct',
            'net_margin_pct',
            'gross_profit',
            'pl_summary',
          ].includes(w.metric),
        ).length * 12;

    // EBITDA
    if (has(/ebitda/))
      score += widgets.filter((w) => w.metric === 'ebitda').length * 15;

    // GL / journal
    if (has(/journal|gl\b|general\s+ledger|ledger\s+entries/))
      score +=
        widgets.filter((w) => ['gl_transactions', 'pl'].includes(w.metric))
          .length * 10;

    // Revenue vs expense comparison
    if (
      has(
        /revenue\s+vs\s+expense|revenue\s+and\s+expense|expense\s+vs\s+revenue/,
      )
    )
      score +=
        widgets.filter((w) => w.metric === 'revenue_vs_expense').length * 12;

    return score;
  }

  private validateWidgetsAgainstSpec(
    spec: QuerySpec,
    widgets: Array<{ type: string; metric: string; grouping: string }>,
  ): string[] {
    const errs: string[] = [];
    const has = (pred: (w: (typeof widgets)[number]) => boolean) =>
      widgets.some(pred);
    const count = (pred: (w: (typeof widgets)[number]) => boolean) =>
      widgets.filter(pred).length;

    if (spec.paymentDaysIntent) {
      if (spec.paymentDaysIntent === 'LIST') {
        if (
          !has(
            (w) =>
              w.type === 'table' &&
              w.metric === 'payment_days' &&
              w.grouping === 'list',
          )
        ) {
          errs.push('PAYMENT_DAYS_LIST_REQUIRES_TABLE');
        }
      }
      if (spec.paymentDaysIntent === 'TREND') {
        if (!has((w) => w.metric === 'dso' && w.grouping === 'month')) {
          errs.push('PAYMENT_DAYS_TREND_REQUIRES_DSO');
        }
      }
      if (spec.paymentDaysIntent === 'DISTRIBUTION') {
        if (
          !has(
            (w) =>
              w.type === 'bar' &&
              w.metric === 'payment_days' &&
              w.grouping === 'bucket',
          )
        ) {
          errs.push('PAYMENT_DAYS_DISTRIBUTION_REQUIRES_BUCKETS');
        }
      }
    }

    if (spec.focus === 'AUDIT') {
      if (!has((w) => w.type === 'table')) errs.push('AUDIT_REQUIRES_TABLE');
    }

    if (spec.focus === 'VENTURE') {
      if (!has((w) => w.type === 'metric' || w.metric === 'venture'))
        errs.push('VENTURE_REQUIRES_METRIC');
    }
    // Avoid irrelevant venture metric tiles when the query isn't about venture runway/burn.
    if (spec.focus !== 'VENTURE') {
      if (has((w) => w.metric === 'venture'))
        errs.push('VENTURE_WIDGET_NOT_RELEVANT');
    }

    if (spec.focus === 'AR_RISK') {
      if (!has((w) => w.metric === 'overdue' || w.metric === 'overdue_rate'))
        errs.push('AR_RISK_REQUIRES_OVERDUE');
    }

    if (spec.wantsTopClients) {
      const hasClientGrouping = count((w) => w.grouping === 'client') >= 1;
      const hasTopClientsTimeSeries = widgets.some(
        (w: any) =>
          w.metric === 'revenue' &&
          w.grouping === 'month' &&
          w.breakdown === 'client',
      );
      if (!hasClientGrouping && !hasTopClientsTimeSeries)
        errs.push('TOP_CLIENTS_REQUIRES_CLIENT_BREAKDOWN');
      // If the user requested a time window ("last 6 months") treat it as a trend request —
      // enforce the time-series top-clients view (otherwise they get a lifetime ranking).
      if (spec.wantsTrend && !hasTopClientsTimeSeries)
        errs.push('TOP_CLIENTS_TREND_REQUIRES_TIME_SERIES');
    }

    if (spec.focus === 'PNL') {
      const hasPnlWidget = has((w) =>
        [
          'net_income',
          'pl',
          'pl_summary',
          'gross_profit',
          'revenue_vs_expense',
        ].includes(w.metric),
      );
      if (!hasPnlWidget) errs.push('PNL_REQUIRES_PNL_WIDGET');
    }

    if (spec.focus === 'EXPENSE') {
      const hasExpenseWidget = has(
        // 'pl' covers waterfall/pl/summary which shows COGS + OpEx breakdown
        (w) =>
          [
            'expense',
            'opex',
            'cogs',
            'expense_summary',
            'pl',
            'pl_summary',
            'net_income',
          ].includes(w.metric),
      );
      if (!hasExpenseWidget) errs.push('EXPENSE_REQUIRES_EXPENSE_WIDGET');
    }

    if (spec.focus === 'MARGIN') {
      const hasMarginWidget = has((w) =>
        [
          'gross_margin_pct',
          'net_margin_pct',
          'gross_profit',
          'pl_summary',
        ].includes(w.metric),
      );
      if (!hasMarginWidget) errs.push('MARGIN_REQUIRES_MARGIN_WIDGET');
    }

    if (spec.focus === 'EBITDA') {
      if (!has((w) => w.metric === 'ebitda'))
        errs.push('EBITDA_REQUIRES_EBITDA_WIDGET');
    }

    if (spec.focus === 'GL') {
      const hasGlWidget = has((w) =>
        ['gl_transactions', 'pl', 'expense'].includes(w.metric),
      );
      if (!hasGlWidget) errs.push('GL_REQUIRES_GL_WIDGET');
    }

    if (spec.wantsTrend) {
      // Trend intent can be satisfied by either a line or a time-binned bar chart.
      if (
        !has(
          (w) =>
            (w.type === 'line' || w.type === 'area' || w.type === 'bar') &&
            (w.grouping === 'month' || w.grouping === 'quarter'),
        )
      ) {
        errs.push('TREND_REQUIRES_TIME_SERIES');
      }
    }

    if (spec.wantsQuarterly) {
      if (!has((w) => w.grouping === 'quarter'))
        errs.push('QUARTERLY_REQUIRES_QUARTER_GROUPING');
    }

    return errs;
  }

  // ─── Hybrid clarification gate (reduce chart mismatch to near-zero) ───────
  // We only ask when the user's query is ambiguous in a way that changes which
  // charts we should build. Otherwise we proceed with best-effort planning.

  private isLikelyClarificationAnswer(query: string): boolean {
    const q = query.trim().toLowerCase();
    if (!q) return false;
    if (q.length > 80) return false;

    // Common short answers to our clarification prompts.
    if (/^(all time|lifetime|overall|since inception)$/.test(q)) return true;
    if (
      /^(last|past)\s+\d+\s+(day|days|week|weeks|month|months|quarter|quarters|year|years)$/.test(
        q,
      )
    )
      return true;
    if (/^(ytd|mtd|qtd)$/.test(q)) return true;
    if (
      /^by\s+(revenue|billed|paid|outstanding|overdue|collection rate|overdue rate)$/.test(
        q,
      )
    )
      return true;
    if (
      /^(revenue|paid|outstanding|overdue|collection rate|overdue rate)$/.test(
        q,
      )
    )
      return true;

    return false;
  }

  private getClarificationPrompt(
    query: string,
    intent: QueryIntent,
  ): ClarificationPrompt | null {
    if (intent === 'EDIT_DASHBOARD') return null;

    const q = query.trim().toLowerCase();
    if (!q) return null;
    if (this.isLikelyClarificationAnswer(q)) return null;

    const spec = parseQuerySpec(query);

    // Balance sheet / cash flow statements are not derivable from journal lines alone.
    // Only block if the user is *exclusively* asking for those (no other answerable signals).
    const strictlyUnsupported =
      /\b(balance\s*sheet|cash\s*flow\s*statement|statement\s*of\s*cash\s*flows?)\b/i;
    const hasAnyAnswerableSignal =
      /\b(revenue|sales|paid|collected|outstanding|overdue|invoice|invoices|ar\b|aging|collections?|expense|expenses|opex|ebitda|margin|profit|loss|p&l|income|cogs|cost|gl|journal)\b/i.test(
        query,
      );

    if (strictlyUnsupported.test(query) && !hasAnyAnswerableSignal) {
      return {
        reason: 'UNSUPPORTED_METRIC',
        question: `Balance sheet and cash flow statements require additional data beyond what is currently synced. I can build P&L, expense breakdowns, margin analysis, and AR dashboards. Which would you like?`,
        options: [
          {
            label: 'P&L / Income Statement',
            value:
              'Build a full P&L with net income, gross margin, and expense breakdown.',
          },
          {
            label: 'Expense analysis',
            value: 'Show expenses by GL account with COGS vs OPEX breakdown.',
          },
          {
            label: 'Revenue & AR',
            value: 'Focus on revenue trends, outstanding, and overdue.',
          },
          {
            label: 'Executive CFO dashboard',
            value:
              'Build a comprehensive CFO dashboard with P&L, margin, AR, and client data.',
          },
        ],
      };
    }

    // "Top clients/customers" is ambiguous without a "by X" qualifier.
    const topClients = /(top|best|biggest)\s+(clients|customers|contacts)\b/i;
    const hasQualifier =
      /\b(by|based on)\b|\brevenue\b|\bbilled\b|\bpaid\b|\boutstanding\b|\boverdue\b|\bcollection\b|\brate\b/i;
    if (topClients.test(query) && !hasQualifier.test(query)) {
      return {
        reason: 'TOP_CLIENTS_AMBIGUOUS',
        question: 'When you say “top clients”, what should “top” mean?',
        options: [
          {
            label: 'By revenue collected',
            value: 'Show top clients by revenue collected.',
          },
          {
            label: 'By total invoiced',
            value: 'Show top clients by total invoiced.',
          },
          {
            label: 'By outstanding balance',
            value: 'Show top clients by outstanding balance.',
          },
          {
            label: 'By overdue exposure',
            value: 'Show top clients by overdue exposure.',
          },
        ],
      };
    }

    // "Collections" can mean paid trend vs delinquency vs rate; clarify once.
    const collections = /\b(collections?|collect|collection efficiency)\b/i;
    const collectionsQualified = /\b(overdue|outstanding|paid|rate)\b/i;
    if (collections.test(query) && !collectionsQualified.test(query)) {
      return {
        reason: 'COLLECTIONS_AMBIGUOUS',
        question:
          'For “collections”, what should I optimize for in the dashboard?',
        options: [
          {
            label: 'Cash collected',
            value: 'Focus on paid amounts and paid trend.',
          },
          {
            label: 'Delinquency risk',
            value: 'Focus on outstanding vs overdue and overdue trend.',
          },
          {
            label: 'Efficiency rates',
            value: 'Focus on collection rate and overdue rate by client.',
          },
          {
            label: 'All of the above',
            value:
              'Include paid, overdue/outstanding, and collection/overdue rates.',
          },
        ],
      };
    }

    // Time windows: if user implies time sensitivity but didn't specify a parseable window, ask once.
    const impliesTime =
      /\b(last|past|recent|lately|this month|this quarter|this year|ytd|mtd|qtd|since)\b/i;
    if (impliesTime.test(query) && !spec.timeRange) {
      return {
        reason: 'TIME_RANGE_AMBIGUOUS',
        question: 'What time window should this dashboard cover?',
        options: [
          { label: 'Last 30 days', value: 'Last 30 days' },
          { label: 'Last 90 days', value: 'Last 90 days' },
          { label: 'Last 12 months', value: 'Last 12 months' },
          { label: 'All time', value: 'All time' },
        ],
      };
    }

    return null;
  }

  // ─── Edit Plan Generation ─────────────────────────────────────────────────

  // ─── SQL-first Dashboard Editor ───────────────────────────────────────────
  // Mirrors generateSmartPlan, but for EDITS: it feeds the LLM each chart's
  // current live SQL plus the user's modification request and asks it to rewrite
  // the SQL (and/or type/title/axis labels/label mode) for the charts that must
  // change. Every rewritten SQL goes through the same validate -> execute ->
  // one-shot self-repair loop the builder uses, so a chart only changes if the
  // new query actually returns clean data. Returns a DashboardEditPlan whose
  // modify/add entries carry the new dynamicSql, or null when the editor is
  // unavailable / declines to act (caller then falls back to the vocab editor).
  // Shared guard so a "refusal"/clarify field never leaks raw SQL to the user.
  private looksLikeSqlText(s: string): boolean {
    return (
      /\bSELECT\b[\s\S]*\bFROM\b/i.test(s) ||
      /\{(?:externalOrgIds|tenantId|asOf)\s*:/i.test(s) ||
      /\b(sumIf|formatDateTime|toStartOf|toFloat64|GROUP\s+BY)\b/i.test(s)
    );
  }

  private async generateSmartEditPlan(
    activeDashboard: ActiveDashboard,
    editRequest: string,
    scope: OrgScope,
    range?: TimeRange,
    conversationHistory?: string,
  ): Promise<DashboardEditPlan | null> {
    try {
      if (activeDashboard.widgets.length === 0) return null;
      if (scope.externalOrgIds.length === 0) return null;

      // Verify Ollama is reachable before the expensive introspection.
      const ping = await fetch(`${this.OLLAMA_URL}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      }).catch(() => null);
      if (!ping?.ok) return null;

      const liveContext = await this.introspectLiveSchema(scope);

      const widgetList = activeDashboard.widgets
        .map((w, i) => {
          const cfg = (w.queryConfig as any) ?? {};
          const sql =
            typeof cfg.dynamicSql === 'string' && cfg.dynamicSql.trim()
              ? cfg.dynamicSql.trim()
              : `(vocabulary widget — no editable SQL; metric=${cfg.metric ?? '?'}, grouping=${cfg.grouping ?? '?'})`;
          const labelMode = cfg?.display?.labelMode
            ? `, labelMode=${cfg.display.labelMode}`
            : '';
          return `INDEX ${i}: type=${w.chartType}${labelMode}, title="${w.title}"\n  SQL: ${sql}`;
        })
        .join('\n\n');

      const historySnippet =
        conversationHistory && !conversationHistory.includes('(No prior')
          ? `\nCONVERSATION CONTEXT:\n${conversationHistory.slice(0, 800)}\n`
          : '';
      const timeHint = range
        ? `\nTime filter in effect: ${JSON.stringify(range)} — preserve it unless the user changes the time range.`
        : '';

      const userMsg = [
        `LIVE SCHEMA / DATA:\n${liveContext}`,
        `\nCURRENT DASHBOARD: "${activeDashboard.title}"`,
        `CURRENT CHARTS (0-indexed):\n${widgetList}`,
        historySnippet,
        timeHint,
        `\nUSER EDIT REQUEST: "${editRequest}"`,
        `Return the edit JSON now. Rewrite the SQL of any chart whose DATA must change (axis, dimension, metric, percentage vs values, filter, sort, top-N, time). For a pure type/title/label change, omit "sql".`,
      ]
        .filter(Boolean)
        .join('\n');

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), LLM_CHAT_TIMEOUT_MS);
      const response = await fetch(`${this.OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.OLLAMA_MODEL,
          messages: [
            { role: 'system', content: SMART_SQL_EDITOR_SYSTEM },
            { role: 'user', content: userMsg },
          ],
          stream: false,
          options: { temperature: 0.05, num_predict: 4000, num_ctx: 16384 },
        }),
      });
      clearTimeout(timer);
      if (!response.ok) return null;

      const body = (await response.json()) as { message?: { content?: string } };
      const rawText = (body.message?.content ?? '')
        .replace(/```json|```/g, '')
        .trim();
      let parsed: any;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        const m = rawText.match(/\{[\s\S]*\}/);
        if (!m) return null;
        parsed = JSON.parse(m[0]);
      }

      // The model may decline when the ask needs data/columns or a feature that
      // does not exist. Honor that as a CLEAR refusal rather than silently keeping
      // the chart (which reads to the user as "same output"). Guard against the
      // model leaking SQL into the refusal text.
      const refusalText =
        typeof parsed?.refusal === 'string' ? parsed.refusal.trim() : '';
      const opsIn = Array.isArray(parsed?.widgets) ? parsed.widgets : [];
      const addsIn = Array.isArray(parsed?.add) ? parsed.add : [];
      if (refusalText && !this.looksLikeSqlText(refusalText)) {
        const hasRealOps =
          opsIn.some(
            (op: any) =>
              String(op?.action ?? 'update').toLowerCase() !== 'keep' &&
              (typeof op?.sql === 'string' ? op.sql.trim().length > 0 : false),
          ) || addsIn.length > 0;
        if (!hasRealOps) {
          return {
            summary: '',
            add: [],
            remove_indices: [],
            modify: [],
            refusal: refusalText.slice(0, 400),
          };
        }
      }
      if (opsIn.length === 0 && addsIn.length === 0) return null;

      // Validate + execute + one self-repair. Returns final scoped SQL or null.
      const verifySql = async (
        rawSql: string,
        chartType: ChartType,
      ): Promise<string | null> => {
        let scoped: string;
        try {
          scoped = this.validateAndScopeDynamicSql(
            String(rawSql).trim().replace(/;+$/, ''),
            scope,
            { chartType },
          );
        } catch {
          return null;
        }
        const r1 = await this.executeDynamicSqlChecked(scoped, scope, {
          chartType,
        });
        let problem: string | null = null;
        if (r1.error) problem = r1.error;
        else if (r1.rows.length === 0) return null;
        else problem = this.detectBadChartShape(r1.rows, chartType);
        if (!problem) return scoped;

        const repaired = await this.repairSqlViaLLM(scoped, problem, liveContext);
        if (!repaired) return null;
        let scoped2: string;
        try {
          scoped2 = this.validateAndScopeDynamicSql(repaired, scope, {
            chartType,
          });
        } catch {
          return null;
        }
        const r2 = await this.executeDynamicSqlChecked(scoped2, scope, {
          chartType,
        });
        if (r2.rows.length > 0 && !this.detectBadChartShape(r2.rows, chartType))
          return scoped2;
        return null;
      };

      const plan: DashboardEditPlan = {
        summary: String(parsed?.summary ?? 'Updated your dashboard').slice(
          0,
          200,
        ),
        add: [],
        remove_indices: [],
        modify: [],
      };

      for (const op of opsIn) {
        const index = Number(op?.index);
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= activeDashboard.widgets.length
        )
          continue;
        const action = String(op?.action ?? 'update').toLowerCase();
        if (action === 'keep') continue;
        if (action === 'remove') {
          plan.remove_indices.push(index);
          continue;
        }

        const widget = activeDashboard.widgets[index]!;
        const nextType =
          typeof op?.type === 'string' && op.type.trim()
            ? (op.type.trim() as ChartType)
            : (widget.chartType as ChartType);
        const mod: DashboardEditPlan['modify'][number] = { index };
        if (typeof op?.title === 'string' && op.title.trim())
          mod.title = op.title.trim().slice(0, 80);
        if (typeof op?.type === 'string' && op.type.trim())
          mod.type = op.type.trim() as ChartType;
        if (typeof op?.xAxisLabel === 'string')
          mod.xAxisLabel = op.xAxisLabel.slice(0, 60);
        if (typeof op?.yAxisLabel === 'string')
          mod.yAxisLabel = op.yAxisLabel.slice(0, 60);
        if (op?.labelMode === 'value' || op?.labelMode === 'percent')
          mod.display = { labelMode: op.labelMode };

        const requestedSqlRewrite =
          typeof op?.sql === 'string' && op.sql.trim().length > 0;
        if (requestedSqlRewrite) {
          const finalSql = await verifySql(op.sql, nextType);
          if (finalSql) {
            mod.dynamicSql = finalSql;
          } else {
            this.logger.warn(
              `[SmartEdit] rewritten SQL for chart ${index} failed verification — keeping original data`,
            );
          }
        }

        // If the model attempted a data rewrite but the SQL failed verification,
        // do not keep a cosmetic-only shell of the edit (often just the same chart
        // type/title). That falsely reports success while leaving the data
        // unchanged, which is exactly what the EBPO prompt suite is catching.
        if (requestedSqlRewrite && !mod.dynamicSql) continue;

        const hasChange =
          mod.title !== undefined ||
          mod.type !== undefined ||
          mod.xAxisLabel !== undefined ||
          mod.yAxisLabel !== undefined ||
          mod.display !== undefined ||
          mod.dynamicSql !== undefined;
        if (hasChange) plan.modify.push(mod);
      }

      const slotsLeft = () =>
        8 -
        (activeDashboard.widgets.length -
          plan.remove_indices.length +
          plan.add.length);
      for (const a of addsIn) {
        if (slotsLeft() <= 0) break;
        if (typeof a?.sql !== 'string' || !a.sql.trim()) continue;
        const type =
          typeof a?.type === 'string' && a.type.trim()
            ? (a.type.trim() as ChartType)
            : ('bar' as ChartType);
        const finalSql = await verifySql(a.sql, type);
        if (!finalSql) continue;
        plan.add.push({
          title: String(a?.title ?? 'New chart').slice(0, 45),
          description: String(a?.description ?? ''),
          type,
          metric: 'dynamic',
          grouping: 'query',
          ...(typeof a?.xAxisLabel === 'string'
            ? { xAxisLabel: a.xAxisLabel.slice(0, 60) }
            : {}),
          ...(typeof a?.yAxisLabel === 'string'
            ? { yAxisLabel: a.yAxisLabel.slice(0, 60) }
            : {}),
          ...(this.inferPercentFormat(a?.yAxisLabel, a?.title)
            ? { display: { valueFormat: 'percent' as const } }
            : {}),
          dynamicSql: finalSql,
        });
      }

      if (
        plan.modify.length === 0 &&
        plan.add.length === 0 &&
        plan.remove_indices.length === 0
      )
        return null;

      this.logger.log(
        `[SmartEdit] ${plan.modify.length} modified, ${plan.add.length} added, ${plan.remove_indices.length} removed for: "${editRequest.slice(0, 60)}"`,
      );
      return plan;
    } catch (err: any) {
      this.logger.warn(`[SmartEdit] failed: ${err?.message ?? err}`);
      return null;
    }
  }

  // ─── Layer D: deterministic follow-up transforms ──────────────────────────
  // Follow-ups like "normalize to 100%", "add a company-wide average line", or
  // "add a 3-month moving average" used to be free-written as SQL by the LLM,
  // which frequently hallucinated columns or produced invalid ClickHouse — so the
  // editor silently kept the old chart ("same output"). Instead we classify the
  // intent and build the SQL deterministically by wrapping the chart's EXISTING
  // SQL, and attach render hints so the frontend expresses the change. Asks the
  // data can't satisfy (YoY/prior-year with a single year) are refused clearly.
  private parseSecondMeasure(q: string): SecondMeasure | null {
    if (/\binvoice/.test(q))
      return { measure: 'invoices', alias: 'invoice_count', label: 'Invoice count', format: 'number', expr: '' };
    if (
      /\baverage\s+transaction\s+value\b|\bavg\s+transaction\b|\baverage\s+(invoice|transaction)\s+value\b|\baverage\s+value\b/.test(
        q,
      )
    )
      return {
        measure: 'avg_txn',
        alias: 'avg_transaction_value',
        label: 'Avg transaction value',
        format: 'currency',
        expr: 'round(avg(toFloat64(debit)), 2)',
      };
    if (
      /\btransaction\s+count\b|\bnumber\s+of\s+transactions\b|\btransaction\s+volume\b|\bcount\s+of\s+transactions\b|#\s*of\s*transactions/.test(
        q,
      )
    )
      return {
        measure: 'count',
        alias: 'transaction_count',
        label: 'Transaction count',
        format: 'number',
        expr: 'count()',
      };
    if (/\btotal\s+spend\b|\bspend\b|\btotal\s+amount\b|\bamount\b/.test(q))
      return {
        measure: 'spend',
        alias: 'total_spend',
        label: 'Total spend',
        format: 'currency',
        expr: 'round(sum(toFloat64(debit)), 2)',
      };
    if (/\bcredit/.test(q))
      return {
        measure: 'credits',
        alias: 'total_credit',
        label: 'Total credit',
        format: 'currency',
        expr: 'round(sum(toFloat64(credit)), 2)',
      };
    return null;
  }

  private detectFollowUpTransform(req: string): FollowUpTransform | null {
    const q = (req ?? '').toLowerCase();
    if (!q.trim()) return null;
    if (/\byear[\s-]*over[\s-]*year\b|\byoy\b|\byear[\s-]*on[\s-]*year\b/.test(q))
      return { kind: 'yoy' };
    if (/\bprior[\s-]*year\b|\bprevious[\s-]*year\b|\blast[\s-]*year\b/.test(q))
      return { kind: 'prior_year' };
    if (/\bmoving[\s-]*average\b|\brolling[\s-]*average\b|\bmoving[\s-]*avg\b/.test(q)) {
      const m = q.match(/(\d+)[\s-]*(?:month|day|period|week)/);
      return { kind: 'moving_average', window: m ? Math.max(2, Math.min(12, Number(m[1]))) : 3 };
    }
    // Period-over-period growth % (replace each value with its % change vs the
    // previous period). Distinct from normalize (% of total) and variance ($
    // change). Must be checked before normalize/variance. "month-over-month",
    // "MoM", "growth %", "% change", "percentage change", "rate of change".
    const momPeriod =
      /\bmonth[\s-]*over[\s-]*month\b|\bm\/m\b|\bmom\b|\bperiod[\s-]*over[\s-]*period\b|\bquarter[\s-]*over[\s-]*quarter\b|\bq\/q\b/.test(
        q,
      );
    const growthPct =
      /\bgrowth\s*(?:rate|%|percent(?:age)?)\b|\b(?:%|percent(?:age)?)\s*growth\b|\b(?:percent(?:age)?|%)\s*change\b|\bchange\s*(?:%|percent(?:age)?)\b|\brate\s+of\s+change\b/.test(
        q,
      );
    if (
      (momPeriod && (growthPct || /\bgrowth\b/.test(q))) ||
      (growthPct &&
        /\b(replace|show|display|convert|express|as)\b/.test(q) &&
        !/\bof\s+(?:the\s+)?total\b/.test(q))
    )
      return { kind: 'growth_pct' };
    // Variance column ($ change vs the previous period). Period-over-period only —
    // prior-year/prior-quarter against single-year data is handled by the yoy/
    // prior_year refusal above (checked first).
    if (
      /\bvariance\s+column\b|\badd\s+a\s+variance\b/.test(q) ||
      (/\bvariance\b|\$?\s*change\b|\bdelta\b/.test(q) &&
        /\b(prior|previous|last)\s+(?:period|quarter|month)\b|\bprior[\s-]?period\b/.test(q))
    )
      return { kind: 'variance' };
    // Second axis / second series with an explicit additional measure. Checked
    // before reference_line because "add a line for <measure>" also mentions "line".
    const secondIntent =
      /\bsecond(?:ary)?\s+(?:axis|y-?axis|bar|series|line)\b/.test(q) ||
      /\badd\s+a\s+(?:second\s+)?(?:bar|line|axis)\b/.test(q) ||
      /\bon\s+(?:a|the)\s+(?:second|secondary)\s+axis\b/.test(q) ||
      (/\balong\s+with\b|\bfor\s+comparison\b/.test(q) && /\b(bar|line|axis|show)/.test(q));
    if (secondIntent) {
      const second = this.parseSecondMeasure(q);
      if (second) return { kind: 'second_axis', second };
    }
    if (
      /\bnormali[sz]e\b|\b100\s*%|\bas a (?:percentage|percent|%)\s+of\s+(?:the\s+)?(?:company\s+|grand\s+)?total\b|\b%\s*of\s*(?:the\s+)?(?:company\s+)?total\b|\bshare of (?:the\s+)?total\b|\bpercentage of (?:the\s+)?(?:company\s+)?total\b|\bproportion of (?:the\s+)?total\b/.test(
        q,
      )
    )
      return { kind: 'normalize' };
    // A flat company/overall average is a SINGLE reference line. But "average <measure>
    // ... by <dimension>" (e.g. "add average monthly salary line by country") is a
    // PER-CATEGORY series, not a flat line — let it fall through to the measure-add
    // (combo) path instead of being hijacked into a company-average reference line.
    const isGroupedAverageSeries =
      /\b(?:average|avg|mean)\b[^.]*\bby\s+[a-z]/i.test(q) &&
      !/\b(company[\s-]*wide|overall|grand|across\s+all)\b/i.test(q);
    if (
      !isGroupedAverageSeries &&
      (/\b(company[\s-]*wide|overall|average|mean|reference|benchmark|target)\b[^.]*\bline\b/.test(q) ||
        /\bline\b[^.]*\b(company[\s-]*wide|overall|average|mean|reference|benchmark|target)\b/.test(q) ||
        /\boverlay\b[^.]*\baverage\b/.test(q) ||
        /\btrend\s+indicators?\b[^.]*\b(?:monthly\s+)?average\b/.test(q) ||
        // NOTE the group: bare "compare" must NOT trigger an average line — that
        // hijacked every "add <measure> to compare" request into a company-average
        // reference line instead of adding the named measure as a 2nd series.
        /\b(?:compare|comparing)\b[^.]*\b(?:monthly\s+)?average\b/.test(q) ||
        /\breference\s+line\b/.test(q))
    )
      return { kind: 'reference_line' };
    return null;
  }

  // Pure presentation toggle for pie/donut labels (percent ↔ whole values).
  // Shared by the legacy editor and the spec editor so "change the percentage to
  // values" works regardless of which path handles the edit.
  private detectLabelModeEdit(req: string): 'value' | 'percent' | null {
    const q = String(req ?? '');
    const wantsValue =
      /\b(whole\s+values?|values?\s+instead\s+of\s+percent(?:age|ages)?|remove\s+percent(?:age|ages)?|show\s+values?|raw\s+values?)\b/i.test(q) ||
      /\bneed\s+values?\b/i.test(q) ||
      /\babsolute\s+values?\b/i.test(q) ||
      /\bnumbers?\s+instead\s+of\s+percent(?:age|ages)?\b/i.test(q) ||
      /\bwithout\s+percent(?:age|ages)?\b/i.test(q) ||
      /\bno\s+percent(?:age|ages)?\b/i.test(q) ||
      /\bpercent(?:age|ages)?\s+to\s+values?\b/i.test(q);
    if (wantsValue) return 'value';
    const wantsPercent =
      /\bpercent(?:age|ages)?\s+to\s+percent(?:age|ages)?\b/i.test(q) ||
      /\bshow\s+percent(?:age|ages)?\b/i.test(q) ||
      /\bpercent(?:age|ages)?\s+labels?\b/i.test(q) ||
      /\bas\s+percent(?:age|ages)?\b/i.test(q);
    return wantsPercent ? 'percent' : null;
  }

  private detectMatrixDisplayEdit(req: string): DisplayHints | null {
    const q = (req ?? '').toLowerCase();
    if (!q.trim()) return null;
    const mentionsMatrixLike = /\b(matrix|heat\s*map|heatmap|grid|cell|cells?|row|rows|column|columns)\b/.test(q);
    const wantsTotals = /\b(row|rows|column|columns|grand)\s+totals?\b|\btotals?\b/.test(q);
    const wantsHighlight =
      /\bhighlight|color|colour|shade|conditional\s+format|conditional\s+formatting\b/.test(q);
    if (!mentionsMatrixLike && !wantsTotals && !wantsHighlight) return null;

    const thresholdMatch =
      q.match(/\b(?:above|over|greater\s+than|more\s+than|>=)\s+\$?\s*([\d,.]+)\s*([kmb])?\b/) ??
      q.match(/\$?\s*([\d,.]+)\s*([kmb])?\s*(?:and\s+)?(?:above|over|plus|\+)\b/);
    const parseThreshold = (): number | null => {
      if (!thresholdMatch?.[1]) return null;
      const base = Number(thresholdMatch[1].replace(/,/g, ''));
      if (!Number.isFinite(base)) return null;
      const suffix = thresholdMatch[2];
      const multiplier =
        suffix === 'b' ? 1_000_000_000 : suffix === 'm' ? 1_000_000 : suffix === 'k' ? 1_000 : 1;
      return base * multiplier;
    };
    const threshold = parseThreshold();

    // Dynamic "above average" threshold (no fixed number) — e.g. "highlight cells
    // above department average". Column/row/overall variants.
    const wantsAvgCompare =
      /\b(above|over|exceed(?:ing|s)?|greater\s+than|more\s+than|higher\s+than)\b/.test(
        q,
      ) && /\baverage|\bmean\b/.test(q);
    const avgMode: DisplayHints['conditionalThresholdMode'] | null = wantsAvgCompare
      ? /\brow\s+average\b/.test(q)
        ? 'rowAverage'
        : /\b(column|columns)\s+average\b/.test(q) ||
            /\b(department|dept|class|account|vendor|month|category|each)\b[^.]*\baverage\b/.test(
              q,
            )
          ? 'columnAverage'
          : 'overallAverage'
      : null;

    const hints: DisplayHints = {};
    if (wantsTotals) hints.showTotals = true;
    if (wantsHighlight || threshold !== null || avgMode) {
      hints.conditionalColor = 'green';
      if (threshold !== null) hints.conditionalThreshold = threshold;
      if (avgMode) hints.conditionalThresholdMode = avgMode;
    }
    return Object.keys(hints).length > 0 ? hints : null;
  }

  private detectEbpoMeasureMention(q: string): string | null {
    return this.detectEbpoMeasureMentions(q)[0] ?? null;
  }

  private detectEbpoMeasureMentions(q: string): string[] {
    const text = String(q ?? '').toLowerCase();
    if (!text.trim()) return [];
    const out: string[] = [];
    const add = (id: string) => {
      if (!out.includes(id)) out.push(id);
    };
    const checks: Array<[RegExp, string]> = [
      [/\byear[-\s]+over[-\s]+year\s+revenue\s+growth\b|\brevenue\s+yoy\s+growth\b|\byoy\s+revenue\s+growth\b/, 'revenue_yoy_pct'],
      [/\bgross\s+margin\s*(?:percentage|percent|%)\b|\bgross\s+margin\s+pct\b/, 'gross_margin_pct'],
      [/\bgross\s+margin\b/, 'gross_margin'],
      [/\btotal\s+revenue\b|\brevenue\b/, 'total_revenue'],
      [/\btotal\s+cost\b|\bcost\b/, 'total_cost'],
      [/\bpayroll\s*(?:to|\/)\s*revenue\b|\bpayroll\s+ratio\b/, 'payroll_to_revenue_pct'],
      [/\btotal\s+payroll\b|\bpayroll\b/, 'total_payroll'],
      [/\bbase\s+salary\b|\bbase\s+pay\b/, 'total_base_salary'],
      [/\bovertime\b|\bovertime\s+cost\b/, 'total_overtime'],
      [/\bbonus\b|\bbonuses\b/, 'total_bonus'],
      [/\bbenefits\b|\bbenefit\s+cost\b/, 'total_benefits'],
      [/\boperating\s+cash\s+flow\b|\boperating\s+cf\b/, 'operating_cf'],
      [/\binvesting\s+cash\s+flow\b|\binvesting\s+cf\b/, 'investing_cf'],
      [/\bfinancing\s+cash\s+flow\b|\bfinancing\s+cf\b/, 'financing_cf'],
      [/\bfree\s+cash\s+flow\b|\bfree\s+cf\b|\bfcf\b/, 'free_cash_flow'],
      [/\bcash\s+balance\b/, 'cash_balance'],
      [/\boutstanding\s+receivables?\b|\bar\s+outstanding\b|\breceivables?\b|\ba\/?r\b/, 'ar_outstanding'],
      [/\boutstanding\s+payables?\b|\bap\s+outstanding\b|\bpayables?\b|\ba\/?p\b/, 'ap_outstanding'],
      [/\bcollection\s+rate\b/, 'collection_rate_pct'],
      [/\bdso\b/, 'dso_days'],
      [/\bdpo\b/, 'dpo_days'],
      [/\bsla\s+compliance\b|\bsla\s*(?:percentage|percent|%)\b/, 'sla_compliance_pct'],
      [/\bcsat\b|\bcustomer\s+satisfaction\b/, 'csat_pct'],
      [/\butilization\b|\butilisation\b/, 'utilization_pct'],
      [/\bcalls?\s+handled\b/, 'calls_handled'],
      [/\btickets?\s+resolved\b/, 'tickets_resolved'],
      [/\bhandling\s+time\b|\baht\b/, 'avg_aht_minutes'],
      [/\bemployee\s+count\b|\bheadcount\b/, 'employee_count'],
      [/\baverage\s+salary\b|\bavg\s+salary\b|\bmonthly\s+salary\b/, 'avg_monthly_salary'],
      [/\brevenue\s+per\s+employee\b/, 'revenue_per_employee'],
      [/\bcost\s+per\s+employee\b/, 'cost_per_employee'],
      [/\basset\s+cost\b/, 'asset_cost'],
      [/\baccumulated\s+depreciation\b|\bdepreciation\b/, 'accumulated_depreciation'],
      [/\bnet\s+book\s+value\b|\bnbv\b/, 'net_book_value'],
      [/\basset\s+count\b/, 'asset_count'],
      [/\btotal\s+debit\b|\bdebits?\b|\bdebit\s+impact\b/, 'total_debit'],
      [/\btotal\s+credit\b|\bcredits?\b|\bcredit\s+impact\b/, 'total_credit'],
      [/\bnet\s+movement\b/, 'net_movement'],
      [/\bclosing\s+balance\b/, 'closing_balance'],
    ];
    for (const [pattern, id] of checks) if (pattern.test(text)) add(id);

    const normalize = (value: string) =>
      ` ${value
        .toLowerCase()
        .replace(/[^a-z0-9%]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()} `;
    const haystack = normalize(text);
    for (const [id, measure] of Object.entries(EBPO_MEASURES)) {
      const candidates = [measure.label, ...(measure.aliases ?? [])];
      if (candidates.some((candidate) => haystack.includes(normalize(candidate)))) add(id);
    }
    return out;
  }

  private detectEbpoScorecardMeasures(q: string): string[] {
    const text = String(q ?? '').toLowerCase();
    if (!/\b(scorecard|kpis?|kpi\s+cards?|metric\s+cards?|cards?)\b/.test(text)) return [];
    const measures = this.detectEbpoMeasureMentions(text);
    if (measures.length < 2) return [];
    return measures;
  }

  private detectEbpoAdditionalMeasures(q: string): string[] {
    const text = String(q ?? '').toLowerCase();
    const out: string[] = [];
    const add = (id: string) => {
      if (!out.includes(id)) out.push(id);
    };

    // Specific multi-measure requests first.
    if (/\binvesting\s+cash\s+flow\b|\binvesting\s+cf\b/.test(text)) add('investing_cf');
    if (/\bfinancing\s+cash\s+flow\b|\bfinancing\s+cf\b/.test(text)) add('financing_cf');
    if (/\bdebits?\b|\bdebit\s+impact\b/.test(text)) add('total_debit');
    if (/\bcredits?\b|\bcredit\s+impact\b/.test(text)) add('total_credit');
    if (/\boutstanding\s+payables?\b|\bap\s+outstanding\b|\bpayables?\b/.test(text)) add('ap_outstanding');

    for (const mid of this.detectEbpoMeasureMentions(text)) add(mid);
    return out;
  }

  private ebpoValueExprForMeasure(measureId: string, column: string): string | null {
    switch (measureId) {
      case 'gross_margin_pct':
      case 'revenue_yoy_pct':
      case 'payroll_to_revenue_pct':
      case 'collection_rate_pct':
      case 'sla_compliance_pct':
      case 'csat_pct':
      case 'utilization_pct':
      case 'dso_days':
      case 'dpo_days':
      case 'avg_aht_minutes':
      case 'avg_monthly_salary':
      case 'revenue_per_employee':
      case 'cost_per_employee':
        return `round(avg(${column}), 2)`;
      case 'cash_balance':
        return `round(max(${column}), 2)`;
      default:
        return `round(sum(${column}), 2)`;
    }
  }

  private async compileEbpoMultiMeasureSql(
    spec: ChartSpec,
    extraMeasureIds: string[],
    scope: OrgScope,
  ): Promise<{ sql: string; type: ChartType; display?: DisplayHints; yAxisLabel?: string } | null> {
    const baseMeasure = spec.measure;
    const dim = spec.dimension || null;
    if (!baseMeasure || !dim) return null;
    const measureIds = [baseMeasure, ...extraMeasureIds].filter(
      (id, idx, arr) => !!id && arr.indexOf(id) === idx,
    );
    if (measureIds.length < 2) return null;

    const compiled = await compileEbpoSpec(spec, this.analyticsDb, (sql) =>
      this.queryRows<Record<string, unknown>>(sql, {
        tenantId: scope.tenantId,
        externalOrgIds: scope.externalOrgIds,
      }),
    );
    if (!compiled.ok) return null;

    const view = compiled.view;
    const dimDef = EBPO_DIMENSIONS[dim];
    if (!dimDef) return null;
    const supportsDim = (v: (typeof EBPO_VIEWS)[number]) =>
      dimDef.isTime ? v.hasTime : v.dims.includes(dim);
    const provider =
      EBPO_VIEWS.find(
        (v) => supportsDim(v) && measureIds.every((id) => id in v.measures),
      ) ?? EBPO_VIEWS.find((v) => v.name === view);
    if (!provider) return null;
    if (!measureIds.every((id) => id in provider.measures)) return null;

    const isTime = !!dimDef.isTime;
    const dimGroup =
      dim === 'quarter'
        ? `toStartOfQuarter(period_date)`
        : dim === 'year'
          ? `toStartOfYear(period_date)`
          : isTime
            ? `toStartOfMonth(period_date)`
            : `COALESCE(NULLIF(${dimDef.column}, ''), 'Unassigned')`;
    const dimLabel =
      dim === 'quarter'
        ? `concat('Q', toString(toQuarter(${dimGroup})), ' ', toString(toYear(${dimGroup})))`
        : dim === 'year'
          ? `toString(toYear(${dimGroup}))`
          : isTime
            ? `formatDateTime(${dimGroup}, '%b %Y')`
            : dimGroup;
    const where = [
      'tenant_id = {tenantId:String}',
      'org_id IN ({externalOrgIds:Array(String)})',
      !isTime && dimDef.column ? `${dimDef.column} != ''` : '',
    ]
      .filter(Boolean)
      .join(' AND ');
    const quoteIdent = (v: string) => `"${String(v).replace(/"/g, '""')}"`;
    const projections = measureIds
      .map((id) => {
        const col = provider.measures[id];
        const expr = col ? this.ebpoValueExprForMeasure(id, col) : null;
        return expr ? `${expr} AS ${quoteIdent(id)}` : null;
      })
      .filter(Boolean);
    if (projections.length !== measureIds.length) return null;

    const sql = `
      SELECT ${dimLabel} AS name, ${projections.join(', ')}
      FROM ${this.analyticsDb}.${provider.name}
      WHERE ${where}
      GROUP BY ${dimGroup}
      ORDER BY ${isTime ? `${dimGroup} ASC` : `"${baseMeasure}" DESC`}
      LIMIT ${isTime ? 100 : 50}
    `;
    const type: ChartType =
      spec.chartType === 'heatmap' || spec.chartType === 'matrix'
        ? 'heatmap'
        : 'combo';
    const check = await this.executeDynamicSqlChecked(sql, scope, { chartType: type }).catch(
      () => null,
    );
    if (!check || check.error || check.rows.length === 0) return null;
    if (this.detectBadChartShape(check.rows, type)) return null;
    return {
      sql: sql.trim(),
      type,
      display: measureIds.some((id) => /pct|ratio|rate|margin/.test(id))
        ? { secondaryAxisFormat: 'percent' }
        : undefined,
    };
  }

  private dataYearCountCache = new Map<string, { count: number; at: number }>();
  private async dataYearCount(scope: OrgScope): Promise<number> {
    const key = this.scopeKey(scope);
    const hit = this.dataYearCountCache.get(key);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.count;
    try {
      const rows = await this.queryRows<{ y: number }>(
        `SELECT uniqExact(toYear(date)) AS y FROM ${this.analyticsDb}.sample_gl_dump WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)}) LIMIT 1`,
        { tenantId: scope.tenantId, externalOrgIds: scope.externalOrgIds },
      );
      const count = Number(rows[0]?.y ?? 1) || 1;
      this.dataYearCountCache.set(key, { count, at: Date.now() });
      return count;
    } catch {
      return 1;
    }
  }

  private buildTransformSql(
    transform: FollowUpTransform,
    baseSql: string,
    numeric: string[],
  ): { sql: string; display?: DisplayHints; yAxisLabel?: string; type?: ChartType } | null {
    const id = (c: string) => '`' + c.replace(/`/g, '') + '`';
    const wrap = (proj: string) =>
      `WITH _base AS (\n${baseSql.replace(/;+\s*$/, '')}\n)\nSELECT ${proj}\nFROM _base\nLIMIT 1000`;

    if (transform.kind === 'second_axis') {
      const s = transform.second;
      if (s.measure === 'invoices' || !s.expr) return null; // unavailable → refused upstream
      // Single-series base only (name + value): plot the original as bars and the
      // second measure as a line on a secondary axis (a combo chart).
      if (!numeric.includes('value')) return null;
      const table = baseSql.match(/\bfrom\s+(`?\w+`?\.`?\w+`?)/i)?.[1];
      const nameExpr = baseSql.match(/select\s+([\s\S]*?)\s+as\s+name\b/i)?.[1]?.trim();
      const whereInner = baseSql
        .match(/\bwhere\b([\s\S]*?)(\bgroup\s+by\b|\border\s+by\b|\blimit\b|$)/i)?.[1]
        ?.trim();
      if (!table || !/sample_gl_dump/i.test(table) || !nameExpr || !whereInner) return null;
      const proj = [
        '_base.name AS name',
        '_base.value AS value',
        `_extra.${id(s.alias)} AS ${id(s.alias)}`,
      ].join(', ');
      const sql =
        `WITH _base AS (\n${baseSql.replace(/;+\s*$/, '')}\n),\n` +
        `_extra AS (\n  SELECT ${nameExpr} AS name, ${s.expr} AS ${id(s.alias)}\n` +
        `  FROM ${table}\n  WHERE ${whereInner}\n  GROUP BY ${nameExpr}\n)\n` +
        `SELECT ${proj}\nFROM _base LEFT JOIN _extra ON _base.name = _extra.name\nLIMIT 1000`;
      return {
        sql,
        type: 'combo',
        display: { secondaryAxisFormat: s.format, secondaryLabel: s.label },
      };
    }

    if (transform.kind === 'normalize') {
      if (numeric.length >= 2) {
        const total = numeric.map(id).join(' + ');
        const proj = [
          'name',
          ...numeric.map((c) => `round(${id(c)} / nullIf(${total}, 0) * 100, 1) AS ${id(c)}`),
        ].join(', ');
        return { sql: wrap(proj), display: { normalized: true }, yAxisLabel: '% of total' };
      }
      const v = id(numeric[0]!);
      const proj = `name, round(${v} / nullIf(sum(${v}) OVER (), 0) * 100, 1) AS ${v}`;
      return {
        sql: wrap(proj),
        display: { normalized: true, labelMode: 'percent' },
        yAxisLabel: '% of total',
      };
    }

    if (transform.kind === 'reference_line') {
      // Company-wide average = mean of each row's TOTAL across all series (matches
      // Power BI's "average of monthly total spend"). For a single-series chart the
      // row total IS the value, so this reduces to avg(value). Averaging just one
      // series (e.g. Admin) would be wrong — that was the "different in Power BI" bug.
      const rowTotal =
        numeric.length >= 2 ? `(${numeric.map(id).join(' + ')})` : id(numeric[0]!);
      const proj = [
        'name',
        ...numeric.map(id),
        `round((SELECT avg(${rowTotal}) FROM _base), 2) AS company_average`,
      ].join(', ');
      return { sql: wrap(proj), display: { referenceSeries: 'company_average' } };
    }

    if (transform.kind === 'moving_average') {
      const n = transform.window ?? 3;
      const suffix = `_MA${n}`;
      const ma = numeric.map(
        (c) =>
          `round(avg(${id(c)}) OVER (ROWS BETWEEN ${n - 1} PRECEDING AND CURRENT ROW), 2) AS ${id(c + suffix)}`,
      );
      const proj = ['name', ...numeric.map(id), ...ma].join(', ');
      return { sql: wrap(proj), display: { movingAverageSuffix: suffix } };
    }

    if (transform.kind === 'variance') {
      // Period-over-period $ change. Single-series only; caller guarantees the
      // base is time-ordered (else it refuses). anyOrNull over the 1-preceding
      // frame is the previous period's value (first row → NULL, no prior period).
      if (!numeric.includes('value')) return null;
      const proj =
        'name, value, ' +
        'round(value - anyOrNull(value) OVER (ROWS BETWEEN 1 PRECEDING AND 1 PRECEDING), 2) AS variance';
      return { sql: wrap(proj) };
    }

    if (transform.kind === 'growth_pct') {
      // REPLACE each value with its period-over-period % change vs the prior row.
      // Caller guarantees the base is time-ordered (else it refuses). Works for a
      // single-series chart (value) and for WIDE pivots (one growth column per
      // series, e.g. a Month×Department matrix → each department's MoM growth %).
      const pct = (c: string) => {
        const cur = id(c);
        const prev = `anyOrNull(${cur}) OVER (ROWS BETWEEN 1 PRECEDING AND 1 PRECEDING)`;
        return `round((${cur} - ${prev}) / nullIf(${prev}, 0) * 100, 1) AS ${cur}`;
      };
      const proj = ['name', ...numeric.map(pct)].join(', ');
      return {
        sql: wrap(proj),
        display: { normalized: true, ...(numeric.length === 1 ? { labelMode: 'percent' } : {}) },
        yAxisLabel: '% change vs prior period',
      };
    }
    return null;
  }

  private async buildDeterministicTransformEdit(
    activeDashboard: ActiveDashboard,
    transform: FollowUpTransform,
    scope: OrgScope,
  ): Promise<DashboardEditPlan | null> {
    // Impossible from the data → refuse clearly instead of silently keeping the chart.
    if (transform.kind === 'yoy' || transform.kind === 'prior_year') {
      const years = await this.dataYearCount(scope);
      if (years < 2) {
        const label = transform.kind === 'yoy' ? 'year-over-year growth' : 'a prior-year comparison';
        return {
          summary: '',
          add: [],
          remove_indices: [],
          modify: [],
          refusal: `I can't add ${label} — this dataset only covers a single year (2024), so there's no earlier period to compare against. I left the chart unchanged.`,
        };
      }
      return null; // multi-year data exists → let the SQL editor handle it
    }
    // The dataset has no invoice-level records, so an invoice count can't be added.
    if (transform.kind === 'second_axis' && transform.second.measure === 'invoices') {
      return {
        summary: '',
        add: [],
        remove_indices: [],
        modify: [],
        refusal: `I can't add an invoice count — this dataset holds GL transactions, not invoice-level records, so there's no invoice data to plot. I left the chart unchanged.`,
      };
    }

    // A period-over-period variance needs a time-ordered base. A trial-balance /
    // single-snapshot matrix has no prior period, so we refuse rather than diff
    // unrelated rows.
    const baseIsTimeSeries = (s: string) =>
      !/sample_trial_balance/i.test(s) &&
      /toStartOf(?:Month|Quarter|Year)|formatDateTime|journal_date|\bdate\b/i.test(s);
    // variance ($ change) and growth_pct (% change) both need a time-ordered base.
    const needsPeriod =
      transform.kind === 'variance' || transform.kind === 'growth_pct';
    let noPriorPeriod = false;

    const modify: DashboardEditPlan['modify'] = [];
    for (let i = 0; i < activeDashboard.widgets.length; i++) {
      const w = activeDashboard.widgets[i]!;
      const cfg = (w.queryConfig as any) ?? {};
      const sql =
        typeof cfg.dynamicSql === 'string' && cfg.dynamicSql.trim() ? cfg.dynamicSql.trim() : null;
      if (!sql) continue;
      const chartType = w.chartType as ChartType;
      if (needsPeriod && !baseIsTimeSeries(sql)) {
        noPriorPeriod = true;
        continue;
      }
      const probe = await this.executeDynamicSqlChecked(sql, scope, { chartType }).catch(
        () => null,
      );
      if (!probe || probe.error || probe.rows.length === 0) continue;
      const cols = Object.keys(probe.rows[0] ?? {});
      if (!cols.includes('name')) continue;
      const numeric = cols.filter(
        (c) =>
          c !== 'name' &&
          probe.rows.some((r) => {
            const v = (r as any)[c];
            return v !== null && v !== '' && Number.isFinite(Number(v));
          }),
      );
      if (numeric.length === 0) continue;

      const built = this.buildTransformSql(transform, sql, numeric);
      if (!built) continue;
      const verifyType = built.type ?? chartType;
      const check = await this.executeDynamicSqlChecked(built.sql, scope, {
        chartType: verifyType,
      }).catch(() => null);
      if (!check || check.error || check.rows.length === 0) continue;
      if (this.detectBadChartShape(check.rows, verifyType)) continue;

      modify.push({
        index: i,
        dynamicSql: built.sql,
        ...(built.type ? { type: built.type } : {}),
        ...(built.display ? { display: built.display } : {}),
        ...(built.yAxisLabel ? { yAxisLabel: built.yAxisLabel } : {}),
      });
    }
    if (modify.length === 0) {
      if (needsPeriod && noPriorPeriod) {
        const what =
          transform.kind === 'growth_pct'
            ? 'period-over-period growth %'
            : 'a prior-period variance column';
        return {
          summary: '',
          add: [],
          remove_indices: [],
          modify: [],
          refusal: `I can't add ${what} — this is a single-period snapshot (balances have no time dimension), so there's no previous period to compare against. I left the chart unchanged.`,
        };
      }
      return null;
    }
    const summaryByKind: Record<string, string> = {
      normalize: 'Normalized the chart to 100% (share of total).',
      reference_line: 'Added a company-wide average reference line.',
      moving_average: `Added a ${transform.kind === 'moving_average' ? transform.window : 3}-period moving average.`,
      second_axis:
        transform.kind === 'second_axis'
          ? `Added ${transform.second.label} on a secondary axis.`
          : 'Added a secondary axis.',
      variance: 'Added a period-over-period variance column.',
      growth_pct: 'Replaced values with period-over-period growth %.',
    };
    return {
      summary: summaryByKind[transform.kind] ?? 'Applied the requested transform.',
      add: [],
      remove_indices: [],
      modify,
    };
  }

  private async buildEbpoMetricEdit(
    activeDashboard: ActiveDashboard,
    editRequest: string,
    scope: OrgScope,
  ): Promise<DashboardEditPlan | null> {
    const q = String(editRequest ?? '').toLowerCase();
    if (!q.trim()) return null;

    const verify = async (sql: string, type: ChartType) => {
      const check = await this.executeDynamicSqlChecked(sql, scope, { chartType: type }).catch(
        () => null,
      );
      if (!check || check.error || check.rows.length === 0) return false;
      return !this.detectBadChartShape(check.rows, type);
    };

    for (let i = 0; i < activeDashboard.widgets.length; i++) {
      const w = activeDashboard.widgets[i]!;
      const cfg = (w.queryConfig as any) ?? {};
      const spec = cfg.spec as ChartSpec | undefined;

      if (
        spec?.measure === 'total_revenue' &&
        spec.dimension === 'month' &&
        spec.breakdown &&
        /\btotal\s+revenue\b/.test(q) &&
        /\blabels?\b/.test(q)
      ) {
        const compiled = await compileEbpoSpec(spec, this.analyticsDb, (sql) =>
          this.queryRows<Record<string, unknown>>(sql, {
            tenantId: scope.tenantId,
            externalOrgIds: scope.externalOrgIds,
          }),
        );
        if (compiled.ok) {
          const sql = `
            WITH _base AS (
              ${compiled.sql}
            ),
            _totals AS (
              SELECT
                formatDateTime(toStartOfMonth(period_date), '%b %Y') AS name,
                round(sum(total_revenue_usd), 2) AS total_revenue
              FROM ${this.analyticsDb}.v_ebpo_revenue_monthly
              WHERE tenant_id = {tenantId:String}
                AND org_id IN ({externalOrgIds:Array(String)})
              GROUP BY toStartOfMonth(period_date)
            )
            SELECT _base.*, _totals.total_revenue AS total_revenue_label
            FROM _base
            LEFT JOIN _totals ON _totals.name = _base.name
            LIMIT 1000
          `;
          if (await verify(sql, w.chartType as ChartType)) {
            return {
              summary: 'Added total revenue labels to each month.',
              add: [],
              remove_indices: [],
              modify: [
                {
                  index: i,
                  dynamicSql: sql.trim(),
                  display: { labelMode: 'value' },
                },
              ],
            };
          }
        }
      }

      if (spec && /\bmedian\b/.test(q)) {
        const compiled = await compileEbpoSpec(spec, this.analyticsDb, (sql) =>
          this.queryRows<Record<string, unknown>>(sql, {
            tenantId: scope.tenantId,
            externalOrgIds: scope.externalOrgIds,
          }),
        );
        if (compiled.ok) {
          const sql = `
            WITH
              _base AS (
                ${compiled.sql}
              ),
              _median AS (
                SELECT round(quantileExact(0.5)(value), 2) AS median_value
                FROM _base
              )
            SELECT
              _base.name AS name,
              _base.value AS value,
              _median.median_value AS median_value
            FROM _base
            CROSS JOIN _median
            LIMIT 1000
          `;
          if (await verify(sql, 'combo')) {
            return {
              summary: 'Added a median comparison line.',
              add: [],
              remove_indices: [],
              modify: [
                {
                  index: i,
                  type: 'combo',
                  dynamicSql: sql.trim(),
                  display: { referenceSeries: 'median_value' },
                },
              ],
            };
          }
        }
      }

      if (spec && /\bcumulative\b/.test(q) && /\bpercent|percentage|%\b/.test(q)) {
        const compiled = await compileEbpoSpec(spec, this.analyticsDb, (sql) =>
          this.queryRows<Record<string, unknown>>(sql, {
            tenantId: scope.tenantId,
            externalOrgIds: scope.externalOrgIds,
          }),
        );
        if (compiled.ok) {
          const sql = `
            WITH _base AS (
              ${compiled.sql}
            )
            SELECT
              name,
              value,
              round(sum(value) OVER (ORDER BY value DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) / nullIf(sum(value) OVER (), 0) * 100, 2) AS cumulative_pct
            FROM _base
            ORDER BY value DESC
            LIMIT 1000
          `;
          if (await verify(sql, 'combo')) {
            return {
              summary: 'Added a cumulative percentage line.',
              add: [],
              remove_indices: [],
              modify: [
                {
                  index: i,
                  type: 'combo',
                  dynamicSql: sql.trim(),
                  yAxisLabel: '% cumulative',
                  display: { secondaryAxisFormat: 'percent', secondaryLabel: 'Cumulative %' },
                },
              ],
            };
          }
        }
      }

      if (spec && /\bhighlight\b/.test(q)) {
        const isHeatmapLike =
          String(w.chartType ?? '').toLowerCase() === 'heatmap' ||
          String(w.chartType ?? '').toLowerCase() === 'matrix';
        if (isHeatmapLike) {
          const hints: DisplayHints = { showTotals: true, conditionalColor: 'green' };
          if (/\bhighest|largest|max\b/.test(q)) hints.conditionalThresholdMode = 'overallAverage';
          if (/\blowest|smallest|min\b/.test(q)) hints.conditionalColor = 'green';
          const compiled = await compileEbpoSpec(spec, this.analyticsDb, (sql) =>
            this.queryRows<Record<string, unknown>>(sql, {
              tenantId: scope.tenantId,
              externalOrgIds: scope.externalOrgIds,
            }),
          );
          const dynamicSql =
            compiled.ok
              ? compiled.sql
              : typeof cfg.dynamicSql === 'string'
                ? cfg.dynamicSql.trim()
                : '';
          return {
            summary: 'Applied heatmap highlighting to the existing verified data.',
            add: [],
            remove_indices: [],
            modify: [
              {
                index: i,
                ...(dynamicSql ? { dynamicSql } : {}),
                display: hints,
              },
            ],
          };
        }
      }

      const extraMeasures = spec
        ? this.detectEbpoAdditionalMeasures(q).filter((id) => id !== spec.measure)
        : [];
      const needsDerivedEbpoFormula =
        (spec?.measure === 'free_cash_flow' &&
          spec.dimension === 'month' &&
          /\bgross\s+margin\s*(?:percentage|percent|%)\b|\bgross\s+margin\s+pct\b/.test(q)) ||
        (spec?.measure === 'operating_cf' &&
          spec.dimension === 'month' &&
          /\bfree\s+cash\s+flow\s+margin\b/.test(q)) ||
        (spec?.measure === 'cash_balance' &&
          spec.dimension === 'month' &&
          /\boutstanding\s+payables?\b|\bap\s+outstanding\b|\bpayables?\b/.test(q)) ||
        (spec?.measure === 'asset_cost' &&
          spec.dimension === 'asset_type' &&
          /\bnet\s+book\s+value\b/.test(q) &&
          /\bpercent|percentage|%\b/.test(q));
      if (spec && extraMeasures.length > 0 && !needsDerivedEbpoFormula) {
        const built = await this.compileEbpoMultiMeasureSql(
          spec,
          extraMeasures,
          scope,
        ).catch(() => null);
        if (built) {
          return {
            summary: 'Added the requested EBPO comparison measure.',
            add: [],
            remove_indices: [],
            modify: [
              {
                index: i,
                type: built.type,
                dynamicSql: built.sql,
                ...(built.display ? { display: built.display } : {}),
                ...(built.yAxisLabel ? { yAxisLabel: built.yAxisLabel } : {}),
              },
            ],
          };
        }
      }

      if (
        !spec &&
        /\bcalls?\s+handled\b/.test(String(w.title ?? '').toLowerCase()) &&
        /\bcsat\b/.test(String(w.title ?? '').toLowerCase()) &&
        /\bsla\s+compliance\b|\bsla\s*(?:percentage|percent|%)\b/.test(q)
      ) {
        const sql = `
          SELECT
            formatDateTime(period_date, '%b %Y') AS name,
            round(sum(calls_handled), 2) AS calls_handled,
            round(avg(csat_pct), 2) AS csat_pct,
            round(avg(sla_compliance_pct), 2) AS sla_compliance_pct
          FROM ${this.analyticsDb}.v_ebpo_operations_monthly
          WHERE tenant_id = {tenantId:String}
            AND org_id IN ({externalOrgIds:Array(String)})
          GROUP BY period_date
          ORDER BY period_date ASC
          LIMIT 100
        `;
        if (await verify(sql, 'combo')) {
          return {
            summary: 'Added SLA compliance percentage as another line.',
            add: [],
            remove_indices: [],
            modify: [
              {
                index: i,
                type: 'combo',
                dynamicSql: sql.trim(),
                display: { secondaryAxisFormat: 'percent' },
              },
            ],
          };
        }
      }

      if (
        !spec &&
        /\bpayable|payables|invoice|outstanding\b/.test(String(w.title ?? '').toLowerCase()) &&
        /\bpayment\s+rate\b|\bpaid\s+rate\b/.test(q)
      ) {
        const byMonth =
          /\bmonthly\b|\bmonth\b/.test(String(w.title ?? '').toLowerCase()) ||
          /\bmonthly\b|\bmonth\b/.test(q);
        const sql = byMonth
          ? `
            SELECT
              formatDateTime(toStartOfMonth(period_date), '%b %Y') AS name,
              round(sum(invoice_amount_usd), 2) AS invoice_amount,
              round(sum(paid_amount_usd), 2) AS paid_amount,
              round(sum(outstanding_balance_usd), 2) AS outstanding_payables,
              round(sum(paid_amount_usd) / nullIf(sum(invoice_amount_usd), 0) * 100, 2) AS payment_rate_pct
            FROM ${this.analyticsDb}.v_ebpo_ap_aging
            WHERE tenant_id = {tenantId:String}
              AND org_id IN ({externalOrgIds:Array(String)})
            GROUP BY toStartOfMonth(period_date)
            ORDER BY toStartOfMonth(period_date) ASC
            LIMIT 100
          `
          : `
            SELECT
              vendor_name AS name,
              round(sum(invoice_amount_usd), 2) AS invoice_amount,
              round(sum(paid_amount_usd), 2) AS paid_amount,
              round(sum(outstanding_balance_usd), 2) AS outstanding_payables,
              round(sum(paid_amount_usd) / nullIf(sum(invoice_amount_usd), 0) * 100, 2) AS payment_rate_pct
            FROM ${this.analyticsDb}.v_ebpo_ap_aging
            WHERE tenant_id = {tenantId:String}
              AND org_id IN ({externalOrgIds:Array(String)})
              AND vendor_name != ''
            GROUP BY vendor_name
            ORDER BY outstanding_payables DESC
            LIMIT 50
          `;
        if (await verify(sql, 'combo')) {
          return {
            summary: 'Added payment rate as a comparison line.',
            add: [],
            remove_indices: [],
            modify: [
              {
                index: i,
                type: 'combo',
                dynamicSql: sql.trim(),
                display: { secondaryAxisFormat: 'percent', secondaryLabel: 'Payment rate' },
              },
            ],
          };
        }
      }

      if (
        !spec &&
        /\bworking\s+capital\b/.test(String(w.title ?? '').toLowerCase()) &&
        /\brevenue\b/.test(q)
      ) {
        const sql = `
          SELECT
            formatDateTime(period_date, '%b %Y') AS name,
            round(cash_balance_usd + ar_outstanding_usd - ap_outstanding_usd, 2) AS working_capital,
            round(total_revenue_usd, 2) AS revenue
          FROM ${this.analyticsDb}.v_ebpo_kpi_monthly
          WHERE tenant_id = {tenantId:String}
            AND org_id IN ({externalOrgIds:Array(String)})
          ORDER BY period_date ASC
          LIMIT 100
        `;
        if (await verify(sql, 'combo')) {
          return {
            summary: 'Added revenue as a comparison line.',
            add: [],
            remove_indices: [],
            modify: [{ index: i, type: 'combo', dynamicSql: sql.trim() }],
          };
        }
      }

      if (
        !spec &&
        /\bpayroll\s+as\s+a\s+percentage\s+of\s+revenue\b|\bpayroll\s+to\s+revenue\b/.test(q) &&
        /\bbusiness\s+unit\b/.test(String(w.title ?? '').toLowerCase())
      ) {
        const sql = `
          SELECT
            business_unit_rollup.business_unit AS name,
            round(business_unit_rollup.total_revenue_usd, 2) AS revenue,
            round(
              any(payroll_rollup.total_payroll_usd)
              * business_unit_rollup.total_revenue_usd
              / nullIf(any(revenue_rollup.total_revenue_usd), 0),
              2
            ) AS payroll,
            round(
              any(payroll_rollup.total_payroll_usd)
              * business_unit_rollup.total_revenue_usd
              / nullIf(any(revenue_rollup.total_revenue_usd), 0)
              / nullIf(business_unit_rollup.total_revenue_usd, 0) * 100,
              2
            ) AS payroll_to_revenue_pct,
            round(business_unit_rollup.gross_margin_usd, 2) AS gross_margin
          FROM (
            SELECT
              tenant_id,
              org_id,
              business_unit,
              sum(total_revenue_usd) AS total_revenue_usd,
              sum(gross_margin_usd) AS gross_margin_usd
            FROM ${this.analyticsDb}.v_ebpo_revenue_by_business_unit
            WHERE tenant_id = {tenantId:String}
              AND org_id IN ({externalOrgIds:Array(String)})
            GROUP BY tenant_id, org_id, business_unit
          ) business_unit_rollup
          LEFT JOIN (
            SELECT
              tenant_id,
              org_id,
              sum(total_payroll_usd) AS total_payroll_usd
            FROM ${this.analyticsDb}.v_ebpo_payroll_monthly
            WHERE tenant_id = {tenantId:String}
              AND org_id IN ({externalOrgIds:Array(String)})
            GROUP BY tenant_id, org_id
          ) payroll_rollup
            ON payroll_rollup.tenant_id = business_unit_rollup.tenant_id
            AND payroll_rollup.org_id = business_unit_rollup.org_id
          LEFT JOIN (
            SELECT
              tenant_id,
              org_id,
              sum(total_revenue_usd) AS total_revenue_usd
            FROM ${this.analyticsDb}.v_ebpo_revenue_by_business_unit
            WHERE tenant_id = {tenantId:String}
              AND org_id IN ({externalOrgIds:Array(String)})
            GROUP BY tenant_id, org_id
          ) revenue_rollup
            ON revenue_rollup.tenant_id = business_unit_rollup.tenant_id
            AND revenue_rollup.org_id = business_unit_rollup.org_id
          GROUP BY business_unit_rollup.business_unit, business_unit_rollup.total_revenue_usd, business_unit_rollup.gross_margin_usd
          ORDER BY revenue DESC
          LIMIT 100
        `;
        if (await verify(sql, 'combo')) {
          return {
            summary: 'Added payroll as a percentage of revenue.',
            add: [],
            remove_indices: [],
            modify: [
              {
                index: i,
                type: 'combo',
                dynamicSql: sql.trim(),
                display: { secondaryAxisFormat: 'percent', secondaryLabel: 'Payroll / revenue' },
              },
            ],
          };
        }
      }

      if (
        !spec &&
        /\bpayroll\s+cost\b/.test(q) &&
        /\bbubble\b|\bsize\b/.test(q) &&
        /\bdelivery\s+center\b/.test(String(w.title ?? '').toLowerCase())
      ) {
        const sql = `
          WITH payroll_by_country AS (
            SELECT
              formatDateTime(period_date, '%Y-%m') AS ym,
              country,
              sum(total_payroll_usd) AS total_payroll_usd
            FROM ${this.analyticsDb}.v_ebpo_payroll_monthly
            WHERE tenant_id = {tenantId:String}
              AND org_id IN ({externalOrgIds:Array(String)})
            GROUP BY ym, country
          ),
          center_base AS (
            SELECT
              formatDateTime(period_date, '%Y-%m') AS ym,
              delivery_center,
              country,
              avg(utilization_pct) AS utilization_pct,
              avg(revenue_per_employee_usd) AS revenue_per_employee_usd,
              sum(employee_count) AS employee_count
            FROM ${this.analyticsDb}.v_ebpo_delivery_center_efficiency_monthly
            WHERE tenant_id = {tenantId:String}
              AND org_id IN ({externalOrgIds:Array(String)})
            GROUP BY ym, delivery_center, country
          ),
          country_totals AS (
            SELECT
              ym,
              country,
              sum(employee_count) AS country_employee_count
            FROM center_base
            GROUP BY ym, country
          )
          SELECT
            c.delivery_center AS name,
            round(avg(c.utilization_pct), 2) AS x,
            round(avg(c.revenue_per_employee_usd), 2) AS y,
            round(avg(p.total_payroll_usd * c.employee_count / nullIf(t.country_employee_count, 0)), 2) AS z
          FROM center_base c
          LEFT JOIN country_totals t
            ON t.ym = c.ym
            AND t.country = c.country
          LEFT JOIN payroll_by_country p
            ON p.ym = c.ym
            AND p.country = c.country
          GROUP BY c.delivery_center
          ORDER BY y DESC
          LIMIT 100
        `;
        if (await verify(sql, 'bubble')) {
          return {
            summary: 'Added payroll cost as bubble size using a country payroll allocation by employee share.',
            add: [],
            remove_indices: [],
            modify: [
              {
                index: i,
                type: 'bubble',
                dynamicSql: sql.trim(),
              },
            ],
          };
        }
      }

      if (
        !spec &&
        /\bnet\s+movement\b/.test(String(w.title ?? '').toLowerCase()) &&
        /\bdebits?\b|\bcredits?\b|\bdebit\s+impact\b|\bcredit\s+impact\b/.test(q)
      ) {
        const sql = `
          SELECT
            account_name AS name,
            round(sum(net_movement_usd), 2) AS net_movement,
            round(sum(total_debit_usd), 2) AS total_debit,
            round(sum(total_credit_usd), 2) AS total_credit
          FROM ${this.analyticsDb}.v_ebpo_gl_monthly
          WHERE tenant_id = {tenantId:String}
            AND org_id IN ({externalOrgIds:Array(String)})
            AND account_name != ''
          GROUP BY account_name
          ORDER BY abs(net_movement) DESC
          LIMIT 50
        `;
        if (await verify(sql, 'waterfall')) {
          return {
            summary: 'Added debit and credit impact labels from verified GL movement columns.',
            add: [],
            remove_indices: [],
            modify: [
              {
                index: i,
                type: 'waterfall',
                dynamicSql: sql.trim(),
                display: { labelMode: 'value' },
              },
            ],
          };
        }
      }

      if (
        !spec &&
        /\b(opening|closing)\s+balance\b/.test(String(w.title ?? '').toLowerCase()) &&
        /\blargest\b|\bhighest\b|\bbiggest\b/.test(q) &&
        /\bbalance\s+movement\b|\bmovement\b/.test(q)
      ) {
        const sql = `
          SELECT
            account_name AS name,
            round(sum(abs(net_movement_usd)), 2) AS value,
            round(sum(closing_balance_usd), 2) AS closing_balance
          FROM ${this.analyticsDb}.v_ebpo_trial_balance_monthly
          WHERE tenant_id = {tenantId:String}
            AND org_id IN ({externalOrgIds:Array(String)})
            AND account_name != ''
          GROUP BY account_name
          ORDER BY value DESC
          LIMIT 25
        `;
        if (await verify(sql, 'bar')) {
          return {
            summary: 'Highlighted accounts with the largest balance movement.',
            add: [],
            remove_indices: [],
            modify: [
              {
                index: i,
                type: 'bar',
                dynamicSql: sql.trim(),
                display: { conditionalColor: 'green' },
              },
            ],
          };
        }
      }

      if (
        spec?.measure === 'employee_count' &&
        /\baverage\s+salary\b|\bavg\s+salary\b/.test(q)
      ) {
        const dim = spec.dimension === 'country' ? 'country' : spec.dimension === 'department' ? 'department' : null;
        if (dim) {
          const sql = `
            SELECT
              ${dim} AS name,
              round(sum(employee_count), 0) AS employee_count,
              round(avg(avg_monthly_salary_usd), 2) AS avg_monthly_salary
            FROM ${this.analyticsDb}.v_ebpo_employee_headcount
            WHERE tenant_id = {tenantId:String}
              AND org_id IN ({externalOrgIds:Array(String)})
              AND ${dim} != ''
            GROUP BY ${dim}
            ORDER BY employee_count DESC
            LIMIT 50
          `;
          if (await verify(sql, 'combo')) {
            return {
              summary: 'Added average salary labels from the employee headcount view.',
              add: [],
              remove_indices: [],
              modify: [
                {
                  index: i,
                  type: 'combo',
                  dynamicSql: sql.trim(),
                  display: { secondaryAxisFormat: 'currency', secondaryLabel: 'Average salary' },
                },
              ],
            };
          }
        }
      }

      if (
        spec?.measure === 'free_cash_flow' &&
        spec.dimension === 'month' &&
        /\bgross\s+margin\s*(?:percentage|percent|%)\b|\bgross\s+margin\s+pct\b/.test(q)
      ) {
        const sql = `
          SELECT
            formatDateTime(period_date, '%b %Y') AS name,
            round(free_cash_flow_usd / nullIf(total_revenue_usd, 0) * 100, 2) AS free_cash_flow_margin_pct,
            round(gross_margin_pct, 2) AS gross_margin_pct
          FROM ${this.analyticsDb}.v_ebpo_kpi_monthly
          WHERE tenant_id = {tenantId:String}
            AND org_id IN ({externalOrgIds:Array(String)})
          ORDER BY period_date ASC
          LIMIT 100
        `;
        if (await verify(sql, 'combo')) {
          return {
            summary: 'Added gross margin percentage as a comparison line.',
            add: [],
            remove_indices: [],
            modify: [{ index: i, type: 'combo', dynamicSql: sql.trim(), yAxisLabel: '%' }],
          };
        }
      }

      if (
        spec?.measure === 'cash_balance' &&
        spec.dimension === 'month' &&
        /\boutstanding\s+payables?\b|\bap\s+outstanding\b|\bpayables?\b/.test(q)
      ) {
        const sql = `
          SELECT
            formatDateTime(period_date, '%b %Y') AS name,
            round(max(cash_balance_usd), 2) AS cash_balance,
            round(max(ar_outstanding_usd), 2) AS ar_outstanding,
            round(max(ap_outstanding_usd), 2) AS ap_outstanding
          FROM ${this.analyticsDb}.v_ebpo_kpi_monthly
          WHERE tenant_id = {tenantId:String}
            AND org_id IN ({externalOrgIds:Array(String)})
          GROUP BY period_date
          ORDER BY period_date ASC
          LIMIT 100
        `;
        if (await verify(sql, 'combo')) {
          return {
            summary: 'Added outstanding payables as another line.',
            add: [],
            remove_indices: [],
            modify: [{ index: i, type: 'combo', dynamicSql: sql.trim() }],
          };
        }
      }

      if (
        spec?.measure === 'asset_cost' &&
        spec.dimension === 'asset_type' &&
        /\bnet\s+book\s+value\b/.test(q) &&
        /\bpercent|percentage|%\b/.test(q)
      ) {
        const sql = `
          SELECT
            asset_type AS name,
            round(sum(asset_cost_usd), 2) AS asset_cost,
            round(sum(accumulated_depreciation_usd), 2) AS accumulated_depreciation,
            round(sum(net_book_value_usd), 2) AS net_book_value,
            round(sum(net_book_value_usd) / nullIf(sum(asset_cost_usd), 0) * 100, 2) AS net_book_value_pct
          FROM ${this.analyticsDb}.v_ebpo_fixed_assets_by_center
          WHERE tenant_id = {tenantId:String}
            AND org_id IN ({externalOrgIds:Array(String)})
            AND asset_type != ''
          GROUP BY asset_type
          ORDER BY asset_cost DESC
          LIMIT 50
        `;
        if (await verify(sql, 'combo')) {
          return {
            summary: 'Added net book value percentage of asset cost as a line.',
            add: [],
            remove_indices: [],
            modify: [
              {
                index: i,
                type: 'combo',
                dynamicSql: sql.trim(),
                yAxisLabel: '% of asset cost',
                display: { secondaryAxisFormat: 'percent' },
              },
            ],
          };
        }
      }

      if (
        spec?.measure === 'revenue_per_employee' &&
        spec.dimension === 'business_unit' &&
        /\bgross\s+margin\s+per\s+employee\b/.test(q)
      ) {
        const sql = `
          SELECT
            business_unit AS name,
            round(avg(revenue_per_employee_usd), 2) AS revenue_per_employee_usd,
            round(sum(gross_margin_usd) / nullIf(sum(employee_count), 0), 2) AS gross_margin_per_employee_usd
          FROM ${this.analyticsDb}.v_ebpo_business_unit_efficiency
          WHERE tenant_id = {tenantId:String}
            AND org_id IN ({externalOrgIds:Array(String)})
            AND business_unit != ''
          GROUP BY business_unit
          ORDER BY revenue_per_employee_usd DESC
          LIMIT 50
        `;
        if (await verify(sql, 'combo')) {
          return {
            summary: 'Added gross margin per employee as a comparison series.',
            add: [],
            remove_indices: [],
            modify: [{ index: i, type: 'combo', dynamicSql: sql.trim() }],
          };
        }
      }

      if (
        spec?.measure === 'operating_cf' &&
        spec.dimension === 'month' &&
        /\bfree\s+cash\s+flow\s+margin\b/.test(q)
      ) {
        const sql = `
          SELECT
            formatDateTime(period_date, '%b %Y') AS name,
            round(sum(operating_cash_flow_usd) / nullIf(sum(total_revenue_usd), 0) * 100, 2) AS operating_cash_flow_pct,
            round(sum(free_cash_flow_usd) / nullIf(sum(total_revenue_usd), 0) * 100, 2) AS free_cash_flow_margin_pct
          FROM ${this.analyticsDb}.v_ebpo_kpi_monthly
          WHERE tenant_id = {tenantId:String}
            AND org_id IN ({externalOrgIds:Array(String)})
          GROUP BY period_date
          ORDER BY period_date ASC
          LIMIT 100
        `;
        if (await verify(sql, 'combo')) {
          return {
            summary: 'Added free cash flow margin as a comparison line.',
            add: [],
            remove_indices: [],
            modify: [{ index: i, type: 'combo', dynamicSql: sql.trim(), yAxisLabel: '% of revenue' }],
          };
        }
      }

      if (
        /\bcurrent\s+ratio\b/.test(q) &&
        /\brevenue\s+per\s+employee\b/.test(q) &&
        /\bfree\s+cash\s+flow\s+margin\b/.test(q)
      ) {
        const sql = `
          WITH latest_kpi AS (
            SELECT *
            FROM ${this.analyticsDb}.v_ebpo_kpi_monthly
            WHERE tenant_id = {tenantId:String}
              AND org_id IN ({externalOrgIds:Array(String)})
            ORDER BY period_date DESC
            LIMIT 1
          )
          SELECT name, value
          FROM (
            SELECT 'Working Capital' AS name, round(cash_balance_usd + ar_outstanding_usd - ap_outstanding_usd, 2) AS value, 1 AS ord
            FROM latest_kpi
            UNION ALL
            SELECT 'Gross Margin %' AS name, round(gross_margin_pct, 2) AS value, 2 AS ord
            FROM latest_kpi
            UNION ALL
            SELECT 'Cost per Employee' AS name, round(sum(total_payroll_usd) / nullIf(sum(employee_count), 0), 2) AS value, 3 AS ord
            FROM ${this.analyticsDb}.v_ebpo_department_efficiency_monthly
            WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})
            UNION ALL
            SELECT 'Revenue per Employee' AS name, round(sum(total_revenue_usd) / nullIf(sum(employee_count), 0), 2) AS value, 4 AS ord
            FROM ${this.analyticsDb}.v_ebpo_department_efficiency_monthly
            WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})
            UNION ALL
            SELECT 'Free Cash Flow Margin %' AS name, round(sum(free_cash_flow_usd) / nullIf(sum(total_revenue_usd), 0) * 100, 2) AS value, 5 AS ord
            FROM ${this.analyticsDb}.v_ebpo_kpi_monthly
            WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})
          )
          ORDER BY ord ASC
          LIMIT 10
        `;
        if (await verify(sql, 'kpi')) {
          return {
            summary: 'Added the requested KPI cards from verified EBPO measures.',
            add: [],
            remove_indices: [],
            modify: [{ index: i, type: 'kpi', dynamicSql: sql.trim() }],
          };
        }
      }
    }

    return null;
  }

  // Give vocabulary widgets (metric/grouping, no stored SQL) an editable
  // dynamicSql by synthesizing + verifying an equivalent query. Returns a copy of
  // the dashboard with backfilled widgets so follow-up edits can rewrite them.
  // sample_gl_dump column expressions per pivot axis (mirror of the closure inside
  // buildExpensePivot) so vocab reconstruction can build the SAME data via a single
  // WIDE SQL the SQL-first edit pipeline can rewrite.
  private glPivotAxisExpr(
    axis: PivotAxis,
  ): { labelExpr: string; sortExpr: string; notEmpty: string } {
    switch (axis) {
      case 'month':
        return {
          labelExpr: `formatDateTime(toStartOfMonth(date), '%b %y')`,
          sortExpr: `toStartOfMonth(date)`,
          notEmpty: `date IS NOT NULL`,
        };
      case 'department':
        return {
          labelExpr: `COALESCE(NULLIF(department, ''), 'Unassigned')`,
          sortExpr: `COALESCE(NULLIF(department, ''), 'Unassigned')`,
          notEmpty: `department != ''`,
        };
      case 'class':
        return {
          labelExpr: `COALESCE(NULLIF(class, ''), 'Unassigned')`,
          sortExpr: `COALESCE(NULLIF(class, ''), 'Unassigned')`,
          notEmpty: `class != ''`,
        };
      case 'vendor':
        return {
          labelExpr: `COALESCE(NULLIF(vendor_customer, ''), 'Unassigned')`,
          sortExpr: `COALESCE(NULLIF(vendor_customer, ''), 'Unassigned')`,
          notEmpty: `vendor_customer != ''`,
        };
      case 'account':
        return {
          labelExpr: `COALESCE(NULLIF(account_name, ''), 'Unassigned')`,
          sortExpr: `COALESCE(NULLIF(account_name, ''), 'Unassigned')`,
          notEmpty: `account_name != ''`,
        };
    }
  }

  private static readonly PIVOT_AXES: ReadonlySet<string> = new Set([
    'month',
    'department',
    'class',
    'vendor',
    'account',
  ]);

  // Rebuild the EXACT data of a vocabulary expense chart as one WIDE pivot SQL,
  // derived from its structured metric+grouping (e.g. metric='expense',
  // grouping='department_class') — NOT guessed from the title. This is what makes
  // follow-ups on heatmap/treemap/matrix/line charts reliable: the edit pipeline
  // now has correct, rewritable SQL to transform. Returns null when the pattern
  // isn't a known expense pivot (caller falls back to title synthesis).
  private async buildVocabExpenseSql(
    metric: string,
    grouping: string,
    scope: OrgScope,
  ): Promise<string | null> {
    const m = String(metric ?? '').toLowerCase();
    if (m !== 'expense' && m !== 'spend') return null;
    const parts = String(grouping ?? '')
      .toLowerCase()
      .split('_')
      .filter(Boolean);
    if (!parts.every((p) => AgentService.PIVOT_AXES.has(p))) return null;

    const SCOPE_WHERE =
      'tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})';
    const tbl = `${this.analyticsDb}.sample_gl_dump`;
    const quoteIdent = (v: string) => `"${String(v).replace(/"/g, '""')}"`;
    const quoteLit = (v: string) => `'${String(v).replace(/'/g, "''")}'`;

    // Single-axis expense → simple ranked bar (name + value).
    if (parts.length === 1) {
      const ax = this.glPivotAxisExpr(parts[0] as PivotAxis);
      const order =
        parts[0] === 'month' ? `${ax.sortExpr} ASC` : `value DESC`;
      return `SELECT ${ax.labelExpr} AS name, round(sum(toFloat64(debit)), 0) AS value FROM ${tbl} WHERE ${SCOPE_WHERE} AND toFloat64(debit) > 0 AND ${ax.notEmpty} GROUP BY ${ax.sortExpr} ORDER BY ${order} LIMIT 100`;
    }

    if (parts.length !== 2) return null;
    const [rowAxis, colAxis] = parts as [PivotAxis, PivotAxis];

    // Determine the actual column set (sorted by spend, capped) the same way the
    // vocab renderer does, so the WIDE SQL columns match what the chart shows.
    const pivot = await this.buildExpensePivot(
      rowAxis,
      colAxis,
      scope,
      {},
      undefined,
    ).catch(() => null);
    const colValues = (pivot?.keys ?? []).filter(
      (k) => typeof k === 'string' && k.length > 0,
    );
    if (colValues.length === 0) return null;

    const row = this.glPivotAxisExpr(rowAxis);
    const col = this.glPivotAxisExpr(colAxis);
    const seriesCols = colValues
      .map(
        (v) =>
          `round(sumIf(toFloat64(debit), ${col.labelExpr} = ${quoteLit(v)}), 0) AS ${quoteIdent(v)}`,
      )
      .join(', ');
    const order =
      rowAxis === 'month'
        ? `${row.sortExpr} ASC`
        : `sum(toFloat64(debit)) DESC`;
    const rowLimit = rowAxis === 'month' ? 24 : 50;
    return `SELECT ${row.labelExpr} AS name, ${seriesCols} FROM ${tbl} WHERE ${SCOPE_WHERE} AND toFloat64(debit) > 0 AND ${row.notEmpty} AND ${col.notEmpty} GROUP BY ${row.sortExpr} ORDER BY ${order} LIMIT ${rowLimit}`;
  }

  // Reconstruct waterfall (metric='pl') and KPI (metric='summary') vocab charts as
  // editable name/value SQL over the trial balance — mirroring the exact P&L
  // formulas the vocab handlers use (Revenue, -COGS, Gross Profit, -OpEx, Net
  // Income). Lets follow-ups convert/edit these charts instead of silently no-op.
  private buildVocabPnlSql(
    metric: string,
    grouping: string,
    scope: OrgScope,
  ): string | null {
    if (scope.externalOrgIds.length === 0) return null;
    const m = String(metric ?? '').toLowerCase();
    const g = String(grouping ?? '').toLowerCase();
    const tb = `${this.analyticsDb}.sample_trial_balance`;
    const SCOPE =
      'tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})';
    const rev = `abs(sumIf(toFloat64(net_balance), account_type = 'Income'))`;
    const cogs = `sumIf(toFloat64(net_balance), account_type = 'Cost of Goods Sold')`;
    const opex = `sumIf(toFloat64(net_balance), account_type = 'Expense')`;
    const branch = (label: string, expr: string, ord: number) =>
      `SELECT '${label}' AS name, round(${expr}, 0) AS value, ${ord} AS ord FROM ${tb} WHERE ${SCOPE}`;

    if (m === 'pl' && g === 'summary') {
      const rows = [
        branch('Revenue', rev, 1),
        branch('Cost of Goods Sold', `-${cogs}`, 2),
        branch('Gross Profit', `${rev} - ${cogs}`, 3),
        branch('Operating Expenses', `-${opex}`, 4),
        branch('Net Income', `${rev} - ${cogs} - ${opex}`, 5),
      ];
      return `SELECT name, value FROM (\n${rows.join('\n  UNION ALL ')}\n) ORDER BY ord ASC LIMIT 10`;
    }

    if (
      (m === 'summary' && g === 'overview') ||
      (m === 'pl_comparison' && g === 'summary')
    ) {
      const rows = [
        branch('Total Revenue', rev, 1),
        branch('Total Expenses', `${opex} + ${cogs}`, 2),
        branch('Gross Profit', `${rev} - ${cogs}`, 3),
        branch('Net Income', `${rev} - ${cogs} - ${opex}`, 4),
      ];
      return `SELECT name, value FROM (\n${rows.join('\n  UNION ALL ')}\n) ORDER BY ord ASC LIMIT 10`;
    }
    return null;
  }

  private async backfillVocabSql(
    ad: ActiveDashboard,
    scope: OrgScope,
  ): Promise<ActiveDashboard> {
    const widgets = await Promise.all(
      ad.widgets.map(async (w) => {
        const cfg = (w.queryConfig as any) ?? {};
        if (typeof cfg.dynamicSql === 'string' && cfg.dynamicSql.trim()) return w;
        if (!cfg.metric && !cfg.grouping) return w;
        // Prefer deterministic reconstruction from the structured metric+grouping
        // (correct columns, no title guessing); fall back to title synthesis.
        const reconstructed =
          (await this.buildVocabExpenseSql(
            cfg.metric,
            cfg.grouping,
            scope,
          ).catch(() => null)) ??
          this.buildVocabPnlSql(cfg.metric, cfg.grouping, scope);
        const sql =
          reconstructed ??
          (await this.generateDynamicSql(
            w.title,
            w.title,
            scope,
            undefined,
          ).catch(() => null));
        if (!sql) return w;
        const r = await this.executeDynamicSqlChecked(sql, scope, {
          chartType: w.chartType as ChartType,
        }).catch(() => null);
        // Only adopt synthesized SQL that runs AND has a clean chart shape — never
        // replace a working vocab chart's data path with a malformed (e.g.
        // long-format / duplicate-label) query.
        if (
          !r ||
          r.error ||
          r.rows.length === 0 ||
          this.detectBadChartShape(r.rows, w.chartType as ChartType)
        )
          return w;
        return {
          ...w,
          queryConfig: { ...cfg, dynamicSql: sql, metric: 'dynamic', grouping: 'query' },
        };
      }),
    );
    return { ...ad, widgets };
  }

  // ─── Phase 3: spec-first editor (behind AGENT_SPEC_MODE flag) ───────────────
  // A follow-up on a spec-backed chart is a DELTA on its stored ChartSpec: the LLM
  // returns the updated spec (catalog-constrained), we recompile to SQL. No SQL
  // rewriting, no regex transform detection, no vocab/dynamic split. Returns a
  // DashboardEditPlan (change or refusal), or null when no widget has a spec / the
  // LLM is unavailable → caller falls back to the legacy editor.
  // A clean, human sentence describing what an edit actually changed (for the chat
  // summary) — derived from the spec diff, no internal mechanics.
  private describeSpecChange(
    prev: ChartSpec,
    next: ChartSpec,
    labelMode: 'value' | 'percent' | null,
  ): string {
    const tname = (t: any) => (typeof t === 'string' ? t : t?.kind);
    const TLABEL: Record<string, string> = {
      normalize: 'normalized it to 100% of the total',
      growth_pct: 'switched to period-over-period growth %',
      moving_average: 'added a moving average',
      reference_line: 'added an average reference line',
    };
    const bits: string[] = [];
    if (next.chartType !== prev.chartType)
      bits.push(`switched it to a ${this.humanizeChartType(next.chartType) ?? next.chartType}`);
    if (next.measure !== prev.measure)
      bits.push(`now showing ${(CATALOG.MEASURES[next.measure]?.label ?? next.measure).toLowerCase()}`);
    if (next.dimension !== prev.dimension)
      bits.push(`grouped by ${CATALOG.DIMENSIONS[next.dimension]?.label?.toLowerCase() ?? next.dimension}`);
    if ((next.breakdown ?? null) !== (prev.breakdown ?? null))
      bits.push(next.breakdown ? `broken down by ${CATALOG.DIMENSIONS[next.breakdown]?.label?.toLowerCase() ?? next.breakdown}` : 'removed the breakdown');
    if ((next.topN ?? null) !== (prev.topN ?? null) && next.topN)
      bits.push(`limited to the top ${next.topN}`);
    const oldT = (prev.transforms ?? []).map(tname);
    for (const t of (next.transforms ?? []).map(tname))
      if (t && !oldT.includes(t)) bits.push(TLABEL[t] ?? String(t));
    if (next.having && !prev.having) bits.push('applied a value threshold');
    if (labelMode === 'value') bits.push('showing values instead of percentages');
    else if (labelMode === 'percent') bits.push('showing percentages');
    if (bits.length === 0) return 'Refreshed the chart.';
    const s = bits.join(', ');
    return s.charAt(0).toUpperCase() + s.slice(1) + '.';
  }

  // Match catalogued EBPO measures NAMED in an "add a measure" follow-up and return
  // the updated spec with measures[] (a real combo), or null when the request is not
  // a measure-add (e.g. a pure transform/label ask) or no single view can plot them.
  private buildEbpoComboEditSpec(currentSpec: ChartSpec, req: string): ChartSpec | null {
    // Normalize so "percentage"/"percent"/"pct"/"%" all compare equal, and strip
    // unit suffixes like "(min)"/"(days)" from measure labels.
    const norm = (s: string) =>
      ` ${s
        .toLowerCase()
        .replace(/\bpercentage\b|\bpercent\b|\bpct\b/g, '%')
        .replace(/\((?:min|days|usd)\)/g, '')
        .replace(/[^a-z0-9%]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()} `;
    const q = norm(req);

    const additive =
      /\b(add|also|include|compare|comparison|alongside|another|plus|overlay|versus|vs)\b/.test(q) ||
      /\bsplit\b.*\binto\b/.test(q) ||
      /\bas (?:a|another) (?:line|column|bar|series)\b/.test(q) ||
      /\bsecond (?:line|series|bar|column|axis)\b/.test(q);
    if (!additive) return null;
    // Pure presentation/transform asks are handled by the transform builder, not here.
    const current = (
      currentSpec.measures?.length
        ? currentSpec.measures
        : currentSpec.measure
          ? [currentSpec.measure]
          : []
    ).filter((m): m is string => !!m);
    if (current.length === 0) return null;

    const mentioned = this.detectEbpoMeasureMentions(req).filter((mid) => !current.includes(mid));
    if (
      /\b(?:% contribution|contribution|normali[sz]e|100 %|moving average|growth|reference line|average line|data label|labels|highlight|cumulative)\b/.test(
        q,
      ) &&
      !mentioned.includes('revenue_yoy_pct')
    )
      return null;

    // Significant words of a label (≥4 chars, dropping filler) — lets "benefits as a
    // percentage of base salary" match "Benefits % of Base Salary" even though the
    // exact label substring isn't present.
    const sigTokens = (s: string) =>
      norm(s)
        .trim()
        .split(' ')
        .filter((w) => w.length >= 4 && !['of', 'the', 'per', 'and'].includes(w));

    const matched: string[] = [...mentioned];
    for (const [mid, def] of Object.entries(EBPO_MEASURES)) {
      if (current.includes(mid) || matched.includes(mid)) continue;
      const idPhrase = norm(mid.replace(/_/g, ' '));
      const candidates = [def.label, ...(def.aliases ?? [])];
      const matchedCandidate = candidates.some((candidate) => {
        const labelCore = norm(candidate);
        const tokens = sigTokens(candidate);
        const allTokensPresent =
          tokens.length >= 2 &&
          tokens.every((t) => q.includes(` ${t} `) || q.includes(`${t} `));
        return (labelCore.trim().length >= 2 && q.includes(labelCore)) || allTokensPresent;
      });
      if (q.includes(idPhrase) || matchedCandidate) {
        matched.push(mid);
      }
    }
    if (matched.length === 0) return null;

    const measures = Array.from(new Set([...current, ...matched]));
    if (measures.length < 2) return null;
    // One EBPO view must expose EVERY measure at the current dimension (no joins).
    if (!resolveEbpoViewMulti(measures, currentSpec.dimension)) return null;

    const keep = new Set(['stacked_bar', 'stacked_area', 'combo']);
    const chartType = keep.has(String(currentSpec.chartType))
      ? currentSpec.chartType
      : ('combo' as ChartSpec['chartType']);
    return { ...currentSpec, measures, chartType };
  }

  // Compile EBPO combo spec(s) for "add a measure" follow-ups and return a modify
  // plan, or null to defer. Fully deterministic — no LLM.
  private async buildEbpoComboEditPlan(
    targets: Array<{ w: any; index: number; spec?: ChartSpec }>,
    editRequest: string,
    scope: OrgScope,
  ): Promise<DashboardEditPlan | null> {
    const modify: DashboardEditPlan['modify'] = [];
    let summary = '';
    const runRows = (sql: string) =>
      this.queryRows<Record<string, unknown>>(sql, {
        tenantId: scope.tenantId,
        externalOrgIds: scope.externalOrgIds,
      });
    for (const t of targets) {
      if (!t.spec) continue;
      const newSpec = this.buildEbpoComboEditSpec(t.spec, editRequest);
      if (!newSpec) continue;
      const compiled = await compileEbpoSpec(newSpec, this.analyticsDb, runRows);
      if (!compiled.ok) continue;
      const nextType = (newSpec.chartType ?? t.w.chartType) as ChartType;
      const check = await this.executeDynamicSqlChecked(compiled.sql, scope, {
        chartType: nextType,
      }).catch(() => null);
      if (!check || check.error || check.rows.length === 0) continue;
      if (this.detectBadChartShape(check.rows, nextType)) continue;
      if (!summary) {
        const prior = new Set(t.spec.measures?.length ? t.spec.measures : [t.spec.measure]);
        const added = (newSpec.measures ?? [])
          .filter((m) => !prior.has(m))
          .map((m) => EBPO_MEASURES[m!]?.label ?? m)
          .join(', ');
        summary = `Added ${added} as a comparison series.`;
      }
      // Format hints: left axis = first measure's unit, right axis = second's.
      const mlist = newSpec.measures ?? [];
      const firstM = EBPO_MEASURES[mlist[0]!];
      const secondM = EBPO_MEASURES[mlist[1]!];
      const display: DisplayHints = {
        valueFormat: firstM?.format ?? null,
        ...(typeof firstM?.decimals === 'number' ? { valueDecimals: firstM.decimals } : {}),
        ...(secondM ? { secondaryAxisFormat: secondM.format, secondaryLabel: secondM.label } : {}),
      };
      modify.push({ index: t.index, type: nextType, dynamicSql: compiled.sql, spec: newSpec, display });
    }
    if (modify.length === 0) return null;
    this.logger.log(
      `[SpecEdit:EBPO-combo] ${modify.length} chart(s) for: "${editRequest.slice(0, 50)}"`,
    );
    return { summary: summary || 'Added a comparison series.', add: [], remove_indices: [], modify };
  }

  private async generateSpecEditPlan(
    activeDashboard: ActiveDashboard,
    editRequest: string,
    scope: OrgScope,
    conversationHistory?: string,
  ): Promise<DashboardEditPlan | null> {
    try {
      const targets = activeDashboard.widgets
        .map((w, index) => ({ w, index, spec: (w.queryConfig as any)?.spec as ChartSpec | undefined }))
        .filter((t) => t.spec && typeof t.spec === 'object');
      if (targets.length === 0) return null;

      // ── EBPO deterministic combo (A1 fix) ────────────────────────────────────
      // "add <catalogued measure> as a line / to compare" must ADD that measure as
      // a 2nd series (measures[]). The GL second-axis builder only sees
      // sample_gl_dump, so for EBPO it degraded to a company-average reference line
      // (the dominant data-2 follow-up failure). Run BEFORE the transform-defer and
      // the LLM ping — this path is fully deterministic and needs neither.
      const ebpoForCombo = await this.orgHasEbpoData(scope).catch(() => false);
      if (ebpoForCombo) {
        const comboPlan = await this.buildEbpoComboEditPlan(targets, editRequest, scope);
        if (comboPlan) return comboPlan;
      }

      // Cumulative percentage lines are a derived overlay, not a change to the
      // base catalog measure. Defer so buildEbpoMetricEdit can add the verified
      // cumulative_pct series instead of the spec editor replacing the chart with
      // a single normalized value series.
      if (/\bcumulative\b/.test(editRequest.toLowerCase()) && /\bpercent|percentage|%\b/.test(editRequest.toLowerCase()))
        return null;

      // Recognized analytical transforms (moving average, normalize, growth %,
      // variance, reference line, second axis, YoY/prior-year) are applied/refused
      // RELIABLY by the deterministic transform builder — the spec-editor LLM tends
      // to echo the spec without adding them, yielding a silent no-op. Defer those.
      if (this.detectFollowUpTransform(editRequest)) return null;

      const ping = await fetch(`${this.OLLAMA_URL}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      }).catch(() => null);
      if (!ping?.ok) return null;

      // Dataset-aware: an EBPO dashboard is edited against the EBPO catalog so the
      // edit stays deterministic too; GL dashboards keep the GL catalog.
      const useEbpo = await this.orgHasEbpoData(scope).catch(() => false);
      const catalogText = useEbpo ? ebpoCatalogPromptText() : catalogPromptText();

      const history =
        conversationHistory && !conversationHistory.includes('(No prior')
          ? `\nCONVERSATION SO FAR:\n${conversationHistory.slice(0, 500)}\n`
          : '';
      // Presentation-only intent (pie/donut label mode, matrix highlighting) that
      // the ChartSpec doesn't model — apply it on top of any spec delta so display
      // edits ("change the percentage to values") aren't dropped in spec mode.
      const labelMode = this.detectLabelModeEdit(editRequest);
      const matrixHints = this.detectMatrixDisplayEdit(editRequest);

      const modify: DashboardEditPlan['modify'] = [];
      let changeSummary = '';

      for (const t of targets) {
        const userMsg =
          `${catalogText}\n${history}\nCURRENT SPEC: ${JSON.stringify(t.spec)}\n` +
          `USER CHANGE: "${editRequest}"\nReturn the updated spec JSON now.`;
        const resp = await fetch(`${this.OLLAMA_URL}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(60_000),
          body: JSON.stringify({
            model: this.OLLAMA_MODEL,
            messages: [
              { role: 'system', content: SPEC_EDITOR_SYSTEM },
              { role: 'user', content: userMsg },
            ],
            stream: false,
            options: { temperature: 0.05, num_predict: 600 },
          }),
        });
        if (!resp.ok) continue;
        const body = (await resp.json()) as { message?: { content?: string } };
        const rawText = (body.message?.content ?? '').replace(/```json|```/g, '').trim();
        let parsed: any;
        try {
          parsed = JSON.parse(rawText);
        } catch {
          const m = rawText.match(/\{[\s\S]*\}/);
          if (!m) continue;
          parsed = JSON.parse(m[0]);
        }

        // Spec mode is ADDITIVE: if it can't model the edit (the model declined,
        // an unmodeled type, or the compile can't satisfy it), DEFER to the legacy
        // editor (which has variance/second-axis/threshold-filter/explode-drill/
        // matrix-format + its own honest refusals). Never refuse from here.
        if (typeof parsed?.refusal === 'string' && parsed.refusal.trim() && !parsed?.spec)
          continue;
        const newSpec = parsed?.spec as ChartSpec | undefined;
        if (!newSpec || typeof newSpec !== 'object') continue;
        if (!this.specCanModelChart(newSpec)) continue;

        // Did the spec actually change? If the model echoed the same spec with no
        // presentation delta either, it couldn't model the edit → defer to legacy
        // (prevents a silent no-op that claims success).
        const specChanged = JSON.stringify(newSpec) !== JSON.stringify(t.spec);
        if (!specChanged && !labelMode && !matrixHints) continue;

        const editRunRows = (sql: string) =>
          this.queryRows<Record<string, unknown>>(sql, {
            tenantId: scope.tenantId,
            externalOrgIds: scope.externalOrgIds,
          });
        const compiled = useEbpo
          ? await compileEbpoSpec(newSpec, this.analyticsDb, editRunRows)
          : await compileSpec(newSpec, this.analyticsDb, editRunRows);
        if (!compiled.ok) continue;
        const nextType = (newSpec.chartType ?? t.w.chartType) as ChartType;
        // NO-OP GUARD: if the recompiled SQL is identical to what's already on the
        // chart and there's no type/label change, the "edit" changed nothing —
        // defer to legacy instead of claiming success ("Refreshed the chart").
        const curSql = String((t.w.queryConfig as any)?.dynamicSql ?? '').trim();
        const sameSql = curSql && curSql === compiled.sql.trim();
        const sameType = String(t.w.chartType) === String(nextType);
        if (sameSql && sameType && !labelMode && !matrixHints) continue;
        const check = await this.executeDynamicSqlChecked(compiled.sql, scope, {
          chartType: nextType,
        }).catch(() => null);
        if (!check || check.error || check.rows.length === 0) continue;
        if (this.detectBadChartShape(check.rows, nextType)) continue;

        const ct = String(nextType).toLowerCase();
        const baseDisplay: DisplayHints | undefined =
          labelMode && (ct === 'pie' || ct === 'donut')
            ? { labelMode }
            : matrixHints && (ct === 'matrix' || ct === 'heatmap')
              ? matrixHints
              : undefined;
        // EBPO: carry the (possibly changed) measure's unit so a percent measure
        // formats as % not $ after an edit like "replace revenue with gross margin %".
        const editMeasureDecimals = (compiled.measure as { decimals?: number }).decimals;
        const display: DisplayHints | undefined = useEbpo
          ? {
              ...(baseDisplay ?? {}),
              valueFormat: compiled.measure.format,
              ...(typeof editMeasureDecimals === 'number'
                ? { valueDecimals: editMeasureDecimals }
                : {}),
            }
          : baseDisplay;
        if (!changeSummary) changeSummary = this.describeSpecChange(t.spec!, newSpec, labelMode);
        modify.push({
          index: t.index,
          type: nextType,
          dynamicSql: compiled.sql,
          spec: newSpec,
          ...(display ? { display } : {}),
        });
      }

      if (modify.length > 0) {
        this.logger.log(`[SpecEdit] ${modify.length} chart(s) re-specced for: "${editRequest.slice(0, 50)}"`);
        return { summary: changeSummary || 'Updated the chart.', add: [], remove_indices: [], modify };
      }
      return null; // couldn't model it → defer to the legacy editor
    } catch (err: any) {
      this.logger.warn(`[SpecEdit] failed: ${err?.message ?? err}`);
      return null;
    }
  }

  private normalizeChartTargetText(text: string): string {
    return String(text ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private tokenizeChartTargetText(text: string): string[] {
    const stop = new Set([
      'a',
      'an',
      'and',
      'chart',
      'dashboard',
      'delete',
      'drop',
      'from',
      'get',
      'graph',
      'hide',
      'it',
      'of',
      'out',
      'please',
      'remove',
      'rid',
      'that',
      'the',
      'this',
      'take',
      'widget',
    ]);
    return this.normalizeChartTargetText(text)
      .split(' ')
      .filter((token) => token.length > 1 && !stop.has(token));
  }

  private ordinalChartIndex(text: string): number | null {
    const q = this.normalizeChartTargetText(text);
    const words: Record<string, number> = {
      first: 0,
      second: 1,
      third: 2,
      fourth: 3,
      fifth: 4,
      sixth: 5,
      seventh: 6,
      eighth: 7,
    };
    for (const [word, index] of Object.entries(words)) {
      if (new RegExp(`\\b${word}\\b`).test(q)) return index;
    }
    const numeric = q.match(/\b(?:chart|widget|graph)\s*(\d+)\b/);
    if (numeric?.[1]) return Number(numeric[1]) - 1;
    const version = q.match(/\bv\s*(\d+)\b/);
    if (version?.[1]) return Number(version[1]) - 1;
    return null;
  }

  private chartChoiceList(activeDashboard: ActiveDashboard): string {
    return activeDashboard.widgets
      .map((widget, index) => `${index + 1}) ${widget.title}`)
      .join('\n');
  }

  private resolveDeleteChartTarget(
    activeDashboard: ActiveDashboard,
    editRequest: string,
  ): DeleteChartTarget {
    const q = this.normalizeChartTargetText(editRequest);
    const wantsDelete =
      /\b(delete|remove|drop|hide)\b/.test(q) ||
      /\btake\s+out\b/i.test(editRequest) ||
      /\bget\s+rid\s+of\b/i.test(editRequest) ||
      /\bdlete\b/.test(q);
    if (!wantsDelete) return { kind: 'none' };

    const widgets = activeDashboard.widgets;
    if (widgets.length === 0) {
      return {
        kind: 'ambiguous',
        refusal:
          'There are no active charts to delete in the live dashboard. Previous chart versions are history only.',
      };
    }

    const requestTokens = this.tokenizeChartTargetText(editRequest);
    const titleTargetMentioned = widgets.some((widget) => {
      const title = this.normalizeChartTargetText(widget.title);
      if (title && q.includes(title)) return true;
      const titleTokens = new Set(this.tokenizeChartTargetText(widget.title));
      return requestTokens.some((token) => titleTokens.has(token));
    });
    const mentionsChart =
      /\b(chart|charts|widget|widgets|graph|graphs|visual|visualization|visualisation)\b/.test(q) ||
      /\b(latest|last|newest|recent|current)\b/.test(q) ||
      /\bv\s*\d+\b/.test(q) ||
      titleTargetMentioned;
    if (!mentionsChart) return { kind: 'none' };

    if (/\b(all|every|each)\b/.test(q) && /\b(charts|widgets|graphs)\b/.test(q)) {
      return {
        kind: 'resolved',
        indices: widgets.map((_, index) => index),
        summary: `Removed all ${widgets.length} charts from the dashboard. Previous chart versions remain in the history.`,
      };
    }

    if (/\b(latest|last|newest|recent|current)\b/.test(q)) {
      const index = widgets.length - 1;
      return {
        kind: 'resolved',
        indices: [index],
        summary: `Removed ${widgets[index]!.title}. Previous chart versions remain in the history.`,
      };
    }

    const ordinal = this.ordinalChartIndex(editRequest);
    if (ordinal !== null) {
      if (ordinal >= 0 && ordinal < widgets.length) {
        return {
          kind: 'resolved',
          indices: [ordinal],
          summary: `Removed ${widgets[ordinal]!.title}. Previous chart versions remain in the history.`,
        };
      }
      return {
        kind: 'ambiguous',
        refusal: `I could not find chart ${ordinal + 1}. Current charts:\n${this.chartChoiceList(activeDashboard)}`,
      };
    }

    const deicticOnly = /\b(this|that|it|selected)\b/.test(q);
    if (deicticOnly && widgets.length === 1) {
      return {
        kind: 'resolved',
        indices: [0],
        summary: `Removed ${widgets[0]!.title}. Previous chart versions remain in the history.`,
      };
    }

    const scored = widgets
      .map((widget, index) => {
        const title = this.normalizeChartTargetText(widget.title);
        const titleTokens = new Set(this.tokenizeChartTargetText(widget.title));
        const overlap = requestTokens.filter((token) => titleTokens.has(token)).length;
        const phraseMatch = title.length > 0 && q.includes(title);
        return {
          index,
          score: (phraseMatch ? 100 : 0) + overlap,
        };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length > 0) {
      const [best, second] = scored;
      if (best && (!second || best.score > second.score)) {
        return {
          kind: 'resolved',
          indices: [best.index],
          summary: `Removed ${widgets[best.index]!.title}. Previous chart versions remain in the history.`,
        };
      }
    }

    if (widgets.length === 1) {
      return {
        kind: 'resolved',
        indices: [0],
        summary: `Removed ${widgets[0]!.title}. Previous chart versions remain in the history.`,
      };
    }

    return {
      kind: 'ambiguous',
      refusal: `Which chart should I delete?\n${this.chartChoiceList(activeDashboard)}`,
    };
  }

  private async generateEditPlan(
    activeDashboard: ActiveDashboard,
    editRequest: string,
    scope?: OrgScope,
    range?: TimeRange,
    conversationHistory?: string,
  ): Promise<DashboardEditPlan> {
    const deleteTarget = this.resolveDeleteChartTarget(
      activeDashboard,
      editRequest,
    );
    if (deleteTarget.kind === 'resolved') {
      return {
        summary: deleteTarget.summary,
        add: [],
        remove_indices: deleteTarget.indices,
        modify: [],
      };
    }
    if (deleteTarget.kind === 'ambiguous') {
      return {
        summary: '',
        add: [],
        remove_indices: [],
        modify: [],
        refusal: deleteTarget.refusal,
      };
    }

    // If any chart carries a ChartSpec, edit the spec (delta) and recompile. This
    // runs when AGENT_SPEC_MODE is on (GL opt-in) OR whenever the active dashboard
    // was built from a spec — which is always true for EBPO charts (the catalog is
    // primary for EBPO), so EBPO follow-ups stay deterministic in production too.
    // Legacy non-spec dashboards are untouched.
    const dashboardHasSpec = activeDashboard.widgets.some(
      (w) => !!(w.queryConfig as any)?.spec,
    );
    if (scope && (process.env.AGENT_SPEC_MODE === '1' || dashboardHasSpec)) {
      const specEdit = await this.generateSpecEditPlan(
        activeDashboard,
        editRequest,
        scope,
        conversationHistory,
      ).catch(() => null);
      if (specEdit) return specEdit;
    }

    const unsupportedFeature = this.detectUnsupportedFeature(editRequest);
    if (unsupportedFeature) {
      return {
        summary: '',
        add: [],
        remove_indices: [],
        modify: [],
        refusal: `${unsupportedFeature.label} is not currently supported, so I left the existing chart unchanged. ${unsupportedFeature.alternativeValue}`,
      };
    }

    // General missing-DATA net: refuse clearly (never fabricate columns) when the
    // follow-up needs data the dataset simply does not contain. This is the cheap
    // deterministic backstop; the data-aware SQL editor refuses the long tail.
    // Dataset-aware: EBPO has cash flow / headcount / region / multi-year / segments,
    // so those categories must NOT be refused here for EBPO orgs.
    const editHasEbpo = scope
      ? await this.orgHasEbpoData(scope).catch(() => false)
      : false;
    const unavailableData = this.detectUnavailableData(editRequest, editHasEbpo);
    if (unavailableData) {
      return {
        summary: '',
        add: [],
        remove_indices: [],
        modify: [],
        refusal: unavailableData,
      };
    }

    const wantsValueLabels =
      /\b(whole\s+values?|values?\s+instead\s+of\s+percent(?:age|ages)?|remove\s+percent(?:age|ages)?|show\s+values?|raw\s+values?)\b/i.test(
        editRequest,
      ) ||
      /\bneed\s+values?\b/i.test(editRequest) ||
      /\babsolute\s+values?\b/i.test(editRequest) ||
      /\bnumbers?\s+instead\s+of\s+percent(?:age|ages)?\b/i.test(editRequest) ||
      /\bwithout\s+percent(?:age|ages)?\b/i.test(editRequest) ||
      /\bno\s+percent(?:age|ages)?\b/i.test(editRequest) ||
      /\bpercentage\s+to\s+values?\b/i.test(editRequest) ||
      /\bpercent(?:age|ages)?\s+to\s+values?\b/i.test(editRequest);
    const wantsPercentLabels =
      /\bpercent(?:age|ages)?\s+to\s+percent(?:age|ages)?\b/i.test(
        editRequest,
      ) ||
      /\bshow\s+percent(?:age|ages)?\b/i.test(editRequest) ||
      /\bpercent(?:age|ages)?\s+labels?\b/i.test(editRequest) ||
      /\bpercent(?:age|ages)?\s+values?\b/i.test(editRequest) ||
      /\bshow\s+percent(?:age|ages)?\s+in\s+the\s+chart\b/i.test(editRequest);

    const requestedLabelMode: 'value' | 'percent' | null = wantsValueLabels
      ? 'value'
      : wantsPercentLabels
        ? 'percent'
        : null;
    const matrixDisplayHints = this.detectMatrixDisplayEdit(editRequest);

    // Deterministically force pie/donut label mode (percent <-> whole values) on
    // top of whatever plan we return. This is cheaper and more reliable than
    // depending on the LLM to honor the exact phrasing.
    const injectPieDonutLabelMode = (
      plan: DashboardEditPlan,
    ): DashboardEditPlan => {
      if (!requestedLabelMode || activeDashboard.widgets.length === 0)
        return plan;
      const pieOrDonutTargets = activeDashboard.widgets
        .map((widget, index) => ({ widget, index }))
        .filter(
          ({ widget }) =>
            String(widget.chartType ?? '').toLowerCase() === 'donut' ||
            String(widget.chartType ?? '').toLowerCase() === 'pie',
        );
      if (pieOrDonutTargets.length === 0) return plan;

      const summarySuffix =
        requestedLabelMode === 'value'
          ? 'Switched pie/donut labels to whole values.'
          : 'Switched pie/donut labels to percentages.';
      plan.summary = plan.summary
        ? `${plan.summary} ${summarySuffix}`
        : summarySuffix;

      for (const { widget, index } of pieOrDonutTargets) {
        const existingModify = plan.modify.find(
          (entry) => entry.index === index,
        );
        const existingDisplay =
          existingModify?.display ??
          (widget.queryConfig as any)?.display ??
          null;
        const mergedDisplay = {
          ...(existingDisplay && typeof existingDisplay === 'object'
            ? existingDisplay
            : {}),
          labelMode: requestedLabelMode,
        };
        if (existingModify) {
          existingModify.display = mergedDisplay;
        } else {
          plan.modify.push({
            index,
            display: mergedDisplay,
          } as DashboardEditPlan['modify'][number]);
        }
      }
      return plan;
    };

    const injectMatrixDisplayHints = (
      plan: DashboardEditPlan,
    ): DashboardEditPlan => {
      if (!matrixDisplayHints || activeDashboard.widgets.length === 0)
        return plan;
      const matrixTargets = activeDashboard.widgets
        .map((widget, index) => ({ widget, index }))
        .filter(({ widget }) => {
          const t = String(widget.chartType ?? '').toLowerCase();
          return t === 'matrix' || t === 'heatmap';
        });
      if (matrixTargets.length === 0) return plan;

      const avgLabel =
        matrixDisplayHints.conditionalThresholdMode === 'columnAverage'
          ? 'above the column average'
          : matrixDisplayHints.conditionalThresholdMode === 'rowAverage'
            ? 'above the row average'
            : matrixDisplayHints.conditionalThresholdMode === 'overallAverage'
              ? 'above the overall average'
              : null;
      const summarySuffix =
        matrixDisplayHints.conditionalThreshold != null
          ? `Highlighted matrix cells above ${matrixDisplayHints.conditionalThreshold.toLocaleString()} in green and kept row/column totals visible.`
          : avgLabel
            ? `Highlighted matrix cells ${avgLabel} in green.`
            : 'Kept matrix row and column totals visible.';
      plan.summary = plan.summary
        ? `${plan.summary} ${summarySuffix}`
        : summarySuffix;

      for (const { widget, index } of matrixTargets) {
        const existingModify = plan.modify.find(
          (entry) => entry.index === index,
        );
        const existingDisplay =
          existingModify?.display ??
          (widget.queryConfig as any)?.display ??
          null;
        const mergedDisplay = {
          ...(existingDisplay && typeof existingDisplay === 'object'
            ? existingDisplay
            : {}),
          ...matrixDisplayHints,
        };
        if (existingModify) {
          existingModify.display = mergedDisplay;
        } else {
          plan.modify.push({
            index,
            display: mergedDisplay,
          } as DashboardEditPlan['modify'][number]);
        }
      }
      return plan;
    };

    if (scope && editHasEbpo && activeDashboard.widgets.length > 0) {
      const ebpoMetricEdit = await this.buildEbpoMetricEdit(
        activeDashboard,
        editRequest,
        scope,
      ).catch((err: any) => {
        this.logger.warn(
          `[Agent:Editor] EBPO metric edit failed (${err?.message ?? err}) — falling back`,
        );
        return null;
      });
      if (ebpoMetricEdit) return injectMatrixDisplayHints(ebpoMetricEdit);
    }

    if (matrixDisplayHints && activeDashboard.widgets.length > 0) {
      const matrixOnlyPlan = injectMatrixDisplayHints({
        summary: '',
        add: [],
        remove_indices: [],
        modify: [],
      });
      if (matrixOnlyPlan.modify.length > 0) return matrixOnlyPlan;
    }

    const explicitType = this.detectPureChartTypeEditRequest(editRequest);
    if (explicitType && activeDashboard.widgets.length > 0) {
      return injectMatrixDisplayHints(injectPieDonutLabelMode({
        summary: `Switched existing chart${activeDashboard.widgets.length > 1 ? 's' : ''} to ${this.humanizeChartType(explicitType)}.`,
        add: [],
        remove_indices: [],
        modify: activeDashboard.widgets.map((_, index) => ({
          index,
          type: explicitType,
        })),
      }));
    }

    // Vocabulary widgets store only metric/grouping (no editable SQL). Synthesize
    // an equivalent base SQL once so BOTH the deterministic transforms and the SQL
    // editor below can actually rewrite them — otherwise a follow-up on a pivot/
    // heatmap/breakdown chart silently no-ops ("same output").
    const effectiveDashboard =
      scope &&
      activeDashboard.widgets.some(
        (w) => !((w.queryConfig as any)?.dynamicSql),
      )
        ? await this.backfillVocabSql(activeDashboard, scope)
        : activeDashboard;

    // ── Layer D: deterministic follow-up transforms (highest priority) ────
    // For recognized transform verbs (normalize-to-100%, moving average,
    // reference/average line) we build the SQL deterministically from the
    // chart's existing SQL — no LLM SQL hallucination — and refuse clearly when
    // the data can't satisfy the ask (YoY/prior-year with a single year).
    if (scope && effectiveDashboard.widgets.length > 0) {
      const transform = this.detectFollowUpTransform(editRequest);
      if (transform) {
        const det = await this.buildDeterministicTransformEdit(
          effectiveDashboard,
          transform,
          scope,
        ).catch((err: any) => {
          this.logger.warn(
            `[Agent:Editor] deterministic transform failed (${err?.message ?? err}) — falling back`,
          );
          return null;
        });
        if (det) return injectMatrixDisplayHints(det); // a real transform plan OR a clear refusal
      }
    }

    if (scope && editHasEbpo && effectiveDashboard.widgets.length > 0) {
      const ebpoMetricEdit = await this.buildEbpoMetricEdit(
        effectiveDashboard,
        editRequest,
        scope,
      ).catch((err: any) => {
        this.logger.warn(
          `[Agent:Editor] EBPO metric edit failed (${err?.message ?? err}) — falling back`,
        );
        return null;
      });
      if (ebpoMetricEdit) return injectMatrixDisplayHints(ebpoMetricEdit);
    }

    // ── PRIMARY: SQL-first editor ─────────────────────────────────────────
    // Rewrites the underlying live SQL so ANY data/axis/metric/percentage change
    // actually takes effect. Falls back to the vocabulary editor below only when
    // the SQL editor is unavailable (Ollama offline) or declines to act.
    if (scope) {
      const smartEdit = await this.generateSmartEditPlan(
        effectiveDashboard,
        editRequest,
        scope,
        range,
        conversationHistory,
      ).catch((err: any) => {
        this.logger.warn(
          `[Agent:Editor] SQL-first editor failed (${err?.message ?? err}) — falling back to vocabulary editor`,
        );
        return null;
      });
      if (smartEdit)
        return injectMatrixDisplayHints(injectPieDonutLabelMode(smartEdit));
    }

    const widgetList = activeDashboard.widgets
      .map((w, i) => {
        const cfg = (w.queryConfig as any) ?? {};
        return `  ${i}. [${w.chartType.toUpperCase()}] ${w.title} — ${cfg.metric ?? '?'}/${cfg.grouping ?? '?'}`;
      })
      .join('\n');

    // HONESTY: when no real change can be produced we must NOT claim success
    // (that is the "same output" the testers keep flagging). Say so plainly and
    // leave the chart untouched, prompting the user to rephrase.
    const honestNoChange: DashboardEditPlan = {
      summary: '',
      add: [],
      remove_indices: [],
      modify: [],
      refusal:
        "I wasn't able to apply that change to the existing chart. Could you rephrase what you'd like — for example the metric, dimension, time range, filter, sort order, top-N, or chart type?",
    };
    // A plan that actually changes something has at least one of these.
    const planHasRealChange = (p: DashboardEditPlan): boolean =>
      (Array.isArray(p.modify) && p.modify.length > 0) ||
      (Array.isArray(p.add) && p.add.length > 0) ||
      (Array.isArray(p.remove_indices) && p.remove_indices.length > 0) ||
      Boolean(p.refusal);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), LLM_CHAT_TIMEOUT_MS);

      const response = await fetch(`${this.OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.OLLAMA_MODEL,
          messages: [
            { role: 'system', content: EDITOR_SYSTEM },
            {
              role: 'user',
              content: `CURRENT DASHBOARD: "${activeDashboard.title}"\nCURRENT WIDGETS (0-indexed):\n${widgetList}\n\nUSER REQUEST: "${editRequest}"\n\nGenerate the edit JSON now.`,
            },
          ],
          stream: false,
          options: {
            temperature: 0.2,
            num_predict: -1,
            num_ctx: 8192,
            top_p: 0.8,
            top_k: 20,
            repeat_penalty: 1.05,
            stop: ['<|start_header_id|>', '<|end_header_id|>', '<|eot_id|>'],
          },
          format: EDITOR_SCHEMA,
        }),
      });
      clearTimeout(timeout);

      if (!response.ok) return honestNoChange;

      const body = (await response.json()) as {
        message?: { content?: string };
      };
      const raw = body.message?.content ?? '';
      const cleaned = raw
        .replace(/^```(?:json)?\s*/m, '')
        .replace(/\s*```$/m, '')
        .trim();
      const parsed = JSON.parse(cleaned) as DashboardEditPlan;

      injectMatrixDisplayHints(injectPieDonutLabelMode(parsed));

      // Validate add widgets against known pairs
      if (Array.isArray(parsed.add)) {
        parsed.add = parsed.add.filter((w) =>
          VALID_WIDGETS.some(
            (v) =>
              v.type === w.type &&
              v.metric === w.metric &&
              v.grouping === w.grouping,
          ),
        );
      } else {
        parsed.add = [];
      }

      // Clamp total widget count to 8
      const afterRemoves =
        activeDashboard.widgets.length - (parsed.remove_indices?.length ?? 0);
      const maxAdd = Math.max(0, 8 - afterRemoves);
      parsed.add = (parsed.add ?? []).slice(0, maxAdd);
      parsed.remove_indices = (parsed.remove_indices ?? []).filter(
        (i) => i >= 0 && i < activeDashboard.widgets.length,
      );
      parsed.modify = (parsed.modify ?? []).filter(
        (m) => m.index >= 0 && m.index < activeDashboard.widgets.length,
      );

      // Honesty guard: if the vocabulary editor produced nothing actionable,
      // refuse clearly instead of silently reporting "Applied requested changes".
      if (!planHasRealChange(parsed)) return honestNoChange;
      return parsed;
    } catch (err: any) {
      this.logger.warn(
        `[Agent:Editor] Edit plan parse failed (${err.message})`,
      );
      return honestNoChange;
    }
  }

  // ─── Apply Dashboard Edit ─────────────────────────────────────────────────

  private async applyDashboardEdit(
    dashboardId: string,
    editPlan: DashboardEditPlan,
    organizationId: string,
    spec?: QuerySpec,
  ): Promise<{
    id: string;
    title: string;
    widgetCount: number;
    widgets: ChartTurnWidgetSnapshot[];
  }> {
    return this.prisma.$transaction(async (tx) => {
      const currentWidgets = await tx.dashboardWidget.findMany({
        where: { dashboardId },
        orderBy: { displayOrder: 'asc' },
      });
      const resolveWidgetType = (
        metric: string,
        grouping: string,
        preferredType?: string,
      ): ChartType => {
        const normalizedMetric = String(metric ?? '').trim();
        const normalizedGrouping = String(grouping ?? '').trim();
        const validMatch = VALID_WIDGETS.find(
          (widget) =>
            widget.metric === normalizedMetric && widget.grouping === normalizedGrouping,
        );
        if (preferredType) {
          const preferredMatch = VALID_WIDGETS.find(
            (widget) =>
              widget.type === preferredType &&
              widget.metric === normalizedMetric &&
              widget.grouping === normalizedGrouping,
          );
          if (preferredMatch) return preferredMatch.type;
        }
        if (validMatch) return validMatch.type;
        return (preferredType ?? 'bar') as ChartType;
      };
      const existingRange =
        (currentWidgets[0]?.queryConfig as any)?.timeRange ?? null;
      const existingProviderHint =
        (currentWidgets[0]?.queryConfig as any)?.providerHint ?? null;
      const incomingOrgId = spec?.entityFilter?.orgId ?? null;
      const incomingOrgName = spec?.entityFilter?.orgName ?? null;
      const existingOrgId =
        (currentWidgets[0]?.queryConfig as any)?.orgId ?? null;
      const existingOrgName =
        (currentWidgets[0]?.queryConfig as any)?.orgName ?? null;
      const nextOrgId = incomingOrgId ?? existingOrgId;
      const nextOrgName = incomingOrgName ?? existingOrgName;

      const removeIds = editPlan.remove_indices
        .filter((i) => i >= 0 && i < currentWidgets.length)
        .map((i) => currentWidgets[i]!.id);

      // If the user explicitly scoped to a different entity, propagate it to all retained widgets.
      if (incomingOrgId && incomingOrgId !== existingOrgId) {
        for (const w of currentWidgets) {
          if (removeIds.includes(w.id)) continue;
          const cfg = (w.queryConfig as any) ?? {};
          await tx.dashboardWidget.update({
            where: { id: w.id },
            data: {
              queryConfig: {
                ...cfg,
                orgId: incomingOrgId,
                orgName: incomingOrgName,
              } as Prisma.InputJsonValue,
            },
          });
        }
      }

      // Apply type/title modifications
      for (const mod of editPlan.modify) {
        const widget = currentWidgets[mod.index];
        if (!widget || removeIds.includes(widget.id)) continue;
        const changes: Record<string, unknown> = {};
        const existingConfig = (widget.queryConfig as Record<string, unknown>) ?? {};
        const nextConfig: Record<string, unknown> = { ...existingConfig };
        if (mod.title) changes.title = mod.title;
        const nextMetric =
          typeof mod.metric === 'string' && mod.metric.trim()
            ? mod.metric.trim()
            : String(existingConfig.metric ?? '').trim();
        const nextGrouping =
          typeof mod.grouping === 'string' && mod.grouping.trim()
            ? mod.grouping.trim()
            : String(existingConfig.grouping ?? '').trim();
        const preferredType = mod.type ?? (widget.chartType as ChartType | undefined);
        // SQL-first edit: a rewritten dynamicSql turns this into (or keeps it) a
        // dynamic-SQL widget. The data endpoint runs queryConfig.dynamicSql, so we
        // must replace it AND force metric/grouping to dynamic/query. The chart
        // type is taken verbatim from the requested/current type (skip the
        // vocabulary resolver, which would otherwise snap it to a preset).
        const hasNewSql =
          typeof mod.dynamicSql === 'string' && mod.dynamicSql.trim().length > 0;
        const nextType = hasNewSql
          ? (preferredType ?? (widget.chartType as ChartType))
          : resolveWidgetType(nextMetric, nextGrouping, preferredType);
        if (nextType !== widget.chartType) changes.chartType = nextType;
        if (hasNewSql) {
          nextConfig.dynamicSql = mod.dynamicSql!.trim();
          nextConfig.metric = 'dynamic';
          nextConfig.grouping = 'query';
          // Phase 3: keep the updated spec next to the SQL it compiled from.
          if (mod.spec) nextConfig.spec = mod.spec as unknown as Prisma.InputJsonValue;
        }
        if (!hasNewSql && typeof mod.metric === 'string' && mod.metric.trim()) {
          nextConfig.metric = mod.metric.trim();
        }
        if (!hasNewSql && typeof mod.grouping === 'string' && mod.grouping.trim()) {
          nextConfig.grouping = mod.grouping.trim();
        }
        if (mod.breakdown !== undefined) nextConfig.breakdown = mod.breakdown;
        if (mod.topN !== undefined) nextConfig.topN = mod.topN;
        if (mod.xAxisLabel !== undefined) nextConfig.xAxisLabel = mod.xAxisLabel;
        if (mod.yAxisLabel !== undefined) nextConfig.yAxisLabel = mod.yAxisLabel;
        if (mod.display !== undefined) {
          if (mod.display === null) {
            nextConfig.display = null;
          } else {
            const existingDisplay =
              existingConfig.display &&
              typeof existingConfig.display === 'object' &&
              !Array.isArray(existingConfig.display)
                ? (existingConfig.display as Record<string, unknown>)
                : {};
            nextConfig.display = {
              ...existingDisplay,
              ...mod.display,
            };
          }
        }
        if (JSON.stringify(nextConfig) !== JSON.stringify(existingConfig)) {
          changes.queryConfig = nextConfig as Prisma.InputJsonValue;
        }
        if (mod.description)
          changes.chartConfig = {
            description: mod.description,
          } as Prisma.InputJsonValue;
        if (Object.keys(changes).length > 0) {
          await tx.dashboardWidget.update({
            where: { id: widget.id },
            data: changes,
          });
        }
      }

      // Remove widgets
      if (removeIds.length > 0) {
        await tx.dashboardWidget.deleteMany({
          where: { id: { in: removeIds } },
        });
      }

      // Add new widgets at high display_order to avoid unique constraint conflicts
      const highBase = 9000;
      for (let i = 0; i < editPlan.add.length; i++) {
        const w = editPlan.add[i]!;
        await tx.dashboardWidget.create({
          data: {
            organizationId,
            dashboardId,
            title: w.title,
            chartType: w.type,
            queryConfig: {
              metric: w.metric,
              grouping: w.grouping,
              timeRange: existingRange,
              providerHint: existingProviderHint,
              clientName:
                (currentWidgets[0]?.queryConfig as any)?.clientName ?? null,
              orgId: nextOrgId,
              orgName: nextOrgName,
              breakdown: (w as any)?.breakdown ?? null,
              topN: (w as any)?.topN ?? null,
              xAxisLabel: (w as any)?.xAxisLabel ?? null,
              yAxisLabel: (w as any)?.yAxisLabel ?? null,
              display: (w as any)?.display ?? null,
              // SQL-first add: carry the live SQL so the data endpoint can run it.
              ...(typeof (w as any)?.dynamicSql === 'string' &&
              (w as any).dynamicSql.trim()
                ? { dynamicSql: (w as any).dynamicSql.trim() }
                : {}),
            } as Prisma.InputJsonValue,
            chartConfig: {
              description: w.description,
            } as Prisma.InputJsonValue,
            displayOrder: highBase + i,
          },
        });
      }

      // Re-fetch all remaining widgets sorted by current display_order (ascending)
      const remaining = await tx.dashboardWidget.findMany({
        where: { dashboardId },
        orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
      });

      // Assign sequential 0-based display_order
      // Processing in ascending order ensures no unique constraint conflicts
      // (each new value ≤ current value of that row OR the lower slots have been freed)
      for (let i = 0; i < remaining.length; i++) {
        if (remaining[i]!.displayOrder !== i) {
          await tx.dashboardWidget.update({
            where: { id: remaining[i]!.id },
            data: { displayOrder: i },
          });
        }
      }

      const dashboard = await tx.dashboard.update({
        where: { id: dashboardId },
        data: { lastSyncedAt: new Date() },
      });

      const widgetCount = await tx.dashboardWidget.count({
        where: { dashboardId },
      });
      return {
        id: dashboard.id,
        title: dashboard.title,
        widgetCount,
        widgets: remaining.map((widget) => ({
          id: widget.id,
          title: widget.title,
          chartType: widget.chartType,
          queryConfig: widget.queryConfig as Record<string, unknown>,
          chartConfig: widget.chartConfig as Record<string, unknown>,
          displayOrder: widget.displayOrder,
        })),
      };
    });
  }

  // ─── Tool Execution ───────────────────────────────────────────────────────

  private async executeTools(
    tools: string[],
    scope: OrgScope,
    spec: QuerySpec,
  ): Promise<ToolResult[]> {
    const validTools = [
      'revenue_trend',
      'entity_comparison',
      'invoice_breakdown',
      'venture_metrics',
      'financial_summary',
      'client_breakdown',
      'client_financial_profile',
    ];
    const toRun = [...new Set(tools.filter((t) => validTools.includes(t)))];

    const results = await Promise.allSettled(
      toRun.map((tool) => this.runTool(tool, scope, spec)),
    );

    return results.map((r, i) => ({
      tool: toRun[i]!,
      data:
        r.status === 'fulfilled' ? r.value : { error: 'Tool execution failed' },
      rowCount:
        r.status === 'fulfilled'
          ? Array.isArray(r.value)
            ? r.value.length
            : 1
          : 0,
    }));
  }

  private async runTool(
    tool: string,
    scope: OrgScope,
    spec: QuerySpec,
  ): Promise<unknown> {
    if (scope.connectionIds.length === 0)
      return {
        message: 'No active ERP connections — sync integrations first.',
      };
    const asOfIso = await this.resolveAsOfIso(scope);
    const asOfExpr =
      asOfIso && this.isStaleAsOf(asOfIso)
        ? `toDateTime('${asOfIso} 23:59:59')`
        : 'now()';
    const time = this.timeWhereOn('issued_at', spec.timeRange, asOfExpr);
    const provider = spec.providerHint
      ? `AND lowerUTF8(provider) = {provider:String}`
      : '';
    const client = spec.clientFilter
      ? `AND lowerUTF8(contact_name) = {clientName:String}`
      : '';
    const entity = spec.entityFilter ? `AND org_id = {orgId:String}` : '';
    // For Xero, prefer ACCREC, but do not exclude all rows if invoice_type wasn't ingested.
    const arFilter = `AND total_amount > 0 AND (provider != 'xero' OR invoice_type = '' OR lowerUTF8(invoice_type) = 'accrec')`;

    switch (tool) {
      case 'revenue_trend': {
        if (scope.externalOrgIds.length === 0) return [];
        return this.queryRows<any>(
          `SELECT
             formatDateTime(toStartOfMonth(issued_at), '%Y-%m') AS month,
             coalesce(sum(total_amount), 0) AS revenue,
             count() AS invoice_count
		           FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
		           WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})
		             ${provider}
		             ${client}
		             ${entity}
		             ${time}
		             ${arFilter}
		             AND issued_at IS NOT NULL
		           GROUP BY month ORDER BY month ASC LIMIT 18`,
          {
            tenantId: scope.tenantId,
            externalOrgIds: scope.externalOrgIds,
            ...(spec.providerHint ? { provider: spec.providerHint } : {}),
            ...(spec.clientFilter
              ? { clientName: spec.clientFilter.nameLower }
              : {}),
            ...(spec.entityFilter ? { orgId: spec.entityFilter.orgId } : {}),
          },
        );
      }

      case 'entity_comparison': {
        return this.queryRows<any>(
          `SELECT
             coalesce(org_name, org_id) AS entity_name,
             provider,
             coalesce(sum(total_amount), 0) AS total_revenue,
             count() AS invoice_count,
             any(currency) AS currency,
	             countIf(
	               due_at IS NOT NULL AND due_at < ${asOfExpr} AND lowerUTF8(status) IN ('authorised','sent','needtosend','notset','active','open')
	             ) AS overdue_count
		           FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
		           WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})
		             ${provider}
		             ${client}
		             ${entity}
		             ${time}
		             ${arFilter}
		             AND issued_at IS NOT NULL
		           GROUP BY org_name, org_id, provider ORDER BY total_revenue DESC`,
          {
            tenantId: scope.tenantId,
            externalOrgIds: scope.externalOrgIds,
            ...(spec.providerHint ? { provider: spec.providerHint } : {}),
            ...(spec.clientFilter
              ? { clientName: spec.clientFilter.nameLower }
              : {}),
            ...(spec.entityFilter ? { orgId: spec.entityFilter.orgId } : {}),
          },
        );
      }

      case 'invoice_breakdown': {
        return this.queryRows<any>(
          `SELECT
             status,
             count() AS invoice_count,
             coalesce(sum(total_amount), 0) AS status_total,
             coalesce(avg(total_amount), 0) AS avg_amount,
             coalesce(max(total_amount), 0) AS max_amount
		           FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
		           WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})
		             ${provider}
		             ${client}
		             ${entity}
		             ${time}
		             ${arFilter}
		             AND issued_at IS NOT NULL
		           GROUP BY status ORDER BY status_total DESC LIMIT 15`,
          {
            tenantId: scope.tenantId,
            externalOrgIds: scope.externalOrgIds,
            ...(spec.providerHint ? { provider: spec.providerHint } : {}),
            ...(spec.clientFilter
              ? { clientName: spec.clientFilter.nameLower }
              : {}),
            ...(spec.entityFilter ? { orgId: spec.entityFilter.orgId } : {}),
          },
        );
      }

      case 'venture_metrics': {
        const rows = await this.queryRows<any>(
          `SELECT
             coalesce(sum(total_amount), 0) AS total_revenue,
             coalesce(sumIf(total_amount, lowerUTF8(status) NOT IN ('paid','closed')), 0) AS open_ar,
             coalesce(sumIf(abs(total_amount), total_amount < 0), 0) AS total_outflow,
             count(DISTINCT toStartOfMonth(issued_at)) AS active_months
		           FROM ${this.analyticsDb}.fact_accounting_invoices
		           WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})
		             ${provider}
		             ${client}
		             ${entity}
		             ${time}`,
          {
            tenantId: scope.tenantId,
            externalOrgIds: scope.externalOrgIds,
            ...(spec.providerHint ? { provider: spec.providerHint } : {}),
            ...(spec.clientFilter
              ? { clientName: spec.clientFilter.nameLower }
              : {}),
            ...(spec.entityFilter ? { orgId: spec.entityFilter.orgId } : {}),
          },
        );
        const r = rows[0] ?? {};
        const revenue = this.num(r.total_revenue);
        const outflow = this.num(r.total_outflow);
        const months = this.num(r.active_months) || 1;
        const monthlyBurn = outflow / months;
        return {
          totalRevenue: revenue,
          totalOutflow: outflow,
          openAR: this.num(r.open_ar),
          estimatedMonthlyBurn: Math.round(monthlyBurn),
          cashOnHand: revenue - outflow,
          runwayMonths:
            monthlyBurn > 0 ? Math.round((revenue / monthlyBurn) * 10) / 10 : 0,
          efficiencyRatio:
            monthlyBurn > 0
              ? Math.round((revenue / monthlyBurn) * 100) / 100
              : 0,
          activeMonths: months,
        };
      }

      case 'financial_summary': {
        const rows = await this.queryRows<any>(
          `WITH invoices AS (
             SELECT
               invoice_external_id,
               toDecimal64(total_amount, 4) AS total_amount,
               issued_at,
               due_at,
               provider,
               org_id
	             FROM ${this.analyticsDb}.fact_accounting_invoices
	             WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})
	               ${provider}
	               ${client}
	               ${entity}
	               ${time}
               ${arFilter}
               AND issued_at IS NOT NULL
               AND invoice_external_id != ''
           ),
           paid AS (
             SELECT
               invoice_external_id,
               sum(amount) AS paid_to_date
	             FROM ${this.analyticsDb}.fact_accounting_payment_applications
	             WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})
	               AND payment_at IS NOT NULL
	               AND payment_at <= ${asOfExpr}
	               AND invoice_external_id != ''
	             GROUP BY invoice_external_id
           ),
           per_invoice AS (
             SELECT
               i.*,
               greatest(i.total_amount - ifNull(p.paid_to_date, toDecimal64(0, 4)), toDecimal64(0, 4)) AS balance
             FROM invoices i
             LEFT JOIN paid p ON p.invoice_external_id = i.invoice_external_id
           )
           SELECT
             count() AS total_invoices,
             coalesce(sum(toFloat64(total_amount)), 0) AS total_revenue,
             coalesce(avg(toFloat64(total_amount)), 0) AS avg_invoice,
             coalesce(max(toFloat64(total_amount)), 0) AS max_invoice,
             coalesce(min(toFloat64(total_amount)), 0) AS min_invoice,
             coalesce(sumIf(toFloat64(balance), due_at IS NOT NULL AND due_at < now()), 0) AS overdue_amount,
             countIf(due_at IS NOT NULL AND due_at < now() AND balance > 0) AS overdue_count,
             count(DISTINCT provider) AS provider_count,
             count(DISTINCT org_id) AS entity_count
           FROM per_invoice`,
          {
            tenantId: scope.tenantId,
            externalOrgIds: scope.externalOrgIds,
            ...(spec.providerHint ? { provider: spec.providerHint } : {}),
            ...(spec.clientFilter
              ? { clientName: spec.clientFilter.nameLower }
              : {}),
            ...(spec.entityFilter ? { orgId: spec.entityFilter.orgId } : {}),
          },
        );
        return rows[0] ?? {};
      }

      case 'client_breakdown': {
        if (scope.externalOrgIds.length === 0) return [];
        if (time.trim()) {
          return this.queryRows<any>(
            `SELECT
               coalesce(nullIf(contact_name, ''), 'Unknown') AS client_name,
               coalesce(sumIf(total_amount, lowerUTF8(status) IN ('paid','voided','closed','active','open')), 0) AS revenue,
               count() AS invoice_count,
               countIf(lowerUTF8(status) = 'overdue') AS overdue_count,
               any(currency) AS currency
		             FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
		             WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})
		               ${provider}
		               ${client}
		               ${entity}
		               ${time}
		               ${arFilter}
		             GROUP BY client_name
		             ORDER BY revenue DESC LIMIT 20`,
            {
              tenantId: scope.tenantId,
              externalOrgIds: scope.externalOrgIds,
              ...(spec.providerHint ? { provider: spec.providerHint } : {}),
              ...(spec.clientFilter
                ? { clientName: spec.clientFilter.nameLower }
                : {}),
              ...(spec.entityFilter ? { orgId: spec.entityFilter.orgId } : {}),
            },
          );
        }
        return this.queryRows<any>(
          `SELECT
             coalesce(nullIf(client_name, ''), 'Unknown') AS client_name,
             client_id,
             total_revenue      AS revenue,
             invoice_count,
             overdue_count,
             currency
		           FROM ${this.analyticsDb}.v_dim_clients_latest
		           WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})
		             AND client_name != ''
		             ${spec.entityFilter ? `AND org_id = {orgId:String}` : ''}
		             ${spec.clientFilter ? `AND lowerUTF8(client_name) = {clientName:String}` : ''}
		           ORDER BY total_revenue DESC LIMIT 20`,
          {
            tenantId: scope.tenantId,
            externalOrgIds: scope.externalOrgIds,
            ...(spec.clientFilter
              ? { clientName: spec.clientFilter.nameLower }
              : {}),
            ...(spec.entityFilter ? { orgId: spec.entityFilter.orgId } : {}),
          },
        );
      }

      case 'client_financial_profile': {
        // Full per-client financial picture from the gold table.
        // The agent uses this data for comparisons, summaries, and pattern detection.
        if (scope.externalOrgIds.length === 0) return [];
        if (time.trim()) {
          return this.queryRows<any>(
            `SELECT
               coalesce(nullIf(contact_name, ''), 'Unknown') AS client_name,
               coalesce(nullIf(org_name, ''), org_id) AS org_name,
               any(provider) AS billing_provider,
               any(currency) AS currency,
               coalesce(sum(abs(total_amount)), 0) AS total_invoiced,
               coalesce(sumIf(total_amount, lowerUTF8(status) IN ('paid','voided','closed','active','open')), 0) AS total_revenue,
	               coalesce(sumIf(total_amount,
	                 lowerUTF8(status) IN ('authorised','sent','needtosend','notset')
	                 AND (due_at IS NULL OR due_at >= ${asOfExpr})), 0) AS total_outstanding,
	               coalesce(sumIf(total_amount,
	                 lowerUTF8(status) IN ('authorised','sent','needtosend','notset')
	                 AND due_at IS NOT NULL AND due_at < ${asOfExpr}), 0) AS total_overdue,
               count() AS invoice_count,
               countIf(lowerUTF8(status) IN ('paid','voided','closed','active','open')) AS paid_count,
	               countIf(lowerUTF8(status) IN ('authorised','sent','needtosend','notset')
	                 AND (due_at IS NULL OR due_at >= ${asOfExpr})) AS outstanding_count,
	               countIf(lowerUTF8(status) IN ('authorised','sent','needtosend','notset')
	                 AND due_at IS NOT NULL AND due_at < ${asOfExpr}) AS overdue_count,
               countIf(lowerUTF8(status) = 'draft') AS draft_count,
               round(avg(abs(total_amount)), 2) AS avg_invoice_amount,
               formatDateTime(min(issued_at), '%Y-%m-%d') AS first_invoice_date,
               formatDateTime(max(issued_at), '%Y-%m-%d') AS last_invoice_date,
               if(total_invoiced > 0,
                 round(total_revenue / total_invoiced * 100, 1), 0) AS collection_rate_pct,
               if(total_invoiced > 0,
                 round(total_overdue / total_invoiced * 100, 1), 0) AS overdue_rate_pct
	             FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
	             WHERE org_id IN ({externalOrgIds:Array(String)})
	               ${provider}
	               ${client}
	               ${entity}
	               ${time}
	               ${arFilter}
             GROUP BY client_name, org_name, org_id
             HAVING client_name != ''
             ORDER BY total_revenue DESC LIMIT 50`,
            {
              tenantId: scope.tenantId,
              externalOrgIds: scope.externalOrgIds,
              ...(spec.providerHint ? { provider: spec.providerHint } : {}),
              ...(spec.clientFilter
                ? { clientName: spec.clientFilter.nameLower }
                : {}),
              ...(spec.entityFilter ? { orgId: spec.entityFilter.orgId } : {}),
            },
          );
        }
        return this.queryRows<any>(
          `SELECT
             coalesce(nullIf(client_name, ''), 'Unknown') AS client_name,
             client_id,
             org_name,
             provider,
             currency,
             -- Billing breakdown
             total_invoiced,
             total_revenue,
             total_outstanding,
             total_overdue,
             -- Volume
             invoice_count,
             paid_count,
             outstanding_count,
             overdue_count,
             draft_count,
             -- Averages & dates
             round(avg_invoice_amount, 2)                              AS avg_invoice_amount,
             formatDateTime(first_invoice_date, '%Y-%m-%d')           AS first_invoice_date,
             formatDateTime(last_invoice_date,  '%Y-%m-%d')           AS last_invoice_date,
             -- Derived health metrics
             if(total_invoiced > 0,
               round(total_revenue / total_invoiced * 100, 1), 0)     AS collection_rate_pct,
             if(total_invoiced > 0,
               round(total_overdue / total_invoiced * 100, 1), 0)     AS overdue_rate_pct
		           FROM ${this.analyticsDb}.v_dim_clients_latest
		           WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)})
		             AND client_name != ''
		             ${spec.entityFilter ? `AND org_id = {orgId:String}` : ''}
		             ${spec.clientFilter ? `AND lowerUTF8(client_name) = {clientName:String}` : ''}
		           ORDER BY total_invoiced DESC LIMIT 50`,
          {
            tenantId: scope.tenantId,
            externalOrgIds: scope.externalOrgIds,
            ...(spec.clientFilter
              ? { clientName: spec.clientFilter.nameLower }
              : {}),
            ...(spec.entityFilter ? { orgId: spec.entityFilter.orgId } : {}),
          },
        );
      }

      default:
        return { error: `Unknown tool: ${tool}` };
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async getOrgScope(
    organizationId: string,
    role: MembershipRole,
    orgId?: string,
  ): Promise<OrgScope> {
    const conns = await this.prisma.erpConnection.findMany({
      where: { organizationId, status: 'ACTIVE' },
      select: { id: true, externalOrganizationId: true },
    });

    const allExternal = conns
      .map((c) => c.externalOrganizationId)
      .filter((v): v is string => Boolean(v));
    const allConnectionIds = conns.map((c) => c.id);
    const all: OrgScope = {
      tenantId: organizationId,
      connectionIds: allConnectionIds,
      externalOrgIds: allExternal,
    };

    // If an explicit orgId scope is provided, always honor it (even for admins).
    if (orgId && allExternal.includes(orgId)) {
      const filteredConnectionIds = conns
        .filter((c) => c.externalOrganizationId === orgId)
        .map((c) => c.id);
      return {
        tenantId: organizationId,
        connectionIds: filteredConnectionIds,
        externalOrgIds: [orgId],
      };
    }

    // Admins can mix entities; members must be entity-scoped (single org_id at a time).
    if (role === 'ADMIN') return all;

    const target = allExternal.length === 1 ? allExternal[0] : null;
    if (!target) return all;

    const filteredConnectionIds = conns
      .filter((c) => c.externalOrganizationId === target)
      .map((c) => c.id);
    return {
      tenantId: organizationId,
      connectionIds: filteredConnectionIds,
      externalOrgIds: [target],
    };
  }

  private async queryRows<T>(
    query: string,
    params: Record<string, unknown>,
  ): Promise<T[]> {
    await this.ensureAnalyticsSchema();
    try {
      const result = await this.clickhouse.query({
        query,
        query_params: params,
        format: 'JSONEachRow',
        clickhouse_settings: SAFE_QUERY,
      });
      return (await result.json()) as T[];
    } catch (err: any) {
      // Some deployments still have MergeTree tables, where FINAL is illegal.
      // Retry once with FINAL stripped to avoid hard failures.
      const code = err?.code ?? err?.cause?.code;
      const message = String(err?.message ?? err?.cause?.message ?? '');
      // If schema creation raced or previously failed, retry once after re-ensuring.
      if (
        code === '60' ||
        /unknown table expression identifier/i.test(message) ||
        /unknown table/i.test(message)
      ) {
        await this.ensureAnalyticsSchema();
        const result = await this.clickhouse.query({
          query,
          query_params: params,
          format: 'JSONEachRow',
          clickhouse_settings: SAFE_QUERY,
        });
        return (await result.json()) as T[];
      }
      if (code === '181' || /doesn'?t support FINAL/i.test(message)) {
        const stripped = query.replace(/\s+FINAL\b/gi, '');
        const result = await this.clickhouse.query({
          query: stripped,
          query_params: params,
          format: 'JSONEachRow',
          clickhouse_settings: SAFE_QUERY,
        });
        return (await result.json()) as T[];
      }
      throw err;
    }
  }

  private num(v: unknown): number {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  }

  private toolLabel(tool: string): string {
    const labels: Record<string, string> = {
      revenue_trend: 'Revenue Trend Analysis',
      entity_comparison: 'Entity Performance Comparison',
      invoice_breakdown: 'Invoice Portfolio Analysis',
      venture_metrics: 'Venture Health Metrics',
      financial_summary: 'Financial Summary',
      client_breakdown: 'Client Revenue Analysis',
      client_financial_profile: 'Client Financial Intelligence',
    };
    return labels[tool] ?? tool;
  }

  // ─── Dynamic SQL Generation ────────────────────────────────────────────────

  private async generateDynamicSql(
    intent: string,
    title: string,
    scope: OrgScope,
    range?: TimeRange,
  ): Promise<string> {
    const timeHint = range
      ? `Time filter requested: ${JSON.stringify(range)}`
      : 'No specific time filter — use all available data';

    const userPrompt = `Chart title: "${title}"
Financial question: ${intent}
${timeHint}
Tenant in scope: ${scope.tenantId} (always filter tenant_id = {tenantId:String})
Org IDs in scope: ${scope.externalOrgIds.slice(0, 3).join(', ')} (always filter org_id IN ({externalOrgIds:Array(String)}))

Write ONE ClickHouse SELECT query that answers this question. Output SQL only.`;

    const body = {
      model: this.OLLAMA_MODEL,
      messages: [
        { role: 'system', content: DYNAMIC_SQL_SYSTEM },
        { role: 'user', content: userPrompt },
      ],
      stream: false,
      options: { temperature: 0, num_predict: 600 },
    };

    const res = await fetch(`${this.OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const json = (await res.json()) as any;
    const raw = (json.message?.content ?? '')
      .replace(/```sql|```/gi, '')
      .trim();

    if (!raw) throw new Error('LLM returned empty SQL');
    return this.validateAndScopeDynamicSql(raw, scope);
  }

  private async generateDynamicMetricSql(
    metric: string,
    grouping: string,
    scope: OrgScope,
    range?: TimeRange,
  ): Promise<string | null> {
    const timeHint = range
      ? `Time filter requested: ${JSON.stringify(range)}`
      : 'No specific time filter — use all available data';

    const userPrompt = `Metric: "${metric}", Grouping: "${grouping}"
${timeHint}
Tenant in scope: ${scope.tenantId} (always filter tenant_id = {tenantId:String})
Org IDs in scope: ${scope.externalOrgIds.slice(0, 3).join(', ')} (always filter org_id IN ({externalOrgIds:Array(String)}))

Write ONE ClickHouse SELECT query that answers this financial metric question.
Return columns named "name" (dimension label string) and "value" (numeric metric).
For multi-series data, add extra numeric columns per series.
Output SQL ONLY — no explanation, no markdown.`;

    try {
      const body = {
        model: this.OLLAMA_MODEL,
        messages: [
          { role: 'system', content: DYNAMIC_SQL_SYSTEM },
          { role: 'user', content: userPrompt },
        ],
        stream: false,
        options: { temperature: 0, num_predict: 600 },
      };

      const res = await fetch(`${this.OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) return null;

      const json = (await res.json()) as any;
      const raw = (json.message?.content ?? '')
        .replace(/```sql|```/gi, '')
        .trim();
      if (!raw || !/^\s*SELECT\b/i.test(raw)) return null;
      if (/\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE)\b/i.test(raw))
        return null;
      if (!/\bLIMIT\s+\d+/i.test(raw)) return null;
      if (!/{externalOrgIds\s*:\s*Array\s*\(\s*String\s*\)}/i.test(raw))
        return null;
      if (!/{tenantId\s*:\s*String}/i.test(raw)) return null;

      return raw.trim().replace(/;+$/, '').trim();
    } catch (err: any) {
      this.logger.warn(
        `[Agent:DynamicMetricSql] LLM call failed: ${err.message}`,
      );
      return null;
    }
  }

  /**
   * Maps natural-language query text to a widget spec deterministically,
   * bypassing the Ollama LLM which is unreliable for structured routing.
   * Covers all 60+ canonical query patterns across 5 dashboard categories.
   */
  private preRouteQuery(
    query: string,
  ): Array<{
    type: string;
    metric: string;
    grouping: string;
    title: string;
  }> | null {
    const q = query.toLowerCase();

    // ── Chart-type signals ───────────────────────────────────────────────────
    const isStackedArea = /stacked.area/.test(q);
    const isStacked = /stacked|clustered/.test(q);
    const isDonut = /\bdonut\b/.test(q);
    const isWaterfall = /\bwaterfall\b/.test(q);
    const isHBar = /horizontal.bar|ranked.bar|ranked.horizontal/.test(q);
    const isTreemap = /\btreemap\b/.test(q);
    const isHeatmap = /\bheat\s*map\b|\bheatmap\b/.test(q);
    const isMatrix = /\bmatrix\b/.test(q);
    const isPareto = /\bpareto\b/.test(q);
    const isScatter = /\bscatter\b/.test(q);
    const isBubble = /\bbubble\b/.test(q);
    const isPie = /\bpie\b/.test(q);
    const isTable = /\btable\b|\branked table\b/.test(q);
    const isLine = /\bline\b|multi.?line/.test(q);
    const isBar = /\bbar\b|\bcolumn\b|\bbargraph\b/.test(q);

    // ── Content signals ──────────────────────────────────────────────────────
    // NOTE: keep signals specific — broad patterns here prevent Ollama from
    // handling novel queries. Only catch unambiguous intent.
    const hasDept =
      /\bdepartments?\b|\badmin\s+depart|\boperations\s+depart|\bsales\s+depart|\bby\s+department\b|\bper\s+department\b/.test(
        q,
      );
    const hasTime =
      /\bmonths?\b|trend|over.time|across.year|each.month|per.month|cumulat|growth/.test(
        q,
      );
    const hasVendor = /\bvendors?\b|\bsuppliers?\b/.test(q);
    const hasTransactionCount =
      /\btransaction\s+counts?\b|\btransactions?\s+per\b|\bnumber\s+of\s+transactions?\b|\btransaction\s+volume\b|\bactivity\b/.test(
        q,
      );
    const hasClass =
      /\bby\s+class\b|\bclass\s+breakdown\b|\bclass\s+split\b|\bgeneral.*marketing.*product\b|\bexpense\s+class\b/.test(
        q,
      );
    const hasRevenueCat =
      /income.source|revenue.categor|revenue.account|revenue.breakdown|revenue.split|sources.of.revenue|where.*revenue.*com/.test(
        q,
      );
    const hasExpense = /\bexpense\b|\bspend\b/.test(q);
    const hasAccountType = /account.types?|by.account.type/.test(q);
    const hasDebitCredit = /debits?.*credits?|credits?.*debits?/.test(q);
    const hasAsset = /\bassets?\b/.test(q);
    const hasLiability = /\bliabilit/.test(q);
    const hasEquity =
      /\bequity\b|\bowner.s.equity\b|\bretained.earnings?\b/.test(q);
    const hasGrossProfit = /gross.profit/.test(q);
    const hasNetMargin = /net.margin|margin.percent/.test(q);
    const hasExpenseRatio = /expense.ratio/.test(q);
    const hasNetPosition =
      /debit.*minus.*credit|debits.minus.credits|net.position|balance.trend|total.debit.*total.credit/.test(
        q,
      );
    const hasPLFlow =
      /revenue.*gross.profit|flows.into|revenue.*net.income/.test(q);
    const hasVsRevenue =
      /versus.revenue|vs.revenue|compared.to.revenue|spend.vs.revenue|revenue.generated/.test(
        q,
      );
    const hasAccount =
      /\bby\s+account\b|\baccount\s+name\b|\bper\s+account\b/.test(q) &&
      !hasAccountType;
    const hasBalanceSheet = /balance.sheet|financial.position|net.worth/.test(
      q,
    );
    const hasTotalAssets = /total.assets?|assets?.total/.test(q);
    const hasTotalLiab = /total.liabilit|liabilit.total/.test(q);
    const hasNetIncome = /\bnet.income\b|\bnet.profit\b|\bbottom.line\b/.test(
      q,
    );
    const hasTrialBalance = /trial.balance/.test(q);
    const hasGLDump = /\bgl.dump\b|\bgeneral.ledger.dump\b|\bgl.entries\b/.test(
      q,
    );
    const hasExecutiveDashboardIntent =
      /\b(dashboard|report|overview|summary|scorecard|board\s+pack|pack|suite)\b/.test(q) &&
      /\b(cfo|executive|financial\s+position|operating\s+performance|profitability|liquidity|cash\s+position|financial\s+health|balance\s+sheet|p&l|income\s+statement|net\s+income)\b/.test(q);

    if (hasExecutiveDashboardIntent)
      return [
        {
          type: 'kpi',
          metric: 'summary',
          grouping: 'overview',
          title: 'Executive KPIs',
        },
        {
          type: 'bar',
          metric: 'balance_sheet',
          grouping: 'summary',
          title: 'Balance Sheet Position',
        },
        {
          type: 'waterfall',
          metric: 'pl',
          grouping: 'summary',
          title: 'P&L Waterfall — Revenue to Net Income',
        },
        {
          type: 'line',
          metric: 'net_income',
          grouping: 'month',
          title: 'Net Income Trend',
        },
        {
          type: 'bar',
          metric: 'expense',
          grouping: 'account',
          title: 'Top Expense Accounts',
        },
        {
          type: 'bar',
          metric: 'revenue',
          grouping: 'account',
          title: 'Revenue by Account',
        },
      ];

    // ═══════════════════════════════════════════════════════════════════════════
    // WATERFALL — highest priority (explicit chart type)
    // ═══════════════════════════════════════════════════════════════════════════
    if (isWaterfall)
      return [
        {
          type: 'waterfall',
          metric: 'pl',
          grouping: 'summary',
          title: 'P&L Waterfall — Revenue to Net Income',
        },
      ];

    // ═══════════════════════════════════════════════════════════════════════════
    // TRIAL BALANCE / GL DUMP — direct table queries
    // ═══════════════════════════════════════════════════════════════════════════
    if (hasTrialBalance)
      return [
        {
          type: 'table',
          metric: 'trial_balance',
          grouping: 'summary',
          title: 'Trial Balance — All Accounts',
        },
      ];
    if (hasGLDump)
      return [
        {
          type: 'table',
          metric: 'gl_dump',
          grouping: 'detail',
          title: 'General Ledger — All Transactions',
        },
      ];

    // ═══════════════════════════════════════════════════════════════════════════
    // BALANCE SHEET queries (total assets / liabilities / equity)
    // ═══════════════════════════════════════════════════════════════════════════
    if (hasBalanceSheet)
      return [
        {
          type: isDonut ? 'donut' : 'bar',
          metric: 'balance_sheet',
          grouping: 'summary',
          title: 'Balance Sheet — Assets, Liabilities & Equity',
        },
      ];
    if (hasTotalAssets)
      return [
        {
          type: isDonut ? 'donut' : isHBar ? 'horizontal_bar' : 'bar',
          metric: 'assets',
          grouping: 'breakdown',
          title: 'Asset Breakdown by Account',
        },
      ];
    if (hasTotalLiab)
      return [
        {
          type: isDonut ? 'donut' : isHBar ? 'horizontal_bar' : 'bar',
          metric: 'liabilities',
          grouping: 'breakdown',
          title: 'Liability Breakdown by Account',
        },
      ];
    if (hasEquity && !hasExpense)
      return [
        {
          type: isDonut ? 'donut' : 'bar',
          metric: 'equity',
          grouping: 'breakdown',
          title: 'Equity Accounts Breakdown',
        },
      ];

    // ═══════════════════════════════════════════════════════════════════════════
    // NET INCOME — from trial balance (authoritative)
    // ═══════════════════════════════════════════════════════════════════════════
    if (hasNetIncome && !hasTime)
      return [
        {
          type: 'metric',
          metric: 'pl_summary',
          grouping: 'summary',
          title: 'P&L KPI Summary — Revenue, Gross Profit, Net Income',
        },
      ];

    // ═══════════════════════════════════════════════════════════════════════════
    // VENDOR queries
    // ═══════════════════════════════════════════════════════════════════════════
    if (hasVendor) {
      if (hasTransactionCount && hasTime)
        return [
          {
            type: isMatrix ? 'matrix' : isStacked ? 'stacked_bar' : isLine ? 'line' : 'heatmap',
            metric: 'vendor_count',
            grouping: 'month_vendor',
            title: 'Vendor Transaction Activity by Month',
          },
        ];
      if (hasTransactionCount && !isScatter && !isBubble && !hasTime)
        return [
          {
            type: isHBar ? 'horizontal_bar' : 'bar',
            metric: 'vendor_count',
            grouping: 'vendor',
            title: 'Transaction Count per Vendor',
          },
        ];
      if (isMatrix && hasDept)
        return [
          {
            type: 'matrix',
            metric: 'expense',
            grouping: 'department_vendor',
            title: 'Department by Vendor Spend Matrix',
          },
        ];
      if (isBubble)
        return [
          {
            type: 'bubble',
            metric: 'vendor_transactions',
            grouping: 'vendor',
            title: 'Vendors — Spend vs Transactions vs Avg Invoice',
          },
        ];
      if (isPareto)
        return [
          {
            type: 'pareto',
            metric: 'expense',
            grouping: 'vendor',
            title: 'Pareto — Vendor Spend Concentration',
          },
        ];
      if (isTable)
        return [
          {
            type: 'table',
            metric: 'expense',
            grouping: 'vendor',
            title: 'Vendor Spend — Ranked Table with % Contribution',
          },
        ];
      if (isScatter)
        return [
          {
            type: 'scatter',
            metric: 'expense',
            grouping: 'vendor',
            title: 'Vendor Spend vs Transaction Count',
          },
        ];
      if (isTreemap)
        return [
          {
            type: 'treemap',
            metric: 'expense',
            grouping: 'vendor',
            title: 'Vendor Contribution to Operating Expenses',
          },
        ];
      if (isDonut)
        return [
          {
            type: 'donut',
            metric: 'expense',
            grouping: 'vendor',
            title: 'Spend Share by Vendor',
          },
        ];
      if (isPie)
        return [
          {
            type: 'pie',
            metric: 'expense',
            grouping: 'vendor',
            title: 'Spend Share by Vendor',
          },
        ];
      if (isStacked && hasTime)
        return [
          {
            type: 'stacked_bar',
            metric: 'expense',
            grouping: 'month_vendor',
            title: 'Monthly Vendor Spend — Stacked',
          },
        ];
      if (isBar && hasTime)
        return [
          {
            type: 'stacked_bar',
            metric: 'expense',
            grouping: 'month_vendor',
            title: 'Top Vendors — Monthly Spend (Bar)',
          },
        ];
      if (hasTime || isLine)
        return [
          {
            type: 'line',
            metric: 'expense',
            grouping: 'month_vendor',
            title: 'Vendor Spend Trend Over Time',
          },
        ];
      if (isHBar)
        return [
          {
            type: 'horizontal_bar',
            metric: 'expense',
            grouping: 'vendor',
            title: 'Vendor Spend Breakdown — Ranked',
          },
        ];
      return [
        {
          type: 'bar',
          metric: 'expense',
          grouping: 'vendor',
          title: 'Top 10 Vendors by Total Spend',
        },
      ];
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DEPARTMENT queries
    // ═══════════════════════════════════════════════════════════════════════════
    if (hasDept) {
      // "scatter of expense vs revenue" → let LLM generate proper x=expense, y=revenue SQL
      if (isScatter && hasVsRevenue) return null;
      if (isHeatmap && hasTime)
        return [
          {
            type: 'heatmap',
            metric: 'expense',
            grouping: 'month_department',
            title: 'Department Spend Heatmap by Month',
          },
        ];
      if (isHeatmap && hasClass)
        return [
          {
            type: 'heatmap',
            metric: 'expense',
            grouping: 'department_class',
            title: 'Department Spend Heatmap by Class',
          },
        ];
      if (isScatter)
        return [
          {
            type: 'scatter',
            metric: 'expense',
            grouping: 'dept_stats',
            title: 'Departments — Spend vs Vendors vs Transactions',
          },
        ];
      if (hasVsRevenue)
        return [
          {
            type: 'stacked_bar',
            metric: 'revenue_vs_expense',
            grouping: 'department',
            title: 'Department Spend vs Revenue Generated',
          },
        ];
      if (isStackedArea)
        return [
          {
            type: 'area',
            metric: 'expense',
            grouping: 'month_department',
            title: 'Cumulative Departmental Spend Across the Year',
          },
        ];
      if ((isStacked || isBar) && hasTime)
        return [
          {
            type: 'stacked_bar',
            metric: 'expense',
            grouping: 'month_department',
            title: 'Monthly Spend by Department — Stacked',
          },
        ];
      if (isMatrix && hasVendor)
        return [
          {
            type: 'matrix',
            metric: 'expense',
            grouping: 'department_vendor',
            title: 'Department by Vendor Spend Matrix',
          },
        ];
      if ((isLine || hasTime) && !isStacked && !isBar)
        return [
          {
            type: 'line',
            metric: 'expense',
            grouping: 'month_department',
            title: 'Monthly Spend Trends — Admin, Operations, Sales',
          },
        ];
      if (isStacked)
        return [
          {
            type: 'stacked_bar',
            metric: 'expense',
            grouping: 'month_department',
            title: 'Monthly Department Spend vs Company Total',
          },
        ];
      if (isDonut)
        return [
          {
            type: 'donut',
            metric: 'expense',
            grouping: 'department',
            title: 'Spend Contribution by Department',
          },
        ];
      if (isPie)
        return [
          {
            type: 'pie',
            metric: 'expense',
            grouping: 'department',
            title: 'Department Share of Annual Operating Spend',
          },
        ];
      if (hasClass)
        return [
          {
            type: 'stacked_bar',
            metric: 'expense',
            grouping: 'dept_class',
            title: 'Department Spend by Class',
          },
        ];
      if (isHBar)
        return [
          {
            type: 'horizontal_bar',
            metric: 'expense',
            grouping: 'department',
            title: 'Top Departments by Operating Cost',
          },
        ];
      return [
        {
          type: 'bar',
          metric: 'expense',
          grouping: 'department',
          title: 'Monthly Spend Across All Departments',
        },
      ];
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CLASS queries (General / Marketing / Product)
    // ═══════════════════════════════════════════════════════════════════════════
    if (hasClass) {
      if (isHeatmap && hasDept)
        return [
          {
            type: 'heatmap',
            metric: 'expense',
            grouping: 'department_class',
            title: 'Department Spend Heatmap by Class',
          },
        ];
      if (isStacked && hasTime)
        return [
          {
            type: 'stacked_bar',
            metric: 'expense',
            grouping: 'month_class',
            title: 'Monthly Spend by Expense Class',
          },
        ];
      if (hasTime || isLine)
        return [
          {
            type: 'line',
            metric: 'expense',
            grouping: 'month_class',
            title: 'Monthly Spend Trend by Class',
          },
        ];
      if (isDonut)
        return [
          {
            type: 'donut',
            metric: 'expense',
            grouping: 'class',
            title: 'Spend Distribution by Class',
          },
        ];
      if (isPie)
        return [
          {
            type: 'pie',
            metric: 'expense',
            grouping: 'class',
            title: 'Proportion of General, Marketing, Product Expenses',
          },
        ];
      return [
        {
          type: 'bar',
          metric: 'expense',
          grouping: 'class',
          title: 'Total Spend by Class',
        },
      ];
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // REVENUE / INCOME queries
    // ═══════════════════════════════════════════════════════════════════════════
    if (hasRevenueCat)
      return [
        {
          type: isHBar ? 'horizontal_bar' : 'bar',
          metric: 'revenue',
          grouping: 'account',
          title: 'Income Sources by Revenue Category',
        },
      ];

    if (hasGrossProfit)
      return [
        {
          type: 'line',
          metric: 'gross_profit',
          grouping: 'month',
          title: 'Monthly Gross Profit Trend',
        },
      ];
    if (hasNetMargin)
      return [
        {
          type: 'line',
          metric: 'net_margin',
          grouping: 'month',
          title: 'Monthly Net Margin %',
        },
      ];
    if (hasExpenseRatio)
      return [
        {
          type: 'line',
          metric: 'expense_ratio',
          grouping: 'month',
          title: 'Expense Ratio % Across the Year',
        },
      ];
    if (hasNetPosition)
      return [
        {
          type: 'line',
          metric: 'net_position',
          grouping: 'month',
          title: 'Monthly Balance — Debits Minus Credits',
        },
      ];

    // ═══════════════════════════════════════════════════════════════════════════
    // ASSET / LIABILITY queries (Balance Sheet) — from sample_trial_balance
    // ═══════════════════════════════════════════════════════════════════════════
    if (hasAsset && !hasExpense)
      return [
        {
          type: isDonut ? 'donut' : isHBar ? 'horizontal_bar' : 'bar',
          metric: 'assets',
          grouping: 'breakdown',
          title: 'Asset Breakdown — Bank, AR, Fixed Assets',
        },
      ];

    if (hasLiability)
      return [
        {
          type: isDonut ? 'donut' : isHBar ? 'horizontal_bar' : 'bar',
          metric: 'liabilities',
          grouping: 'breakdown',
          title: 'Liability Breakdown — AP, Current & Long-Term',
        },
      ];

    // ═══════════════════════════════════════════════════════════════════════════
    // DEBIT / CREDIT / ACCOUNT TYPE queries
    // ═══════════════════════════════════════════════════════════════════════════
    if (hasDebitCredit || hasAccountType) {
      if (isTreemap)
        return [
          {
            type: 'treemap',
            metric: 'accounts',
            grouping: 'account_type',
            title: 'Account Type Contribution to Total Balance',
          },
        ];
      if (isScatter)
        return [
          {
            type: 'scatter',
            metric: 'debits_credits',
            grouping: 'account',
            title: 'Account Activity — Debit vs Credit',
          },
        ];
      if (isStacked)
        return [
          {
            type: 'stacked_bar',
            metric: 'debits_credits',
            grouping: 'month',
            title: 'Monthly Debits and Credits by Account Type',
          },
        ];
      if (isPie)
        return [
          {
            type: 'pie',
            metric: 'debits_credits',
            grouping: 'account_type',
            title: 'Total Balance by Account Type',
          },
        ];
      if (isDonut)
        return [
          {
            type: 'donut',
            metric: 'debits_credits',
            grouping: 'account_type',
            title: 'Balance by Account Type',
          },
        ];
      if (/top.*debit|debit.*top|debit.balanc/.test(q))
        return [
          {
            type: 'bar',
            metric: 'debits',
            grouping: 'account_type',
            title: 'Top Account Types by Debit Balance',
          },
        ];
      if (/top.*credit|credit.*top|credit.balanc/.test(q))
        return [
          {
            type: 'bar',
            metric: 'credits',
            grouping: 'account_type',
            title: 'Top Account Types by Credit Balance',
          },
        ];
      return [
        {
          type: 'bar',
          metric: 'debits_credits',
          grouping: 'account_type',
          title: 'Debit vs Credit Amounts by Account Type',
        },
      ];
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EXPENSE / ACCOUNT NAME — only when there's an unambiguous explicit intent
    // (chart type or grouping is stated). Generic "show expenses" goes to Ollama.
    // ═══════════════════════════════════════════════════════════════════════════
    if (hasPLFlow)
      return [
        {
          type: 'waterfall',
          metric: 'pl',
          grouping: 'summary',
          title: 'P&L Waterfall — Revenue to Net Income',
        },
      ];

    if (hasExpense && hasAccount)
      return [
        {
          type: isHBar ? 'horizontal_bar' : 'bar',
          metric: 'expense',
          grouping: 'account',
          title: 'Expense Amount by Account Name',
        },
      ];

    if (hasExpense && isTreemap)
      return [
        {
          type: 'treemap',
          metric: 'expense',
          grouping: 'account',
          title: 'Expense Contribution by Account Category',
        },
      ];

    if (hasExpense && isHBar)
      return [
        {
          type: 'horizontal_bar',
          metric: 'expense',
          grouping: 'account',
          title: 'Expense Amount by Account Name — Ranked',
        },
      ];

    // Fall through to Ollama for everything else (novel queries, client questions,
    // invoice analysis, multi-entity comparisons, free-form questions, etc.)
    return null;
  }

  /**
   * Repair common ClickHouse SQL mistakes the LLM produces:
   * 1. `ORDER BY alias` where alias shadows a column name → expand to full expression
   * 2. lag()/lead() window functions → not supported, remove or simplify
   */
  // A scalar function can't carry a window: `abs(sumIf(...)) OVER ()` is invalid
  // (ClickHouse: "Aggregate function abs does not exist"). The window belongs on
  // the AGGREGATE, so rewrite f(agg(...)) OVER (win) → f(agg(...) OVER (win)).
  // The LLM writes this often for share-of-total; fix it deterministically so it
  // never errors / needs the slow self-repair round-trip.
  private fixScalarWindowWrap(sql: string): string {
    const scalarFns = ['abs', 'round', 'floor', 'ceil', 'toFloat64', 'toFloat32'];
    let out = sql;
    for (const fn of scalarFns) {
      const re = new RegExp(`\\b${fn}\\s*\\(`, 'gi');
      let m: RegExpExecArray | null;
      while ((m = re.exec(out)) !== null) {
        const open = m.index + m[0].length - 1; // index of '('
        let depth = 1;
        let i = open + 1;
        for (; i < out.length && depth > 0; i++) {
          if (out[i] === '(') depth++;
          else if (out[i] === ')') depth--;
        }
        const close = i - 1; // matching ')' of fn(...)
        const after = out.slice(close + 1);
        const over = after.match(/^(\s*OVER\s*\()/i);
        if (!over) continue;
        // find the window's matching ')'
        let d2 = 1;
        let j = close + 1 + over[0].length;
        for (; j < out.length && d2 > 0; j++) {
          if (out[j] === '(') d2++;
          else if (out[j] === ')') d2--;
        }
        const winClose = j - 1;
        const inner = out.slice(open + 1, close);
        const overClause = out.slice(close + 1, winClose + 1); // " OVER (...)"
        const rebuilt = `${fn}(${inner}${overClause})`;
        out = out.slice(0, m.index) + rebuilt + out.slice(winClose + 1);
        re.lastIndex = m.index + rebuilt.length;
      }
    }
    return out;
  }

  private repairClickHouseSql(sql: string): string {
    let fixed = this.fixScalarWindowWrap(sql);

    // ── 1. Fix alias-shadowing (ClickHouse new analyzer bug) ─────────────────────────────────
    // When COALESCE(NULLIF(department,''),'Other') is aliased AS department, ClickHouse's
    // strict analyzer resolves 'department' inside GROUP BY COALESCE(NULLIF(department,...))
    // as the SELECT alias rather than the underlying column, producing NOT_AN_AGGREGATE.
    // Fix: rename the alias to a non-conflicting name so the column resolves normally.
    fixed = fixed.replace(
      /COALESCE\s*\(\s*NULLIF\s*\(\s*department\b[^)]*\)[^)]*\)\s+AS\s+department\b/gi,
      (m) => m.replace(/\bAS\s+department\b/i, 'AS dept'),
    );
    fixed = fixed.replace(
      /COALESCE\s*\(\s*NULLIF\s*\(\s*vendor_name\b[^)]*\)[^)]*\)\s+AS\s+vendor_name\b/gi,
      (m) => m.replace(/\bAS\s+vendor_name\b/i, 'AS vendor'),
    );
    fixed = fixed.replace(
      /COALESCE\s*\(\s*NULLIF\s*\(\s*class_name\b[^)]*\)[^)]*\)\s+AS\s+class_name\b/gi,
      (m) => m.replace(/\bAS\s+class_name\b/i, 'AS class_label'),
    );

    // ── 2. Fix bare ORDER BY dimension references ─────────────────────────────────────────────
    // Replace bare column references in ORDER BY with their COALESCE wrapping.
    // The (?<!\() lookbehind prevents matching 'department' when it is already inside a
    // function argument (e.g. NULLIF(department, '')) to avoid double-wrapping.
    fixed = fixed.replace(
      /ORDER\s+BY\s+(.*?)(?<!\()department\b(?!\s*\()/gi,
      (match, prefix) =>
        `ORDER BY ${prefix}COALESCE(NULLIF(department,''),'Other')`,
    );
    fixed = fixed.replace(
      /ORDER\s+BY\s+(.*?)(?<!\()vendor_name\b(?!\s*\()/gi,
      (match, prefix) =>
        `ORDER BY ${prefix}COALESCE(NULLIF(vendor_name,''),'Other')`,
    );
    fixed = fixed.replace(
      /ORDER\s+BY\s+(.*?)(?<!\()class_name\b(?!\s*\()/gi,
      (match, prefix) =>
        `ORDER BY ${prefix}COALESCE(NULLIF(class_name,''),'Other')`,
    );

    // ── 2b. Fix invalid quarter formatting ───────────────────────────────────────────────────
    // ClickHouse formatDateTime() has NO quarter token (%Q). A query using it
    // throws and the chart silently renders empty. Rewrite to a valid quarter
    // label — toQuarter()/toYear() accept the same inner date expression
    // (e.g. toStartOfMonth(journal_date) or journal_date) directly.
    fixed = fixed.replace(
      /formatDateTime\s*\(\s*([^,]+?)\s*,\s*'[^']*%Q[^']*'\s*\)/gi,
      (_m, inner) =>
        `concat('Q', toString(toQuarter(${String(inner).trim()})), ' ', toString(toYear(${String(inner).trim()})))`,
    );

    // ── 2c. Fix cross-table date column confusion ────────────────────────────────────────────
    // sample_gl_dump's date column is `date`. The model often writes `journal_date`
    // (which only exists on v_fact_accounting_journal_lines_latest), causing
    // UNKNOWN_IDENTIFIER → empty chart. When the query reads sample_gl_dump and NOT
    // the journal-lines view, rewrite journal_date → date.
    if (
      /\bsample_gl_dump\b/i.test(fixed) &&
      !/v_fact_accounting_journal_lines/i.test(fixed)
    ) {
      fixed = fixed.replace(/\bjournal_date\b/gi, 'date');
    }
    // Symmetric: sample_trial_balance has no date column at all — nothing to do here,
    // but if the model used line_amount on sample_gl_dump (which has debit/credit),
    // that is a different table and handled by table selection, not a rename.

    // ── 3. Normalize window functions to ClickHouse spelling ─────────────────────────────────
    // ClickHouse supports window functions but names them lagInFrame()/leadInFrame()
    // (not the standard lag()/lead()). The model often writes the standard names —
    // rewrite them so month-over-month growth etc. runs instead of erroring.
    // (Only touch lag(/lead( that are NOT already *InFrame.)
    fixed = fixed.replace(/\blag\s*\(/gi, 'lagInFrame(');
    fixed = fixed.replace(/\blead\s*\(/gi, 'leadInFrame(');

    return fixed;
  }

  private validateAndScopeDynamicSql(
    sql: string,
    scope: OrgScope,
    opts?: { chartType?: ChartType },
  ): string {
    // The planner is told to scope every query, but the LLM frequently writes
    // only the org_id predicate (most prompt examples show org_id alone). The
    // validator requires BOTH tenant_id and org_id predicates. We always pass
    // the tenantId param, so inject the tenant predicate next to each org
    // predicate when it is missing — otherwise every widget would be rejected
    // and we'd silently fall back to generic charts.
    const scoped = injectTenantScopePredicate(sql);
    const normalized = validateDynamicSql(scoped, {
      analyticsDb: this.analyticsDb,
      chartType: opts?.chartType ?? null,
    });
    // Auto-repair common ClickHouse incompatibilities (alias-shadowing, ORDER BY fixes, etc)
    return this.repairClickHouseSql(normalized);
  }

  private async executeDynamicSql(
    sql: string,
    scope: OrgScope,
    opts?: { chartType?: ChartType },
  ): Promise<Record<string, unknown>[]> {
    const { rows } = await this.executeDynamicSqlChecked(sql, scope, opts);
    return rows;
  }

  // Like executeDynamicSql but surfaces WHY a query produced no rows: error !==
  // null means validation or ClickHouse rejected it (recoverable via self-repair);
  // error === null with rows === [] means the query ran fine but the data is
  // genuinely empty (do NOT retry — that is an honest no-data).
  private async executeDynamicSqlChecked(
    sql: string,
    scope: OrgScope,
    opts?: { chartType?: ChartType },
  ): Promise<{ rows: Record<string, unknown>[]; error: string | null }> {
    try {
      const normalized = this.validateAndScopeDynamicSql(sql, scope, opts);

      const tryQuery = async (q: string, asOfIso: string | null) => {
        const params: Record<string, unknown> = {
          tenantId: scope.tenantId,
          externalOrgIds: scope.externalOrgIds,
        };
        if (asOfIso) params.asOf = `${asOfIso} 23:59:59`;
        return this.queryRows<Record<string, unknown>>(q, params);
      };

      const usesNow = sqlUsesNowOrToday(normalized);
      const asOfIso = usesNow ? await this.resolveAsOfIso(scope) : null;
      const shouldAnchor = asOfIso ? this.isStaleAsOf(asOfIso) : false;

      // Primary attempt
      if (usesNow && shouldAnchor && asOfIso) {
        const rewritten = rewriteRelativeNowToAsOf(normalized);
        const anchored = this.validateAndScopeDynamicSql(
          rewritten,
          scope,
          opts,
        );
        const rows = await tryQuery(anchored, asOfIso);
        if (rows.length > 0) return { rows, error: null };
        // If anchored returns empty, fall through to original (may be intended "now").
      }

      const primary = await tryQuery(normalized, null);
      if (primary.length > 0) return { rows: primary, error: null };

      // Retry: if time-relative SQL returned empty, try anchoring to dataset max date.
      if (usesNow && asOfIso) {
        const rewritten = rewriteRelativeNowToAsOf(normalized);
        const anchored = this.validateAndScopeDynamicSql(
          rewritten,
          scope,
          opts,
        );
        const rows = await tryQuery(anchored, asOfIso);
        return { rows, error: null };
      }

      return { rows: [], error: null };
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      this.logger.warn(`[Agent:Dynamic] SQL execution failed: ${msg}`);
      return { rows: [], error: msg };
    }
  }

  private pivotAxisExpr(axis: PivotAxis): {
    labelExpr: string;
    sortExpr: string;
  } {
    switch (axis) {
      case 'month':
        return {
          labelExpr: `formatDateTime(toStartOfMonth(journal_date), '%b %y')`,
          sortExpr: `toStartOfMonth(journal_date)`,
        };
      case 'department':
        return {
          labelExpr: `COALESCE(NULLIF(department, ''), 'Unassigned')`,
          sortExpr: `COALESCE(NULLIF(department, ''), 'Unassigned')`,
        };
      case 'class':
        return {
          labelExpr: `COALESCE(NULLIF(class_name, ''), 'Unassigned')`,
          sortExpr: `COALESCE(NULLIF(class_name, ''), 'Unassigned')`,
        };
      case 'vendor':
        return {
          labelExpr: `COALESCE(NULLIF(vendor_name, ''), 'Unassigned')`,
          sortExpr: `COALESCE(NULLIF(vendor_name, ''), 'Unassigned')`,
        };
      case 'account':
        return {
          labelExpr: `COALESCE(NULLIF(account_name, ''), 'Unassigned')`,
          sortExpr: `COALESCE(NULLIF(account_name, ''), 'Unassigned')`,
        };
    }
  }

  private async buildExpensePivot(
    rowAxis: PivotAxis,
    colAxis: PivotAxis,
    scope: OrgScope,
    entityParam: Record<string, unknown>,
    range: TimeRange | undefined,
    // Show the full category set (the old default of 8 truncated vendors/accounts
    // even though only ~24 vendors / ~26 accounts exist). Months (≤12) are
    // unaffected. Testers explicitly flagged missing vendors as the bug.
    maxColumns = 40,
  ): Promise<{ data: Array<Record<string, unknown>>; keys: string[] }> {
    if (scope.externalOrgIds.length === 0) return { data: [], keys: [] };

    const jTbl = `${this.analyticsDb}.v_fact_accounting_journal_lines_enriched_latest`;
    const glTbl = `${this.analyticsDb}.sample_gl_dump`;
    const entity =
      entityParam && Object.keys(entityParam).length > 0
        ? 'AND org_id = {orgId:String}'
        : '';
    const jTime = this.timeWhereOn('journal_date', range);
    const row = this.pivotAxisExpr(rowAxis);
    const col = this.pivotAxisExpr(colAxis);

    const materialize = (rows: any[]) => {
      const colTotals = new Map<string, number>();
      const rowMap = new Map<string, { sort: string; total: number; [key: string]: any }>();

      for (const r of rows as any[]) {
        const rowLabel = String(r.row_label ?? '');
        const colLabel = String(r.col_label ?? '');
        const value = this.num(r.value);
        if (!rowLabel || !colLabel || !Number.isFinite(value) || value <= 0) continue;
        colTotals.set(colLabel, (colTotals.get(colLabel) ?? 0) + value);
        if (!rowMap.has(rowLabel)) {
          rowMap.set(rowLabel, { sort: String(r.row_sort ?? rowLabel), total: 0 });
        }
        const entry = rowMap.get(rowLabel)!;
        entry[colLabel] = (entry[colLabel] ?? 0) + value;
        entry.total += value;
      }

      const sortedCols = Array.from(colTotals.entries())
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, Math.max(1, Math.min(maxColumns, colTotals.size)))
        .map(([key]) => key);

      const sortedRows = Array.from(rowMap.entries())
        .sort((a, b) => {
          if (rowAxis === 'month') return a[1].sort.localeCompare(b[1].sort);
          return b[1].total - a[1].total || a[0].localeCompare(b[0]);
        })
        .map(([label, vals]) => {
          const out: Record<string, unknown> = { name: label };
          for (const colLabel of sortedCols) out[colLabel] = vals[colLabel] ?? 0;
          return out;
        });

      return { data: sortedRows, keys: sortedCols };
    };

    const glAxisExpr = (axis: PivotAxis) => {
      switch (axis) {
        case 'month':
          return {
            labelExpr: `formatDateTime(toStartOfMonth(date), '%b %y')`,
            sortExpr: `toStartOfMonth(date)`,
            notEmpty: `date IS NOT NULL`,
          };
        case 'department':
          return {
            labelExpr: `COALESCE(NULLIF(department, ''), 'Unassigned')`,
            sortExpr: `COALESCE(NULLIF(department, ''), 'Unassigned')`,
            notEmpty: `department != ''`,
          };
        case 'class':
          return {
            labelExpr: `COALESCE(NULLIF(class, ''), 'Unassigned')`,
            sortExpr: `COALESCE(NULLIF(class, ''), 'Unassigned')`,
            notEmpty: `class != ''`,
          };
        case 'vendor':
          return {
            labelExpr: `COALESCE(NULLIF(vendor_customer, ''), 'Unassigned')`,
            sortExpr: `COALESCE(NULLIF(vendor_customer, ''), 'Unassigned')`,
            notEmpty: `vendor_customer != ''`,
          };
        case 'account':
          return {
            labelExpr: `COALESCE(NULLIF(account_name, ''), 'Unassigned')`,
            sortExpr: `COALESCE(NULLIF(account_name, ''), 'Unassigned')`,
            notEmpty: `account_name != ''`,
          };
      }
    };

    const glRow = glAxisExpr(rowAxis);
    const glCol = glAxisExpr(colAxis);
    const glTime = this.timeWhereOn('date', range);
    const glRows = await this.queryRows<any>(
      `SELECT
         ${glRow.labelExpr} AS row_label,
         ${glRow.sortExpr} AS row_sort,
         ${glCol.labelExpr} AS col_label,
         round(sum(toFloat64(debit)), 0) AS value
       FROM ${glTbl}
       WHERE org_id IN ({externalOrgIds:Array(String)})
         ${glTime}
         AND toFloat64(debit) > 0
         AND ${glRow.notEmpty}
         AND ${glCol.notEmpty}
       GROUP BY row_label, row_sort, col_label
       HAVING value > 0
       ORDER BY row_sort ASC, value DESC`,
      { externalOrgIds: scope.externalOrgIds },
    );
    const glPivot = materialize(glRows);
    if (glPivot.data.length > 0) return glPivot;

    const rows = await this.queryRows<any>(
      `SELECT
         ${row.labelExpr} AS row_label,
         ${row.sortExpr} AS row_sort,
         ${col.labelExpr} AS col_label,
         round(sum(toFloat64(line_amount)), 0) AS value
       FROM ${jTbl}
       WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${jTime}
         AND line_amount > 0 AND journal_date IS NOT NULL
       GROUP BY row_label, row_sort, col_label
       HAVING value > 0
       ORDER BY row_sort ASC, value DESC`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
    );

    return materialize(rows);
  }

  // Detect a chart whose SQL ran but produced an unusable SHAPE — most commonly
  // the wrong dimension used as the x-axis label (duplicate "name" values), or a
  // missing label column. Returns a human hint for self-repair, or null if fine.
  private detectBadChartShape(
    rows: Record<string, unknown>[],
    chartType: ChartType,
  ): string | null {
    const t = String(chartType).toLowerCase();
    // These chart types don't have a categorical x-axis label to dedupe.
    if (['table', 'metric', 'kpi', 'gauge'].includes(t)) return null;
    if (!rows.length) return null;

    const keys = Object.keys(rows[0] ?? {});
    if (!keys.includes('name')) {
      return `Output has no "name" column (columns: ${keys.join(', ')}). Alias the label/dimension column AS name.`;
    }

    const names = rows.map((r) => String((r as any).name ?? ''));
    const distinct = new Set(names).size;
    if (distinct < names.length) {
      return (
        `The "name" column has duplicate labels (${distinct} distinct across ${names.length} rows), ` +
        `so the x-axis repeats values — the WRONG dimension is being used as the label. Put the entity ` +
        `the user is listing/ranking in "name" (one row per entity), and express any "by <category>" ` +
        `breakdown as separate NUMERIC sumIf() columns (one per category) — not as extra rows and not ` +
        `as an extra text column.`
      );
    }

    // Must have at least one numeric series column besides "name".
    const hasNumericSeries = keys.some(
      (k) =>
        k !== 'name' &&
        rows.some((r) => {
          const v = (r as any)[k];
          return v !== null && v !== '' && Number.isFinite(Number(v));
        }),
    );
    if (!hasNumericSeries) {
      return `Output has no numeric series column (columns: ${keys.join(', ')}). Provide a numeric "value" column, or numeric series columns.`;
    }

    // Multi-series dept chart: if all non-name columns are zero, the SQL's sumIf
    // conditions didn't match (wrong table, wrong dept name, etc.) — self-repair.
    if (!keys.includes('value') && keys.length >= 3) {
      const seriesKeys = keys.filter((k) => k !== 'name');
      const allZero = rows.every((r) =>
        seriesKeys.every((k) => {
          const v = (r as any)[k];
          return v === 0 || v === null || v === '' || Number(v) === 0;
        }),
      );
      if (allZero && rows.length > 0) {
        return (
          `All department/series columns are zero (columns: ${seriesKeys.join(', ')}). ` +
          `The sumIf conditions did not match — likely wrong table or wrong dept names. ` +
          `Use sample_gl_dump with: SELECT formatDateTime(toStartOfMonth(date),'%b %Y') AS name, ` +
          `round(sumIf(toFloat64(debit), COALESCE(NULLIF(department,''),'Other')='Admin'),0) AS admin, ` +
          `round(sumIf(toFloat64(debit), COALESCE(NULLIF(department,''),'Other')='Operations'),0) AS operations, ` +
          `round(sumIf(toFloat64(debit), COALESCE(NULLIF(department,''),'Other')='Sales'),0) AS sales ` +
          `FROM analytics.sample_gl_dump WHERE ... AND department!='' ` +
          `GROUP BY toStartOfMonth(date) ORDER BY toStartOfMonth(date) LIMIT 24`
        );
      }
    }

    // Sanity check for department spend data: Operations must be the largest dept.
    // If Admin or Sales is > Operations by >5x, the SQL used account_type='Expense'
    // filter which excludes COGS from Operations — producing badly wrong values.
    if (keys.includes('value') && rows.length >= 2) {
      const deptRows = rows.filter((r) => {
        const n = String((r as any).name ?? '').toLowerCase();
        return n === 'admin' || n === 'operations' || n === 'sales';
      });
      if (deptRows.length >= 2) {
        const ops = deptRows.find(
          (r) => String((r as any).name ?? '').toLowerCase() === 'operations',
        );
        const admin = deptRows.find(
          (r) => String((r as any).name ?? '').toLowerCase() === 'admin',
        );
        if (ops && admin) {
          const opsVal = Number((ops as any).value ?? 0);
          const adminVal = Number((admin as any).value ?? 0);
          if (opsVal > 0 && adminVal > opsVal * 5) {
            return (
              'Department spend values are wrong — Operations ($' +
              opsVal.toFixed(0) +
              ') is much less than Admin ($' +
              adminVal.toFixed(0) +
              '). ' +
              'Your SQL filtered by account_type="Expense" which excludes COGS from Operations. ' +
              'REMOVE the account_type filter. Use: SELECT COALESCE(NULLIF(department,""),"Other") AS name, ' +
              'round(sum(toFloat64(debit)),0) AS value FROM analytics.sample_gl_dump ' +
              'WHERE tenant_id={tenantId:String} AND org_id IN ({externalOrgIds:Array(String)}) ' +
              'AND department!="" AND toFloat64(debit)>0 GROUP BY COALESCE(NULLIF(department,""),"Other") ORDER BY value DESC LIMIT 10'
            );
          }
        }
      }
    }

    return null;
  }

  // Self-repair: when a chart's SQL is rejected by ClickHouse (wrong column,
  // bad function, syntax), feed the error + live schema back to the model ONCE
  // and ask for a corrected query. Generic safety net for the recurring class of
  // "model wrote slightly-wrong SQL → empty chart" failures. Returns null if it
  // cannot produce a clean fix (caller then drops the chart / reports no_data).
  private async repairSqlViaLLM(
    brokenSql: string,
    errorMessage: string,
    liveContext: string,
  ): Promise<string | null> {
    try {
      const sys =
        'You are a ClickHouse SQL fixer. A query failed. Return ONLY the corrected single ' +
        'SELECT or WITH query — no markdown, no prose. Keep the SAME analytical intent and the ' +
        'same output column aliases. ALWAYS keep the scope predicate ' +
        'WHERE tenant_id = {tenantId:String} AND org_id IN ({externalOrgIds:Array(String)}) and a LIMIT. ' +
        'Use ONLY tables/columns that exist in the schema below. Common fixes: correct date column per ' +
        "table (sample_gl_dump uses 'date'; v_fact_accounting_journal_lines_latest uses 'journal_date'; " +
        "invoices use 'issued_at'); ClickHouse window functions are lagInFrame()/leadInFrame() (never lag/lead); " +
        "there is NO '%Q' format token (build quarter labels with toQuarter()/toYear()).";
      const user =
        `SCHEMA / LIVE DATA:\n${liveContext}\n\n` +
        `FAILED SQL:\n${brokenSql}\n\n` +
        `CLICKHOUSE ERROR:\n${errorMessage}\n\n` +
        `Return the corrected SQL only.`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      const resp = await fetch(`${this.OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.OLLAMA_MODEL,
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: user },
          ],
          stream: false,
          options: { temperature: 0.05, num_predict: 1500, num_ctx: 8192 },
        }),
      }).catch(() => null);
      clearTimeout(timer);
      if (!resp?.ok) return null;

      const body = (await resp.json()) as { message?: { content?: string } };
      let out = (body.message?.content ?? '')
        .replace(/```sql|```json|```/gi, '')
        .trim();
      // Strip any surrounding prose — keep from the first SELECT/WITH onward.
      const m = out.match(/\b(WITH|SELECT)\b[\s\S]*/i);
      if (m) out = m[0];
      out = out.replace(/;+\s*$/, '').trim();
      return out || null;
    } catch {
      return null;
    }
  }

  private buildToolPreview(result: ToolResult): string {
    if (!result.data || result.rowCount === 0) return 'No data returned';
    if (Array.isArray(result.data) && result.data.length > 0) {
      const keys = Object.keys(result.data[0] as object).slice(0, 4);
      return `${result.rowCount} records — fields: ${keys.join(', ')}`;
    }
    if (typeof result.data === 'object') {
      const keys = Object.keys(result.data as object).slice(0, 4);
      return `Summary: ${keys.join(', ')}`;
    }
    return `${result.rowCount} records`;
  }

  // GL data is often historical (e.g. 2024 data queried from 2026).
  // When a relative time filter returns nothing, fall back to all-time.
  private async queryRowsWithTimeFallback<T>(
    buildSql: (timeClause: string) => string,
    params: Record<string, any>,
    jTime: string,
  ): Promise<T[]> {
    if (jTime) {
      const rows = await this.queryRows<T>(buildSql(jTime), params);
      if (rows.length > 0) return rows;
      // Time-filtered query returned nothing — data may be historical. Retry without time filter.
      this.logger.debug(
        '[GL] time-filtered query empty — retrying without date range',
      );
    }
    return this.queryRows<T>(buildSql(''), params);
  }

  private timeWhereOn(
    column: string,
    range?: TimeRange,
    asOfExpr: string = 'now()',
  ): string {
    if (!range || range.kind === 'ALL_TIME') return '';

    const col = column;
    const isIsoDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

    if (range.kind === 'MTD')
      return `AND ${col} >= toStartOfMonth(${asOfExpr})`;
    if (range.kind === 'QTD')
      return `AND ${col} >= toStartOfQuarter(${asOfExpr})`;
    if (range.kind === 'YTD') return `AND ${col} >= toStartOfYear(${asOfExpr})`;

    if (range.kind === 'SINCE_DATE' && isIsoDate(range.start)) {
      return `AND ${col} >= toDateTime('${range.start} 00:00:00')`;
    }

    if (
      range.kind === 'BETWEEN_DATES' &&
      isIsoDate(range.start) &&
      isIsoDate(range.end)
    ) {
      // Inclusive start, inclusive end (end-of-day)
      return `AND ${col} >= toDateTime('${range.start} 00:00:00') AND ${col} <= toDateTime('${range.end} 23:59:59')`;
    }

    if (range.kind === 'LAST_N_DAYS')
      return `AND ${col} >= (${asOfExpr} - INTERVAL ${Math.max(1, Math.floor(range.days))} DAY)`;
    if (range.kind === 'LAST_N_WEEKS')
      return `AND ${col} >= (${asOfExpr} - INTERVAL ${Math.max(1, Math.floor(range.weeks))} WEEK)`;
    if (range.kind === 'LAST_N_MONTHS') {
      const months = Math.max(1, Math.floor(range.months));
      // Use calendar-month boundaries so "last 6 months" yields 6 month buckets
      // (including the current month) when charting by month.
      return `AND ${col} >= toStartOfMonth(addMonths(${asOfExpr}, -${months - 1}))`;
    }
    if (range.kind === 'LAST_N_QUARTERS')
      return `AND ${col} >= toStartOfQuarter(addMonths(${asOfExpr}, -${(Math.max(1, Math.floor(range.quarters)) - 1) * 3}))`;
    if (range.kind === 'LAST_N_YEARS')
      return `AND ${col} >= toStartOfYear(addYears(${asOfExpr}, -${Math.max(1, Math.floor(range.years)) - 1}))`;

    return '';
  }

  private chunkText(text: string, size: number): string[] {
    const s = text ?? '';
    const n = Math.max(1, Math.floor(size));
    const out: string[] = [];
    for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
    return out.length > 0 ? out : [''];
  }

  private composeDeterministicBrief(
    spec: QuerySpec,
    toolResults: ToolResult[],
    plan: AgentPlan,
    meta: {
      intent: QueryIntent;
      dashboardTitle: string;
      widgetCount: number;
      editSummary: string | null;
    },
  ): string {
    const map = new Map<string, any>();
    for (const r of toolResults) map.set(r.tool, r.data);

    const summary =
      map.get('financial_summary') &&
      typeof map.get('financial_summary') === 'object'
        ? map.get('financial_summary')
        : {};

    const totalInvoices = this.num(summary.total_invoices);
    const totalRevenue = this.num(summary.total_revenue);
    const overdueAmount = this.num(summary.overdue_amount);
    const overdueCount = this.num(summary.overdue_count);
    const clientScope = spec.clientFilter?.name ?? null;

    const formatUsd = (n: number) =>
      `$${this.fmtK(Math.max(0, Math.round(n)))}`;

    const chartWord = meta.widgetCount === 1 ? 'chart' : 'charts';
    const action =
      meta.intent === 'EDIT_DASHBOARD'
        ? `Updated **${meta.dashboardTitle}**.`
        : meta.dashboardTitle
          ? `Built **${meta.dashboardTitle}** — ${meta.widgetCount} ${chartWord}.`
          : `Analyzed your data and prepared a dashboard plan.`;

    const metricSentence = (() => {
      // SQL-first (smart-plan) dashboards run no invoice tools, so financial_summary
      // is absent. Do NOT assert "No invoices found" for a vendor/expense dashboard
      // that never involved invoices — it reads as broken. Stay silent on metrics.
      if (!map.has('financial_summary')) return '';
      if (totalInvoices === 0) {
        // Only assert "no invoices" for an invoice/receivables dashboard. For a
        // payroll / employee-count / cash-flow / asset chart (EBPO orgs have no
        // invoice table at all) this sentence is irrelevant and reads as broken —
        // stay silent instead.
        const invoiceFocused =
          /invoice|receivable|\bcollect|outstanding|overdue|\bbilled\b|aging|\bAR\b|\bAP\b|payables?/i.test(
            String(meta.dashboardTitle ?? ''),
          );
        if (!invoiceFocused) return '';
        if (spec.entityFilter?.orgName) {
          return `No invoices found for ${spec.entityFilter.orgName} in this scope yet (0 invoices).`;
        }
        return `No invoices found in this scope yet (0 invoices).`;
      }
      if (spec.paymentDaysIntent) {
        if (spec.paymentDaysIntent === 'LIST') {
          return `Showing issued→paid payment days per invoice${clientScope ? ` for ${clientScope}` : ''}.`;
        }
        if (spec.paymentDaysIntent === 'DISTRIBUTION') {
          return `Showing the distribution of issued→paid payment days${clientScope ? ` for ${clientScope}` : ''}.`;
        }
        return `Showing the average issued→paid payment days trend${clientScope ? ` for ${clientScope}` : ''}.`;
      }
      if (spec.focus === 'AR_RISK') {
        return `Overdue exposure is ${formatUsd(overdueAmount)} across ${overdueCount} overdue invoices.`;
      }
      if (spec.focus === 'VENTURE') {
        const vm =
          map.get('venture_metrics') &&
          typeof map.get('venture_metrics') === 'object'
            ? map.get('venture_metrics')
            : null;
        if (!vm)
          return `Total revenue is ${formatUsd(totalRevenue)} across ${totalInvoices} invoices.`;
        const burn = this.num(vm.estimatedMonthlyBurn);
        const runway = this.num(vm.runwayMonths);
        const cash = this.num(vm.cashOnHand);
        return `Estimated burn is ${formatUsd(burn)}/mo with ~${runway} months runway and ${formatUsd(cash)} cash-on-hand.`;
      }
      if (spec.focus === 'AUDIT') {
        return `Showing ${totalInvoices} invoices with an average invoice size of ${formatUsd(this.num(summary.avg_invoice))}.`;
      }
      if (spec.focus === 'COLLECTIONS') {
        return `Total revenue is ${formatUsd(totalRevenue)} with ${formatUsd(overdueAmount)} currently overdue.`;
      }
      return `Total revenue is ${formatUsd(totalRevenue)} across ${totalInvoices} invoices.`;
    })();

    const highlightSentence = (() => {
      const scopeBits: string[] = [];
      if (spec.entityFilter?.orgName)
        scopeBits.push(`Entity: ${spec.entityFilter.orgName}`);
      if (clientScope) scopeBits.push(`Client: ${clientScope}`);
      if (spec.timeRange?.kind && spec.timeRange.kind !== 'ALL_TIME')
        scopeBits.push(`Window: ${spec.timeRange.kind}`);

      const widgetTitles = (plan.dashboard.widgets ?? [])
        .map((w) => w.title)
        .filter(Boolean);
      const chartBit =
        widgetTitles.length === 0
          ? null
          : widgetTitles.length <= 2
            ? `Charts: ${widgetTitles.join(' + ')}.`
            : `Charts: ${widgetTitles[0]} + ${widgetTitles.length - 1} more.`;

      const scopeBit =
        scopeBits.length > 0 ? `Scope: ${scopeBits.join(' · ')}.` : null;

      if (spec.paymentDaysIntent) {
        return [scopeBit, chartBit].filter(Boolean).join(' ');
      }
      // Prefer period-aware client data when timeRange is set (we compute from facts in metricData),
      // but for synthesis we use the tool outputs we actually executed.
      if (spec.wantsTopClients) {
        const profile = Array.isArray(map.get('client_financial_profile'))
          ? (map.get('client_financial_profile') as any[])
          : [];
        const breakdown = Array.isArray(map.get('client_breakdown'))
          ? (map.get('client_breakdown') as any[])
          : [];
        const rows = profile.length > 0 ? profile : breakdown;
        if (rows.length === 0)
          return `No client-level breakdown was available for this scope.`;

        const pick = (() => {
          if (spec.topBy === 'OVERDUE')
            return rows
              .slice()
              .sort(
                (a, b) =>
                  this.num(b.total_overdue ?? b.overdue ?? 0) -
                  this.num(a.total_overdue ?? a.overdue ?? 0),
              )[0];
          if (spec.topBy === 'OUTSTANDING')
            return rows
              .slice()
              .sort(
                (a, b) =>
                  this.num(b.total_outstanding ?? b.outstanding ?? 0) -
                  this.num(a.total_outstanding ?? a.outstanding ?? 0),
              )[0];
          if (spec.topBy === 'TOTAL_INVOICED')
            return rows
              .slice()
              .sort(
                (a, b) =>
                  this.num(b.total_invoiced ?? b.billed ?? 0) -
                  this.num(a.total_invoiced ?? a.billed ?? 0),
              )[0];
          return rows
            .slice()
            .sort(
              (a, b) =>
                this.num(b.total_revenue ?? b.revenue ?? 0) -
                this.num(a.total_revenue ?? a.revenue ?? 0),
            )[0];
        })();

        const name = String(
          pick?.client_name ?? pick?.client_name ?? pick?.client ?? 'Unknown',
        ).slice(0, 64);
        const value = (() => {
          if (spec.topBy === 'OVERDUE')
            return this.num(pick?.total_overdue ?? pick?.overdue ?? 0);
          if (spec.topBy === 'OUTSTANDING')
            return this.num(pick?.total_outstanding ?? pick?.outstanding ?? 0);
          if (spec.topBy === 'TOTAL_INVOICED')
            return this.num(pick?.total_invoiced ?? pick?.billed ?? 0);
          return this.num(pick?.total_revenue ?? pick?.revenue ?? 0);
        })();

        const label =
          spec.topBy === 'OVERDUE'
            ? 'overdue exposure'
            : spec.topBy === 'OUTSTANDING'
              ? 'outstanding balance'
              : spec.topBy === 'TOTAL_INVOICED'
                ? 'total invoiced'
                : 'revenue';

        return [
          `Top client by ${label}: ${name} at ${formatUsd(value)}.`,
          scopeBit,
          chartBit,
        ]
          .filter(Boolean)
          .join(' ');
      }

      return (
        [scopeBit, chartBit].filter(Boolean).join(' ') ||
        `Charts built from verified invoice data only.`
      );
    })();

    // Skip a generic editor summary ("Updated the chart") — the action line
    // already says we updated it; only append a summary that adds real detail.
    const editDetail = (meta.editSummary ?? '').replace(/[.\s]+$/, '');
    const editIsGeneric = /^updated (your |the )?chart$/i.test(editDetail);
    const sentence3 =
      editDetail && !editIsGeneric && meta.intent === 'EDIT_DASHBOARD'
        ? `${editDetail}.`
        : highlightSentence;

    // Maximum 3 sentences. Never invent numbers — everything above is derived from tool results.
    return [action, metricSentence, sentence3].filter(Boolean).join(' ');
  }

  private chunk(type: string, payload: Record<string, unknown>): string {
    return JSON.stringify({ type, ...payload }) + '\n';
  }
}
