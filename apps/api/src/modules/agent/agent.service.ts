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

type ChartType =
  | 'line'
  | 'bar'
  | 'pie'
  | 'donut'
  | 'metric'
  | 'kpi'
  | 'table'
  | 'area'
  | 'treemap'
  | 'scatter'
  | 'stacked_bar'
  | 'waterfall'
  | 'histogram'
  | 'horizontal_bar'
  | 'pareto'
  | 'gauge'
  | 'bubble'
  | 'heatmap';

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
      type: ChartType;
      metric: string;
      grouping: string;
      breakdown?: 'client';
      topN?: number;
      // Presentation-only hints for the frontend (ignored by /agent/metrics).
      display?: {
        donut?: boolean;
        highlightMaxMin?: boolean;
      };
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
    type: ChartType;
    metric: string;
    grouping: string;
    breakdown?: 'client';
    topN?: number;
  }>;
  remove_indices: number[];
  modify: Array<{
    index: number;
    title?: string;
    type?: ChartType;
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
  requiredTypes?: ChartType[];
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
  { type: 'bar', metric: 'invoice_count', grouping: 'month' },
  { type: 'line', metric: 'overdue', grouping: 'month' },
  { type: 'line', metric: 'collection_rate', grouping: 'month' },
  { type: 'line', metric: 'mom_growth', grouping: 'month' },
  { type: 'line', metric: 'revenue', grouping: 'quarter' },
  { type: 'line', metric: 'avg_invoice', grouping: 'month' },
  { type: 'bar', metric: 'avg_invoice', grouping: 'month' },
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
  { type: 'pie',            metric: 'revenue', grouping: 'client' },
  { type: 'pie',            metric: 'revenue', grouping: 'provider' },
  // ── Revenue by GL account / category (from journal lines)
  { type: 'bar',            metric: 'revenue', grouping: 'account' },
  { type: 'horizontal_bar', metric: 'revenue', grouping: 'account' },
  { type: 'pie',            metric: 'revenue', grouping: 'account' },
  { type: 'donut',          metric: 'revenue', grouping: 'account' },
  { type: 'bar',            metric: 'revenue', grouping: 'category' },
  { type: 'horizontal_bar', metric: 'revenue', grouping: 'category' },
  { type: 'pie',            metric: 'revenue', grouping: 'category' },
  { type: 'pie',            metric: 'invoices', grouping: 'status' },
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

  // ── P&L / Income Statement (sourced from fact_accounting_journal_lines)
  { type: 'line',   metric: 'net_income',         grouping: 'month'   },
  { type: 'bar',    metric: 'net_income',         grouping: 'month'   },
  { type: 'bar',    metric: 'net_income',         grouping: 'quarter' },
  { type: 'line',   metric: 'expense',            grouping: 'month'   },
  { type: 'bar',    metric: 'expense',            grouping: 'month'   },
  { type: 'bar',    metric: 'expense',            grouping: 'quarter' },
  { type: 'line',   metric: 'gross_profit',       grouping: 'month'   },
  { type: 'line',   metric: 'gross_margin_pct',   grouping: 'month'   },
  { type: 'line',   metric: 'net_margin_pct',     grouping: 'month'   },
  { type: 'line',   metric: 'ebitda',             grouping: 'month'   },
  { type: 'line',   metric: 'revenue_vs_expense', grouping: 'month'   },
  { type: 'bar',    metric: 'revenue_vs_expense', grouping: 'month'   },

  // ── Expense breakdowns by GL account
  { type: 'bar',    metric: 'expense',            grouping: 'account' },
  { type: 'pie',    metric: 'expense',            grouping: 'account' },
  // Expense breakdowns by user-defined cost category (e.g., Admin / Marketing / Sales)
  { type: 'bar',    metric: 'expense',            grouping: 'category' },
  { type: 'pie',    metric: 'expense',            grouping: 'category' },
  { type: 'bar',    metric: 'opex',               grouping: 'account' },
  { type: 'bar',    metric: 'cogs',               grouping: 'account' },
  // Admin-only expense cuts (requires map_account_cost_categories mapping)
  { type: 'line',   metric: 'admin_expense',      grouping: 'month' },
  { type: 'bar',    metric: 'admin_expense',      grouping: 'month' },
  { type: 'bar',    metric: 'admin_expense',      grouping: 'account' },
  { type: 'table',  metric: 'admin_expense',      grouping: 'list' },

  // ── CFO / controller-style extras
  { type: 'area',   metric: 'revenue_cumulative', grouping: 'month' },
  { type: 'line',   metric: 'revenue_cumulative', grouping: 'month' },
  { type: 'bar',    metric: 'debits_credits',     grouping: 'month' },
  { type: 'stacked_bar', metric: 'debits_credits', grouping: 'month' },
  { type: 'bar',    metric: 'net_position',       grouping: 'month' },
  { type: 'waterfall', metric: 'net_position',    grouping: 'month' },
  { type: 'line',   metric: 'running_balance',    grouping: 'month' },
  { type: 'bar',    metric: 'invoice_amount',     grouping: 'bucket' },
  { type: 'table',  metric: 'top_invoices',       grouping: 'list' },
  { type: 'pie',    metric: 'invoice_value',      grouping: 'invoice_type' },
  { type: 'pie',    metric: 'transaction_value',  grouping: 'journal_type' },
  { type: 'pie',    metric: 'transaction_value',  grouping: 'currency' },
  { type: 'treemap', metric: 'expense',           grouping: 'account' },
  { type: 'scatter', metric: 'invoice_amount',    grouping: 'time' },

  // ── P&L tables and metric tiles
  { type: 'table',  metric: 'pl',                 grouping: 'summary' },
  { type: 'table',  metric: 'expense',            grouping: 'list'    },
  { type: 'table',  metric: 'gl_transactions',    grouping: 'list'    },
  { type: 'metric', metric: 'pl_summary',         grouping: 'summary' },
  { type: 'metric', metric: 'expense_summary',    grouping: 'summary' },

  // ── Department dimension (QB DepartmentRef / Xero TrackingCategory 1)
  { type: 'bar',          metric: 'expense',      grouping: 'department' },
  { type: 'pie',          metric: 'expense',      grouping: 'department' },
  { type: 'donut',        metric: 'expense',      grouping: 'department' },
  { type: 'treemap',      metric: 'expense',      grouping: 'department' },
  { type: 'horizontal_bar', metric: 'expense',    grouping: 'department' },
  { type: 'stacked_bar',  metric: 'expense',      grouping: 'department' },
  { type: 'line',         metric: 'expense',      grouping: 'department' },
  { type: 'bar',          metric: 'net_income',   grouping: 'department' },
  { type: 'line',         metric: 'net_income',   grouping: 'department' },
  { type: 'bar',          metric: 'revenue',      grouping: 'department' },
  { type: 'pie',          metric: 'revenue',      grouping: 'department' },

  // ── Class dimension (QB ClassRef / Xero TrackingCategory 2)
  { type: 'bar',          metric: 'expense',      grouping: 'class' },
  { type: 'pie',          metric: 'expense',      grouping: 'class' },
  { type: 'donut',        metric: 'expense',      grouping: 'class' },
  { type: 'treemap',      metric: 'expense',      grouping: 'class' },
  { type: 'horizontal_bar', metric: 'expense',    grouping: 'class' },
  { type: 'stacked_bar',  metric: 'expense',      grouping: 'class' },

  // ── Vendor dimension (QB VendorRef / Xero contact on bills)
  { type: 'bar',          metric: 'expense',      grouping: 'vendor' },
  { type: 'horizontal_bar', metric: 'expense',    grouping: 'vendor' },
  { type: 'pie',          metric: 'expense',      grouping: 'vendor' },
  { type: 'donut',        metric: 'expense',      grouping: 'vendor' },
  { type: 'treemap',      metric: 'expense',      grouping: 'vendor' },
  { type: 'pareto',       metric: 'expense',      grouping: 'vendor' },
  { type: 'table',        metric: 'expense',      grouping: 'vendor' },
  { type: 'scatter',      metric: 'expense',      grouping: 'vendor' },
  { type: 'bubble',       metric: 'expense',      grouping: 'vendor' },
  { type: 'line',         metric: 'expense',      grouping: 'vendor' },

  // ── Debit / Credit by account type (balance-sheet analysis)
  { type: 'bar',          metric: 'debits_credits', grouping: 'account_type' },
  { type: 'stacked_bar',  metric: 'debits_credits', grouping: 'account_type' },
  { type: 'pie',          metric: 'debits_credits', grouping: 'account_type' },

  // ── Multi-series monthly expense with department breakdown
  { type: 'stacked_bar',  metric: 'expense',      grouping: 'month_department' },
  { type: 'line',         metric: 'expense',      grouping: 'month_department' },
  { type: 'area',         metric: 'expense',      grouping: 'month_department' },
  // ── Vendor spend trend (multi-series line per vendor over months)
  { type: 'line',         metric: 'expense',      grouping: 'vendor_month' },
  { type: 'stacked_bar',  metric: 'expense',      grouping: 'vendor_month' },
  { type: 'area',         metric: 'expense',      grouping: 'vendor_month' },

  // ── Vendor transactions (scatter / bubble for risk / concentration)
  { type: 'scatter',      metric: 'vendor_transactions', grouping: 'vendor' },
  { type: 'bubble',       metric: 'vendor_transactions', grouping: 'vendor' },

  // ── GL transactions by vendor (table)
  { type: 'table',        metric: 'gl_transactions', grouping: 'vendor' },

  // ── Monthly by class (multi-series)
  { type: 'stacked_bar',  metric: 'expense',      grouping: 'month_class' },
  { type: 'line',         metric: 'expense',      grouping: 'month_class' },
  { type: 'area',         metric: 'expense',      grouping: 'month_class' },

  // ── Dept × Class cross breakdown
  { type: 'stacked_bar',  metric: 'expense',      grouping: 'dept_class' },
  { type: 'bar',          metric: 'expense',      grouping: 'dept_class' },

  // ── Department stats scatter
  { type: 'scatter',      metric: 'expense',      grouping: 'dept_stats' },

  // ── Revenue vs Expense by department
  { type: 'stacked_bar',  metric: 'revenue_vs_expense', grouping: 'department' },
  { type: 'bar',          metric: 'revenue_vs_expense', grouping: 'department' },

  // ── P&L waterfall
  { type: 'waterfall',    metric: 'pl',           grouping: 'summary' },

  // ── Monthly financial KPI lines
  { type: 'line',         metric: 'gross_profit', grouping: 'month' },
  { type: 'line',         metric: 'net_margin',   grouping: 'month' },
  { type: 'line',         metric: 'expense_ratio', grouping: 'month' },
  { type: 'line',         metric: 'net_position', grouping: 'month' },

  // ── Balance sheet: assets / liabilities / equity / balance_sheet summary
  { type: 'donut',          metric: 'assets',         grouping: 'account_type' },
  { type: 'pie',            metric: 'assets',         grouping: 'account_type' },
  { type: 'bar',            metric: 'assets',         grouping: 'breakdown' },
  { type: 'horizontal_bar', metric: 'assets',         grouping: 'breakdown' },
  { type: 'donut',          metric: 'assets',         grouping: 'breakdown' },
  { type: 'donut',          metric: 'liabilities',    grouping: 'account_type' },
  { type: 'pie',            metric: 'liabilities',    grouping: 'account_type' },
  { type: 'bar',            metric: 'liabilities',    grouping: 'breakdown' },
  { type: 'horizontal_bar', metric: 'liabilities',    grouping: 'breakdown' },
  { type: 'donut',          metric: 'liabilities',    grouping: 'breakdown' },
  { type: 'bar',            metric: 'equity',         grouping: 'breakdown' },
  { type: 'donut',          metric: 'equity',         grouping: 'breakdown' },
  { type: 'bar',            metric: 'balance_sheet',  grouping: 'summary' },
  { type: 'donut',          metric: 'balance_sheet',  grouping: 'summary' },
  { type: 'table',          metric: 'trial_balance',  grouping: 'summary' },
  { type: 'table',          metric: 'trial_balance',  grouping: 'list' },
  { type: 'table',          metric: 'gl_dump',        grouping: 'detail' },
  { type: 'bar',            metric: 'income',         grouping: 'breakdown' },
  { type: 'donut',          metric: 'income',         grouping: 'breakdown' },
  { type: 'bar',            metric: 'account_type',   grouping: 'breakdown' },
  { type: 'donut',          metric: 'account_type',   grouping: 'breakdown' },

  // ── Account type treemap / top debits / top credits / scatter
  { type: 'treemap',      metric: 'accounts',     grouping: 'account_type' },
  { type: 'bar',          metric: 'debits',       grouping: 'account_type' },
  { type: 'bar',          metric: 'credits',      grouping: 'account_type' },
  { type: 'scatter',      metric: 'debits_credits', grouping: 'account' },

  // ── Monthly debits vs credits stacked
  { type: 'stacked_bar',  metric: 'debits_credits', grouping: 'month' },
  { type: 'donut',        metric: 'debits_credits', grouping: 'account_type' },
] as const;

// ─── Planning Prompt — minimal for fast Ollama inference ─────────────────────
// Small context + small output = fast response, no timeouts.

// ─── Planner Prompt — Ollama is the sole dashboard architect.
// It receives live data context + full chart vocabulary and decides freely.
// NO hardcoded chart selection happens before this prompt runs.

const PLANNER_SYSTEM = `You are a world-class CFO analytics copilot. Given a user query and LIVE DATA from their accounting system, design the minimum set of accurate charts needed to answer the user's request. Output JSON only. No explanation.

CHART TYPE MAPPING — map user language to EXACT type. This rule is ABSOLUTE — never substitute:
  "line chart" → line          "bar chart" / "column chart" → bar           "area chart" → area
  "waterfall chart" → waterfall  "stacked bar" / "stacked column" → stacked_bar
  "pie chart" → pie              "donut chart" / "doughnut" / "ring chart" → donut
  "treemap" → treemap            "scatter plot" / "scatter chart" → scatter
  "histogram" → histogram        "horizontal bar" / "ranked horizontal bar" / "ranked bar" → horizontal_bar
  "pareto chart" → pareto        "gauge chart" / "speedometer" → gauge
  "bubble chart" → bubble        "heatmap" / "heat map" → heatmap
  "KPI cards" / "KPI tiles" / "metric cards" → kpi    "metric" / "tile" → metric
  "table" / "list" → table       "clustered bar" / "clustered column" → bar
  "multi-line" → line (use breakdown param)   "box plot" → horizontal_bar

AVAILABLE CHART VOCABULARY — use ONLY these exact type/metric/grouping values:

LINE:
  line/revenue/month              line/outstanding/month          line/paid/month
  line/invoice_count/month        line/overdue/month              line/collection_rate/month
  line/mom_growth/month           line/revenue/quarter            line/avg_invoice/month
  line/dso/month                  line/net_income/month           line/expense/month
  line/gross_profit/month         line/gross_margin_pct/month     line/net_margin_pct/month
  line/ebitda/month               line/revenue_vs_expense/month   line/revenue_cumulative/month
  line/running_balance/month

BAR:
  bar/revenue/month               bar/revenue/org                 bar/revenue/quarter
  bar/revenue/client              bar/total_invoiced/client       bar/outstanding/client
  bar/overdue/client              bar/invoices/client             bar/avg_invoice/client
  bar/avg_invoice/month           bar/paid/client                 bar/collection_rate/client
  bar/expense/month               bar/expense/account             bar/net_income/month
  bar/net_income/quarter          bar/revenue_vs_expense/month    bar/debits_credits/month
  bar/net_position/month          bar/invoice_count/month         bar/top_invoices/value
  bar/expense_by_type/source      bar/pl_accounts/account         bar/bs_accounts/account
  bar/accounts_by_type/classification

HORIZONTAL_BAR (horizontal ranked bars):
  horizontal_bar/revenue/client   horizontal_bar/top_invoices/value
  horizontal_bar/expense/account  horizontal_bar/overdue/client

STACKED_BAR:
  stacked_bar/debits_credits/month    stacked_bar/expense_by_type/month
  stacked_bar/revenue_vs_expense/month

AREA:
  area/revenue/month              area/revenue_cumulative/month   area/outstanding/month

WATERFALL:
  waterfall/net_position/month

PIE:
  pie/revenue/client              pie/invoices/status             pie/expense/account
  pie/invoice_value/invoice_type  pie/transaction_value/source_type
  pie/transaction_value/currency  pie/accounts/classification     pie/accounts/active_status

DONUT (ring display, same data sources as pie):
  donut/revenue/client            donut/invoice_value/invoice_type
  donut/expense/account           donut/transaction_value/source_type
  donut/transaction_value/currency  donut/accounts/classification

TREEMAP:
  treemap/expense/account         treemap/revenue/client
  treemap/expense/department      treemap/expense/class           treemap/expense/vendor

SCATTER:
  scatter/invoice_amount/time     scatter/expense/vendor          scatter/vendor_transactions/vendor

HISTOGRAM:
  histogram/invoice_amount/bucket   histogram/payment_days/bucket

PARETO:
  pareto/revenue/client           pareto/expense/account          pareto/expense/vendor

BUBBLE:
  bubble/clients/revenue_invoices_avg   bubble/expense/vendor     bubble/vendor_transactions/vendor

HEATMAP:
  heatmap/revenue_expense/month

GAUGE:
  gauge/financial_health/summary

KPI:
  kpi/summary/overview

METRIC:
  metric/venture/summary          metric/pl_summary/summary       metric/expense_summary/summary

TABLE:
  table/invoices/list             table/overdue/aging             table/top_invoices/list
  table/payment_days/list         table/pl/summary                table/expense/list
  table/gl_transactions/list      table/expense/vendor

DEPARTMENT dimension (use when user asks "by department", "by division", "Admin/Sales/Operations split"):
  bar/expense/department          pie/expense/department          donut/expense/department
  treemap/expense/department      horizontal_bar/expense/department
  stacked_bar/expense/department  line/expense/department
  bar/net_income/department       bar/revenue/department          pie/revenue/department
  bar/revenue/account             pie/revenue/account             horizontal_bar/revenue/account
  bar/revenue/category            pie/revenue/category            horizontal_bar/revenue/category

CLASS dimension (use when user asks "by class", "General/Marketing/Product split"):
  bar/expense/class               pie/expense/class               donut/expense/class
  treemap/expense/class           horizontal_bar/expense/class    stacked_bar/expense/class

VENDOR dimension (use when user asks "by vendor", "vendor spend", "supplier analysis"):
  bar/expense/vendor              horizontal_bar/expense/vendor   pie/expense/vendor
  donut/expense/vendor            treemap/expense/vendor          pareto/expense/vendor
  table/expense/vendor            scatter/expense/vendor          bubble/expense/vendor
  line/expense/vendor

DEBIT/CREDIT by account type:
  bar/debits_credits/account_type   stacked_bar/debits_credits/account_type
  pie/debits_credits/account_type

MONTHLY expense with department multi-series:
  stacked_bar/expense/month_department   line/expense/month_department

TOOLS:
  revenue_trend, entity_comparison, invoice_breakdown, venture_metrics,
  financial_summary, client_breakdown, client_financial_profile

RULES:
1. Read LIVE DATA CONTEXT — base choices on actual numbers.
2. ABSOLUTE: If user names a chart type, output THAT EXACT type. "waterfall chart" → waterfall. "donut chart" → donut. "histogram" → histogram. "bubble chart" → bubble. "gauge" → gauge. NEVER substitute.
3. If no chart type specified, pick best type for the data (trend→line, comparison→bar, proportion→pie, distribution→histogram).
4. NEVER repeat same metric+grouping. Max 8 widgets per dashboard.
5. Title each chart specifically — not generic.
6. For cumulative/running total → area/revenue_cumulative/month or line/revenue_cumulative/month.
7. For distribution → histogram/invoice_amount/bucket.
8. For ranked horizontal bars → horizontal_bar type.
9. For donut charts → donut type (never pie when user says donut).
10. For executive/CFO dashboard → kpi/summary/overview + line/revenue_vs_expense/month + line/net_income/month + bar/expense/account + bar/revenue/client + table/pl/summary.
11. For KPI cards → kpi/summary/overview.
12. For gauge → gauge/financial_health/summary.
13. For bubble → bubble/clients/revenue_invoices_avg.
14. For Pareto → pareto/revenue/client or pareto/expense/account.
15. For "split by invoice type" → pie/invoice_value/invoice_type or donut/invoice_value/invoice_type.
16. For "by journal type" / "by source type" → pie/transaction_value/source_type or donut/transaction_value/source_type.
17. For stacked expenses by month → stacked_bar/expense_by_type/month.
18. For "by account type" / "P&L vs Balance Sheet" → bar/accounts_by_type/classification or pie/accounts/classification.
19. For "by department" / "Admin/Sales/Operations" single snapshot (no time axis) → use grouping "department" (e.g. bar/expense/department, pie/expense/department).
20. For "by class" / "General/Marketing/Product" → use grouping "class" (e.g. bar/expense/class, donut/expense/class).
21. For "by vendor" / "vendor spend" / "supplier" / "top vendors" → use grouping "vendor" (e.g. horizontal_bar/expense/vendor, pareto/expense/vendor, table/expense/vendor).
22. For "debit vs credit by account type" → bar/debits_credits/account_type or stacked_bar/debits_credits/account_type.
23. CRITICAL — For ANY request that mentions BOTH departments AND months/trend/over time/multi-line → ALWAYS use line/expense/month_department or stacked_bar/expense/month_department. This includes: "monthly spend per department", "trend for Admin/Sales/Operations", "multi-line by department", "department breakdown over time", "how each dept spends per month".
24. For vendor scatter/bubble (spend vs transactions) → scatter/expense/vendor or bubble/vendor_transactions/vendor.
25. For clustered column comparing departments → stacked_bar/expense/department with breakdown.
26. CRITICAL — For "income sources", "revenue by account", "revenue breakdown", "revenue by category", "income category", "where does revenue come from", "revenue split" → ALWAYS use metric="revenue", grouping="account" (e.g. horizontal_bar/revenue/account, bar/revenue/account, pie/revenue/account). NEVER use dynamic SQL for revenue breakdown.
27. ANY question not in vocabulary → output type="bar", metric="dynamic", grouping="sql" — the backend will auto-generate ClickHouse SQL.
28. CRITICAL — NEVER generate multiple widgets for the same chart broken out by year. A single chart request ("annual operating spend", "total expenses by department") = EXACTLY ONE widget covering ALL available data. Only split by year when the user explicitly says "compare years", "year over year", "by year", or "2023 vs 2024". "Annual" means the full dataset period, NOT one widget per calendar year.

OUTPUT FORMAT (JSON only):
{"candidates":[{"title":"...","tools":["tool1"],"widgets":[{"type":"line","metric":"revenue","grouping":"month","title":"Monthly Revenue Trend"}]}]}

EXAMPLES:
Q: "Create a line chart showing total revenue by month for the last 12 months" → {"candidates":[{"title":"Monthly Revenue — Last 12 Months","tools":["revenue_trend"],"widgets":[{"type":"line","metric":"revenue","grouping":"month","title":"Total Revenue by Month"}]}]}
Q: "Create a horizontal bar chart showing income sources by revenue category" → {"candidates":[{"title":"Income Sources by Revenue Category","tools":["revenue_trend"],"widgets":[{"type":"horizontal_bar","metric":"revenue","grouping":"account","title":"Revenue Breakdown by Account"}]}]}
Q: "Show revenue breakdown by category" → {"candidates":[{"title":"Revenue by Category","tools":["revenue_trend"],"widgets":[{"type":"bar","metric":"revenue","grouping":"account","title":"Revenue by Account Category"}]}]}
Q: "Create a multi-line chart showing monthly spend trends for Admin, Operations, and Sales departments" → {"candidates":[{"title":"Monthly Spend by Department","tools":["expense_trend"],"widgets":[{"type":"line","metric":"expense","grouping":"month_department","title":"Monthly Spend — Admin vs Operations vs Sales"}]}]}
Q: "Show expense trend by department over time" → {"candidates":[{"title":"Dept Expense Trend","tools":["expense_trend"],"widgets":[{"type":"stacked_bar","metric":"expense","grouping":"month_department","title":"Monthly Expenses by Department"}]}]}
Q: "Create an area chart showing cumulative revenue growth across the year" → {"candidates":[{"title":"Cumulative Revenue Growth","tools":["revenue_trend"],"widgets":[{"type":"area","metric":"revenue_cumulative","grouping":"month","title":"Cumulative Revenue Growth Across the Year"}]}]}
Q: "Create a waterfall chart showing net monthly financial position using total credits minus total debits" → {"candidates":[{"title":"Net Monthly Financial Position","tools":["financial_summary"],"widgets":[{"type":"waterfall","metric":"net_position","grouping":"month","title":"Net Monthly Position — Credits Minus Debits"}]}]}
Q: "Create a stacked bar chart showing debit and credit amounts by month" → {"candidates":[{"title":"Monthly Debits vs Credits","tools":["financial_summary"],"widgets":[{"type":"stacked_bar","metric":"debits_credits","grouping":"month","title":"Monthly Debits and Credits (Stacked)"}]}]}
Q: "Create a donut chart showing the split of total transaction value by invoice type" → {"candidates":[{"title":"Invoice Type Distribution","tools":["financial_summary"],"widgets":[{"type":"donut","metric":"invoice_value","grouping":"invoice_type","title":"Transaction Value Split by Invoice Type"}]}]}
Q: "Create a pie chart showing total transaction value by journal type such as AP, AR, EX" → {"candidates":[{"title":"Transaction Value by Source Type","tools":["financial_summary"],"widgets":[{"type":"pie","metric":"transaction_value","grouping":"source_type","title":"Transaction Value by Journal Type"}]}]}
Q: "Create a histogram showing the distribution of invoice amounts" → {"candidates":[{"title":"Invoice Amount Distribution","tools":["financial_summary"],"widgets":[{"type":"histogram","metric":"invoice_amount","grouping":"bucket","title":"Invoice Amount Distribution"}]}]}
Q: "Create a ranked horizontal bar chart showing the top 10 highest-value invoices" → {"candidates":[{"title":"Top 10 Highest-Value Invoices","tools":["financial_summary"],"widgets":[{"type":"horizontal_bar","metric":"top_invoices","grouping":"value","title":"Top 10 Invoices by Value"}]}]}
Q: "Create a treemap showing expense contribution by account name" → {"candidates":[{"title":"Expense Treemap by Account","tools":["financial_summary"],"widgets":[{"type":"treemap","metric":"expense","grouping":"account","title":"Expense Contribution by Account"}]}]}
Q: "Create a Pareto chart showing revenue concentration among top clients" → {"candidates":[{"title":"Revenue Pareto — Client Concentration","tools":["client_financial_profile"],"widgets":[{"type":"pareto","metric":"revenue","grouping":"client","title":"Revenue Concentration (80/20 Pareto)"}]}]}
Q: "Create a bubble chart showing clients by total revenue, number of invoices, and average invoice value" → {"candidates":[{"title":"Client Revenue Bubble Analysis","tools":["client_financial_profile"],"widgets":[{"type":"bubble","metric":"clients","grouping":"revenue_invoices_avg","title":"Clients — Revenue vs Invoice Count vs Avg Value"}]}]}
Q: "Create KPI cards showing total revenue, total expenses, net profit, avg invoice value, number of invoices, and ending balance" → {"candidates":[{"title":"Executive KPI Dashboard","tools":["financial_summary"],"widgets":[{"type":"kpi","metric":"summary","grouping":"overview","title":"Key Financial Performance Indicators"}]}]}
Q: "Create a gauge chart showing current financial health" → {"candidates":[{"title":"Financial Health Gauge","tools":["financial_summary"],"widgets":[{"type":"gauge","metric":"financial_health","grouping":"summary","title":"Overall Financial Health Score"}]}]}
Q: "Create a heatmap showing monthly revenue and expenses side by side" → {"candidates":[{"title":"Revenue vs Expenses Heatmap","tools":["financial_summary","revenue_trend"],"widgets":[{"type":"heatmap","metric":"revenue_expense","grouping":"month","title":"Monthly Revenue vs Expenses Heatmap"}]}]}
Q: "Create a bar chart showing total expenses by account name" → {"candidates":[{"title":"Expense Breakdown by Account","tools":["financial_summary"],"widgets":[{"type":"bar","metric":"expense","grouping":"account","title":"Total Expenses by Account Name"}]}]}
Q: "Create a stacked column chart showing monthly expenses broken down by account category" → {"candidates":[{"title":"Monthly Expenses by Category","tools":["financial_summary"],"widgets":[{"type":"stacked_bar","metric":"expense_by_type","grouping":"month","title":"Monthly Expenses by Source Category"}]}]}
Q: "Create a bar chart showing total transaction amount by account type" → {"candidates":[{"title":"Transactions by Account Type","tools":["financial_summary"],"widgets":[{"type":"bar","metric":"accounts_by_type","grouping":"classification","title":"Total by Account Classification"}]}]}
Q: "Create a bar chart showing total amount for Profit & Loss accounts" → {"candidates":[{"title":"P&L Accounts Breakdown","tools":["financial_summary"],"widgets":[{"type":"bar","metric":"pl_accounts","grouping":"account","title":"P&L Accounts by Total Amount"}]}]}
Q: "Create an executive summary dashboard" → {"candidates":[{"title":"Executive CFO Dashboard","tools":["financial_summary","revenue_trend","client_financial_profile"],"widgets":[{"type":"kpi","metric":"summary","grouping":"overview","title":"Executive KPIs"},{"type":"line","metric":"revenue_vs_expense","grouping":"month","title":"Revenue vs Expenses Trend"},{"type":"line","metric":"net_income","grouping":"month","title":"Net Income Trend"},{"type":"bar","metric":"revenue","grouping":"client","title":"Top Clients by Revenue"},{"type":"bar","metric":"expense","grouping":"account","title":"Top Expense Accounts"},{"type":"table","metric":"pl","grouping":"summary","title":"P&L Statement"}]}]}
Q: "Show me my revenue dashboard" → {"candidates":[{"title":"Revenue Dashboard","tools":["revenue_trend","financial_summary","client_financial_profile"],"widgets":[{"type":"line","metric":"revenue","grouping":"month","title":"Monthly Revenue Trend"},{"type":"bar","metric":"revenue","grouping":"client","title":"Top Clients by Revenue"},{"type":"metric","metric":"pl_summary","grouping":"summary","title":"Revenue KPIs"}]}]}
Q: "Compare top two clients revenue for last six months" → {"candidates":[{"title":"Top 2 Clients — Revenue by Month","tools":["client_breakdown"],"widgets":[{"type":"bar","metric":"revenue","grouping":"month","breakdown":"client","topN":2,"title":"Top 2 Clients — Revenue by Month"}]}]}
Q: "Show top 3 clients revenue by month for last year" → {"candidates":[{"title":"Top 3 Clients — Monthly Revenue","tools":["client_breakdown"],"widgets":[{"type":"bar","metric":"revenue","grouping":"month","breakdown":"client","topN":3,"title":"Top 3 Clients — Revenue by Month"}]}]}
Q: "Create a pie chart showing the contribution of each department to annual operating spend" → {"candidates":[{"title":"Department Share of Annual Operating Spend","tools":["expense_trend"],"widgets":[{"type":"pie","metric":"expense","grouping":"department","title":"Department Share of Annual Operating Spend"}]}]}
Q: "Show department breakdown of total expenses" → {"candidates":[{"title":"Expenses by Department","tools":["expense_trend"],"widgets":[{"type":"bar","metric":"expense","grouping":"department","title":"Total Expenses by Department"}]}]}`;

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
                  enum: [
                    'line',
                    'bar',
                    'pie',
                    'donut',
                    'metric',
                    'kpi',
                    'table',
                    'area',
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
                  ],
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
LINE: revenue/month | outstanding/month | paid/month | invoice_count/month | overdue/month | collection_rate/month | mom_growth/month | revenue/quarter | avg_invoice/month | dso/month
      net_income/month | expense/month | gross_profit/month | gross_margin_pct/month | net_margin_pct/month | ebitda/month | revenue_vs_expense/month
      revenue_cumulative/month | running_balance/month
BAR:  revenue/month | net_income/month | net_income/quarter | expense/month | expense/quarter | expense/account | opex/account | cogs/account
BAR:  revenue/org | revenue/quarter | invoices/org | outstanding/org | overdue/org
      revenue/client | total_invoiced/client | outstanding/client | overdue/client | invoices/client | avg_invoice/client | paid/client
      collection_rate/client | overdue_rate/client | payment_days/bucket
      revenue_vs_expense/month | debits_credits/month | net_position/month | invoice_amount/bucket
STACKED_BAR: debits_credits/month
WATERFALL: net_position/month
PIE:  invoices/status | revenue/provider | revenue/client | outstanding/client | expense/account
      invoice_value/invoice_type | transaction_value/journal_type | transaction_value/currency
TREEMAP: expense/account | expense/department | expense/class | expense/vendor | revenue/client
METRIC: venture/summary | top5_revenue_share/summary | collected_vs_outstanding/summary | pl_summary/summary | expense_summary/summary
TABLE: invoices/list | overdue/aging | payment_days/list | pl/summary | expense/list | gl_transactions/list
      top_invoices/list | expense/vendor
SCATTER: invoice_amount/time | expense/vendor | vendor_transactions/vendor
BUBBLE: expense/vendor | vendor_transactions/vendor
DEPARTMENT: expense/department | net_income/department | revenue/department
CLASS: expense/class
VENDOR: expense/vendor
DEBIT_CREDIT: debits_credits/account_type

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
            enum: [
              'line',
              'bar',
              'pie',
              'metric',
              'table',
              'area',
              'treemap',
              'scatter',
              'stacked_bar',
              'waterfall',
            ],
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
            enum: [
              'line',
              'bar',
              'pie',
              'metric',
              'table',
              'area',
              'treemap',
              'scatter',
              'stacked_bar',
              'waterfall',
            ],
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

// ─── Analytics Schema Context (for dynamic SQL generation) ───────────────────

const ANALYTICS_SCHEMA_CONTEXT = `
ClickHouse Analytics Database Schema — available tables for querying:

TABLE: v_fact_accounting_invoices_latest
  Columns: connection_id, tenant_id, org_id, provider, invoice_id, invoice_number,
    invoice_type, contact_name, contact_id, status, issued_at, due_at, paid_at,
    total_amount, amount_due, amount_paid, currency, updated_at
  Filters always required: org_id IN ({externalOrgIds:Array(String)})
  Notes: status values are 'paid','open','overdue','voided','draft'
         invoice_type = 'ACCREC' for sales invoices on Xero
         total_amount is in local currency; positive = revenue

TABLE: v_dim_clients_latest
  Columns: connection_id, tenant_id, org_id, provider, client_id, client_name,
    total_invoiced, total_paid, outstanding, overdue, invoice_count,
    avg_invoice_amount, last_invoice_date, updated_at
  Filters always required: org_id IN ({externalOrgIds:Array(String)})

TABLE: v_fact_accounting_journal_lines_latest
  Columns: connection_id, tenant_id, org_id, provider, journal_id, line_id,
    journal_number, journal_date, account_id, account_code, account_name,
    line_amount, description, source_type,
    department, class_name, vendor_name, vendor_id,
    debit_amount, credit_amount, updated_at
  Filters always required: org_id IN ({externalOrgIds:Array(String)})
  Notes: line_amount is signed: positive = debit = EXPENSE, negative = credit = REVENUE.
         ALWAYS use line_amount sign to classify: revenue WHERE line_amount < 0, expenses WHERE line_amount > 0.
         NEVER use debit_amount or credit_amount columns — they may be zero; derive from line_amount sign instead.
         account_name contains GL account labels like 'Sales Revenue', 'Rent Expense', 'COGS', etc.
         journal_date is DateTime — use toStartOfMonth(journal_date) for monthly grouping
         department: QuickBooks DepartmentRef or Xero TrackingCategory (e.g. 'Admin', 'Sales', 'Operations')
         class_name: QuickBooks ClassRef or Xero second TrackingCategory (e.g. 'General', 'Marketing', 'Product')
         vendor_name: vendor/supplier name from QB Bills, Purchases, and JournalEntry entity fields
         vendor_id: vendor ID from QuickBooks VendorRef

TABLE: v_map_account_cost_categories_latest
  Columns: tenant_id, org_id, provider, account_code, pnl_group, opex_category, cost_nature,
    is_admin_cost, notes, updated_at
  Filters always required: org_id IN ({externalOrgIds:Array(String)})
  Notes: This is a user-maintained mapping table to label expenses (e.g. Admin vs Marketing).

TABLE: v_fact_accounting_journal_lines_enriched_latest
  Columns: all columns from v_fact_accounting_journal_lines_latest plus:
    pnl_group, opex_category, cost_nature, is_admin_cost
  Filters always required: org_id IN ({externalOrgIds:Array(String)})
  Notes: Prefer this view for expense analysis — includes department, class_name, vendor_name,
         debit_amount, credit_amount, plus user-defined opex_category/pnl_group classifications.
         Use for: expense by department, expense by class, vendor spend, debit/credit by account type.

TABLE: v_unmapped_cost_category_accounts
  Columns: tenant_id, org_id, provider, account_code, account_name, total_spend
  Filters always required: org_id IN ({externalOrgIds:Array(String)})
  Notes: Use this to find accounts that still need categorisation.

IMPORTANT ClickHouse rules:
- Always filter: org_id IN ({externalOrgIds:Array(String)})
- CRITICAL: GROUP BY toStartOfMonth(col) — NEVER group by an alias. ORDER BY toStartOfMonth(col)
- Month label: SELECT formatDateTime(toStartOfMonth(col), '%b %Y') AS name ... GROUP BY toStartOfMonth(col)
- No CTEs (WITH clause) — use subqueries or flat SQL
- For the output column "name", always put the label/dimension
- For the output column "value", always put the primary numeric measure
- Additional numeric columns are fine (they render as multi-series)
- Add ORDER BY on the time or dimension column
- Always add LIMIT (max 500 rows)
- NEVER access system tables or tables not listed above
- NEVER use INSERT, UPDATE, DELETE, DROP, CREATE, ALTER
- Output column aliases must be simple snake_case (no spaces)
`;

const DYNAMIC_SQL_SYSTEM = `You are a ClickHouse SQL expert generating safe, read-only analytical queries for a financial dashboard.

SCHEMA:
${ANALYTICS_SCHEMA_CONTEXT}

TASK: Given a financial question and a chart title, write ONE ClickHouse SELECT statement.

RULES:
1. Output ONLY the raw SQL — no explanation, no markdown, no code fences
2. Always include: WHERE org_id IN ({externalOrgIds:Array(String)})
3. Always include LIMIT (use 100 for aggregates, 500 for lists)
4. The query MUST return at least a "name" column (dimension label) and a "value" column (primary metric)
5. Additional numeric columns are allowed for multi-series charts
6. Sort by time ascending for trends, by value descending for rankings
7. Use simple aggregations: sum(), count(), avg(), max(), min()
8. For monthly trends: GROUP BY toStartOfMonth(col) ORDER BY toStartOfMonth(col) — NEVER group by alias
9. For rankings: GROUP BY dimension ORDER BY value DESC
10. Never use WITH (CTE), window functions, or ARRAY JOIN unless essential
11. Keep queries simple and fast — max 2 JOINs
12. NEVER reference columns debit_amount or credit_amount — they may be zero. Instead compute:
    debits  = sumIf(toFloat64(line_amount),  line_amount > 0)
    credits = sumIf(-toFloat64(line_amount), line_amount < 0)
13. NEVER filter AND department != '' or AND vendor_name != '' unless you also have a fallback — those columns may be empty. When grouping by department or vendor, always use COALESCE(NULLIF(col,''),'Other') and omit the NOT NULL filter.
14. For "balance by account type" or "total balance by account classification": group by a multiIf() over account_name patterns to produce categories (Revenue, Cost of Sales, Payroll, Operating Expenses, Cash & Bank, AR/AP, Equity), compute sum(line_amount) as value.`;

// ─── Smart SQL Planner — primary agentic path ────────────────────────────────
// The LLM writes real ClickHouse SQL for every chart instead of picking from a
// preset vocabulary. Live dimension values from ClickHouse are injected at
// runtime so the model sees ACTUAL data, not an abstract schema.
const SMART_SQL_PLANNER_SYSTEM = `You are a world-class CFO analytics AI with live read access to a ClickHouse financial database. For every user request you write exact, runnable ClickHouse SQL and pick the best chart type.

DATABASE SCHEMA — use EXACT view names and column names:

TABLE analytics.sample_trial_balance  ← USE THIS for P&L totals, balance sheet, account type queries
  org_id (String)  account_number (String)  account_name (String)  account_type (String)
  debit (Decimal18,4)  credit (Decimal18,4)  net_balance (Decimal18,4)
  account_type VALUES: 'Bank' | 'Accounts Receivable (AR)' | 'Other Current Asset' | 'Fixed Asset' | 'Other Asset'
                       'Accounts Payable (AP)' | 'Other Current Liability' | 'Long Term Liability'
                       'Equity' | 'Income' | 'Cost of Goods Sold' | 'Expense'
  ALWAYS filter: WHERE org_id IN ({externalOrgIds:Array(String)})
  KEY FORMULAS (match Excel DAX exactly):
    Revenue   = round(abs(sumIf(toFloat64(net_balance), account_type = 'Income')), 0)
    COGS      = round(sumIf(toFloat64(net_balance), account_type = 'Cost of Goods Sold'), 0)
    OpEx      = round(sumIf(toFloat64(net_balance), account_type = 'Expense'), 0)
    GrossProfit = Revenue - COGS
    NetIncome   = GrossProfit - OpEx
    TotalAssets = round(abs(sumIf(toFloat64(net_balance), account_type IN ('Bank','Accounts Receivable (AR)','Other Current Asset','Fixed Asset','Other Asset'))), 0)
    TotalLiab   = round(abs(sumIf(toFloat64(net_balance), account_type IN ('Accounts Payable (AP)','Other Current Liability','Long Term Liability'))), 0)
    TotalEquity = round(abs(sumIf(toFloat64(net_balance), account_type = 'Equity')), 0)

TABLE analytics.sample_gl_dump  ← USE THIS for vendor, department, class, journal-type, row-level GL queries
  org_id (String)  date (Date)  transaction_id (String)  journal_type (String — AP|AS|EX|PR|TR)
  account_number (String)  account_name (String)  account_type (String)
  vendor_customer (String)  description (String)
  debit (Decimal18,4)  credit (Decimal18,4)  running_balance (Decimal18,4)
  department (String — 'Admin'|'Operations'|'Sales' ONLY — NO Finance)
  class (String — 'General'|'Marketing'|'Product')
  ALWAYS filter: WHERE org_id IN ({externalOrgIds:Array(String)})
  account_type VALUES same as trial_balance above
  VENDOR SPEND: sum(toFloat64(debit)) WHERE org_id IN (...) AND vendor_customer != '' AND account_type IN ('Expense','Cost of Goods Sold')
  DEPT SPEND: sum(toFloat64(debit)) WHERE org_id IN (...) AND department != '' GROUP BY department
  CLASS SPEND: sum(toFloat64(debit)) WHERE org_id IN (...) AND class != '' GROUP BY class

TABLE analytics.v_fact_accounting_journal_lines_latest  ← for time-series, trend queries
  journal_date (Nullable DateTime)  account_name (String)  account_code (String)
  line_amount (Decimal18,4)  — SIGN CONVENTION: positive = debit/expense, negative = credit/revenue
  source_type (String)  department (String)  class_name (String)  vendor_name (String)
  description (String)  org_id (String)  provider (String)

TABLE analytics.v_fact_accounting_invoices_latest
  issued_at (DateTime)  due_at (DateTime)  paid_at (Nullable DateTime)
  total_amount (Float64)  amount_due (Float64)  amount_paid (Float64)
  status (String)  invoice_type (String — 'ACCREC'=revenue receivable, 'ACCPAY'=expense payable)
  contact_name (Nullable String)  contact_id (Nullable String)
  invoice_number (String)  org_id (String)  org_name (String)  provider (String)
  *** NOTE: column is contact_name NOT client_name ***

TABLE analytics.v_dim_clients_latest
  client_id (String)  client_name (String)  org_id (String)  provider (String)
  total_invoiced (Float64)  total_revenue (Float64)  total_outstanding (Float64)  total_overdue (Float64)
  invoice_count (UInt32)  paid_count (UInt32)  outstanding_count (UInt32)  overdue_count (UInt32)
  avg_invoice_amount (Float64)  first_invoice_date (Date)  last_invoice_date (Date)
  *** NOTE: column is total_revenue NOT total_paid ***

TABLE SELECTION GUIDE (org_id filter required on ALL tables):
  P&L totals / balance sheet / account type breakdown → analytics.sample_trial_balance (WHERE org_id IN ({externalOrgIds:Array(String)}))
  Vendor spend / department spend / class spend / GL detail → analytics.sample_gl_dump (WHERE org_id IN ({externalOrgIds:Array(String)}))
  Monthly trends / time-series → analytics.v_fact_accounting_journal_lines_latest (WHERE org_id IN ({externalOrgIds:Array(String)}))
  Invoice analysis / client revenue → analytics.v_fact_accounting_invoices_latest (WHERE org_id IN ({externalOrgIds:Array(String)}))

NON-NEGOTIABLE SQL RULES:
1. EVERY query MUST include: WHERE org_id IN ({externalOrgIds:Array(String)})
2. EVERY query MUST include LIMIT (100 for aggregates, 500 for row-level lists)
3. Standard output columns: "name" = label/dimension, "value" = primary numeric metric
4. CRITICAL — ClickHouse GROUP BY + ORDER BY: ALWAYS use the RAW EXPRESSION, NEVER the alias.
   CORRECT:   GROUP BY toStartOfMonth(journal_date) ORDER BY toStartOfMonth(journal_date) ASC
   WRONG:     GROUP BY name  ← alias in GROUP BY causes error
   CORRECT:   GROUP BY COALESCE(NULLIF(department,''),'Other') ORDER BY COALESCE(NULLIF(department,''),'Other') ASC
   WRONG:     ORDER BY department ASC  ← alias shadows raw column, ClickHouse resolves raw column which is not in GROUP BY
5. For month labels: SELECT formatDateTime(toStartOfMonth(journal_date), '%b %Y') AS name — GROUP BY toStartOfMonth(journal_date) ORDER BY toStartOfMonth(journal_date)
6. For expenses (debit): WHERE line_amount > 0 — use sumIf(toFloat64(line_amount), line_amount > 0)
7. For revenue from journals: sumIf(-toFloat64(line_amount), line_amount < 0) as value
8. NO CTEs (WITH clause) — use flat SELECT or subqueries only
9. NEVER reference debit_amount or credit_amount columns directly — use line_amount sign
10. For grouping by department/vendor: COALESCE(NULLIF(department,''),'Other') — and ORDER BY the SAME expression
11. Keep queries fast — max 2 JOINs, prefer aggregates over row scans
12. CRITICAL — For "compare X vs Y" or "top N clients/vendors" side-by-side comparison charts:
    Use sumIf() to pivot each entity into its OWN column. One row per time period, one column per entity.
    Set chart config grouping = "month" for time-series comparisons.
    CORRECT multi-series bar (2 clients per month):
      SQL: SELECT formatDateTime(toStartOfMonth(issued_at), '%b %Y') AS name,
             round(sumIf(total_amount, contact_name = 'Apex Ventures Ltd'), 2) AS apex_ventures_ltd,
             round(sumIf(total_amount, contact_name = 'BlueOak Distributors'), 2) AS blueoak_distributors
      FROM analytics.v_fact_accounting_invoices_latest
      WHERE org_id IN ({externalOrgIds:Array(String)}) AND invoice_type = 'ACCREC'
      GROUP BY toStartOfMonth(issued_at) ORDER BY toStartOfMonth(issued_at) ASC LIMIT 24
      Config: { "type": "bar", "metric": "revenue", "grouping": "month" }
    WRONG (collapses everything into one bar per month):
      SELECT name, sum(total_amount) AS value ... GROUP BY month  ← single bar, not a comparison
    Column names must be valid SQL identifiers (replace spaces with underscores, lowercase).
    Each column name = entity identifier with spaces replaced by underscores, fully lowercase.
13. CRITICAL — NO WINDOW FUNCTIONS: ClickHouse does NOT support lag(), lead(), row_number(), rank() in aggregate queries. For month-over-month growth, use a self-join subquery or simply show absolute values per month. NEVER write lag() or lead().
14. For ORDER BY on a coalesced dimension: ALWAYS write the full COALESCE expression, e.g. ORDER BY COALESCE(NULLIF(vendor_name,''),'Other') ASC
15. CRITICAL — NO aggregate functions in WHERE: NEVER write WHERE col >= max(col) or WHERE col >= min(col). For time filtering use: WHERE journal_date >= addMonths(now(), -6) or WHERE issued_at >= addDays(now(), -90). Use now() for relative dates.
16. For client queries: use v_dim_clients_latest with client_name column. For invoice-level queries: use v_fact_accounting_invoices_latest with contact_name (NOT client_name).
17. For vendor "last N months" queries: WHERE journal_date >= addMonths(now(), -N) — not subqueries with MAX.
18. CRITICAL — NO ALIAS SHADOWING: NEVER alias a COALESCE(NULLIF(col,...)) expression with the same name as the underlying column. ClickHouse's analyzer resolves the alias in GROUP BY creating NOT_AN_AGGREGATE.
    WRONG: SELECT COALESCE(NULLIF(department,''),'Other') AS department ... GROUP BY COALESCE(NULLIF(department,''),'Other')
    CORRECT: SELECT COALESCE(NULLIF(department,''),'Other') AS dept ... GROUP BY COALESCE(NULLIF(department,''),'Other')
    Rule: department → alias AS dept | vendor_name → alias AS vendor | class_name → alias AS class_label
19. CRITICAL — For department/vendor breakdown over time (stacked/grouped bars): use sumIf() pivot.
    Known departments: READ LIVE DATA CONTEXT above for actual department names. NEVER hardcode departments not listed in LIVE DATA. NEVER add 'Finance' or any other department unless it appears in the LIVE DATA departments list.
    CORRECT stacked bar by department (replace Admin/Operations/Sales with ACTUAL departments from LIVE DATA):
      SELECT formatDateTime(toStartOfMonth(journal_date), '%b %Y') AS name,
             round(sumIf(toFloat64(line_amount), line_amount > 0 AND COALESCE(NULLIF(department,''),'Other') = 'Admin'), 0) AS admin,
             round(sumIf(toFloat64(line_amount), line_amount > 0 AND COALESCE(NULLIF(department,''),'Other') = 'Operations'), 0) AS operations,
             round(sumIf(toFloat64(line_amount), line_amount > 0 AND COALESCE(NULLIF(department,''),'Other') = 'Sales'), 0) AS sales
      FROM analytics.v_fact_accounting_journal_lines_latest
      WHERE org_id IN ({externalOrgIds:Array(String)}) AND journal_date >= addMonths(now(), -12)
      GROUP BY toStartOfMonth(journal_date) ORDER BY toStartOfMonth(journal_date) ASC LIMIT 24
20. TIME SCOPING — "annual operating spend" / "for the year" = last 12 months: WHERE journal_date >= addMonths(now(), -12). "This year" = WHERE toYear(journal_date) = toYear(now()). Never return all-time data when user says "annual" or "for the year".
21. SOURCE TYPES — the source_type column cleanly separates entry types. ALWAYS use it:
    • source_type = 'REV'  → Revenue/income accounts (Product Sales, Service Revenue, etc.) — line_amount is NEGATIVE (credit)
    • source_type = 'OPEX' → Operating expenses — line_amount is POSITIVE (debit)
    • source_type = 'COGS' → Cost of goods sold — line_amount is POSITIVE (debit)
    • source_type = 'GL'   → Balance sheet / adjusting entries (Accounts Payable, Accrued Payroll, Inventory) — EXCLUDE from P&L queries
    REVENUE: Use WHERE source_type = 'REV' for revenue. Value = abs(sum(line_amount)) or sumIf(-toFloat64(line_amount), line_amount < 0).
    NEVER use bare line_amount < 0 for revenue — it picks up AP and Accrued Payroll (which are GL type, not REV).
    OPERATING EXPENSES: Use WHERE source_type IN ('OPEX') or IN ('OPEX','COGS') for total cost.
    VENDOR SPEND: Use source_type IN ('OPEX','COGS') to show real vendor operating costs (exclude GL inventory purchases).
22. FINAL OUTPUT COLUMNS must always be: "name" (the label/dimension) and "value" (the metric). For single-dimension charts: wrap in subquery if needed. Example: SELECT dept AS name, spend AS value FROM (SELECT COALESCE(NULLIF(department,''),'Other') AS dept, round(sumIf(toFloat64(line_amount), line_amount > 0), 0) AS spend FROM ... GROUP BY COALESCE(...)) LIMIT 100. For scatter: columns x, y, z (optional size), name (label). For multi-series pivot: one "name" column + one column per series entity.
23. SCATTER CHARTS: output columns must be x (numeric X axis), y (numeric Y axis), name (label).
    Example — expense vs revenue by department:
      SELECT COALESCE(NULLIF(department,''),'Other') AS name,
             round(sumIf(toFloat64(line_amount), source_type IN ('OPEX','COGS') AND line_amount > 0), 0) AS x,
             round(abs(sumIf(toFloat64(line_amount), source_type = 'REV')), 0) AS y
      FROM analytics.v_fact_accounting_journal_lines_latest
      WHERE org_id IN ({externalOrgIds:Array(String)})
      GROUP BY COALESCE(NULLIF(department,''),'Other')
      HAVING x > 0 OR y > 0 LIMIT 20
24. USER TYPOS: understand user intent even with spelling errors — "grpah" = chart, "monthy" = monthly, "departemnt" = department, "expnese" = expense. Always infer the intended meaning.

CHART TYPE REFERENCE:
  line bar stacked_bar area waterfall pie donut treemap scatter horizontal_bar
  pareto gauge bubble histogram table metric kpi

OUTPUT FORMAT — JSON only, no explanation, no markdown:
{
  "title": "Dashboard or chart title (specific, not generic)",
  "charts": [
    {
      "title": "Chart title (specific — use real account/department/vendor names from LIVE DATA)",
      "description": "One-sentence insight this chart reveals",
      "type": "bar",
      "sql": "SELECT formatDateTime(toStartOfMonth(journal_date), '%b %Y') AS name, round(sumIf(toFloat64(line_amount), line_amount > 0), 2) AS value FROM analytics.v_fact_accounting_journal_lines_latest WHERE org_id IN ({externalOrgIds:Array(String)}) AND journal_date IS NOT NULL GROUP BY toStartOfMonth(journal_date) ORDER BY toStartOfMonth(journal_date) ASC LIMIT 100"
    }
  ]
}

25. SAMPLE TABLE RULES — org_id filter required on both sample tables:
    analytics.sample_trial_balance and analytics.sample_gl_dump BOTH have org_id. ALWAYS add WHERE org_id IN ({externalOrgIds:Array(String)}).
    For P&L / balance sheet: ALWAYS use analytics.sample_trial_balance with org_id filter
    For vendor/dept/class/GL detail: ALWAYS use analytics.sample_gl_dump with org_id filter
    For monthly trends / time-series: use analytics.v_fact_accounting_journal_lines_latest (also with org_id filter)
    DEPARTMENT VALUES (sample_gl_dump): 'Admin', 'Operations', 'Sales' — ONLY these three. NEVER 'Finance'.
    CLASS VALUES (sample_gl_dump): 'General', 'Marketing', 'Product'
    JOURNAL_TYPE VALUES (sample_gl_dump): 'AP', 'AS', 'EX', 'PR', 'TR'

INTELLIGENCE RULES:
- Read LIVE DATA below — use actual account names, departments, vendors in titles and WHERE clauses
- Title charts with specific names: "Monthly Rent vs Marketing Spend" not "Expense Chart"
- For P&L totals → use analytics.sample_trial_balance WHERE org_id IN ({externalOrgIds:Array(String)}) with account_type filters (see KEY FORMULAS above)
- For vendor spend → SELECT vendor_customer, sum(debit) FROM analytics.sample_gl_dump WHERE org_id IN ({externalOrgIds:Array(String)}) AND vendor_customer != '' GROUP BY vendor_customer
- For department spend → SELECT department, sum(debit) FROM analytics.sample_gl_dump WHERE org_id IN ({externalOrgIds:Array(String)}) AND department != '' GROUP BY department
- For class spend → SELECT class, sum(debit) FROM analytics.sample_gl_dump WHERE org_id IN ({externalOrgIds:Array(String)}) AND class != '' GROUP BY class
- For "by department": departments are EXACTLY 'Admin', 'Operations', 'Sales' — no Finance, no Other
- For "by vendor": use vendor_customer from analytics.sample_gl_dump NOT vendor_name from journal lines
- For "by account": GROUP BY account_name ORDER BY value DESC LIMIT 20
- For revenue+expense comparison: multi-series with two value columns
- Max 6 charts per dashboard — pick what genuinely answers the question
- ZERO hallucination: only columns listed above, only views listed above
- FINAL column names MUST be "name" and "value" (not "dept", "vendor", "cls", etc.) for single-dimension charts
- ZERO Finance: NEVER add a Finance department — it does not exist in the data`;

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

    // Dynamic SQL widget — look up stored SQL from the widget's queryConfig and execute it
    if (metric === 'dynamic' && widgetId) {
      try {
        const widget = await this.prisma.dashboardWidget.findFirst({
          where: { id: widgetId, organizationId },
          select: { queryConfig: true },
        });
        const cfg = widget?.queryConfig as Record<string, unknown> | null;
        const sql = typeof cfg?.dynamicSql === 'string' ? cfg.dynamicSql : null;
        if (sql) {
          const data = await this.executeDynamicSql(sql, scope);
          return { data };
        }
      } catch (err: any) {
        this.logger.warn(`[Agent:Dynamic] widgetId=${widgetId} SQL exec failed: ${err.message}`);
      }
      return { data: [] };
    }
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
           WHERE org_id IN ({externalOrgIds:Array(String)})
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
        return { name: String(r.month ?? ''), value: Math.round(running), revenue: Math.round(cur) };
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
        return { name: String(r.month ?? ''), value: Math.round(running), net: Math.round(net) };
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

    const jDb  = this.analyticsDb;
    const jTbl = `${jDb}.v_fact_accounting_journal_lines_enriched_latest`;
    const tbTbl = `${jDb}.sample_trial_balance`;
    const glTbl = `${jDb}.sample_gl_dump`;

    // ── expense/month (line or bar) ───────────────────────────────────────────
    if (metric === 'expense' && grouping === 'month') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
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
      return { data: rows.map((r) => ({ name: r.month as string, value: this.num(r.total_expense) })) };
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
      return { data: rows.map((r) => ({ name: r.quarter as string, value: this.num(r.total_expense) })) };
    }

    // ── expense/account (bar or pie) ──────────────────────────────────────────
    if (metric === 'expense' && grouping === 'account') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const limit = (() => {
        const n =
          typeof topN === 'number' && Number.isFinite(topN) ? Math.floor(topN) : 20;
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
      return { data: rows.map((r) => ({ name: r.account_name as string, value: this.num(r.total_expense) })) };
    }

    // ── expense/category (bar or pie) — user-defined cost categories ─────────
    if (metric === 'expense' && grouping === 'category') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const limit = (() => {
        const n =
          typeof topN === 'number' && Number.isFinite(topN) ? Math.floor(topN) : 20;
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
          typeof topN === 'number' && Number.isFinite(topN) ? Math.floor(topN) : 20;
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
      return { data: rows.map((r) => ({ name: r.account_name as string, value: this.num(r.total_opex) })) };
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
      return { data: rows.map((r) => ({ name: r.account_name as string, value: this.num(r.total_cogs) })) };
    }

    // ── net_income/month (line or bar) ────────────────────────────────────────
    if (metric === 'net_income' && grouping === 'month') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
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
          .sort((a: any, b: any) => String(a._sort).localeCompare(String(b._sort)))
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
      const expMap = new Map<string, number>(expRows.map((r: any) => [String(r.quarter), this.num(r.exp)]));
      return {
        data: revRows
          .map((r: any) => ({ name: String(r.quarter), value: Math.round(this.num(r.rev) - (expMap.get(String(r.quarter)) ?? 0)), _qs: String(r.quarter_start) }))
          .sort((a: any, b: any) => a._qs.localeCompare(b._qs))
          .map(({ _qs: _qs, ...rest }: any) => rest),
      };
    }

    // ── gross_profit/month (line) — revenue minus COGS ───────────────────────
    if (metric === 'gross_profit' && grouping === 'month') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
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
      const cogsMap = new Map<string, number>(cogsRows.map((r: any) => [String(r.month_start), this.num(r.cogs)]));
      return {
        data: revRows
          .map((r: any) => ({ name: String(r.month_start), value: Math.round(this.num(r.rev) - (cogsMap.get(String(r.month_start)) ?? 0)) }))
          .sort((a: any, b: any) => a.name.localeCompare(b.name)),
      };
    }

    // ── gross_margin_pct/month (line) — gross profit % ───────────────────────
    if (metric === 'gross_margin_pct' && grouping === 'month') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
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
             AND line_amount > 0 AND journal_date IS NOT NULL ${jTime} AND ${COGS_MATCH}
           GROUP BY month_start`,
          { externalOrgIds: scope.externalOrgIds, ...entityParam },
        ),
      ]);
      const cogsMap = new Map<string, number>(cogsRows.map((r: any) => [String(r.month_start), this.num(r.cogs)]));
      return {
        data: revRows
          .map((r: any) => {
            const rev = this.num(r.rev);
            const cogs = cogsMap.get(String(r.month_start)) ?? 0;
            return { name: String(r.month_start), value: rev > 0 ? Math.round(((rev - cogs) / rev) * 1000) / 10 : 0 };
          })
          .sort((a: any, b: any) => a.name.localeCompare(b.name)),
      };
    }

    // ── net_margin_pct/month (line) — net income % ───────────────────────────
    if (metric === 'net_margin_pct' && grouping === 'month') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
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
      const expMap = new Map<string, number>(expRows.map((r: any) => [String(r.month_start), this.num(r.exp)]));
      return {
        data: revRows
          .map((r: any) => {
            const rev = this.num(r.rev);
            const exp = expMap.get(String(r.month_start)) ?? 0;
            return { name: String(r.month_start), value: rev > 0 ? Math.round(((rev - exp) / rev) * 1000) / 10 : 0 };
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
      const expMap = new Map<string, number>(expRows.map((r: any) => [String(r.month_start), this.num(r.exp)]));
      const daMap  = new Map<string, number>(daRows.map((r: any) => [String(r.month_start), this.num(r.da)]));
      return {
        data: revRows
          .map((r: any) => {
            const key = String(r.month_start);
            const rev = this.num(r.rev);
            const exp = expMap.get(key) ?? 0;
            const da  = daMap.get(key) ?? 0;
            return { name: key, value: Math.round(rev - exp + da) };
          })
          .sort((a: any, b: any) => a.name.localeCompare(b.name)),
      };
    }

    // ── revenue_vs_expense/month (line) — dual series ─────────────────────────
    if (metric === 'revenue_vs_expense' && grouping === 'month') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
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
      for (const r of revRows) map.set(String(r.month), { name: String(r.month), Revenue: this.num(r.rev), Expense: 0, _sort: String(r.month_start) });
      for (const r of expRows) {
        const key = String(r.month);
        const existing = map.get(key) ?? { name: key, Revenue: 0, _sort: key };
        existing.Expense = this.num(r.exp);
        map.set(key, existing);
      }
      return { data: Array.from(map.values()).sort((a, b) => a._sort.localeCompare(b._sort)).map(({ _sort: _s, ...rest }) => rest) };
    }

    // ── balance_sheet/summary — total assets, liabilities, equity from trial balance ──
    if (metric === 'balance_sheet' && grouping === 'summary') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const [assetRows, liabRows, equityRows] = await Promise.all([
        this.queryRows<any>(
          `SELECT account_name AS name, round(abs(toFloat64(net_balance)), 0) AS value, account_type
           FROM ${tbTbl}
           WHERE org_id IN ({externalOrgIds:Array(String)})
             AND account_type IN ('Bank','Accounts Receivable (AR)','Other Current Asset','Fixed Asset','Other Asset')
           ORDER BY value DESC LIMIT 50`,
          { externalOrgIds: scope.externalOrgIds },
        ),
        this.queryRows<any>(
          `SELECT account_name AS name, round(abs(toFloat64(net_balance)), 0) AS value, account_type
           FROM ${tbTbl}
           WHERE org_id IN ({externalOrgIds:Array(String)})
             AND account_type IN ('Accounts Payable (AP)','Other Current Liability','Long Term Liability')
           ORDER BY value DESC LIMIT 50`,
          { externalOrgIds: scope.externalOrgIds },
        ),
        this.queryRows<any>(
          `SELECT account_name AS name, round(abs(toFloat64(net_balance)), 0) AS value, account_type
           FROM ${tbTbl}
           WHERE org_id IN ({externalOrgIds:Array(String)})
             AND account_type = 'Equity'
           ORDER BY value DESC LIMIT 20`,
          { externalOrgIds: scope.externalOrgIds },
        ),
      ]);
      const totalAssets = assetRows.reduce((s: number, r: any) => s + this.num(r.value), 0);
      const totalLiab = liabRows.reduce((s: number, r: any) => s + this.num(r.value), 0);
      const totalEquity = equityRows.reduce((s: number, r: any) => s + this.num(r.value), 0);
      return {
        data: [
          { name: 'Total Assets',      value: totalAssets },
          { name: 'Total Liabilities', value: totalLiab },
          { name: 'Total Equity',      value: totalEquity },
        ],
      };
    }

    // ── assets/breakdown — asset accounts from trial balance ─────────────────
    if (metric === 'assets' && (grouping === 'account_type' || grouping === 'account' || grouping === 'breakdown' || grouping === 'summary')) {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT account_name AS name, round(abs(toFloat64(net_balance)), 0) AS value, account_type
         FROM ${tbTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})
           AND account_type IN ('Bank','Accounts Receivable (AR)','Other Current Asset','Fixed Asset','Other Asset')
           AND abs(toFloat64(net_balance)) > 0
         ORDER BY value DESC LIMIT 50`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return { data: rows.map((r: any) => ({ name: String(r.name), value: this.num(r.value), type: String(r.account_type) })) };
    }

    // ── liabilities/breakdown — liability accounts from trial balance ─────────
    if (metric === 'liabilities' && (grouping === 'account_type' || grouping === 'account' || grouping === 'breakdown' || grouping === 'summary')) {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT account_name AS name, round(abs(toFloat64(net_balance)), 0) AS value, account_type
         FROM ${tbTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})
           AND account_type IN ('Accounts Payable (AP)','Other Current Liability','Long Term Liability')
           AND abs(toFloat64(net_balance)) > 0
         ORDER BY value DESC LIMIT 50`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return { data: rows.map((r: any) => ({ name: String(r.name), value: this.num(r.value), type: String(r.account_type) })) };
    }

    // ── equity/breakdown — equity accounts from trial balance ─────────────────
    if (metric === 'equity' && (grouping === 'account_type' || grouping === 'account' || grouping === 'breakdown' || grouping === 'summary')) {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT account_name AS name, round(abs(toFloat64(net_balance)), 0) AS value
         FROM ${tbTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})
           AND account_type = 'Equity' AND abs(toFloat64(net_balance)) > 0
         ORDER BY value DESC LIMIT 20`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return { data: rows.map((r: any) => ({ name: String(r.name), value: this.num(r.value) })) };
    }

    // ── trial_balance/summary — full trial balance table ──────────────────────
    if (metric === 'trial_balance' && (grouping === 'summary' || grouping === 'list')) {
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
    if (metric === 'income' && (grouping === 'breakdown' || grouping === 'account' || grouping === 'summary')) {
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
      return { data: rows.map((r: any) => ({ name: String(r.name), value: this.num(r.value), type: String(r.account_type) })) };
    }

    // ── account_type/breakdown — any account type breakdown from trial balance ─
    if (metric === 'account_type' && (grouping === 'breakdown' || grouping === 'summary' || grouping === 'account')) {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT account_type AS name, round(sum(abs(toFloat64(net_balance))), 0) AS value
         FROM ${tbTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})
         GROUP BY account_type
         ORDER BY value DESC LIMIT 20`,
        { externalOrgIds: scope.externalOrgIds },
      );
      return { data: rows.map((r: any) => ({ name: String(r.name), value: this.num(r.value) })) };
    }

    // ── gl_dump/detail — full GL dump from sample_gl_dump ─────────────────────
    if (metric === 'gl_dump' && (grouping === 'detail' || grouping === 'list')) {
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
      const totalCogs    = this.num((tbSummary[0] as any)?.total_cogs ?? 0);
      const totalOpex    = this.num((tbSummary[0] as any)?.total_expenses ?? 0);
      const grossProfit  = totalRevenue - totalCogs;
      const netIncome    = grossProfit - totalOpex;
      const rows: Array<{ name: string; value: number }> = [
        { name: 'Revenue',              value: totalRevenue },
        ...(totalCogs > 0    ? [{ name: 'Cost of Goods Sold',  value: -totalCogs }]  : []),
        { name: 'Gross Profit',         value: grossProfit },
        ...(totalOpex > 0    ? [{ name: 'Operating Expenses',  value: -totalOpex }]  : []),
        { name: 'Net Income',           value: netIncome },
      ].filter(r => r.value !== 0);
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
      const rev  = this.num((tbRows[0] as any)?.total_revenue ?? 0);
      const cogs = this.num((tbRows[0] as any)?.total_cogs ?? 0);
      const exp  = this.num((tbRows[0] as any)?.total_expenses ?? 0);
      const gp   = rev - cogs;
      const ni   = gp - exp;
      return {
        data: [
          { label: 'Total Revenue',    value: rev,  format: 'currency' },
          { label: 'Total Expenses',   value: exp + cogs, format: 'currency' },
          { label: 'Gross Profit',     value: gp,   format: 'currency' },
          { label: 'Net Income',       value: ni,   format: 'currency' },
          { label: 'Gross Margin',     value: rev > 0 ? Math.round((gp / rev) * 1000) / 10 : 0, format: 'percent' },
          { label: 'Net Margin',       value: rev > 0 ? Math.round((ni / rev) * 1000) / 10 : 0, format: 'percent' },
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
      const totalExp  = totalCogs + totalOpex;
      const topAcct   = String((topRows[0] as any)?.account_name ?? 'N/A');
      const topAmt    = this.num((topRows[0] as any)?.amt ?? 0);
      return {
        data: [
          { label: 'Total Expenses',         value: totalExp,  format: 'currency' },
          { label: 'Cost of Sales (COGS)',   value: totalCogs, format: 'currency' },
          { label: 'Operating Expenses',     value: totalOpex, format: 'currency' },
          { label: 'Largest Expense',        value: topAmt,    format: 'currency', note: topAcct },
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
          return { name: String(r.month ?? ''), value: Math.round(cumulative), monthly: Math.round(this.num(r.monthly_revenue)) };
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
      return { data: rows.map((r: any) => ({ name: String(r.name ?? ''), value: this.num(r.value) })) };
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
      return { data: rows.map((r: any) => ({ name: String(r.name ?? ''), value: this.num(r.value) })) };
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
      return { data: rows.map((r: any) => ({ name: String(r.name ?? ''), value: this.num(r.value) })) };
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
      return { data: rows.map((r: any) => ({ name: String(r.name ?? ''), value: this.num(r.value) })) };
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
      return { data: rows.map((r: any) => ({ name: String(r.name ?? ''), value: this.num(r.value) })) };
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
      return { data: rows.map((r: any) => ({ name: String(r.bucket ?? ''), value: this.num(r.invoice_count) })) };
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
      return { data: rows.map((r: any) => ({ name: String(r.name ?? ''), value: this.num(r.value) })) };
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
        if (!monthMap.has(m)) { monthMap.set(m, { name: m }); sortMap.set(m, String(r.month_start ?? '')); }
        (monthMap.get(m) as any)[String(r.source_type)] = this.num(r.amount);
      }
      return {
        data: [...monthMap.entries()]
          .sort(([a], [b]) => (sortMap.get(a) ?? '').localeCompare(sortMap.get(b) ?? ''))
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
      return { data: rows.map((r: any) => ({ name: String(r.name ?? ''), value: this.num(r.value) })) };
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
      return { data: rows.map((r: any) => ({ name: String(r.name ?? ''), value: this.num(r.value) })) };
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
      return { data: rows.map((r: any) => ({ name: String(r.name ?? ''), value: this.num(r.value) })) };
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
      const netMargin = revenue > 0 ? ((revenue - expenses) / revenue) * 100 : 50;
      const score = Math.max(0, Math.min(100, Math.round(
        collectionRate * 0.4 + Math.max(0, 100 - overdueRatio * 2) * 0.3 + Math.max(0, Math.min(100, netMargin)) * 0.3
      )));
      return {
        data: [{
          name: 'Financial Health',
          value: score,
          revenue: Math.round(revenue),
          collected: Math.round(collected),
          overdue: Math.round(overdue),
          expenses: Math.round(expenses),
          collectionRate: Math.round(collectionRate),
          label: score >= 80 ? 'Excellent' : score >= 60 ? 'Good' : score >= 40 ? 'Fair' : 'Needs Attention',
        }],
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
      const revenue  = this.num((tbRows[0] as any)?.total_revenue ?? 0);
      const cogs     = this.num((tbRows[0] as any)?.total_cogs ?? 0);
      const opex     = this.num((tbRows[0] as any)?.total_opex ?? 0);
      const expenses = cogs + opex;
      const netProfit = revenue - expenses;
      const invoiceCount = this.num((invRows[0] as any)?.invoice_count ?? 0);
      const avgInvoice   = this.num((invRows[0] as any)?.avg_invoice ?? 0);
      const overdue      = this.num((invRows[0] as any)?.overdue ?? 0);
      return {
        data: [
          { label: 'Total Revenue',     value: revenue,     format: 'currency', icon: 'revenue'  },
          { label: 'Total Expenses',    value: expenses,    format: 'currency', icon: 'expenses' },
          { label: 'Net Profit',        value: netProfit,   format: 'currency', icon: 'profit'   },
          { label: 'Avg Invoice Value', value: avgInvoice,  format: 'currency', icon: 'invoice'  },
          { label: 'Invoice Count',     value: invoiceCount,format: 'number',   icon: 'count'    },
          { label: 'Overdue Amount',    value: overdue,     format: 'currency', icon: 'overdue'  },
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
      const revMap = new Map(revRows.map((r: any) => [String(r.month), { value: this.num(r.value), sort: String(r.month_start) }]));
      const expMap = new Map(expRows.map((r: any) => [String(r.month), { value: this.num(r.value), sort: String(r.month_start) }]));
      const months = [...new Set([...revMap.keys(), ...expMap.keys()])]
        .sort((a, b) => (revMap.get(a)?.sort ?? expMap.get(a)?.sort ?? '').localeCompare(revMap.get(b)?.sort ?? expMap.get(b)?.sort ?? ''));
      return {
        data: months.map(m => ({
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
      const deptRows = await this.queryRows<any>(
        `SELECT
           department AS name,
           round(sum(toFloat64(debit)), 0) AS value
         FROM ${glTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})
           AND department != '' AND account_type IN ('Expense','Cost of Goods Sold')
         GROUP BY department HAVING value > 0
         ORDER BY value DESC LIMIT 20`,
        { externalOrgIds: scope.externalOrgIds },
      );
      if (deptRows.length > 0) {
        return { data: deptRows.map((r: any) => ({ name: String(r.name), value: this.num(r.value) })) };
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
      return { data: fallbackRows.map((r: any) => ({ name: String(r.name), value: this.num(r.value) })) };
    }

    // ── expense/class (bar, pie, treemap) ─────────────────────────────────────
    if (metric === 'expense' && grouping === 'class') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      // Use sample_gl_dump for exact class data (General, Marketing, Product)
      const classRows = await this.queryRows<any>(
        `SELECT
           class AS name,
           round(sum(toFloat64(debit)), 0) AS value
         FROM ${glTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})
           AND class != '' AND account_type IN ('Expense','Cost of Goods Sold')
         GROUP BY class HAVING value > 0
         ORDER BY value DESC LIMIT 20`,
        { externalOrgIds: scope.externalOrgIds },
      );
      if (classRows.length > 0) {
        return { data: classRows.map((r: any) => ({ name: String(r.name), value: this.num(r.value) })) };
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
      return { data: fallbackRows.map((r: any) => ({ name: String(r.name), value: this.num(r.value) })) };
    }

    // ── expense/vendor (horizontal_bar, pareto, table, scatter) ──────────────
    // Primary: sample_gl_dump.vendor_customer (exact Excel data, 24 real vendors)
    if (metric === 'expense' && grouping === 'vendor') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const limit = Math.max(5, Math.min(50, requestedTopN ?? 20));
      const glVendorRows = await this.queryRows<any>(
        `SELECT
           vendor_customer AS name,
           round(sum(toFloat64(debit)), 0) AS value,
           count() AS transaction_count,
           round(avg(toFloat64(debit)), 0) AS avg_amount
         FROM ${glTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)})
           AND vendor_customer != '' AND account_type IN ('Expense','Cost of Goods Sold')
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
    // line_amount < 0 = credit = revenue in double-entry GL.
    // Only include accounts that are clearly revenue/income — never liabilities (AP, payables, accruals).
    if (metric === 'revenue' && (grouping === 'account' || grouping === 'category' || grouping === 'account_name')) {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      // Use source_type = 'REV' to reliably identify revenue — avoids AP/Payroll contamination
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
      // Fallback: if no REV source_type rows, use account name matching (older data formats)
      if (revRows.length === 0) {
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
        return { data: fallbackRows.map((r: any) => ({ name: String(r.name), value: this.num(r.value) })) };
      }
      return { data: revRows.map((r: any) => ({ name: String(r.name), value: this.num(r.value) })) };
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
      return { data: deptRows.map((r: any) => ({ name: String(r.name), value: this.num(r.value) })) };
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
      const rows = await this.queryRows<any>(
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

    // ── expense/vendor_month (multi-series line — top vendors by month) ─────────
    if (metric === 'expense' && grouping === 'vendor_month') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      // Get top 8 vendors by total spend; fall back to all-time if time-filtered data is empty
      const topVendors = await this.queryRowsWithTimeFallback<any>(
        (t) => `SELECT vendor_name, sum(line_amount) AS total
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${t}
           AND line_amount > 0 AND journal_date IS NOT NULL AND vendor_name != '' ${BS_EXCL}
         GROUP BY vendor_name ORDER BY total DESC LIMIT 8`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
        jTime,
      );
      if (topVendors.length === 0) return { data: [], _noVendorData: true } as any;
      const vendorNames = (topVendors as any[]).map((r: any) => String(r.vendor_name));
      // Use all-time for monthly pivot so we get the full trend regardless of date range
      const rows = await this.queryRows<any>(
        `SELECT
           formatDateTime(toStartOfMonth(journal_date), '%b %y') AS month,
           toStartOfMonth(journal_date) AS month_start,
           vendor_name AS vendor,
           round(sum(line_amount), 0) AS value
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity}
           AND line_amount > 0 AND journal_date IS NOT NULL
           AND vendor_name IN ({vendorNames:Array(String)}) ${BS_EXCL}
         GROUP BY month, month_start, vendor
         ORDER BY month_start ASC`,
        { externalOrgIds: scope.externalOrgIds, vendorNames, ...entityParam },
      );
      const monthMap = new Map<string, { sort: string; [key: string]: any }>();
      const vendors = new Set<string>();
      for (const r of rows as any[]) {
        const m = String(r.month);
        if (!monthMap.has(m)) monthMap.set(m, { sort: String(r.month_start) });
        monthMap.get(m)![String(r.vendor)] = this.num(r.value);
        vendors.add(String(r.vendor));
      }
      const data = [...monthMap.entries()]
        .sort(([, a], [, b]) => a.sort.localeCompare(b.sort))
        .map(([month, vals]) => {
          const row: Record<string, any> = { name: month };
          for (const v of vendors) row[v] = vals[v] ?? 0;
          return row;
        });
      return { data, keys: [...vendors] };
    }

    // ── vendor_transactions/vendor (scatter, bubble) — falls back to account ───
    if (metric === 'vendor_transactions' && grouping === 'vendor') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
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
      if (vendorRows.length === 0) return { data: [], _noVendorData: true } as any;
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
        data: rows.map((r: any) => ({ name: String(r.name), value: this.num(r.value) })),
      };
    }

    // ── vendor_count/vendor (bar) — falls back to account when no vendor data ──
    if (metric === 'vendor_count' && grouping === 'vendor') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const vendorRows = await this.queryRows<any>(
        `SELECT vendor_name AS name, count() AS value
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${jTime}
           AND line_amount > 0 AND journal_date IS NOT NULL AND vendor_name != ''
         GROUP BY name ORDER BY value DESC LIMIT 20`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      if (vendorRows.length === 0) return { data: [], _noVendorData: true } as any;
      return { data: (vendorRows as any[]).map((r: any) => ({ name: String(r.name), value: this.num(r.value) })) };
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
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           formatDateTime(toStartOfMonth(journal_date), '%b %y') AS month,
           toStartOfMonth(journal_date) AS month_start,
           coalesce(nullIf(class_name, ''), 'Unassigned') AS cls,
           round(sum(line_amount), 0) AS value
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${jTime}
           AND line_amount > 0 AND journal_date IS NOT NULL ${BS_EXCL}
         GROUP BY month, month_start, cls
         ORDER BY month_start ASC, value DESC`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      const monthMap = new Map<string, { sort: string; [key: string]: any }>();
      const classes = new Set<string>();
      for (const r of rows as any[]) {
        const m = String(r.month);
        if (!monthMap.has(m)) monthMap.set(m, { sort: String(r.month_start) });
        monthMap.get(m)![String(r.cls)] = this.num(r.value);
        classes.add(String(r.cls));
      }
      const data = [...monthMap.entries()]
        .sort(([, a], [, b]) => a.sort.localeCompare(b.sort))
        .map(([month, vals]) => {
          const row: Record<string, any> = { name: month };
          for (const c of classes) row[c] = vals[c] ?? 0;
          return row;
        });
      return { data, keys: [...classes] };
    }

    // ── expense/dept_class (stacked bar: dept × class breakdown) ────────────
    if (metric === 'expense' && grouping === 'dept_class') {
      if (scope.externalOrgIds.length === 0) return { data: [] };
      const rows = await this.queryRows<any>(
        `SELECT
           coalesce(nullIf(department, ''), 'Unassigned') AS dept,
           coalesce(nullIf(class_name, ''), 'Unassigned') AS cls,
           round(sum(line_amount), 0) AS value
         FROM ${jTbl}
         WHERE org_id IN ({externalOrgIds:Array(String)}) ${entity} ${jTime}
           AND line_amount > 0 AND journal_date IS NOT NULL ${BS_EXCL}
         GROUP BY dept, cls
         HAVING value > 0
         ORDER BY dept ASC, value DESC`,
        { externalOrgIds: scope.externalOrgIds, ...entityParam },
      );
      const deptMap = new Map<string, { [key: string]: any }>();
      const classes = new Set<string>();
      for (const r of rows as any[]) {
        const d = String(r.dept);
        if (!deptMap.has(d)) deptMap.set(d, {});
        deptMap.get(d)![String(r.cls)] = this.num(r.value);
        classes.add(String(r.cls));
      }
      const data = [...deptMap.entries()].map(([dept, vals]) => {
        const row: Record<string, any> = { name: dept };
        for (const c of classes) row[c] = vals[c] ?? 0;
        return row;
      });
      return { data, keys: [...classes] };
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
      const revMap = new Map<string, number>((revJRows as any[]).map((r: any) => [String(r.dept), this.num(r.revenue)]));
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
      const expMap = new Map<string, number>((expRows as any[]).map((r: any) => [String(r.month_start), this.num(r.exp)]));
      return {
        data: (revRows as any[])
          .map((r: any) => {
            const rev = this.num(r.rev);
            const exp = expMap.get(String(r.month_start)) ?? 0;
            return { name: String(r.month_start), value: rev > 0 ? Math.round(((rev - exp) / rev) * 1000) / 10 : 0 };
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
      const expMap = new Map<string, number>((expRows as any[]).map((r: any) => [String(r.month_start), this.num(r.exp)]));
      return {
        data: (revRows as any[])
          .map((r: any) => {
            const rev = this.num(r.rev);
            const exp = expMap.get(String(r.month_start)) ?? 0;
            return { name: String(r.month_start), value: rev > 0 ? Math.round((exp / rev) * 1000) / 10 : 0 };
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
      return { data: (rows as any[]).map((r: any) => ({ name: String(r.name), value: this.num(r.value) })) };
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
      return { data: (rows as any[]).map((r: any) => ({ name: String(r.name), value: this.num(r.value) })) };
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
      return { data: (rows as any[]).map((r: any) => ({ name: String(r.name), value: this.num(r.value) })) };
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
      return { data: (rows as any[]).map((r: any) => ({ name: String(r.name), value: this.num(r.value) })) };
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
      return { data: (rows as any[]).map((r: any) => ({ name: String(r.name), value: this.num(r.value) })) };
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
      const dynamicSql = await this.generateDynamicMetricSql(metric, grouping, scope, range);
      if (dynamicSql) {
        try {
          const data = await this.executeDynamicSql(dynamicSql, scope);
          return { data };
        } catch (err: any) {
          this.logger.warn(`[Agent:DynamicFallback] metric=${metric} grouping=${grouping} sql_error=${err.message}`);
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
      const isDirectiveMessage = /^\s*use\s+(client|entity)(?:\s+(?:a|b|1|2))?\s*:/i.test(queryText);
      const mightBeCompareFollowUp = !isDirectiveMessage &&
        !spec.wantsTopClients &&
        (
          /\b(compare|comparison)\b/i.test(queryText) ||
          (/\b(revenue|outstanding|overdue|dso|month|chart|bar|line)\b/i.test(queryText) &&
            queryText.trim().split(/\s+/).length <= 20)
        );
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
          const directiveOrder = ['entity', 'client', 'client_a', 'client_b'] as const;
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
          const options = (
            await this.listEntitiesForScope(scope.connectionIds, spec.providerHint)
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
                const detail = o.value && o.value !== o.label ? ` — ${o.value}` : '';
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
              .map(
                (l) =>
                  l.match(/^use\s+client\s+(?:a|1)\s*[:\-]\s*(.+)$/i)?.[1]?.trim(),
              )
              .filter(Boolean)
              .slice(-1)[0] ?? null;
          const directiveB =
            lines
              .map(
                (l) =>
                  l.match(/^use\s+client\s+(?:b|2)\s*[:\-]\s*(.+)$/i)?.[1]?.trim(),
              )
              .filter(Boolean)
              .slice(-1)[0] ?? null;

          const inferred = this.extractCompareClients(queryText);
          // If the user explicitly chose B (but not A), don't treat it as A.
          const clientA =
            directiveA ??
            (directiveB ? null : inferred?.[0] ?? null);
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
                  value: 'Compare average days-to-pay by month in a line chart.',
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
              ? { connectionIds: scope.connectionIds, externalOrgIds: [spec.entityFilter.orgId] }
              : scope;

          if (scopeForPick.externalOrgIds.length > 0 && (!hasA || !hasB)) {
            const rows = await this.queryRows<any>(
              `SELECT
                 coalesce(nullIf(client_name, ''), '') AS client_name,
                 sum(total_invoiced) AS total_invoiced
               FROM ${this.analyticsDb}.v_dim_clients_latest
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
            ? { connectionIds: scope.connectionIds, externalOrgIds: [spec.entityFilter.orgId] }
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
            scope,
            spec.timeRange,
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
          scope,
          spec.timeRange,
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
          const scope = await this.getOrgScope(organizationId, role, spec.entityFilter?.orgId);
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

              const clientBreakdownMetrics = ['revenue', 'overdue', 'outstanding', 'dso', 'paid'];
              const breakdown =
                w.grouping === 'month' &&
                clientBreakdownMetrics.includes(String(w.metric ?? '').toLowerCase()) &&
                (wantsClientPair || spec.wantsTopClients)
                  ? 'client'
                  : ((w as any)?.breakdown ?? null);

              // Smart plan widgets carry pre-generated SQL (_sql field).
              // Fallback: if metric=dynamic but no _sql, generate SQL now.
              let dynamicSql: string | null = (w as any)._sql ?? null;
              if (!dynamicSql && w.metric === 'dynamic') {
                const intent = (w as any)._dynamicIntent ?? `${w.title} chart`;
                dynamicSql = await this.generateDynamicSql(intent, w.title, scope, spec.timeRange).catch(() => null);
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
                  display: dynamicSql ? null : ((w as any)?.display ?? null),
                  topN: dynamicSql ? null : (applyClientPair
                    ? null
                    : breakdown === 'client' && spec.wantsTopClients
                      ? (typeof (w as any)?.topN === 'number' ? (w as any).topN : (spec.topN ?? 2))
                      : ((w as any)?.topN ?? null)),
                  ...(dynamicSql ? { dynamicSql } : {}),
                } as Prisma.InputJsonValue,
                chartConfig: {
                  description: w.description,
                } as Prisma.InputJsonValue,
                displayOrder: w.display_order,
              };
            }),
          );

          await this.prisma.dashboardWidget.createMany({ data: widgetDataList });

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
            // Heatmaps aren't a first-class widget yet; map to bar/stacked bar as best-effort.
            if (wants(/heatmap/)) return wants(/stacked/) ? 'stacked_bar' : 'bar';
            if (wants(/waterfall/)) return 'waterfall';
            if (wants(/treemap/)) return 'treemap';
            if (wants(/scatter/)) return 'scatter';
            if (wants(/area\s+chart/)) return 'area';
            if (wants(/stacked\s+(bar|column)/)) return 'stacked_bar';
            if (wants(/(bar|column)\s+chart/)) return 'bar';
            if (wants(/pie\s+chart|donut\s+chart/)) return 'pie';
            if (wants(/line\s+chart/)) return 'line';
            return 'line';
          })();

          const display: W['display'] | undefined =
            wants(/donut/) || (wants(/highlight/) && wants(/highest|lowest|max|min/))
              ? {
                  donut: wants(/donut/),
                  highlightMaxMin:
                    wants(/highlight/) && wants(/highest|lowest|max|min/),
                }
              : undefined;

          const metricGrouping = ((): { metric: string; grouping: string } | null => {
            // Gauge-style “financial health” defaults to a KPI summary.
            if (wants(/gauge|health/) && wants(/revenue|expense|balance|profit|net/))
              return { metric: 'pl_summary', grouping: 'summary' };

            // Revenue by month
            if (wants(/revenue/) && wants(/\bby\s+month\b|\bmonthly\b|\beach\s+month\b/))
              return { metric: 'revenue', grouping: 'month' };

            // Month-over-month revenue growth %
            if (wants(/month[-\s]?over[-\s]?month|mom\b/) && wants(/revenue|growth/))
              return { metric: 'mom_growth', grouping: 'month' };

            // Cumulative revenue
            if (wants(/cumulative/) && wants(/revenue|sales|income/))
              return { metric: 'revenue_cumulative', grouping: 'month' };

            // Revenue vs expenses comparison
            if (wants(/compare|comparing/) && wants(/revenue/) && wants(/expense/))
              return { metric: 'revenue_vs_expense', grouping: 'month' };
            if (wants(/heatmap/) && wants(/revenue/) && wants(/expense/))
              return { metric: 'revenue_vs_expense', grouping: 'month' };

            // Net position (credits - debits)
            if (
              wants(/net\s+monthly|net\s+position|credits?\s*-\s*debits?|debits?\s*-\s*credits?/) ||
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
            if (wants(/invoice\s+value/) && wants(/\bby\s+month\b|\bmonthly\b|\beach\s+month\b/))
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
	            if (metricGrouping.metric === 'pl_summary') return 'Financial Health (KPI Summary)';
	            if (metricGrouping.metric === 'revenue') return 'Monthly Revenue';
	            if (metricGrouping.metric === 'mom_growth') return 'MoM Revenue Growth %';
	            if (metricGrouping.metric === 'revenue_cumulative') return 'Cumulative Revenue';
            if (metricGrouping.metric === 'revenue_vs_expense') return 'Revenue vs Expenses';
            if (metricGrouping.metric === 'net_position') return 'Net Monthly Position';
            if (metricGrouping.metric === 'running_balance') return 'Running Balance';
            if (metricGrouping.metric === 'debits_credits') return 'Debits vs Credits';
            if (metricGrouping.metric === 'invoice_value') return 'Invoice Value by Type';
            if (metricGrouping.metric === 'transaction_value') return 'Transaction Value by Journal Type';
            if (metricGrouping.metric === 'invoice_count') return 'Invoice Count Trend';
            if (metricGrouping.metric === 'avg_invoice') return 'Average Invoice Value';
            if (metricGrouping.metric === 'invoice_amount') return 'Invoice Amount Distribution';
            if (metricGrouping.metric === 'top_invoices') return 'Top Invoices';
            if (metricGrouping.metric === 'expense' && metricGrouping.grouping === 'month')
              return 'Monthly Expenses';
            if (metricGrouping.metric === 'expense' && metricGrouping.grouping === 'account')
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

	          const extra = topFromLine ? ({ topN: topFromLine } as const) : undefined;

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
    if (has(/running\s+balance|balance\s+trend|cash\s+position|net\s+position/)) {
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
    if (has(/scatter|outlier/) && has(/invoice\s+amount|invoice\s+value|amount/)) {
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
        mk('EBITDA Trend', 'Monthly EBITDA (net income + depreciation/amortisation add-back)', 'line', 'ebitda', 'month', 0),
        mk('P&L KPI Summary', 'Revenue, Expenses, Gross Profit, Net Income, Margins', 'metric', 'pl_summary', 'summary', 1),
        mk('Revenue vs Expenses', 'Revenue and total expenses on the same timeline', 'line', 'revenue_vs_expense', 'month', 2),
      ];
    }

    // ── Margin analysis focus ────────────────────────────────────────────────
    if (has(/gross\s+margin|net\s+margin|margin\s+analysis|margin\s+trend|gross\s+profit|markup/)) {
      return [
        mk('Gross Margin % Trend', 'Monthly gross margin percentage (revenue minus COGS)', 'line', 'gross_margin_pct', 'month', 0),
        mk('Net Margin % Trend', 'Monthly net margin percentage (revenue minus all expenses)', 'line', 'net_margin_pct', 'month', 1),
        mk('P&L KPI Summary', 'Revenue, Expenses, Gross Profit, Net Income, Margins', 'metric', 'pl_summary', 'summary', 2),
      ];
    }

    // ── P&L / income statement / net income focus ───────────────────────────
    if (has(/p&l|pl\b|profit\s+and\s+loss|income\s+statement|net\s+income|net\s+profit/) ||
        (has(/profit|loss|profitability/) && !has(/overdue|ar\b|receivable/))) {
      const chartType: 'line' | 'bar' = has(/bar\s+chart|bar\s+graph|\bbar\b/) ? 'bar' : 'line';
      return [
        mk('P&L Statement', 'Full income statement: Revenue, COGS, OPEX, Net Income by account', 'table', 'pl', 'summary', 0),
        mk('P&L KPI Summary', 'Revenue, Expenses, Gross Profit, Net Income, Gross Margin %, Net Margin %', 'metric', 'pl_summary', 'summary', 1),
        mk('Net Income Trend', 'Monthly net income (revenue minus all GL expenses)', chartType, 'net_income', 'month', 2),
      ];
    }

    // ── Expense / OPEX / cost breakdown focus ────────────────────────────────
    if (has(/expense|expenses|opex|operating\s+expense|cost\s+breakdown|spending|spend|overheads?/)) {
      const chartType: 'bar' | 'pie' = has(/pie\s+chart|pie\s+graph|\bpie\b/) ? 'pie' : 'bar';
      const w: W[] = [
        mk('Top Expenses by GL Account', 'Expense accounts ranked by total spend', chartType, 'expense', 'account', 0),
        mk('Expense Trend', 'Monthly total expense trend from GL journals', 'line', 'expense', 'month', 1),
        mk('Expense KPI Summary', 'Total Expenses, COGS, OPEX, largest expense account', 'metric', 'expense_summary', 'summary', 2),
      ];
      if (has(/cogs|cost\s+of\s+goods|cost\s+of\s+sales|direct\s+cost/)) {
        w.push(mk('COGS by Account', 'Direct cost accounts ranked by spend', 'bar', 'cogs', 'account', 3));
      }
      if (has(/opex|operating\s+expense/) && !has(/only|just/)) {
        w.push(mk('OPEX by Account', 'Operating expense accounts (excluding COGS)', 'bar', 'opex', 'account', 4));
      }
      return w;
    }

    // ── GL / journal / ledger focus ──────────────────────────────────────────
    if (has(/journal|journals|gl\b|general\s+ledger|journal\s+lines?|gl\s+entries|ledger\s+entries/)) {
      return [
        mk('GL Journal Entries', 'All journal lines with debit/credit type, account, journal number', 'table', 'gl_transactions', 'list', 0),
        mk('Top Expenses by Account', 'Expense accounts from journal lines ranked by spend', 'bar', 'expense', 'account', 1),
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

      if (
        wantsCompareClients &&
        has(/\b(outstanding|overdue|aging|ar\b|receivable|past.?due)\b/) &&
        has(/month|monthly|month[-\s]?wise|trend|over\s+time|last\s+\d+\s+months?/)
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
        has(/dso|days?\s+to\s+pay|payment\s+days|issued.*paid|convert.*issued.*paid/) &&
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

      const [summary, topClients, entities, journalCtx] = await Promise.allSettled([
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
	           WHERE org_id IN ({externalOrgIds:Array(String)})
	             ${client}
	             ${entity}
	             AND issued_at IS NOT NULL
	             ${time}`,
	          {
	            externalOrgIds: orgIds,
	            ...clientParam,
	            ...entityParam,
	          },
	        ),
        this.queryRows<any>(
          `SELECT client_name, round(total_invoiced, 0) AS billed, round(total_overdue, 0) AS overdue
           FROM ${this.analyticsDb}.v_dim_clients_latest
           WHERE org_id IN ({orgIds:Array(String)}) AND client_name != ''
           ${clientDim}
           ${entityFilter ? `AND org_id = {orgId:String}` : ''}
           ORDER BY total_invoiced DESC
           LIMIT ${clientFilter ? 1 : 5}`,
          { orgIds, ...clientParam, ...entityParam },
        ),
        this.queryRows<any>(
          `SELECT coalesce(org_name, org_id) AS org_name, count() AS invoice_count
	           FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
	           WHERE org_id IN ({externalOrgIds:Array(String)})
	             ${client}
	             ${entity}
	             ${time}
	           GROUP BY org_name ORDER BY invoice_count DESC LIMIT 5`,
	          {
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
           WHERE org_id IN ({orgIds:Array(String)})
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
          { orgIds, ...entityParam },
        ).catch(() => [] as any[]),
      ]);

      const s =
        (summary.status === 'fulfilled' ? summary.value[0] : null) ?? {};
      const clients = topClients.status === 'fulfilled' ? topClients.value : [];
      const ents = entities.status === 'fulfilled' ? entities.value : [];
      const jCtx = (journalCtx.status === 'fulfilled' ? journalCtx.value[0] : null) ?? {};

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
        : [`- GL Journals: no journal lines synced yet (P&L/expense charts need Xero journal sync)`];

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

  // ─── Live schema introspection — feeds real dimension values to the SQL planner
  private async introspectLiveSchema(scope: OrgScope): Promise<string> {
    if (scope.externalOrgIds.length === 0) return '';
    const db = this.analyticsDb;
    const params = { externalOrgIds: scope.externalOrgIds };
    const orgWhere = `org_id IN ({externalOrgIds:Array(String)})`;

    try {
      const [
        dateRange, departments, vendors, expenseAccts, revenueAccts, jTypes, invoiceSummary, topClients,
        tbSummary, tbAccounts, glDepts, glClasses, glVendors, glJournalTypes,
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
             round(abs(sumIf(toFloat64(net_balance), account_type IN ('Bank','Accounts Receivable (AR)','Other Current Asset','Fixed Asset','Other Asset'))), 0) AS total_assets,
             round(abs(sumIf(toFloat64(net_balance), account_type IN ('Accounts Payable (AP)','Other Current Liability','Long Term Liability'))), 0) AS total_liabilities,
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
        this.queryRows<any>(
          `SELECT department, round(sum(toFloat64(debit)), 0) AS spend
           FROM ${db}.sample_gl_dump
           WHERE ${orgWhere} AND department != ''
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
          `SELECT vendor_customer AS vname, round(sum(toFloat64(debit)), 0) AS spend
           FROM ${db}.sample_gl_dump
           WHERE ${orgWhere} AND vendor_customer != '' AND account_type IN ('Expense','Cost of Goods Sold')
           GROUP BY vendor_customer ORDER BY spend DESC LIMIT 15`,
          params,
        ),
        this.queryRows<any>(
          `SELECT DISTINCT journal_type FROM ${db}.sample_gl_dump WHERE ${orgWhere} ORDER BY journal_type LIMIT 10`,
          params,
        ),
      ]);

      const dr    = dateRange.status       === 'fulfilled' ? dateRange.value[0]  : null;
      const depts = departments.status     === 'fulfilled' ? departments.value.map((r: any) => r.dept).filter(Boolean) : [];
      const vends = vendors.status         === 'fulfilled' ? vendors.value        : [];
      const expAs = expenseAccts.status    === 'fulfilled' ? expenseAccts.value   : [];
      const revAs = revenueAccts.status    === 'fulfilled' ? revenueAccts.value   : [];
      const jtps  = jTypes.status          === 'fulfilled' ? jTypes.value.map((r: any) => r.source_type).filter(Boolean) : [];
      const inv   = invoiceSummary.status  === 'fulfilled' ? invoiceSummary.value[0] : null;
      const clts  = topClients.status      === 'fulfilled' ? topClients.value     : [];
      const tb    = tbSummary.status       === 'fulfilled' ? tbSummary.value[0]   : null;
      const tbAc  = tbAccounts.status      === 'fulfilled' ? tbAccounts.value     : [];
      const glDs  = glDepts.status         === 'fulfilled' ? glDepts.value        : [];
      const glCs  = glClasses.status       === 'fulfilled' ? glClasses.value      : [];
      const glVs  = glVendors.status       === 'fulfilled' ? glVendors.value      : [];
      const glJts = glJournalTypes.status  === 'fulfilled' ? glJournalTypes.value.map((r: any) => r.journal_type).filter(Boolean) : [];

      const lines: string[] = ['LIVE DATA CONTEXT — use these real values in SQL and chart titles:'];

      // ── Trial Balance P&L totals (authoritative) ──────────────────────────────
      if (tb) {
        const rev   = this.num(tb.revenue);
        const cogs  = this.num(tb.cogs);
        const opex  = this.num(tb.opex);
        const gp    = rev - cogs;
        const ni    = gp - opex;
        lines.push(`• AUTHORITATIVE P&L (from sample_trial_balance): Revenue=$${this.fmtK(rev)} | COGS=$${this.fmtK(cogs)} | Operating Expenses=$${this.fmtK(opex)} | Gross Profit=$${this.fmtK(gp)} | Net Income=$${this.fmtK(ni)}`);
        lines.push(`• AUTHORITATIVE Balance Sheet: Total Assets=$${this.fmtK(this.num(tb.total_assets))} | Total Liabilities=$${this.fmtK(this.num(tb.total_liabilities))} | Total Equity=$${this.fmtK(this.num(tb.total_equity))}`);
      }

      // ── Trial Balance accounts by type ────────────────────────────────────────
      if (tbAc.length > 0) {
        const byType = new Map<string, Array<{name: string; balance: number}>>();
        for (const r of tbAc) {
          const at = String(r.account_type);
          if (!byType.has(at)) byType.set(at, []);
          byType.get(at)!.push({ name: String(r.account_name), balance: this.num(r.balance) });
        }
        const typeLines: string[] = [];
        for (const [at, accts] of byType.entries()) {
          typeLines.push(`${at}: ${accts.slice(0,5).map(a => `${a.name} ($${this.fmtK(a.balance)})`).join(', ')}`);
        }
        lines.push(`• sample_trial_balance account types → ${typeLines.join(' | ')}`);
      }

      // ── GL dump context ────────────────────────────────────────────────────────
      if (glDs.length > 0) {
        const ds = glDs.map((r: any) => `${r.department} ($${this.fmtK(this.num(r.spend))})`).join(', ');
        lines.push(`• sample_gl_dump departments (exact, NO Finance): ${ds}`);
      }
      if (glCs.length > 0) {
        const cs = glCs.map((r: any) => `${r.class} ($${this.fmtK(this.num(r.spend))})`).join(', ');
        lines.push(`• sample_gl_dump classes: ${cs}`);
      }
      if (glVs.length > 0) {
        const vs = glVs.slice(0, 12).map((r: any) => `${r.vname} ($${this.fmtK(this.num(r.spend))})`).join(' | ');
        lines.push(`• Top vendors (sample_gl_dump.vendor_customer): ${vs}`);
      }
      if (glJts.length > 0) {
        lines.push(`• sample_gl_dump journal_type values: ${glJts.join(', ')}`);
      }

      // ── Journal lines / invoice context ───────────────────────────────────────
      if (dr?.cnt > 0)
        lines.push(`• GL journal entries: ${dr.cnt} rows | Period: ${dr.from_d} → ${dr.to_d}`);
      if (this.num(inv?.inv_count) > 0)
        lines.push(`• Invoices: ${inv.inv_count} total | Revenue: $${this.fmtK(this.num(inv.inv_revenue))} | Period: ${inv.from_d} → ${inv.to_d}`);
      if (depts.length > 0)
        lines.push(`• Departments in journal lines (use exact names): ${depts.join(', ')}`);
      if (jtps.length > 0)
        lines.push(`• Journal source_type values: ${jtps.join(', ')}`);
      if (expAs.length > 0) {
        const top = expAs.slice(0, 10).map((a: any) => `${a.account_name} ($${this.fmtK(this.num(a.total))})`).join(' | ');
        lines.push(`• Top expense accounts (source_type IN ('OPEX','COGS'), line_amount > 0): ${top}`);
      }
      if (revAs.length > 0) {
        const top = revAs.slice(0, 8).map((a: any) => `${a.account_name} ($${this.fmtK(this.num(a.total))})`).join(' | ');
        lines.push(`• Revenue accounts (source_type = 'REV', use abs(line_amount)): ${top}`);
      }
      if (vends.length > 0) {
        const top = vends.slice(0, 10).map((v: any) => `${v.vname} ($${this.fmtK(this.num(v.spend))})`).join(' | ');
        lines.push(`• Top vendors in journal lines (secondary): ${top}`);
      }
      if (clts.length > 0) {
        const top = clts.slice(0, 6).map((c: any) => `${c.client_name} ($${this.fmtK(this.num(c.billed))})`).join(' | ');
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
  private async generateSmartPlan(
    query: string,
    scope: OrgScope,
    range?: TimeRange,
    conversationHistory?: string,
  ): Promise<AgentPlan | null> {
    try {
      // Verify Ollama is reachable before doing the expensive introspection
      const ping = await fetch(`${this.OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
      if (!ping?.ok) return null;

      const liveContext = await this.introspectLiveSchema(scope);

      const q = query.toLowerCase();
      const maxCharts =
        /\b(dashboard|report|board.pack|pack|suite|deep.dive)\b/.test(q) ? 6
        : /\bcharts?\b|\bgraphs?\b|\bwidgets?\b/i.test(q) ? 4
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
        `Generate up to ${maxCharts} chart(s). Each chart needs a precise SQL query using the REAL data values shown above.`,
      ].filter(Boolean).join('\n');

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120_000);

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
            num_predict: 3000,
            num_ctx: 8192,
          },
        }),
      });
      clearTimeout(timer);

      if (!response.ok) return null;

      const body = (await response.json()) as { message?: { content?: string } };
      const raw = (body.message?.content ?? '').replace(/```json|```/g, '').trim();

      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Try to extract JSON from response if LLM added surrounding text
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        parsed = JSON.parse(jsonMatch[0]);
      }

      if (!parsed?.charts || !Array.isArray(parsed.charts) || parsed.charts.length === 0) return null;

      const widgets: Array<AgentPlan['dashboard']['widgets'][number] & { _sql?: string }> = [];

      for (let i = 0; i < parsed.charts.length; i++) {
        const c = parsed.charts[i];
        if (!c?.sql || !c?.type || !c?.title) continue;

        let sql: string | null = null;
        try {
          sql = this.validateAndScopeDynamicSql(String(c.sql).trim().replace(/;+$/, ''), scope);
        } catch (e: any) {
          this.logger.warn(`[SmartPlan] Widget ${i} SQL invalid: ${e.message}`);
          continue;
        }

        const chartType = (() => {
          const valid: ChartType[] = [
            'line','bar','pie','donut','metric','kpi','table','area','treemap',
            'scatter','stacked_bar','waterfall','histogram','horizontal_bar',
            'pareto','gauge','bubble','heatmap',
          ];
          return valid.includes(c.type as ChartType) ? (c.type as ChartType) : 'bar';
        })();

        widgets.push({
          title: String(c.title ?? '').slice(0, 80),
          description: String(c.description ?? ''),
          type: chartType,
          metric: 'dynamic',
          grouping: 'query',
          display_order: i,
          _sql: sql,
        } as any);
      }

      if (widgets.length === 0) return null;

      this.logger.log(`[SmartPlan] Generated ${widgets.length} SQL-backed charts for: "${query.slice(0, 80)}"`);

      return {
        tools_to_execute: [],
        should_generate_dashboard: true,
        dashboard: {
          title: String(parsed.title ?? query).slice(0, 100),
          description: 'Real-time dashboard built from live ClickHouse data',
          widgets: widgets as AgentPlan['dashboard']['widgets'],
        },
        analysis_focus: query,
      };
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
      if (/\b(info|information|details|data|list|breakdown|comparison)\b/i.test(chunk)) {
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
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s))
      return true;
    if (/^\d{8,}$/.test(s)) return true;
    return false;
  }

  private async listEntitiesForScope(
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
        const provider = String(r.provider ?? '').toLowerCase().trim();
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
           WHERE org_id IN ({orgIds:Array(String)})
           GROUP BY org_id
           ORDER BY total_amount DESC
           LIMIT 500`,
          { orgIds: opaqueOrgIds },
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
      else if (this.isOpaqueEntityLabel(existing.orgName) && !this.isOpaqueEntityLabel(cur.orgName))
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

    // Prefer Prisma connections list (stable even if invoices are empty / not yet synced),
    // but enrich opaque ids with org_name from live invoice data when possible.
    const connCandidates = await this.listEntitiesForScope(
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

    if (
      /\bline\s*chart\b|\bline\s*graph\b|\bline\b/.test(q) &&
      /\bchart\b|\bgraph\b/.test(q)
    )
      addType('line');
    if (
      /\barea\s*chart\b|\barea\s*graph\b|\barea\b/.test(q) &&
      /\bchart\b|\bgraph\b/.test(q)
    )
      addType('area');
    if (
      /\bbar\s*chart\b|\bbarchart\b|\bbar\s*graph\b|\bstacked\s+bar\b|\bstacked\s+bars\b/.test(
        q,
      )
    )
      addType(/\bstacked\s+bar\b|\bstacked\s+bars\b/.test(q) ? 'stacked_bar' : 'bar');
    if (/\bpie\s+chart\b|\bpie\s+graph\b/.test(q)) addType('pie');
    if (/\btable\b|\btabular\b/.test(q)) addType('table');
    if (/\bmetric\s+tile\b|\bmetric\b/.test(q) && /\btile\b/.test(q))
      addType('metric');
    if (/\bwaterfall\s+chart\b|\bwaterfall\b/.test(q)) addType('waterfall');
    if (/\btreemap\b/.test(q)) addType('treemap');
    if (/\bscatter\s*plot\b|\bscatter\b/.test(q)) addType('scatter');

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
    scope?: OrgScope,
    range?: TimeRange,
  ): Promise<AgentPlan> {
    // Fast deterministic routing — bypass both the Smart SQL planner and Ollama
    // for well-known query patterns to guarantee consistent, correct output.
    const preRouted = this.preRouteQuery(query);
    if (preRouted && preRouted.length > 0) {
      this.logger.log(`[plan] pre-route matched — ${preRouted.length} widget(s), bypassing LLM`);
      const widgets = preRouted.map((w, i) => ({
        title: w.title,
        description: '',
        type: w.type as AgentPlan['dashboard']['widgets'][number]['type'],
        metric: w.metric,
        grouping: w.grouping,
        display_order: i,
        data: [],
      }));
      return {
        tools_to_execute: this.selectToolsForQuery(query),
        should_generate_dashboard: true,
        dashboard: {
          title: this.deriveQueryTitle(query),
          description: 'AI-generated financial intelligence dashboard',
          widgets,
        },
        analysis_focus: query,
      };
    }

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
        /\b(dashboard|report|board pack|pack|suite|deep dive)\b/i.test(
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

    // ── PRIMARY PATH: Smart SQL planner — queries real ClickHouse data ─────────
    // Introspects live dimension values, then has the LLM generate exact SQL for
    // every chart. No preset vocabulary, no pattern-matching shortcuts.
    if (scope && scope.externalOrgIds.length > 0) {
      const smartPlan = await this.generateSmartPlan(query, scope, range, conversationHistory);
      if (smartPlan) {
        this.logger.log(`[plan] smart-SQL path succeeded — ${smartPlan.dashboard.widgets.length} SQL-backed charts`);
        return smartPlan;
      }
      this.logger.warn('[plan] smart-SQL path failed — falling back to vocabulary planner');
    }

    // ── FALLBACK: Vocabulary-based planner (Ollama picks preset metric+grouping)
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
        type PlannedWidget = AgentPlan['dashboard']['widgets'][number] & { _dynamicIntent?: string };
        // Separate known widgets from unknown ones (unknown become dynamic SQL candidates)
        const knownWidgets = (cand.widgets ?? []).filter((w) =>
          VALID_WIDGETS.some(
            (v) => v.type === w.type && v.metric === w.metric && v.grouping === w.grouping,
          ),
        );
        const unknownWidgets = (cand.widgets ?? []).filter(
          (w) =>
            !VALID_WIDGETS.some(
              (v) => v.type === w.type && v.metric === w.metric && v.grouping === w.grouping,
            ),
        );
        // Tag unknown widgets as dynamic — they get SQL generated in Phase 3
        const dynamicWidgets: PlannedWidget[] = unknownWidgets.map((w: any, i) => ({
          title: w.title ?? `${w.metric} Chart`,
          description: w.description ?? '',
          type: ((
            [
              'line',
              'bar',
              'pie',
              'table',
              'metric',
              'area',
              'treemap',
              'scatter',
              'stacked_bar',
              'waterfall',
            ].includes(w.type)
              ? w.type
              : 'bar'
          ) as any),
          metric: 'dynamic',
          grouping: 'query',
          display_order: knownWidgets.length + i,
          _dynamicIntent: `${w.title ?? w.metric}: ${w.metric}/${w.grouping} chart for query "${query}"`,
        }));

        const validWidgets = knownWidgets
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
          .slice(0, 6) // cap known widgets to leave room for up to 2 dynamic
          .map((w: any, i) => {
            const breakdown =
              typeof w.breakdown === 'string' ? String(w.breakdown) : undefined;
            const topN = Number.isFinite(Number(w.topN))
              ? Number(w.topN)
              : undefined;

            // Metrics that support breakdown='client' (multi-series per-client pivot)
            const clientBreakdownSupportedMetrics = new Set([
              'revenue', 'outstanding', 'overdue', 'paid', 'dso',
            ]);
            const normalizedBreakdown: 'client' | undefined =
              breakdown === 'client' &&
              clientBreakdownSupportedMetrics.has(w.metric) &&
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

        // Merge dynamic widgets (capped at 2 to avoid dashboard bloat)
        const allWidgets = [
          ...validWidgets,
          ...dynamicWidgets.slice(0, Math.max(0, 8 - validWidgets.length)),
        ].map((w, i) => ({ ...w, display_order: i }));

        // If the model fails to select any valid widgets, fall back deterministically.
        // This is a safety net only — we do NOT auto-add extra charts beyond what was requested.
        if (allWidgets.length === 0) {
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
          allWidgets.push(...filler);
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
            : this.deriveToolsFromWidgets(allWidgets, query);

        return {
          title:
            cand.title?.trim() && cand.title.length > 5
              ? cand.title.trim()
              : fallback.dashboard.title,
          widgets: allWidgets,
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
          const repair = (
            errs: string[],
            widgets: AgentPlan['dashboard']['widgets'],
          ): AgentPlan['dashboard']['widgets'] => {
            const out = widgets.slice();
            const wantsType = constraints?.requiredTypes?.[0];

            const mk = (
              title: string,
              description: string,
              type: ChartType,
              metric: string,
              grouping: string,
              extra?: Record<string, any>,
            ) => ({
              title,
              description,
              type,
              metric,
              grouping,
              display_order: 0,
              ...(extra ?? {}),
            });

            const replaceAll = (next: any[]) =>
              applyImplicitMax(next).map((w, i) => ({ ...w, display_order: i }));

            // Payment-speed intent repairs
            if (errs.includes('PAYMENT_DAYS_TREND_REQUIRES_DSO')) {
              return replaceAll([
                mk(
                  'DSO Trend',
                  'Average days-to-pay by month (issued date)',
                  wantsType === 'bar' ? 'bar' : 'line',
                  'dso',
                  'month',
                ),
              ]);
            }
            if (errs.includes('PAYMENT_DAYS_LIST_REQUIRES_TABLE')) {
              return replaceAll([
                mk(
                  'Invoice Payment Days (Issued → Paid)',
                  'Days between invoice issue and final payment',
                  'table',
                  'payment_days',
                  'list',
                ),
              ]);
            }
            if (errs.includes('PAYMENT_DAYS_DISTRIBUTION_REQUIRES_BUCKETS')) {
              return replaceAll([
                mk(
                  'Payment Speed Distribution',
                  'Histogram of days-to-pay buckets',
                  'bar',
                  'payment_days',
                  'bucket',
                ),
              ]);
            }

            // Top-clients repairs (avoid useless lifetime ranking when trend requested)
            if (
              errs.includes('TOP_CLIENTS_TREND_REQUIRES_TIME_SERIES') ||
              errs.includes('TOP_CLIENTS_REQUIRES_CLIENT_BREAKDOWN')
            ) {
              const n = typeof spec.topN === 'number' ? Math.max(1, Math.min(5, spec.topN)) : 2;
              const alreadyHasIt = out.some(
                (w: any) =>
                  w.metric === 'revenue' &&
                  w.grouping === 'month' &&
                  String((w as any).breakdown ?? '') === 'client',
              );
              if (alreadyHasIt) return replaceAll(out);
              // Replace the whole plan — the LLM missed the breakdown requirement.
              // Appending would be silently dropped by applyImplicitMax (which caps
              // single-question dashboards at 1 widget). Replace instead.
              return replaceAll([
                mk(
                  `Top ${n} Clients — Revenue by Month`,
                  'Month-wise revenue for your top clients (grouped bars)',
                  wantsType === 'line' ? 'line' : 'bar',
                  'revenue',
                  'month',
                  { breakdown: 'client', topN: n },
                ),
              ]);
            }

            // Generic trend repairs
            if (errs.includes('TREND_REQUIRES_TIME_SERIES')) {
              return replaceAll([
                mk(
                  'Revenue Trend',
                  'Monthly revenue trend',
                  wantsType === 'bar' ? 'bar' : 'line',
                  'revenue',
                  'month',
                ),
              ]);
            }

            if (errs.includes('QUARTERLY_REQUIRES_QUARTER_GROUPING')) {
              return replaceAll([
                mk(
                  'Quarterly Revenue Cadence',
                  'Quarter-by-quarter revenue trend',
                  'bar',
                  'revenue',
                  'quarter',
                ),
              ]);
            }

            if (errs.includes('AUDIT_REQUIRES_TABLE')) {
              return replaceAll([
                mk(
                  'Recent Invoices Ledger',
                  'Latest invoices for audit and drill-down',
                  'table',
                  'invoices',
                  'list',
                ),
              ]);
            }

            if (errs.includes('VENTURE_REQUIRES_METRIC')) {
              return replaceAll([
                mk(
                  'Venture Health Metrics',
                  'Burn, runway, cash-on-hand, efficiency',
                  'metric',
                  'venture',
                  'summary',
                ),
              ]);
            }
            if (errs.includes('VENTURE_WIDGET_NOT_RELEVANT')) {
              return replaceAll(out.filter((w: any) => w.metric !== 'venture'));
            }

            // AR risk repairs
            if (errs.includes('AR_RISK_REQUIRES_OVERDUE')) {
              return replaceAll([
                mk(
                  'Overdue AR Trend',
                  'Monthly overdue build-up — collection risk signal',
                  wantsType === 'bar' ? 'bar' : 'line',
                  'overdue',
                  'month',
                ),
              ]);
            }

            // P&L repairs
            if (errs.includes('PNL_REQUIRES_PNL_WIDGET')) {
              return replaceAll([
                mk('P&L Statement', 'Full income statement by account', 'table', 'pl', 'summary'),
                mk('P&L KPI Summary', 'Revenue, Expenses, Gross Profit, Net Income, Margins', 'metric', 'pl_summary', 'summary'),
                mk('Net Income Trend', 'Monthly net income (revenue minus expenses)', wantsType === 'bar' ? 'bar' : 'line', 'net_income', 'month'),
              ]);
            }

            // Expense repairs
            if (errs.includes('EXPENSE_REQUIRES_EXPENSE_WIDGET')) {
              return replaceAll([
                mk('Top Expenses by Account', 'GL expense breakdown ranked by spend', wantsType === 'pie' ? 'pie' : 'bar', 'expense', 'account'),
                mk('Expense Trend', 'Monthly total expense trend', 'line', 'expense', 'month'),
                mk('Expense KPI Summary', 'Total Expenses, COGS, OPEX, largest account', 'metric', 'expense_summary', 'summary'),
              ]);
            }

            // Margin repairs
            if (errs.includes('MARGIN_REQUIRES_MARGIN_WIDGET')) {
              return replaceAll([
                mk('Gross Margin % Trend', 'Monthly gross margin percentage', 'line', 'gross_margin_pct', 'month'),
                mk('Net Margin % Trend', 'Monthly net margin percentage', 'line', 'net_margin_pct', 'month'),
                mk('P&L KPI Summary', 'Revenue, Gross Profit, Net Income, Margins', 'metric', 'pl_summary', 'summary'),
              ]);
            }

            // EBITDA repairs
            if (errs.includes('EBITDA_REQUIRES_EBITDA_WIDGET')) {
              return replaceAll([
                mk('EBITDA Trend', 'Monthly EBITDA (net income + D&A add-back)', 'line', 'ebitda', 'month'),
                mk('P&L KPI Summary', 'Revenue, Expenses, Gross Profit, Net Income, Margins', 'metric', 'pl_summary', 'summary'),
              ]);
            }

            // GL repairs
            if (errs.includes('GL_REQUIRES_GL_WIDGET')) {
              return replaceAll([
                mk('GL Journal Entries', 'All journal lines with debit/credit, account, amount', 'table', 'gl_transactions', 'list'),
                mk('Top Expenses by Account', 'GL expense breakdown ranked by spend', 'bar', 'expense', 'account'),
              ]);
            }

            return out;
          };

          const repaired = repair(validationErrors, constrainedWidgets);
          const remaining = this.validateWidgetsAgainstSpec(spec, repaired);
          if (remaining.length > 0) {
            this.logger.warn(
              `[Agent:Planner] Plan rejected by spec validation: ${validationErrors.join(',')}; repair failed: ${remaining.join(',')}`,
            );
            return fallback;
          }
          this.logger.warn(
            `[Agent:Planner] Plan repaired after spec validation: ${validationErrors.join(',')}`,
          );
          // Proceed with repaired widgets.
          return {
            tools_to_execute: this.deriveToolsFromWidgets(repaired, query),
            should_generate_dashboard: true,
            dashboard: {
              title: best.title,
              description: 'AI-generated financial intelligence dashboard',
              widgets: repaired,
            },
            analysis_focus: query,
          };
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
    if (spec.wantsTopClients || /\b(client|clients|customer|customers|contact|contacts)\b/i.test(query)) {
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
    const types = new Set(widgets.map((w) => w.type === 'area' ? 'line' : w.type));
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
      score += widgets.filter((w) => w.type === 'line' || w.type === 'area').length * 5;
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
    if (has(/p&l|pl\b|profit\s+and\s+loss|income\s+statement|net\s+income|net\s+profit/))
      score += widgets.filter((w) => ['net_income', 'pl', 'pl_summary'].includes(w.metric)).length * 12;

    // Expense / OPEX / cost
    if (has(/expense|expenses|opex|operating\s+expense|cost\s+breakdown|spending|spend|overheads?|cogs|cost\s+of\s+goods|cost\s+of\s+sales|direct\s+cost/))
      score += widgets.filter((w) => ['expense', 'opex', 'cogs', 'expense_summary'].includes(w.metric)).length * 12;

    // Margin analysis
    if (has(/gross\s+margin|net\s+margin|margin|profitability|gross\s+profit/))
      score += widgets.filter((w) => ['gross_margin_pct', 'net_margin_pct', 'gross_profit', 'pl_summary'].includes(w.metric)).length * 12;

    // EBITDA
    if (has(/ebitda/))
      score += widgets.filter((w) => w.metric === 'ebitda').length * 15;

    // GL / journal
    if (has(/journal|gl\b|general\s+ledger|ledger\s+entries/))
      score += widgets.filter((w) => ['gl_transactions', 'pl'].includes(w.metric)).length * 10;

    // Revenue vs expense comparison
    if (has(/revenue\s+vs\s+expense|revenue\s+and\s+expense|expense\s+vs\s+revenue/))
      score += widgets.filter((w) => w.metric === 'revenue_vs_expense').length * 12;

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
      if (has((w) => w.metric === 'venture')) errs.push('VENTURE_WIDGET_NOT_RELEVANT');
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
      const hasPnlWidget = has(
        (w) =>
          ['net_income', 'pl', 'pl_summary', 'gross_profit', 'revenue_vs_expense'].includes(w.metric),
      );
      if (!hasPnlWidget) errs.push('PNL_REQUIRES_PNL_WIDGET');
    }

    if (spec.focus === 'EXPENSE') {
      const hasExpenseWidget = has(
        (w) => ['expense', 'opex', 'cogs', 'expense_summary'].includes(w.metric),
      );
      if (!hasExpenseWidget) errs.push('EXPENSE_REQUIRES_EXPENSE_WIDGET');
    }

    if (spec.focus === 'MARGIN') {
      const hasMarginWidget = has(
        (w) =>
          ['gross_margin_pct', 'net_margin_pct', 'gross_profit', 'pl_summary'].includes(w.metric),
      );
      if (!hasMarginWidget) errs.push('MARGIN_REQUIRES_MARGIN_WIDGET');
    }

    if (spec.focus === 'EBITDA') {
      if (!has((w) => w.metric === 'ebitda')) errs.push('EBITDA_REQUIRES_EBITDA_WIDGET');
    }

    if (spec.focus === 'GL') {
      const hasGlWidget = has((w) => ['gl_transactions', 'pl', 'expense'].includes(w.metric));
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
          { label: 'P&L / Income Statement', value: 'Build a full P&L with net income, gross margin, and expense breakdown.' },
          { label: 'Expense analysis', value: 'Show expenses by GL account with COGS vs OPEX breakdown.' },
          { label: 'Revenue & AR', value: 'Focus on revenue trends, outstanding, and overdue.' },
          { label: 'Executive CFO dashboard', value: 'Build a comprehensive CFO dashboard with P&L, margin, AR, and client data.' },
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
	           FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
	           WHERE org_id IN ({externalOrgIds:Array(String)})
	             ${provider}
	             ${client}
	             ${entity}
	             ${time}
	             ${arFilter}
	             AND issued_at IS NOT NULL
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
             countIf(
               due_at IS NOT NULL AND due_at < now() AND lowerUTF8(status) IN ('authorised','sent','needtosend','notset','active','open')
             ) AS overdue_count
	           FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
	           WHERE org_id IN ({externalOrgIds:Array(String)})
	             ${provider}
	             ${client}
	             ${entity}
	             ${time}
	             ${arFilter}
	             AND issued_at IS NOT NULL
	           GROUP BY org_name, org_id, provider ORDER BY total_revenue DESC`,
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

      case 'invoice_breakdown': {
        return this.queryRows<any>(
          `SELECT
             status,
             count() AS invoice_count,
             coalesce(sum(total_amount), 0) AS status_total,
             coalesce(avg(total_amount), 0) AS avg_amount,
             coalesce(max(total_amount), 0) AS max_amount
	           FROM ${this.analyticsDb}.v_fact_accounting_invoices_latest
	           WHERE org_id IN ({externalOrgIds:Array(String)})
	             ${provider}
	             ${client}
	             ${entity}
	             ${time}
	             ${arFilter}
	             AND issued_at IS NOT NULL
	           GROUP BY status ORDER BY status_total DESC LIMIT 15`,
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

      case 'venture_metrics': {
        const rows = await this.queryRows<any>(
          `SELECT
             coalesce(sum(total_amount), 0) AS total_revenue,
             coalesce(sumIf(total_amount, lowerUTF8(status) NOT IN ('paid','closed')), 0) AS open_ar,
             coalesce(sumIf(abs(total_amount), total_amount < 0), 0) AS total_outflow,
             count(DISTINCT toStartOfMonth(issued_at)) AS active_months
	           FROM ${this.analyticsDb}.fact_accounting_invoices
	           WHERE org_id IN ({externalOrgIds:Array(String)})
	             ${provider}
	             ${client}
	             ${entity}
	             ${time}`,
          {
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
             WHERE org_id IN ({externalOrgIds:Array(String)})
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
             WHERE org_id IN ({externalOrgIds:Array(String)})
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
	             WHERE org_id IN ({externalOrgIds:Array(String)})
	               ${provider}
	               ${client}
	               ${entity}
	               ${time}
	               ${arFilter}
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
	           FROM ${this.analyticsDb}.v_dim_clients_latest
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
               any(provider) AS billing_provider,
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
Org IDs in scope: ${scope.externalOrgIds.slice(0, 3).join(', ')} (always use org_id IN ({externalOrgIds:Array(String)}) filter)

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
    const raw = (json.message?.content ?? '').replace(/```sql|```/gi, '').trim();

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
Org IDs in scope: ${scope.externalOrgIds.slice(0, 3).join(', ')} (always filter with org_id IN ({externalOrgIds:Array(String)}))

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
      const raw = (json.message?.content ?? '').replace(/```sql|```/gi, '').trim();
      if (!raw || !/^\s*SELECT\b/i.test(raw)) return null;
      if (/\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE)\b/i.test(raw)) return null;
      if (!/\bLIMIT\s+\d+/i.test(raw)) return null;
      if (!/{externalOrgIds\s*:\s*Array\s*\(\s*String\s*\)}/i.test(raw)) return null;

      return raw.trim().replace(/;+$/, '').trim();
    } catch (err: any) {
      this.logger.warn(`[Agent:DynamicMetricSql] LLM call failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Maps natural-language query text to a widget spec deterministically,
   * bypassing the Ollama LLM which is unreliable for structured routing.
   * Covers all 60+ canonical query patterns across 5 dashboard categories.
   */
  private preRouteQuery(query: string): Array<{ type: string; metric: string; grouping: string; title: string }> | null {
    const q = query.toLowerCase();

    // ── Chart-type signals ───────────────────────────────────────────────────
    const isStackedArea = /stacked.area/.test(q);
    const isStacked     = /stacked|clustered/.test(q);
    const isDonut       = /\bdonut\b/.test(q);
    const isWaterfall   = /\bwaterfall\b/.test(q);
    const isHBar        = /horizontal.bar|ranked.bar|ranked.horizontal/.test(q);
    const isTreemap     = /\btreemap\b/.test(q);
    const isPareto      = /\bpareto\b/.test(q);
    const isScatter     = /\bscatter\b/.test(q);
    const isBubble      = /\bbubble\b/.test(q);
    const isPie         = /\bpie\b/.test(q);
    const isTable       = /\btable\b|\bmatrix\b|\branked table\b/.test(q);
    const isLine        = /\bline\b|multi.?line/.test(q);
    const isBar         = /\bbar\b|\bcolumn\b|\bbargraph\b/.test(q);

    // ── Content signals ──────────────────────────────────────────────────────
    // NOTE: keep signals specific — broad patterns here prevent Ollama from
    // handling novel queries. Only catch unambiguous intent.
    const hasDept       = /\bdepartments?\b|\badmin\s+depart|\boperations\s+depart|\bsales\s+depart|\bby\s+department\b|\bper\s+department\b/.test(q);
    const hasTime       = /\bmonths?\b|trend|over.time|across.year|each.month|per.month|cumulat|growth/.test(q);
    const hasVendor     = /\bvendors?\b|\bsuppliers?\b/.test(q);
    const hasClass      = /\bby\s+class\b|\bclass\s+breakdown\b|\bclass\s+split\b|\bgeneral.*marketing.*product\b|\bexpense\s+class\b/.test(q);
    const hasRevenueCat = /income.source|revenue.categor|revenue.account|revenue.breakdown|revenue.split|sources.of.revenue|where.*revenue.*com/.test(q);
    const hasExpense    = /\bexpense\b|\bspend\b/.test(q);
    const hasAccountType = /account.types?|by.account.type/.test(q);
    const hasDebitCredit = /debits?.*credits?|credits?.*debits?/.test(q);
    const hasAsset      = /\bassets?\b/.test(q);
    const hasLiability  = /\bliabilit/.test(q);
    const hasEquity     = /\bequity\b|\bowner.s.equity\b|\bretained.earnings?\b/.test(q);
    const hasGrossProfit = /gross.profit/.test(q);
    const hasNetMargin  = /net.margin|margin.percent/.test(q);
    const hasExpenseRatio = /expense.ratio/.test(q);
    const hasNetPosition = /debit.*minus.*credit|debits.minus.credits|net.position|balance.trend|total.debit.*total.credit/.test(q);
    const hasPLFlow     = /revenue.*gross.profit|flows.into|revenue.*net.income/.test(q);
    const hasVsRevenue  = /versus.revenue|vs.revenue|compared.to.revenue|spend.vs.revenue|revenue.generated/.test(q);
    const hasAccount    = /\bby\s+account\b|\baccount\s+name\b|\bper\s+account\b/.test(q) && !hasAccountType;
    const hasBalanceSheet = /balance.sheet|financial.position|net.worth/.test(q);
    const hasTotalAssets = /total.assets?|assets?.total/.test(q);
    const hasTotalLiab   = /total.liabilit|liabilit.total/.test(q);
    const hasNetIncome   = /\bnet.income\b|\bnet.profit\b|\bbottom.line\b/.test(q);
    const hasTrialBalance = /trial.balance/.test(q);
    const hasGLDump      = /\bgl.dump\b|\bgeneral.ledger.dump\b|\bgl.entries\b/.test(q);

    // ═══════════════════════════════════════════════════════════════════════════
    // WATERFALL — highest priority (explicit chart type)
    // ═══════════════════════════════════════════════════════════════════════════
    if (isWaterfall)
      return [{ type: 'waterfall', metric: 'pl', grouping: 'summary', title: 'P&L Waterfall — Revenue to Net Income' }];

    // ═══════════════════════════════════════════════════════════════════════════
    // TRIAL BALANCE / GL DUMP — direct table queries
    // ═══════════════════════════════════════════════════════════════════════════
    if (hasTrialBalance)
      return [{ type: 'table', metric: 'trial_balance', grouping: 'summary', title: 'Trial Balance — All Accounts' }];
    if (hasGLDump)
      return [{ type: 'table', metric: 'gl_dump', grouping: 'detail', title: 'General Ledger — All Transactions' }];

    // ═══════════════════════════════════════════════════════════════════════════
    // BALANCE SHEET queries (total assets / liabilities / equity)
    // ═══════════════════════════════════════════════════════════════════════════
    if (hasBalanceSheet)
      return [
        { type: isDonut ? 'donut' : 'bar', metric: 'balance_sheet', grouping: 'summary', title: 'Balance Sheet — Assets, Liabilities & Equity' },
      ];
    if (hasTotalAssets)
      return [{ type: isDonut ? 'donut' : isHBar ? 'horizontal_bar' : 'bar', metric: 'assets', grouping: 'breakdown', title: 'Asset Breakdown by Account' }];
    if (hasTotalLiab)
      return [{ type: isDonut ? 'donut' : isHBar ? 'horizontal_bar' : 'bar', metric: 'liabilities', grouping: 'breakdown', title: 'Liability Breakdown by Account' }];
    if (hasEquity && !hasExpense)
      return [{ type: isDonut ? 'donut' : 'bar', metric: 'equity', grouping: 'breakdown', title: 'Equity Accounts Breakdown' }];

    // ═══════════════════════════════════════════════════════════════════════════
    // NET INCOME — from trial balance (authoritative)
    // ═══════════════════════════════════════════════════════════════════════════
    if (hasNetIncome && !hasTime)
      return [{ type: 'metric', metric: 'pl_summary', grouping: 'summary', title: 'P&L KPI Summary — Revenue, Gross Profit, Net Income' }];

    // ═══════════════════════════════════════════════════════════════════════════
    // VENDOR queries
    // ═══════════════════════════════════════════════════════════════════════════
    if (hasVendor) {
      if (isBubble)    return [{ type: 'bubble',        metric: 'vendor_transactions', grouping: 'vendor',       title: 'Vendors — Spend vs Transactions vs Avg Invoice' }];
      if (isPareto)    return [{ type: 'pareto',         metric: 'expense',             grouping: 'vendor',       title: 'Pareto — Vendor Spend Concentration' }];
      if (isTable)     return [{ type: 'table',          metric: 'expense',             grouping: 'vendor',       title: 'Vendor Spend — Ranked Table with % Contribution' }];
      if (isScatter)   return [{ type: 'scatter',        metric: 'expense',             grouping: 'vendor',       title: 'Vendor Spend vs Transaction Count' }];
      if (isTreemap)   return [{ type: 'treemap',        metric: 'expense',             grouping: 'vendor',       title: 'Vendor Contribution to Operating Expenses' }];
      if (isDonut)     return [{ type: 'donut',          metric: 'expense',             grouping: 'vendor',       title: 'Spend Share by Vendor' }];
      if (isPie)       return [{ type: 'pie',            metric: 'expense',             grouping: 'vendor',       title: 'Spend Share by Vendor' }];
      if (isStacked && hasTime) return [{ type: 'stacked_bar', metric: 'expense',       grouping: 'vendor_month', title: 'Monthly Vendor Spend — Stacked' }];
      if (isBar && hasTime)    return [{ type: 'stacked_bar', metric: 'expense',       grouping: 'vendor_month', title: 'Top Vendors — Monthly Spend (Bar)' }];
      if (hasTime || isLine)   return [{ type: 'line',        metric: 'expense',       grouping: 'vendor_month', title: 'Vendor Spend Trend Over Time' }];
      if (isHBar)      return [{ type: 'horizontal_bar', metric: 'expense',             grouping: 'vendor',       title: 'Vendor Spend Breakdown — Ranked' }];
      return           [{ type: 'bar',              metric: 'expense',             grouping: 'vendor',       title: 'Top 10 Vendors by Total Spend' }];
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DEPARTMENT queries
    // ═══════════════════════════════════════════════════════════════════════════
    if (hasDept) {
      // "scatter of expense vs revenue" → let LLM generate proper x=expense, y=revenue SQL
      if (isScatter && hasVsRevenue) return null;
      if (isScatter)   return [{ type: 'scatter',        metric: 'expense',             grouping: 'dept_stats',       title: 'Departments — Spend vs Vendors vs Transactions' }];
      if (hasVsRevenue)return [{ type: 'stacked_bar',    metric: 'revenue_vs_expense',  grouping: 'department',       title: 'Department Spend vs Revenue Generated' }];
      if (isStackedArea) return [{ type: 'area',         metric: 'expense',             grouping: 'month_department', title: 'Cumulative Departmental Spend Across the Year' }];
      if ((isStacked || isBar) && hasTime) return [{ type: 'stacked_bar', metric: 'expense', grouping: 'month_department', title: 'Monthly Spend by Department — Stacked' }];
      if ((isLine || hasTime) && !isStacked && !isBar) return [{ type: 'line', metric: 'expense', grouping: 'month_department', title: 'Monthly Spend Trends — Admin, Operations, Sales' }];
      if (isStacked)   return [{ type: 'stacked_bar',    metric: 'expense',             grouping: 'month_department', title: 'Monthly Department Spend vs Company Total' }];
      if (isDonut)     return [{ type: 'donut',          metric: 'expense',             grouping: 'department',       title: 'Spend Contribution by Department' }];
      if (isPie)       return [{ type: 'pie',            metric: 'expense',             grouping: 'department',       title: 'Department Share of Annual Operating Spend' }];
      if (hasClass)    return [{ type: 'stacked_bar',    metric: 'expense',             grouping: 'dept_class',       title: 'Department Spend by Class' }];
      if (isHBar)      return [{ type: 'horizontal_bar', metric: 'expense',             grouping: 'department',       title: 'Top Departments by Operating Cost' }];
      return           [{ type: 'bar',              metric: 'expense',             grouping: 'department',       title: 'Monthly Spend Across All Departments' }];
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CLASS queries (General / Marketing / Product)
    // ═══════════════════════════════════════════════════════════════════════════
    if (hasClass) {
      if (isStacked && hasTime) return [{ type: 'stacked_bar', metric: 'expense', grouping: 'month_class', title: 'Monthly Spend by Expense Class' }];
      if (hasTime || isLine)    return [{ type: 'line',        metric: 'expense', grouping: 'month_class', title: 'Monthly Spend Trend by Class' }];
      if (isDonut)  return [{ type: 'donut', metric: 'expense', grouping: 'class', title: 'Spend Distribution by Class' }];
      if (isPie)    return [{ type: 'pie',   metric: 'expense', grouping: 'class', title: 'Proportion of General, Marketing, Product Expenses' }];
      return        [{ type: 'bar',          metric: 'expense', grouping: 'class', title: 'Total Spend by Class' }];
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // REVENUE / INCOME queries
    // ═══════════════════════════════════════════════════════════════════════════
    if (hasRevenueCat)
      return [{ type: isHBar ? 'horizontal_bar' : 'bar', metric: 'revenue', grouping: 'account', title: 'Income Sources by Revenue Category' }];

    if (hasGrossProfit) return [{ type: 'line', metric: 'gross_profit', grouping: 'month', title: 'Monthly Gross Profit Trend' }];
    if (hasNetMargin)   return [{ type: 'line', metric: 'net_margin',   grouping: 'month', title: 'Monthly Net Margin %' }];
    if (hasExpenseRatio)return [{ type: 'line', metric: 'expense_ratio', grouping: 'month', title: 'Expense Ratio % Across the Year' }];
    if (hasNetPosition) return [{ type: 'line', metric: 'net_position', grouping: 'month', title: 'Monthly Balance — Debits Minus Credits' }];

    // ═══════════════════════════════════════════════════════════════════════════
    // ASSET / LIABILITY queries (Balance Sheet) — from sample_trial_balance
    // ═══════════════════════════════════════════════════════════════════════════
    if (hasAsset && !hasExpense)
      return [{ type: isDonut ? 'donut' : isHBar ? 'horizontal_bar' : 'bar', metric: 'assets', grouping: 'breakdown', title: 'Asset Breakdown — Bank, AR, Fixed Assets' }];

    if (hasLiability)
      return [{ type: isDonut ? 'donut' : isHBar ? 'horizontal_bar' : 'bar', metric: 'liabilities', grouping: 'breakdown', title: 'Liability Breakdown — AP, Current & Long-Term' }];

    // ═══════════════════════════════════════════════════════════════════════════
    // DEBIT / CREDIT / ACCOUNT TYPE queries
    // ═══════════════════════════════════════════════════════════════════════════
    if (hasDebitCredit || hasAccountType) {
      if (isTreemap)   return [{ type: 'treemap',     metric: 'accounts',       grouping: 'account_type', title: 'Account Type Contribution to Total Balance' }];
      if (isScatter)   return [{ type: 'scatter',     metric: 'debits_credits', grouping: 'account',      title: 'Account Activity — Debit vs Credit' }];
      if (isStacked)   return [{ type: 'stacked_bar', metric: 'debits_credits', grouping: 'month',        title: 'Monthly Debits and Credits by Account Type' }];
      if (isPie)       return [{ type: 'pie',         metric: 'debits_credits', grouping: 'account_type', title: 'Total Balance by Account Type' }];
      if (isDonut)     return [{ type: 'donut',       metric: 'debits_credits', grouping: 'account_type', title: 'Balance by Account Type' }];
      if (/top.*debit|debit.*top|debit.balanc/.test(q))  return [{ type: 'bar', metric: 'debits',  grouping: 'account_type', title: 'Top Account Types by Debit Balance' }];
      if (/top.*credit|credit.*top|credit.balanc/.test(q)) return [{ type: 'bar', metric: 'credits', grouping: 'account_type', title: 'Top Account Types by Credit Balance' }];
      return [{ type: 'bar', metric: 'debits_credits', grouping: 'account_type', title: 'Debit vs Credit Amounts by Account Type' }];
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EXPENSE / ACCOUNT NAME — only when there's an unambiguous explicit intent
    // (chart type or grouping is stated). Generic "show expenses" goes to Ollama.
    // ═══════════════════════════════════════════════════════════════════════════
    if (hasPLFlow)
      return [{ type: 'waterfall', metric: 'pl', grouping: 'summary', title: 'P&L Waterfall — Revenue to Net Income' }];

    if (hasExpense && hasAccount)
      return [{ type: isHBar ? 'horizontal_bar' : 'bar', metric: 'expense', grouping: 'account', title: 'Expense Amount by Account Name' }];

    if (hasExpense && isTreemap)
      return [{ type: 'treemap', metric: 'expense', grouping: 'account', title: 'Expense Contribution by Account Category' }];

    if (hasExpense && isHBar)
      return [{ type: 'horizontal_bar', metric: 'expense', grouping: 'account', title: 'Expense Amount by Account Name — Ranked' }];

    // Fall through to Ollama for everything else (novel queries, client questions,
    // invoice analysis, multi-entity comparisons, free-form questions, etc.)
    return null;
  }

  /**
   * Repair common ClickHouse SQL mistakes the LLM produces:
   * 1. `ORDER BY alias` where alias shadows a column name → expand to full expression
   * 2. lag()/lead() window functions → not supported, remove or simplify
   */
  private repairClickHouseSql(sql: string): string {
    let fixed = sql;

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
      (match, prefix) => `ORDER BY ${prefix}COALESCE(NULLIF(department,''),'Other')`,
    );
    fixed = fixed.replace(
      /ORDER\s+BY\s+(.*?)(?<!\()vendor_name\b(?!\s*\()/gi,
      (match, prefix) => `ORDER BY ${prefix}COALESCE(NULLIF(vendor_name,''),'Other')`,
    );
    fixed = fixed.replace(
      /ORDER\s+BY\s+(.*?)(?<!\()class_name\b(?!\s*\()/gi,
      (match, prefix) => `ORDER BY ${prefix}COALESCE(NULLIF(class_name,''),'Other')`,
    );

    // ── 3. Reject unsupported window functions ────────────────────────────────────────────────
    if (/\blag\s*\(/i.test(fixed) || /\blead\s*\(/i.test(fixed)) {
      throw new Error(
        'SQL uses lag()/lead() window functions which ClickHouse does not support in aggregate queries. Rewrite using a self-join or neighbor().',
      );
    }

    return fixed;
  }

  private validateAndScopeDynamicSql(sql: string, scope: OrgScope): string {
    let normalized = sql.trim().replace(/;+$/, '').trim();

    // Must be a SELECT
    if (!/^\s*SELECT\b/i.test(normalized)) {
      throw new Error('Dynamic SQL must start with SELECT');
    }

    // Block mutation statements
    if (/\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|REPLACE)\b/i.test(normalized)) {
      throw new Error('Dynamic SQL must not contain mutation statements');
    }

    // Block system table access
    if (/\bsystem\s*\.\s*\w+/i.test(normalized) || /\binformation_schema\b/i.test(normalized)) {
      throw new Error('Dynamic SQL must not access system tables');
    }

    // Must have LIMIT
    if (!/\bLIMIT\s+\d+/i.test(normalized)) {
      throw new Error('Dynamic SQL must include LIMIT clause');
    }

    // Must reference the org scope filter so no cross-tenant data leaks.
    if (!/{externalOrgIds\s*:\s*Array\s*\(\s*String\s*\)}/i.test(normalized)) {
      throw new Error('Dynamic SQL missing externalOrgIds scope filter');
    }

    // Auto-repair common ClickHouse incompatibilities
    normalized = this.repairClickHouseSql(normalized);

    return normalized;
  }

  private async executeDynamicSql(sql: string, scope: OrgScope): Promise<Record<string, unknown>[]> {
    try {
      let raw = String(sql ?? '').trim();
      if (!raw) return [];
      const lower = raw.toLowerCase();
      // Safety: dynamic SQL MUST be read-only and MUST be tenant-scoped.
      if (/\b(insert|update|delete|drop|alter|create|truncate|optimize|attach|detach)\b/i.test(lower)) {
        this.logger.warn('[Agent:Dynamic] Rejected non-readonly SQL.');
        return [];
      }
      // Enforce org scoping by requiring the externalOrgIds query param placeholder.
      // We generate prompts that use: org_id IN ({externalOrgIds:Array(String)}).
      if (!/\{externalorgids\s*:\s*array\s*\(\s*string\s*\)\s*\}/i.test(raw)) {
        this.logger.warn('[Agent:Dynamic] Rejected SQL missing externalOrgIds scope.');
        return [];
      }
      // Auto-repair stored SQL that may have ClickHouse incompatibilities
      try {
        raw = this.repairClickHouseSql(raw);
      } catch (repairErr: any) {
        this.logger.warn(`[Agent:Dynamic] SQL rejected by repair: ${repairErr.message}`);
        return [];
      }
      return await this.queryRows<Record<string, unknown>>(raw, {
        externalOrgIds: scope.externalOrgIds,
      });
    } catch (err: any) {
      this.logger.warn(`[Agent:Dynamic] SQL execution failed: ${err.message}`);
      return [];
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
      this.logger.debug('[GL] time-filtered query empty — retrying without date range');
    }
    return this.queryRows<T>(buildSql(''), params);
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
    if (range.kind === 'LAST_N_MONTHS') {
      const months = Math.max(1, Math.floor(range.months));
      // Use calendar-month boundaries so "last 6 months" yields 6 month buckets
      // (including the current month) when charting by month.
      return `AND ${col} >= toStartOfMonth(addMonths(now(), -${months - 1}))`;
    }
    if (range.kind === 'LAST_N_QUARTERS')
      return `AND ${col} >= toStartOfQuarter(addMonths(now(), -${(Math.max(1, Math.floor(range.quarters)) - 1) * 3}))`;
    if (range.kind === 'LAST_N_YEARS')
      return `AND ${col} >= toStartOfYear(addYears(now(), -${Math.max(1, Math.floor(range.years)) - 1}))`;

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
