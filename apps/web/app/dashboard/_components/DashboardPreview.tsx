"use client";

import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Maximize2,
  X,
  TrendingDown,
  DollarSign,
  Clock,
  Zap,
  Activity,
  ArrowUpRight,
  ArrowDownRight,
  BarChart3 as BarChart3Icon,
} from "lucide-react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  ZAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
  Area,
  AreaChart,
  ReferenceLine,
  Treemap,
  ScatterChart,
  Scatter,
  ComposedChart,
  RadialBarChart,
  RadialBar,
  LabelList,
} from "recharts";
import { ApiError, type ChatMessage, type TimeRange } from "../../../lib/api";
import { useNumeriquApi } from "../../../lib/useNumeriquApi";
import { EmptyState } from "../../../components/ui/EmptyState";
import { ErrorBanner } from "../../../components/ui/ErrorBanner";
import { cn } from "../../../components/ui/cn";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface ChartConfig {
  metric: string;
  grouping: string;
  description?: string;
  timeRange?: TimeRange | null;
  providerHint?: string | null;
  clientName?: string | null;
  clientNames?: string[] | null;
  orgId?: string | null;
  orgName?: string | null;
  breakdown?: "client" | null;
  topN?: number | null;
  xAxisLabel?: string | null;
  yAxisLabel?: string | null;
  display?: {
    donut?: boolean | null;
    highlightMaxMin?: boolean | null;
    labelMode?: "percent" | "value" | null;
    // Layer D follow-up render hints.
    normalized?: boolean | null; // values are 0–100 %, format axis as %
    referenceSeries?: string | null; // column drawn as a flat reference line, not a series
    movingAverageSuffix?: string | null; // series ending in this suffix render dashed
    secondaryAxisFormat?: "number" | "currency" | "percent" | null; // combo right-axis format
    secondaryLabel?: string | null; // combo second-measure label
    showTotals?: boolean | null; // matrix/heatmap totals are rendered when true/default
    conditionalThreshold?: number | null; // matrix cells at/above this value use conditional color
    conditionalColor?: "green" | null;
  } | null;
}

interface Chart {
  id: string;
  title: string;
  description?: string | null;
  type: string;
  config: ChartConfig;
  layoutIndex?: number;
  snapshotData?: DataRow[];
}

interface Dashboard {
  id: string;
  title: string;
  description?: string | null;
  charts: Chart[];
}

interface VentureData {
  burnRate?: number;
  runwayMonths?: number;
  cashOnHand?: number;
  efficiencyMultiplier?: number;
}

type DataRow = Record<string, number | string>;

type ChartTurnMode = "create" | "edit";

type ChartTurnWidgetSnapshot = {
  title?: string;
  chartType?: string;
  queryConfig?: Record<string, unknown>;
  chartConfig?: Record<string, unknown>;
  displayOrder?: number;
  dataSnapshot?: Array<Record<string, unknown>>;
  dataSnapshotTruncated?: boolean;
};

type ChartTurnMetadata = {
  kind?: string;
  mode?: ChartTurnMode;
  versionNumber?: number;
  previousVersionNumber?: number | null;
  dashboardId?: string | null;
  dashboardTitle?: string;
  widgetCount?: number;
  prompt?: string;
  summary?: string;
  widgetSnapshots?: ChartTurnWidgetSnapshot[];
  intent?: "CREATE_DASHBOARD" | "EDIT_DASHBOARD" | null;
};

type ChartVersionSnapshot = {
  versionNumber: number;
  mode: ChartTurnMode;
  previousVersionNumber: number | null;
  dashboardTitle: string;
  summary: string;
  charts: Chart[];
};

// ─── Constants ────────────────────────────────────────────────────────────────

// Single source of truth for categorical chart colours. A 12-hue, perceptually
// balanced palette harmonised around the brand violet/blue — used by EVERY chart
// type (pie, donut, scatter, bubble, heatmap, multi-series bars) so colours stay
// consistent across the dashboard and only repeat past 12 distinct categories.
const PIE_COLORS = [
  "#7c3aed", // violet (brand)
  "#3b82f6", // blue
  "#06b6d4", // cyan
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ef4444", // red
  "#ec4899", // pink
  "#8b5cf6", // purple
  "#14b8a6", // teal
  "#f97316", // orange
  "#6366f1", // indigo
  "#84cc16", // lime
];

// ─── Series Key Inference ─────────────────────────────────────────────────────

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function hasFiniteValueKey(rows: DataRow[], key: string): boolean {
  return rows.some((row) => toFiniteNumber((row as any)?.[key]) !== null);
}

function inferNumericSeriesKeys(rows: DataRow[]): string[] {
  const totals = new Map<string, number>();

  for (const row of rows) {
    if (!row) continue;
    for (const [k, raw] of Object.entries(row)) {
      if (k === "name" || k === "value") continue;
      const n = toFiniteNumber(raw);
      if (n === null) continue;
      totals.set(k, (totals.get(k) ?? 0) + Math.abs(n));
    }
  }

  return Array.from(totals.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k]) => k);
}

function toSeriesKey(value: unknown): string {
  return String(value ?? "series")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "series";
}

function pivotLongSeriesRows(rows: DataRow[]): DataRow[] {
  if (!rows.length) return rows;
  const canPivot = rows.every(
    (row) =>
      typeof (row as any).name === "string" &&
      typeof (row as any).series === "string" &&
      toFiniteNumber((row as any).value) !== null,
  );
  if (!canPivot) return rows;

  const byName = new Map<string, DataRow>();
  for (const row of rows) {
    const name = String((row as any).name);
    const seriesKey = toSeriesKey((row as any).series);
    const value = toFiniteNumber((row as any).value) ?? 0;
    const current = byName.get(name) ?? { name };
    current[seriesKey] = (Number((current as any)[seriesKey]) || 0) + value;
    byName.set(name, current);
  }

  return Array.from(byName.values());
}

function isChartTurnMetadata(metadata: unknown): metadata is ChartTurnMetadata {
  return !!metadata && typeof metadata === "object" && (metadata as ChartTurnMetadata).kind === "chart_turn";
}

function buildChartVersionHistory(messages: ChatMessage[]): ChartVersionSnapshot[] {
  const versions: ChartVersionSnapshot[] = [];

  for (const message of messages) {
    if (message.role !== "assistant" || !isChartTurnMetadata(message.metadata)) continue;

    const metadata = message.metadata;
    const versionNumber = Number(metadata.versionNumber ?? 0);
    if (!Number.isFinite(versionNumber) || versionNumber < 1) continue;

    const charts: Chart[] = [];
    for (const [widgetIndex, widget] of (metadata.widgetSnapshots ?? []).entries()) {
      const title = String(widget.title ?? `Chart ${widgetIndex + 1}`).trim();
      if (!title) continue;

      const queryConfig = widget.queryConfig ?? {};
      const chartConfigSource = widget.chartConfig ?? {};
      const displayFromQuery = queryConfig.display as ChartConfig["display"];
      const displayFromChart = chartConfigSource.display as ChartConfig["display"];
      const chartConfig = {
        ...(queryConfig as Record<string, unknown>),
        ...(typeof chartConfigSource.description === "string"
          ? { description: chartConfigSource.description }
          : {}),
        display: displayFromQuery ?? displayFromChart ?? null,
      } as unknown as ChartConfig;
      const chartDescription =
        typeof chartConfigSource.description === "string"
          ? chartConfigSource.description
          : metadata.summary ?? "";

      charts.push({
        id: `chart-version-${versionNumber}-${widget.displayOrder ?? widgetIndex}-${title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")}`,
        title,
        description: chartDescription,
        type: String(widget.chartType ?? "bar").trim(),
        config: chartConfig,
        layoutIndex: widget.displayOrder ?? widgetIndex,
        snapshotData: Array.isArray(widget.dataSnapshot)
          ? (widget.dataSnapshot as DataRow[])
          : undefined,
      });
    }

    if (charts.length === 0) continue;

    versions.push({
      versionNumber,
      mode: metadata.mode ?? "create",
      previousVersionNumber: metadata.previousVersionNumber ?? null,
      dashboardTitle: metadata.dashboardTitle ?? "Dashboard",
      summary: metadata.summary ?? "Chart version",
      charts,
    });
  }

  return versions.sort((a, b) => a.versionNumber - b.versionNumber);
}

function mergeChartVersionHistories(
  sessionHistory: ChartVersionSnapshot[],
  liveHistory: ChartVersionSnapshot[],
): ChartVersionSnapshot[] {
  const merged = new Map<number, ChartVersionSnapshot>();

  for (const version of sessionHistory) {
    merged.set(version.versionNumber, version);
  }

  for (const version of liveHistory) {
    merged.set(version.versionNumber, version);
  }

  return Array.from(merged.values()).sort((a, b) => a.versionNumber - b.versionNumber);
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function prettyChartType(type: string): string {
  const t = String(type || "").toLowerCase();
  if (t === "bar") return "Bar chart";
  if (t === "stacked_bar") return "Stacked bar";
  if (t === "horizontal_bar") return "Ranked bar";
  if (t === "line") return "Line chart";
  if (t === "combo") return "Combo chart";
  if (t === "pie") return "Pie chart";
  if (t === "donut") return "Donut chart";
  if (t === "area") return "Area chart";
  if (t === "waterfall") return "Waterfall";
  if (t === "treemap") return "Treemap";
  if (t === "scatter") return "Scatter plot";
  if (t === "histogram") return "Histogram";
  if (t === "pareto") return "Pareto chart";
  if (t === "gauge") return "Gauge";
  if (t === "bubble") return "Bubble chart";
  if (t === "heatmap") return "Heatmap";
  if (t === "matrix") return "Matrix";
  if (t === "kpi") return "KPI cards";
  if (t === "metric") return "Metric";
  if (t === "table") return "Table";
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "Chart";
}

function fmtCurrency(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function fmtNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(0);
}

function fmtPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatValue(metric: string, grouping: string, value: number): string {
  const metricKey = String(metric ?? "").toLowerCase();
  const isPercent =
    metric === "collection_rate" ||
    metric === "overdue_rate" ||
    metric === "mom_growth" ||
    metric === "top5_revenue_share" ||
    metric === "collected_vs_outstanding" ||
    /\b(pct|percent|percentage|share|ratio|rate)\b/.test(metricKey);
  if (isPercent) return fmtPercent(value);

  if (metric === "dso") return `${value.toFixed(1)}d`;

  const isCurrencyMetric =
    metric === "revenue" ||
    metric === "revenue_cumulative" ||
    metric === "outstanding" ||
    metric === "overdue" ||
    metric === "paid" ||
    metric === "total_invoiced" ||
    metric === "avg_invoice" ||
    metric === "expense" ||
    metric === "opex" ||
    metric === "cogs" ||
    metric === "gross_profit" ||
    metric === "net_income" ||
    metric === "ebitda" ||
    metric === "revenue_vs_expense" ||
    metric === "net_position" ||
    metric === "running_balance" ||
    metric === "transaction_value" ||
    metric === "invoice_value" ||
    (metric === "invoice_amount" && grouping === "time") ||
    metric === "debits_credits" ||
    (metric === "invoices" && grouping === "status") ||
    /\b(spend|expense|revenue|income|cost|profit|margin|balance|cash|asset|liabil|equity|payable|receivable|debit|credit|amount|value)\b/.test(
      metricKey,
    );

  if (isCurrencyMetric) return fmtCurrency(value);
  return fmtNumber(value);
}

// ─── Custom Tooltip ───────────────────────────────────────────────────────────

const CustomTooltip = ({ active, payload, label, metric, grouping, valueFormatter }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-default bg-bg-card/95 p-3 shadow-2xl backdrop-blur-sm">
      {label && (
        <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-text-muted">
          {label}
        </p>
      )}
      {payload.map((entry: any, i: number) => (
        <div key={i} className="flex items-center gap-2">
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: entry.color || entry.fill }}
          />
          <span className="text-xs font-semibold text-text-primary">
            {typeof entry.value === "number"
              ? typeof valueFormatter === "function"
                ? valueFormatter(entry.value, entry)
                : formatValue(String(metric ?? ""), String(grouping ?? ""), entry.value)
              : entry.value}
          </span>
          {entry.name && entry.name !== "value" && (
            <span className="text-[10px] text-text-muted">({entry.name})</span>
          )}
        </div>
      ))}
    </div>
  );
};

const PieTooltip = ({ active, payload, metric, grouping, labelMode }: any) => {
  if (!active || !payload?.length) return null;
  const entry = payload[0];
  const total = entry?.payload?.total;
  const pct = total ? ((entry.value / total) * 100).toFixed(1) : null;
  return (
    <div className="rounded-xl border border-default bg-bg-card/95 p-3 shadow-2xl backdrop-blur-sm">
      <p className="text-xs font-bold text-text-primary">{entry.name}</p>
      <p className="text-xs text-text-secondary">
        {typeof entry.value === "number"
          ? formatValue(String(metric ?? ""), String(grouping ?? ""), entry.value)
          : entry.value}
        {pct && labelMode !== "value" ? ` · ${pct}%` : ""}
      </p>
    </div>
  );
};

// ─── Per-Chart Insight Bar ────────────────────────────────────────────────────

function ChartInsight({ type, data }: { type: string; data: DataRow[] }) {
  if (data.length === 0) return null;

  if (type === "line") {
    const first = Number(data[0]?.value) || 0;
    const last = Number(data[data.length - 1]?.value) || 0;
    if (first === 0 || data.length < 2) return null;
    const pct = ((last - first) / first) * 100;
    const up = pct >= 0;
    return (
      <div
        className={cn(
          "flex items-center gap-1.5 text-[10px] font-semibold",
          up ? "text-feedback-success" : "text-feedback-danger",
        )}
      >
        {up ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}
        <span>
          {Math.abs(pct).toFixed(1)}% {up ? "growth" : "decline"} over period
        </span>
      </div>
    );
  }

  if (type === "bar") {
    // Support both single-series (d.value) and multi-series pivot charts
    const seriesKey = hasFiniteValueKey(data, "value")
      ? "value"
      : (inferNumericSeriesKeys(data)[0] ?? "value");
    const vals = data.map((d) => Number((d as any)[seriesKey]) || 0);
    const max = Math.max(...vals);
    const maxEntry = data.find((d) => Number((d as any)[seriesKey]) === max);
    if (!maxEntry || max === 0) return null;
    const name = String(maxEntry.name ?? "").slice(0, 20);
    return (
      <div className="flex min-w-0 items-center gap-1 text-[10px] text-text-muted">
        <BarChart3Icon size={9} className="shrink-0" />
        <span className="truncate">
          Top: <span className="font-semibold text-text-secondary">{name}</span> · {fmtCurrency(max)}
        </span>
      </div>
    );
  }

  if (type === "pie") {
    const total = data.reduce((s, d) => s + (Number(d.value) || 0), 0);
    if (total === 0 || data.length === 0) return null;
    const maxEntry = data.reduce(
      (a, b) => (Number(a.value) >= Number(b.value) ? a : b),
      data[0]!,
    );
    const pct = ((Number(maxEntry.value) / total) * 100).toFixed(0);
    const name = String(maxEntry.name ?? "").slice(0, 20);
    return (
      <div className="flex min-w-0 items-center gap-1 text-[10px] text-text-muted">
        <span className="truncate">
          <span className="font-semibold text-text-secondary">{name}</span> leads at {pct}%
        </span>
      </div>
    );
  }

  return null;
}

// ─── Metric Card ─────────────────────────────────────────────────────────────

function VentureMetricCard({ data }: { data: VentureData }) {
  const metrics = [
    {
      label: "Monthly Burn",
      value: fmtCurrency(data.burnRate ?? 0),
      sub: "per month",
      icon: TrendingDown,
      color: "text-feedback-danger",
      bg: "bg-feedback-danger/8",
      ring: "ring-feedback-danger/15",
    },
    {
      label: "Runway",
      value: `${data.runwayMonths ?? 0}mo`,
      sub:
        (data.runwayMonths ?? 0) < 6
          ? "⚠ critical"
          : (data.runwayMonths ?? 0) < 12
            ? "watch closely"
            : "✓ healthy",
      icon: Clock,
      color:
        (data.runwayMonths ?? 0) < 6
          ? "text-feedback-danger"
          : (data.runwayMonths ?? 0) < 12
            ? "text-feedback-warning"
            : "text-feedback-success",
      bg:
        (data.runwayMonths ?? 0) < 12 ? "bg-feedback-warning/8" : "bg-feedback-success/8",
      ring:
        (data.runwayMonths ?? 0) < 12
          ? "ring-feedback-warning/15"
          : "ring-feedback-success/15",
    },
    {
      label: "Cash on Hand",
      value: fmtCurrency(data.cashOnHand ?? 0),
      sub: "available",
      icon: DollarSign,
      color: "text-accent-cyan",
      bg: "bg-accent-cyan/8",
      ring: "ring-accent-cyan/15",
    },
      {
        label: "Efficiency",
        value: `${data.efficiencyMultiplier ?? 0}x`,
        sub: "cash flow / burn",
        icon: Zap,
        color:
        (data.efficiencyMultiplier ?? 0) >= 1.5
          ? "text-feedback-success"
          : "text-feedback-warning",
      bg: "bg-accent-violet/8",
      ring: "ring-accent-violet/15",
    },
  ];

  return (
    <div className="grid w-full grid-cols-2 gap-3 sm:grid-cols-4">
      {metrics.map((m, i) => (
        <motion.div
          key={m.label}
          initial={{ opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: i * 0.08 }}
          className={cn(
            "flex flex-col gap-2 rounded-2xl p-3 ring-1",
            m.bg,
            m.ring,
          )}
        >
          <div className="flex items-center justify-between gap-1">
            <span className="text-[9px] font-bold uppercase tracking-wider text-text-muted leading-tight">
              {m.label}
            </span>
            <m.icon size={12} className={cn("shrink-0", m.color)} />
          </div>
          <div>
            <p className={cn("text-xl font-black tracking-tight leading-none", m.color)}>{m.value}</p>
            <p className="mt-1 text-[9px] text-text-muted">{m.sub}</p>
          </div>
        </motion.div>
      ))}
    </div>
  );
}

// ─── Chart Renderer ───────────────────────────────────────────────────────────

// Isolates a single chart's render. A malformed row or an unexpected data shape
// throws inside Recharts; without this, one bad chart would blank the entire
// dashboard. Here it degrades to a friendly inline message and the rest render.
class ChartErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: unknown) {
    // eslint-disable-next-line no-console
    console.error("[ChartErrorBoundary] chart failed to render:", error);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full min-h-[160px] items-center justify-center rounded-xl bg-bg-elevated/30">
          <p className="px-4 text-center text-xs text-text-muted">
            This chart couldn&apos;t be displayed. The data may be in an
            unexpected shape — try regenerating or rephrasing it.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

function renderChart(chart: Chart, data: DataRow[], isExpanded: boolean) {
  const h = isExpanded ? 480 : 240;

  if (chart.type === "metric") {
    if (chart.config.metric === "venture") {
      const raw = data[0] as VentureData | undefined;
      return (
        <div className="flex w-full items-center justify-center py-2">
          <VentureMetricCard data={raw ?? {}} />
        </div>
      );
    }

    const first = data[0] ?? {};
    const rawValue = (first as any)?.value;
    const numeric = typeof rawValue === "number" ? rawValue : Number(rawValue ?? 0);
    const label = chart.title || "Metric";
    const secondary =
      typeof (first as any)?.outstandingPct === "number"
        ? `${Number((first as any).outstandingPct).toFixed(1)}% outstanding`
        : null;

    return (
      <div className="flex h-full w-full items-center justify-center">
        <div className="flex w-full max-w-md flex-col items-center justify-center gap-2 rounded-2xl border border-default bg-bg-elevated/30 p-6 text-center">
          <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-text-muted">
            {label}
          </p>
          <p className="text-4xl font-black tracking-tight text-text-primary">
            {formatValue(chart.config.metric, chart.config.grouping, Number.isFinite(numeric) ? numeric : 0)}
          </p>
          {secondary && <p className="text-xs text-text-muted">{secondary}</p>}
        </div>
      </div>
    );
  }

  const tickStyle = {
    fill: "rgb(var(--color-text-muted))",
    fontSize: isExpanded ? 12 : 10,
  };
  const gridStyle = {
    strokeDasharray: "3 3",
    stroke: "rgb(var(--color-text-muted) / 0.12)",
  };

  // ── Layer D follow-up render hints ──────────────────────────────────────
  const dispNormalized = Boolean(chart.config.display?.normalized);
  const refSeriesKey = chart.config.display?.referenceSeries ?? null;
  const maSuffix = chart.config.display?.movingAverageSuffix ?? null;
  const pctTick = (v: number) => fmtPercent(Number(v) || 0);
  const yTick = (v: number) =>
    dispNormalized
      ? pctTick(v)
      : formatValue(chart.config.metric, chart.config.grouping, Number(v) || 0);
  // Constant value of the reference column (it's the same on every row).
  const refValue =
    refSeriesKey && data.length > 0 ? Number((data[0] as any)[refSeriesKey]) : null;
  // Color a moving-average series to match its parent series.
  const colorAt = (i: number): string =>
    PIE_COLORS[((i % PIE_COLORS.length) + PIE_COLORS.length) % PIE_COLORS.length] ?? PIE_COLORS[0]!;
  const seriesColor = (key: string, keys: string[], idx: number): string => {
    if (maSuffix && key.endsWith(maSuffix)) {
      const parent = key.slice(0, -maSuffix.length);
      const pIdx = keys.indexOf(parent);
      if (pIdx >= 0) return colorAt(pIdx);
    }
    return colorAt(idx);
  };

  if (chart.type === "line" || chart.type === "area") {
    const allKeys = inferNumericSeriesKeys(data);
    const hasValueSeries = hasFiniteValueKey(data, "value");
    // Reference column is drawn as a flat ReferenceLine, not a plotted series.
    const seriesKeys = allKeys.filter((k) => k !== refSeriesKey);
    const isMultiSeries = !hasValueSeries && seriesKeys.length > 0;

    const vals = isMultiSeries
      ? []
      : data.map((d) => Number((d as any).value) || 0);
    const avg = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;

    return (
      <div style={{ height: h, width: "100%" }}>
        <ResponsiveContainer width="100%" height="100%">
	          <AreaChart data={data} margin={{ top: 8, right: 4, left: 12, bottom: 0 }}>
            <defs>
              <linearGradient id={`grad-line-${chart.id}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="rgb(var(--color-accent-violet))" stopOpacity={0.3} />
                <stop offset="95%" stopColor="rgb(var(--color-accent-violet))" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid {...gridStyle} />
            <XAxis
              dataKey="name"
              tick={tickStyle}
              tickLine={false}
              axisLine={false}
              minTickGap={14}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={tickStyle}
              tickLine={false}
              axisLine={false}
              tickFormatter={yTick}
              width={56}
              tickMargin={8}
            />
            <Tooltip
              content={
                <CustomTooltip
                  metric={chart.config.metric}
                  grouping={chart.config.grouping}
                  valueFormatter={(value: number) => yTick(Number(value) || 0)}
                />
              }
            />
            {refSeriesKey && refValue != null && Number.isFinite(refValue) && (
              <ReferenceLine
                y={refValue}
                stroke="rgb(var(--color-accent-cyan))"
                strokeDasharray="6 3"
                strokeWidth={1.6}
                label={{
                  value: refSeriesKey.replace(/_/g, " "),
                  position: "insideTopRight",
                  fill: "rgb(var(--color-accent-cyan))",
                  fontSize: 10,
                }}
              />
            )}
            {!isMultiSeries && isExpanded && avg > 0 && refValue == null && (
              <ReferenceLine
                y={avg}
                stroke="rgb(var(--color-accent-cyan))"
                strokeDasharray="4 4"
                strokeWidth={1.5}
                label={{
                  value: "avg",
                  position: "insideTopRight",
                  fill: "rgb(var(--color-text-muted))",
                  fontSize: 10,
                }}
              />
            )}
	            {isMultiSeries ? (
              <>
                {seriesKeys.slice(0, isExpanded ? 12 : 8).map((k, idx) => {
                  const isMa = Boolean(maSuffix && k.endsWith(maSuffix));
                  const color = seriesColor(k, seriesKeys, idx);
                  return (
                    <Area
                      key={k}
                      type="monotone"
                      dataKey={k}
                      name={k.replace(/_/g, " ")}
                      stroke={color}
                      strokeWidth={isExpanded ? 2.3 : 2}
                      strokeDasharray={isMa ? "5 3" : undefined}
                      fill={color}
                      fillOpacity={isMa ? 0 : chart.type === "area" ? 0.18 : 0.08}
                      dot={false}
                      activeDot={{
                        r: 5,
                        fill: color,
                        strokeWidth: 2,
                        stroke: "rgb(var(--color-bg-card))",
                      }}
                    >
                      {!isMa && data.length <= 12 && seriesKeys.length <= 4 && (
                        <LabelList
                          dataKey={k}
                          position="top"
                          offset={8}
                          style={{
                            fill: "rgb(var(--color-text-secondary))",
                            fontSize: isExpanded ? 10 : 9,
                            fontWeight: 600,
                          }}
                          formatter={(v: unknown) => yTick(Number(v) || 0)}
                        />
                      )}
                    </Area>
                  );
                })}
                <Legend
                  verticalAlign="bottom"
                  height={28}
                  iconType="circle"
                  iconSize={8}
                  wrapperStyle={{ fontSize: isExpanded ? 11 : 10, fontWeight: 600, paddingTop: 4 }}
                  formatter={(value: string) => (
                    <span style={{ color: "rgb(var(--color-text-secondary))" }}>
                      {String(value).replace(/_/g, " ")}
                    </span>
                  )}
                />
              </>
	            ) : (
	              <Area
	                type="monotone"
	                dataKey="value"
	                stroke="rgb(var(--color-accent-violet))"
                strokeWidth={isExpanded ? 2.5 : 2}
                fill={`url(#grad-line-${chart.id})`}
                dot={
                  isExpanded
                    ? { r: 4, fill: "rgb(var(--color-accent-violet))", strokeWidth: 0 }
                    : false
                }
                activeDot={{
                  r: 5,
                  fill: "rgb(var(--color-accent-violet))",
                  strokeWidth: 2,
                  stroke: "rgb(var(--color-bg-card))",
                }}
	              >
	                {data.length <= 12 && (
	                  <LabelList dataKey="value" position="top" offset={8}
	                    style={{ fill: "rgb(var(--color-text-secondary))", fontSize: isExpanded ? 10 : 9, fontWeight: 600 }}
	                    formatter={(v: unknown) => yTick(Number(v) || 0)} />
	                )}
	              </Area>
	            )}
	          </AreaChart>
	        </ResponsiveContainer>
	      </div>
	    );
	  }

	  if (chart.type === "waterfall") {
	    const rows = data.map((d) => ({
	      name: String((d as any).name ?? ""),
	      value: Number((d as any).value) || 0,
	    }));
	    let running = 0;
	    const wf = rows.map((r) => {
	      const start = running;
	      const end = running + r.value;
	      const base = Math.min(start, end);
	      const delta = Math.abs(r.value);
	      running = end;
	      return { name: r.name, base, delta, _pos: r.value >= 0 };
	    });

	    return (
	      <div style={{ height: h, width: "100%" }}>
	        <ResponsiveContainer width="100%" height="100%">
	          <BarChart data={wf} margin={{ top: 8, right: 4, left: 12, bottom: 0 }}>
	            <CartesianGrid {...gridStyle} vertical={false} />
	            <XAxis dataKey="name" tick={tickStyle} tickLine={false} axisLine={false} interval={0} />
	            <YAxis
	              tick={tickStyle}
	              tickLine={false}
	              axisLine={false}
	              tickFormatter={(v: number) =>
	                formatValue(chart.config.metric, chart.config.grouping, Number(v) || 0)
	              }
	              width={56}
	              tickMargin={8}
	            />
	            <Tooltip content={<CustomTooltip metric={chart.config.metric} grouping={chart.config.grouping} />} />
	            <Bar dataKey="base" stackId="wf" fill="transparent" />
	            <Bar
	              dataKey="delta"
	              stackId="wf"
	              radius={[6, 6, 0, 0]}
	              maxBarSize={56}
	              // eslint-disable-next-line react/no-unstable-nested-components
	              fillOpacity={1}
	            >
	              {wf.map((entry, idx) => (
	                <Cell
	                  key={idx}
	                  fill={entry._pos ? "#10b981" : "#ef4444"}
	                  stroke="none"
	                />
	              ))}
	            </Bar>
	          </BarChart>
	        </ResponsiveContainer>
	      </div>
	    );
		  }

  if (chart.type === "combo") {
    const lineKeys = inferNumericSeriesKeys(data);
    const lineKey = lineKeys[0] ?? null;
    const secFmt = chart.config.display?.secondaryAxisFormat ?? "percent";
    const secTick = (v: number) =>
      secFmt === "currency"
        ? fmtCurrency(Number(v) || 0)
        : secFmt === "number"
          ? fmtNumber(Number(v) || 0)
          : `${(Number(v) || 0).toFixed(1)}%`;

    return (
      <div style={{ height: h, width: "100%" }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 12, left: 12, bottom: 0 }}>
            <defs>
              <linearGradient id={`grad-bar-${chart.id}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgb(var(--color-accent-blue))" stopOpacity={1} />
                <stop offset="100%" stopColor="rgb(var(--color-accent-violet))" stopOpacity={0.8} />
              </linearGradient>
            </defs>
            <CartesianGrid {...gridStyle} vertical={false} />
            <XAxis
              dataKey="name"
              tick={tickStyle}
              tickLine={false}
              axisLine={false}
              minTickGap={14}
              interval="preserveStartEnd"
            />
            <YAxis
              yAxisId="left"
              tick={tickStyle}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) =>
                formatValue(chart.config.metric, chart.config.grouping, Number(v) || 0)
              }
              width={56}
              tickMargin={8}
            />
            {lineKey && (
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={tickStyle}
                tickLine={false}
                axisLine={false}
                tickFormatter={secTick}
                width={44}
                tickMargin={8}
              />
            )}
            <Tooltip
              content={
                <CustomTooltip
                  metric={chart.config.metric}
                  grouping={chart.config.grouping}
                  valueFormatter={(value: number, entry: any) =>
                    entry?.dataKey === "value"
                      ? formatValue(chart.config.metric, chart.config.grouping, Number(value) || 0)
                      : secTick(Number(value) || 0)
                  }
                />
              }
            />
            <Bar
              yAxisId="left"
              dataKey="value"
              name="value"
              fill={`url(#grad-bar-${chart.id})`}
              radius={[6, 6, 0, 0]}
              maxBarSize={56}
            />
            {lineKey && (
              <Line
                yAxisId="right"
                type="monotone"
                dataKey={lineKey}
                name={lineKey.replace(/_/g, " ")}
                stroke="rgb(var(--color-accent-cyan))"
                strokeWidth={isExpanded ? 2.5 : 2}
                dot={isExpanded ? { r: 4, fill: "rgb(var(--color-accent-cyan))", strokeWidth: 0 } : false}
                activeDot={{
                  r: 5,
                  fill: "rgb(var(--color-accent-cyan))",
                  strokeWidth: 2,
                  stroke: "rgb(var(--color-bg-card))",
                }}
              />
            )}
            <Legend
              verticalAlign="bottom"
              height={28}
              iconType="circle"
              iconSize={8}
              wrapperStyle={{ fontSize: isExpanded ? 11 : 10, fontWeight: 600, paddingTop: 4 }}
              formatter={(value: string) => (
                <span style={{ color: "rgb(var(--color-text-secondary))" }}>
                  {String(value).replace(/_/g, " ")}
                </span>
              )}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    );
  }

	  if (chart.type === "bar" || chart.type === "stacked_bar") {
    const barData = chart.type === "stacked_bar" ? pivotLongSeriesRows(data) : data;
    // Detect multi-series FIRST (pivot data with one column per entity, no "value" key)
    const rawSeriesKeys = inferNumericSeriesKeys(barData);
    const rawHasValueSeries = hasFiniteValueKey(barData, "value");
    const isActuallyMultiSeries = !rawHasValueSeries && rawSeriesKeys.length >= 1;

    // Only use horizontal bars for single-series client ranking (NOT for multi-series pivots)
    const isClientGrouping = chart.config.grouping === "client";
    const useHorizontalBars = isClientGrouping && !isActuallyMultiSeries && data.length > 6;

    const trimmed = useHorizontalBars
      ? barData.slice(0, isExpanded ? 15 : 8)
      : barData;

    const seriesKeys = (
      isActuallyMultiSeries ? rawSeriesKeys : inferNumericSeriesKeys(trimmed)
    ).filter((k) => k !== refSeriesKey);
    const hasValueSeries = isActuallyMultiSeries ? false : hasFiniteValueKey(trimmed, "value");
    const barRefValue =
      refSeriesKey && trimmed.length > 0 ? Number((trimmed[0] as any)[refSeriesKey]) : null;
    // Time-series bars (months) keep one color; categorical bars get per-category colors.
    const barLooksTimeSeries =
      trimmed.length > 0 &&
      trimmed.filter((d: any) =>
        /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b|\b(19|20)\d{2}\b|^\d{4}-\d{2}/i.test(
          String((d as any).name ?? ""),
        ),
      ).length >= trimmed.length / 2;
	    const isMultiSeries = !useHorizontalBars && isActuallyMultiSeries;
	    const highlightMaxMin = Boolean(chart.config.display?.highlightMaxMin) && !isMultiSeries;
	    const highlight = (() => {
	      if (!highlightMaxMin) return null;
	      const vals = trimmed.map((d) => Number((d as any).value) || 0);
	      if (vals.length < 2) return null;
	      const max = Math.max(...vals);
	      const min = Math.min(...vals);
	      if (!Number.isFinite(max) || !Number.isFinite(min) || max === min) return null;
	      return { max, min };
	    })();

    const needsRotatedLabels = !useHorizontalBars && trimmed.length > 5;
    const isStackedBarChart = chart.type === "stacked_bar" && isMultiSeries;
    const displayKeys = isMultiSeries ? seriesKeys.slice(0, 8) : [];
    const chartData = isStackedBarChart
      ? trimmed.map((row) => ({
          ...(row as any),
          _total: displayKeys.reduce((s, k) => s + (Number((row as any)[k]) || 0), 0),
        }))
      : trimmed;

    const barHeight = useHorizontalBars
      ? Math.max(h, trimmed.length * (isExpanded ? 30 : 26) + 32)
      : needsRotatedLabels ? h + 60 : h;

    const barMargin = useHorizontalBars
      ? { top: 6, right: 10, left: 8, bottom: 6 }
      : needsRotatedLabels
        ? { top: 8, right: 4, left: 12, bottom: 90 }
        : isStackedBarChart
          ? { top: 20, right: 4, left: 12, bottom: 0 }
          : { top: 8, right: 4, left: 12, bottom: 0 };

    return (
      <div style={{ height: barHeight, width: "100%" }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={barMargin} layout={useHorizontalBars ? "vertical" : "horizontal"}>
            <defs>
              <linearGradient id={`grad-bar-${chart.id}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgb(var(--color-accent-blue))" stopOpacity={1} />
                <stop
                  offset="100%"
                  stopColor="rgb(var(--color-accent-violet))"
                  stopOpacity={0.8}
                />
              </linearGradient>
            </defs>
            <CartesianGrid {...gridStyle} vertical={false} />
            {useHorizontalBars ? (
              <>
                <XAxis
                  type="number"
                  tick={tickStyle}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) =>
                    formatValue(chart.config.metric, chart.config.grouping, Number(v) || 0)
                  }
                  tickMargin={8}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  tick={tickStyle}
                  tickLine={false}
                  axisLine={false}
                  width={isExpanded ? 200 : 160}
                  tickMargin={10}
                  interval={0}
                  tickFormatter={(v: string) => {
                    const label = String(v ?? "");
                    const limit = isExpanded ? 26 : 18;
                    return label.length > limit ? label.slice(0, limit - 1) + "…" : label;
                  }}
                />
              </>
            ) : (
              <>
                <XAxis
                  dataKey="name"
                  tick={
                    needsRotatedLabels
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      ? (props: any) => {
                          const x = Number(props.x ?? 0);
                          const y = Number(props.y ?? 0);
                          const label = String(props.payload?.value ?? "");
                          const truncated = label.length > 16 ? label.slice(0, 15) + "…" : label;
                          return (
                            <g transform={`translate(${x},${y})`}>
                              <text
                                x={0}
                                y={0}
                                dy={8}
                                textAnchor="end"
                                transform="rotate(-45)"
                                style={{ ...tickStyle, fontSize: isExpanded ? 11 : 10 }}
                              >
                                {truncated}
                              </text>
                            </g>
                          );
                        }
                      : tickStyle
                  }
                  tickLine={false}
                  axisLine={false}
                  interval={needsRotatedLabels ? 0 : "preserveStartEnd"}
                />
                <YAxis
                  tick={tickStyle}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={yTick}
                  width={56}
                  tickMargin={8}
                />
              </>
            )}
            <Tooltip
              content={
                <CustomTooltip
                  metric={chart.config.metric}
                  grouping={chart.config.grouping}
                  valueFormatter={(value: number) => yTick(Number(value) || 0)}
                />
              }
            />
            {refSeriesKey && barRefValue != null && Number.isFinite(barRefValue) && !useHorizontalBars && (
              <ReferenceLine
                y={barRefValue}
                stroke="rgb(var(--color-accent-cyan))"
                strokeDasharray="6 3"
                strokeWidth={1.6}
                label={{
                  value: refSeriesKey.replace(/_/g, " "),
                  position: "insideTopRight",
                  fill: "rgb(var(--color-accent-cyan))",
                  fontSize: 10,
                }}
              />
            )}
            {isMultiSeries ? (
              <>
                {displayKeys.map((k, idx) => (
                  <Bar
                    key={k}
                    dataKey={k}
                    name={k.replace(/_/g, " ")}
                    fill={PIE_COLORS[idx % PIE_COLORS.length]}
                    radius={isStackedBarChart ? [0, 0, 0, 0] : [4, 4, 0, 0]}
                    maxBarSize={isStackedBarChart ? (isExpanded ? 48 : 36) : (isExpanded ? 20 : 16)}
                    stackId={isStackedBarChart ? "stack" : undefined}
                  >
                    {!isStackedBarChart && displayKeys.length <= 4 && chartData.length <= 12 && (
                      <LabelList
                        dataKey={k}
                        position="top"
                        offset={4}
                        style={{
                          fill: "rgb(var(--color-text-secondary))",
                          fontSize: isExpanded ? 10 : 9,
                          fontWeight: 600,
                        }}
                        formatter={(v: unknown) => yTick(Number(v) || 0)}
                      />
                    )}
                  </Bar>
                ))}
                {isStackedBarChart && (
                  <Bar dataKey="_total" stackId="stack" fill="transparent"
                    maxBarSize={isExpanded ? 48 : 36} isAnimationActive={false} legendType="none">
                    <LabelList dataKey="_total" position="top"
                      style={{ fill: "rgb(var(--color-text-muted))", fontSize: isExpanded ? 10 : 9, fontWeight: 600 }}
                      formatter={(v: unknown) => fmtCurrency(Number(v) || 0)} />
                  </Bar>
                )}
                <Legend
                  verticalAlign="bottom"
                  height={28}
                  iconType="circle"
                  iconSize={8}
                  wrapperStyle={{ fontSize: isExpanded ? 11 : 10, fontWeight: 600, paddingTop: 4 }}
                  formatter={(value: string) => (
                    <span style={{ color: "rgb(var(--color-text-secondary))" }}>
                      {String(value).replace(/_/g, " ")}
                    </span>
                  )}
                />
              </>
	            ) : (
	              <Bar
	                dataKey="value"
	                fill={highlight ? "#7c3aed" : `url(#grad-bar-${chart.id})`}
	                radius={useHorizontalBars ? [6, 6, 6, 6] : [6, 6, 0, 0]}
	                maxBarSize={useHorizontalBars ? (isExpanded ? 18 : 16) : 56}
	              >
	                {highlight
	                  ? trimmed.map((entry: any, idx: number) => {
	                      const v = Number(entry?.value) || 0;
	                      const isMax = v === highlight.max;
	                      const isMin = v === highlight.min;
		                      return (
		                        <Cell
		                          key={idx}
		                          fill={isMax ? "#10b981" : isMin ? "#ef4444" : "#7c3aed"}
		                        />
		                      );
	                    })
	                  : !barLooksTimeSeries
	                    ? trimmed.map((_: any, idx: number) => (
	                        <Cell key={idx} fill={colorAt(idx)} />
	                      ))
	                    : null}
                {(useHorizontalBars ? trimmed.length <= 15 : trimmed.length <= 12) && (
                  <LabelList
                    dataKey="value"
                    position={useHorizontalBars ? "right" : "top"}
                    offset={useHorizontalBars ? 6 : 4}
                    style={{ fill: "rgb(var(--color-text-secondary))", fontSize: isExpanded ? 10 : 9, fontWeight: 600 }}
                    formatter={(v: unknown) => formatValue(chart.config.metric, chart.config.grouping, Number(v) || 0)}
                  />
                )}
	              </Bar>
	            )}
	          </BarChart>
	        </ResponsiveContainer>
	      </div>
	    );
	  }

  if (chart.type === "treemap") {
    const seriesKeys = inferNumericSeriesKeys(data);
    const hasValueSeries = hasFiniteValueKey(data, "value");
    const nodes = !hasValueSeries && seriesKeys.length > 1
      ? data.flatMap((d) =>
          seriesKeys.map((key) => ({
            name: `${String((d as any).name ?? "")} / ${key.replace(/_/g, " ")}`,
            size: Number((d as any)[key]) || 0,
          })),
        )
      : data.map((d) => ({
          name: String((d as any).name ?? ""),
          size: Number((d as any).value) || 0,
        }))
          .filter((n) => n.name && Number.isFinite(n.size) && n.size > 0)
          .slice(0, 40);

    const TreemapCell = ({ x, y, width, height, name, size, index }: any) => {
      const color = PIE_COLORS[index % PIE_COLORS.length];
      // Lower thresholds so smaller cells (e.g. all 24 vendors) still get a label,
      // and always provide a hover tooltip so nothing is unreadable/"empty".
      const showLabel = width > 38 && height > 18;
      const showValue = width > 50 && height > 34;
      const charBudget = Math.max(3, Math.floor(width / 7));
      const label = String(name ?? "");
      return (
        <g>
          <title>{`${label}: ${fmtCurrency(size)}`}</title>
          <rect x={x} y={y} width={width} height={height} fill={color} stroke="rgb(var(--color-bg-card))" strokeWidth={2} rx={4} />
          {showLabel && (
            <>
              <text x={x + width / 2} y={y + height / 2 - (showValue ? 6 : 0)} textAnchor="middle" dominantBaseline="central"
                fill="white" fontSize={Math.min(12, Math.max(8, width / 9))} fontWeight={700}
                paintOrder="stroke" stroke="rgba(0,0,0,0.35)" strokeWidth={2}
                style={{ pointerEvents: "none" }}>
                {label.length > charBudget ? label.slice(0, charBudget - 1) + "…" : label}
              </text>
              {showValue && (
                <text x={x + width / 2} y={y + height / 2 + 10} textAnchor="middle" dominantBaseline="central"
                  fill="rgba(255,255,255,0.9)" fontSize={Math.min(10, width / 10)}
                  paintOrder="stroke" stroke="rgba(0,0,0,0.3)" strokeWidth={1.5}
                  style={{ pointerEvents: "none" }}>
                  {fmtCurrency(size)}
                </text>
              )}
            </>
          )}
        </g>
      );
    };

    return (
      <div style={{ height: h, width: "100%" }}>
        <ResponsiveContainer width="100%" height="100%">
          <Treemap
            data={nodes}
            dataKey="size"
            nameKey="name"
            stroke="rgb(var(--color-bg-card))"
            fill="rgb(var(--color-accent-violet))"
            aspectRatio={4 / 3}
            content={<TreemapCell />}
          />
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "scatter") {
    // Detect x/y keys from data: prefer explicit x/y, fall back to first two numeric keys
    const firstRow = data[0] as any;
    const hasXY = firstRow && typeof firstRow.x === "number" && typeof firstRow.y === "number";
    const numKeys = inferNumericSeriesKeys(data);
    const xKey = hasXY ? "x" : (numKeys[1] ?? numKeys[0] ?? "x");
    const yKey = hasXY ? "y" : (numKeys[0] ?? "y");
    const nameKey = firstRow && typeof firstRow.name === "string" ? "name" : undefined;

    // Rich visualization: every point gets its own colour, its name printed on
    // the chart, and a colour-coded legend below so the user always knows which
    // dot is which. Labels are only drawn on the chart when the point count is
    // small enough to stay legible; otherwise the legend + tooltip carry it.
    const xLabel = xKey.replaceAll("_", " ");
    const showInlineLabels = !!nameKey && data.length <= 18;
    return (
      <div style={{ height: h, width: "100%" }} className="flex flex-col">
        <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 14, right: 16, left: 12, bottom: 24 }}>
            <CartesianGrid {...gridStyle} />
            <XAxis
              dataKey={xKey}
              type="number"
              name={xKey}
              tick={tickStyle}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => fmtNumber(Number(v) || 0)}
              label={{ value: xLabel, position: "insideBottom", offset: -8, fontSize: 10, fill: "rgb(var(--color-text-muted))" }}
            />
            <YAxis
              dataKey={yKey}
              type="number"
              name={yKey}
              tick={tickStyle}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => formatValue(chart.config.metric, chart.config.grouping, Number(v) || 0)}
              width={56}
              tickMargin={8}
            />
            <Tooltip
              cursor={{ strokeDasharray: "3 3" }}
              content={({ payload }) => {
                const d = payload?.[0]?.payload;
                if (!d) return null;
                return (
                  <div className="rounded-xl border border-default bg-bg-card/95 p-3 shadow-2xl backdrop-blur-sm text-[11px]">
                    {nameKey && <p className="font-bold text-text-primary mb-1">{d[nameKey]}</p>}
                    {Object.entries(d).filter(([k]) => k !== nameKey && typeof d[k] === "number").map(([k, v]) => (
                      <p key={k} className="text-text-secondary">{k.replaceAll("_", " ")}: {fmtCurrency(Number(v))}</p>
                    ))}
                  </div>
                );
              }}
            />
            <Scatter data={data as any} fillOpacity={0.9}>
              {data.map((_, i) => (
                <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
              ))}
              {showInlineLabels && (
                <LabelList
                  dataKey={nameKey}
                  position="top"
                  offset={8}
                  style={{ fontSize: 9, fontWeight: 600, fill: "rgb(var(--color-text-secondary))" }}
                />
              )}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
        </div>
        {nameKey && (
          <div className="mt-1 flex max-h-[34%] flex-wrap gap-x-3 gap-y-1 overflow-y-auto px-1">
            {data.map((d, i) => (
              <span key={i} className="inline-flex items-center gap-1 text-[9px] text-text-secondary">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                {String((d as any)[nameKey])}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (chart.type === "pie") {
    const labelMode = chart.config.display?.labelMode ?? "percent";
    // Filter only positive values and find the label key (may be "name", "dept", "vendor", etc.)
    const labelKey = (() => {
      const row = data[0] as any;
      if (!row) return "name";
      if (typeof row.name === "string") return "name";
      return Object.keys(row).find((k) => k !== "value" && typeof row[k] === "string") ?? "name";
    })();
    const cleaned = data
      .map((d) => ({ ...d, name: String((d as any)[labelKey] ?? (d as any).name ?? ""), value: Number((d as any).value) || 0 }))
      .filter((d) => d.value > 0);
    const total = cleaned.reduce((s, d) => s + d.value, 0);
    const enriched = cleaned.map((d) => ({ ...d, total }));

    const renderLabel = ({
      cx,
      cy,
      midAngle,
      innerRadius,
      outerRadius,
      percent,
      value,
    }: any) => {
      if (percent < 0.06) return null;
      const RADIAN = Math.PI / 180;
      const r = innerRadius + (outerRadius - innerRadius) * 0.55;
      const x = cx + r * Math.cos(-midAngle * RADIAN);
      const y = cy + r * Math.sin(-midAngle * RADIAN);
      const labelText =
        labelMode === "value"
          ? formatValue(chart.config.metric, chart.config.grouping, Number(value) || 0)
          : fmtPercent((Number(percent) || 0) * 100);
      return (
        <text x={x} y={y} fill="white" textAnchor="middle" dominantBaseline="central"
          fontSize={isExpanded ? 12 : 10} fontWeight="700">
          {labelText}
        </text>
      );
    };

    return (
      <div style={{ height: h, width: "100%" }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={enriched} cx="45%" cy="50%" innerRadius={0}
              outerRadius={isExpanded ? "65%" : "58%"} paddingAngle={3}
              dataKey="value" nameKey="name" labelLine={false} label={renderLabel}>
              {enriched.map((_, i) => (
                <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} stroke="none" />
              ))}
            </Pie>
            <Tooltip
              content={
                <PieTooltip
                  metric={chart.config.metric}
                  grouping={chart.config.grouping}
                  labelMode={labelMode}
                />
              }
            />
            <Legend layout="vertical" align="right" verticalAlign="middle" iconType="circle" iconSize={8}
              formatter={(value: string) => (
                <span style={{ fontSize: isExpanded ? 11 : 10, color: "rgb(var(--color-text-secondary))", fontWeight: 600 }}>
                  {value}
                </span>
              )}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "table") {
    const limit = isExpanded ? 25 : 10;
    const rows = data.slice(0, limit);
    const totalSpend = rows.reduce((s, r) => s + (Number((r as any).value) || 0), 0);
    const cols = rows.length > 0 ? Object.keys(rows[0] ?? {}).slice(0, 8) : [];
    const isCurrencyCol = (col: string) =>
      col === "value" || /amount|spend|revenue|income|expense|total|cost|profit/i.test(col);
    const isPercentCol = (col: string) => /pct|percent|share|ratio|rate/i.test(col);

    const formatCell = (col: string, val: unknown, rowIdx: number): string => {
      if (col === "rank") return String(rowIdx + 1);
      const n = typeof val === "number" ? val : Number(val);
      if (!Number.isFinite(n)) return String(val ?? "");
      if (isPercentCol(col)) return `${n.toFixed(1)}%`;
      if (isCurrencyCol(col)) return fmtCurrency(n);
      return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(2);
    };

    return (
      <div style={{ height: h, width: "100%" }} className="overflow-hidden rounded-xl border border-default bg-bg-elevated/30">
        <div className="h-full overflow-auto">
          <table className="w-full text-left text-[11px]">
            <thead className="sticky top-0 bg-bg-elevated/80 backdrop-blur">
              <tr>
                <th className="px-3 py-2 font-bold uppercase tracking-wider text-text-muted w-8">#</th>
                {cols.map((c) => (
                  <th key={c} className="px-3 py-2 font-bold uppercase tracking-wider text-text-muted">
                    {c === "value" ? "Total Spend" : c.replaceAll("_", " ")}
                  </th>
                ))}
                {totalSpend > 0 && cols.includes("value") && (
                  <th className="px-3 py-2 font-bold uppercase tracking-wider text-text-muted">% Share</th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => (
                <tr key={idx} className="border-t border-default/50 hover:bg-bg-elevated/40 transition-colors">
                  <td className="px-3 py-2 text-text-muted font-mono text-center">{idx + 1}</td>
                  {cols.map((c) => (
                    <td key={c} className={`px-3 py-2 whitespace-nowrap ${isCurrencyCol(c) ? "text-text-primary font-semibold" : "text-text-secondary"}`}>
                      {formatCell(c, (r as any)?.[c], idx)}
                    </td>
                  ))}
                  {totalSpend > 0 && cols.includes("value") && (
                    <td className="px-3 py-2 text-text-muted font-mono">
                      {totalSpend > 0 ? `${((Number((r as any).value) || 0) / totalSpend * 100).toFixed(1)}%` : "—"}
                    </td>
                  )}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td className="px-3 py-3 text-text-muted" colSpan={(cols.length || 1) + 2}>No rows</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // ── donut (pie with inner hole) ────────────────────────────────────────────
  if (chart.type === "donut") {
    const labelMode = chart.config.display?.labelMode ?? "percent";
    const COLORS = PIE_COLORS;
    // Detect label key — may be "name", "dept", "vendor", "cls", etc.
    const labelKey = (() => {
      const row = data[0] as any;
      if (!row) return "name";
      if (typeof row.name === "string") return "name";
      return Object.keys(row).find((k) => k !== "value" && typeof row[k] === "string") ?? "name";
    })();
    // Filter negatives/zeros and normalise to {name, value}
    const donutData = data
      .map((d) => ({
        name: String((d as any)[labelKey] ?? (d as any).name ?? ""),
        value: Math.abs(Number((d as any).value) || 0),
      }))
      .filter((d) => d.value > 0);
    const donutTotal = donutData.reduce((s, d) => s + d.value, 0);
    const donutDataWithTotal = donutData.map((d) => ({ ...d, total: donutTotal }));

    const renderDonutLabel = ({
      cx,
      cy,
      midAngle,
      innerRadius,
      outerRadius,
      percent,
      value,
    }: any) => {
      if (percent < 0.07) return null;
      const RADIAN = Math.PI / 180;
      const r = innerRadius + (outerRadius - innerRadius) * 0.5;
      const x = cx + r * Math.cos(-midAngle * RADIAN);
      const y = cy + r * Math.sin(-midAngle * RADIAN);
      const labelText =
        labelMode === "value"
          ? formatValue(chart.config.metric, chart.config.grouping, Number(value) || 0)
          : fmtPercent((Number(percent) || 0) * 100);
      return (
        <text x={x} y={y} fill="white" textAnchor="middle" dominantBaseline="central"
          fontSize={isExpanded ? 11 : 9} fontWeight="700">
          {labelText}
        </text>
      );
    };

    return (
      <div style={{ height: h + (isExpanded ? 0 : 20), width: "100%" }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            {donutTotal > 0 && (
              <text x="50%" y={isExpanded ? "50%" : "46%"} textAnchor="middle" dominantBaseline="central"
                fill="rgb(var(--color-text-primary))" fontSize={isExpanded ? 13 : 11} fontWeight={700}>
                {fmtCurrency(donutTotal)}
              </text>
            )}
            <Pie data={donutDataWithTotal} dataKey="value" nameKey="name" cx="50%" cy={isExpanded ? "50%" : "44%"}
              innerRadius={isExpanded ? 70 : 52} outerRadius={isExpanded ? 120 : 88}
              paddingAngle={2} labelLine={false} label={renderDonutLabel}>
              {donutDataWithTotal.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
            </Pie>
            <Tooltip
              content={
                <PieTooltip
                  metric={chart.config.metric}
                  grouping={chart.config.grouping}
                  labelMode={labelMode}
                />
              }
            />
            <Legend iconType="circle" iconSize={8}
              verticalAlign="bottom" align="center"
              wrapperStyle={{ fontSize: isExpanded ? 11 : 10, paddingTop: 8 }}
              formatter={(value: string) => (
                <span style={{ color: "rgb(var(--color-text-secondary))", fontWeight: 600 }}>{value}</span>
              )}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // ── horizontal_bar (ranked horizontal bars) ────────────────────────────────
  if (chart.type === "horizontal_bar") {
    const sorted = [...data].sort((a, b) => (Number((b as any).value) || 0) - (Number((a as any).value) || 0));
    return (
      <div style={{ height: Math.max(h, sorted.length * 32 + 40), width: "100%" }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={sorted} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(var(--color-text-muted)/0.12)" horizontal={false} />
            <XAxis type="number" tick={{ fill: "rgb(var(--color-text-muted))", fontSize: 10 }}
              tickLine={false} axisLine={false}
              tickFormatter={(v: number) => formatValue(chart.config.metric, chart.config.grouping, v)} />
            <YAxis type="category" dataKey="name" tick={{ fill: "rgb(var(--color-text-muted))", fontSize: 10 }}
              tickLine={false} axisLine={false} width={120} />
            <Tooltip content={<CustomTooltip metric={chart.config.metric} grouping={chart.config.grouping} />} />
            <Bar dataKey="value" fill="rgb(var(--color-accent-violet))" radius={[0, 4, 4, 0]} maxBarSize={24} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // ── histogram (distribution bars) ─────────────────────────────────────────
  if (chart.type === "histogram") {
    return (
      <div style={{ height: h, width: "100%" }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 16 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(var(--color-text-muted)/0.12)" />
            <XAxis dataKey="name" tick={{ fill: "rgb(var(--color-text-muted))", fontSize: 9 }}
              tickLine={false} axisLine={false} />
            <YAxis tick={{ fill: "rgb(var(--color-text-muted))", fontSize: 10 }}
              tickLine={false} axisLine={false} width={40} />
            <Tooltip formatter={(v) => [`${Number(v) || 0} invoices`, "Count"]} />
            <Bar dataKey="value" fill="rgb(var(--color-accent-cyan))" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // ── pareto (bar + cumulative % line) ──────────────────────────────────────
  if (chart.type === "pareto") {
    const sorted = [...data].sort((a, b) => (Number((b as any).value) || 0) - (Number((a as any).value) || 0));
    const totalVal = sorted.reduce((s, d) => s + (Number((d as any).value) || 0), 0);
    let cumSum = 0;
    const paretoData = sorted.map((d) => {
      cumSum += Number((d as any).value) || 0;
      return { ...(d as any), cumPct: totalVal > 0 ? Math.round((cumSum / totalVal) * 100) : 0 };
    });
    return (
      <div style={{ height: h, width: "100%" }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={paretoData} margin={{ top: 8, right: 40, left: 8, bottom: 16 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(var(--color-text-muted)/0.12)" />
            <XAxis dataKey="name" tick={{ fill: "rgb(var(--color-text-muted))", fontSize: 9 }}
              tickLine={false} axisLine={false} />
            <YAxis yAxisId="left" tick={{ fill: "rgb(var(--color-text-muted))", fontSize: 10 }}
              tickLine={false} axisLine={false} width={56}
              tickFormatter={(v: number) => formatValue(chart.config.metric, chart.config.grouping, v)} />
            <YAxis yAxisId="right" orientation="right" domain={[0, 100]}
              tick={{ fill: "rgb(var(--color-text-muted))", fontSize: 10 }}
              tickLine={false} axisLine={false} tickFormatter={(v: number) => `${v}%`} width={36} />
            <Tooltip formatter={(v, name) =>
              name === "cumPct" ? [`${Number(v) || 0}%`, "Cumulative %"] : [fmtCurrency(Number(v) || 0), "Value"]} />
            <Bar yAxisId="left" dataKey="value" fill="rgb(var(--color-accent-violet))" radius={[4, 4, 0, 0]} />
            <Line yAxisId="right" type="monotone" dataKey="cumPct"
              stroke="rgb(var(--color-accent-cyan))" strokeWidth={2} dot={false} />
            <ReferenceLine yAxisId="right" y={80} stroke="rgb(var(--color-accent-cyan))"
              strokeDasharray="4 4" label={{ value: "80%", position: "right", fontSize: 9, fill: "rgb(var(--color-accent-cyan))" }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // ── gauge (radial financial health) ──────────────────────────────────────
  if (chart.type === "gauge") {
    const raw = (data[0] as any) ?? {};
    const score = Math.max(0, Math.min(100, Number(raw.value) || 0));
    const label = raw.label ?? (score >= 80 ? "Excellent" : score >= 60 ? "Good" : score >= 40 ? "Fair" : "Needs Attention");
    const color = score >= 80 ? "#10B981" : score >= 60 ? "#0EA5E9" : score >= 40 ? "#F59E0B" : "#EF4444";
    const gaugeData = [{ name: "Score", value: score, fill: color }, { name: "Remaining", value: 100 - score, fill: "transparent" }];
    return (
      <div style={{ height: h, width: "100%" }} className="flex flex-col items-center justify-center">
        <ResponsiveContainer width="100%" height={isExpanded ? 300 : 200}>
          <RadialBarChart cx="50%" cy="70%" innerRadius="60%" outerRadius="90%"
            startAngle={180} endAngle={0} data={gaugeData}>
            <RadialBar dataKey="value" background={{ fill: "rgba(var(--color-text-muted)/0.1)" }}
              cornerRadius={8}>
              {gaugeData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
            </RadialBar>
          </RadialBarChart>
        </ResponsiveContainer>
        <div className="mt-[-40px] flex flex-col items-center gap-1">
          <p className="text-4xl font-black" style={{ color }}>{score}</p>
          <p className="text-sm font-semibold" style={{ color }}>{label}</p>
          <p className="text-[10px] text-text-muted">Financial Health Score</p>
          {raw.revenue > 0 && (
            <div className="mt-2 flex gap-4 text-[10px] text-text-muted">
              <span>Billed: {fmtCurrency(raw.revenue)}</span>
              <span>Collected: {raw.collectionRate}%</span>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── bubble (scatter with size dimension) ──────────────────────────────────
  if (chart.type === "bubble") {
    const maxZ = Math.max(...data.map((d) => Number((d as any).z) || 0), 1);
    const bubbleData = data.map((d) => ({
      ...(d as any),
      z: Math.max(4, Math.round((Number((d as any).z) / maxZ) * 30)),
    }));
    const bubbleHasName = bubbleData[0] && typeof (bubbleData[0] as any).name === "string";
    const showBubbleLabels = bubbleHasName && bubbleData.length <= 16;
    return (
      <div style={{ height: h, width: "100%" }} className="flex flex-col">
        <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 14, right: 12, left: 8, bottom: 24 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(var(--color-text-muted)/0.12)" />
            <XAxis type="number" dataKey="x" name="Amount"
              tick={{ fill: "rgb(var(--color-text-muted))", fontSize: 10 }} tickLine={false} axisLine={false}
              tickFormatter={(v: number) => fmtCurrency(v)} label={{ value: "Amount", position: "bottom", fontSize: 10, fill: "rgb(var(--color-text-muted))" }} />
            <YAxis type="number" dataKey="y" name="Invoices"
              tick={{ fill: "rgb(var(--color-text-muted))", fontSize: 10 }} tickLine={false} axisLine={false}
              label={{ value: "Invoices", angle: -90, position: "left", fontSize: 10, fill: "rgb(var(--color-text-muted))" }} />
            <ZAxis type="number" dataKey="z" range={[40, 400]} />
            <Tooltip cursor={{ strokeDasharray: "3 3" }}
              content={({ payload }) => {
                const d = payload?.[0]?.payload;
                if (!d) return null;
                return (
                  <div className="rounded-lg border border-default bg-bg-elevated p-2 text-[10px] shadow-lg">
                    <p className="font-semibold text-text-primary">{d.name}</p>
                    <p className="text-text-muted">Amount: {fmtCurrency(d.revenue ?? d.x)}</p>
                    <p className="text-text-muted">Invoices: {d.invoices ?? d.y}</p>
                    <p className="text-text-muted">Avg Invoice: {fmtCurrency(d.avgInvoice ?? 0)}</p>
                  </div>
                );
              }} />
            <Scatter data={bubbleData} fillOpacity={0.75}>
              {bubbleData.map((_, i) => (
                <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
              ))}
              {showBubbleLabels && (
                <LabelList
                  dataKey="name"
                  position="top"
                  offset={6}
                  style={{ fontSize: 9, fontWeight: 600, fill: "rgb(var(--color-text-secondary))" }}
                />
              )}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
        </div>
        {bubbleHasName && (
          <div className="mt-1 flex max-h-[34%] flex-wrap gap-x-3 gap-y-1 overflow-y-auto px-1">
            {bubbleData.map((d, i) => (
              <span key={i} className="inline-flex items-center gap-1 text-[9px] text-text-secondary">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                {String((d as any).name)}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── kpi (multi-card grid) ─────────────────────────────────────────────────
  if (chart.type === "kpi") {
    const iconMap: Record<string, string> = {
      revenue: "↑", expenses: "↓", profit: "◈", invoice: "◻", count: "#", overdue: "⚠"
    };
    const colorMap: Record<string, string> = {
      revenue: "text-emerald-400", expenses: "text-red-400", profit: "text-violet-400",
      invoice: "text-cyan-400", count: "text-blue-400", overdue: "text-amber-400"
    };
    return (
      <div className="grid h-full w-full grid-cols-2 gap-2 p-1 md:grid-cols-3">
        {data.map((item, i) => {
          const d = item as any;
          const fmt = d.format === "currency" ? fmtCurrency(d.value) : fmtNumber(d.value);
          const icon = iconMap[d.icon ?? ""] ?? "◈";
          const color = colorMap[d.icon ?? ""] ?? "text-violet-400";
          return (
            <div key={i} className="flex flex-col items-center justify-center gap-1 rounded-xl border border-default bg-bg-elevated/40 p-3 text-center">
              <span className={`text-lg ${color}`}>{icon}</span>
              <p className="text-[9px] font-bold uppercase tracking-widest text-text-muted">{d.label}</p>
              <p className={`text-lg font-black tracking-tight ${color}`}>{fmt}</p>
            </div>
          );
        })}
      </div>
    );
  }

  // ── heatmap (general grid: rows = series, columns = categories) ────────────
  if (chart.type === "heatmap" || chart.type === "matrix") {
    const rows = data.filter(Boolean);
    const colKeys =
      inferNumericSeriesKeys(rows).filter((k) => k !== "total") ||
      [];
    const rowAxis = String(chart.config.grouping ?? "").split("_")[0] || "row";
    const prettyAxis = (value: string) =>
      value
        .split("_")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
    const axisLabel = (axis: string) => prettyAxis(axis || "Name");
    const amount = (value: number) =>
      formatValue(chart.config.metric, chart.config.grouping, value);
    const lerp = (from: number, to: number, t: number) =>
      Math.round(from + (to - from) * Math.max(0, Math.min(1, t)));
    const rgb = (r: number, g: number, b: number) => `rgb(${r}, ${g}, ${b})`;
    const conditionalThreshold =
      typeof chart.config.display?.conditionalThreshold === "number"
        ? chart.config.display.conditionalThreshold
        : null;
    const cellTheme = (value: number) => {
      if (
        conditionalThreshold !== null &&
        value >= conditionalThreshold &&
        chart.config.display?.conditionalColor === "green"
      ) {
        return { bg: "#16a34a", fg: "#ffffff" };
      }
      const maxVal = Math.max(
        ...rows.flatMap((row) => colKeys.map((key) => Math.abs(Number((row as any)[key]) || 0))),
        1,
      );
      const intensity = Math.min(1, Math.abs(value) / maxVal);
      if (intensity >= 0.5) {
        const t = (intensity - 0.5) / 0.5;
        const r = lerp(245, 22, t);
        const g = lerp(158, 163, t);
        const b = lerp(11, 74, t);
        const fg = intensity >= 0.8 ? "#ffffff" : "#111827";
        return { bg: rgb(r, g, b), fg };
      }
      const t = intensity / 0.5;
      const r = lerp(248, 245, t);
      const g = lerp(113, 158, t);
      const b = lerp(113, 11, t);
      return { bg: rgb(r, g, b), fg: intensity < 0.25 ? "#ffffff" : "#111827" };
    };
    const rowTotals = rows.map((row) =>
      colKeys.reduce((sum, key) => sum + (Number((row as any)[key]) || 0), 0),
    );
    const colTotals = colKeys.map((key) =>
      rows.reduce((sum, row) => sum + (Number((row as any)[key]) || 0), 0),
    );
    const grandTotal = rowTotals.reduce((sum, value) => sum + value, 0);

    return (
      <div style={{ height: h, width: "100%", overflowX: "auto" }}>
        <div className="mb-2 flex items-center gap-3 text-[10px] font-semibold text-text-muted">
          <span className="uppercase tracking-wider">Intensity</span>
          <span className="flex items-center gap-1">
            <span className="h-3 w-3 rounded-[3px] bg-[#f87171]" />
            Low
          </span>
          <span className="flex items-center gap-1">
            <span className="h-3 w-3 rounded-[3px] bg-[#f5b61b]" />
            Medium
          </span>
          <span className="flex items-center gap-1">
            <span className="h-3 w-3 rounded-[3px] bg-[#22c55e]" />
            High
          </span>
        </div>
        <table className="min-w-full border-separate border-spacing-1">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 rounded-md border border-default bg-bg-card px-3 py-2 text-left text-[11px] font-semibold text-text-muted shadow-sm">
                {axisLabel(rowAxis)}
              </th>
              {colKeys.map((key) => (
                <th
                  key={key}
                  className="rounded-md border border-default bg-bg-card px-3 py-2 text-center text-[11px] font-semibold text-text-muted shadow-sm"
                >
                  {prettyAxis(key)}
                </th>
              ))}
              <th className="rounded-md border border-default bg-bg-card px-3 py-2 text-center text-[11px] font-semibold text-text-muted shadow-sm">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => {
              const rowLabel = String((row as any).name ?? `Row ${rowIndex + 1}`);
              return (
                <tr key={rowLabel}>
                  <th className="sticky left-0 z-10 rounded-md border border-default bg-bg-card px-3 py-2 text-left text-[11px] font-semibold text-text-muted shadow-sm">
                    {rowLabel}
                  </th>
                  {colKeys.map((key) => {
                    const value = Number((row as any)[key]) || 0;
                    const theme = cellTheme(value);
                    return (
                      <td
                        key={key}
                        className="rounded-md border border-black/10 px-3 py-3 text-center text-[12px] font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] transition-transform transition-opacity hover:-translate-y-[1px] hover:opacity-100"
                        style={{ background: theme.bg, color: theme.fg }}
                        title={`${rowLabel} / ${prettyAxis(key)}: ${amount(value)}`}
                      >
                        {amount(value)}
                      </td>
                    );
                  })}
                  <td className="rounded-md border border-default bg-bg-elevated px-3 py-3 text-center text-[12px] font-bold text-text-primary shadow-sm">
                    {amount(rowTotals[rowIndex] ?? 0)}
                  </td>
                </tr>
              );
            })}
            <tr>
              <th className="sticky left-0 z-10 rounded-md border border-default bg-bg-card px-3 py-2 text-left text-[11px] font-bold text-text-primary shadow-sm">
                Total
              </th>
              {colTotals.map((value, index) => (
                <td
                  key={colKeys[index] ?? index}
                  className="rounded-md border border-default bg-bg-elevated px-3 py-3 text-center text-[12px] font-bold text-text-primary shadow-sm"
                >
                  {amount(value)}
                </td>
              ))}
              <td className="rounded-md border border-default bg-bg-elevated px-3 py-3 text-center text-[12px] font-bold text-text-primary shadow-sm">
                {amount(grandTotal)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div style={{ height: h, width: "100%" }}>
      <ResponsiveContainer width="100%" height="100%">
        {(() => {
          const seriesKeys = inferNumericSeriesKeys(data);
          const hasValueSeries = hasFiniteValueKey(data, "value");
          const isMultiSeries = !hasValueSeries && seriesKeys.length > 0;

          if (isMultiSeries) {
            return (
              <LineChart data={data} margin={{ top: 8, right: 4, left: 12, bottom: 0 }}>
                <CartesianGrid {...gridStyle} />
                <XAxis dataKey="name" tick={tickStyle} />
                <YAxis
                  tick={tickStyle}
                  tickFormatter={(v: number) =>
                    formatValue(chart.config.metric, chart.config.grouping, Number(v) || 0)
                  }
                  width={56}
                  tickMargin={8}
                />
                <Tooltip
                  content={
                    <CustomTooltip metric={chart.config.metric} grouping={chart.config.grouping} />
                  }
                />
                <Legend
                  verticalAlign="top"
                  height={24}
                  wrapperStyle={{ fontSize: 10, fontWeight: 600, color: "rgb(var(--color-text-muted))" }}
                />
                {seriesKeys.slice(0, 6).map((key, idx) => (
                  <Line
                    key={key}
                    type="monotone"
                    dataKey={key}
                    name={key.replace(/_/g, " ")}
                    stroke={PIE_COLORS[idx % PIE_COLORS.length]}
                    strokeWidth={2}
                    dot={false}
                  />
                ))}
              </LineChart>
            );
          }

          return (
            <LineChart data={data} margin={{ top: 8, right: 4, left: 12, bottom: 0 }}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="name" tick={tickStyle} />
              <YAxis
                tick={tickStyle}
                tickFormatter={(v: number) =>
                  formatValue(chart.config.metric, chart.config.grouping, Number(v) || 0)
                }
                width={56}
                tickMargin={8}
              />
              <Tooltip
                content={
                  <CustomTooltip metric={chart.config.metric} grouping={chart.config.grouping} />
                }
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke="rgb(var(--color-accent-blue))"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          );
        })()}
      </ResponsiveContainer>
    </div>
  );
}

// ─── Chart Card ───────────────────────────────────────────────────────────────

function getEmptyMessage(chart: Chart): string {
  if (chart.config.metric === 'dynamic')
    return 'No data returned for this query — try rephrasing or check that your accounting data is synced';
  if (chart.config.orgName)
    return `No data synced for "${chart.config.orgName}" in this scope yet`;
  if (chart.config.grouping === 'vendor')
    return 'Vendor data requires a QuickBooks or Xero sync with bill-level detail';
  if (chart.config.grouping === 'department')
    return 'Department data requires accounting sync with department tagging enabled';
  if (chart.config.grouping === 'class')
    return 'Class data requires QuickBooks sync with class tracking enabled';
  if (chart.config.grouping === 'account' || chart.config.grouping === 'category') {
    if (chart.config.metric === 'revenue' || chart.config.metric === 'expense')
      return 'No matching accounts found in this GL data — this dataset may need a different grouping';
  }
  return 'No data for this scope yet';
}

// Chart types that have no meaningful X/Y axes.
const AXISLESS_TYPES = new Set([
  "metric",
  "kpi",
  "gauge",
  "pie",
  "donut",
  "treemap",
]);

// Compact, always-visible caption telling the user exactly what each axis means.
function AxisCaption({ chart }: { chart: Chart }) {
  if (AXISLESS_TYPES.has(chart.type)) return null;
  const x = chart.config.xAxisLabel?.trim();
  const y = chart.config.yAxisLabel?.trim();
  if (!x && !y) return null;
  return (
    <p className="mt-1 line-clamp-1 text-[10px] font-medium text-text-muted/90">
      {x ? (
        <>
          <span className="text-text-muted/70">X:</span> {x}
        </>
      ) : null}
      {x && y ? <span className="mx-1.5 text-text-muted/40">·</span> : null}
      {y ? (
        <>
          <span className="text-text-muted/70">Y:</span> {y}
        </>
      ) : null}
    </p>
  );
}

function ChartCard({
  chart,
  data,
  index,
  onExpand,
}: {
  chart: Chart;
  data: DataRow[];
  index: number;
  onExpand: () => void;
}) {
  const isEmpty = data.length === 0;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.35, delay: index * 0.07, ease: [0.22, 1, 0.36, 1] }}
      onClick={() => !isEmpty && onExpand()}
      className={cn(
        "surface-card group relative flex flex-col p-4 transition-all duration-200",
        !isEmpty &&
          "cursor-pointer hover:-translate-y-0.5 hover:border-accent-violet/30 hover:shadow-xl hover:shadow-accent-violet/5",
      )}
      style={{ minHeight: chart.type === "metric" ? "auto" : 300 }}
    >
      {/* Header */}
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-text-primary">{chart.title}</h3>
          <p className="mt-0.5 line-clamp-1 text-[10px] text-text-muted">
            {chart.description ?? `${chart.type} · ${chart.config.metric} / ${chart.config.grouping}`}
          </p>
          <AxisCaption chart={chart} />
        </div>
        {!isEmpty && (
          <Maximize2
            size={12}
            className="mt-0.5 shrink-0 text-text-muted opacity-0 transition-opacity group-hover:opacity-100"
          />
        )}
      </div>

      {/* Chart */}
      <div className="min-h-0 flex-1 pointer-events-none">
        {isEmpty ? (
          <div className="flex h-full min-h-[160px] items-center justify-center rounded-xl bg-bg-elevated/30">
            <p className="text-xs text-text-muted text-center px-4">
              {getEmptyMessage(chart)}
            </p>
          </div>
        ) : (
          <ChartErrorBoundary>{renderChart(chart, data, false)}</ChartErrorBoundary>
        )}
      </div>

      {/* Footer: type badge + insight */}
      <div className="mt-3 flex min-w-0 items-center gap-2">
        <span className="shrink-0 rounded-full bg-bg-elevated px-2.5 py-0.5 text-[10px] font-semibold text-text-muted ring-1 ring-default">
          {prettyChartType(chart.type)}
        </span>
        {!isEmpty && (
          <div className="min-w-0 flex-1 overflow-hidden">
            <ChartInsight type={chart.type} data={data} />
          </div>
        )}
      </div>
    </motion.div>
  );
}

function VersionSection({
  version,
  charts,
  chartData,
  onExpandChart,
}: {
  version: ChartVersionSnapshot | null;
  charts: Chart[];
  chartData: Record<string, DataRow[]>;
  onExpandChart: (chartId: string) => void;
}) {
  const versionLabel = version ? `Chart v${version.versionNumber}` : "Current dashboard";
  const modeLabel = version
    ? version.mode === "edit"
      ? "updated chart"
      : "new chart"
    : "latest charts";

  return (
    <div className="rounded-2xl border border-default bg-bg-elevated/20 p-4">
      {version ? (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-accent-cyan/10 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-accent-cyan">
            {versionLabel}
          </span>
          <span className="rounded-full bg-bg-elevated px-2.5 py-0.5 text-[10px] font-semibold text-text-muted">
            {modeLabel}
          </span>
          {typeof version.previousVersionNumber === "number" && (
            <span className="rounded-full bg-bg-elevated px-2.5 py-0.5 text-[10px] font-semibold text-text-muted">
              preserves v{version.previousVersionNumber}
            </span>
          )}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4">
        {charts.map((chart, index) => (
          <ChartCard
            key={chart.id}
            chart={chart}
            data={chartData[chart.id] ?? []}
            index={index}
            onExpand={() => onExpandChart(chart.id)}
          />
        ))}
      </div>
    </div>
  );
}

// ─── DashboardPreview ─────────────────────────────────────────────────────────

export function DashboardPreview({
  triggerSync,
  isGenerating = false,
  sessionId,
  liveChartTurn,
}: {
  triggerSync: number;
  isGenerating?: boolean;
  sessionId?: string | null;
  liveChartTurn?: ChartTurnMetadata | null;
}) {
  const { agent, loading } = useNumeriquApi();
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [chartVersions, setChartVersions] = useState<ChartVersionSnapshot[]>([]);
  const [chartData, setChartData] = useState<Record<string, DataRow[]>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedChartId, setExpandedChartId] = useState<string | null>(null);
  const prevSessionRef = useRef<string | null | undefined>(sessionId);

  // Switching chats (or starting a new one) must NOT keep showing the previous
  // dashboard's charts. Clear immediately so the loading/generating skeleton is
  // shown until the new session's dashboard arrives.
  if (prevSessionRef.current !== sessionId) {
    prevSessionRef.current = sessionId;
    if (dashboard !== null) setDashboard(null);
    if (chartVersions.length > 0) setChartVersions([]);
    if (Object.keys(chartData).length > 0) setChartData({});
    setExpandedChartId(null);
  }

  useEffect(() => {
    if (loading) return;

    const fetchDashboard = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const [latest, sessionDetail] = await Promise.all([
          sessionId ? agent.dashboardForSession(sessionId) : agent.latestDashboard(),
          sessionId ? agent.session(sessionId).catch(() => null) : Promise.resolve(null),
        ]);
        if (latest) {
          const charts: Chart[] = (latest.charts ?? []).map((c) => ({
            id: c.id,
            title: c.title,
            description: c.description ?? null,
            type: c.type,
            config: c.config as ChartConfig,
            layoutIndex: c.layoutIndex,
          }));
          const sessionHistory = sessionDetail ? buildChartVersionHistory(sessionDetail.messages) : [];
          const liveHistory = liveChartTurn
            ? buildChartVersionHistory([
                { role: "assistant", content: "", metadata: liveChartTurn } as ChatMessage,
              ])
            : [];
          const history = mergeChartVersionHistories(sessionHistory, liveHistory);
          const chartsToLoad = history.length > 0 ? history.flatMap((version) => version.charts) : charts;
          setDashboard({
            id: latest.id,
            title: latest.title,
            description: latest.description ?? null,
            charts,
          });
          setChartVersions(history);

          const dataMap: Record<string, DataRow[]> = {};
          for (const chart of chartsToLoad) {
            if (Array.isArray(chart.snapshotData) && chart.snapshotData.length > 0) {
              dataMap[chart.id] = chart.snapshotData;
            }
          }
          await Promise.all(
            chartsToLoad
              .filter((chart) => !dataMap[chart.id])
              .map(async (chart) => {
              try {
                const res = await agent.getMetrics(
                  chart.config.metric,
                  chart.config.grouping,
                  chart.config.timeRange ?? null,
                  chart.config.providerHint ?? null,
                  chart.config.clientName ?? null,
                  (chart.config as any)?.clientNames ?? null,
                  chart.config.orgId ?? null,
                  chart.config.breakdown ?? null,
                  chart.config.topN ?? null,
                  chart.config.metric === "dynamic" ? chart.id : null,
                );
                dataMap[chart.id] = (res.data ?? []) as DataRow[];
              } catch {
                dataMap[chart.id] = [];
              }
              }),
          );
          setChartData(dataMap);
        } else {
          setDashboard(null);
          setChartVersions([]);
          setChartData({});
        }
      } catch (caught) {
        const message =
          caught instanceof ApiError
            ? caught.toUserMessage("Could not load the dashboard.")
            : "Could not load the dashboard.";
        setError(message);
      } finally {
        setIsLoading(false);
      }
    };

    void fetchDashboard();
  }, [agent, loading, triggerSync, sessionId, liveChartTurn]);

  // ── Loading / Generating state ──────────────────────────────────────────────
  // Show the generating skeleton whenever a generation is in flight — even if a
  // previous dashboard is still in state — so a new prompt never displays the
  // old prompt's charts while the new one is being built.
  if (isGenerating) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 rounded-2xl border border-accent-violet/20 bg-accent-violet/5 px-4 py-3">
          <Activity size={12} className="animate-pulse text-accent-violet" />
          <span className="text-xs font-semibold text-accent-violet">
            Generating your dashboard...
          </span>
          <span className="ml-2 text-[10px] text-text-muted">
            Executing data tools · designing charts · writing analysis
          </span>
        </div>
        <div className="space-y-4">
          {[220, 260, 200, 240].map((h, i) => (
            <motion.div
              key={i}
              animate={{ opacity: [0.35, 0.7, 0.35] }}
              transition={{ duration: 1.6, repeat: Infinity, delay: i * 0.22 }}
              className="w-full rounded-2xl bg-bg-elevated"
              style={{ height: h }}
            />
          ))}
        </div>
      </div>
    );
  }

  if (isLoading && !dashboard) {
    return (
      <div className="space-y-4">
        {[1, 2, 3, 4].map((i) => (
          <motion.div
            key={i}
            animate={{ opacity: [0.3, 0.6, 0.3] }}
            transition={{ duration: 1.4, repeat: Infinity, delay: i * 0.15 }}
            className="h-[280px] w-full rounded-2xl bg-bg-elevated"
          />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <ErrorBanner title="Dashboard unavailable" tone="danger">
        {error}
      </ErrorBanner>
    );
  }

  if (!dashboard) {
    return (
      <EmptyState
        title="No dashboard yet"
        detail='Give the agent a mission — "Build a CFO board pack" — to generate an intelligent dashboard that lives here.'
      />
    );
  }

  const visibleVersions =
    chartVersions.length > 0
      ? chartVersions
      : [
          {
            versionNumber: 0,
            mode: "create" as const,
            previousVersionNumber: null,
            dashboardTitle: dashboard.title,
            summary: dashboard.description ?? "Current dashboard",
            charts: dashboard.charts,
          },
        ];
  const visibleCharts = visibleVersions.flatMap((version) => version.charts);
  const expandedChart = visibleCharts.find((c) => c.id === expandedChartId);
  const expandedData = expandedChart ? (chartData[expandedChart.id] ?? []) : [];

  return (
    <div className="space-y-4">
      {/* Dashboard header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        className="surface-card flex items-start justify-between gap-3 border-feedback-success/20 bg-feedback-success/4 p-4"
      >
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-bold text-text-primary">{dashboard.title}</h2>
          <p className="mt-0.5 text-xs text-text-muted">
            {dashboard.description ?? "AI-generated strategic intelligence dashboard"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Activity size={11} className="animate-pulse text-feedback-success" />
          <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-feedback-success">
            Live
          </span>
        </div>
      </motion.div>

      {chartVersions.length > 0 ? (
        <div className="rounded-2xl border border-default bg-bg-elevated/25 px-4 py-3">
          <p className="text-xs text-text-muted">
            Live dashboard keeps every chart version below the previous one, so edits extend the
            history instead of replacing it.
          </p>
        </div>
      ) : null}

      {/* Chart history — each version stacks downward in the live dashboard */}
      <div className="space-y-4 pb-8">
        {visibleVersions.map((version) => (
          <VersionSection
            key={`${version.versionNumber}-${version.dashboardTitle}`}
            version={version.versionNumber > 0 ? version : null}
            charts={version.charts}
            chartData={chartData}
            onExpandChart={(chartId) => setExpandedChartId(chartId)}
          />
        ))}
      </div>

      {/* Expanded view modal */}
      <AnimatePresence>
        {expandedChart && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/88 backdrop-blur-2xl"
              onClick={() => setExpandedChartId(null)}
            />
            <motion.div
              initial={{ scale: 0.94, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.94, opacity: 0, y: 20 }}
              transition={{ type: "spring", stiffness: 280, damping: 28 }}
              className="surface-card relative flex h-[88vh] w-full max-w-5xl flex-col p-8"
            >
              <button
                onClick={() => setExpandedChartId(null)}
                className="absolute right-6 top-6 rounded-full bg-bg-elevated p-2 text-text-muted transition-colors hover:bg-surface-card hover:text-text-primary"
                aria-label="Close"
              >
                <X size={18} />
              </button>

              <div className="mb-6">
                <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-feedback-success">
                  NumeriQ Intelligence
                </p>
                <h2 className="mt-1 text-2xl font-bold text-text-primary">
                  {expandedChart.title}
                </h2>
                <p className="mt-1 text-sm text-text-muted">
                  {expandedChart.description ??
                    `${expandedChart.type} analysis of ${expandedChart.config.metric} grouped by ${expandedChart.config.grouping}`}
                </p>
                {!AXISLESS_TYPES.has(expandedChart.type) &&
                (expandedChart.config.xAxisLabel || expandedChart.config.yAxisLabel) ? (
                  <p className="mt-2 text-xs font-medium text-text-muted">
                    {expandedChart.config.xAxisLabel ? (
                      <>
                        <span className="text-text-muted/70">X-Axis:</span>{" "}
                        {expandedChart.config.xAxisLabel}
                      </>
                    ) : null}
                    {expandedChart.config.xAxisLabel && expandedChart.config.yAxisLabel ? (
                      <span className="mx-2 text-text-muted/40">·</span>
                    ) : null}
                    {expandedChart.config.yAxisLabel ? (
                      <>
                        <span className="text-text-muted/70">Y-Axis:</span>{" "}
                        {expandedChart.config.yAxisLabel}
                      </>
                    ) : null}
                  </p>
                ) : null}
              </div>

              <div className="min-h-0 w-full flex-1 rounded-2xl border border-default bg-bg-elevated/30 p-6">
                <ChartErrorBoundary>
                  {renderChart(expandedChart, expandedData, true)}
                </ChartErrorBoundary>
              </div>

              <div className="mt-5 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-text-muted">
                    {expandedData.length} data points · live data
                  </span>
                  <ChartInsight type={expandedChart.type} data={expandedData} />
                </div>
                <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-text-muted">
                  NumeriQ Strategic Layer
                </span>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
