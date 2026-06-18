/**
 * Domain types for the agent module. Extracted from agent.service.ts
 * (Phase 3 decomposition) so the service file leads with behavior, not
 * declarations. Pure type-level code.
 */
import type { ChartSpec } from './chart-spec';
import type { TimeRange } from './query-spec';
import type { Prisma } from '@repo/db';

export interface OrgScope {
  tenantId: string;
  connectionIds: string[];
  externalOrgIds: string[];
}

export type MembershipRole = 'ADMIN' | 'USER';

export type PivotAxis = 'month' | 'department' | 'class' | 'vendor' | 'account';

export type ChartType =
  | 'line'
  | 'bar'
  | 'pie'
  | 'donut'
  | 'metric'
  | 'kpi'
  | 'table'
  | 'area'
  | 'combo'
  | 'treemap'
  | 'scatter'
  | 'stacked_bar'
  | 'waterfall'
  | 'histogram'
  | 'horizontal_bar'
  | 'pareto'
  | 'gauge'
  | 'bubble'
  | 'heatmap'
  | 'matrix';

export interface ToolResult {
  tool: string;
  data: unknown;
  rowCount: number;
}

export interface AgentPlan {
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
      // Axis titles surfaced to the chart (what X and Y actually represent).
      xAxisLabel?: string;
      yAxisLabel?: string;
      // Presentation-only hints for the frontend (ignored by /agent/metrics).
      display?: {
        donut?: boolean;
        highlightMaxMin?: boolean;
        labelMode?: 'percent' | 'value';
      };
      display_order: number;
    }>;
  };
  analysis_focus: string;
}

// Structured outcome of the SQL-first planner: build a dashboard, ask the user
// a focused question, or honestly report that the data is not available.
export type SmartPlanResult =
  | { kind: 'build'; plan: AgentPlan }
  | { kind: 'clarify'; clarification: ClarificationPrompt }
  | { kind: 'no_data'; message: string };

export interface DashboardEditPlan {
  summary: string;
  add: Array<{
    title: string;
    description: string;
    type: ChartType;
    metric: string;
    grouping: string;
    breakdown?: 'client';
    topN?: number;
    xAxisLabel?: string;
    yAxisLabel?: string;
    // SQL-first editor: full live ClickHouse SQL for a brand-new chart.
    // When present, the widget is stored as a dynamic-SQL widget (metric='dynamic').
    dynamicSql?: string;
    display?: DisplayHints | null;
  }>;
  remove_indices: number[];
  modify: Array<{
    index: number;
    title?: string;
    type?: ChartType;
    description?: string;
    metric?: string;
    grouping?: string;
    breakdown?: 'client';
    topN?: number;
    xAxisLabel?: string;
    yAxisLabel?: string;
    // SQL-first editor: rewritten live ClickHouse SQL for an existing chart.
    // When present, the widget's stored dynamicSql is replaced so the DATA changes,
    // not just the presentation.
    dynamicSql?: string;
    // Phase 3: the new ChartSpec when the edit was a spec delta (persisted so the
    // next follow-up edits this updated spec).
    spec?: ChartSpec;
    display?: DisplayHints | null;
  }>;
  // Layer D: when a follow-up cannot be satisfied from the data (e.g. YoY with a
  // single year of data, budget variance with no budget), the editor refuses
  // clearly instead of silently keeping the previous chart.
  refusal?: string;
}

export type DeleteChartTarget =
  | { kind: 'none' }
  | { kind: 'resolved'; indices: number[]; summary: string }
  | { kind: 'ambiguous'; refusal: string };

// Render-intent hints persisted into a widget's queryConfig.display so the
// frontend can express a follow-up transform correctly (e.g. a normalized chart
// renders a % axis; a "reference/average line" renders as a flat ReferenceLine;
// moving-average series render dashed and paired to their parent series).
export interface DisplayHints {
  donut?: boolean | null;
  highlightMaxMin?: boolean | null;
  labelMode?: 'percent' | 'value' | null;
  // Values are 0–100 percentages (normalize-to-100%): format axis/labels as %.
  normalized?: boolean | null;
  // Name of the numeric column to draw as a flat reference line rather than a series.
  referenceSeries?: string | null;
  // Suffix marking moving-average columns (e.g. '_MA3') so they render dashed.
  movingAverageSuffix?: string | null;
  // Combo (dual-axis) second-measure axis formatting + label.
  secondaryAxisFormat?: 'number' | 'currency' | 'percent' | null;
  secondaryLabel?: string | null;
  // Primary value unit, so the web formats EBPO dynamic charts (metric='dynamic')
  // correctly — a percent measure must render as % not $ (Q37/Q72 fix).
  valueFormat?: 'currency' | 'number' | 'percent' | null;
  valueDecimals?: number | null;
  // Matrix / heatmap formatting hints.
  showTotals?: boolean | null;
  conditionalThreshold?: number | null;
  // Dynamic threshold: highlight cells above the column/row/overall average
  // instead of a fixed number (e.g. "highlight cells above department average").
  conditionalThresholdMode?:
    | 'columnAverage'
    | 'rowAverage'
    | 'overallAverage'
    | null;
  conditionalColor?: 'green' | null;
}

// A second measure to plot on a combo chart's secondary axis. `expr` is the
// ClickHouse aggregate over sample_gl_dump; an empty expr (invoices) means the
// measure is unavailable in this dataset and the ask must be refused.
export interface SecondMeasure {
  measure: 'spend' | 'count' | 'avg_txn' | 'credits' | 'invoices';
  alias: string;
  label: string;
  format: 'number' | 'currency' | 'percent';
  expr: string;
}

export type FollowUpTransform =
  | {
      kind:
        | 'yoy'
        | 'prior_year'
        | 'normalize'
        | 'reference_line'
        | 'variance'
        | 'growth_pct';
    }
  | { kind: 'moving_average'; window: number }
  | { kind: 'second_axis'; second: SecondMeasure };

export type UnsupportedFeature =
  | {
      reason: 'CHART_TYPE_UNSUPPORTED';
      label: string;
      alternativeLabel: string;
      alternativeValue: string;
    }
  | {
      reason: 'INTERACTIVE_FEATURE_UNSUPPORTED';
      label: string;
      alternativeLabel: string;
      alternativeValue: string;
    };

export interface ActiveDashboard {
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

export type ChartTurnMode = 'create' | 'edit';

export type ChartTurnWidgetSnapshot = {
  id?: string;
  title: string;
  chartType: string;
  queryConfig: Record<string, unknown>;
  chartConfig: Record<string, unknown>;
  displayOrder: number;
  dataSnapshot?: Array<Record<string, unknown>>;
  dataSnapshotTruncated?: boolean;
  rangeNotice?: string | null;
  requestedRangeLabel?: string | null;
  availableRange?: { start: string; end: string } | null;
};

export type ChartTurnMetadata = {
  kind: 'chart_turn';
  mode: ChartTurnMode;
  versionNumber: number;
  previousVersionNumber: number | null;
  sessionId: string;
  dashboardId: string | null;
  dashboardTitle: string;
  widgetCount: number;
  prompt: string;
  summary: string;
  widgetSnapshots: ChartTurnWidgetSnapshot[];
  intent: QueryIntent;
};

export type QueryIntent = 'CREATE_DASHBOARD' | 'EDIT_DASHBOARD';

export interface ClarificationPrompt {
  question: string;
  options: Array<{ label: string; value: string }>;
  reason: string;
}

export type ExplicitChartConstraints = {
  exactCount?: number;
  requiredTypes?: ChartType[];
};

export type ClientResolution =
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

export type EntityResolution =
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
