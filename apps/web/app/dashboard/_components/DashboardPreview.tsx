"use client";

import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import {
  ChevronDown,
  History,
  Maximize2,
  Trash2,
  X,
  TrendingDown,
  DollarSign,
  Clock,
  Zap,
  Activity,
  ArrowUpRight,
  ArrowDownRight,
  BarChart3 as BarChart3Icon,
  CalendarRange,
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
    valueFormat?: "currency" | "number" | "percent" | null; // primary value unit (EBPO dynamic charts)
    valueDecimals?: number | null; // decimals for the primary value (e.g. 1 for %)
    showTotals?: boolean | null; // matrix/heatmap totals are rendered when true/default
    conditionalThreshold?: number | null; // matrix cells at/above this value use conditional color
    conditionalThresholdMode?: "columnAverage" | "rowAverage" | "overallAverage" | null; // dynamic "above average" highlight
    conditionalColor?: "green" | null;
  } | null;
}

interface Chart {
  id: string;
  // The real DB widget id, when known. Used as the stable target for header
  // deletion (the synthesized `id` above is only unique per render, not a row).
  widgetId?: string | null;
  title: string;
  description?: string | null;
  type: string;
  config: ChartConfig;
  layoutIndex?: number;
  snapshotData?: DataRow[];
  rangeNotice?: string | null;
  requestedRangeLabel?: string | null;
  availableRange?: { start: string; end: string } | null;
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
type ChartScopeSelection =
  | { kind: "all" }
  | { kind: "year"; year: number }
  | { kind: "preset"; months: number }
  | { kind: "custom"; start: string; end: string };
type ChartPeriodMeta = {
  years: number[];
  minMonth: string | null;
  maxMonth: string | null;
  hasMonthlyData: boolean;
};

type ChartTurnMode = "create" | "edit";

type ChartTurnWidgetSnapshot = {
  id?: string | null;
  title?: string;
  chartType?: string;
  queryConfig?: Record<string, unknown>;
  chartConfig?: Record<string, unknown>;
  displayOrder?: number;
  dataSnapshot?: Array<Record<string, unknown>>;
  dataSnapshotTruncated?: boolean;
  rangeNotice?: string | null;
  requestedRangeLabel?: string | null;
  availableRange?: { start: string; end: string } | null;
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

type ChartDataMeta = {
  rangeNotice?: string | null;
  requestedRangeLabel?: string | null;
  availableRange?: { start: string; end: string } | null;
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
    // Drop series that are zero/empty in every row — they add a flat-zero line or
    // bar (e.g. a date-null vendor, or a split the data doesn't have) and read as
    // a broken chart. A series with no data shouldn't be plotted.
    .filter(([, total]) => total > 0)
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
        widgetId: typeof widget.id === "string" ? widget.id : null,
        title,
        description: chartDescription,
        type: String(widget.chartType ?? "bar").trim(),
        config: chartConfig,
        layoutIndex: widget.displayOrder ?? widgetIndex,
        snapshotData: Array.isArray(widget.dataSnapshot)
          ? (widget.dataSnapshot as DataRow[])
          : undefined,
        rangeNotice: widget.rangeNotice ?? null,
        requestedRangeLabel: widget.requestedRangeLabel ?? null,
        availableRange: widget.availableRange ?? null,
      });
    }

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

// ─── Chart Scope Helpers ─────────────────────────────────────────────────────

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function parsePointDate(row: DataRow): Date | null {
  const candidates = [
    (row as any).period_date,
    (row as any).month_start,
    (row as any).date,
    (row as any).name,
    (row as any).month,
    (row as any).period,
  ];

  for (const raw of candidates) {
    const text = String(raw ?? "").trim();
    if (!text) continue;

    const isoMonth = text.match(/^((?:19|20)\d{2})-(\d{1,2})(?:-\d{1,2})?$/);
    if (isoMonth) {
      return new Date(Date.UTC(Number(isoMonth[1]), Number(isoMonth[2]) - 1, 1));
    }

    const shortMonth = text.match(/^([A-Za-z]{3,9})\s+((?:19|20)\d{2})$/);
    if (shortMonth) {
      const month = [
        "jan",
        "feb",
        "mar",
        "apr",
        "may",
        "jun",
        "jul",
        "aug",
        "sep",
        "oct",
        "nov",
        "dec",
      ].indexOf(shortMonth[1]!.slice(0, 3).toLowerCase());
      if (month >= 0) return new Date(Date.UTC(Number(shortMonth[2]), month, 1));
    }

    const numericMonth = text.match(/^(\d{1,2})\/(\d{2}|\d{4})$/);
    if (numericMonth) {
      const month = Number(numericMonth[1]);
      const rawYear = Number(numericMonth[2]);
      const year = rawYear < 100 ? 2000 + rawYear : rawYear;
      if (month >= 1 && month <= 12) return new Date(Date.UTC(year, month - 1, 1));
    }

    const quarter = text.match(/^Q[1-4]\s+((?:19|20)\d{2})$/i);
    if (quarter) return new Date(Date.UTC(Number(quarter[1]), 0, 1));

    const yearOnly = text.match(/^((?:19|20)\d{2})$/);
    if (yearOnly) return new Date(Date.UTC(Number(yearOnly[1]), 0, 1));
  }

  return null;
}

function getPeriodMeta(data: DataRow[]): ChartPeriodMeta {
  const dates = data.map(parsePointDate).filter((d): d is Date => !!d);
  const years = Array.from(new Set(dates.map((d) => d.getUTCFullYear()))).sort((a, b) => a - b);
  const months = dates.map(monthKey).sort();
  const uniqueMonths = Array.from(new Set(months));
  return {
    years,
    minMonth: uniqueMonths[0] ?? null,
    maxMonth: uniqueMonths[uniqueMonths.length - 1] ?? null,
    hasMonthlyData: uniqueMonths.length > years.length,
  };
}

function filterRowsByScope(data: DataRow[], selection?: ChartScopeSelection): DataRow[] {
  if (!selection || selection.kind === "all") return data;

  const dated = data
    .map((row) => ({ row, date: parsePointDate(row) }))
    .filter((item): item is { row: DataRow; date: Date } => !!item.date);
  if (dated.length === 0) return data;

  if (selection.kind === "year") {
    return dated.filter((item) => item.date.getUTCFullYear() === selection.year).map((item) => item.row);
  }

  if (selection.kind === "preset") {
    const maxDate = dated.reduce((latest, item) => (item.date > latest ? item.date : latest), dated[0]!.date);
    const start = new Date(Date.UTC(maxDate.getUTCFullYear(), maxDate.getUTCMonth() - selection.months + 1, 1));
    return dated.filter((item) => item.date >= start && item.date <= maxDate).map((item) => item.row);
  }

  const start = selection.start ? new Date(`${selection.start}-01T00:00:00.000Z`) : null;
  const end = selection.end ? new Date(`${selection.end}-01T00:00:00.000Z`) : null;
  return dated
    .filter((item) => (!start || item.date >= start) && (!end || item.date <= end))
    .map((item) => item.row);
}

function describeScope(selection: ChartScopeSelection | undefined, data: DataRow[]): string {
  if (!selection || selection.kind === "all") return `${data.length} points`;
  if (selection.kind === "year") return `${selection.year} · ${data.length} points`;
  if (selection.kind === "preset") return `Last ${selection.months} months · ${data.length} points`;
  if (selection.start && selection.end) return `${selection.start} to ${selection.end} · ${data.length} points`;
  return `${data.length} points`;
}

function defaultScopeFromTimeRange(range: TimeRange | null | undefined): ChartScopeSelection | undefined {
  if (!range || range.kind === "ALL_TIME") return undefined;
  if (range.kind === "LAST_N_MONTHS") return { kind: "preset", months: range.months };
  if (range.kind === "BETWEEN_DATES") return { kind: "custom", start: range.start.slice(0, 7), end: range.end.slice(0, 7) };
  if (range.kind === "SINCE_DATE") return { kind: "custom", start: range.start.slice(0, 7), end: range.start.slice(0, 7) };
  if (range.kind === "YTD") return { kind: "preset", months: new Date().getUTCMonth() + 1 };
  return undefined;
}

function monthKeyToDate(key: string): Date | null {
  const match = key.match(/^((?:19|20)\d{2})-(\d{2})$/);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
}

function formatMonthKey(key: string, variant: "short" | "long" = "short"): string {
  const date = monthKeyToDate(key);
  if (!date) return key;
  return new Intl.DateTimeFormat("en-US", {
    month: variant === "short" ? "short" : "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function enumerateMonths(minMonth: string | null, maxMonth: string | null): string[] {
  const start = minMonth ? monthKeyToDate(minMonth) : null;
  const end = maxMonth ? monthKeyToDate(maxMonth) : null;
  if (!start || !end || start > end) return [];

  const months: string[] = [];
  const cursor = new Date(start);
  while (cursor <= end && months.length < 240) {
    months.push(monthKey(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

function clampMonthRange(
  start: string,
  end: string,
  minMonth: string | null,
  maxMonth: string | null,
): { start: string; end: string } {
  const safeStart = start || minMonth || end || maxMonth || "";
  const safeEnd = end || maxMonth || safeStart;
  const ordered = safeStart <= safeEnd ? { start: safeStart, end: safeEnd } : { start: safeEnd, end: safeStart };
  return {
    start: minMonth && ordered.start < minMonth ? minMonth : ordered.start,
    end: maxMonth && ordered.end > maxMonth ? maxMonth : ordered.end,
  };
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
              ? (() => {
                  // Per-series unit: a series whose NAME marks it a percentage (e.g.
                  // "Gross Margin %") must format as % even inside a $ combo — the
                  // chart-level valueFormatter would otherwise label it as dollars.
                  const _nm = String(entry.name ?? "").toLowerCase();
                  const _isPct =
                    !/\busd\b|\$/.test(_nm) &&
                    /%|\bpercent(age)?\b|\bsla\b|\bcsat\b|utili[sz]ation/.test(_nm);
                  if (_isPct) return fmtPercent(entry.value);
                  return typeof valueFormatter === "function"
                    ? valueFormatter(entry.value, entry)
                    : formatValue(
                        String(metric ?? ""),
                        String(grouping ?? ""),
                        entry.value,
                      );
                })()
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
    // The pie renders only positive slices (share of magnitude). The caption MUST
    // use the same basis — otherwise mixed-sign data (e.g. a balance sheet with
    // negative liabilities) collapses the total and yields nonsense like "488%".
    const positives = data.filter((d) => (Number(d.value) || 0) > 0);
    const total = positives.reduce((s, d) => s + (Number(d.value) || 0), 0);
    if (total === 0 || positives.length === 0) return null;
    const maxEntry = positives.reduce(
      (a, b) => (Number(a.value) >= Number(b.value) ? a : b),
      positives[0]!,
    );
    const pct = Math.min(100, (Number(maxEntry.value) / total) * 100).toFixed(0);
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

export function renderChart(chart: Chart, data: DataRow[], isExpanded: boolean) {
  const h = isExpanded ? 480 : 240;

  // Honor an explicit value-format hint when present. EBPO charts use
  // metric="dynamic", so formatValue can't infer "percent" from the metric name —
  // a % measure (gross margin %, depreciation %) would otherwise render as $/thousands.
  // The EBPO compiler sets display.valueFormat from the measure's catalog format.
  const _vfmt = chart.config.display?.valueFormat ?? null;
  const _vdec = chart.config.display?.valueDecimals ?? null;
  const _metric = chart.config.metric;
  const _grouping = chart.config.grouping;
  const fmtVal = (value: number): string => {
    const n = Number(value) || 0;
    if (_vfmt === "percent") return `${n.toFixed(_vdec ?? 1)}%`;
    if (_vfmt === "currency") return fmtCurrency(n);
    if (_vfmt === "number") return fmtNumber(n);
    // Safety net for dynamic charts with no explicit valueFormat: trust the unit the
    // planner stated in yAxisLabel (e.g. "Gross Margin (%)"). High-precision — never
    // overrides an explicit $/USD unit, so a currency chart can't be mislabeled.
    const _lbl = String(chart.config.yAxisLabel ?? "").toLowerCase();
    if (
      _lbl &&
      !/\busd\b|\(\s*\$\s*\)|dollars?/.test(_lbl) &&
      /%|\bpercent(age)?\b|\bsla\b|\bcsat\b|utili[sz]ation/.test(_lbl)
    )
      return fmtPercent(n);
    return formatValue(_metric, _grouping, n);
  };

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
            {fmtVal(Number.isFinite(numeric) ? numeric : 0)}
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
      : fmtVal(Number(v) || 0);
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
	                fmtVal(Number(v) || 0)
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
    // Series in SQL/select order (= measures[] order): the first is the bar, the
    // rest are lines. EBPO multi-measure combos emit MEASURE-NAMED columns and no
    // "value" column — so hardcoding dataKey="value" drew an empty bar and only one
    // line. Derive the keys from the data instead, preserving order.
    const firstRow = (data[0] ?? {}) as Record<string, unknown>;
    // ClickHouse serializes integer columns (e.g. employee_count) as JSON STRINGS
    // while floats arrive as numbers. A strict typeof==="number" check therefore
    // silently DROPPED the integer series — the reported "combo shows only payroll"
    // bug. Accept any value that parses to a finite number (matches the multi-series
    // path's inferNumericSeriesKeys).
    const orderedKeys = Object.keys(firstRow).filter(
      (k) => k !== "name" && toFiniteNumber(firstRow[k]) !== null,
    );
    const seriesKeys = orderedKeys.length > 0 ? orderedKeys : inferNumericSeriesKeys(data);
    const barKey = seriesKeys.includes("value") ? "value" : (seriesKeys[0] ?? null);
    const lineSeriesKeys = seriesKeys.filter((k) => k !== barKey);
    const lineKey = lineSeriesKeys[0] ?? null;
    // Coerce series values to numbers so Recharts plots string-typed integers.
    const comboData = data.map((r) => {
      const o: Record<string, unknown> = { ...r };
      for (const k of seriesKeys) o[k] = toFiniteNumber(r[k]) ?? 0;
      return o;
    });
    const LINE_COLORS = [
      "rgb(var(--color-accent-cyan))",
      "rgb(var(--color-accent-violet))",
      "rgb(var(--color-accent-blue))",
    ];
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
          <ComposedChart data={comboData} margin={{ top: 8, right: 12, left: 12, bottom: 0 }}>
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
                fmtVal(Number(v) || 0)
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
                    entry?.dataKey === barKey
                      ? fmtVal(Number(value) || 0)
                      : secTick(Number(value) || 0)
                  }
                />
              }
            />
            {barKey && (
              <Bar
                yAxisId="left"
                dataKey={barKey}
                name={barKey === "value" ? "value" : barKey.replace(/_/g, " ")}
                fill={`url(#grad-bar-${chart.id})`}
                radius={[6, 6, 0, 0]}
                maxBarSize={56}
              />
            )}
            {lineSeriesKeys.map((lk, i) => {
              const color = LINE_COLORS[i % LINE_COLORS.length];
              return (
                <Line
                  key={lk}
                  yAxisId="right"
                  type="monotone"
                  dataKey={lk}
                  name={lk.replace(/_/g, " ")}
                  stroke={color}
                  strokeWidth={isExpanded ? 2.5 : 2}
                  dot={isExpanded ? { r: 4, fill: color, strokeWidth: 0 } : false}
                  activeDot={{
                    r: 5,
                    fill: color,
                    strokeWidth: 2,
                    stroke: "rgb(var(--color-bg-card))",
                  }}
                />
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
                    fmtVal(Number(v) || 0)
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
                    formatter={(v: unknown) => fmtVal(Number(v) || 0)}
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
    // ClickHouse returns counts as strings ("154"), so a typeof===number check
    // wrongly rejected x/y and the renderer reordered axes by magnitude (swapping
    // spend↔count) and labelled the axis with the raw key "y". Coerce to numbers,
    // KEEP the SQL's x→horizontal / y→vertical order, and label the axes from the
    // chart's real xAxisLabel/yAxisLabel so the plot matches the heading.
    const num = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const firstRow = data[0] as any;
    const hasXY = firstRow && num(firstRow.x) !== null && num(firstRow.y) !== null;
    const numKeys = inferNumericSeriesKeys(data);
    const xKey = hasXY ? "x" : (numKeys[0] ?? "x");
    const yKey = hasXY ? "y" : (numKeys[1] ?? numKeys[0] ?? "y");
    const nameKey = firstRow && typeof firstRow.name === "string" ? "name" : undefined;
    const points = data.map((d: any) => ({
      ...d,
      [xKey]: num(d[xKey]) ?? 0,
      [yKey]: num(d[yKey]) ?? 0,
    }));

    // Rich visualization: every point gets its own colour, its name printed on
    // the chart, and a colour-coded legend below so the user always knows which
    // dot is which. Labels are only drawn on the chart when the point count is
    // small enough to stay legible; otherwise the legend + tooltip carry it.
    const xLabel = chart.config.xAxisLabel?.trim() || xKey.replaceAll("_", " ");
    const yLabel = chart.config.yAxisLabel?.trim() || yKey.replaceAll("_", " ");
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
              name={xLabel}
              tick={tickStyle}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => fmtNumber(Number(v) || 0)}
              label={{ value: xLabel, position: "insideBottom", offset: -8, fontSize: 10, fill: "rgb(var(--color-text-muted))" }}
            />
            <YAxis
              dataKey={yKey}
              type="number"
              name={yLabel}
              tick={tickStyle}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => fmtNumber(Number(v) || 0)}
              width={64}
              tickMargin={8}
              label={{ value: yLabel, angle: -90, position: "insideLeft", offset: 4, fontSize: 10, fill: "rgb(var(--color-text-muted))" }}
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
            <Scatter data={points as any} fillOpacity={0.9}>
              {points.map((_, i) => (
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
          ? fmtVal(Number(value) || 0)
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
          ? fmtVal(Number(value) || 0)
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
              tickFormatter={(v: number) => fmtVal(v)} />
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
              tickFormatter={(v: number) => fmtVal(v)} />
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
      fmtVal(value);
    const lerp = (from: number, to: number, t: number) =>
      Math.round(from + (to - from) * Math.max(0, Math.min(1, t)));
    const rgb = (r: number, g: number, b: number) => `rgb(${r}, ${g}, ${b})`;
    const conditionalThreshold =
      typeof chart.config.display?.conditionalThreshold === "number"
        ? chart.config.display.conditionalThreshold
        : null;
    const cellTheme = (value: number, highlight: boolean) => {
      if (highlight && chart.config.display?.conditionalColor === "green") {
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

    // Dynamic "above average" conditional highlight (column / row / overall mean).
    const conditionalMode = chart.config.display?.conditionalThresholdMode ?? null;
    const colAverages: Record<string, number> = {};
    colKeys.forEach((key, i) => {
      colAverages[key] = rows.length ? (colTotals[i] ?? 0) / rows.length : 0;
    });
    const overallAverage = rows.length && colKeys.length
      ? grandTotal / (rows.length * colKeys.length)
      : 0;
    const shouldHighlight = (value: number, colKey: string, rowAvg: number) => {
      if (chart.config.display?.conditionalColor !== "green") return false;
      if (conditionalThreshold !== null) return value >= conditionalThreshold;
      if (conditionalMode === "columnAverage") return value > (colAverages[colKey] ?? 0);
      if (conditionalMode === "rowAverage") return value > rowAvg;
      if (conditionalMode === "overallAverage") return value > overallAverage;
      return false;
    };

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
              const rowAvg = colKeys.length
                ? colKeys.reduce((s, k) => s + (Number((row as any)[k]) || 0), 0) /
                  colKeys.length
                : 0;
              return (
                <tr key={rowLabel}>
                  <th className="sticky left-0 z-10 rounded-md border border-default bg-bg-card px-3 py-2 text-left text-[11px] font-semibold text-text-muted shadow-sm">
                    {rowLabel}
                  </th>
                  {colKeys.map((key) => {
                    const value = Number((row as any)[key]) || 0;
                    const theme = cellTheme(value, shouldHighlight(value, key, rowAvg));
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
                    fmtVal(Number(v) || 0)
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
                  fmtVal(Number(v) || 0)
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

function ChartScopeControls({
  data,
  selection,
  onChange,
}: {
  data: DataRow[];
  selection?: ChartScopeSelection;
  onChange: (selection: ChartScopeSelection) => void;
}) {
  const meta = getPeriodMeta(data);
  const active = selection ?? { kind: "all" as const };
  const hasYears = meta.years.length > 1;
  const canUseRange = meta.hasMonthlyData && !!meta.minMonth && !!meta.maxMonth && data.length > 6;
  const months = enumerateMonths(meta.minMonth, meta.maxMonth);
  const [customOpen, setCustomOpen] = useState(false);
  const [editingBoundary, setEditingBoundary] = useState<"start" | "end">("start");
  const custom =
    active.kind === "custom"
      ? clampMonthRange(active.start, active.end, meta.minMonth, meta.maxMonth)
      : clampMonthRange(meta.minMonth ?? "", meta.maxMonth ?? "", meta.minMonth, meta.maxMonth);
  const customYears = Array.from(new Set(months.map((month) => month.slice(0, 4))));
  const allowedCustomYears =
    editingBoundary === "end"
      ? customYears.filter((year) => year >= custom.start.slice(0, 4))
      : customYears;
  const activeCustomYear =
    (editingBoundary === "start" ? custom.start : custom.end).slice(0, 4) ||
    allowedCustomYears[0] ||
    "";
  const visibleCustomMonths = months.filter((month) => month.startsWith(activeCustomYear));
  const customLabel =
    active.kind === "custom"
      ? `${formatMonthKey(custom.start)} - ${formatMonthKey(custom.end)}`
      : "Custom period";

  if (!hasYears && !canUseRange) return null;

  return (
    <div
      className="mb-3 rounded-xl border border-default bg-bg-elevated/35 p-2"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 inline-flex items-center gap-1 rounded-lg bg-bg-card px-2 py-1 text-[9px] font-bold uppercase tracking-[0.18em] text-text-muted ring-1 ring-default">
          <CalendarRange size={10} />
          Scope
        </span>
        <button
          type="button"
          onClick={() => onChange({ kind: "all" })}
          className={cn(
            "rounded-lg px-2 py-1 text-[10px] font-semibold transition-colors",
            active.kind === "all"
              ? "bg-text-primary text-bg-card"
              : "bg-bg-card text-text-secondary ring-1 ring-default hover:text-text-primary",
          )}
        >
          All
        </button>
        {hasYears &&
          meta.years.map((year) => (
            <button
              type="button"
              key={year}
              onClick={() => onChange({ kind: "year", year })}
              className={cn(
                "rounded-lg px-2 py-1 text-[10px] font-semibold transition-colors",
                active.kind === "year" && active.year === year
                  ? "bg-accent-cyan text-bg-card"
                  : "bg-bg-card text-text-secondary ring-1 ring-default hover:text-text-primary",
              )}
            >
              {year}
            </button>
          ))}
        {canUseRange && (
          <>
            <button
              type="button"
              onClick={() => onChange({ kind: "preset", months: 6 })}
              className={cn(
                "rounded-lg px-2 py-1 text-[10px] font-semibold transition-colors",
                active.kind === "preset" && active.months === 6
                  ? "bg-accent-violet text-white"
                  : "bg-bg-card text-text-secondary ring-1 ring-default hover:text-text-primary",
              )}
            >
              Last 6M
            </button>
            <button
              type="button"
              onClick={() => onChange({ kind: "preset", months: 12 })}
              className={cn(
                "rounded-lg px-2 py-1 text-[10px] font-semibold transition-colors",
                active.kind === "preset" && active.months === 12
                  ? "bg-accent-violet text-white"
                  : "bg-bg-card text-text-secondary ring-1 ring-default hover:text-text-primary",
              )}
            >
              Last 12M
            </button>
            <div>
              <button
                type="button"
                onClick={() => setCustomOpen((open) => !open)}
                className={cn(
                  "rounded-lg px-2 py-1 text-[10px] font-semibold transition-colors",
                  active.kind === "custom"
                    ? "bg-accent-cyan/12 text-accent-cyan ring-1 ring-accent-cyan/30"
                    : "bg-bg-card text-text-secondary ring-1 ring-default hover:text-text-primary",
                )}
              >
                {customLabel}
              </button>

              {customOpen && typeof document !== "undefined" ? createPortal(
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm">
                  <div
                    className="w-full max-w-sm rounded-2xl border border-default bg-bg-card p-4 shadow-2xl shadow-black/50"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div>
                        <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-text-muted">
                          Custom period
                        </p>
                        <p className="mt-0.5 text-xs font-semibold text-text-secondary">
                          {editingBoundary === "start"
                            ? "Choose a start month"
                            : `Choose an end month after ${formatMonthKey(custom.start)}`}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        {active.kind === "custom" && (
                          <button
                            type="button"
                            onClick={() => {
                              onChange({ kind: "all" });
                              setCustomOpen(false);
                            }}
                            className="rounded-md bg-bg-elevated px-2 py-1 text-[10px] font-semibold text-text-muted hover:text-text-primary"
                          >
                            Reset
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setCustomOpen(false)}
                          className="rounded-md bg-accent-cyan/10 px-2 py-1 text-[10px] font-semibold text-accent-cyan hover:bg-accent-cyan/15"
                        >
                          Done
                        </button>
                      </div>
                    </div>

                    <div className="mb-3 grid grid-cols-2 gap-1 rounded-lg bg-bg-elevated/60 p-1">
                      {(["start", "end"] as const).map((bound) => (
                        <button
                          type="button"
                          key={bound}
                          onClick={() => setEditingBoundary(bound)}
                          className={cn(
                            "rounded-md px-2 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] transition-colors",
                            editingBoundary === bound
                              ? "bg-text-primary text-bg-card"
                              : "text-text-muted hover:text-text-primary",
                          )}
                        >
                          {bound === "start" ? "From" : "To"}
                        </button>
                      ))}
                    </div>

                    <div className="mb-2 flex flex-wrap gap-1">
                      {allowedCustomYears.map((year) => (
                        <button
                          type="button"
                          key={year}
                          onClick={() => {
                            const month = `${year}-${(editingBoundary === "start" ? custom.start : custom.end).slice(5, 7)}`;
                            const fallback = months.find((item) => item.startsWith(year)) ?? month;
                            const boundedFallback =
                              editingBoundary === "end" && fallback < custom.start ? custom.start : fallback;
                            const next =
                              editingBoundary === "start"
                                ? clampMonthRange(fallback, custom.end, meta.minMonth, meta.maxMonth)
                                : clampMonthRange(custom.start, boundedFallback, meta.minMonth, meta.maxMonth);
                            onChange({ kind: "custom", ...next });
                          }}
                          className={cn(
                            "rounded-md px-2 py-1 text-[10px] font-semibold transition-colors",
                            activeCustomYear === year
                              ? "bg-accent-cyan/12 text-accent-cyan ring-1 ring-accent-cyan/30"
                              : "bg-bg-elevated text-text-muted hover:text-text-primary",
                          )}
                        >
                          {year}
                        </button>
                      ))}
                    </div>

                    <div className="grid grid-cols-4 gap-1">
                      {visibleCustomMonths.map((month) => {
                        const isSelected = editingBoundary === "start" ? custom.start === month : custom.end === month;
                        const isDisabled = editingBoundary === "end" && month < custom.start;
                        const monthName = formatMonthKey(month).split(" ")[0];
                        return (
                          <button
                            type="button"
                            key={month}
                            disabled={isDisabled}
                            onClick={() => {
                              if (isDisabled) return;
                              const next =
                                editingBoundary === "start"
                                  ? clampMonthRange(month, custom.end < month ? month : custom.end, meta.minMonth, meta.maxMonth)
                                  : clampMonthRange(custom.start, month, meta.minMonth, meta.maxMonth);
                              onChange({ kind: "custom", ...next });
                              if (editingBoundary === "start") setEditingBoundary("end");
                            }}
                            className={cn(
                              "rounded-lg px-2 py-2 text-[10px] font-semibold transition-colors",
                              isDisabled && "cursor-not-allowed opacity-30",
                              isSelected
                                ? "bg-accent-cyan text-bg-card"
                                : "bg-bg-elevated/70 text-text-secondary hover:text-text-primary",
                            )}
                          >
                            {monthName}
                          </button>
                        );
                      })}
                    </div>

                    <div className="mt-3 flex items-center justify-between border-t border-default pt-2">
                      <button
                        type="button"
                        onClick={() => {
                          onChange({ kind: "all" });
                          setCustomOpen(false);
                        }}
                        className="text-[10px] font-semibold text-text-muted hover:text-text-primary"
                      >
                        Clear filter
                      </button>
                      <button
                        type="button"
                        onClick={() => setCustomOpen(false)}
                        className="text-[10px] font-semibold text-accent-cyan hover:text-text-primary"
                      >
                        Apply
                      </button>
                    </div>
                  </div>
                </div>,
                document.body,
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ChartCard({
  chart,
  data,
  fullData,
  meta,
  scopeSelection,
  index,
  onExpand,
  onScopeChange,
  onDelete,
}: {
  chart: Chart;
  data: DataRow[];
  fullData: DataRow[];
  meta?: ChartDataMeta;
  scopeSelection?: ChartScopeSelection;
  index: number;
  onExpand: () => void;
  onScopeChange: (selection: ChartScopeSelection) => void;
  onDelete?: () => void;
}) {
  const isEmpty = data.length === 0;
  const rangeNotice = meta?.rangeNotice ?? chart.rangeNotice ?? null;

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
        <div className="flex shrink-0 items-center gap-1">
          {onDelete && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              aria-label={`Delete ${chart.title}`}
              title="Delete chart"
              className="rounded-md p-1 text-text-muted opacity-0 transition-all hover:bg-feedback-danger/10 hover:text-feedback-danger focus-visible:opacity-100 group-hover:opacity-100"
            >
              <Trash2 size={13} />
            </button>
          )}
          {!isEmpty && (
            <Maximize2
              size={12}
              className="mt-0.5 text-text-muted opacity-0 transition-opacity group-hover:opacity-100"
            />
          )}
        </div>
      </div>

      <ChartScopeControls
        data={fullData}
        selection={scopeSelection}
        onChange={onScopeChange}
      />

      {rangeNotice && (
        <div className="mb-3 rounded-xl border border-accent-cyan/25 bg-accent-cyan/8 px-3 py-2 text-[11px] font-semibold leading-relaxed text-accent-cyan">
          {rangeNotice}
        </div>
      )}

      {/* Chart */}
      <div className="min-h-0 flex-1 pointer-events-none">
        {isEmpty ? (
          <div className="flex h-full min-h-[160px] items-center justify-center rounded-xl bg-bg-elevated/30">
            <p className="text-xs text-text-muted text-center px-4">
              {rangeNotice ?? getEmptyMessage(chart)}
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
        <span className="shrink-0 rounded-full bg-bg-elevated px-2.5 py-0.5 text-[10px] font-semibold text-text-muted ring-1 ring-default">
          {describeScope(scopeSelection, data)}
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
  chartDataMeta,
  chartScopes,
  isHistorical = false,
  onExpandChart,
  onScopeChange,
  onDeleteChart,
}: {
  version: ChartVersionSnapshot | null;
  charts: Chart[];
  chartData: Record<string, DataRow[]>;
  chartDataMeta: Record<string, ChartDataMeta>;
  chartScopes: Record<string, ChartScopeSelection>;
  isHistorical?: boolean;
  onExpandChart: (chartId: string) => void;
  onScopeChange: (chartId: string, selection: ChartScopeSelection) => void;
  onDeleteChart?: (chart: Chart) => void;
}) {
  const versionLabel = version ? `Chart v${version.versionNumber}` : "Current dashboard";
  const modeLabel = version
    ? version.mode === "edit"
      ? "updated chart"
      : "new chart"
    : "latest charts";

  return (
    <div
      className={cn(
        "rounded-2xl border border-default bg-bg-elevated/20 p-4",
        isHistorical && "border-dashed opacity-75",
      )}
    >
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
          {isHistorical && (
            <span className="rounded-full bg-bg-elevated px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
              history only
            </span>
          )}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4">
        {charts.length === 0 ? (
          <div className="rounded-xl border border-default bg-bg-card/60 px-4 py-5">
            <p className="text-sm font-semibold text-text-primary">
              No charts yet
            </p>
            <p className="mt-1 text-xs leading-relaxed text-text-muted">
              This dashboard doesn&apos;t have any charts. Ask the agent to build one to get started.
            </p>
          </div>
        ) : charts.map((chart, index) => {
          const fullData = chartData[chart.id] ?? [];
          const scopeSelection = chartScopes[chart.id] ?? defaultScopeFromTimeRange(chart.config.timeRange);
          const scopedData = filterRowsByScope(fullData, scopeSelection);
          return (
            <ChartCard
              key={chart.id}
              chart={chart}
              data={scopedData}
              fullData={fullData}
              meta={chartDataMeta[chart.id]}
              scopeSelection={scopeSelection}
              index={index}
              onExpand={() => onExpandChart(chart.id)}
              onScopeChange={(selection) => onScopeChange(chart.id, selection)}
              onDelete={
                onDeleteChart && chart.widgetId ? () => onDeleteChart(chart) : undefined
              }
            />
          );
        })}
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
  const [chartDataMeta, setChartDataMeta] = useState<Record<string, ChartDataMeta>>({});
  const [chartScopes, setChartScopes] = useState<Record<string, ChartScopeSelection>>({});
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedChartId, setExpandedChartId] = useState<string | null>(null);
  // Widget ids optimistically hidden while a header-delete is pending (or until
  // the server-confirmed refetch lands). Lets the card disappear immediately
  // while the actual DELETE is deferred behind the undo window.
  const [hiddenWidgetIds, setHiddenWidgetIds] = useState<Set<string>>(new Set());
  const [refreshNonce, setRefreshNonce] = useState(0);
  const prevSessionRef = useRef<string | null | undefined>(sessionId);

  // Switching chats (or starting a new one) must NOT keep showing the previous
  // dashboard's charts. Clear immediately so the loading/generating skeleton is
  // shown until the new session's dashboard arrives.
  if (prevSessionRef.current !== sessionId) {
    prevSessionRef.current = sessionId;
    if (dashboard !== null) setDashboard(null);
    if (chartVersions.length > 0) setChartVersions([]);
    if (Object.keys(chartData).length > 0) setChartData({});
    if (Object.keys(chartDataMeta).length > 0) setChartDataMeta({});
    if (Object.keys(chartScopes).length > 0) setChartScopes({});
    if (showVersionHistory) setShowVersionHistory(false);
    setExpandedChartId(null);
    if (hiddenWidgetIds.size > 0) setHiddenWidgetIds(new Set());
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
            widgetId: c.id,
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
          const metaMap: Record<string, ChartDataMeta> = {};
          for (const chart of chartsToLoad) {
            if (Array.isArray(chart.snapshotData) && chart.snapshotData.length > 0) {
              dataMap[chart.id] = chart.snapshotData;
            }
            if (chart.rangeNotice || chart.requestedRangeLabel || chart.availableRange) {
              metaMap[chart.id] = {
                rangeNotice: chart.rangeNotice,
                requestedRangeLabel: chart.requestedRangeLabel,
                availableRange: chart.availableRange,
              };
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
                if (res.rangeNotice || res.requestedRangeLabel || res.availableRange) {
                  metaMap[chart.id] = {
                    rangeNotice: res.rangeNotice ?? null,
                    requestedRangeLabel: res.requestedRangeLabel ?? null,
                    availableRange: res.availableRange ?? null,
                  };
                }
              } catch {
                dataMap[chart.id] = [];
              }
              }),
          );
          setChartData(dataMap);
          setChartDataMeta(metaMap);
          // Server state is now authoritative: drop any optimistic hides whose
          // widget is no longer present (i.e. the delete went through).
          setHiddenWidgetIds((prev) => {
            if (prev.size === 0) return prev;
            const liveWidgetIds = new Set(
              chartsToLoad
                .map((chart) => chart.widgetId)
                .filter((id): id is string => typeof id === "string"),
            );
            const next = new Set([...prev].filter((id) => liveWidgetIds.has(id)));
            return next.size === prev.size ? prev : next;
          });
          setChartScopes((current) => {
            const validIds = new Set(chartsToLoad.map((chart) => chart.id));
            return Object.fromEntries(
              Object.entries(current).filter(([chartId]) => validIds.has(chartId)),
            );
          });
        } else {
          setDashboard(null);
          setChartVersions([]);
          setChartData({});
          setChartDataMeta({});
          setChartScopes({});
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
  }, [agent, loading, triggerSync, sessionId, liveChartTurn, refreshNonce]);

  // Header delete: hide the card immediately, then fire the real DELETE only
  // after the undo window closes. Undo just cancels the pending timer, so no
  // re-create is ever needed (the deletion never left the client).
  const handleRequestDelete = (chart: Chart) => {
    const widgetId = chart.widgetId;
    if (!sessionId || !widgetId) return;

    setHiddenWidgetIds((prev) => new Set(prev).add(widgetId));

    const unhide = () =>
      setHiddenWidgetIds((prev) => {
        if (!prev.has(widgetId)) return prev;
        const next = new Set(prev);
        next.delete(widgetId);
        return next;
      });

    const timer = setTimeout(async () => {
      try {
        await agent.deleteSessionChart(sessionId, widgetId);
        // Pull the new version from the server; the prune step clears the hide.
        setRefreshNonce((n) => n + 1);
      } catch {
        unhide();
        toast.error("Couldn't delete the chart — it's back on your dashboard.");
      }
    }, 5000);

    toast(`Deleted “${chart.title}”`, {
      duration: 5000,
      action: {
        label: "Undo",
        onClick: () => {
          clearTimeout(timer);
          unhide();
        },
      },
    });
  };

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

  const sortedVersions =
    chartVersions.length > 0
      ? chartVersions.slice().sort((a, b) => b.versionNumber - a.versionNumber)
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
  // The "live" view is the newest version that still has charts. If the most
  // recent edit removed its chart, fall back to the most recent prior version
  // that still has one instead of dead-ending on an empty dashboard. The empty
  // state only shows when no version anywhere has a chart (a genuine zero).
  const newestVersion = sortedVersions[0] ?? null;
  const liveVersion = sortedVersions.find((version) => version.charts.length > 0) ?? newestVersion;
  const latestRemovedActive =
    !!newestVersion && !!liveVersion && newestVersion.versionNumber !== liveVersion.versionNumber;
  // History excludes the live version and any empty versions, so a removed-chart
  // edit never renders as an "empty" history card.
  const historyVersions = sortedVersions.filter(
    (version) => version !== liveVersion && version.charts.length > 0,
  );
  const visibleVersions = [
    ...(liveVersion ? [liveVersion] : []),
    ...(showVersionHistory ? historyVersions : []),
  ];
  const latestVersionNumber = liveVersion?.versionNumber ?? null;
  const visibleCharts = visibleVersions.flatMap((version) => version.charts);
  const expandedChart = visibleCharts.find((c) => c.id === expandedChartId);
  const expandedFullData = expandedChart ? (chartData[expandedChart.id] ?? []) : [];
  const expandedScope = expandedChart
    ? (chartScopes[expandedChart.id] ?? defaultScopeFromTimeRange(expandedChart.config.timeRange))
    : undefined;
  const expandedData = filterRowsByScope(expandedFullData, expandedScope);

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

      {latestRemovedActive && liveVersion ? (
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-start gap-2.5 rounded-2xl border border-accent-cyan/25 bg-accent-cyan/5 px-4 py-3"
        >
          <History size={14} className="mt-0.5 shrink-0 text-accent-cyan" />
          <p className="text-xs leading-relaxed text-text-secondary">
            The latest edit removed its chart. Showing{" "}
            <span className="font-semibold text-text-primary">v{liveVersion.versionNumber}</span> — the
            most recent chart still active.
          </p>
        </motion.div>
      ) : null}

      {chartVersions.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-default bg-bg-elevated/25 px-4 py-3">
          <p className="text-xs text-text-muted">
            Showing the live dashboard only. Previous versions are review-only history.
          </p>
          {historyVersions.length > 0 ? (
            <button
              type="button"
              onClick={() => setShowVersionHistory((open) => !open)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-default bg-bg-card/60 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-text-secondary transition-colors hover:border-accent-cyan/40 hover:text-accent-cyan"
            >
              <History size={12} />
              {showVersionHistory ? "Hide history" : `Show history (${historyVersions.length})`}
              <ChevronDown
                size={12}
                className={cn("transition-transform", showVersionHistory && "rotate-180")}
              />
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Chart history — each version stacks downward in the live dashboard */}
      <div className="space-y-4 pb-8">
        {visibleVersions.map((version, index) => (
          <div key={`${version.versionNumber}-${version.dashboardTitle}`} className="space-y-4">
            {showVersionHistory && index === 1 ? (
              <div className="flex items-center gap-3 px-1">
                <div className="h-px flex-1 bg-text-muted/20" />
                <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-text-muted">
                  Previous versions
                </span>
                <div className="h-px flex-1 bg-text-muted/20" />
              </div>
            ) : null}
            <VersionSection
              version={version.versionNumber > 0 ? version : null}
              charts={version.charts.filter(
                (chart) => !chart.widgetId || !hiddenWidgetIds.has(chart.widgetId),
              )}
              chartData={chartData}
              chartDataMeta={chartDataMeta}
              chartScopes={chartScopes}
              isHistorical={latestVersionNumber !== null && version.versionNumber !== latestVersionNumber}
              onExpandChart={(chartId) => setExpandedChartId(chartId)}
              onScopeChange={(chartId, selection) =>
                setChartScopes((current) => ({ ...current, [chartId]: selection }))
              }
              // Delete is only offered on the genuine live version — never on a
              // previous-version fallback (those charts aren't live) or history.
              onDeleteChart={
                !!sessionId &&
                !latestRemovedActive &&
                latestVersionNumber !== null &&
                version.versionNumber === latestVersionNumber
                  ? handleRequestDelete
                  : undefined
              }
            />
          </div>
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
                <div className="mt-4">
                  <ChartScopeControls
                    data={expandedFullData}
                    selection={expandedScope}
                    onChange={(selection) =>
                      expandedChart &&
                      setChartScopes((current) => ({ ...current, [expandedChart.id]: selection }))
                    }
                  />
                </div>
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
