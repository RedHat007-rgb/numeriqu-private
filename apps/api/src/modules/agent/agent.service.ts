import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PrismaClient, Prisma } from '@repo/db';
import {
  CLICKHOUSE_ANALYTICS_TOKEN,
  PRISMA_TOKEN,
} from '../../database/database.module';
import type { ClickHouseClient } from '@clickhouse/client';
import { OrganizationContextService } from '../org-context/org-context.service';

// ─── Types ────────────────────────────────────────────────────────────────────

interface OrgScope {
  connectionIds: string[];
  externalOrgIds: string[];
}

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

const SAFE_QUERY = { max_memory_usage: '536870912', max_execution_time: 20 };

// ─── Valid widget configurations ─────────────────────────────────────────────
// These are the ONLY supported metric+grouping pairs the agent can use.

// ─── Complete chart vocabulary — every (type, metric, grouping) pair the
// system can serve. Ollama picks freely from this list; the frontend renders any.
const VALID_WIDGETS = [
  // ── Time-series trends (line charts)
  { type: 'line', metric: 'revenue',         grouping: 'month'   },
  { type: 'line', metric: 'outstanding',     grouping: 'month'   },
  { type: 'line', metric: 'paid',            grouping: 'month'   },
  { type: 'line', metric: 'invoice_count',   grouping: 'month'   },
  { type: 'line', metric: 'overdue',         grouping: 'month'   },
  { type: 'line', metric: 'revenue',         grouping: 'quarter' },
  { type: 'line', metric: 'avg_invoice',     grouping: 'month'   },
  // ── Comparison bars — entity / period
  { type: 'bar',  metric: 'revenue',         grouping: 'org'     },
  { type: 'bar',  metric: 'revenue',         grouping: 'quarter' },
  { type: 'bar',  metric: 'invoices',        grouping: 'org'     },
  { type: 'bar',  metric: 'outstanding',     grouping: 'org'     },
  { type: 'bar',  metric: 'overdue',         grouping: 'org'     },
  // ── Client-level bars (sourced from dim_clients gold table)
  { type: 'bar',  metric: 'revenue',         grouping: 'client'  },
  { type: 'bar',  metric: 'total_invoiced',  grouping: 'client'  },
  { type: 'bar',  metric: 'outstanding',     grouping: 'client'  },
  { type: 'bar',  metric: 'overdue',         grouping: 'client'  },
  { type: 'bar',  metric: 'invoices',        grouping: 'client'  },
  { type: 'bar',  metric: 'avg_invoice',     grouping: 'client'  },
  { type: 'bar',  metric: 'paid',            grouping: 'client'  },
  { type: 'bar',  metric: 'collection_rate', grouping: 'client'  },
  { type: 'bar',  metric: 'overdue_rate',    grouping: 'client'  },
  // ── Proportional pies
  { type: 'pie',  metric: 'revenue',         grouping: 'client'  },
  { type: 'pie',  metric: 'revenue',         grouping: 'provider'},
  { type: 'pie',  metric: 'invoices',        grouping: 'status'  },
  { type: 'pie',  metric: 'outstanding',     grouping: 'client'  },
  // ── Metric tiles
  { type: 'metric', metric: 'venture',       grouping: 'summary' },
  // ── Tables
  { type: 'table', metric: 'invoices',       grouping: 'list'    },
] as const;

// ─── Planning Prompt — minimal for fast Ollama inference ─────────────────────
// Small context + small output = fast response, no timeouts.

// ─── Planner Prompt — Ollama is the sole dashboard architect.
// It receives live data context + full chart vocabulary and decides freely.
// NO hardcoded chart selection happens before this prompt runs.

const PLANNER_SYSTEM = `You are a world-class financial dashboard architect. Given a user query and LIVE DATA from their accounting system, design the most insightful possible dashboard. Output JSON only. No explanation.

AVAILABLE CHART TYPES — use ONLY these exact type/metric/grouping values:

LINE (trends over time):
  line/revenue/month        — monthly revenue trend
  line/outstanding/month    — monthly outstanding AR build-up
  line/paid/month           — monthly cash collected trend
  line/invoice_count/month  — monthly invoice volume trend
  line/overdue/month        — monthly overdue AR accumulation
  line/revenue/quarter      — quarterly revenue as trend line
  line/avg_invoice/month    — average invoice size trend

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

PIE (proportional breakdowns):
  pie/revenue/client        — revenue share by client
  pie/revenue/provider      — revenue split by ERP system
  pie/invoices/status       — invoice count by status
  pie/outstanding/client    — outstanding concentration by client

METRIC (tiles):
  metric/venture/summary    — burn, runway, cash, efficiency

TABLE (rows):
  table/invoices/list       — recent invoices (audit view)

TOOLS:
  revenue_trend             — monthly/quarterly revenue data
  entity_comparison         — revenue, invoices, overdue per entity
  invoice_breakdown         — invoice status analysis
  venture_metrics           — burn rate, cash, runway
  financial_summary         — overall totals and averages
  client_breakdown          — top clients by revenue (from gold table)
  client_financial_profile  — full per-client data: revenue, outstanding, overdue, counts, dates

RULES:
1. Read the LIVE DATA CONTEXT carefully — base your chart choices on the actual numbers
2. Pick 4-6 charts that tell the most useful story for this specific query (minimum 4)
3. NEVER repeat the same metric+grouping twice
4. Title the dashboard and each chart specifically — not generic names
5. For client queries: always include client_financial_profile tool + at least 2 client-grouping charts
6. For trend queries: favour line charts; for comparisons: favour bar; for distribution: include a pie
7. If the data shows high overdue amounts, include an overdue chart even if not explicitly asked
8. Prefer diversity: include (at least) 1 trend line, 1 comparison bar, and 1 distribution pie unless clearly irrelevant.

OUTPUT FORMAT (JSON only, no markdown):
Return EITHER:
1) Single plan:
{"title":"Dashboard title","tools":["tool1"],"widgets":[{"type":"bar","metric":"revenue","grouping":"client","title":"Specific title"}]}
OR (preferred)
2) Candidates (you must provide 2-3 candidates):
{"candidates":[{"title":"Candidate A","tools":["tool1"],"widgets":[...]},{"title":"Candidate B","tools":[...],"widgets":[...]}]}

EXAMPLES:
Q: "who are my top clients" + 12 clients, $4.2M revenue, $45K overdue → {"title":"Top Client Revenue & Collection Intelligence","tools":["client_financial_profile","client_breakdown"],"widgets":[{"type":"bar","metric":"revenue","grouping":"client","title":"Top Clients by Total Revenue Collected"},{"type":"bar","metric":"outstanding","grouping":"client","title":"Outstanding Balance per Client"},{"type":"bar","metric":"overdue","grouping":"client","title":"Overdue Exposure per Client"},{"type":"pie","metric":"revenue","grouping":"client","title":"Revenue Concentration Risk"}]}
Q: "show overdue invoices" + $45K overdue, 8 clients → {"title":"AR Collection Risk Analysis","tools":["invoice_breakdown","client_financial_profile"],"widgets":[{"type":"bar","metric":"overdue","grouping":"client","title":"Overdue Exposure by Client"},{"type":"line","metric":"overdue","grouping":"month","title":"Overdue AR Accumulation Trend"},{"type":"pie","metric":"invoices","grouping":"status","title":"Invoice Status Breakdown"}]}
Q: "quarterly revenue breakdown" + 2 entities, $4.2M lifetime → {"title":"Quarterly Revenue Performance","tools":["revenue_trend","entity_comparison"],"widgets":[{"type":"bar","metric":"revenue","grouping":"quarter","title":"Quarterly Revenue Cadence"},{"type":"line","metric":"revenue","grouping":"month","title":"Monthly Revenue Within Quarters"},{"type":"bar","metric":"revenue","grouping":"org","title":"Revenue by Entity"}]}
Q: "compare entities" + 2 entities → {"title":"Entity Revenue Concentration","tools":["entity_comparison","financial_summary"],"widgets":[{"type":"bar","metric":"revenue","grouping":"org","title":"Revenue by Entity"},{"type":"bar","metric":"outstanding","grouping":"org","title":"Outstanding AR by Entity"},{"type":"bar","metric":"invoices","grouping":"org","title":"Invoice Volume by Entity"}]}
Q: "revenue trend" + strong growth → {"title":"Revenue Growth & Momentum Analysis","tools":["revenue_trend","financial_summary"],"widgets":[{"type":"line","metric":"revenue","grouping":"month","title":"Monthly Revenue Growth Trajectory"},{"type":"bar","metric":"revenue","grouping":"quarter","title":"Quarterly Revenue Acceleration"},{"type":"line","metric":"invoice_count","grouping":"month","title":"Invoice Volume Momentum"}]}
Q: "CFO board pack" + all data available → {"title":"Executive Financial Intelligence Dashboard","tools":["financial_summary","revenue_trend","entity_comparison","client_financial_profile"],"widgets":[{"type":"line","metric":"revenue","grouping":"month","title":"Revenue Growth Trajectory"},{"type":"bar","metric":"revenue","grouping":"client","title":"Top Client Revenue Ranking"},{"type":"bar","metric":"outstanding","grouping":"client","title":"Outstanding AR by Client"},{"type":"pie","metric":"invoices","grouping":"status","title":"Invoice Portfolio Health"}]}`;

// ─── Dashboard Editor Prompt ──────────────────────────────────────────────────

const EDITOR_SYSTEM = `You are a precise financial dashboard editor. Apply the minimal change to satisfy the user's request.

AVAILABLE WIDGET TYPES (use ONLY these exact pairs):
LINE: revenue/month | outstanding/month | paid/month | invoice_count/month | overdue/month | revenue/quarter | avg_invoice/month
BAR:  revenue/org | revenue/quarter | invoices/org | outstanding/org | overdue/org
      revenue/client | total_invoiced/client | outstanding/client | overdue/client | invoices/client | avg_invoice/client | paid/client
      collection_rate/client | overdue_rate/client
PIE:  invoices/status | revenue/provider | revenue/client | outstanding/client
METRIC: venture/summary
TABLE: invoices/list

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
- Total widgets after edit MUST be between 4 and 6.
- If the request is ambiguous, add the most relevant widget without removing anything.
- If asked to change a chart type, use "modify" with the correct "type" value.`; 

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

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    @Inject(CLICKHOUSE_ANALYTICS_TOKEN) private readonly clickhouse: ClickHouseClient,
    private readonly orgContext: OrganizationContextService,
  ) {
    this.OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
    this.OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3:latest';
    this.analyticsDb = process.env.CLICKHOUSE_ANALYTICS_DB || 'analytics';
  }

  // ─── Health ───────────────────────────────────────────────────────────────

  async health() {
    let ollamaOnline = false;
    try {
      const res = await fetch(`${this.OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
      ollamaOnline = res.ok;
    } catch { /* offline */ }

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
        config: typeof w.queryConfig === 'object' && w.queryConfig
          ? (w.queryConfig as Record<string, string>)
          : { metric: 'revenue', grouping: 'month' },
        layoutIndex: w.displayOrder,
      })),
    };
  }

  // ─── Metric Data ──────────────────────────────────────────────────────────

  async metricData(organizationId: string, metric: string, grouping: string) {
    const scope = await this.getOrgScope(organizationId);
    if (scope.connectionIds.length === 0) return { data: [] };

    if (metric === 'venture') {
      const rows = await this.queryRows<any>(
        `SELECT
           coalesce(sum(total_amount), 0) AS total_revenue,
           coalesce(sumIf(total_amount, lowerUTF8(status) NOT IN ('paid','closed')), 0) AS open_amount
         FROM ${this.analyticsDb}.fact_accounting_invoices
         WHERE connection_id IN ({connectionIds:Array(String)})`,
        { connectionIds: scope.connectionIds },
      );
      const r = rows[0] ?? {};
      const revenue = this.num(r.total_revenue);
      const open = this.num(r.open_amount);
      return {
        data: [{
          burnRate: open,
          runwayMonths: open > 0 ? Math.round((revenue / open) * 10) / 10 : 99,
          cashOnHand: revenue - open,
          efficiencyMultiplier: open > 0 ? Math.round((revenue / open) * 100) / 100 : 0,
        }],
      };
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
         GROUP BY month, month_start
         ORDER BY month_start ASC
         LIMIT 24`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return {
        data: rows.map((r) => ({ name: r.month as string, value: this.num(r.avg_invoice) })),
      };
    }

    if (metric === 'invoices' && grouping === 'status') {
      const rows = await this.queryRows<any>(
        `SELECT status, coalesce(sum(total_amount), 0) AS total_amount, count() AS total_count
         FROM ${this.analyticsDb}.fact_accounting_invoices
         WHERE connection_id IN ({connectionIds:Array(String)})
         GROUP BY status ORDER BY total_amount DESC`,
        { connectionIds: scope.connectionIds },
      );
      return {
        data: rows.map((r) => ({ name: r.status as string, value: this.num(r.total_amount), count: this.num(r.total_count) })),
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
         ORDER BY issued_at DESC
         LIMIT 50`,
        { connectionIds: scope.connectionIds },
      );
      return { data: rows };
    }

    if (metric === 'invoices' && grouping === 'org') {
      const rows = await this.queryRows<any>(
        `SELECT coalesce(org_name, org_id) AS org_name, count() AS total_count, coalesce(sum(total_amount), 0) AS total_amount
         FROM ${this.analyticsDb}.fact_accounting_invoices
         WHERE connection_id IN ({connectionIds:Array(String)})
         GROUP BY org_name, org_id ORDER BY total_count DESC LIMIT 10`,
        { connectionIds: scope.connectionIds },
      );
      return {
        data: rows.map((r) => ({ name: (r.org_name as string) || 'Unknown', value: this.num(r.total_count) })),
      };
    }

    if (metric === 'revenue' && grouping === 'org') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT coalesce(org_name, org_id) AS org_name, coalesce(sum(total_amount), 0) AS total_revenue
         FROM ${this.analyticsDb}.fact_accounting_invoices
         WHERE org_id IN ({externalOrgIds:Array(String)})
         GROUP BY org_name, org_id ORDER BY total_revenue DESC LIMIT 10`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return {
        data: rows.map((r) => ({ name: (r.org_name as string) || 'Unknown', value: this.num(r.total_revenue) })),
      };
    }

    if (metric === 'revenue' && grouping === 'provider') {
      const rows = await this.queryRows<any>(
        `SELECT provider, coalesce(sum(total_amount), 0) AS total_revenue
         FROM ${this.analyticsDb}.fact_accounting_invoices
         WHERE connection_id IN ({connectionIds:Array(String)})
         GROUP BY provider ORDER BY total_revenue DESC`,
        { connectionIds: scope.connectionIds },
      );
      return {
        data: rows.map((r) => ({ name: (r.provider as string) || 'Unknown', value: this.num(r.total_revenue) })),
      };
    }

    if (metric === 'revenue' && grouping === 'quarter') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           concat('Q', toString(toQuarter(issued_at)), ' ', toString(toYear(issued_at))) AS quarter,
           toStartOfQuarter(issued_at) AS quarter_start,
           coalesce(sum(total_amount), 0) AS total_revenue
         FROM ${this.analyticsDb}.fact_accounting_invoices
         WHERE org_id IN ({externalOrgIds:Array(String)})
         GROUP BY quarter, quarter_start ORDER BY quarter_start ASC LIMIT 12`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return {
        data: rows.map((r) => ({ name: r.quarter as string, value: this.num(r.total_revenue) })),
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
         GROUP BY month, month_start ORDER BY month_start ASC LIMIT 24`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return {
        data: rows.map((r) => ({ name: r.month as string, value: this.num(r.invoice_count) })),
      };
    }

    if (metric === 'overdue' && grouping === 'month') {
      if (scope.connectionIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           formatDateTime(toStartOfMonth(issued_at), '%m/%y') AS month,
           toStartOfMonth(issued_at) AS month_start,
           coalesce(sumIf(total_amount, lowerUTF8(status) = 'overdue'), 0) AS overdue_amount,
           countIf(lowerUTF8(status) = 'overdue') AS overdue_count
         FROM ${this.analyticsDb}.fact_accounting_invoices
         WHERE connection_id IN ({connectionIds:Array(String)})
         GROUP BY month, month_start ORDER BY month_start ASC LIMIT 24`,
        { connectionIds: scope.connectionIds },
      );
      return {
        data: rows.map((r) => ({ name: r.month as string, value: this.num(r.overdue_amount), count: this.num(r.overdue_count) })),
      };
    }

    if (metric === 'revenue' && grouping === 'client') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
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
           AND client_name != ''
         ORDER BY total_revenue DESC LIMIT 15`,
        { externalOrgIds: scope.externalOrgIds },
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
        })),
      };
    }

    if (metric === 'invoices' && grouping === 'client') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           coalesce(nullIf(client_name, ''), 'Unknown Client') AS client_name,
           client_id,
           invoice_count,
           total_invoiced
         FROM ${this.analyticsDb}.dim_clients FINAL
         WHERE org_id IN ({externalOrgIds:Array(String)})
           AND client_name != ''
         ORDER BY invoice_count DESC LIMIT 15`,
        { externalOrgIds: scope.externalOrgIds },
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
        `SELECT
           formatDateTime(toStartOfMonth(issued_at), '%m/%y') AS month,
           toStartOfMonth(issued_at)                           AS month_start,
           coalesce(sumIf(total_amount,
             lowerUTF8(status) IN ('authorised','sent','needtosend','notset')
             AND (due_at IS NULL OR due_at >= now())), 0)      AS outstanding_amount
         FROM ${this.analyticsDb}.fact_accounting_invoices
         WHERE org_id IN ({externalOrgIds:Array(String)})
         GROUP BY month, month_start ORDER BY month_start ASC LIMIT 24`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return { data: rows.map((r) => ({ name: r.month as string, value: this.num(r.outstanding_amount) })) };
    }

    // ── paid/month ────────────────────────────────────────────────────────────
    if (metric === 'paid' && grouping === 'month') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           formatDateTime(toStartOfMonth(issued_at), '%m/%y') AS month,
           toStartOfMonth(issued_at)                           AS month_start,
           coalesce(sumIf(total_amount,
             lowerUTF8(status) IN ('paid','voided','closed','active','open')), 0) AS paid_amount
         FROM ${this.analyticsDb}.fact_accounting_invoices
         WHERE org_id IN ({externalOrgIds:Array(String)})
         GROUP BY month, month_start ORDER BY month_start ASC LIMIT 24`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return { data: rows.map((r) => ({ name: r.month as string, value: this.num(r.paid_amount) })) };
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
         GROUP BY quarter, quarter_start ORDER BY quarter_start ASC LIMIT 12`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return { data: rows.map((r) => ({ name: r.quarter as string, value: this.num(r.total_revenue) })) };
    }

    // ── outstanding/org and overdue/org ───────────────────────────────────────
    if (metric === 'outstanding' && grouping === 'org') {
      if (scope.connectionIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT coalesce(org_name, org_id) AS org_name,
                coalesce(sumIf(total_amount,
                  lowerUTF8(status) IN ('authorised','sent','needtosend','notset')
                  AND (due_at IS NULL OR due_at >= now())), 0) AS outstanding
         FROM ${this.analyticsDb}.fact_accounting_invoices
         WHERE connection_id IN ({connectionIds:Array(String)})
         GROUP BY org_name, org_id ORDER BY outstanding DESC LIMIT 10`,
        { connectionIds: scope.connectionIds },
      );
      return { data: rows.map((r) => ({ name: (r.org_name as string) || 'Unknown', value: this.num(r.outstanding) })) };
    }

    if (metric === 'overdue' && grouping === 'org') {
      if (scope.connectionIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT coalesce(org_name, org_id) AS org_name,
                coalesce(sumIf(total_amount,
                  lowerUTF8(status) IN ('authorised','sent','needtosend','notset')
                  AND due_at IS NOT NULL AND due_at < now()), 0) AS overdue
         FROM ${this.analyticsDb}.fact_accounting_invoices
         WHERE connection_id IN ({connectionIds:Array(String)})
         GROUP BY org_name, org_id ORDER BY overdue DESC LIMIT 10`,
        { connectionIds: scope.connectionIds },
      );
      return { data: rows.map((r) => ({ name: (r.org_name as string) || 'Unknown', value: this.num(r.overdue) })) };
    }

    // ── total_invoiced/client ─────────────────────────────────────────────────
    if (metric === 'total_invoiced' && grouping === 'client') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT coalesce(nullIf(client_name, ''), 'Unknown') AS client_name, client_id, total_invoiced, invoice_count
         FROM ${this.analyticsDb}.dim_clients FINAL
         WHERE org_id IN ({externalOrgIds:Array(String)}) AND client_name != ''
         ORDER BY total_invoiced DESC LIMIT 15`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return { data: rows.map((r) => ({ name: r.client_name as string, value: this.num(r.total_invoiced), invoiceCount: this.num(r.invoice_count) })) };
    }

    // ── avg_invoice/client ────────────────────────────────────────────────────
    if (metric === 'avg_invoice' && grouping === 'client') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT coalesce(nullIf(client_name, ''), 'Unknown') AS client_name, client_id, avg_invoice_amount, invoice_count
         FROM ${this.analyticsDb}.dim_clients FINAL
         WHERE org_id IN ({externalOrgIds:Array(String)}) AND client_name != '' AND invoice_count > 0
         ORDER BY avg_invoice_amount DESC LIMIT 15`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return { data: rows.map((r) => ({ name: r.client_name as string, value: this.num(r.avg_invoice_amount), invoiceCount: this.num(r.invoice_count) })) };
    }

    // ── paid/client ───────────────────────────────────────────────────────────
    if (metric === 'paid' && grouping === 'client') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT coalesce(nullIf(client_name, ''), 'Unknown') AS client_name, client_id, total_revenue AS paid_amount, paid_count
         FROM ${this.analyticsDb}.dim_clients FINAL
         WHERE org_id IN ({externalOrgIds:Array(String)}) AND client_name != ''
         ORDER BY paid_amount DESC LIMIT 15`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return { data: rows.map((r) => ({ name: r.client_name as string, value: this.num(r.paid_amount), paidCount: this.num(r.paid_count) })) };
    }

    // ── collection_rate/client ───────────────────────────────────────────────
    if (metric === 'collection_rate' && grouping === 'client') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           coalesce(nullIf(client_name, ''), 'Unknown') AS client_name,
           total_invoiced,
           total_revenue
         FROM ${this.analyticsDb}.dim_clients FINAL
         WHERE org_id IN ({externalOrgIds:Array(String)}) AND client_name != '' AND total_invoiced > 0
         ORDER BY total_invoiced DESC LIMIT 15`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return {
        data: rows.map((r) => ({
          name: r.client_name as string,
          value: Math.round(((this.num(r.total_revenue) / Math.max(1, this.num(r.total_invoiced))) * 100) * 10) / 10,
        })),
      };
    }

    // ── overdue_rate/client ──────────────────────────────────────────────────
    if (metric === 'overdue_rate' && grouping === 'client') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           coalesce(nullIf(client_name, ''), 'Unknown') AS client_name,
           total_invoiced,
           total_overdue
         FROM ${this.analyticsDb}.dim_clients FINAL
         WHERE org_id IN ({externalOrgIds:Array(String)}) AND client_name != '' AND total_invoiced > 0
         ORDER BY total_overdue DESC LIMIT 15`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return {
        data: rows.map((r) => ({
          name: r.client_name as string,
          value: Math.round(((this.num(r.total_overdue) / Math.max(1, this.num(r.total_invoiced))) * 100) * 10) / 10,
        })),
      };
    }

    // ── outstanding/client (pie variant — same data as bar) ──────────────────
    if (metric === 'outstanding' && grouping === 'client') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           coalesce(nullIf(client_name, ''), 'Unknown Client') AS client_name,
           client_id,
           total_outstanding,
           outstanding_count,
           total_overdue
         FROM ${this.analyticsDb}.dim_clients FINAL
         WHERE org_id IN ({externalOrgIds:Array(String)})
           AND client_name != ''
           AND (total_outstanding > 0 OR total_overdue > 0)
         ORDER BY total_outstanding DESC LIMIT 15`,
        { externalOrgIds: scope.externalOrgIds },
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

    if (metric === 'overdue' && grouping === 'client') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           coalesce(nullIf(client_name, ''), 'Unknown Client') AS client_name,
           client_id,
           total_overdue,
           overdue_count,
           total_outstanding
         FROM ${this.analyticsDb}.dim_clients FINAL
         WHERE org_id IN ({externalOrgIds:Array(String)})
           AND client_name != ''
           AND total_overdue > 0
         ORDER BY total_overdue DESC LIMIT 15`,
        { externalOrgIds: scope.externalOrgIds },
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

    // Default: revenue by month
    if (scope.externalOrgIds.length === 0) return { data: [] };
    const rows = await this.queryRows<any>(
      `SELECT
         formatDateTime(toStartOfMonth(issued_at), '%m/%y') AS month,
         coalesce(sum(total_amount), 0) AS total_revenue
       FROM ${this.analyticsDb}.fact_accounting_invoices
       WHERE org_id IN ({externalOrgIds:Array(String)})
       GROUP BY toStartOfMonth(issued_at) ORDER BY toStartOfMonth(issued_at) ASC LIMIT 24`,
      { externalOrgIds: scope.externalOrgIds },
    );
    return {
      data: rows.map((r) => ({ name: r.month as string, value: this.num(r.total_revenue) })),
    };
  }

  // ─── Main Agent Query Loop ────────────────────────────────────────────────

  async *query(
    organizationId: string,
    userId: string,
    userQuery: string,
    sessionId?: string,
  ): AsyncGenerator<string> {
    const runStartedAt = Date.now();

    // ── Session setup (first, so we can link the request) ──────────────────
    const existingSession = sessionId
      ? await this.prisma.agentChatSession.findFirst({ where: { id: sessionId, organizationId, userId } })
      : null;
    const currentSession = existingSession ?? await this.prisma.agentChatSession.create({
      data: { organizationId, userId, title: userQuery.slice(0, 80) },
    });

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
      data: { requestId: request.id, organizationId, status: 'RUNNING', startedAt: new Date() },
    });
    const logEvent = async (eventType: string, payload?: Record<string, unknown>) => {
      try {
        await this.prisma.agentRunEvent.create({
          data: { runId: run.id, organizationId, eventType, ...(payload ? { payload: payload as Prisma.InputJsonValue } : {}) },
        });
      } catch { /* non-critical */ }
    };

    await this.prisma.agentChatMessage.create({
      data: { sessionId: currentSession.id, organizationId, role: 'user', content: userQuery },
    });

    try {
      // ── Detect intent and gather context ──────────────────────────────────
      const activeDashboard = await this.getActiveSessionDashboard(currentSession.id, organizationId);
      const intent = this.detectIntent(userQuery, !!activeDashboard);
      const conversationHistory = await this.getConversationHistory(currentSession.id, organizationId);

      yield this.chunk('intent', {
        intent,
        activeDashboardId: activeDashboard?.id ?? null,
        activeDashboardTitle: activeDashboard?.title ?? null,
      });

      // ── PHASE 1: Planning ──────────────────────────────────────────────
      yield this.chunk('status', {
        message: intent === 'EDIT_DASHBOARD'
          ? 'Analyzing your dashboard edit request...'
          : 'Analyzing your request and building execution plan...',
      });
      yield this.chunk('phase', { phase: 'planning', label: intent === 'EDIT_DASHBOARD' ? 'Dashboard Edit Planning' : 'Strategic Planning' });

      await logEvent('PLANNING_START', { query: userQuery.slice(0, 200), intent });

      // Fetch live data context so Ollama can make data-aware chart decisions.
      // Runs as a fast parallel pre-flight — does NOT block the phase status emit above.
      const dataContext = await this.getDataContext(organizationId);

      // Generate plans in parallel when editing (need both a tool plan and an edit diff)
      let plan: AgentPlan;
      let editPlan: DashboardEditPlan | null = null;

      if (intent === 'EDIT_DASHBOARD' && activeDashboard) {
        const [resolvedPlan, resolvedEdit] = await Promise.all([
          this.generatePlan(userQuery, conversationHistory, activeDashboard, dataContext),
          this.generateEditPlan(activeDashboard, userQuery),
        ]);
        plan = resolvedPlan;
        plan.should_generate_dashboard = false; // We're editing, not creating
        editPlan = resolvedEdit;
      } else {
        plan = await this.generatePlan(userQuery, conversationHistory, activeDashboard, dataContext);
      }

      await logEvent('PLAN_GENERATED', { tools: plan.tools_to_execute, intent, hasEditPlan: !!editPlan });

      for (const tool of plan.tools_to_execute) {
        yield this.chunk('tool_call', { tool, label: this.toolLabel(tool) });
      }

      // ── PHASE 2: Tool Execution ────────────────────────────────────────
      yield this.chunk('phase', { phase: 'execution', label: 'Gathering Financial Intelligence' });
      yield this.chunk('status', { message: `Executing ${plan.tools_to_execute.length} data queries in parallel...` });

      const scope = await this.getOrgScope(organizationId);
      const toolResults = await this.executeTools(plan.tools_to_execute, scope);

      for (const result of toolResults) {
        await logEvent('TOOL_EXECUTED', { tool: result.tool, rowCount: result.rowCount });
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
        yield this.chunk('phase', { phase: 'dashboard', label: 'Applying Dashboard Changes' });
        yield this.chunk('status', { message: 'Updating your dashboard...' });

        try {
          const updated = await this.applyDashboardEdit(activeDashboard.id, editPlan, organizationId);
          dashboardId = updated.id;
          dashboardTitle = updated.title;
          actualWidgetCount = updated.widgetCount;

          await logEvent('DASHBOARD_UPDATED', { dashboardId, summary: editPlan.summary });
          yield this.chunk('dashboard_updated', {
            dashboardId,
            title: updated.title,
            summary: editPlan.summary,
            widgetCount: updated.widgetCount,
          });
          yield this.chunk('system', { action: 'DASHBOARD_REFRESH' });
        } catch (editErr: any) {
          this.logger.warn(`[Agent:Edit] Edit failed — ${editErr.message}. Falling back to create.`);
          // Fall through and let synthesis continue without dashboard update
        }

      } else if (plan.should_generate_dashboard) {
        yield this.chunk('phase', { phase: 'dashboard', label: 'Designing Your Dashboard' });
        yield this.chunk('status', { message: 'Generating intelligent dashboard layout...' });

        try {
          const dashboard = await this.prisma.dashboard.create({
            data: {
              organizationId,
              ownerId: userId,
              title: plan.dashboard.title || this.deriveQueryTitle(userQuery),
              description: plan.dashboard.description || 'AI-generated strategic intelligence dashboard',
              config: { source: 'agent', query: userQuery, model: this.OLLAMA_MODEL } as Prisma.InputJsonValue,
              permissions: { shared: false } as Prisma.InputJsonValue,
            },
          });
          dashboardId = dashboard.id;
          dashboardTitle = dashboard.title;

          const widgets = plan.dashboard.widgets.length > 0
            ? plan.dashboard.widgets
            : this.queryAwareFallbackWidgets(userQuery);

          await this.prisma.dashboardWidget.createMany({
            data: widgets.map((w) => ({
              organizationId,
              dashboardId: dashboard.id,
              title: w.title,
              chartType: w.type,
              queryConfig: { metric: w.metric, grouping: w.grouping } as Prisma.InputJsonValue,
              chartConfig: { description: w.description } as Prisma.InputJsonValue,
              displayOrder: w.display_order,
            })),
          });

          // Link request to the generated dashboard
          await this.prisma.agentDashboardRequest.update({
            where: { id: request.id },
            data: { generatedDashboardId: dashboard.id },
          });

          actualWidgetCount = widgets.length;
          await logEvent('DASHBOARD_CREATED', { dashboardId, widgetCount: widgets.length });
          yield this.chunk('dashboard_created', {
            dashboardId,
            title: dashboard.title,
            description: plan.dashboard.description,
            widgetCount: widgets.length,
          });
          yield this.chunk('system', { action: 'DASHBOARD_REFRESH' });

        } catch (permErr: any) {
          this.logger.warn(`[Agent:Dashboard] Creation failed: ${permErr.message}`);
          yield this.chunk('dashboard_skipped', {
            reason: permErr.message?.includes('permission')
              ? 'Dashboard creation requires elevated permissions. Contact your admin.'
              : 'Dashboard generation encountered an issue.',
          });
        }
      }

      // ── PHASE 4: Synthesis Streaming ──────────────────────────────────
      yield this.chunk('phase', { phase: 'synthesis', label: 'Synthesizing Intelligence Brief' });
      yield this.chunk('status', { message: 'Composing your financial intelligence brief...' });

      const synthesisMessages = this.buildSynthesisMessages(
        userQuery,
        toolResults,
        plan,
        dashboardId,
        dashboardTitle,
        intent,
        editPlan,
        actualWidgetCount,
      );

      let fullResponse = '';
      let buffer = '';
      let tokenCount = 0;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 300_000);

      let response: Response;
      try {
        response = await fetch(`${this.OLLAMA_URL}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            model: this.OLLAMA_MODEL,
            messages: synthesisMessages,
            stream: true,
            options: {
              temperature: 0.2,
              num_predict: -1,        // unlimited — never truncate the response
              num_ctx: 8192,          // llama3 native max
              top_p: 0.8,
              top_k: 20,
              repeat_penalty: 1.05,
              stop: ['<|start_header_id|>', '<|end_header_id|>', '<|eot_id|>'],
            },
          }),
        });
      } catch (fetchErr: any) {
        clearTimeout(timeout);
        throw new Error(fetchErr.name === 'AbortError' ? 'AI_TIMEOUT' : 'AI_ENGINE_OFFLINE');
      }

      if (!response.ok) {
        clearTimeout(timeout);
        throw new Error('AI_ENGINE_OFFLINE');
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let lineCarry = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lineCarry += decoder.decode(value, { stream: true });
        const lines = lineCarry.split('\n');
        lineCarry = lines.pop() ?? '';
        let streamDone = false;
        for (const line of lines) {
          if (!line.trim()) continue;
          let parsed: { message?: { content?: string }; done?: boolean };
          try { parsed = JSON.parse(line); } catch { continue; }
          const token = parsed.message?.content;
          if (token) {
            fullResponse += token;
            buffer += token;
            if (buffer.length >= 8) {
              yield this.chunk('token', { content: buffer });
              tokenCount++;
              buffer = '';
            }
          }
          if (parsed.done === true) { streamDone = true; break; }
        }
        if (streamDone) break;
      }

      if (lineCarry.trim()) {
        try {
          const parsed = JSON.parse(lineCarry.trim()) as { message?: { content?: string } };
          if (parsed.message?.content) { fullResponse += parsed.message.content; buffer += parsed.message.content; }
        } catch { /* ignore */ }
      }
      if (buffer) {
        yield this.chunk('token', { content: buffer });
        tokenCount++;
      }
      clearTimeout(timeout);

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
        data: { status: 'SUCCEEDED', completedAt: new Date(), latencyMs: Date.now() - runStartedAt },
      });

      await logEvent('SYNTHESIS_COMPLETE', { tokens: tokenCount, dashboardId, intent });

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
          model: this.OLLAMA_MODEL,
          intent,
        },
      });

    } catch (error: any) {
      const message = error instanceof Error ? error.message : 'Agent failed unexpectedly.';
      this.logger.error(`[Agent:Fatal] ${message}`);

      await this.prisma.agentDashboardRequest.update({
        where: { id: request.id },
        data: { status: 'FAILED', errorCode: 'AGENT_QUERY_FAILED', errorMessage: message, completedAt: new Date() },
      }).catch(() => { });
      await this.prisma.agentRun.update({
        where: { id: run.id },
        data: { status: 'FAILED', completedAt: new Date(), latencyMs: Date.now() - runStartedAt },
      }).catch(() => { });

      let userMessage: string;
      if (message === 'AI_ENGINE_OFFLINE' || message?.includes('ECONNREFUSED')) {
        userMessage = '**AI engine is starting up.** Financial data has been gathered — please try again in a moment.';
      } else if (message === 'AI_TIMEOUT') {
        userMessage = '**Analysis timed out.** Try a more focused question.';
      } else if (message?.includes('permission')) {
        userMessage = '**Permission required.** You need dashboard creation permissions. Contact your org admin.';
      } else {
        userMessage = '**Agent encountered an error.** Please try again.';
      }

      yield this.chunk('error', { message: userMessage });
    }
  }

  // ─── Intent Detection ─────────────────────────────────────────────────────

  private detectIntent(query: string, hasActiveDashboard: boolean): QueryIntent {
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
    // Active dashboard exists + no explicit "create new" signals → default to edit the existing dashboard
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

  private async getConversationHistory(sessionId: string, organizationId: string): Promise<string> {
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
        const preview = m.content.length > 180 ? m.content.slice(0, 180) + '...' : m.content;
        return `${role}: ${preview}`;
      })
      .join('\n');
  }

  // ─── Deterministic Widget Selection ──────────────────────────────────────
  // The LLM is unreliable for widget selection (only 9 valid combos).
  // This function is the single source of truth for which charts to show.
  // It maps query intent → the exact most relevant chart combination.

  private selectWidgetsForQuery(
    query: string,
    activeDashboard?: ActiveDashboard | null,
  ): AgentPlan['dashboard']['widgets'] {
    const q = query.toLowerCase();
    const has = (r: RegExp) => r.test(q);

    type W = AgentPlan['dashboard']['widgets'][number];
    const mk = (
      title: string,
      description: string,
      type: 'line' | 'bar' | 'pie' | 'metric' | 'table',
      metric: string,
      grouping: string,
      order: number,
    ): W => ({ title, description, type, metric, grouping, display_order: order });

    // ── 0. Audit / list / drilldown focus ────────────────────────────────────
    if (has(/audit|list|show\b|detail|transaction|invoice\s+list|recent\s+invoice/)) {
      return [
        mk('Recent Invoices Ledger', 'Latest invoices for audit and drill-down', 'table', 'invoices', 'list', 0),
        mk('Invoice Portfolio by Status', 'Paid vs open vs overdue — collection efficiency', 'pie', 'invoices', 'status', 1),
        mk('Overdue AR Accumulation Trend', 'Monthly overdue build-up — collection velocity signal', 'line', 'overdue', 'month', 2),
      ];
    }

    // ── 0. Client / customer / contact focus ─────────────────────────────────
    if (has(/client|customer|contact|who.*paid|who.*bought|best.*client|top.*client|top.*customer/)) {
      // Overdue-heavy client query → show risk first
      if (has(/overdue|owe|debt|late|past.?due|risk|collect/)) {
        return [
          mk('Overdue Exposure by Client', 'How much each client has past their due date — collection risk', 'bar', 'overdue', 'client', 0),
          mk('Outstanding Balance by Client', 'Unpaid invoices not yet overdue — near-term cash flow', 'bar', 'outstanding', 'client', 1),
          mk('Revenue vs Exposure', 'Total paid revenue per client for context', 'bar', 'revenue', 'client', 2),
          mk('Overdue Rate by Client', 'Overdue as % of billed — worst offenders', 'bar', 'overdue_rate', 'client', 3),
        ];
      }
      // Compare / ranking query → show revenue + volume + overdue
      if (has(/compar|rank|vs\b|versus|benchmark|against|best|worst|top|bottom/)) {
        return [
          mk('Client Revenue Ranking', 'Total paid revenue per client — who drives your top line', 'bar', 'revenue', 'client', 0),
          mk('Invoice Volume by Client', 'Transaction frequency — engagement depth per client', 'bar', 'invoices', 'client', 1),
          mk('Overdue Exposure by Client', 'Collection risk concentration across clients', 'bar', 'overdue', 'client', 2),
          mk('Revenue Concentration', 'Share of total revenue — single-client dependency risk', 'pie', 'revenue', 'client', 3),
          mk('Collection Rate by Client', 'Paid as % of billed — collection efficiency', 'bar', 'collection_rate', 'client', 4),
        ];
      }
      // Default client intelligence dashboard
      return [
        mk('Top Clients by Revenue', 'Total paid revenue per client — who drives your top line', 'bar', 'revenue', 'client', 0),
        mk('Outstanding Balance by Client', 'Unpaid AR not yet overdue — cash to collect', 'bar', 'outstanding', 'client', 1),
        mk('Overdue Exposure by Client', 'Past-due AR per client — collection risk signal', 'bar', 'overdue', 'client', 2),
        mk('Revenue Concentration', 'Share of total revenue — single-client dependency risk', 'pie', 'revenue', 'client', 3),
        mk('Collection Rate by Client', 'Paid as % of billed — collection efficiency', 'bar', 'collection_rate', 'client', 4),
      ];
    }

    // ── 1. Overdue / AR / collection focus ───────────────────────────────────
    if (has(/overdue|aging|ar\b|receivable|collect|bad.?debt|payment.?risk/)) {
      const w: W[] = [
        mk('Overdue AR Accumulation Trend', 'Monthly overdue build-up — collection velocity signal', 'line', 'overdue', 'month', 0),
        mk('Invoice Portfolio by Status', 'Paid vs open vs overdue — collection efficiency rate', 'pie', 'invoices', 'status', 1),
      ];
      if (has(/entity|org|compan|who|which/)) {
        w.push(mk('Invoice Activity by Entity', 'Entity-level invoice exposure — overdue concentration', 'bar', 'invoices', 'org', 2));
      }
      return w;
    }

    // ── 2. Burn / runway / cash / venture focus ───────────────────────────────
    if (has(/burn|runway|cash|venture|fund|raise|investor|rule.?of.?40|survival/)) {
      return [
        mk('Revenue Growth Trajectory', 'Monthly revenue inflow vs outflow context', 'line', 'revenue', 'month', 0),
        mk('Invoice Portfolio Health', 'Cash collection mix — paid vs outstanding AR', 'pie', 'invoices', 'status', 1),
        mk('Overdue AR Risk', 'Unpaid AR accumulation — cash flow impact', 'line', 'overdue', 'month', 2),
      ];
    }

    // ── 3. Quarterly analysis ─────────────────────────────────────────────────
    if (has(/quarter|q[1-4]\b|qoq|quarter.?over.?quarter|quarterly/)) {
      const w: W[] = [
        mk('Quarterly Revenue Cadence', 'Quarter-by-quarter revenue — growth acceleration/deceleration', 'bar', 'revenue', 'quarter', 0),
        mk('Monthly Revenue Within Quarter', 'Month-level revenue granularity inside quarters', 'line', 'revenue', 'month', 1),
      ];
      if (has(/invoice|volume|activit/)) {
        w.push(mk('Invoice Volume by Quarter', 'Business activity velocity per quarter', 'line', 'invoice_count', 'month', 2));
      }
      return w;
    }

    // ── 4. Entity / concentration / comparison focus ──────────────────────────
    if (has(/entity|entiti|concentrat|org\b|compan|which.*(most|top|best|worst)|top.*entit|who.*contribut/)) {
      return [
        mk('Entity Revenue Concentration', 'Revenue by entity — single-entity dependency risk', 'bar', 'revenue', 'org', 0),
        mk('Entity Invoice Activity', 'Invoice volume distribution — most vs least active entities', 'bar', 'invoices', 'org', 1),
        mk('Invoice Portfolio by Status', 'Collection health — paid vs open vs overdue mix', 'pie', 'invoices', 'status', 2),
      ];
    }

    // ── 5. Invoice volume / activity focus ───────────────────────────────────
    if (has(/invoice.?vol|invoice.?count|activity.?vol|number.?of.?invoice|how.?many.?invoice/)) {
      return [
        mk('Invoice Volume Trend', 'Monthly invoice count — business activity momentum', 'line', 'invoice_count', 'month', 0),
        mk('Invoice Portfolio Health', 'Invoice status composition — collection efficiency', 'pie', 'invoices', 'status', 1),
        mk('Revenue Growth Trajectory', 'Revenue trend alongside activity volume', 'line', 'revenue', 'month', 2),
      ];
    }

    // ── 6. Provider / ERP / source system focus ───────────────────────────────
    if (has(/provider|erp|xero|quickbooks|netsuite|source.?system|which.?system|integration/)) {
      return [
        mk('Revenue by ERP Provider', 'Revenue split across accounting integrations', 'pie', 'revenue', 'provider', 0),
        mk('Revenue Growth Trajectory', 'Monthly revenue trend across all providers', 'line', 'revenue', 'month', 1),
      ];
    }

    // ── 7. Invoice health / AR portfolio / status focus ──────────────────────
    if (has(/invoice.?health|ar.?health|portfolio|paid.*unpaid|open.*invoice|status|collection.?rate|dso/)) {
      return [
        mk('Invoice Portfolio Health', 'Paid vs open vs overdue — collection efficiency', 'pie', 'invoices', 'status', 0),
        mk('Overdue AR Accumulation', 'Monthly overdue AR trend — risk velocity', 'line', 'overdue', 'month', 1),
        mk('Revenue Growth Trajectory', 'Revenue context for collections analysis', 'line', 'revenue', 'month', 2),
      ];
    }

    // ── 8. Revenue trend / growth / trajectory focus ─────────────────────────
    if (has(/revenue.?trend|revenue.?growth|revenue.?trajectory|growth.?trend|mom\b|month.?over.?month|yoy|year.?over.?year|revenue.?momentum|sales.?trend/)) {
      return [
        mk('Revenue Growth Trajectory', 'Monthly revenue with MoM acceleration/deceleration signals', 'line', 'revenue', 'month', 0),
        mk('Invoice Volume Momentum', 'Invoice count trend — business activity proxy', 'line', 'invoice_count', 'month', 1),
      ];
    }

    // ── 9. Board / CFO / executive / comprehensive overview ──────────────────
    if (has(/board|cfo|executive|overview|health.?check|full.?analysis|comprehensive|complete|summary/)) {
      return [
        mk('Revenue Growth Trajectory', 'Monthly revenue trend and momentum signals', 'line', 'revenue', 'month', 0),
        mk('Entity Revenue Concentration', 'Revenue concentration across entities', 'bar', 'revenue', 'org', 1),
        mk('Invoice Portfolio Health', 'Invoice status composition — collection health', 'pie', 'invoices', 'status', 2),
      ];
    }

    // ── 10. General revenue / income / sales focus ───────────────────────────
    if (has(/revenue|income|sales|earning|arr|mrr|total.?revenue/)) {
      return [
        mk('Revenue Growth Trajectory', 'Monthly revenue trend with momentum signals', 'line', 'revenue', 'month', 0),
        mk('Entity Revenue Concentration', 'Which entities drive your revenue', 'bar', 'revenue', 'org', 1),
      ];
    }

    // ── 11. Default — broad financial analysis ────────────────────────────────
    return [
      mk('Revenue Growth Trajectory', 'Monthly revenue trend', 'line', 'revenue', 'month', 0),
      mk('Entity Revenue Concentration', 'Revenue distribution across entities', 'bar', 'revenue', 'org', 1),
      mk('Invoice Portfolio Health', 'Invoice status composition', 'pie', 'invoices', 'status', 2),
    ];
  }

  // ─── Query-Aware Fallback Widgets (kept for edit plan validation only) ────

  private deriveQueryTitle(query: string): string {
    const q = query.toLowerCase();
    const has = (r: RegExp) => r.test(q);

    if (has(/client|customer|contact/)) return 'Top Client Revenue Analysis';
    if (has(/overdue|receivable|ar\b|aging|collection/)) return 'Overdue AR & Collection Risk Analysis';
    if (has(/burn|runway|cash.*hand|cash.*flow/)) return 'Cash Burn Rate & Runway Analysis';
    if (has(/quarter|q[1-4]\b|quarterly/)) return 'Quarterly Revenue Performance';
    if (has(/entity|entities|concentrat|org\b/)) return 'Entity Revenue Concentration Risk';
    if (has(/invoice.*vol|activity.*vol|volume/)) return 'Invoice Volume & Activity Trends';
    if (has(/provider|erp|xero|quickbooks/)) return 'ERP Provider Revenue Breakdown';
    if (has(/growth|trend|trajectory|momentum/)) return 'Revenue Growth Trajectory';
    if (has(/revenue|income|sales/)) return 'Revenue Performance Analysis';
    if (has(/invoice|ar\b|receivable/)) return 'Invoice Portfolio Health';
    if (has(/board|cfo|overview|health|executive/)) return 'Executive Financial Intelligence';
    if (has(/profit|margin|efficiency/)) return 'Profitability & Efficiency Analysis';

    // Last resort: use first meaningful words from query
    const words = query.trim().split(/\s+/).slice(0, 6).join(' ');
    return words.length > 8 ? words.charAt(0).toUpperCase() + words.slice(1) : 'Financial Analysis';
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
  private queryAwareFallbackWidgets(query: string): AgentPlan['dashboard']['widgets'] {
    return this.selectWidgetsForQuery(query);
  }

  // ─── Deterministic fallback tool selection ───────────────────────────────
  // Used only when Ollama fails both attempts.

  private selectToolsForQuery(query: string): string[] {
    const q = query.toLowerCase();
    const has = (r: RegExp) => r.test(q);
    const tools = new Set<string>(['financial_summary', 'revenue_trend', 'invoice_breakdown']);
    if (has(/entity|entities|org\b|compan|concentrat|who|which/)) tools.add('entity_comparison');
    if (has(/burn|runway|cash|venture|fund|raise|investor/)) tools.add('venture_metrics');
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

  private async getDataContext(organizationId: string): Promise<string> {
    try {
      const scope = await this.getOrgScope(organizationId);
      if (scope.connectionIds.length === 0) return 'No ERP connections found.';

      const orgIds = scope.externalOrgIds.length > 0 ? scope.externalOrgIds : ['__none__'];

      const [summary, topClients, entities] = await Promise.allSettled([
        this.queryRows<any>(
          `SELECT
             count()                                                                AS total_invoices,
             count(DISTINCT contact_id)                                             AS total_clients,
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
             AND issued_at IS NOT NULL`,
          { connectionIds: scope.connectionIds },
        ),
        this.queryRows<any>(
          `SELECT client_name, round(total_invoiced, 0) AS billed, round(total_overdue, 0) AS overdue
           FROM ${this.analyticsDb}.dim_clients FINAL
           WHERE org_id IN ({orgIds:Array(String)}) AND client_name != ''
           ORDER BY total_invoiced DESC LIMIT 5`,
          { orgIds },
        ),
        this.queryRows<any>(
          `SELECT coalesce(org_name, org_id) AS org_name, count() AS invoice_count
           FROM ${this.analyticsDb}.fact_accounting_invoices
           WHERE connection_id IN ({connectionIds:Array(String)})
           GROUP BY org_name ORDER BY invoice_count DESC LIMIT 5`,
          { connectionIds: scope.connectionIds },
        ),
      ]);

      const s = (summary.status === 'fulfilled' ? summary.value[0] : null) ?? {};
      const clients = topClients.status === 'fulfilled' ? topClients.value : [];
      const ents = entities.status === 'fulfilled' ? entities.value : [];

      const clientCount = this.num(s.total_clients) || clients.length;
      const topStr = clients
        .map((c: any) => `${c.client_name} ($${this.fmtK(this.num(c.billed))}${this.num(c.overdue) > 0 ? `, $${this.fmtK(this.num(c.overdue))} overdue` : ''})`)
        .join('; ');
      const entStr = ents.map((e: any) => e.org_name).filter(Boolean).join(', ');

      return [
        `LIVE DATA CONTEXT:`,
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

  // ─── Plan Generation — Ollama is the sole dashboard architect ───────────────
  // Ollama sees live data context + full chart vocabulary and decides freely.
  // selectWidgetsForQuery is only called if Ollama completely fails.

  private async generatePlan(
    query: string,
    _conversationHistory: string,
    activeDashboard: ActiveDashboard | null,
    dataContext: string,
  ): Promise<AgentPlan> {
    // Emergency fallback — only used if Ollama crashes/times out
    const fallback: AgentPlan = {
      tools_to_execute: this.selectToolsForQuery(query),
      should_generate_dashboard: true,
      dashboard: {
        title: this.deriveQueryTitle(query),
        description: 'AI-generated financial intelligence dashboard',
        widgets: this.selectWidgetsForQuery(query, activeDashboard),
      },
      analysis_focus: query,
    };

    const contextBlock = activeDashboard
      ? `${dataContext}\n\nCURRENT DASHBOARD: "${activeDashboard.title}" — pick DIFFERENT and MORE RELEVANT charts.`
      : dataContext;

    const userMsg = `${contextBlock}\n\nUSER QUERY: "${query}"`;

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
          format: 'json',
          options: {
            num_ctx: 8192,         // llama3 native max — full context window
            num_predict: -1,       // unlimited — let model finish naturally, no truncation
            temperature: 0.2,      // near-deterministic, best JSON quality
            top_p: 0.8,
            top_k: 20,
            repeat_penalty: 1.05,
            stop: ['<|start_header_id|>', '<|end_header_id|>', '<|eot_id|>'],
          },
        }),
      });
      clearTimeout(timer);

      if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);

      const body = await response.json() as { message?: { content?: string } };
      const raw = (body.message?.content ?? '').replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(raw) as any;

      const candidates: Array<{
        title?: string;
        tools?: string[];
        widgets?: Array<{ type: string; metric: string; grouping: string; title?: string }>;
      }> = Array.isArray(parsed?.candidates)
        ? parsed.candidates
        : [{ title: parsed?.title, tools: parsed?.tools, widgets: parsed?.widgets }];

      const buildCandidate = (cand: (typeof candidates)[number]) => {
        const validWidgets = (cand.widgets ?? [])
          .filter((w) =>
            VALID_WIDGETS.some((v) => v.type === w.type && v.metric === w.metric && v.grouping === w.grouping),
          )
          .filter((w, i, arr) =>
            // Enforce uniqueness: never repeat exact metric+grouping within a single dashboard.
            arr.findIndex((x) => x.metric === w.metric && x.grouping === w.grouping) === i,
          )
          .slice(0, 6)
          .map((w, i) => ({
            title: w.title ?? `${w.metric} ${w.type}`,
            description: '',
            type: w.type as 'line' | 'bar' | 'pie' | 'metric' | 'table',
            metric: w.metric,
            grouping: w.grouping,
            display_order: i,
          }));

        // Enforce minimum dashboard richness: if the model returns <4 valid widgets,
        // top up deterministically (query-aware) to reach 4 without duplicates.
        if (validWidgets.length < 4) {
          const existing = new Set(validWidgets.map((w) => `${w.type}/${w.metric}/${w.grouping}`));
          const filler = this.selectWidgetsForQuery(query, activeDashboard);
          for (const f of filler) {
            const key = `${f.type}/${f.metric}/${f.grouping}`;
            if (existing.has(key)) continue;
            if (!VALID_WIDGETS.some((v) => v.type === f.type && v.metric === f.metric && v.grouping === f.grouping)) continue;
            validWidgets.push({ ...f, display_order: validWidgets.length });
            existing.add(key);
            if (validWidgets.length >= 4) break;
          }
        }

        const validTools = (cand.tools ?? []).filter((t) =>
          ['revenue_trend', 'entity_comparison', 'invoice_breakdown', 'venture_metrics', 'financial_summary', 'client_breakdown', 'client_financial_profile'].includes(t),
        );

        const inferredTools = validTools.length > 0
          ? validTools
          : this.deriveToolsFromWidgets(validWidgets, query);

        return {
          title: (cand.title?.trim() && cand.title.length > 5) ? cand.title.trim() : fallback.dashboard.title,
          widgets: validWidgets,
          tools: inferredTools,
        };
      };

      const scored = candidates
        .map(buildCandidate)
        .filter((c) => c.widgets.length >= 1)
        .map((c) => ({ ...c, score: this.scorePlannedDashboard(query, c.widgets) }))
        .sort((a, b) => b.score - a.score);

      const best = scored[0];
      if (best) {
        this.logger.log(`[Agent:Planner] Ollama succeeded — picked plan score=${best.score.toFixed(1)}, widgets=${best.widgets.length}, tools=${best.tools.length}`);
        return {
          tools_to_execute: best.tools,
          should_generate_dashboard: true,
          dashboard: {
            title: best.title,
            description: 'AI-generated financial intelligence dashboard',
            widgets: best.widgets,
          },
          analysis_focus: query,
        };
      }

      this.logger.warn('[Agent:Planner] Ollama returned 0 valid widgets — activating emergency fallback');
    } catch (err: any) {
      this.logger.warn(`[Agent:Planner] Ollama failed (${err.message}) — activating emergency fallback`);
    }

    return fallback;
  }

  private deriveToolsFromWidgets(
    widgets: Array<{ type: 'line' | 'bar' | 'pie' | 'metric' | 'table'; metric: string; grouping: string }>,
    query: string,
  ): string[] {
    const tools = new Set<string>();

    for (const w of widgets) {
      if (w.metric === 'venture' || w.type === 'metric') tools.add('venture_metrics');
      if (w.grouping === 'month' || w.grouping === 'quarter') tools.add('revenue_trend');
      if (w.grouping === 'org' || w.grouping === 'provider') tools.add('entity_comparison');
      if (w.metric === 'invoices' || w.grouping === 'status') tools.add('invoice_breakdown');
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
    widgets: Array<{ type: 'line' | 'bar' | 'pie' | 'metric' | 'table'; metric: string; grouping: string }>,
  ): number {
    const q = query.toLowerCase();
    const has = (r: RegExp) => r.test(q);

    let score = 0;

    // Prefer 4-6 widgets (board-pack quality).
    score += Math.min(widgets.length, 6) * 10;
    if (widgets.length >= 4) score += 20;
    if (widgets.length < 4) score -= (4 - widgets.length) * 15;

    // Diversity across visualization types.
    const types = new Set(widgets.map((w) => w.type));
    if (types.has('line')) score += 8;
    if (types.has('bar')) score += 8;
    if (types.has('pie')) score += 6;
    if (types.has('metric')) score += 4;
    if (types.has('table')) score += 3;

    // Query-intent alignment (cheap, deterministic heuristic scoring).
    if (has(/client|customer|contact/)) score += widgets.filter((w) => w.grouping === 'client').length * 6;
    if (has(/overdue|aging|ar\b|receivable|collect|past.?due/)) {
      score += widgets.filter((w) => w.metric === 'overdue' || w.metric === 'overdue_rate').length * 8;
      score += widgets.filter((w) => w.grouping === 'status').length * 3;
    }
    if (has(/trend|growth|momentum|mom\b|yoy|month/)) score += widgets.filter((w) => w.type === 'line').length * 5;
    if (has(/quarter|q[1-4]\b|qoq|quarterly/)) score += widgets.filter((w) => w.grouping === 'quarter').length * 6;
    if (has(/entity|org\b|entities|compare|versus|vs\b|concentration/)) score += widgets.filter((w) => w.grouping === 'org').length * 5;
    if (has(/provider|erp|xero|quickbooks|qbo|netsuite|integration/)) score += widgets.filter((w) => w.grouping === 'provider').length * 7;
    if (has(/audit|list|show|detail|transaction/)) score += widgets.filter((w) => w.type === 'table').length * 8;
    if (has(/runway|burn|cash|venture|investor|fundraise/)) score += widgets.filter((w) => w.type === 'metric' || w.metric === 'venture').length * 6;

    return score;
  }

  // ─── Edit Plan Generation ─────────────────────────────────────────────────

  private async generateEditPlan(
    activeDashboard: ActiveDashboard,
    editRequest: string,
  ): Promise<DashboardEditPlan> {
    const widgetList = activeDashboard.widgets.map((w, i) => {
      const cfg = (w.queryConfig as any) ?? {};
      return `  ${i}. [${w.chartType.toUpperCase()}] ${w.title} — ${cfg.metric ?? '?'}/${cfg.grouping ?? '?'}`;
    }).join('\n');

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
          format: 'json',
        }),
      });
      clearTimeout(timeout);

      if (!response.ok) return editFallback;

      const body = await response.json() as { message?: { content?: string } };
      const raw = body.message?.content ?? '';
      const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
      const parsed = JSON.parse(cleaned) as DashboardEditPlan;

      // Validate add widgets against known pairs
      if (Array.isArray(parsed.add)) {
        parsed.add = parsed.add.filter((w) =>
          VALID_WIDGETS.some((v) => v.type === w.type && v.metric === w.metric && v.grouping === w.grouping),
        );
      } else {
        parsed.add = [];
      }

      // Clamp total widget count to 6
      const afterRemoves = activeDashboard.widgets.length - (parsed.remove_indices?.length ?? 0);
      const maxAdd = Math.max(0, 6 - afterRemoves);
      parsed.add = (parsed.add ?? []).slice(0, maxAdd);
      parsed.remove_indices = (parsed.remove_indices ?? []).filter((i) => i >= 0 && i < activeDashboard.widgets.length);
      parsed.modify = (parsed.modify ?? []).filter((m) => m.index >= 0 && m.index < activeDashboard.widgets.length);

      return parsed;

    } catch (err: any) {
      this.logger.warn(`[Agent:Editor] Edit plan parse failed (${err.message})`);
      return editFallback;
    }
  }

  // ─── Apply Dashboard Edit ─────────────────────────────────────────────────

  private async applyDashboardEdit(
    dashboardId: string,
    editPlan: DashboardEditPlan,
    organizationId: string,
  ): Promise<{ id: string; title: string; widgetCount: number }> {
    return this.prisma.$transaction(async (tx) => {
      const currentWidgets = await tx.dashboardWidget.findMany({
        where: { dashboardId },
        orderBy: { displayOrder: 'asc' },
      });

      const removeIds = editPlan.remove_indices
        .filter((i) => i >= 0 && i < currentWidgets.length)
        .map((i) => currentWidgets[i]!.id);

      // Apply type/title modifications
      for (const mod of editPlan.modify) {
        const widget = currentWidgets[mod.index];
        if (!widget || removeIds.includes(widget.id)) continue;
        const changes: Record<string, unknown> = {};
        if (mod.title) changes.title = mod.title;
        if (mod.type) changes.chartType = mod.type;
        if (mod.description) changes.chartConfig = { description: mod.description } as Prisma.InputJsonValue;
        if (Object.keys(changes).length > 0) {
          await tx.dashboardWidget.update({ where: { id: widget.id }, data: changes });
        }
      }

      // Remove widgets
      if (removeIds.length > 0) {
        await tx.dashboardWidget.deleteMany({ where: { id: { in: removeIds } } });
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
            queryConfig: { metric: w.metric, grouping: w.grouping } as Prisma.InputJsonValue,
            chartConfig: { description: w.description } as Prisma.InputJsonValue,
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

      const widgetCount = await tx.dashboardWidget.count({ where: { dashboardId } });
      return { id: dashboard.id, title: dashboard.title, widgetCount };
    });
  }

  // ─── Tool Execution ───────────────────────────────────────────────────────

  private async executeTools(tools: string[], scope: OrgScope): Promise<ToolResult[]> {
    const validTools = ['revenue_trend', 'entity_comparison', 'invoice_breakdown', 'venture_metrics', 'financial_summary', 'client_breakdown', 'client_financial_profile'];
    const toRun = [...new Set(tools.filter((t) => validTools.includes(t)))];

    const results = await Promise.allSettled(
      toRun.map((tool) => this.runTool(tool, scope)),
    );

    return results.map((r, i) => ({
      tool: toRun[i]!,
      data: r.status === 'fulfilled' ? r.value : { error: 'Tool execution failed' },
      rowCount: r.status === 'fulfilled' ? (Array.isArray(r.value) ? r.value.length : 1) : 0,
    }));
  }

  private async runTool(tool: string, scope: OrgScope): Promise<unknown> {
    if (scope.connectionIds.length === 0) return { message: 'No active ERP connections — sync integrations first.' };

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
           GROUP BY month ORDER BY month ASC LIMIT 18`,
          { externalOrgIds: scope.externalOrgIds },
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
           GROUP BY org_name, org_id, provider ORDER BY total_revenue DESC`,
          { connectionIds: scope.connectionIds },
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
           GROUP BY status ORDER BY status_total DESC LIMIT 15`,
          { connectionIds: scope.connectionIds },
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
           WHERE connection_id IN ({connectionIds:Array(String)})`,
          { connectionIds: scope.connectionIds },
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
          runwayMonths: monthlyBurn > 0 ? Math.round((revenue / monthlyBurn) * 10) / 10 : 0,
          efficiencyRatio: monthlyBurn > 0 ? Math.round((revenue / monthlyBurn) * 100) / 100 : 0,
          activeMonths: months,
        };
      }

      case 'financial_summary': {
        const rows = await this.queryRows<any>(
          `SELECT
             count() AS total_invoices,
             coalesce(sum(total_amount), 0) AS total_revenue,
             coalesce(avg(total_amount), 0) AS avg_invoice,
             coalesce(max(total_amount), 0) AS max_invoice,
             coalesce(min(total_amount), 0) AS min_invoice,
             coalesce(sumIf(total_amount, lowerUTF8(status) = 'overdue'), 0) AS overdue_amount,
             countIf(lowerUTF8(status) = 'overdue') AS overdue_count,
             count(DISTINCT provider) AS provider_count,
             count(DISTINCT org_id) AS entity_count
           FROM ${this.analyticsDb}.fact_accounting_invoices
           WHERE connection_id IN ({connectionIds:Array(String)})`,
          { connectionIds: scope.connectionIds },
        );
        return rows[0] ?? {};
      }

      case 'client_breakdown': {
        if (scope.externalOrgIds.length === 0) return [];
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
           ORDER BY total_revenue DESC LIMIT 20`,
          { externalOrgIds: scope.externalOrgIds },
        );
      }

      case 'client_financial_profile': {
        // Full per-client financial picture from the gold table.
        // The agent uses this data for comparisons, summaries, and pattern detection.
        if (scope.externalOrgIds.length === 0) return [];
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
           ORDER BY total_invoiced DESC LIMIT 50`,
          { externalOrgIds: scope.externalOrgIds },
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
    const toolSummary = toolResults.map((r) => {
      const dataStr = JSON.stringify(r.data, null, 2);
      const preview = dataStr.length > 4000 ? dataStr.slice(0, 4000) + '\n...(truncated)' : dataStr;
      return `### ${this.toolLabel(r.tool)} (${r.rowCount} records)\n\`\`\`json\n${preview}\n\`\`\``;
    }).join('\n\n');

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

  private async getOrgScope(organizationId: string): Promise<OrgScope> {
    const conns = await this.prisma.erpConnection.findMany({
      where: { organizationId, status: 'ACTIVE' },
      select: { id: true, externalOrganizationId: true },
    });
    return {
      connectionIds: conns.map((c) => c.id),
      externalOrgIds: conns.map((c) => c.externalOrganizationId).filter((v): v is string => Boolean(v)),
    };
  }

  private async queryRows<T>(query: string, params: Record<string, unknown>): Promise<T[]> {
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
    if (typeof v === 'string') { const n = Number(v); return Number.isFinite(n) ? n : 0; }
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

  private chunk(type: string, payload: Record<string, unknown>): string {
    return JSON.stringify({ type, ...payload }) + '\n';
  }
}
