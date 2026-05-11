import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PrismaClient, Prisma } from '@repo/db';
import {
  CLICKHOUSE_ANALYTICS_TOKEN,
  PRISMA_TOKEN,
} from '../../database/database.module';
import type { ClickHouseClient } from '@clickhouse/client';
import { OrganizationContextService } from '../org-context/org-context.service';
import { parseQuerySpec, type QuerySpec, type TimeRange } from './query-spec';

// ─── Types ────────────────────────────────────────────────────────────────────

interface OrgScope {
  connectionIds: string[];
  externalOrgIds: string[];
}

type MembershipRole = 'ADMIN' | 'USER';

interface ToolResult {
  tool: string;
  data: unknown;
  rowCount: number;
}

interface AgentPlan {
  tools_to_execute: string[];
  should_generate_dashboard: boolean;
  dashboard: {
    title: string;
    description: string;
    widgets: Array<{
      title: string;
      description: string;
      type: 'line' | 'bar' | 'pie' | 'metric' | 'table';
      metric: string;
      grouping: string;
      breakdown?: 'client';
      topN?: number;
      display_order: number;
    }>;
  };
  analysis_focus: string;
}

interface DashboardEditPlan {
  summary: string;
  add: Array<{
    title: string;
    description: string;
    type: 'line' | 'bar' | 'pie' | 'metric' | 'table';
    metric: string;
    grouping: string;
    breakdown?: 'client';
    topN?: number;
  }>;
  remove_indices: number[];
  modify: Array<{
    index: number;
    title?: string;
    type?: 'line' | 'bar' | 'pie' | 'metric' | 'table';
    description?: string;
  }>;
}

interface ActiveDashboard {
  id: string;
  title: string;
  widgets: Array<{
    id: string;
    title: string;
    chartType: string;
    queryConfig: unknown;
    displayOrder: number;
  }>;
}

type QueryIntent = 'CREATE_DASHBOARD' | 'EDIT_DASHBOARD';

interface ClarificationPrompt {
  question: string;
  options: Array<{ label: string; value: string }>;
  reason: string;
}

type ExplicitChartConstraints = {
  exactCount?: number;
  requiredTypes?: Array<'line' | 'bar' | 'pie' | 'metric' | 'table'>;
};

type ClientResolution =
  | { status: 'none' }
  | {
      status: 'resolved';
      mention: string;
      clientName: string;
      clientNameLower: string;
      score: number;
    }
  | {
      status: 'ambiguous';
      mention: string;
      candidates: Array<{ clientName: string; score: number }>;
    };

type EntityResolution =
  | { status: 'none' }
  | {
      status: 'resolved';
      mention: string;
      orgId: string;
      orgName: string;
      orgNameLower: string;
      score: number;
    }
  | {
      status: 'ambiguous';
      mention: string;
      candidates: Array<{ orgId: string; orgName: string; score: number }>;
    };

const SAFE_QUERY = { max_memory_usage: '536870912', max_execution_time: 20 };

// ─── Valid widget configurations ─────────────────────────────────────────────
// These are the ONLY supported metric+grouping pairs the agent can use.

// ─── Complete chart vocabulary — every (type, metric, grouping) pair the
// system can serve. Ollama picks freely from this list; the frontend renders any.
const VALID_WIDGETS = [
  // ── Time-series trends (line charts)
  { type: 'line', metric: 'revenue', grouping: 'month' },
  // Bar variant for when the user explicitly asks for bars over time
  { type: 'bar', metric: 'revenue', grouping: 'month' },
  { type: 'line', metric: 'outstanding', grouping: 'month' },
  { type: 'line', metric: 'paid', grouping: 'month' },
  { type: 'line', metric: 'invoice_count', grouping: 'month' },
  { type: 'line', metric: 'overdue', grouping: 'month' },
  { type: 'line', metric: 'collection_rate', grouping: 'month' },
  { type: 'line', metric: 'mom_growth', grouping: 'month' },
  { type: 'line', metric: 'revenue', grouping: 'quarter' },
  { type: 'line', metric: 'avg_invoice', grouping: 'month' },
  // ── Comparison bars — entity / period
  { type: 'bar', metric: 'revenue', grouping: 'org' },
  { type: 'bar', metric: 'revenue', grouping: 'quarter' },
  { type: 'bar', metric: 'invoices', grouping: 'org' },
  { type: 'bar', metric: 'outstanding', grouping: 'org' },
  { type: 'bar', metric: 'overdue', grouping: 'org' },
  // ── Client-level bars (sourced from dim_clients gold table)
  { type: 'bar', metric: 'revenue', grouping: 'client' },
  { type: 'bar', metric: 'total_invoiced', grouping: 'client' },
  { type: 'bar', metric: 'outstanding', grouping: 'client' },
  { type: 'bar', metric: 'overdue', grouping: 'client' },
  { type: 'bar', metric: 'invoices', grouping: 'client' },
  { type: 'bar', metric: 'avg_invoice', grouping: 'client' },
  { type: 'bar', metric: 'paid', grouping: 'client' },
  { type: 'bar', metric: 'collection_rate', grouping: 'client' },
  { type: 'bar', metric: 'overdue_rate', grouping: 'client' },
  // ── Proportional pies
  { type: 'pie', metric: 'revenue', grouping: 'client' },
  { type: 'pie', metric: 'revenue', grouping: 'provider' },
  { type: 'pie', metric: 'invoices', grouping: 'status' },
  { type: 'pie', metric: 'outstanding', grouping: 'client' },
  // ── Metric tiles
  { type: 'metric', metric: 'venture', grouping: 'summary' },
  { type: 'metric', metric: 'top5_revenue_share', grouping: 'summary' },
  { type: 'metric', metric: 'collected_vs_outstanding', grouping: 'summary' },
  // ── Tables
  { type: 'table', metric: 'invoices', grouping: 'list' },
  { type: 'table', metric: 'overdue', grouping: 'aging' },
  { type: 'table', metric: 'payment_days', grouping: 'list' },
  // ── Payment efficiency distributions
  { type: 'bar', metric: 'payment_days', grouping: 'bucket' },
  { type: 'line', metric: 'dso', grouping: 'month' },
] as const;

// ─── Planning Prompt — minimal for fast Ollama inference ─────────────────────
// Small context + small output = fast response, no timeouts.

// ─── Planner Prompt — Ollama is the sole dashboard architect.
// It receives live data context + full chart vocabulary and decides freely.
// NO hardcoded chart selection happens before this prompt runs.

const PLANNER_SYSTEM = `You are a world-class CFO analytics copilot. Given a user query and LIVE DATA from their accounting system, design the minimum set of accurate charts needed to answer the user's request. Output JSON only. No explanation.

AVAILABLE CHART TYPES — use ONLY these exact type/metric/grouping values:

LINE (trends over time):
  line/revenue/month        — monthly revenue trend
  bar/revenue/month         — monthly revenue trend (bar form when explicitly requested)
  line/outstanding/month    — monthly outstanding AR build-up
  line/paid/month           — monthly cash collected trend
  line/invoice_count/month  — monthly invoice volume trend
  line/overdue/month        — monthly overdue AR accumulation
  line/collection_rate/month — monthly collection rate (paid / invoiced)
  line/mom_growth/month     — month-on-month growth % (revenue)
  line/revenue/quarter      — quarterly revenue as trend line
  line/avg_invoice/month    — average invoice size trend
  line/dso/month            — days sales outstanding trend (avg days to pay)

BAR (ranked comparisons):
  bar/revenue/org           — total revenue per entity
  bar/revenue/quarter       — revenue per quarter
  bar/invoices/org          — invoice count per entity
  bar/outstanding/org       — outstanding balance per entity
  bar/overdue/org           — overdue exposure per entity
  bar/revenue/client        — total paid revenue per client
  bar/total_invoiced/client — lifetime gross billing per client
  bar/outstanding/client    — outstanding balance per client
  bar/overdue/client        — overdue exposure per client
  bar/invoices/client       — invoice count per client
  bar/avg_invoice/client    — average invoice size per client
  bar/paid/client           — cash collected per client
  bar/collection_rate/client — % collected (paid / invoiced) per client
  bar/overdue_rate/client    — % overdue (overdue / invoiced) per client
  bar/payment_days/bucket    — payment speed histogram (days to pay buckets)

PIE (proportional breakdowns):
  pie/revenue/client        — revenue share by client
  pie/revenue/provider      — revenue split by ERP system
  pie/invoices/status       — invoice count by status
  pie/outstanding/client    — outstanding concentration by client

METRIC (tiles):
  metric/venture/summary    — burn, runway, cash, efficiency
  metric/top5_revenue_share/summary — % of revenue from top 5 clients
  metric/collected_vs_outstanding/summary — % collected vs outstanding

TABLE (rows):
  table/invoices/list       — recent invoices (audit view)
  table/overdue/aging       — overdue invoice aging table (0–30 / 31–60 / 60+)
  table/payment_days/list   — per-invoice payment days list (issued → paid)
  table/payment_days/list   — per-invoice payment days (issued → paid) for a client or overall

TOOLS:
  revenue_trend             — monthly/quarterly revenue data
  entity_comparison         — revenue, invoices, overdue per entity
  invoice_breakdown         — invoice status analysis
  venture_metrics           — burn rate, cash, runway
  financial_summary         — overall totals and averages
  client_breakdown          — top clients by revenue (from gold table)
  client_financial_profile  — full per-client data: revenue, outstanding, overdue, counts, dates
  (payment_days and dso are served via metrics: table/payment_days/list, bar/payment_days/bucket, line/dso/month)

SPECIAL PARAMS (optional fields on a widget object):
- breakdown: "client" (ONLY supported on line/revenue/month and bar/revenue/month)
- topN: number (1–5). Only used when breakdown="client" (e.g. topN=2 for "top two clients")

RULES:
1. Read the LIVE DATA CONTEXT carefully — base your chart choices on the actual numbers
2. If the user explicitly asks for specific chart types (e.g. "line chart", "bar chart", "table") or an exact number of charts, obey exactly.
3. If the user does NOT specify charts, pick the best single chart (or at most 2-3) that answers the question with the least cognitive load.
4. Only add extra charts if they are strictly necessary to answer the question.
5. NEVER repeat the same metric+grouping twice
6. Title the dashboard and each chart specifically — not generic names
7. For client queries: prefer client_financial_profile tool + at least 1 client-grouping chart when relevant
8. For payment-speed questions (days to pay / payment days / paid after / DSO): include table/payment_days/list. If the user asks for a trend, add line/dso/month. If they ask for distribution, add bar/payment_days/bucket.
9. For trend queries: favour line charts; for comparisons: favour bar; for distribution: include a pie (except payment-days distribution uses bar/payment_days/bucket)
10. Never invent unavailable metrics. If the request cannot be answered with the available chart vocabulary, choose the closest accurate chart.

OUTPUT FORMAT (JSON only, no markdown):
Return ONLY candidates (you must provide 1-3 candidates):
{"candidates":[{"title":"Candidate A","tools":["tool1"],"widgets":[...]},{"title":"Candidate B","tools":[...],"widgets":[...]}]}

EXAMPLES:
Q: "who are my top clients" + 12 clients, $4.2M revenue, $45K overdue → {"title":"Top Client Revenue & Collection Intelligence","tools":["client_financial_profile","client_breakdown"],"widgets":[{"type":"bar","metric":"revenue","grouping":"client","title":"Top Clients by Total Revenue Collected"},{"type":"bar","metric":"outstanding","grouping":"client","title":"Outstanding Balance per Client"},{"type":"bar","metric":"overdue","grouping":"client","title":"Overdue Exposure per Client"},{"type":"pie","metric":"revenue","grouping":"client","title":"Revenue Concentration Risk"}]}
Q: "show overdue invoices" + $45K overdue, 8 clients → {"title":"AR Collection Risk Analysis","tools":["invoice_breakdown","client_financial_profile"],"widgets":[{"type":"bar","metric":"overdue","grouping":"client","title":"Overdue Exposure by Client"},{"type":"line","metric":"overdue","grouping":"month","title":"Overdue AR Accumulation Trend"},{"type":"pie","metric":"invoices","grouping":"status","title":"Invoice Status Breakdown"}]}
Q: "quarterly revenue breakdown" + 2 entities, $4.2M lifetime → {"title":"Quarterly Revenue Performance","tools":["revenue_trend","entity_comparison"],"widgets":[{"type":"bar","metric":"revenue","grouping":"quarter","title":"Quarterly Revenue Cadence"},{"type":"line","metric":"revenue","grouping":"month","title":"Monthly Revenue Within Quarters"},{"type":"bar","metric":"revenue","grouping":"org","title":"Revenue by Entity"}]}
Q: "compare entities" + 2 entities → {"title":"Entity Revenue Concentration","tools":["entity_comparison","financial_summary"],"widgets":[{"type":"bar","metric":"revenue","grouping":"org","title":"Revenue by Entity"},{"type":"bar","metric":"outstanding","grouping":"org","title":"Outstanding AR by Entity"},{"type":"bar","metric":"invoices","grouping":"org","title":"Invoice Volume by Entity"}]}
Q: "revenue trend" + strong growth → {"title":"Revenue Growth & Momentum Analysis","tools":["revenue_trend","financial_summary"],"widgets":[{"type":"line","metric":"revenue","grouping":"month","title":"Monthly Revenue Growth Trajectory"},{"type":"bar","metric":"revenue","grouping":"quarter","title":"Quarterly Revenue Acceleration"},{"type":"line","metric":"invoice_count","grouping":"month","title":"Invoice Volume Momentum"}]}
Q: "month wise revenue for my top two clients for last six months as a bar chart" → {"title":"Top Client Revenue Trend","tools":["client_financial_profile"],"widgets":[{"type":"bar","metric":"revenue","grouping":"month","breakdown":"client","topN":2,"title":"Top 2 Clients — Monthly Revenue"}]}
Q: "CFO board pack" + all data available → {"title":"Executive Financial Intelligence Dashboard","tools":["financial_summary","revenue_trend","entity_comparison","client_financial_profile"],"widgets":[{"type":"line","metric":"revenue","grouping":"month","title":"Revenue Growth Trajectory"},{"type":"bar","metric":"revenue","grouping":"client","title":"Top Client Revenue Ranking"},{"type":"bar","metric":"outstanding","grouping":"client","title":"Outstanding AR by Client"},{"type":"pie","metric":"invoices","grouping":"status","title":"Invoice Portfolio Health"}]}`;

const PLANNER_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          tools: { type: 'array', items: { type: 'string' } },
          widgets: {
            type: 'array',
            minItems: 1,
            maxItems: 8,
            items: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['line', 'bar', 'pie', 'metric', 'table'],
                },
                metric: { type: 'string' },
                grouping: { type: 'string' },
                title: { type: 'string' },
                breakdown: { type: 'string' },
                topN: { type: 'number' },
              },
              required: ['type', 'metric', 'grouping', 'title'],
            },
          },
        },
        required: ['title', 'widgets'],
      },
    },
  },
  required: ['candidates'],
} as const;

// ─── Dashboard Editor Prompt ──────────────────────────────────────────────────

const EDITOR_SYSTEM = `You are a precise financial dashboard editor. Apply the minimal change to satisfy the user's request.

AVAILABLE WIDGET TYPES (use ONLY these exact pairs):
LINE: revenue/month | outstanding/month | paid/month | invoice_count/month | overdue/month | collection_rate/month | mom_growth/month | revenue/quarter | avg_invoice/month
BAR:  revenue/month
BAR:  revenue/org | revenue/quarter | invoices/org | outstanding/org | overdue/org
      revenue/client | total_invoiced/client | outstanding/client | overdue/client | invoices/client | avg_invoice/client | paid/client
      collection_rate/client | overdue_rate/client
PIE:  invoices/status | revenue/provider | revenue/client | outstanding/client
METRIC: venture/summary | top5_revenue_share/summary | collected_vs_outstanding/summary
TABLE: invoices/list | overdue/aging

OUTPUT: Respond with ONLY valid JSON. Zero explanation. Zero markdown.

{
  "summary": "One sentence describing what changed (e.g., 'Added quarterly revenue bar chart')",
  "add": [
    { "title": "Widget title (max 45 chars)", "description": "One sentence insight", "type": "bar", "metric": "revenue", "grouping": "quarter" }
  ],
  "remove_indices": [],
  "modify": [
    { "index": 0, "title": "New title", "type": "line" }
  ]
}

Rules:
- "add": new widgets to insert. Use exact metric+grouping from the available list above.
- "remove_indices": 0-based indices of widgets to delete from the current list.
- "modify": change type, title, or description of an existing widget at that 0-based index.
- Total widgets after edit MUST be between 1 and 8.
- If the request is ambiguous, add the most relevant widget without removing anything.
- If asked to change a chart type, use "modify" with the correct "type" value.`;

const EDITOR_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    add: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          type: {
            type: 'string',
            enum: ['line', 'bar', 'pie', 'metric', 'table'],
          },
          metric: { type: 'string' },
          grouping: { type: 'string' },
        },
        required: ['title', 'description', 'type', 'metric', 'grouping'],
      },
    },
    remove_indices: { type: 'array', items: { type: 'integer' } },
    modify: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          title: { type: 'string' },
          type: {
            type: 'string',
            enum: ['line', 'bar', 'pie', 'metric', 'table'],
          },
          description: { type: 'string' },
        },
        required: ['index'],
      },
    },
  },
  required: ['summary', 'add', 'remove_indices', 'modify'],
} as const;

// ─── Synthesis Prompt ─────────────────────────────────────────────────────────

const SYNTHESIZER_SYSTEM = `You are NumeriQ. Respond with 2-3 SHORT sentences only.

Tell the user:
1. What dashboard was built and how many charts
2. What the charts show (one phrase each)

Example: "Built your **Overdue AR Analysis** dashboard with 2 charts — an overdue trend line showing monthly AR build-up, and an invoice status pie breaking down your collection efficiency. Your data is live."

RULES:
- Maximum 3 sentences. No headers. No bullet points. No financial analysis.
- Never invent numbers. Never give advice.
- If dashboard was edited: mention what changed instead.`;

// ─── AgentService ─────────────────────────────────────────────────────────────

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly OLLAMA_URL: string;
  private readonly OLLAMA_MODEL: string;
  private readonly analyticsDb: string;
  private analyticsSchemaEnsured = false;
  private analyticsSchemaEnsurePromise: Promise<void> | null = null;

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    @Inject(CLICKHOUSE_ANALYTICS_TOKEN)
    private readonly clickhouse: ClickHouseClient,
    private readonly orgContext: OrganizationContextService,
  ) {
    this.OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
    this.OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3:latest';
    this.analyticsDb = process.env.CLICKHOUSE_ANALYTICS_DB || 'analytics';
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
        ];
        for (const q of migrations) await safeDDL(q);

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

    return {
      status: ollamaOnline ? 'operational' : 'degraded',
      advisory: ollamaOnline
        ? `NumeriQ Agent Layer ready — ${this.OLLAMA_MODEL}`
        : `Ollama offline — check ${this.OLLAMA_URL}`,
      mode: 'agentic-tool-use',
      ollama: ollamaOnline,
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
    if (!dashboard) return null;
    return {
      id: dashboard.id,
      title: dashboard.title,
      description: dashboard.description,
      charts: dashboard.widgets.map((w) => ({
        id: w.id,
        title: w.title,
        description: (w.chartConfig as any)?.description ?? null,
        type: w.chartType,
        config:
          typeof w.queryConfig === 'object' && w.queryConfig
            ? (w.queryConfig as Record<string, string>)
            : { metric: 'revenue', grouping: 'month' },
        layoutIndex: w.displayOrder,
      })),
    };
  }

  // ─── Metric Data ──────────────────────────────────────────────────────────

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
  ) {
    await this.ensureAnalyticsSchema();
    const scope = await this.getOrgScope(organizationId, role, orgId);
    if (scope.connectionIds.length === 0) return { data: [] };
    // Enforce member scoping on read endpoints too: never mix entities for non-admins.
    if (role !== 'ADMIN' && !orgId && scope.externalOrgIds.length > 1)
      return { data: [] };
    const time = this.timeWhereOn('issued_at', range);
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
    const clientListParam = clientNamesLower ? { clientNames: clientNamesLower } : {};
    const entity = orgId ? `AND org_id = {orgId:String}` : '';
    const entityParam = orgId ? { orgId } : {};
    const rangeEndExpr = (() => {
      if (
        range?.kind === 'BETWEEN_DATES' &&
        /^\d{4}-\d{2}-\d{2}$/.test(range.end)
      ) {
        return `toDateTime('${range.end} 23:59:59')`;
      }
      return 'now()';
    })();

    // For Xero, the Invoices endpoint contains both sales (ACCREC) and bills (ACCPAY).
    // We prefer ACCREC, but older ingestions may have blank invoice_type; don't exclude all data in that case.
    const arFilter = `AND total_amount > 0 AND (provider != 'xero' OR invoice_type = '' OR lowerUTF8(invoice_type) = 'accrec')`;

    if (metric === 'venture') {
      const rows = await this.queryRows<any>(
        `SELECT
           coalesce(sum(total_amount), 0) AS total_revenue,
           coalesce(sumIf(total_amount, lowerUTF8(status) NOT IN ('paid','closed')), 0) AS open_amount
         FROM ${this.analyticsDb}.fact_accounting_invoices
         WHERE connection_id IN ({connectionIds:Array(String)})
           ${provider}
           ${client}
           ${clientListFact}
           ${entity}
           ${time}`,
        {
          connectionIds: scope.connectionIds,
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
           FROM ${this.analyticsDb}.fact_accounting_invoices
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
           FROM ${this.analyticsDb}.dim_clients FINAL
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
           FROM ${this.analyticsDb}.dim_clients FINAL
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
         WHERE connection_id IN ({connectionIds:Array(String)})
           ${provider}
           ${client}
           ${time}
         GROUP BY status ORDER BY total_amount DESC`,
        {
          connectionIds: scope.connectionIds,
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
	         WHERE connection_id IN ({connectionIds:Array(String)})
	           ${provider}
	           ${client}
	           ${time}
	         ORDER BY issued_at DESC
	         LIMIT 50`,
        {
          connectionIds: scope.connectionIds,
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
	             max(payment_at) AS last_paid_at,
	             sum(amount) AS paid_to_date
	           FROM ${this.analyticsDb}.fact_accounting_payment_applications
	           WHERE org_id IN ({externalOrgIds:Array(String)})
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
        },
      );
      return { data: rows };
    }

    // ── dso/month (line) ─────────────────────────────────────────────────────
    if (metric === 'dso' && grouping === 'month') {
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

    // ── overdue/aging (table) ────────────────────────────────────────────────
    if (metric === 'overdue' && grouping === 'aging') {
      if (scope.connectionIds.length === 0) return { data: [] };
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
           WHERE connection_id IN ({connectionIds:Array(String)})
             ${time}
             ${arFilter}
             AND issued_at IS NOT NULL
         ),
         paid AS (
           SELECT
             invoice_external_id,
             sum(amount) AS paid_to_date
           FROM ${this.analyticsDb}.fact_accounting_payment_applications
           WHERE connection_id IN ({connectionIds:Array(String)})
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
        { connectionIds: scope.connectionIds },
      );
      return { data: rows };
    }

    if (metric === 'invoices' && grouping === 'org') {
      const rows = await this.queryRows<any>(
        `SELECT coalesce(org_name, org_id) AS org_name, count() AS total_count, coalesce(sum(total_amount), 0) AS total_amount
         FROM ${this.analyticsDb}.fact_accounting_invoices
         WHERE connection_id IN ({connectionIds:Array(String)})
           ${provider}
           ${entity}
           ${time}
         GROUP BY org_name, org_id ORDER BY total_count DESC LIMIT 10`,
        {
          connectionIds: scope.connectionIds,
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
         WHERE connection_id IN ({connectionIds:Array(String)})
           ${provider}
           ${entity}
           ${time}
           ${arFilter}
           AND issued_at IS NOT NULL
         GROUP BY provider ORDER BY total_revenue DESC`,
        {
          connectionIds: scope.connectionIds,
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

    // ── revenue/month (default) ───────────────────────────────────────────────
    // Note: breakdown="client" is handled by a separate branch that pivots top-N clients.
    if (
      metric === 'revenue' &&
      grouping === 'month' &&
      breakdown !== 'client'
    ) {
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
      const rows = await this.queryRows<any>(
        `WITH invoices AS (
           SELECT
             invoice_external_id,
             toDecimal64(total_amount, 4) AS total_amount,
             issued_at,
             due_at
           FROM ${this.analyticsDb}.fact_accounting_invoices
           WHERE org_id IN ({externalOrgIds:Array(String)})
             ${provider}
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
        { externalOrgIds: scope.externalOrgIds, ...providerParam },
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
	           FROM ${this.analyticsDb}.dim_clients FINAL
	           WHERE org_id IN ({externalOrgIds:Array(String)})
	             ${clientListDim}
	             ${entity}
	           GROUP BY client_name
	           ORDER BY total_collected DESC
	           LIMIT 30`,
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
	           FROM ${this.analyticsDb}.dim_clients FINAL
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

    // ── revenue/month broken down by client (top N) ─────────────────────────
    // Returns multi-series rows: { name: "MM/YY", "<Client A>": 123, "<Client B>": 456 }
    if (
      metric === 'revenue' &&
      grouping === 'month' &&
      breakdown === 'client'
    ) {
      if (scope.externalOrgIds.length === 0) return { data: [] };
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
           FROM ${this.analyticsDb}.fact_accounting_invoices
           WHERE org_id IN ({externalOrgIds:Array(String)})
             ${provider}
             ${client}
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
          ...entityParam,
          ...(explicitClients ? { clientNames: explicitClients } : {}),
        },
      );

      // Pivot in JS for Recharts multi-series.
      const map = new Map<string, any>();
      for (const r of rows) {
        const key = String(r.month);
        const existing = map.get(key) ?? { name: key };
        existing[String(r.client_name)] = this.num(r.collected);
        map.set(key, existing);
      }
      return { data: Array.from(map.values()) };
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
             FROM ${this.analyticsDb}.fact_accounting_invoices
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
             FROM ${this.analyticsDb}.dim_clients FINAL
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
         FROM ${this.analyticsDb}.dim_clients FINAL
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
      const rows = await this.queryRows<any>(
        `WITH invoices AS (
           SELECT
             invoice_external_id,
             toDecimal64(total_amount, 4) AS total_amount,
             issued_at,
             due_at
           FROM ${this.analyticsDb}.fact_accounting_invoices
           WHERE org_id IN ({externalOrgIds:Array(String)})
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
        { externalOrgIds: scope.externalOrgIds },
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
           FROM ${this.analyticsDb}.fact_accounting_invoices
           WHERE org_id IN ({externalOrgIds:Array(String)})
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
           AND p.payment_at IS NOT NULL
           AND p.payment_at <= ${rangeEndExpr}
           AND p.invoice_external_id != ''
         GROUP BY month, month_start
         ORDER BY month_start ASC
         LIMIT 36`,
        { externalOrgIds: scope.externalOrgIds },
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
      if (scope.connectionIds.length === 0) return { data: [] };
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
           WHERE connection_id IN ({connectionIds:Array(String)})
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
           WHERE connection_id IN ({connectionIds:Array(String)})
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
        { connectionIds: scope.connectionIds, ...entityParam },
      );
      return {
        data: rows.map((r) => ({
          name: (r.org_name as string) || 'Unknown',
          value: this.num(r.outstanding),
        })),
      };
    }

    if (metric === 'overdue' && grouping === 'org') {
      if (scope.connectionIds.length === 0) return { data: [] };
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
           WHERE connection_id IN ({connectionIds:Array(String)})
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
           WHERE connection_id IN ({connectionIds:Array(String)})
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
        { connectionIds: scope.connectionIds, ...entityParam },
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
             FROM ${this.analyticsDb}.dim_clients FINAL
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
         FROM ${this.analyticsDb}.dim_clients FINAL
         WHERE org_id IN ({externalOrgIds:Array(String)})
           ${entity}
           ${clientListDim}
           AND client_name != ''
         ORDER BY total_invoiced DESC LIMIT 15`,
        { externalOrgIds: scope.externalOrgIds, ...clientListParam, ...entityParam },
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
             FROM ${this.analyticsDb}.dim_clients FINAL
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
         FROM ${this.analyticsDb}.dim_clients FINAL
         WHERE org_id IN ({externalOrgIds:Array(String)})
           ${entity}
           ${clientListDim}
           AND client_name != '' AND invoice_count > 0
         ORDER BY avg_invoice_amount DESC LIMIT 15`,
        { externalOrgIds: scope.externalOrgIds, ...clientListParam, ...entityParam },
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
           FROM ${this.analyticsDb}.dim_clients FINAL
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
	           FROM ${this.analyticsDb}.dim_clients FINAL
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
	           FROM ${this.analyticsDb}.dim_clients FINAL
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
	           FROM ${this.analyticsDb}.dim_clients FINAL
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
	           FROM ${this.analyticsDb}.dim_clients FINAL
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
	           FROM ${this.analyticsDb}.dim_clients FINAL
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
	           FROM ${this.analyticsDb}.dim_clients FINAL
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

    // Default: revenue by month
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
      if (/^\s*use\s+(client|entity)(?:\s+(?:a|b|1|2))?\s*:/i.test(queryText)) {
        const recentUsers = await this.prisma.agentChatMessage.findMany({
          where: {
            sessionId: currentSession.id,
            organizationId,
            role: 'user',
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
        });
        const prior = recentUsers
          .slice(1) // exclude current message
          .map((m) => String(m.content ?? '').trim())
          .filter(Boolean);

        const priorDirectives: string[] = [];
        let base: string | null = null;
        for (const t of prior) {
          if (/^\d+$/.test(t)) continue;
          if (/^\s*use\s+(client|entity)(?:\s+(?:a|b|1|2))?\s*:/i.test(t)) {
            priorDirectives.push(t);
            continue;
          }
          base = t;
          break;
        }

        const normalize = (s: string) => s.trim().toLowerCase();
        const uniq = (arr: string[]) => {
          const seen = new Set<string>();
          const out: string[] = [];
          for (const x of arr) {
            const k = normalize(x);
            if (seen.has(k)) continue;
            seen.add(k);
            out.push(x.trim());
          }
          return out;
        };

        const merged = uniq([
          ...(base ? [base] : []),
          ...priorDirectives.reverse(), // chronological
          queryText.trim(),
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
      // Runs as a fast parallel pre-flight — does NOT block the phase status emit above.
      const scope = await this.getOrgScope(organizationId, role);
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
          const connRows = await this.prisma.erpConnection.findMany({
            where: { id: { in: scope.connectionIds }, status: 'ACTIVE' },
            select: {
              externalOrganizationId: true,
              displayName: true,
              metadata: true,
              provider: true,
            },
          });
          const options = connRows
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
              return {
                orgId,
                orgName,
                provider: String(r.provider ?? '').toLowerCase(),
              };
            })
            .filter(
              (o) =>
                o.orgId &&
                o.orgName &&
                (!spec.providerHint || o.provider === spec.providerHint),
            )
            .slice(0, 8);

          if (options.length >= 2) {
            const clarification: ClarificationPrompt = {
              reason: 'ENTITY_REQUIRED_FOR_CLIENTS',
              question: 'Which entity should I use for this client analysis?',
              options: options.map((o) => ({
                label: o.orgName,
                value: `Use entity: ${o.orgId}`,
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
              value: `Use entity: ${c.orgId}`,
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
          const connRows = await this.prisma.erpConnection.findMany({
            where: { id: { in: scope.connectionIds }, status: 'ACTIVE' },
            select: {
              externalOrganizationId: true,
              displayName: true,
              metadata: true,
              provider: true,
            },
          });
          const entities = connRows
            .map((r) => {
              const id = String(r.externalOrganizationId ?? '').trim();
              const meta = (r.metadata as Record<string, any>) || {};
              const name = String(
                r.displayName ??
                  meta.orgName ??
                  meta.companyName ??
                  meta.companyId ??
                  id,
              ).trim();
              return {
                orgId: id,
                orgName: name,
                provider: String(r.provider ?? '').toLowerCase(),
              };
            })
            .filter(
              (e) =>
                e.orgId &&
                e.orgName &&
                (!spec.providerHint || e.provider === spec.providerHint),
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
                value: `Use entity: ${e.orgId}`,
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
              .map(
                (l) =>
                  l.match(/^use\s+client\s+(?:a|1)\s*[:\-]\s*(.+)$/i)?.[1]?.trim(),
              )
              .find(Boolean) ?? null;
          const directiveB =
            lines
              .map(
                (l) =>
                  l.match(/^use\s+client\s+(?:b|2)\s*[:\-]\s*(.+)$/i)?.[1]?.trim(),
              )
              .find(Boolean) ?? null;

          const inferred = this.extractCompareClients(queryText);
          // If the user explicitly chose B (but not A), don't treat it as A.
          const clientA =
            directiveA ??
            (directiveB ? null : inferred?.[0] ?? null);
          const clientB = directiveB ?? inferred?.[1] ?? null;

          const hasA = Boolean(clientA);
          const hasB = Boolean(clientB);

          // We require entity scoping for client comparisons.
          const scopeForPick: OrgScope =
            spec.entityFilter?.orgId &&
            scope.externalOrgIds.includes(spec.entityFilter.orgId)
              ? {
                  connectionIds: scope.connectionIds,
                  externalOrgIds: [spec.entityFilter.orgId],
                }
              : scope;

          if (scopeForPick.externalOrgIds.length > 0 && (!hasA || !hasB)) {
            const rows = await this.queryRows<any>(
              `SELECT
                 coalesce(nullIf(client_name, ''), '') AS client_name,
                 sum(total_invoiced) AS total_invoiced
               FROM ${this.analyticsDb}.dim_clients FINAL
               WHERE org_id IN ({externalOrgIds:Array(String)})
                 AND client_name != ''
               GROUP BY client_name
               ORDER BY total_invoiced DESC
               LIMIT 25`,
              { externalOrgIds: scopeForPick.externalOrgIds },
            );
            const clients = rows
              .map((r) => String(r.client_name ?? '').trim())
              .filter(Boolean)
              .slice(0, 20);

            if (clients.length >= 2) {
              if (!hasA) {
                const clarification: ClarificationPrompt = {
                  reason: 'COMPARE_CLIENT_PICK_A',
                  question: 'Pick the first client to compare (or type a name):',
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
                  question: 'Pick the second client to compare (or type a name):',
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
      const clarification = this.getClarificationPrompt(queryText, intent);
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
        const [resolvedPlan, resolvedEdit] = await Promise.all([
          this.generatePlan(
            queryText,
            conversationHistory,
            activeDashboard,
            dataContext,
          ),
          this.generateEditPlan(activeDashboard, queryText),
        ]);
        plan = resolvedPlan;
        plan.should_generate_dashboard = false; // We're editing, not creating
        editPlan = resolvedEdit;
      } else {
        plan = await this.generatePlan(
          queryText,
          conversationHistory,
          activeDashboard,
          dataContext,
        );
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

          await logEvent('DASHBOARD_UPDATED', {
            dashboardId,
            summary: editPlan.summary,
          });
          yield this.chunk('dashboard_updated', {
            dashboardId,
            title: updated.title,
            summary: editPlan.summary,
            widgetCount: updated.widgetCount,
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
          const dashboard = await this.prisma.dashboard.create({
            data: {
              organizationId,
              ownerId: userId,
              title: plan.dashboard.title || this.deriveQueryTitle(queryText),
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

          const widgets =
            plan.dashboard.widgets.length > 0
              ? plan.dashboard.widgets
              : this.queryAwareFallbackWidgets(queryText);

          const compareClients = this.extractCompareClients(queryText);
          const shouldUseCompareClients =
            /\bcompare\b/i.test(queryText) &&
            /\b(client|clients|customer|customers|contact|contacts)\b/i.test(
              queryText,
            ) &&
            !spec.wantsTopClients &&
            Array.isArray(compareClients) &&
            compareClients.length >= 2;

          await this.prisma.dashboardWidget.createMany({
            data: widgets.map((w) => {
              const wantsClientPair =
                shouldUseCompareClients &&
                Array.isArray(compareClients) &&
                compareClients.length >= 2;

              const applyClientPair =
                wantsClientPair &&
                (w.grouping === 'client' ||
                  (w.metric === 'revenue' && w.grouping === 'month'));

              const breakdown =
                wantsClientPair && w.metric === 'revenue' && w.grouping === 'month'
                  ? 'client'
                  : ((w as any)?.breakdown ?? null);

              return {
                organizationId,
                dashboardId: dashboard.id,
                title: w.title,
                chartType: w.type,
                queryConfig: {
                  metric: w.metric,
                  grouping: w.grouping,
                  timeRange: spec.timeRange ?? null,
                  providerHint: spec.providerHint ?? null,
                  clientName: spec.clientFilter?.name ?? null,
                  clientNames: applyClientPair ? compareClients : null,
                  orgId: spec.entityFilter?.orgId ?? null,
                  orgName: spec.entityFilter?.orgName ?? null,
                  breakdown,
                  topN: applyClientPair ? null : ((w as any)?.topN ?? null),
                } as Prisma.InputJsonValue,
                chartConfig: {
                  description: w.description,
                } as Prisma.InputJsonValue,
                displayOrder: w.display_order,
              };
            }),
          });

          // Link request to the generated dashboard
          await this.prisma.agentDashboardRequest.update({
            where: { id: request.id },
            data: { generatedDashboardId: dashboard.id },
          });

          actualWidgetCount = widgets.length;
          await logEvent('DASHBOARD_CREATED', {
            dashboardId,
            widgetCount: widgets.length,
          });
          yield this.chunk('dashboard_created', {
            dashboardId,
            title: dashboard.title,
            description: plan.dashboard.description,
            widgetCount: widgets.length,
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

      const synthesisMessages = this.buildSynthesisMessages(
        queryText,
        toolResults,
        plan,
        dashboardId,
        dashboardTitle,
        intent,
        editPlan,
        actualWidgetCount,
      );

      void synthesisMessages; // reserved for future "LLM rewrite" mode; deterministic output avoids hallucination.

      const fullResponse = this.composeDeterministicBrief(
        spec,
        toolResults,
        plan,
        {
          intent,
          dashboardTitle,
          widgetCount: actualWidgetCount,
          editSummary: editPlan?.summary ?? null,
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
    if (asksForChart) return 'CREATE_DASHBOARD';

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

  // ─── Conversation History ────────────────────────────────────────────────

  private async getConversationHistory(
    sessionId: string,
    organizationId: string,
  ): Promise<string> {
    const messages = await this.prisma.agentChatMessage.findMany({
      where: { sessionId, organizationId },
      orderBy: { createdAt: 'desc' },
      take: 6,
    });

    if (messages.length <= 1) return '(No prior conversation in this session)';

    return messages
      .reverse()
      .slice(0, -1) // Exclude the current user message (just persisted)
      .map((m) => {
        const role = m.role.toUpperCase();
        const preview =
          m.content.length > 180 ? m.content.slice(0, 180) + '...' : m.content;
        return `${role}: ${preview}`;
      })
      .join('\n');
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
      .find(Boolean);
    const b2 = lines
      .map((l) =>
        l.match(/^use\s+client\s+(?:b|2)\s*[:\-]\s*(.+)$/i)?.[1]?.trim(),
      )
      .find(Boolean);
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
      type: 'line' | 'bar' | 'pie' | 'metric' | 'table',
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
        has(/month|monthly|month[-\s]?wise|trend|over\s+time|last\s+\d+\s+months?/)
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

      const [summary, topClients, entities] = await Promise.allSettled([
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
           FROM ${this.analyticsDb}.fact_accounting_invoices
           WHERE connection_id IN ({connectionIds:Array(String)})
             ${client}
             ${entity}
             AND issued_at IS NOT NULL
             ${time}`,
          {
            connectionIds: resolvedScope.connectionIds,
            ...clientParam,
            ...entityParam,
          },
        ),
        this.queryRows<any>(
          `SELECT client_name, round(total_invoiced, 0) AS billed, round(total_overdue, 0) AS overdue
           FROM ${this.analyticsDb}.dim_clients FINAL
           WHERE org_id IN ({orgIds:Array(String)}) AND client_name != ''
           ${clientDim}
           ${entityFilter ? `AND org_id = {orgId:String}` : ''}
           ORDER BY total_invoiced DESC
           LIMIT ${clientFilter ? 1 : 5}`,
          { orgIds, ...clientParam, ...entityParam },
        ),
        this.queryRows<any>(
          `SELECT coalesce(org_name, org_id) AS org_name, count() AS invoice_count
           FROM ${this.analyticsDb}.fact_accounting_invoices
           WHERE connection_id IN ({connectionIds:Array(String)})
             ${client}
             ${entity}
             ${time}
           GROUP BY org_name ORDER BY invoice_count DESC LIMIT 5`,
          {
            connectionIds: resolvedScope.connectionIds,
            ...clientParam,
            ...entityParam,
          },
        ),
      ]);

      const s =
        (summary.status === 'fulfilled' ? summary.value[0] : null) ?? {};
      const clients = topClients.status === 'fulfilled' ? topClients.value : [];
      const ents = entities.status === 'fulfilled' ? entities.value : [];

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

      return [
        `LIVE DATA CONTEXT:`,
        ...(clientFilter ? [`- Client scope: ${clientFilter.name}`] : []),
        ...(entityFilter ? [`- Entity scope: ${entityFilter.orgName}`] : []),
        `- Invoices: ${this.num(s.total_invoices)} total | Period: ${s.date_from ?? '?'} to ${s.date_to ?? '?'}`,
        `- Revenue: $${this.fmtK(this.num(s.total_revenue))} | Outstanding: $${this.fmtK(this.num(s.total_outstanding))} | Overdue: $${this.fmtK(this.num(s.total_overdue))}`,
        `- Clients: ${clientCount}${topStr ? ` | Top: ${topStr}` : ''}`,
        `- Entities: ${entStr || 'None connected'}`,
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
       FROM ${this.analyticsDb}.dim_clients FINAL
       WHERE org_id IN ({externalOrgIds:Array(String)})
         AND client_name != ''
       GROUP BY client_name
       ORDER BY total_invoiced DESC
       LIMIT 500`,
      { externalOrgIds: scope.externalOrgIds },
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

    // Prefer Prisma connections list (stable even if invoices are empty / not yet synced).
    const connRows = await this.prisma.erpConnection.findMany({
      where: {
        id: { in: scope.connectionIds },
        status: 'ACTIVE',
      },
      select: {
        externalOrganizationId: true,
        displayName: true,
        metadata: true,
        provider: true,
      },
    });

    const connCandidates = connRows
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
          r.orgName &&
          (!providerHint || r.provider === providerHint),
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

    const connScored = connRows
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
        const score = this.scoreEntityNameMatch(
          mentionNorm,
          this.normalizeEntityName(orgName),
        );
        const provider = String(r.provider ?? '')
          .toLowerCase()
          .trim();
        return { orgId, orgName, score, provider };
      })
      .filter(
        (r) =>
          r.orgId &&
          r.orgName &&
          r.score > 0 &&
          (!providerHint || r.provider === providerHint),
      )
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map((r) => ({ orgId: r.orgId, orgName: r.orgName, score: r.score }));

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
       WHERE connection_id IN ({connectionIds:Array(String)})
         ${providerFilter}
         AND org_id != ''
       GROUP BY org_id
       ORDER BY total_amount DESC
       LIMIT 200`,
      {
        connectionIds: scope.connectionIds,
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
    const requiredTypes: Array<'line' | 'bar' | 'pie' | 'metric' | 'table'> =
      [];

    const addType = (t: (typeof requiredTypes)[number]) => {
      if (!requiredTypes.includes(t)) requiredTypes.push(t);
    };

    if (
      /\bline\s*chart\b|\bline\s*graph\b|\bline\b/.test(q) &&
      /\bchart\b|\bgraph\b/.test(q)
    )
      addType('line');
    if (
      /\bbar\s*chart\b|\bbarchart\b|\bbar\s*graph\b|\bstacked\s+bar\b|\bstacked\s+bars\b/.test(
        q,
      )
    )
      addType('bar');
    if (/\bpie\s+chart\b|\bpie\s+graph\b/.test(q)) addType('pie');
    if (/\btable\b|\btabular\b/.test(q)) addType('table');
    if (/\bmetric\s+tile\b|\bmetric\b/.test(q) && /\btile\b/.test(q))
      addType('metric');

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

  // ─── Plan Generation — Ollama is the sole dashboard architect ───────────────
  // Ollama sees live data context + full chart vocabulary and decides freely.
  // selectWidgetsForQuery is only called if Ollama completely fails.

  private async generatePlan(
    query: string,
    conversationHistory: string,
    activeDashboard: ActiveDashboard | null,
    dataContext: string,
  ): Promise<AgentPlan> {
    const spec = parseQuerySpec(query);
    const constraints = this.parseExplicitChartConstraints(query);
    const compareClients = this.extractCompareClients(query);
    const wantsCompareClients =
      /\bcompare\b/i.test(query) &&
      /\b(client|clients|customer|customers|contact|contacts)\b/i.test(query) &&
      !spec.wantsTopClients &&
      !!compareClients &&
      compareClients.length >= 2;
    const mentionsRevenue =
      /\b(revenue|sales|invoiced|billed|collected|paid)\b/i.test(query);

    const inferImplicitMaxWidgets = (): number | null => {
      if (constraints?.exactCount && Number.isFinite(constraints.exactCount))
        return constraints.exactCount;

      const q = query.trim();
      const lower = q.toLowerCase();

      // If the user is clearly asking for a dashboard/pack, allow multiple charts.
      if (
        /\b(dashboard|board pack|pack|suite|analysis|overview|signals|deep dive)\b/i.test(
          lower,
        )
      )
        return 4;

      // If the prompt contains multiple enumerated questions, allow more charts.
      const lines = q
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const numbered = lines.filter((l) => /^\d+[\).\]]\s+/.test(l));
      if (numbered.length >= 2)
        return Math.min(8, Math.max(2, numbered.length));

      // If they explicitly mention "charts" plural without specifying a number.
      if (/\bcharts\b|\bgraphs\b|\bwidgets\b/i.test(lower)) return 3;

      // Default: for a single natural-language question, prefer 1 chart.
      return 1;
    };

    const applyConstraints = (
      widgets: AgentPlan['dashboard']['widgets'],
    ): AgentPlan['dashboard']['widgets'] => {
      if (!constraints) return widgets;
      let out = widgets.slice();

      if (constraints.requiredTypes && constraints.requiredTypes.length > 0) {
        const req = constraints.requiredTypes[0]!;
        if (out[0] && out[0].type !== req) {
          const canConvert = VALID_WIDGETS.some(
            (v) =>
              v.type === req &&
              v.metric === out[0]!.metric &&
              v.grouping === out[0]!.grouping,
          );
          if (canConvert) out[0] = { ...out[0]!, type: req };
        }
        out = out.filter((w) => constraints.requiredTypes!.includes(w.type));
      }

      if (
        typeof constraints.exactCount === 'number' &&
        Number.isFinite(constraints.exactCount)
      ) {
        out = out.slice(
          0,
          Math.max(1, Math.min(8, Math.floor(constraints.exactCount))),
        );
      }

      return out.map((w, i) => ({ ...w, display_order: i }));
    };

    const applyImplicitMax = (
      widgets: AgentPlan['dashboard']['widgets'],
    ): AgentPlan['dashboard']['widgets'] => {
      const max = inferImplicitMaxWidgets();
      if (!max || !Number.isFinite(max)) return widgets;
      return widgets
        .slice(0, Math.max(1, Math.min(8, Math.floor(max))))
        .map((w, i) => ({
          ...w,
          display_order: i,
        }));
    };

    // Emergency fallback — only used if Ollama crashes/times out
    const fallback: AgentPlan = {
      tools_to_execute: this.selectToolsForQuery(query),
      should_generate_dashboard: true,
      dashboard: {
        title: this.deriveQueryTitle(query),
        description: 'AI-generated financial intelligence dashboard',
        widgets: applyImplicitMax(
          applyConstraints(this.selectWidgetsForQuery(query, activeDashboard)),
        ),
      },
      analysis_focus: query,
    };

    // If the model backend is offline, do not pretend with canned dashboards.
    // Return a "no-dashboard" plan so the user sees the real problem immediately.
    try {
      const res = await fetch(`${this.OLLAMA_URL}/api/tags`, {
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) {
        return {
          tools_to_execute: this.selectToolsForQuery(query),
          should_generate_dashboard: false,
          dashboard: {
            title: this.deriveQueryTitle(query),
            description: `LLM backend offline (${this.OLLAMA_URL}). Start Ollama or configure OLLAMA_URL/OLLAMA_MODEL.`,
            widgets: [],
          },
          analysis_focus: query,
        };
      }
    } catch {
      return {
        tools_to_execute: this.selectToolsForQuery(query),
        should_generate_dashboard: false,
        dashboard: {
          title: this.deriveQueryTitle(query),
          description: `LLM backend offline (${this.OLLAMA_URL}). Start Ollama or configure OLLAMA_URL/OLLAMA_MODEL.`,
          widgets: [],
        },
        analysis_focus: query,
      };
    }

    const contextBlock = activeDashboard
      ? `${dataContext}\n\nCURRENT DASHBOARD: "${activeDashboard.title}" — pick DIFFERENT and MORE RELEVANT charts.`
      : dataContext;

    const historyBlock =
      conversationHistory &&
      !conversationHistory.includes('(No prior conversation')
        ? `\n\nRECENT CONVERSATION (for context):\n${conversationHistory}`
        : '';

    const userMsg = `${contextBlock}${historyBlock}\n\nUSER QUERY: "${query}"`;

    try {
      const controller = new AbortController();
      // 5 minute ceiling — user explicitly said "if it takes time, fine"
      const timer = setTimeout(() => controller.abort(), 300_000);

      const response = await fetch(`${this.OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.OLLAMA_MODEL,
          messages: [
            { role: 'system', content: PLANNER_SYSTEM },
            { role: 'user', content: userMsg },
          ],
          stream: false,
          format: PLANNER_SCHEMA,
          options: {
            num_ctx: 8192, // llama3 native max — full context window
            num_predict: -1, // unlimited — let model finish naturally, no truncation
            temperature: 0.2, // near-deterministic, best JSON quality
            top_p: 0.8,
            top_k: 20,
            repeat_penalty: 1.05,
            stop: ['<|start_header_id|>', '<|end_header_id|>', '<|eot_id|>'],
          },
        }),
      });
      clearTimeout(timer);

      if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);

      const body = (await response.json()) as {
        message?: { content?: string };
      };
      const raw = (body.message?.content ?? '')
        .replace(/```json|```/g, '')
        .trim();
      const parsed = JSON.parse(raw) as any;

      const candidates: Array<{
        title?: string;
        tools?: string[];
        widgets?: Array<{
          type: string;
          metric: string;
          grouping: string;
          title?: string;
        }>;
      }> = Array.isArray(parsed?.candidates)
        ? parsed.candidates
        : [
            {
              title: parsed?.title,
              tools: parsed?.tools,
              widgets: parsed?.widgets,
            },
          ];

      const buildCandidate = (cand: (typeof candidates)[number]) => {
        type PlannedWidget = AgentPlan['dashboard']['widgets'][number];
        const validWidgets = (cand.widgets ?? [])
          .filter((w) =>
            VALID_WIDGETS.some(
              (v) =>
                v.type === w.type &&
                v.metric === w.metric &&
                v.grouping === w.grouping,
            ),
          )
          .filter(
            (w, i, arr) =>
              // Enforce uniqueness: never repeat exact metric+grouping(+breakdown) within a single dashboard.
              arr.findIndex(
                (x: any) =>
                  x.metric === w.metric &&
                  x.grouping === w.grouping &&
                  String((x as any).breakdown ?? '') ===
                    String((w as any).breakdown ?? ''),
              ) === i,
          )
          .slice(0, 8)
          .map((w: any, i) => {
            const breakdown =
              typeof w.breakdown === 'string' ? String(w.breakdown) : undefined;
            const topN = Number.isFinite(Number(w.topN))
              ? Number(w.topN)
              : undefined;

            const normalizedBreakdown: 'client' | undefined =
              breakdown === 'client' &&
              w.metric === 'revenue' &&
              w.grouping === 'month'
                ? 'client'
                : undefined;

            const normalizedTopN = (() => {
              if (!normalizedBreakdown) return undefined;
              const requested = Number.isFinite(topN as number)
                ? (topN as number)
                : typeof spec.topN === 'number'
                  ? spec.topN
                  : 2;
              return Math.max(1, Math.min(5, Math.floor(requested)));
            })();

            const out: PlannedWidget = {
              title: w.title ?? `${w.metric} ${w.type}`,
              description: '',
              type: w.type as 'line' | 'bar' | 'pie' | 'metric' | 'table',
              metric: w.metric,
              grouping: w.grouping,
              display_order: i,
            };
            if (normalizedBreakdown) out.breakdown = normalizedBreakdown;
            if (
              typeof normalizedTopN === 'number' &&
              Number.isFinite(normalizedTopN)
            )
              out.topN = normalizedTopN;
            return out;
          });

        // If the model fails to select any valid widgets, fall back deterministically.
        // This is a safety net only — we do NOT auto-add extra charts beyond what was requested.
        if (validWidgets.length === 0) {
          const filler = applyConstraints(
            this.selectWidgetsForQuery(query, activeDashboard),
          )
            .slice(0, 2)
            .filter((w) =>
              VALID_WIDGETS.some(
                (v) =>
                  v.type === w.type &&
                  v.metric === w.metric &&
                  v.grouping === w.grouping,
              ),
            )
            .map((w, i) => ({ ...w, display_order: i }));
          validWidgets.push(...filler);
        }

        const validTools = (cand.tools ?? []).filter((t) =>
          [
            'revenue_trend',
            'entity_comparison',
            'invoice_breakdown',
            'venture_metrics',
            'financial_summary',
            'client_breakdown',
            'client_financial_profile',
          ].includes(t),
        );

        const inferredTools =
          validTools.length > 0
            ? validTools
            : this.deriveToolsFromWidgets(validWidgets, query);

        return {
          title:
            cand.title?.trim() && cand.title.length > 5
              ? cand.title.trim()
              : fallback.dashboard.title,
          widgets: validWidgets,
          tools: inferredTools,
        };
      };

      const scored = candidates
        .map(buildCandidate)
        .filter((c) => c.widgets.length >= 1)
        .map((c) => ({
          ...c,
          score: this.scorePlannedDashboard(query, c.widgets),
        }))
        .sort((a, b) => b.score - a.score);

      const best = scored[0];
      if (best) {
        const constrainedWidgets = (() => {
          if (!constraints) return applyImplicitMax(best.widgets);

          let out = best.widgets.slice();

          if (
            constraints.requiredTypes &&
            constraints.requiredTypes.length > 0
          ) {
            const picked: typeof out = [];
            for (const t of constraints.requiredTypes) {
              const idx = out.findIndex((w) => w.type === t);
              if (idx >= 0) picked.push(out.splice(idx, 1)[0]!);
            }
            // If user explicitly listed chart types, prefer returning ONLY those.
            if (picked.length > 0) out = picked;
          }

          if (
            typeof constraints.exactCount === 'number' &&
            Number.isFinite(constraints.exactCount)
          ) {
            out = out.slice(
              0,
              Math.max(1, Math.min(8, Math.floor(constraints.exactCount))),
            );
          }

          const withImplicit = applyImplicitMax(out).map((w, i) => ({
            ...w,
            display_order: i,
          }));

          // If user explicitly asked to compare two specific clients and mentioned revenue,
          // ensure we include a client-broken-down monthly view (otherwise the dashboard is useless).
          if (wantsCompareClients && mentionsRevenue) {
            const hasClientPivot = withImplicit.some(
              (w: any) =>
                w.metric === 'revenue' &&
                w.grouping === 'month' &&
                w.breakdown === 'client',
            );
            if (!hasClientPivot) {
              return applyImplicitMax([
                {
                  title: 'Monthly Revenue — Client Comparison',
                  description: 'Monthly revenue for the selected clients',
                  type:
                    constraints?.requiredTypes?.[0] === 'line' ? 'line' : 'bar',
                  metric: 'revenue',
                  grouping: 'month',
                  breakdown: 'client',
                  topN: undefined,
                  display_order: 0,
                } as any,
              ]).map((w, i) => ({ ...w, display_order: i }));
            }
          }

          return withImplicit;
        })();

        const validationErrors = this.validateWidgetsAgainstSpec(
          spec,
          constrainedWidgets,
        );
        if (validationErrors.length > 0) {
          this.logger.warn(
            `[Agent:Planner] Plan rejected by spec validation: ${validationErrors.join(',')}`,
          );
          return fallback;
        }
        this.logger.log(
          `[Agent:Planner] Ollama succeeded — picked plan score=${best.score.toFixed(1)}, widgets=${best.widgets.length}, tools=${best.tools.length}`,
        );
        return {
          tools_to_execute: this.deriveToolsFromWidgets(
            constrainedWidgets,
            query,
          ),
          should_generate_dashboard: true,
          dashboard: {
            title: best.title,
            description: 'AI-generated financial intelligence dashboard',
            widgets: constrainedWidgets,
          },
          analysis_focus: query,
        };
      }

      this.logger.warn(
        '[Agent:Planner] Ollama returned 0 valid widgets — activating emergency fallback',
      );
    } catch (err: any) {
      this.logger.warn(
        `[Agent:Planner] Ollama failed (${err.message}) — activating emergency fallback`,
      );
    }

    return fallback;
  }

  private deriveToolsFromWidgets(
    widgets: Array<{
      type: 'line' | 'bar' | 'pie' | 'metric' | 'table';
      metric: string;
      grouping: string;
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
      if (w.grouping === 'client') {
        tools.add('client_financial_profile');
        tools.add('client_breakdown');
      }
    }

    // Always include a lightweight summary so synthesis can anchor quickly.
    tools.add('financial_summary');

    const inferred = Array.from(tools);
    // If inference yields nothing (shouldn't), fall back to deterministic intent-based tool selection.
    return inferred.length > 0 ? inferred : this.selectToolsForQuery(query);
  }

  private scorePlannedDashboard(
    query: string,
    widgets: Array<{
      type: 'line' | 'bar' | 'pie' | 'metric' | 'table';
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
    const types = new Set(widgets.map((w) => w.type));
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
      score += widgets.filter((w) => w.type === 'line').length * 5;
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

    if (spec.wantsTrend) {
      // Trend intent can be satisfied by either a line or a time-binned bar chart.
      if (
        !has(
          (w) =>
            (w.type === 'line' || w.type === 'bar') &&
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

    // If the user asks for metrics we do not have in our tool/widget vocabulary,
    // we must clarify to avoid guessing (hallucination).
    const hardUnsupportedMetric =
      /(gross\s*margin|net\s*income|cogs|expense|expenses|opex|ebitda|cash\s*flow|cashflow|balance\s*sheet|p&l|income\s*statement)/i;
    const softProfitLanguage =
      /\b(profit|profitable|profitability|margin|margins)\b/i;
    const hasInvoiceSignals =
      /\b(revenue|sales|paid|collected|outstanding|overdue|invoice|invoices|ar\b|aging|collections?)\b/i.test(
        query,
      );

    // Hard finance statements require data we don't currently ingest (expenses/COGS/GL).
    // Only block if the user is *primarily* asking for those, not when they also asked an answerable
    // invoice-based question (e.g. "compare revenue across entities, which is most profitable").
    if (hardUnsupportedMetric.test(query) && !hasInvoiceSignals) {
      return {
        reason: 'UNSUPPORTED_METRIC',
        question: `I can only build dashboards from invoice-based signals right now (revenue/paid/outstanding/overdue/collections) plus the venture summary tile. Which should I focus on for this dashboard?`,
        options: [
          {
            label: 'Revenue performance',
            value: 'Focus on revenue trends and revenue by entity/client.',
          },
          {
            label: 'AR / overdue risk',
            value: 'Focus on outstanding vs overdue and top overdue clients.',
          },
          {
            label: 'Collections efficiency',
            value:
              'Focus on paid amounts and collection/overdue rates by client.',
          },
          {
            label: 'Venture summary',
            value:
              'Focus on the venture summary tile (burn/runway/cash/efficiency) and supporting revenue context.',
          },
        ],
      };
    }

    // Mixed ask: includes unsupported metrics *and* invoice signals (e.g. "revenue and gross margin").
    // We must clarify to avoid silently dropping the unsupported part.
    if (hardUnsupportedMetric.test(query) && hasInvoiceSignals) {
      return {
        reason: 'UNSUPPORTED_METRIC_MIXED',
        question: `I can answer the invoice-based parts (revenue/paid/outstanding/overdue), but I can’t calculate true margins/profit yet (needs expenses/COGS). How should I proceed?`,
        options: [
          {
            label: 'Proceed with invoice signals only',
            value:
              'Proceed using invoice-based metrics only (revenue/paid/outstanding/overdue/collections).',
          },
          {
            label: 'Focus on collections/AR instead',
            value:
              'Focus on collections efficiency and AR/overdue risk (no margins).',
          },
          {
            label: 'Show revenue only',
            value: 'Show revenue trends and client/entity comparisons only.',
          },
          {
            label: 'Cancel and fix data',
            value:
              'Stop and tell me what data source you need to calculate margins/profit (expenses/COGS).',
          },
        ],
      };
    }

    // Soft "profit/profitable/margin" language shouldn't block if we can still answer using invoice signals.
    if (
      softProfitLanguage.test(query) &&
      !hasInvoiceSignals &&
      spec.focus !== 'VENTURE'
    ) {
      return {
        reason: 'UNSUPPORTED_METRIC',
        question: `I can’t calculate true profit/margins yet (needs expenses/COGS), but I *can* analyze invoice-based performance. Which should I focus on?`,
        options: [
          {
            label: 'Revenue performance',
            value: 'Focus on revenue trends and revenue by entity/client.',
          },
          {
            label: 'AR / overdue risk',
            value: 'Focus on outstanding vs overdue and top overdue clients.',
          },
          {
            label: 'Collections efficiency',
            value:
              'Focus on paid amounts and collection/overdue rates by client.',
          },
          {
            label: 'Venture summary',
            value:
              'Focus on the venture summary tile (burn/runway/cash/efficiency) and supporting revenue context.',
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

  private async generateEditPlan(
    activeDashboard: ActiveDashboard,
    editRequest: string,
  ): Promise<DashboardEditPlan> {
    const widgetList = activeDashboard.widgets
      .map((w, i) => {
        const cfg = (w.queryConfig as any) ?? {};
        return `  ${i}. [${w.chartType.toUpperCase()}] ${w.title} — ${cfg.metric ?? '?'}/${cfg.grouping ?? '?'}`;
      })
      .join('\n');

    const editFallback: DashboardEditPlan = {
      summary: 'Applied requested changes',
      add: [],
      remove_indices: [],
      modify: [],
    };

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 300_000);

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

      if (!response.ok) return editFallback;

      const body = (await response.json()) as {
        message?: { content?: string };
      };
      const raw = body.message?.content ?? '';
      const cleaned = raw
        .replace(/^```(?:json)?\s*/m, '')
        .replace(/\s*```$/m, '')
        .trim();
      const parsed = JSON.parse(cleaned) as DashboardEditPlan;

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

      return parsed;
    } catch (err: any) {
      this.logger.warn(
        `[Agent:Editor] Edit plan parse failed (${err.message})`,
      );
      return editFallback;
    }
  }

  // ─── Apply Dashboard Edit ─────────────────────────────────────────────────

  private async applyDashboardEdit(
    dashboardId: string,
    editPlan: DashboardEditPlan,
    organizationId: string,
    spec?: QuerySpec,
  ): Promise<{ id: string; title: string; widgetCount: number }> {
    return this.prisma.$transaction(async (tx) => {
      const currentWidgets = await tx.dashboardWidget.findMany({
        where: { dashboardId },
        orderBy: { displayOrder: 'asc' },
      });
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
        if (mod.title) changes.title = mod.title;
        if (mod.type) changes.chartType = mod.type;
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
      return { id: dashboard.id, title: dashboard.title, widgetCount };
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
    const time = this.timeWhereOn('issued_at', spec.timeRange);
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
	           FROM ${this.analyticsDb}.fact_accounting_invoices
	           WHERE org_id IN ({externalOrgIds:Array(String)})
	             ${provider}
	             ${client}
	             ${entity}
	             ${time}
	           GROUP BY month ORDER BY month ASC LIMIT 18`,
          {
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
             countIf(lowerUTF8(status) = 'overdue') AS overdue_count
	           FROM ${this.analyticsDb}.fact_accounting_invoices
	           WHERE connection_id IN ({connectionIds:Array(String)})
	             ${provider}
	             ${client}
	             ${entity}
	             ${time}
	           GROUP BY org_name, org_id, provider ORDER BY total_revenue DESC`,
          {
            connectionIds: scope.connectionIds,
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
	           FROM ${this.analyticsDb}.fact_accounting_invoices
	           WHERE connection_id IN ({connectionIds:Array(String)})
	             ${provider}
	             ${client}
	             ${entity}
	             ${time}
	           GROUP BY status ORDER BY status_total DESC LIMIT 15`,
          {
            connectionIds: scope.connectionIds,
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
	           WHERE connection_id IN ({connectionIds:Array(String)})
	             ${provider}
	             ${client}
	             ${entity}
	             ${time}`,
          {
            connectionIds: scope.connectionIds,
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
             WHERE connection_id IN ({connectionIds:Array(String)})
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
             WHERE connection_id IN ({connectionIds:Array(String)})
               AND payment_at IS NOT NULL
               AND payment_at <= now()
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
            connectionIds: scope.connectionIds,
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
	             FROM ${this.analyticsDb}.fact_accounting_invoices
	             WHERE org_id IN ({externalOrgIds:Array(String)})
	               ${provider}
	               ${client}
	               ${entity}
	               ${time}
	             GROUP BY client_name
	             ORDER BY revenue DESC LIMIT 20`,
            {
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
	           FROM ${this.analyticsDb}.dim_clients FINAL
	           WHERE org_id IN ({externalOrgIds:Array(String)})
	             AND client_name != ''
	             ${spec.entityFilter ? `AND org_id = {orgId:String}` : ''}
	             ${spec.clientFilter ? `AND lowerUTF8(client_name) = {clientName:String}` : ''}
	           ORDER BY total_revenue DESC LIMIT 20`,
          {
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
               any(provider) AS provider,
               any(currency) AS currency,
               coalesce(sum(abs(total_amount)), 0) AS total_invoiced,
               coalesce(sumIf(total_amount, lowerUTF8(status) IN ('paid','voided','closed','active','open')), 0) AS total_revenue,
               coalesce(sumIf(total_amount,
                 lowerUTF8(status) IN ('authorised','sent','needtosend','notset')
                 AND (due_at IS NULL OR due_at >= now())), 0) AS total_outstanding,
               coalesce(sumIf(total_amount,
                 lowerUTF8(status) IN ('authorised','sent','needtosend','notset')
                 AND due_at IS NOT NULL AND due_at < now()), 0) AS total_overdue,
               count() AS invoice_count,
               countIf(lowerUTF8(status) IN ('paid','voided','closed','active','open')) AS paid_count,
               countIf(lowerUTF8(status) IN ('authorised','sent','needtosend','notset')
                 AND (due_at IS NULL OR due_at >= now())) AS outstanding_count,
               countIf(lowerUTF8(status) IN ('authorised','sent','needtosend','notset')
                 AND due_at IS NOT NULL AND due_at < now()) AS overdue_count,
               countIf(lowerUTF8(status) = 'draft') AS draft_count,
               round(avg(abs(total_amount)), 2) AS avg_invoice_amount,
               formatDateTime(min(issued_at), '%Y-%m-%d') AS first_invoice_date,
               formatDateTime(max(issued_at), '%Y-%m-%d') AS last_invoice_date,
               if(total_invoiced > 0,
                 round(total_revenue / total_invoiced * 100, 1), 0) AS collection_rate_pct,
               if(total_invoiced > 0,
                 round(total_overdue / total_invoiced * 100, 1), 0) AS overdue_rate_pct
	             FROM ${this.analyticsDb}.fact_accounting_invoices
	             WHERE org_id IN ({externalOrgIds:Array(String)})
	               ${provider}
	               ${client}
	               ${entity}
	               ${time}
             GROUP BY client_name, org_name, org_id
             HAVING client_name != ''
             ORDER BY total_revenue DESC LIMIT 50`,
            {
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
	           FROM ${this.analyticsDb}.dim_clients FINAL
	           WHERE org_id IN ({externalOrgIds:Array(String)})
	             AND client_name != ''
	             ${spec.entityFilter ? `AND org_id = {orgId:String}` : ''}
	             ${spec.clientFilter ? `AND lowerUTF8(client_name) = {clientName:String}` : ''}
	           ORDER BY total_invoiced DESC LIMIT 50`,
          {
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

  // ─── Synthesis Message Builder ────────────────────────────────────────────

  private buildSynthesisMessages(
    userQuery: string,
    toolResults: ToolResult[],
    plan: AgentPlan,
    dashboardId: string | null,
    dashboardTitle: string,
    intent: QueryIntent,
    editPlan: DashboardEditPlan | null,
    actualWidgetCount: number,
  ): Array<{ role: string; content: string }> {
    const toolSummary = toolResults
      .map((r) => {
        const dataStr = JSON.stringify(r.data, null, 2);
        const preview =
          dataStr.length > 4000
            ? dataStr.slice(0, 4000) + '\n...(truncated)'
            : dataStr;
        return `### ${this.toolLabel(r.tool)} (${r.rowCount} records)\n\`\`\`json\n${preview}\n\`\`\``;
      })
      .join('\n\n');

    let dashboardNote = '';
    if (dashboardId && intent === 'EDIT_DASHBOARD' && editPlan) {
      dashboardNote = `\n\nThe dashboard "${dashboardTitle}" has been updated: ${editPlan.summary}. Reference it in your brief.`;
    } else if (dashboardId && intent === 'CREATE_DASHBOARD') {
      dashboardNote = `\n\nDashboard "${dashboardTitle}" generated with ${actualWidgetCount} charts.`;
    }

    const userContent = `USER QUERY: "${userQuery}"
${dashboardNote}

Write your 2-3 sentence summary now.`;

    return [
      { role: 'system', content: SYNTHESIZER_SYSTEM },
      { role: 'user', content: userContent },
    ];
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
      connectionIds: allConnectionIds,
      externalOrgIds: allExternal,
    };

    // If an explicit orgId scope is provided, always honor it (even for admins).
    if (orgId && allExternal.includes(orgId)) {
      const filteredConnectionIds = conns
        .filter((c) => c.externalOrganizationId === orgId)
        .map((c) => c.id);
      return { connectionIds: filteredConnectionIds, externalOrgIds: [orgId] };
    }

    // Admins can mix entities; members must be entity-scoped (single org_id at a time).
    if (role === 'ADMIN') return all;

    const target = allExternal.length === 1 ? allExternal[0] : null;
    if (!target) return all;

    const filteredConnectionIds = conns
      .filter((c) => c.externalOrganizationId === target)
      .map((c) => c.id);
    return { connectionIds: filteredConnectionIds, externalOrgIds: [target] };
  }

  private async queryRows<T>(
    query: string,
    params: Record<string, unknown>,
  ): Promise<T[]> {
    await this.ensureAnalyticsSchema();
    const result = await this.clickhouse.query({
      query,
      query_params: params,
      format: 'JSONEachRow',
      clickhouse_settings: SAFE_QUERY,
    });
    return (await result.json()) as T[];
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

  private timeWhereOn(column: string, range?: TimeRange): string {
    if (!range || range.kind === 'ALL_TIME') return '';

    const col = column;
    const isIsoDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

    if (range.kind === 'MTD') return `AND ${col} >= toStartOfMonth(now())`;
    if (range.kind === 'QTD') return `AND ${col} >= toStartOfQuarter(now())`;
    if (range.kind === 'YTD') return `AND ${col} >= toStartOfYear(now())`;

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
      return `AND ${col} >= (now() - INTERVAL ${Math.max(1, Math.floor(range.days))} DAY)`;
    if (range.kind === 'LAST_N_WEEKS')
      return `AND ${col} >= (now() - INTERVAL ${Math.max(1, Math.floor(range.weeks))} WEEK)`;
    if (range.kind === 'LAST_N_MONTHS')
      return `AND ${col} >= (now() - INTERVAL ${Math.max(1, Math.floor(range.months))} MONTH)`;
    if (range.kind === 'LAST_N_QUARTERS')
      return `AND ${col} >= (now() - INTERVAL ${Math.max(1, Math.floor(range.quarters)) * 3} MONTH)`;
    if (range.kind === 'LAST_N_YEARS')
      return `AND ${col} >= (now() - INTERVAL ${Math.max(1, Math.floor(range.years))} YEAR)`;

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

    const action =
      meta.intent === 'EDIT_DASHBOARD'
        ? `Updated your dashboard "${meta.dashboardTitle}" with ${meta.widgetCount} charts.`
        : meta.dashboardTitle
          ? `Built your dashboard "${meta.dashboardTitle}" with ${meta.widgetCount} charts.`
          : `Analyzed your data and prepared a dashboard plan.`;

    const metricSentence = (() => {
      if (totalInvoices === 0) {
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

    const sentence3 =
      meta.editSummary && meta.intent === 'EDIT_DASHBOARD'
        ? `Change applied: ${meta.editSummary}.`
        : highlightSentence;

    // Maximum 3 sentences. Never invent numbers — everything above is derived from tool results.
    return [action, metricSentence, sentence3].filter(Boolean).join(' ');
  }

  private chunk(type: string, payload: Record<string, unknown>): string {
    return JSON.stringify({ type, ...payload }) + '\n';
  }
}
