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
  ReferenceArea,
  ReferenceDot,
  Treemap,
  ScatterChart,
  Scatter,
  ComposedChart,
  RadialBarChart,
  RadialBar,
  LabelList,
  RadarChart,
  Radar,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  FunnelChart,
  Funnel,
  Sankey as RechartsSankey,
} from "recharts";
import { ApiError, type ChatMessage, type TimeRange } from "../../../lib/api";
import type { FigureEvidence } from "../../../lib/api/types";
import { useNumeriquApi } from "../../../lib/useNumeriquApi";
import { ProvenanceDrawer } from "./ProvenanceDrawer";
import { EmptyState } from "../../../components/ui/EmptyState";
import { ErrorBanner } from "../../../components/ui/ErrorBanner";
import { cn } from "../../../components/ui/cn";
import { toFiniteNumber } from "../_lib/parse-number";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface ChartConfig {
  metric: string;
  grouping: string;
  // Autonomous chart widgets retain their validated engine spec alongside the
  // display hints. The renderer uses the original requested type when a stacked
  // chart is promoted to a combo for a secondary-axis overlay.
  spec?: {
    chartType?: string | null;
    highlightCostWithoutRevenue?: boolean | null;
    highlightLowPerformance?: boolean | null;
  } | null;
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
    showAllSeries?: boolean | null;
    highlightSeries?: string[] | null;
    highlightNames?: string[] | null;
    labelSeries?: string | null;
    referenceAxis?: "left" | "right" | null;
    labelMode?: "percent" | "value" | null;
    labelFormat?: "currency" | "number" | "percent" | null;
    // Surface data labels on line/area/bar/combo charts when the user explicitly
    // asks for them. Dense charts still degrade to sparse/latest-only labels so the
    // frontend never renders unreadable overlaps.
    showDataLabels?: boolean | null;
    // Layer D follow-up render hints.
    normalized?: boolean | null; // values are 0–100 %, format axis as %
    referenceSeries?: string | null; // column drawn as a flat reference line, not a series
    movingAverageSuffix?: string | null; // series ending in this suffix render dashed
    secondaryAxisFormat?: "number" | "currency" | "percent" | null; // combo right-axis format
    secondaryLabel?: string | null; // combo second-measure label
    // Per-series roles for multi-measure combos: draw N clustered bars + M lines on
    // the correct axes. When present this fully drives the combo renderer.
    series?: Array<{
      key: string;
      role: "bar" | "line";
      axis: "left" | "right";
      format: "currency" | "number" | "percent";
      decimals?: number | null;
    }> | null;
    valueFormat?: "currency" | "number" | "percent" | null; // primary value unit (EBPO dynamic charts)
    valueDecimals?: number | null; // decimals for the primary value (e.g. 1 for %)
    requestedChartLabel?: string | null;
    colorMetric?: string | null; // treemap color channel; size still comes from value
    colorMetricLabel?: string | null;
    colorMetricFormat?: "currency" | "number" | "percent" | null;
    showTotals?: boolean | null; // matrix/heatmap totals are rendered when true/default
    conditionalThreshold?: number | null; // matrix cells at/above this value use conditional color
    conditionalThresholdMode?:
      | "columnAverage"
      | "rowAverage"
      | "overallAverage"
      | null; // dynamic "above average" highlight
    conditionalColor?: "green" | "red" | null;
    // Heatmap/matrix: ring-highlight the highest and/or lowest cell.
    highlightExtremes?: "max" | "min" | "both" | null;
    // Line/area/bar: mark negative datapoints red and draw a zero baseline.
    highlightNegative?: boolean;
    highlightTopN?: number;
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

  return (
    Array.from(totals.entries())
      // Drop series that are zero/empty in every row — they add a flat-zero line or
      // bar (e.g. a date-null vendor, or a split the data doesn't have) and read as
      // a broken chart. A series with no data shouldn't be plotted.
      .filter(([, total]) => total > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([k]) => k)
  );
}

function inferHeatmapSeriesKeys(rows: DataRow[]): string[] {
  const seriesKeys = inferNumericSeriesKeys(rows).filter(
    (key) => key !== "total",
  );
  if (seriesKeys.length > 0) return seriesKeys;
  if (hasFiniteValueKey(rows, "value")) return ["value"];
  if (hasFiniteValueKey(rows, "total")) return ["total"];
  return [];
}

function toSeriesKey(value: unknown): string {
  return (
    String(value ?? "series")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "series"
  );
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
  return (
    !!metadata &&
    typeof metadata === "object" &&
    (metadata as ChartTurnMetadata).kind === "chart_turn"
  );
}

function buildChartVersionHistory(
  messages: ChatMessage[],
): ChartVersionSnapshot[] {
  const versions: ChartVersionSnapshot[] = [];

  for (const message of messages) {
    if (message.role !== "assistant" || !isChartTurnMetadata(message.metadata))
      continue;

    const metadata = message.metadata;
    const versionNumber = Number(metadata.versionNumber ?? 0);
    if (!Number.isFinite(versionNumber) || versionNumber < 1) continue;

    const charts: Chart[] = [];
    for (const [widgetIndex, widget] of (
      metadata.widgetSnapshots ?? []
    ).entries()) {
      const title = String(widget.title ?? `Chart ${widgetIndex + 1}`).trim();
      if (!title) continue;

      const queryConfig = widget.queryConfig ?? {};
      const chartConfigSource = widget.chartConfig ?? {};
      const displayFromQuery = queryConfig.display as ChartConfig["display"];
      const displayFromChart =
        chartConfigSource.display as ChartConfig["display"];
      const chartConfig = {
        ...(queryConfig as Record<string, unknown>),
        ...(typeof chartConfigSource.description === "string"
          ? { description: chartConfigSource.description }
          : {}),
        // Follow-up edits enrich chartConfig.display with render-only metadata
        // (secondary axis formats, per-series units, requested chart label, etc.)
        // while queryConfig.display often carries only the base metric format.
        // Preserve both by layering query display under chart display.
        display:
          displayFromQuery || displayFromChart
            ? {
                ...(displayFromQuery ?? {}),
                ...(displayFromChart ?? {}),
              }
            : null,
      } as unknown as ChartConfig;
      const chartDescription =
        typeof chartConfigSource.description === "string"
          ? chartConfigSource.description
          : (metadata.summary ?? "");

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

  return Array.from(merged.values()).sort(
    (a, b) => a.versionNumber - b.versionNumber,
  );
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
      return new Date(
        Date.UTC(Number(isoMonth[1]), Number(isoMonth[2]) - 1, 1),
      );
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
      if (month >= 0)
        return new Date(Date.UTC(Number(shortMonth[2]), month, 1));
    }

    const numericMonth = text.match(/^(\d{1,2})\/(\d{2}|\d{4})$/);
    if (numericMonth) {
      const month = Number(numericMonth[1]);
      const rawYear = Number(numericMonth[2]);
      const year = rawYear < 100 ? 2000 + rawYear : rawYear;
      if (month >= 1 && month <= 12)
        return new Date(Date.UTC(year, month - 1, 1));
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
  const years = Array.from(new Set(dates.map((d) => d.getUTCFullYear()))).sort(
    (a, b) => a - b,
  );
  const months = dates.map(monthKey).sort();
  const uniqueMonths = Array.from(new Set(months));
  return {
    years,
    minMonth: uniqueMonths[0] ?? null,
    maxMonth: uniqueMonths[uniqueMonths.length - 1] ?? null,
    hasMonthlyData: uniqueMonths.length > years.length,
  };
}

function filterRowsByScope(
  data: DataRow[],
  selection?: ChartScopeSelection,
): DataRow[] {
  if (!selection || selection.kind === "all") return data;

  const dated = data
    .map((row) => ({ row, date: parsePointDate(row) }))
    .filter((item): item is { row: DataRow; date: Date } => !!item.date);
  if (dated.length === 0) return data;

  if (selection.kind === "year") {
    return dated
      .filter((item) => item.date.getUTCFullYear() === selection.year)
      .map((item) => item.row);
  }

  if (selection.kind === "preset") {
    const maxDate = dated.reduce(
      (latest, item) => (item.date > latest ? item.date : latest),
      dated[0]!.date,
    );
    const start = new Date(
      Date.UTC(
        maxDate.getUTCFullYear(),
        maxDate.getUTCMonth() - selection.months + 1,
        1,
      ),
    );
    return dated
      .filter((item) => item.date >= start && item.date <= maxDate)
      .map((item) => item.row);
  }

  const start = selection.start
    ? new Date(`${selection.start}-01T00:00:00.000Z`)
    : null;
  const end = selection.end
    ? new Date(`${selection.end}-01T00:00:00.000Z`)
    : null;
  return dated
    .filter(
      (item) => (!start || item.date >= start) && (!end || item.date <= end),
    )
    .map((item) => item.row);
}

function describeScope(
  selection: ChartScopeSelection | undefined,
  data: DataRow[],
): string {
  if (!selection || selection.kind === "all") return `${data.length} points`;
  if (selection.kind === "year")
    return `${selection.year} · ${data.length} points`;
  if (selection.kind === "preset")
    return `Last ${selection.months} months · ${data.length} points`;
  if (selection.start && selection.end)
    return `${selection.start} to ${selection.end} · ${data.length} points`;
  return `${data.length} points`;
}

function defaultScopeFromTimeRange(
  range: TimeRange | null | undefined,
): ChartScopeSelection | undefined {
  if (!range || range.kind === "ALL_TIME") return undefined;
  if (range.kind === "LAST_N_MONTHS")
    return { kind: "preset", months: range.months };
  if (range.kind === "BETWEEN_DATES")
    return {
      kind: "custom",
      start: range.start.slice(0, 7),
      end: range.end.slice(0, 7),
    };
  if (range.kind === "SINCE_DATE")
    return {
      kind: "custom",
      start: range.start.slice(0, 7),
      end: range.start.slice(0, 7),
    };
  if (range.kind === "YTD")
    return { kind: "preset", months: new Date().getUTCMonth() + 1 };
  return undefined;
}

function monthKeyToDate(key: string): Date | null {
  const match = key.match(/^((?:19|20)\d{2})-(\d{2})$/);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
}

function formatMonthKey(
  key: string,
  variant: "short" | "long" = "short",
): string {
  const date = monthKeyToDate(key);
  if (!date) return key;
  return new Intl.DateTimeFormat("en-US", {
    month: variant === "short" ? "short" : "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function enumerateMonths(
  minMonth: string | null,
  maxMonth: string | null,
): string[] {
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
  const ordered =
    safeStart <= safeEnd
      ? { start: safeStart, end: safeEnd }
      : { start: safeEnd, end: safeStart };
  return {
    start: minMonth && ordered.start < minMonth ? minMonth : ordered.start,
    end: maxMonth && ordered.end > maxMonth ? maxMonth : ordered.end,
  };
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function prettyChartType(chart: Chart): string {
  const requested = chart.config.display?.requestedChartLabel?.trim();
  if (requested) return requested;
  const descriptionText =
    `${chart.description ?? ""} ${chart.title ?? ""}`.toLowerCase();
  if (/\bstacked\s+column\b/.test(descriptionText)) return "Stacked column";
  if (/\bclustered\s+column\b/.test(descriptionText)) return "Clustered column";
  if (/\bcolumn\s+chart\b|\bcolumn\b/.test(descriptionText))
    return "Column chart";
  const t = String(getEffectiveChartType(chart) || "").toLowerCase();
  if (t === "bar") return "Bar chart";
  if (t === "stacked_bar") return "Stacked bar";
  if (t === "horizontal_bar") return "Ranked bar";
  if (t === "line") return "Line chart";
  if (t === "combo") return "Combo chart";
  if (t === "pie") return "Pie chart";
  if (t === "donut") return "Donut chart";
  if (t === "area") return "Area chart";
  if (t === "stacked_area") return "Stacked area";
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

function getEffectiveChartType(chart: Chart): string {
  const declared = String(chart.type || "").toLowerCase();
  const series = Array.isArray(chart.config.display?.series)
    ? chart.config.display?.series
    : [];
  const hasLineRole = series.some((s) => s?.role === "line");
  // Follow-up edits can keep the original base type ("bar") while attaching
  // display.series metadata that explicitly says one or more measures are lines.
  // If we keep trusting only chart.type, the renderer drops the line and the UI
  // says "updated" while still showing the old bar-only visual.
  if ((declared === "bar" || declared === "stacked_bar") && hasLineRole)
    return "combo";
  return declared;
}

function fmtCurrency(value: number): string {
  // Null-safe: a single missing/NaN value must never crash the whole dashboard.
  const v = Number(value);
  if (!Number.isFinite(v)) return "$0";
  // Abbreviate by MAGNITUDE so negatives match positives (−$87.6M, not −$87,596,173).
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000)
    return `${sign}$${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: abs < 100 ? 2 : 0,
  }).format(v);
}

function fmtNumber(value: number): string {
  const v = Number(value);
  if (!Number.isFinite(v)) return "0";
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000)
    return `${sign}${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
  // Preserve meaningful precision for ratios and fractional operational
  // measures. Integer counts stay integer while values such as 0.472 no longer
  // collapse to the misleading display value 0.
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
  }).format(v);
}

function fmtPercent(value: number): string {
  const v = Number(value);
  if (!Number.isFinite(v)) return "0%";
  return `${v.toFixed(1)}%`;
}

function isRiskHeatmapMetric(metric: string, title?: string | null): boolean {
  const text = `${metric ?? ""} ${title ?? ""}`.toLowerCase();
  return /\boverdue\b|\bpast\s+due\b|\bdelinq(?:uent|uency)?\b|\barrears?\b|\blate\s+payment\b|\bunpaid\b|\bnonpayment\b|\bbad\s+debt\b|\brisk\b|\bloss(?:es)?\b|\bdeficit\b|\bshortfall\b/.test(
    text,
  );
}

function heatmapPalette(
  metric: string,
  title?: string | null,
  conditionalColor?: "green" | "red" | null,
): "green" | "red" {
  if (conditionalColor === "red" || conditionalColor === "green")
    return conditionalColor;
  return isRiskHeatmapMetric(metric, title) ? "red" : "green";
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

const CustomTooltip = ({
  active,
  payload,
  label,
  metric,
  grouping,
  valueFormatter,
}: any) => {
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
                  if (typeof valueFormatter === "function") {
                    return valueFormatter(entry.value, entry);
                  }
                  // Per-series unit: a series whose NAME marks it a percentage (e.g.
                  // "Gross Margin %") must format as % even inside a $ combo — the
                  // chart-level valueFormatter would otherwise label it as dollars.
                  const _nm = String(entry.name ?? "").toLowerCase();
                  const _isPct =
                    !/\busd\b|\$/.test(_nm) &&
                    /%|\bpercent(age)?\b|\bsla\b|\bcsat\b|utili[sz]ation/.test(
                      _nm,
                    );
                  if (_isPct) return fmtPercent(entry.value);
                  return formatValue(
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
      {typeof payload[0]?.payload?.["Largest Client"] === "string" && (
        <p className="mt-1.5 border-t border-default/60 pt-1.5 text-[10px] font-semibold text-text-muted">
          Largest client:{" "}
          <span className="text-text-secondary">
            {payload[0].payload["Largest Client"]}
          </span>
        </p>
      )}
    </div>
  );
};

const PieTooltip = ({ active, payload, metric, grouping, labelMode }: any) => {
  if (!active || !payload?.length) return null;
  const entry = payload[0];
  const total = entry?.payload?.total;
  const pct = total ? ((entry.value / total) * 100).toFixed(1) : null;
  const displayValue =
    typeof entry?.payload?.rawValue === "number"
      ? entry.payload.rawValue
      : typeof entry?.payload?.raw_value === "number"
        ? entry.payload.raw_value
        : entry.value;
  return (
    <div className="rounded-xl border border-default bg-bg-card/95 p-3 shadow-2xl backdrop-blur-sm">
      <p className="text-xs font-bold text-text-primary">{entry.name}</p>
      <p className="text-xs text-text-secondary">
        {typeof displayValue === "number"
          ? formatValue(
              String(metric ?? ""),
              String(grouping ?? ""),
              displayValue,
            )
          : displayValue}
        {pct && labelMode !== "value" ? ` · ${pct}%` : ""}
      </p>
    </div>
  );
};

// ─── Per-Chart Insight Bar ────────────────────────────────────────────────────

// Does the chart's x-axis (the `name` column) read as a chronological time axis?
// Months ("Jan", "Jan 2022"), quarters ("Q1 2022"), bare years ("2022"), or ISO
// dates count as time; client/account/country labels do not. Used to gate the
// "growth over period" line caption so it never fires on a categorical line.
function isTimeAxisLabels(data: DataRow[]): boolean {
  const names = data
    .map((d) => (d as { name?: unknown }).name)
    .filter((n): n is string => typeof n === "string");
  if (names.length < 2) return false;
  const timeRe =
    /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(\s+\d{2,4})?$|^q[1-4](\s+\d{2,4})?$|^(19|20)\d{2}$|^\d{4}-\d{2}(-\d{2})?$/i;
  const matches = names.filter((n) => timeRe.test(n.trim())).length;
  return matches >= Math.ceil(names.length / 2);
}

function humanizeCategoryLabel(value: unknown): string {
  return String(value ?? "")
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

function ChartInsight({
  type,
  data,
  valueFormat,
}: {
  type: string;
  data: DataRow[];
  valueFormat?: "currency" | "number" | "percent" | null;
}) {
  if (data.length === 0) return null;
  // Format the caption's headline number in the chart's real unit — a percent
  // measure (gross margin %, overtime %) must read "33.7%", not "$34".
  const fmtInsight = (n: number): string =>
    valueFormat === "percent"
      ? `${n.toFixed(1)}%`
      : valueFormat === "number"
        ? fmtNumber(n)
        : fmtCurrency(n);

  if (type === "line") {
    // "X% growth over period" only makes sense when the x-axis is actually a time
    // period. A line drawn over a CATEGORICAL axis (e.g. cumulative gross margin by
    // client) has no chronology, so a period-over-period delta is meaningless — it
    // produced bogus captions like "381.2% growth over period" on a by-client
    // cumulative line. Only show the caption when the axis labels read as time.
    if (!isTimeAxisLabels(data)) return null;
    const first = Number(data[0]?.value) || 0;
    const last = Number(data[data.length - 1]?.value) || 0;
    // A "% growth/decline over period" is only meaningful off a POSITIVE baseline with
    // no sign flip. Measures that can go negative or cross zero (free cash flow,
    // investing/financing CF, net change) produce nonsense like "-177.7% decline" when
    // the series ends below zero — suppress the caption rather than show a misleading %.
    if (data.length < 2 || first <= 0 || last < 0) return null;
    const pct = ((last - first) / first) * 100;
    const absoluteChange = last - first;
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
          {Math.abs(pct) > 1000
            ? `${fmtInsight(Math.abs(absoluteChange))} ${up ? "increase" : "decrease"} over period`
            : `${Math.abs(pct).toFixed(1)}% ${up ? "growth" : "decline"} over period`}
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
    const name = humanizeCategoryLabel(maxEntry.name).slice(0, 28);
    return (
      <div className="flex min-w-0 items-center gap-1 text-[10px] text-text-muted">
        <BarChart3Icon size={9} className="shrink-0" />
        <span className="truncate">
          Top: <span className="font-semibold text-text-secondary">{name}</span>{" "}
          · {fmtInsight(max)}
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
    const pct = Math.min(100, (Number(maxEntry.value) / total) * 100).toFixed(
      0,
    );
    const name = String(maxEntry.name ?? "").slice(0, 20);
    return (
      <div className="flex min-w-0 items-center gap-1 text-[10px] text-text-muted">
        <span className="truncate">
          <span className="font-semibold text-text-secondary">{name}</span>{" "}
          leads at {pct}%
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
      value: (() => {
        const days = Math.round((data.runwayMonths ?? 0) * 30);
        return `${days} ${days === 1 ? "day" : "days"}`;
      })(),
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
        (data.runwayMonths ?? 0) < 12
          ? "bg-feedback-warning/8"
          : "bg-feedback-success/8",
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
            <p
              className={cn(
                "text-xl font-black tracking-tight leading-none",
                m.color,
              )}
            >
              {m.value}
            </p>
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
    // The chart already falls back to a friendly inline message. Keep the
    // boundary quiet so a recoverable chart issue doesn't trigger the noisy
    // dev overlay for the whole dashboard.
    void error;
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

// Glass Ledger: what a bar/point click reports up so the dashboard can fetch the
// provenance behind that exact figure.
export type FigureClickArg = {
  widgetId: string | null;
  category: string;
  series?: string;
  value?: number;
};

// ─── Chart zoom (scatter / numeric-axis charts) ────────────────────────────────
// Points that cluster in a corner (e.g. every delivery center at 90%+ SLA / 80%+
// CSAT) are unreadable when the axes are pinned to 0–100%. This frame (1) auto-fits
// the axes to the DATA with padding so the cluster spreads across the plot, and (2)
// lets the user drag a box to zoom, scroll to zoom, and reset — without stealing the
// click-to-provenance interaction (a plain click still falls through).

type ZoomRange = [number, number];
type ZoomDomain = { x: ZoomRange; y: ZoomRange };

// A "nice" rounded step for axis bounds, so a fitted domain doesn't start at 89.7631.
function niceZoomStep(span: number): number {
  if (!Number.isFinite(span) || span <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(span / 4)));
  const norm = span / 4 / mag;
  const mult = norm >= 5 ? 5 : norm >= 2 ? 2 : 1;
  return mult * mag;
}

// Fit a padded, nicely-rounded [min,max] to a set of values.
function fitZoomBounds(values: number[], pad: number): ZoomRange {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return [0, 1];
  let lo = Math.min(...finite);
  let hi = Math.max(...finite);
  if (lo === hi) {
    const d = Math.abs(lo) > 1 ? Math.abs(lo) * 0.1 : 1;
    lo -= d;
    hi += d;
  }
  const span = hi - lo;
  const padded: ZoomRange = [lo - span * pad, hi + span * pad];
  const step = niceZoomStep(span);
  return [
    Math.floor(padded[0] / step) * step,
    Math.ceil(padded[1] / step) * step,
  ];
}

function zoomAxisRange(
  range: ZoomRange,
  factor: number,
  center: number | undefined,
): ZoomRange {
  const [lo, hi] = range;
  const c = center ?? (lo + hi) / 2;
  const nlo = c - (c - lo) / factor;
  const nhi = c + (hi - c) / factor;
  if (!(nhi - nlo > 1e-9)) return range;
  return [nlo, nhi];
}

function ZoomableChartFrame({
  height,
  xValues,
  yValues,
  enableXZoom = true,
  footer,
  children,
}: {
  height: number | string;
  xValues: number[];
  yValues: number[];
  enableXZoom?: boolean;
  footer?: ReactNode;
  children: (domain: ZoomDomain) => ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fit: ZoomDomain = {
    x: fitZoomBounds(xValues, 0.08),
    y: fitZoomBounds(yValues, 0.12),
  };
  const fitKey = `${fit.x[0]},${fit.x[1]},${fit.y[0]},${fit.y[1]}`;
  const [view, setView] = useState<ZoomDomain>(fit);
  const lastFitKey = useRef(fitKey);
  useEffect(() => {
    if (lastFitKey.current !== fitKey) {
      lastFitKey.current = fitKey;
      setView(fit);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  const isZoomed =
    view.x[0] !== fit.x[0] ||
    view.x[1] !== fit.x[1] ||
    view.y[0] !== fit.y[0] ||
    view.y[1] !== fit.y[1];

  const [sel, setSel] = useState<{
    left: number;
    top: number;
    w: number;
    h: number;
  } | null>(null);
  const dragRef = useRef<{ sx: number; sy: number; grid: DOMRect } | null>(
    null,
  );
  const draggedRef = useRef(false);
  const viewRef = useRef(view);
  viewRef.current = view;

  const gridRect = (): DOMRect | null => {
    const root = containerRef.current;
    if (!root) return null;
    const grid = root.querySelector(
      ".recharts-cartesian-grid",
    ) as SVGGElement | null;
    if (grid) return grid.getBoundingClientRect();
    const surf = root.querySelector(
      ".recharts-surface",
    ) as SVGSVGElement | null;
    return surf ? surf.getBoundingClientRect() : null;
  };
  const toData = (clientX: number, clientY: number, g: DOMRect) => {
    const v = viewRef.current;
    const fx = Math.min(1, Math.max(0, (clientX - g.left) / g.width));
    const fy = Math.min(1, Math.max(0, (clientY - g.top) / g.height));
    return {
      x: v.x[0] + fx * (v.x[1] - v.x[0]),
      y: v.y[1] - fy * (v.y[1] - v.y[0]),
    };
  };

  const applyZoom = (factor: number, cx?: number, cy?: number) =>
    setView((v) => ({
      x: enableXZoom ? zoomAxisRange(v.x, factor, cx) : v.x,
      y: zoomAxisRange(v.y, factor, cy),
    }));

  // Recharts stops propagation of mouse events on its own surface, so React handlers on
  // this wrapper never see them. Attach NATIVE listeners in the CAPTURE phase (top-down)
  // so we intercept wheel/drag before Recharts can — while a plain click (no drag) still
  // falls through to the chart's onClick (provenance). preventDefault on wheel stops the
  // page from scrolling while zooming.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const g = gridRect();
      if (!g) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      const d = toData(e.clientX, e.clientY, g);
      applyZoom(factor, enableXZoom ? d.x : undefined, d.y);
    };
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const g = gridRect();
      if (!g) return;
      dragRef.current = { sx: e.clientX, sy: e.clientY, grid: g };
      draggedRef.current = false;
    };
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) < 6) return;
      draggedRef.current = true;
      const root = el.getBoundingClientRect();
      setSel({
        left: Math.min(d.sx, e.clientX) - root.left,
        top: Math.min(d.sy, e.clientY) - root.top,
        w: Math.abs(e.clientX - d.sx),
        h: Math.abs(e.clientY - d.sy),
      });
    };
    const onUp = (e: MouseEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (draggedRef.current && d) {
        const a = toData(d.sx, d.sy, d.grid);
        const b = toData(e.clientX, e.clientY, d.grid);
        const nx: ZoomRange = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
        const ny: ZoomRange = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
        if (nx[1] - nx[0] > 0 && ny[1] - ny[0] > 0) {
          setView((v) => ({ x: enableXZoom ? nx : v.x, y: ny }));
        }
      }
      setSel(null);
    };
    // Swallow the click that follows a zoom-drag so it doesn't also open provenance.
    const onClick = (e: MouseEvent) => {
      if (draggedRef.current) {
        e.stopPropagation();
        e.preventDefault();
        draggedRef.current = false;
      }
    };
    const onLeave = () => {
      dragRef.current = null;
      setSel(null);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("mousedown", onDown, true);
    el.addEventListener("mousemove", onMove, true);
    el.addEventListener("mouseup", onUp, true);
    el.addEventListener("click", onClick, true);
    el.addEventListener("mouseleave", onLeave);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("mousedown", onDown, true);
      el.removeEventListener("mousemove", onMove, true);
      el.removeEventListener("mouseup", onUp, true);
      el.removeEventListener("click", onClick, true);
      el.removeEventListener("mouseleave", onLeave);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enableXZoom]);

  const btn =
    "flex h-6 w-6 items-center justify-center rounded-md text-sm font-bold leading-none transition-colors";
  const btnStyle = {
    background: "rgb(var(--color-bg-elevated) / 0.85)",
    color: "rgb(var(--color-text-secondary))",
    border: "1px solid rgb(var(--color-border-subtle) / 0.15)",
  } as const;
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    fn();
  };

  return (
    <div
      ref={containerRef}
      className="relative flex flex-col"
      style={{ height, width: "100%" }}
    >
      <div
        className="absolute right-1 top-1 z-20 flex items-center gap-1"
        title="Scroll or drag a box to zoom"
      >
        <button
          type="button"
          aria-label="Zoom in"
          className={btn}
          style={btnStyle}
          onMouseDown={stop(() => {})}
          onClick={stop(() => applyZoom(1.4))}
        >
          +
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          className={btn}
          style={btnStyle}
          onMouseDown={stop(() => {})}
          onClick={stop(() => applyZoom(1 / 1.4))}
        >
          −
        </button>
        {isZoomed && (
          <button
            type="button"
            aria-label="Reset zoom"
            className={btn}
            style={btnStyle}
            onMouseDown={stop(() => {})}
            onClick={stop(() => setView(fit))}
          >
            ⟳
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1">{children(view)}</div>
      {sel && sel.w > 2 && sel.h > 2 && (
        <div
          className="pointer-events-none absolute z-10 rounded-sm"
          style={{
            left: sel.left,
            top: sel.top,
            width: sel.w,
            height: sel.h,
            background: "rgb(var(--color-accent-cyan) / 0.15)",
            border: "1px solid rgb(var(--color-accent-cyan) / 0.7)",
          }}
        />
      )}
      {footer}
    </div>
  );
}

/** Convert the engine's generic long-form multi-dimensional result
 * (`name`, `series`, `value`) into the wide rows consumed by Recharts and the
 * heatmap renderer. Series names come from live dimension values; nothing is
 * enumerated or hardcoded here. */
function pivotLongSeries(rows: DataRow[]): DataRow[] {
  if (
    rows.length === 0 ||
    !rows.every(
      (row) =>
        typeof (row as Record<string, unknown>).series === "string" &&
        Object.prototype.hasOwnProperty.call(row, "value"),
    )
  ) {
    return rows;
  }
  const byName = new Map<string, DataRow>();
  for (const row of rows) {
    const source = row as Record<string, unknown>;
    const name = String(source.name ?? "");
    const series = String(source.series ?? "");
    if (!series) continue;
    const target = byName.get(name) ?? ({ name } as DataRow);
    target[series] = source.value as never;
    byName.set(name, target);
  }
  return [...byName.values()];
}

export function renderChart(
  chart: Chart,
  data: DataRow[],
  isExpanded: boolean,
  onFigureClick?: (arg: FigureClickArg) => void,
) {
  // Treemaps consume the long-form hierarchy directly. Pivoting them like a
  // stacked chart duplicates path text into numeric series keys and loses the
  // signed-size metadata needed by the tooltip.
  data = chart.type === "treemap" ? data : pivotLongSeries(data);
  const h = isExpanded ? 480 : 240;
  // Expanded charts live inside a flex-1 modal container that is taller than 480px, so a
  // fixed-height wrapper leaves dead space below and mis-aligns the plot. When expanded we
  // fill the container (height:100%); in-card charts keep their fixed pixel height. Numeric
  // `h` is still used where sizing math needs a number (axis offsets, data-driven heights).
  const wrapH: number | string = isExpanded ? "100%" : h;
  // Glass Ledger: a datapoint is inspectable only when a handler is wired AND we know
  // the real widget id to trace it back to.
  const figureWidgetId = chart.widgetId ?? null;
  const canInspect = !!onFigureClick && !!figureWidgetId;
  const emitFigure = (
    category: string,
    series: string | undefined,
    value: unknown,
  ) => {
    if (!onFigureClick || !figureWidgetId) return;
    const num = Number(value);
    onFigureClick({
      widgetId: figureWidgetId,
      category,
      series,
      value: Number.isFinite(num) ? num : undefined,
    });
  };
  // Line / area / scatter / combo charts don't have per-bar cells to click, so they
  // report the ACTIVE point at the click position (Recharts container onClick). We take
  // the x-category and the first series there — enough to trace the figure.
  //
  // Recharts v3 changed the shape delivered to external click handlers: it no longer
  // includes `activePayload`, only { activeLabel, activeDataKey, activeIndex,
  // activeCoordinate, isTooltipActive }. The old code read `state.activePayload` and
  // always early-returned on v3 → line/area/combo/scatter clicks never opened the
  // provenance drawer (bars still worked via their own per-bar <Bar onClick>). Read the
  // v3 fields and fall back to v2's activePayload so both shapes work.
  const emitFromActive = (state: any) => {
    if (!state) return;
    const pts = Array.isArray(state.activePayload) ? state.activePayload : null;
    const p = pts?.[0];
    // Category = the x-axis label under the click.
    const category = String(state.activeLabel ?? p?.payload?.name ?? "");
    // Which series was hit. v3 exposes activeDataKey; v2 carried it on the payload.
    // A shared tooltip may not pin a single series — resolved below from the data row.
    let key = String(state.activeDataKey ?? p?.dataKey ?? p?.name ?? "");
    // Value for the trust-stamp: prefer the payload (v2); on v3 resolve it from the
    // chart's own data row (matched by category), or by active index as a last resort.
    let value: unknown =
      p?.value ?? (p?.payload && key ? p.payload[key] : undefined);
    const row =
      (category && Array.isArray(data)
        ? (data as any[]).find((r) => String(r?.name) === category)
        : undefined) ||
      (state.activeIndex != null && Array.isArray(data)
        ? (data as any[])[Number(state.activeIndex)]
        : undefined);
    if (value === undefined && row) {
      value = key && key !== "value" ? (row as any)[key] : (row as any).value;
    }
    // Clicking the body of a multi-series line/area with a shared tooltip pins neither a
    // series nor a value. Fall back to the first numeric series in the row so the figure
    // still traces to a concrete series AND carries its on-screen value — that value lets
    // the backend reconcile the recompute and stamp it "verified", instead of the neutral
    // "recomputed from source" you get with no value to compare against.
    if ((!key || key === "value" || value === undefined) && row) {
      const skip = new Set([
        "name",
        "label",
        "month",
        "period",
        "date",
        "category",
        "order",
        "x",
        "group",
      ]);
      const firstKey = Object.keys(row).find(
        (k) =>
          !skip.has(k.toLowerCase()) &&
          Number.isFinite(Number((row as any)[k])),
      );
      if (firstKey) {
        if (!key || key === "value") key = firstKey;
        if (value === undefined) value = (row as any)[firstKey];
      }
    }
    if (!category && value === undefined) return;
    emitFigure(
      category,
      key && key !== "value" ? prettySeriesName(key) : undefined,
      value,
    );
  };
  // Precise per-line click: a line's active dot carries its OWN series payload, so
  // clicking directly on a point of one line traces exactly that series+value even
  // when the shared tooltip doesn't pin a single dataKey for emitFromActive.
  const dotClick = (seriesKey: string) => (dotProps: any, evt?: any) => {
    // Stop the click from also reaching the chart-level onClick (emitFromActive),
    // which — with a shared tooltip that doesn't pin a single series — would override
    // this precise per-line trace with the chart's primary measure. Recharts passes
    // the DOM event as the 2nd arg; some versions fold it into the first.
    (evt ?? dotProps)?.stopPropagation?.();
    const payload = dotProps?.payload;
    if (!payload) return;
    emitFigure(
      String(payload?.name ?? ""),
      seriesKey && seriesKey !== "value"
        ? prettySeriesName(seriesKey)
        : undefined,
      payload?.[seriesKey],
    );
  };
  const inspectDot = (seriesKey: string, radius = 4) =>
    canInspect
      ? { r: radius, cursor: "pointer" as const, onClick: dotClick(seriesKey) }
      : false;
  // A pie/donut can only depict NON-NEGATIVE parts of a whole. If the data carries any
  // negative value (e.g. cash-flow components where investing/financing CF are negative),
  // a pie silently drops those slices and misleads — render it as a bar instead. This is
  // the universal render-layer safety net behind the planner/editor coercions.
  if (
    (String(chart.type).toLowerCase() === "pie" ||
      String(chart.type).toLowerCase() === "donut") &&
    Array.isArray(data) &&
    data.some((d) => Number((d as any)?.value) < 0)
  ) {
    chart = { ...chart, type: "bar" } as Chart;
  }
  const effectiveChartType = getEffectiveChartType(chart);

  // Honor an explicit value-format hint when present. EBPO charts use
  // metric="dynamic", so formatValue can't infer "percent" from the metric name —
  // a % measure (gross margin %, depreciation %) would otherwise render as $/thousands.
  // The EBPO compiler sets display.valueFormat from the measure's catalog format.
  const _vfmt = chart.config.display?.valueFormat ?? null;
  const _vdec = chart.config.display?.valueDecimals ?? null;
  // When the user explicitly asks to "show data labels", force per-point labels even
  // past the auto-threshold (EBPO trends carry 48 months, so labels are off by default).
  const _forceLabels = chart.config.display?.showDataLabels === true;
  const _metric = chart.config.metric;
  const _grouping = chart.config.grouping;
  const seriesMeta = chart.config.display?.series ?? [];
  const seriesMetaByKey = new Map(
    seriesMeta
      .filter(
        (s): s is NonNullable<typeof s> => !!s && typeof s.key === "string",
      )
      .map((s) => [s.key, s]),
  );
  // Human-readable series name for legends/labels. Raw SQL aliases from the LLM
  // editor arrive as snake_case ids (e.g. "payroll_to_revenue_pct", "total_revenue_usd")
  // which testers flagged as "un-named / missing chart names". Strip unit suffixes,
  // map pct→%, and title-case.
  // Financial acronyms that must stay UPPER-CASE in a legend/title (the raw column
  // alias arrives lower-cased, e.g. "ap_outstanding" → would title-case to "Ap").
  const SERIES_ACRONYMS: Record<string, string> = {
    ap: "AP",
    ar: "AR",
    dso: "DSO",
    dpo: "DPO",
    csat: "CSAT",
    sla: "SLA",
    fte: "FTE",
    ebitda: "EBITDA",
    cfo: "CFO",
    kpi: "KPI",
    nbv: "NBV",
    gl: "GL",
    yoy: "YoY",
    mom: "MoM",
    ytd: "YTD",
    roi: "ROI",
    fcf: "FCF",
  };
  const prettySeriesName = (key: string): string => {
    let s = String(key ?? "")
      .replace(/_/g, " ")
      .trim();
    s = s.replace(/\busd\b/gi, "").replace(/\bpct\b/gi, "%");
    s = s
      .replace(/\s*%/g, " %")
      .replace(/\s{2,}/g, " ")
      .trim();
    return s
      .split(" ")
      .map((w) => {
        if (w === "%") return w;
        const acr = SERIES_ACRONYMS[w.toLowerCase()];
        if (acr) return acr;
        if (/^[A-Z0-9&/]+$/.test(w)) return w;
        return w.charAt(0).toUpperCase() + w.slice(1);
      })
      .join(" ");
  };
  const fmtVal = (value: number): string => {
    const n = Number(value) || 0;
    // 100%-stacked contribution: every value is a percent share regardless of the
    // underlying measure's $ unit — never let the currency heuristics fire.
    if (chart.config.display?.normalized) return `${n.toFixed(_vdec ?? 1)}%`;
    const _lbl = String(chart.config.yAxisLabel ?? "").toLowerCase();
    const labelLooksPercent =
      /%|\bpercent(age)?\b|\bsla\b|\bcsat\b|utili[sz]ation/.test(_lbl);
    const labelLooksCurrency =
      /\busd\b|\(\s*\$\s*\)|dollars?|\bbalance\b|\boutstanding\b|\breceiv(?:able|ables)\b|\boverdue\b|\bamount\b|\bvalue\b|\brevenue\b|\bincome\b|\bexpense\b|\bcost\b|\bprofit\b|\bmargin\b|\bcash\b|\basset\b|\bliabil(?:ity|ities)\b|\bequity\b|\bpayable\b|\bdebit\b|\bcredit\b/.test(
        _lbl,
      );
    if (_vfmt === "percent") {
      if (labelLooksCurrency && !labelLooksPercent) return fmtCurrency(n);
      return `${n.toFixed(_vdec ?? 1)}%`;
    }
    if (_vfmt === "currency") return fmtCurrency(n);
    if (_vfmt === "number") return fmtNumber(n);
    // Safety net for dynamic charts with no explicit valueFormat: trust the unit the
    // planner stated in yAxisLabel (e.g. "Gross Margin (%)"). High-precision — never
    // overrides an explicit $/USD unit, so a currency chart can't be mislabeled.
    if (_lbl && !labelLooksCurrency && labelLooksPercent) return fmtPercent(n);
    return formatValue(_metric, _grouping, n);
  };
  const inferFormatFromKey = (
    key: string | null | undefined,
    fallback: "currency" | "number" | "percent" | null = null,
  ): "currency" | "number" | "percent" => {
    const raw = String(key ?? "");
    // A normalized (100%-stacked) chart makes EVERY series a percent share — the
    // series NAME ("Voice Revenue") must not infer currency here.
    if (chart.config.display?.normalized) return "percent";
    const metaFormat = raw ? (seriesMetaByKey.get(raw)?.format ?? null) : null;
    if (metaFormat) return metaFormat;
    if (
      chart.config.display?.labelSeries &&
      raw === chart.config.display.labelSeries
    ) {
      const labelFmt = chart.config.display?.labelFormat ?? null;
      if (labelFmt) return labelFmt;
    }
    // Normalize underscores to spaces so \b word-boundaries match underscore-joined
    // metric names. `_` is a regex word char, so \bpct\b/\brate\b NEVER matched
    // "cumulative_pct", "collection_rate", "gross_margin_pct" etc. — LLM-SQL edits
    // emit exactly those aliases with no display.series, so the % line fell through
    // to the chart's currency valueFormat and rendered a "$" secondary axis.
    const text = raw.toLowerCase().replace(/_+/g, " ");
    if (
      !/\busd\b|\$/.test(text) &&
      /%|\bpercent(age)?\b|\bpct\b|\bratio\b|\brate\b|\bshare\b|\bsla\b|\bcsat\b|utili[sz]ation/.test(
        text,
      )
    )
      return "percent";
    if (
      /\bday(s)?\b|\bdso\b|\bdpo\b|\bcount\b|\bheadcount\b|\binvoice(s)?\b|\bticket(s)?\b|\bcall(s)?\b/.test(
        text,
      )
    )
      return "number";
    // Generic dynamic-series aliases like "value" / "Value MA3" carry no intrinsic
    // unit. On percent charts (e.g. net profit margin + rolling average), prefer the
    // chart-level fallback rather than the generic "value => currency" heuristic below,
    // otherwise tooltips and labels render "$-48" against a -48.0% axis.
    if (
      fallback === "percent" &&
      /(?:^|[\s_])value(?:[\s_]|$)|\bma\d+\b/.test(text) &&
      !/\busd\b|\$|revenue|cost|expense|margin|balance|cash|asset|salary|payroll|amount|book/.test(
        text,
      )
    )
      return "percent";
    if (
      /\b(revenue|cost|expense|margin|balance|cash|asset|salary|payroll|amount|book)\b/.test(
        text,
      ) ||
      // Match "value", "cumulative_value", "running_value" etc. — compound names where a
      // strict \bvalue\b boundary would miss the underscore-joined token.
      /(?:^|[_\s])value\b|value$/.test(text)
    )
      return "currency";
    if (fallback) return fallback;
    return chart.config.display?.valueFormat ?? "number";
  };
  const inferFormatFromLabelText = (
    label: string | null | undefined,
    fallback: "currency" | "number" | "percent" | null = null,
  ): "currency" | "number" | "percent" =>
    inferFormatFromKey(String(label ?? "").replace(/\s+/g, "_"), fallback);
  const normalizeMetricLabel = (value: string | null | undefined): string =>
    String(value ?? "")
      .toLowerCase()
      .replace(/[%()]/g, " ")
      .replace(/\busd\b/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const resolveAxisFormatFromMetadata = (
    axisLabel: string | null | undefined,
    axis: "x" | "y" | "z",
    fallback: "currency" | "number" | "percent" | null = null,
  ): "currency" | "number" | "percent" => {
    const normalizedLabel = normalizeMetricLabel(axisLabel);
    const matchedSeries = seriesMeta.find((series, idx) => {
      const pretty = normalizeMetricLabel(prettySeriesName(series.key));
      const raw = normalizeMetricLabel(series.key);
      const ordinalMatch =
        !normalizedLabel &&
        ((axis === "x" && idx === 0) ||
          (axis === "y" && idx === 1) ||
          (axis === "z" && idx === 2));
      return (
        ordinalMatch ||
        (!!normalizedLabel &&
          (pretty === normalizedLabel || raw === normalizedLabel))
      );
    });
    if (matchedSeries?.format) return matchedSeries.format;
    if (axis === "y") {
      const secondaryLabel = normalizeMetricLabel(
        chart.config.display?.secondaryLabel,
      );
      if (secondaryLabel && secondaryLabel === normalizedLabel) {
        return (
          chart.config.display?.secondaryAxisFormat ??
          inferFormatFromLabelText(axisLabel, fallback)
        );
      }
      if (
        !normalizedLabel &&
        chart.config.display?.secondaryAxisFormat &&
        seriesMeta.length > 1
      ) {
        return chart.config.display.secondaryAxisFormat;
      }
    }
    if (axis === "x" && seriesMeta[0]?.format) return seriesMeta[0].format;
    if (axis === "y" && seriesMeta[1]?.format) return seriesMeta[1].format;
    if (axis === "z" && seriesMeta[2]?.format) return seriesMeta[2].format;
    return inferFormatFromLabelText(axisLabel, fallback);
  };
  const fmtByUnit = (
    value: number,
    unit: "currency" | "number" | "percent",
  ): string => {
    const n = Number(value) || 0;
    return unit === "percent"
      ? fmtPercent(n)
      : unit === "currency"
        ? fmtCurrency(n)
        : fmtNumber(n);
  };
  const fmtSeriesValue = (
    value: number,
    key?: string | null,
    fallback: "currency" | "number" | "percent" | null = null,
  ): string => fmtByUnit(value, inferFormatFromKey(key, fallback));
  const fmtLabel = (value: number): string => {
    const n = Number(value) || 0;
    const explicit = chart.config.display?.labelFormat ?? null;
    if (explicit === "percent") return fmtPercent(n);
    if (explicit === "currency") return fmtCurrency(n);
    if (explicit === "number") return fmtNumber(n);
    return fmtSeriesValue(n, chart.config.display?.labelSeries);
  };

  type PointLabelMode = "none" | "full" | "sparse" | "latest";
  // Forced labels still need to respect visual density. When multiple series share
  // the same x-axis, "show labels" should degrade to sparse/latest labels instead
  // of drawing unreadable overlapping text on every datapoint.
  const pointLabelMode = (
    pointCount: number,
    seriesCount = 1,
    forceLabels = false,
    expanded = false,
  ): PointLabelMode => {
    const safeSeriesCount = Math.max(1, seriesCount);
    const totalLabels = pointCount * safeSeriesCount;
    // Expanded charts have materially more space, so evaluate density as if there
    // were fewer effective collisions. Smaller effective counts = more labels shown.
    const effectivePointCount = expanded
      ? Math.max(1, Math.ceil(pointCount * 0.72))
      : pointCount;
    const effectiveTotalLabels = expanded
      ? Math.max(1, Math.ceil(totalLabels * 0.68))
      : totalLabels;

    if (forceLabels) {
      if (safeSeriesCount >= 3 && effectiveTotalLabels > 26) return "latest";
      if (safeSeriesCount >= 2 && effectiveTotalLabels > 34) return "latest";
      if (effectiveTotalLabels > 18) return "sparse";
      return "full";
    }

    // A latest-value label for every line is still unreadable on comparison
    // charts with many series (for example 5 metrics x current/prior/variance).
    // Keep the plot clean and expose every exact value through the tooltip.
    if (safeSeriesCount >= 6) return "none";

    if (safeSeriesCount === 1) {
      if (effectivePointCount <= 12) return "full";
      if (effectivePointCount <= 24) return "sparse";
      return "latest";
    }

    if (safeSeriesCount <= 3) {
      if (effectivePointCount <= 5) return "full";
      if (effectivePointCount <= 14) return "sparse";
      return "latest";
    }

    if (effectivePointCount <= 6) return "sparse";
    return "latest";
  };
  const labelStride = (count: number, targetVisibleLabels = 12): number =>
    count <= targetVisibleLabels + 4
      ? 1
      : Math.max(2, Math.ceil(count / targetVisibleLabels));
  const latestFiniteIndex = (rows: DataRow[], key: string): number => {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const n = toFiniteNumber((rows[i] as any)?.[key]);
      if (n !== null) return i;
    }
    return -1;
  };
  const latestLabelDy = (seriesIndex = 0): number => {
    const offsets = [-12, 14, -26, 28, -40, 42];
    return offsets[seriesIndex] ?? (seriesIndex % 2 === 0 ? -12 : 14);
  };
  const chartTitleText =
    `${chart.title ?? ""} ${chart.description ?? ""}`.toLowerCase();
  const shouldForceNegativeEmphasis =
    /\b(?:cash\s+flow|cash\s+balance|free\s+cash\s+flow|net\s+cash)\b/.test(
      chartTitleText,
    );
  const expandedXAxisHeight = isExpanded ? 34 : 24;
  const longFormLegendSeriesCount = new Set(
    data
      .map((row) => String((row as Record<string, unknown>).series ?? ""))
      .filter(Boolean),
  ).size;
  const legendSeriesCount = Math.max(
    1,
    chart.config.display?.series?.length ?? 0,
    inferNumericSeriesKeys(data).length,
    longFormLegendSeriesCount,
  );
  // Recharts does not grow its legend wrapper automatically. Reserve additional
  // rows for dense comparison charts so long legends are not cut off in either
  // the card or the expanded view.
  const expandedLegendHeight = isExpanded
    ? Math.min(180, 30 + Math.ceil(legendSeriesCount / 4) * 18)
    : legendSeriesCount > 6
      ? Math.min(128, 28 + Math.ceil(legendSeriesCount / 4) * 18)
      : 28;
  const expandedBottomChartMargin = isExpanded ? 44 : 8;
  // Axis TITLES ("Department" under x, "USD" beside y) so the chart explains itself.
  // Only rendered when the backend supplied them (chart.config.xAxisLabel/yAxisLabel),
  // so charts that don't set them look exactly as before. Copies the scatter branch's
  // `label` prop pattern. The pad/width additions keep the titles from clipping ticks.
  const xAxisTitle = chart.config.xAxisLabel?.trim() || "";
  const yAxisTitle = chart.config.yAxisLabel?.trim() || "";
  const axisTitleFill = "rgb(var(--color-text-muted))";
  const axisTitleFontSize = isExpanded ? 12 : 11;
  const xAxisTitlePad = xAxisTitle ? (isExpanded ? 22 : 18) : 0;
  const yAxisTitleWidth = yAxisTitle ? (isExpanded ? 22 : 18) : 0;
  const xAxisTitleProp = xAxisTitle
    ? {
        label: {
          value: xAxisTitle,
          position: "insideBottom" as const,
          offset: isExpanded ? -8 : -6,
          fontSize: axisTitleFontSize,
          fill: axisTitleFill,
        },
      }
    : {};
  const yAxisTitleProp = yAxisTitle
    ? {
        label: {
          value: yAxisTitle,
          angle: -90,
          position: "insideLeft" as const,
          offset: 6,
          fontSize: axisTitleFontSize,
          fill: axisTitleFill,
          style: { textAnchor: "middle" as const },
        },
      }
    : {};
  // LabelList `content` renderer that skips off-stride points (formatter can't see the
  // index, so thinning must happen in a custom content renderer).
  const thinnedLabel =
    (stride: number, fmt: (n: number) => string, dy = -6) =>
    (props: any) => {
      const { x, y, value, index } = props;
      if (value === null || value === undefined || index === undefined)
        return null;
      if (stride > 1 && index % stride !== 0) return null;
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      return (
        <text
          x={x}
          y={y}
          dy={dy}
          textAnchor="middle"
          fontSize={isExpanded ? 10 : 9}
          fontWeight={600}
          fill="rgb(var(--color-text-secondary))"
          stroke="rgb(var(--color-bg-card))"
          strokeWidth={3}
          strokeLinejoin="round"
          paintOrder="stroke"
        >
          {fmt(n)}
        </text>
      );
    };
  const latestOnlyLabel =
    (
      rows: DataRow[],
      key: string,
      fmt: (n: number) => string,
      seriesIndex = 0,
      dx = -8,
    ) =>
    (props: any) => {
      const { x, y, value, index } = props;
      const latestIndex = latestFiniteIndex(rows, key);
      if (latestIndex < 0 || index !== latestIndex) return null;
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      return (
        <text
          x={x}
          y={y}
          dx={dx}
          dy={latestLabelDy(seriesIndex)}
          textAnchor="end"
          fontSize={isExpanded ? 10 : 9}
          fontWeight={700}
          fill="rgb(var(--color-text-primary))"
          stroke="rgb(var(--color-bg-card))"
          strokeWidth={3}
          strokeLinejoin="round"
          paintOrder="stroke"
        >
          {fmt(n)}
        </text>
      );
    };
  const rowLabel =
    (
      key: string,
      fmt: (n: number) => string,
      dy = -6,
      rows?: DataRow[],
      horizontal = false,
    ) =>
    (props: any) => {
      const { x, y, width, height, payload, index } = props;
      const row =
        payload ??
        (typeof index === "number" && rows
          ? (rows[index] as Record<string, unknown> | undefined)
          : undefined);
      const raw = row?.[key];
      if (raw === null || raw === undefined || raw === "") return null;
      const n = Number(raw);
      if (!Number.isFinite(n)) return null;
      const numericX = Number(x);
      const numericY = Number(y);
      const numericWidth = Number(width);
      const numericHeight = Number(height);
      const labelX =
        horizontal && Number.isFinite(numericWidth)
          ? numericX + numericWidth + 6
          : Number.isFinite(numericWidth)
            ? numericX + numericWidth / 2
            : numericX;
      const labelY =
        horizontal && Number.isFinite(numericHeight)
          ? numericY + numericHeight / 2
          : numericY;
      if (!Number.isFinite(labelX) || !Number.isFinite(labelY)) return null;
      return (
        <text
          x={labelX}
          y={labelY}
          dy={horizontal ? 0 : dy}
          textAnchor={horizontal ? "start" : "middle"}
          dominantBaseline={horizontal ? "central" : undefined}
          fontSize={isExpanded ? 11 : 10}
          fontWeight={800}
          fill="rgb(var(--color-text-primary))"
        >
          {fmt(n)}
        </text>
      );
    };

  if (chart.type === "box_plot") {
    const rows = data
      .map((row) => {
        const min = Number((row as any).min);
        const q1 = Number((row as any).q1);
        const median = Number((row as any).median);
        const q3 = Number((row as any).q3);
        const max = Number((row as any).max);
        return {
          name: String((row as any).name ?? ""),
          min,
          q1,
          median,
          q3,
          max,
          employeeCount: Number((row as any).employee_count ?? 0),
        };
      })
      .filter((row) =>
        [row.min, row.q1, row.median, row.q3, row.max].every((value) =>
          Number.isFinite(value),
        ),
      )
      .slice(0, isExpanded ? 18 : 10);
    if (!rows.length) {
      return (
        <div className="flex h-full items-center justify-center text-xs text-text-muted">
          No box plot data available.
        </div>
      );
    }
    const domainMin = Math.min(...rows.map((row) => row.min));
    const domainMax = Math.max(...rows.map((row) => row.max));
    const span = Math.max(domainMax - domainMin, 1);
    const x = (value: number) => 8 + ((value - domainMin) / span) * 84;

    return (
      <div
        style={{ height: wrapH, width: "100%" }}
        className="flex flex-col gap-2 overflow-hidden"
      >
        <div className="flex justify-between px-2 text-[10px] font-semibold text-text-muted">
          <span>{fmtVal(domainMin)}</span>
          <span>{fmtVal(domainMax)}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="flex flex-col gap-2">
            {rows.map((row) => {
              const medianX = x(row.median);
              return (
                <div
                  key={row.name}
                  className="grid items-center gap-2"
                  style={{
                    gridTemplateColumns:
                      "minmax(96px, 0.8fr) minmax(160px, 2fr)",
                  }}
                >
                  <div className="min-w-0">
                    <p className="truncate text-[11px] font-semibold text-text-primary">
                      {row.name}
                    </p>
                    <p className="text-[9px] text-text-muted">
                      {row.employeeCount
                        ? `${fmtNumber(row.employeeCount)} employees`
                        : ""}
                    </p>
                  </div>
                  <div className="relative h-9 rounded border border-default bg-bg-card/60">
                    <div
                      className="absolute top-1/2 h-px -translate-y-1/2 bg-text-muted/50"
                      style={{
                        left: `${x(row.min)}%`,
                        width: `${Math.max(x(row.max) - x(row.min), 1)}%`,
                      }}
                    />
                    <div
                      className="absolute top-1/2 h-4 -translate-y-1/2 rounded border border-primary/50 bg-primary/20"
                      style={{
                        left: `${x(row.q1)}%`,
                        width: `${Math.max(x(row.q3) - x(row.q1), 1)}%`,
                      }}
                    />
                    {[row.min, row.max].map((value, index) => (
                      <div
                        key={`${row.name}-${index}`}
                        className="absolute top-1/2 h-5 w-px -translate-y-1/2 bg-text-muted"
                        style={{ left: `${x(value)}%` }}
                      />
                    ))}
                    <div
                      className="absolute top-1/2 h-6 w-0.5 -translate-y-1/2 rounded bg-primary"
                      style={{ left: `${medianX}%` }}
                      title={`Median: ${fmtVal(row.median)}`}
                    />
                    {_forceLabels ? (
                      <span
                        className="absolute -top-0.5 -translate-x-1/2 rounded bg-bg-elevated px-1 text-[9px] font-bold text-text-primary shadow-sm"
                        style={{ left: `${medianX}%` }}
                      >
                        {fmtVal(row.median)}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  if (chart.type === "radar") {
    const radarData =
      data.length === 1
        ? Object.entries(data[0] ?? {})
            .filter(
              ([key, value]) =>
                key !== "name" && Number.isFinite(Number(value)),
            )
            .map(([name, value]) => ({
              name: prettySeriesName(name),
              value: Number(value),
            }))
        : data;
    const series = Array.from(
      new Set(
        radarData.flatMap((row) =>
          Object.keys(row).filter(
            (key) =>
              key !== "name" && Number.isFinite(Number((row as any)[key])),
          ),
        ),
      ),
    );
    return (
      <div
        style={{ height: wrapH, width: "100%" }}
        className="flex justify-center overflow-x-auto"
      >
        <RadarChart
          width={isExpanded ? 980 : 640}
          height={isExpanded ? 480 : 240}
          data={radarData}
          margin={{ top: 24, right: 52, bottom: 24, left: 52 }}
        >
          <PolarGrid stroke="rgba(var(--color-text-muted)/0.25)" />
          <PolarAngleAxis
            dataKey="name"
            tick={{
              fill: "rgb(var(--color-text-secondary))",
              fontSize: isExpanded ? 11 : 9,
            }}
          />
          <PolarRadiusAxis
            tick={{ fill: "rgb(var(--color-text-muted))", fontSize: 9 }}
            tickFormatter={(v) => fmtVal(Number(v) || 0)}
          />
          {series.slice(0, 6).map((key, index) => (
            <Radar
              key={key}
              name={prettySeriesName(key)}
              dataKey={key}
              stroke={PIE_COLORS[index % PIE_COLORS.length]}
              fill={PIE_COLORS[index % PIE_COLORS.length]}
              fillOpacity={0.12}
              strokeWidth={2}
              isAnimationActive={false}
            />
          ))}
          <Tooltip
            formatter={(v, name) => [fmtVal(Number(v) || 0), String(name)]}
          />
          {series.length > 1 && (
            <Legend wrapperStyle={{ fontSize: isExpanded ? 11 : 9 }} />
          )}
        </RadarChart>
      </div>
    );
  }

  if (chart.type === "funnel") {
    const rawStages =
      data.length === 1 &&
      !Object.prototype.hasOwnProperty.call(data[0] ?? {}, "value")
        ? Object.entries(data[0] ?? {})
            .filter(
              ([key, value]) =>
                key !== "name" && Number.isFinite(Number(value)),
            )
            .map(([name, value]) => ({
              name: prettySeriesName(name),
              value: Number(value),
            }))
        : data.map((row, index) => ({
            name: String((row as any).name ?? `Stage ${index + 1}`),
            value: Number((row as any).value ?? 0),
          }));
    const funnelData = rawStages
      .filter((row) => Number.isFinite(row.value))
      .map((row, index) => ({
        ...row,
        fill: PIE_COLORS[index % PIE_COLORS.length],
      }));
    return (
      <div
        style={{ height: wrapH, width: "100%" }}
        className="flex justify-center overflow-x-auto"
      >
        <FunnelChart
          width={isExpanded ? 980 : 640}
          height={isExpanded ? 480 : 240}
          margin={{ top: 12, right: 80, bottom: 12, left: 80 }}
        >
          <Tooltip formatter={(v) => fmtVal(Number(v) || 0)} />
          <Funnel dataKey="value" data={funnelData} isAnimationActive={false}>
            <LabelList
              position="right"
              fill="rgb(var(--color-text-primary))"
              stroke="none"
              dataKey="name"
              fontSize={isExpanded ? 12 : 10}
            />
            <LabelList
              position="center"
              fill="#fff"
              stroke="none"
              dataKey="value"
              formatter={(v: unknown) => fmtVal(Number(v) || 0)}
              fontSize={isExpanded ? 11 : 9}
            />
          </Funnel>
        </FunnelChart>
      </div>
    );
  }

  if (chart.type === "sankey") {
    const nodeIndex = new Map<string, number>();
    const nodes: Array<{ name: string }> = [];
    const node = (name: string) => {
      if (!nodeIndex.has(name)) {
        nodeIndex.set(name, nodes.length);
        nodes.push({ name });
      }
      return nodeIndex.get(name)!;
    };
    const links = data.flatMap((row) => {
      const sourceName = String((row as any).name ?? "Source");
      return Object.entries(row)
        .filter(([key, value]) => key !== "name" && Number(value) > 0)
        .map(([key, value]) => ({
          source: node(sourceName),
          target: node(key),
          value: Number(value),
        }));
    });
    return (
      <div
        style={{ height: wrapH, width: "100%" }}
        className="flex justify-center overflow-x-auto"
      >
        <RechartsSankey
          width={isExpanded ? 980 : 640}
          height={isExpanded ? 480 : 240}
          data={{ nodes, links }}
          nodePadding={18}
          margin={{ top: 20, right: 100, bottom: 20, left: 100 }}
          link={{
            stroke: "rgb(var(--color-accent-cyan))",
            strokeOpacity: 0.25,
          }}
        >
          <Tooltip formatter={(v) => fmtVal(Number(v) || 0)} />
        </RechartsSankey>
      </div>
    );
  }

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
    const numeric =
      typeof rawValue === "number" ? rawValue : Number(rawValue ?? 0);
    const label = chart.title || "Metric";
    const secondary =
      typeof (first as any)?.outstandingPct === "number"
        ? `${fmtPercent(Number((first as any).outstandingPct) || 0)} outstanding`
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
    dispNormalized ? pctTick(v) : fmtVal(Number(v) || 0);
  // Constant value of the reference column (it's the same on every row).
  const refValue =
    refSeriesKey && data.length > 0
      ? Number((data[0] as any)[refSeriesKey])
      : null;
  // A reference line for a measure that is NOT plotted on the chart lives on its own
  // secondary (right) axis — otherwise a metric on a different scale (e.g. an average-cost
  // line of $1.8M over a $0–$100K overtime axis) is pushed off-screen. When the backend
  // marks referenceAxis="right", draw a dedicated right axis for the reference line.
  const refOnRightAxis = chart.config.display?.referenceAxis === "right";
  const refAxisFmt = (v: number): string =>
    chart.config.display?.secondaryAxisFormat === "percent"
      ? `${(Number(v) || 0).toFixed(1)}%`
      : chart.config.display?.secondaryAxisFormat === "number"
        ? fmtNumber(Number(v) || 0)
        : fmtCurrency(Number(v) || 0);
  // Color a moving-average series to match its parent series.
  const colorAt = (i: number): string =>
    PIE_COLORS[
      ((i % PIE_COLORS.length) + PIE_COLORS.length) % PIE_COLORS.length
    ] ?? PIE_COLORS[0]!;
  const seriesColor = (key: string, keys: string[], idx: number): string => {
    if (maSuffix && key.endsWith(maSuffix)) {
      const parent = key.slice(0, -maSuffix.length);
      const pIdx = keys.indexOf(parent);
      if (pIdx >= 0) return colorAt(pIdx);
    }
    return colorAt(idx);
  };

  if (
    effectiveChartType === "line" ||
    effectiveChartType === "area" ||
    effectiveChartType === "stacked_area"
  ) {
    const areaData =
      effectiveChartType === "stacked_area" ? pivotLongSeriesRows(data) : data;
    const allKeys = inferNumericSeriesKeys(areaData).filter(
      (k) => k !== chart.config.display?.labelSeries,
    );
    const hasValueSeries = hasFiniteValueKey(areaData, "value");
    // Reference column is drawn as a flat ReferenceLine, not a plotted series.
    const seriesKeys = allKeys.filter((k) => k !== refSeriesKey);
    // A follow-up overlay can preserve the base `value` column and add one or more
    // extra numeric columns (for example `cumulative_value`). The old renderer treated
    // any chart with `value` as single-series, so it silently dropped the added series
    // even though the backend had produced it. Multi-series should mean "more than one
    // plottable numeric series", not "no `value` column present".
    const plottedSeriesKeys = hasValueSeries
      ? ["value", ...seriesKeys.filter((k) => k !== "value")]
      : seriesKeys;
    const isMultiSeries = plottedSeriesKeys.length > 1;
    const highlightedSeries = new Set(
      chart.config.display?.highlightSeries ?? [],
    );
    const hasSeriesHighlight = plottedSeriesKeys.some((key) =>
      highlightedSeries.has(key),
    );
    const visibleSeriesKeys = chart.config.display?.showAllSeries
      ? plottedSeriesKeys
      : plottedSeriesKeys.slice(0, isExpanded ? 12 : 8);
    const multiSeriesLabelMode = pointLabelMode(
      areaData.length,
      visibleSeriesKeys.length,
      _forceLabels,
      isExpanded,
    );
    const singleSeriesLabelMode = pointLabelMode(
      areaData.length,
      1,
      _forceLabels,
      isExpanded,
    );

    const vals = isMultiSeries
      ? []
      : areaData.map((d) => Number((d as any).value) || 0);
    const avg =
      vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    const extremaMarkers = (() => {
      type ExtremaMarker = { name: string; value: number; kind: "min" | "max" };
      if (isMultiSeries) return [];

      const rows = areaData
        .map((row) => ({
          name: String((row as any).name ?? ""),
          value: Number((row as any).value),
          minValue: Number((row as any).min_value),
          maxValue: Number((row as any).max_value),
        }))
        .filter((row) => row.name && Number.isFinite(row.value));

      if (rows.length < 2) return [];

      const markers: ExtremaMarker[] = [];
      const explicitMin = rows.find(
        (row) => Number.isFinite(row.minValue) && row.value === row.minValue,
      );
      const explicitMax = rows.find(
        (row) => Number.isFinite(row.maxValue) && row.value === row.maxValue,
      );

      if (explicitMin) {
        markers.push({
          name: explicitMin.name,
          value: explicitMin.value,
          kind: "min",
        });
      }
      if (explicitMax) {
        markers.push({
          name: explicitMax.name,
          value: explicitMax.value,
          kind: "max",
        });
      }

      if (markers.length > 0) return markers;
      if (!chart.config.display?.highlightMaxMin) return [];

      const values = rows.map((row) => row.value);
      const min = Math.min(...values);
      const max = Math.max(...values);
      if (!Number.isFinite(min) || !Number.isFinite(max) || min === max)
        return [];

      const derived: ExtremaMarker[] = [];
      for (const row of rows) {
        if (row.value === min)
          derived.push({ name: row.name, value: row.value, kind: "min" });
        else if (row.value === max) {
          derived.push({ name: row.name, value: row.value, kind: "max" });
        }
      }
      return derived;
    })();

    return (
      <div style={{ height: wrapH, width: "100%" }}>
        <ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={0}
          minHeight={0} initialDimension={{ width: 1, height: 1 }}
        >
          <AreaChart
            data={areaData}
            margin={{
              top: isExpanded ? 28 : 16,
              right: isExpanded ? 54 : 30,
              left: 12,
              bottom: isMultiSeries ? expandedBottomChartMargin : 12,
            }}
            onClick={emitFromActive}
          >
            <defs>
              <linearGradient
                id={`grad-line-${chart.id}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop
                  offset="5%"
                  stopColor="rgb(var(--color-accent-violet))"
                  stopOpacity={0.3}
                />
                <stop
                  offset="95%"
                  stopColor="rgb(var(--color-accent-violet))"
                  stopOpacity={0}
                />
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
              tickMargin={8}
              height={expandedXAxisHeight + xAxisTitlePad}
              {...xAxisTitleProp}
            />
            <YAxis
              tick={tickStyle}
              tickLine={false}
              axisLine={false}
              tickFormatter={yTick}
              width={56 + yAxisTitleWidth}
              tickMargin={8}
              {...yAxisTitleProp}
            />
            {refOnRightAxis &&
              refValue != null &&
              Number.isFinite(refValue) && (
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  // The reference value is the only thing on this axis (no plotted series), so
                  // an "auto" max would collapse to 0 and hide the line. Scale the axis to the
                  // reference value (with headroom) so the line sits visibly near the top.
                  domain={[0, Math.abs(refValue) * 1.15]}
                  tick={tickStyle}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => refAxisFmt(Number(v) || 0)}
                  width={56}
                  tickMargin={8}
                />
              )}
            <Tooltip
              content={
                <CustomTooltip
                  metric={chart.config.metric}
                  grouping={chart.config.grouping}
                  valueFormatter={(value: number, entry: any) =>
                    fmtSeriesValue(
                      Number(value) || 0,
                      String(entry?.dataKey ?? entry?.name ?? ""),
                      chart.config.display?.valueFormat ?? null,
                    )
                  }
                />
              }
            />
            {refSeriesKey &&
              refValue != null &&
              Number.isFinite(refValue) &&
              !refOnRightAxis && (
                <ReferenceLine
                  y={refValue}
                  stroke="rgb(var(--color-accent-cyan))"
                  strokeDasharray="6 3"
                  strokeWidth={1.6}
                  label={{
                    value: prettySeriesName(refSeriesKey),
                    position: "insideTopRight",
                    fill: "rgb(var(--color-accent-cyan))",
                    fontSize: 10,
                  }}
                />
              )}
            {/* A reference for a DIFFERENT metric lives on the secondary axis. recharts
                won't tick a y-axis that has no plotted series, so draw the (constant)
                reference column as a flat dashed Line bound to the right axis — that both
                anchors/scales the axis and renders the line visibly. */}
            {refSeriesKey &&
              refValue != null &&
              Number.isFinite(refValue) &&
              refOnRightAxis && (
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey={refSeriesKey}
                  name={prettySeriesName(refSeriesKey)}
                  stroke="rgb(var(--color-accent-cyan))"
                  strokeDasharray="6 3"
                  strokeWidth={1.6}
                  dot={false}
                  activeDot={false}
                  isAnimationActive={false}
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
            {(chart.config.display?.highlightNames ?? []).map((nm) => {
              const row = (areaData as any[]).find(
                (d) => String(d.name) === String(nm),
              );
              const yv = row ? Number((row as any).value) : NaN;
              if (!Number.isFinite(yv)) return null;
              return (
                <ReferenceDot
                  key={`hi-${nm}`}
                  x={String(nm)}
                  y={yv}
                  r={7}
                  fill="#f59e0b"
                  stroke="rgb(var(--color-bg-card))"
                  strokeWidth={2}
                  label={{
                    value: String(nm),
                    position: "top",
                    fill: "#f59e0b",
                    fontSize: 10,
                    fontWeight: 700,
                  }}
                />
              );
            })}
            {extremaMarkers.map((marker) => {
              const isMax = marker.kind === "max";
              const color = isMax
                ? "rgb(var(--color-success))"
                : "rgb(var(--color-danger))";
              return (
                <ReferenceDot
                  key={`${marker.kind}-${marker.name}-${marker.value}`}
                  x={marker.name}
                  y={marker.value}
                  r={6}
                  fill={color}
                  stroke="rgb(var(--color-bg-card))"
                  strokeWidth={2}
                  label={{
                    value: isMax ? "High" : "Low",
                    position: isMax ? "top" : "bottom",
                    fill: color,
                    fontSize: 10,
                    fontWeight: 700,
                  }}
                />
              );
            })}
            {(chart.config.display?.highlightNegative ||
              shouldForceNegativeEmphasis) &&
              (areaData as any[]).some(
                (d) => Number((d as any)?.value) < 0,
              ) && (
                <ReferenceLine
                  y={0}
                  stroke="rgb(var(--color-danger))"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                />
              )}
            {(chart.config.display?.highlightNegative ||
              shouldForceNegativeEmphasis) &&
              !isMultiSeries &&
              (areaData as any[])
                .filter((d) => Number((d as any)?.value) < 0)
                .map((d) => (
                  <ReferenceDot
                    key={`neg-${String((d as any).name)}`}
                    x={String((d as any).name)}
                    y={Number((d as any).value)}
                    r={5}
                    fill="rgb(var(--color-danger))"
                    stroke="rgb(var(--color-bg-card))"
                    strokeWidth={2}
                  />
                ))}
            {isMultiSeries ? (
              <>
                {visibleSeriesKeys.map((k, idx) => {
                  const isMa = Boolean(maSuffix && k.endsWith(maSuffix));
                  const isHighlighted = highlightedSeries.has(k);
                  const color = seriesColor(k, seriesKeys, idx);
                  return (
                    <Area
                      key={k}
                      type="monotone"
                      dataKey={k}
                      name={prettySeriesName(k)}
                      stroke={color}
                      strokeWidth={
                        isHighlighted
                          ? isExpanded
                            ? 4
                            : 3.4
                          : isExpanded
                            ? 2.3
                            : 2
                      }
                      strokeOpacity={
                        hasSeriesHighlight && !isHighlighted ? 0.22 : 1
                      }
                      strokeDasharray={isMa ? "5 3" : undefined}
                      stackId={
                        effectiveChartType === "stacked_area" && !isMa
                          ? "stacked-area"
                          : undefined
                      }
                      fill={color}
                      fillOpacity={
                        hasSeriesHighlight && !isHighlighted
                          ? 0.01
                          : isMa
                            ? 0
                            : effectiveChartType === "stacked_area" ||
                                chart.type === "area"
                              ? 0.18
                              : 0.08
                      }
                      dot={false}
                      activeDot={{
                        r: 5,
                        fill: color,
                        strokeWidth: 2,
                        stroke: "rgb(var(--color-bg-card))",
                      }}
                      isAnimationActive={false}
                    >
                      {!isMa && multiSeriesLabelMode !== "none" && (
                        <LabelList
                          dataKey={k}
                          content={
                            multiSeriesLabelMode === "latest"
                              ? latestOnlyLabel(
                                  areaData,
                                  k,
                                  (n) =>
                                    fmtSeriesValue(
                                      n,
                                      k,
                                      chart.config.display?.valueFormat ?? null,
                                    ),
                                  idx,
                                )
                              : thinnedLabel(
                                  multiSeriesLabelMode === "full"
                                    ? 1
                                    : labelStride(
                                        areaData.length,
                                        Math.max(
                                          4,
                                          Math.floor(
                                            12 /
                                              Math.max(
                                                1,
                                                visibleSeriesKeys.length,
                                              ),
                                          ),
                                        ),
                                      ),
                                  (n) =>
                                    fmtSeriesValue(
                                      n,
                                      k,
                                      chart.config.display?.valueFormat ?? null,
                                    ),
                                  -8,
                                )
                          }
                        />
                      )}
                    </Area>
                  );
                })}
                <Legend
                  verticalAlign="bottom"
                  height={expandedLegendHeight}
                  iconType="circle"
                  iconSize={8}
                  wrapperStyle={{
                    fontSize: isExpanded ? 11 : 10,
                    fontWeight: 600,
                    paddingTop: isExpanded ? 8 : 4,
                  }}
                  formatter={(value: string) => (
                    <span style={{ color: "rgb(var(--color-text-secondary))" }}>
                      {prettySeriesName(String(value))}
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
                    ? {
                        r: 4,
                        fill: "rgb(var(--color-accent-violet))",
                        strokeWidth: 0,
                      }
                    : false
                }
                activeDot={{
                  r: 5,
                  fill: "rgb(var(--color-accent-violet))",
                  strokeWidth: 2,
                  stroke: "rgb(var(--color-bg-card))",
                }}
              >
                {singleSeriesLabelMode !== "none" && (
                  <LabelList
                    dataKey="value"
                    content={
                      singleSeriesLabelMode === "latest"
                        ? latestOnlyLabel(areaData, "value", (n) => yTick(n))
                        : thinnedLabel(
                            singleSeriesLabelMode === "full"
                              ? 1
                              : labelStride(areaData.length),
                            (n) => yTick(n),
                            -8,
                          )
                    }
                  />
                )}
              </Area>
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "waterfall") {
    const labelSeriesKey = chart.config.display?.labelSeries ?? null;
    // A row flagged is_total (e.g. the "Gross Margin" bar in a Revenue→Cost→Margin
    // bridge) is drawn from zero as a subtotal, not as another increment — without
    // this the bridge double-counts and only the first measure looked meaningful.
    const rows = data.map((d) => ({
      name: String((d as any).name ?? ""),
      value: Number((d as any).value) || 0,
      labelValue:
        labelSeriesKey && (d as any)[labelSeriesKey] !== undefined
          ? (d as any)[labelSeriesKey]
          : null,
      isTotal:
        Number((d as any).is_total) === 1 ||
        (d as any).is_total === true ||
        (d as any).isTotal === true,
    }));
    // When NO row is explicitly flagged is_total (e.g. an LLM-built P&L bridge
    // Revenue → Cost → Gross Margin → Payroll → Net Profit), auto-detect SUBTOTAL
    // rows: a row whose value equals the running cumulative of the preceding
    // increments is a checkpoint (Gross Margin = Revenue−Cost, Net Profit = sum so
    // far), NOT another increment. Drawing it as an increment double-counts and
    // corrupts the bridge. Structural signal (value ≈ running), not a keyword match.
    const anyExplicitTotal = rows.some((r) => r.isTotal);
    let running = 0;
    const wf = rows.map((r, i) => {
      const autoTotal =
        !anyExplicitTotal &&
        i > 0 &&
        Math.abs(r.value - running) <= Math.max(1, Math.abs(running) * 0.005);
      if (r.isTotal || autoTotal) {
        const base = Math.min(0, r.value);
        // A subtotal establishes the baseline for the following movements.
        // Without this, an opening-balance total was drawn correctly but every
        // account-group change incorrectly started from zero.
        running = r.value;
        return {
          name: r.name,
          base,
          delta: Math.abs(r.value),
          _pos: r.value >= 0,
          _total: true,
          _raw: r.value,
          _labelValue: r.labelValue,
        };
      }
      const start = running;
      const end = running + r.value;
      const base = Math.min(start, end);
      const delta = Math.abs(r.value);
      running = end;
      return {
        name: r.name,
        base,
        delta,
        _pos: r.value >= 0,
        _total: false,
        _raw: r.value,
        _labelValue: r.labelValue,
      };
    });
    // Few-bar bridges read best with the labels rotated only when crowded.
    const manyBars = wf.length > 14;
    // "Highlight the largest / smallest balances" → ring the extreme increment bar(s)
    // with a gold (max) / blue (min) outline so it stands out from the green/red bars.
    const wfExtremes = chart.config.display?.highlightExtremes ?? null;
    let wfMaxIdx = -1;
    let wfMinIdx = -1;
    if (wfExtremes) {
      let mx = -Infinity;
      let mn = Infinity;
      wf.forEach((e, i) => {
        if (e._total) return; // a subtotal isn't an individual balance
        if (e._raw > mx) {
          mx = e._raw;
          wfMaxIdx = i;
        }
        if (e._raw < mn) {
          mn = e._raw;
          wfMinIdx = i;
        }
      });
    }
    const wfRing = (idx: number): { stroke: string; width: number } | null => {
      if (!wfExtremes) return null;
      if ((wfExtremes === "max" || wfExtremes === "both") && idx === wfMaxIdx)
        return { stroke: "#f59e0b", width: 3 };
      if ((wfExtremes === "min" || wfExtremes === "both") && idx === wfMinIdx)
        return { stroke: "#3b82f6", width: 3 };
      return null;
    };

    return (
      <div style={{ height: wrapH, width: "100%" }}>
        <ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={0}
          minHeight={0} initialDimension={{ width: 1, height: 1 }}
        >
          <BarChart
            data={wf}
            margin={{ top: 16, right: 4, left: 12, bottom: manyBars ? 46 : 4 }}
            onClick={emitFromActive}
          >
            <CartesianGrid {...gridStyle} vertical={false} />
            <XAxis
              dataKey="name"
              tick={tickStyle}
              tickLine={false}
              axisLine={false}
              interval={0}
              angle={manyBars ? -40 : 0}
              textAnchor={manyBars ? "end" : "middle"}
              height={manyBars ? 70 : 24}
              tickFormatter={(value: unknown) => {
                const label = String(value ?? "");
                return wf.length > 24 && label.length > 20
                  ? `${label.slice(0, 19)}…`
                  : label;
              }}
            />
            <YAxis
              tick={tickStyle}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => fmtVal(Number(v) || 0)}
              width={56}
              tickMargin={8}
            />
            {refSeriesKey && refValue != null && Number.isFinite(refValue) && (
              <ReferenceLine
                y={refValue}
                stroke="rgb(var(--color-accent-cyan))"
                strokeWidth={2}
                strokeDasharray="6 4"
                ifOverflow="extendDomain"
                label={{
                  value: `${prettySeriesName(refSeriesKey)} ${fmtSeriesValue(refValue, refSeriesKey)}`,
                  position: "insideTopRight",
                  fill: "rgb(var(--color-accent-cyan))",
                  fontSize: isExpanded ? 11 : 10,
                }}
              />
            )}
            <Tooltip
              cursor={{ fill: "rgba(var(--color-text-muted)/0.08)" }}
              content={({ payload }) => {
                const d = payload?.[0]?.payload;
                if (!d) return null;
                return (
                  <div className="rounded-lg border border-default bg-bg-elevated p-2 text-[10px] shadow-lg">
                    <p className="font-semibold text-text-primary">{d.name}</p>
                    <p className="text-text-muted">
                      {fmtVal(Number(d._raw) || 0)}
                      {d._total ? " (subtotal)" : ""}
                    </p>
                  </div>
                );
              }}
            />
            <Bar
              dataKey="base"
              stackId="wf"
              fill="transparent"
              isAnimationActive={false}
            />
            <Bar
              dataKey="delta"
              stackId="wf"
              radius={[6, 6, 0, 0]}
              maxBarSize={64}
              fillOpacity={1}
              isAnimationActive={false}
            >
              {wf.map((entry, idx) => {
                const ring = wfRing(idx);
                return (
                  <Cell
                    key={idx}
                    fill={
                      entry._total
                        ? "#6366f1"
                        : entry._pos
                          ? "#10b981"
                          : "#ef4444"
                    }
                    stroke={ring ? ring.stroke : "none"}
                    strokeWidth={ring ? ring.width : undefined}
                  />
                );
              })}
              {(_forceLabels || wf.length <= 14) && (
                <LabelList
                  dataKey="_raw"
                  position="top"
                  offset={6}
                  style={{
                    fill: "rgb(var(--color-text-secondary))",
                    fontSize: isExpanded ? 10 : 9,
                    fontWeight: 600,
                  }}
                  formatter={(v: unknown) => fmtVal(Number(v) || 0)}
                />
              )}
              {labelSeriesKey && (
                <LabelList
                  dataKey="_labelValue"
                  position="insideTop"
                  offset={-2}
                  style={{
                    fill: "rgb(var(--color-text-muted))",
                    fontSize: isExpanded ? 9 : 8,
                    fontWeight: 700,
                  }}
                  formatter={(v: unknown) => {
                    if (v === null || v === undefined || v === "") return "";
                    const n = Number(v);
                    if (!Number.isFinite(n)) return String(v);
                    return fmtLabel(n);
                  }}
                />
              )}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (effectiveChartType === "combo") {
    type ComboFmt = "currency" | "number" | "percent";
    type ComboSeries = {
      key: string;
      role: "bar" | "line";
      axis: "left" | "right" | "farRight";
      format: ComboFmt;
    };
    const ignoredKeys = new Set([
      "name",
      refSeriesKey ?? "",
      chart.config.display?.labelSeries ?? "",
    ]);
    // Combo series must be inferred across ALL rows, not just the first one. YoY /
    // prior-year overlays are null for early periods by design, so first-row-only
    // detection silently dropped the whole comparison series and its right axis.
    const nonZeroInferredKeys = inferNumericSeriesKeys(data).filter(
      (k) => !ignoredKeys.has(k),
    );
    // Per-series roles from the backend (display.series) are the source of truth:
    // they say which measures are clustered BARS vs LINES and on which axis. This
    // replaces the old "first column = bar, every other = a %-axis line" assumption
    // that broke "show both as bars", "debit/credit columns missing", and units.
    const configuredMeta = (chart.config.display?.series ?? []).filter(
      (s): s is NonNullable<typeof s> => !!s && typeof s.key === "string",
    );
    // A requested/configured measure remains part of the chart even when every
    // value in the selected period is legitimately zero. Generic inference drops
    // empty noise, but it must not silently erase explicit series such as Payroll
    // Liability or Tax Liability from the legend and tooltip.
    const inferredKeys = [
      ...configuredMeta
        .map((s) => s.key)
        .filter(
          (key) => !ignoredKeys.has(key) && hasFiniteValueKey(data, key),
        ),
      ...nonZeroInferredKeys.filter(
        (key) => !configuredMeta.some((s) => s.key === key),
      ),
    ];
    // Long-form breakdown queries pivot into keys such as
    // "Manager — Employee Headcount". Match those concrete keys back to their
    // measure metadata so every grade remains a bar on the headcount axis while
    // an aggregate salary/margin overlay remains a line on its proper axis.
    const metaRaw = inferredKeys.flatMap((actualKey) => {
      const matched = configuredMeta.find(
        (s) => actualKey === s.key || actualKey.endsWith(` — ${s.key}`),
      );
      return matched && !ignoredKeys.has(actualKey)
        ? [{ ...matched, key: actualKey }]
        : [];
    });
    const orderedKeys = [
      ...metaRaw.map((s) => s.key),
      ...inferredKeys.filter((k) => !metaRaw.some((s) => s.key === k)),
    ];
    let series: ComboSeries[];
    if (metaRaw.length >= 1) {
      series = metaRaw.map((s) => ({
        key: s.key,
        role: s.role === "line" ? "line" : "bar",
        axis: s.axis === "right" ? "right" : "left",
        format: (s.format ?? "number") as ComboFmt,
      }));
      // Defensive: any numeric column the backend didn't describe is added as a line.
      for (const k of orderedKeys)
        if (!series.some((s) => s.key === k))
          series.push({
            key: k,
            role: "line",
            axis: "right",
            format: "number",
          });
    } else {
      // Legacy heuristic fallback (non-EBPO combos without series metadata).
      // Derive each column's unit from its NAME (revenue/cost/value→currency, pct/share/
      // rate→percent, days/count→number). A chart-wide percent valueFormat describes a
      // percentage OVERLAY (e.g. a cumulative-% line added to a revenue Pareto), so it must
      // NOT be force-applied to the absolute bar measure — otherwise the $ bar axis renders
      // as "%" (the "7000000.0%" corruption).
      const inferComboFmt = (key: string | undefined | null): ComboFmt =>
        inferFormatFromKey(key ?? null, null) as ComboFmt;
      // `value` is the implicit PRIMARY measure: inferNumericSeriesKeys() excludes it, so
      // orderedKeys holds only the overlay columns (e.g. cumulative_pct, threshold_pct).
      // It must be the bar on the LEFT axis with its own ($/count) unit; same-unit overlays
      // join it on the left, different-unit overlays (the %s) get the right axis.
      const hasValue = data.some(
        (r) => toFiniteNumber((r as any).value) != null,
      );
      // With NO overlay columns there is nothing else the chart-wide valueFormat could
      // describe — it IS the primary series' unit (e.g. a company-share % rendered as a
      // combo). Only when overlays exist does valueFormat risk describing the overlay,
      // so only then fall back to name inference (the "7000000.0%" Pareto guard).
      const valueFmt: ComboFmt =
        orderedKeys.length === 0
          ? ((chart.config.display?.valueFormat as ComboFmt) ??
            inferComboFmt("value"))
          : inferComboFmt("value");
      series = [];
      if (hasValue)
        series.push({
          key: "value",
          role: "bar",
          format: valueFmt,
          axis: "left",
        });
      orderedKeys.forEach((k, i) => {
        const fmt = inferComboFmt(k);
        series.push({
          key: k,
          role: !hasValue && i === 0 ? "bar" : "line",
          format: fmt,
          axis: fmt === valueFmt ? "left" : "right",
        });
      });
      // No absolute primary at all → the first overlay anchors the left axis.
      if (!hasValue && series[0]) series[0] = { ...series[0], axis: "left" };
    }

    // Safety net for same-format combos whose metadata lost the secondary axis.
    // If a line series is orders of magnitude away from the bar series, keep it on
    // the right axis so the primary series does not collapse to the baseline.
    if (!series.some((s) => s.axis === "right")) {
      const maxFor = (key: string) =>
        Math.max(
          0,
          ...data.map((r) =>
            Math.abs(toFiniteNumber((r as Record<string, unknown>)[key]) ?? 0),
          ),
        );
      const barMax = Math.max(
        0,
        ...series.filter((s) => s.role === "bar").map((s) => maxFor(s.key)),
      );
      series = series.map((s) => {
        if (s.role !== "line") return s;
        const lineMax = maxFor(s.key);
        if (barMax > 0 && lineMax > 0) {
          const ratio =
            Math.max(barMax, lineMax) / Math.max(1, Math.min(barMax, lineMax));
          if (ratio >= 20) return { ...s, axis: "right" as const };
        }
        return s;
      });
    }

    // A combo can legitimately contain three scales (for example payroll $, paid
    // hours, and $ per paid hour). Never merge unlike units onto one right axis:
    // move a scale-separated line that shares the primary bar's FORMAT to a
    // second right-side axis so its values remain visible and correctly labelled.
    const primaryBarFormat = series.find(
      (s) => s.axis === "left" && s.role === "bar",
    )?.format;
    const rightFormats = new Set(
      series.filter((s) => s.axis === "right").map((s) => s.format),
    );
    if (primaryBarFormat && rightFormats.size > 1) {
      series = series.map((s) =>
        s.axis === "right" && s.format === primaryBarFormat
          ? { ...s, axis: "farRight" as const }
          : s,
      );
    }

    const barSeries = series.filter((s) => s.role === "bar");
    const lineSeries = series.filter((s) => s.role === "line");
    const usesRight =
      series.some((s) => s.axis === "right") ||
      chart.config.display?.referenceAxis === "right" ||
      (!!chart.config.display?.secondaryAxisFormat && lineSeries.length > 0);
    const usesFarRight = series.some((s) => s.axis === "farRight");
    const leftFmt: ComboFmt =
      series.find((s) => s.axis === "left")?.format ??
      (chart.config.display?.valueFormat as ComboFmt) ??
      "currency";
    const rightFmt: ComboFmt =
      series.find((s) => s.axis === "right")?.format ??
      (chart.config.display?.secondaryAxisFormat as ComboFmt) ??
      "percent";
    const farRightFmt: ComboFmt =
      series.find((s) => s.axis === "farRight")?.format ?? "currency";
    const configuredSecondaryLabel = String(
      chart.config.display?.secondaryLabel ?? "",
    );
    const rightSeriesKeys = series
      .filter((s) => s.axis === "right")
      .map((s) => s.key);
    const conciseSecondaryLabel =
      rightFmt === "number" &&
      rightSeriesKeys.length > 0 &&
      rightSeriesKeys.every((key) => /\b(?:days?|dso|dpo)\b/i.test(key))
        ? "Days"
        : configuredSecondaryLabel;
    const fmtFor = (fmt: ComboFmt) => (v: number) =>
      fmt === "currency"
        ? fmtCurrency(Number(v) || 0)
        : fmt === "percent"
          ? `${(Number(v) || 0).toFixed(1)}%`
          : fmtNumber(Number(v) || 0);
    const fmtMap = new Map<string, ComboFmt>(
      series.map((s) => [s.key, s.format]),
    );

    const comboData = data.map((r) => {
      const o: Record<string, unknown> = { ...r };
      // Preserve a genuinely missing/undefined ratio as null. Coercing it to 0
      // invents a business value (for example, 0.0% margin when revenue is zero)
      // and draws a misleading point. Recharts correctly leaves null points open.
      for (const s of series) o[s.key] = toFiniteNumber(r[s.key]);
      return o;
    });
    const comboNameMaxLen = comboData.reduce(
      (max, row) => Math.max(max, String(row.name ?? "").length),
      0,
    );
    const comboLooksTimeSeries =
      comboData.length > 0 &&
      comboData.filter((row) =>
        /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b|\b(19|20)\d{2}\b|^\d{4}-\d{2}/i.test(
          String(row.name ?? ""),
        ),
      ).length >=
        comboData.length / 2;
    const comboNeedsRotatedLabels =
      !comboLooksTimeSeries &&
      (comboData.length > 5 || comboNameMaxLen > 14);
    const comboDenseTimeAxis =
      comboLooksTimeSeries && comboData.length > (isExpanded ? 16 : 12);
    const comboTimeTickStep = comboDenseTimeAxis
      ? Math.max(
          1,
          Math.ceil(
            (comboData.length - 1) / Math.max(1, (isExpanded ? 12 : 9) - 1),
          ),
        )
      : 1;
    const BAR_COLORS = [
      `url(#grad-bar-${chart.id})`,
      "rgb(var(--color-accent-blue))",
      "rgb(var(--color-accent-cyan))",
      "rgb(var(--color-accent-violet))",
    ];
    const LINE_COLORS = [
      "rgb(var(--color-accent-cyan))",
      "rgb(var(--color-accent-violet))",
      "rgb(var(--color-accent-blue))",
      "#22C55E",
      "#F59E0B",
      "#EC4899",
      "#14B8A6",
      "#F97316",
      "#A3E635",
      "#E879F9",
    ];
    const barSize = barSeries.length > 1 ? 28 : 56;
    const shouldStackBars =
      chart.config.spec?.chartType === "stacked_bar" && barSeries.length > 1;
    const comboBarLabelMode = pointLabelMode(
      comboData.length,
      Math.max(1, barSeries.length),
      _forceLabels,
      isExpanded,
    );
    const comboLineLabelMode = pointLabelMode(
      comboData.length,
      Math.max(1, lineSeries.length),
      _forceLabels,
      isExpanded,
    );
    const comboHeight =
      comboNeedsRotatedLabels && !isExpanded ? h + 80 : wrapH;

    return (
      <div style={{ height: comboHeight, width: "100%" }}>
        <ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={0}
          minHeight={0} initialDimension={{ width: 1, height: 1 }}
        >
          <ComposedChart
            data={comboData}
            // top margin must clear the value label that sits ABOVE the tallest
            // bar/point — with top:8 the max label (e.g. "$11.6M") clipped the top
            // border. ~22/28px reserves the label height so nothing is cut off.
            margin={{
              top: isExpanded ? 28 : 22,
              right: 12,
              left: 12,
              bottom: comboNeedsRotatedLabels
                ? isExpanded
                  ? 106
                  : 88
                : expandedBottomChartMargin,
            }}
            onClick={emitFromActive}
          >
            <defs>
              <linearGradient
                id={`grad-bar-${chart.id}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop
                  offset="0%"
                  stopColor="rgb(var(--color-accent-blue))"
                  stopOpacity={1}
                />
                <stop
                  offset="100%"
                  stopColor="rgb(var(--color-accent-violet))"
                  stopOpacity={0.8}
                />
              </linearGradient>
            </defs>
            <CartesianGrid {...gridStyle} vertical={false} />
            <XAxis
              dataKey="name"
              tick={
                comboNeedsRotatedLabels || comboDenseTimeAxis
                  ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    (props: any) => {
                      const index = Number(props.index ?? 0);
                      if (
                        comboDenseTimeAxis &&
                        index !== 0 &&
                        index !== comboData.length - 1 &&
                        (index % comboTimeTickStep !== 0 ||
                          comboData.length - 1 - index < comboTimeTickStep)
                      )
                        return null;
                      const x = Number(props.x ?? 0);
                      const y = Number(props.y ?? 0);
                      const label = String(props.payload?.value ?? "");
                      return (
                        <g transform={`translate(${x},${y})`}>
                          <text
                            x={0}
                            y={0}
                            dy={8}
                            textAnchor={
                              comboNeedsRotatedLabels
                                ? "end"
                                : comboDenseTimeAxis && index === 0
                                  ? "start"
                                  : comboDenseTimeAxis &&
                                      index === comboData.length - 1
                                    ? "end"
                                    : "middle"
                            }
                            transform={
                              comboNeedsRotatedLabels
                                ? "rotate(-45)"
                                : undefined
                            }
                            style={{
                              ...tickStyle,
                              fontSize: isExpanded ? 11 : 10,
                            }}
                          >
                            {label.length > 30
                              ? `${label.slice(0, 29)}…`
                              : label}
                          </text>
                        </g>
                      );
                    }
                  : tickStyle
              }
              tickLine={false}
              axisLine={false}
              minTickGap={14}
              interval={
                comboNeedsRotatedLabels || comboDenseTimeAxis
                  ? 0
                  : "preserveStartEnd"
              }
              tickMargin={8}
              height={
                (comboNeedsRotatedLabels
                  ? isExpanded
                    ? 74
                    : 62
                  : expandedXAxisHeight) + xAxisTitlePad
              }
              {...xAxisTitleProp}
            />
            <YAxis
              yAxisId="left"
              tick={tickStyle}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => fmtFor(leftFmt)(Number(v) || 0)}
              width={(isExpanded ? 68 : 56) + yAxisTitleWidth}
              tickMargin={8}
              {...yAxisTitleProp}
            />
            {usesRight && (
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={tickStyle}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => fmtFor(rightFmt)(Number(v) || 0)}
                width={conciseSecondaryLabel ? (isExpanded ? 76 : 64) : 48}
                tickMargin={8}
                {...(conciseSecondaryLabel
                  ? {
                      label: {
                        value: usesFarRight
                          ? /hours?/i.test(conciseSecondaryLabel)
                            ? "Hours"
                            : conciseSecondaryLabel.replace(
                                /\s*\/\s*USD\s*$/i,
                                "",
                              )
                          : conciseSecondaryLabel,
                        angle: 90,
                        position: "insideRight" as const,
                        offset: 6,
                        fontSize: axisTitleFontSize,
                        fill: axisTitleFill,
                        style: { textAnchor: "middle" as const },
                      },
                    }
                  : {})}
              />
            )}
            {usesFarRight && (
              <YAxis
                yAxisId="farRight"
                orientation="right"
                tick={tickStyle}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) =>
                  fmtFor(farRightFmt)(Number(v) || 0)
                }
                width={isExpanded ? 78 : 66}
                tickMargin={8}
                label={{
                  value: "USD / paid hr",
                  angle: 90,
                  position: "insideRight" as const,
                  offset: 6,
                  fontSize: axisTitleFontSize,
                  fill: axisTitleFill,
                  style: { textAnchor: "middle" as const },
                }}
              />
            )}
            <Tooltip
              content={
                <CustomTooltip
                  metric={chart.config.metric}
                  grouping={chart.config.grouping}
                  valueFormatter={(value: number, entry: any) =>
                    fmtFor(fmtMap.get(String(entry?.dataKey)) ?? leftFmt)(
                      Number(value) || 0,
                    )
                  }
                />
              }
            />
            {refSeriesKey && refValue != null && Number.isFinite(refValue) && (
              <ReferenceLine
                yAxisId={chart.config.display?.referenceAxis ?? "left"}
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
            {barSeries.map((s, i) => (
              <Bar
                key={s.key}
                yAxisId={s.axis}
                dataKey={s.key}
                name={s.key === "value" ? "value" : prettySeriesName(s.key)}
                fill={BAR_COLORS[i % BAR_COLORS.length]}
                radius={[6, 6, 0, 0]}
                maxBarSize={barSize}
                stackId={shouldStackBars ? "primary" : undefined}
              >
                {comboBarLabelMode !== "none" && (
                  <LabelList
                    dataKey={s.key}
                    content={
                      comboBarLabelMode === "latest"
                        ? latestOnlyLabel(
                            comboData as DataRow[],
                            s.key,
                            (n) => fmtFor(fmtMap.get(s.key) ?? leftFmt)(n),
                            i,
                            0,
                          )
                        : thinnedLabel(
                            comboBarLabelMode === "full"
                              ? 1
                              : labelStride(comboData.length),
                            (n) => fmtFor(fmtMap.get(s.key) ?? leftFmt)(n),
                            -4,
                          )
                    }
                  />
                )}
              </Bar>
            ))}
            {lineSeries.map((s, i) => {
              const color = LINE_COLORS[i % LINE_COLORS.length];
              return (
                <Line
                  key={s.key}
                  yAxisId={s.axis}
                  type="monotone"
                  dataKey={s.key}
                  name={prettySeriesName(s.key)}
                  stroke={color}
                  strokeWidth={isExpanded ? 2.5 : 2}
                  strokeDasharray={
                    /previous year/i.test(s.key)
                      ? "7 4"
                      : /variance\s*%/i.test(s.key)
                        ? "2 3"
                        : undefined
                  }
                  dot={
                    isExpanded ? { r: 4, fill: color, strokeWidth: 0 } : false
                  }
                  activeDot={{
                    r: 5,
                    fill: color,
                    strokeWidth: 2,
                    stroke: "rgb(var(--color-bg-card))",
                  }}
                >
                  {comboLineLabelMode !== "none" && (
                    <LabelList
                      dataKey={s.key}
                      content={
                        comboLineLabelMode === "latest"
                          ? latestOnlyLabel(
                              comboData as DataRow[],
                              s.key,
                              (n) => fmtFor(fmtMap.get(s.key) ?? rightFmt)(n),
                              i,
                            )
                          : thinnedLabel(
                              comboLineLabelMode === "full"
                                ? 1
                                : labelStride(
                                    comboData.length,
                                    Math.max(
                                      4,
                                      Math.floor(
                                        12 / Math.max(1, lineSeries.length),
                                      ),
                                    ),
                                  ),
                              (n) => fmtFor(fmtMap.get(s.key) ?? rightFmt)(n),
                              -8,
                            )
                      }
                    />
                  )}
                </Line>
              );
            })}
            <Legend
              verticalAlign="bottom"
              height={expandedLegendHeight}
              iconType="circle"
              iconSize={8}
              wrapperStyle={{
                fontSize: isExpanded ? 11 : 10,
                fontWeight: 600,
                paddingTop: isExpanded ? 8 : 4,
              }}
              formatter={(value: string) => (
                <span style={{ color: "rgb(var(--color-text-secondary))" }}>
                  {prettySeriesName(String(value))}
                </span>
              )}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (effectiveChartType === "bar" || effectiveChartType === "stacked_bar") {
    const barData =
      effectiveChartType === "stacked_bar" ? pivotLongSeriesRows(data) : data;
    const labelSeriesKey = chart.config.display?.labelSeries ?? null;
    // Detect multi-series FIRST (pivot data with one column per entity, no "value" key)
    const rawSeriesKeys = inferNumericSeriesKeys(barData).filter(
      (key) => key !== labelSeriesKey,
    );
    const rawHasValueSeries = hasFiniteValueKey(barData, "value");
    const isActuallyMultiSeries =
      !rawHasValueSeries && rawSeriesKeys.length >= 1;

    // Horizontal bars for ANY single-series categorical ranking with long or numerous
    // labels — the names then read straight across the axis instead of being rotated and
    // truncated to "London Client M…". Applies to every grouping (delivery center,
    // business unit, vendor, account, client…), not just clients. Multi-series (clustered)
    // pivots and time-series bars (months/years) stay vertical.
    const barNameMaxLen = barData.reduce(
      (m: number, d: any) => Math.max(m, String((d as any)?.name ?? "").length),
      0,
    );
    const barLooksTimeSeriesRaw =
      barData.length > 0 &&
      barData.filter((d: any) =>
        /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b|\b(19|20)\d{2}\b|^\d{4}-\d{2}/i.test(
          String((d as any)?.name ?? ""),
        ),
      ).length >=
        barData.length / 2;
    const useHorizontalBars =
      !isActuallyMultiSeries &&
      !barLooksTimeSeriesRaw &&
      barData.length >= 3 &&
      (barNameMaxLen > 14 ||
        (chart.config.grouping === "client" && data.length > 6));

    // Horizontal bars have vertical room, so show the WHOLE set for any realistic
    // categorical breakdown (departments, business units, countries…). The old cap
    // of 8 silently hid rows while the footer still counted them all — e.g. a
    // 10-department chart rendered 8 bars but read "10 points". This higher cap
    // covers every realistic breakdown; only genuinely huge sets are trimmed.
    const HBAR_CAP = isExpanded ? 40 : 20;
    const trimmed = useHorizontalBars ? barData.slice(0, HBAR_CAP) : barData;

    const seriesKeys = (
      isActuallyMultiSeries ? rawSeriesKeys : inferNumericSeriesKeys(trimmed)
    ).filter((k) => k !== refSeriesKey && k !== labelSeriesKey);
    const hasValueSeries = isActuallyMultiSeries
      ? false
      : hasFiniteValueKey(trimmed, "value");
    const barRefValue =
      refSeriesKey && trimmed.length > 0
        ? Number((trimmed[0] as any)[refSeriesKey])
        : null;
    // Time-series bars (months) keep one color; categorical bars get per-category colors.
    const barLooksTimeSeries =
      trimmed.length > 0 &&
      trimmed.filter((d: any) =>
        /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b|\b(19|20)\d{2}\b|^\d{4}-\d{2}/i.test(
          String((d as any).name ?? ""),
        ),
      ).length >=
        trimmed.length / 2;
    const isMultiSeries = !useHorizontalBars && isActuallyMultiSeries;
    const barHighlightedSeries = new Set(
      chart.config.display?.highlightSeries ?? [],
    );
    const hasBarSeriesHighlight = rawSeriesKeys.some((key) =>
      barHighlightedSeries.has(key),
    );
    // "highlight the top N clients" / a named category → emphasize matching bars, dim rest.
    const barHighlightNames = new Set(
      (chart.config.display?.highlightNames ?? []).map((s) => String(s)),
    );
    const highlightTopN = Math.max(
      0,
      Math.floor(Number(chart.config.display?.highlightTopN) || 0),
    );
    if (highlightTopN > 0 && !isMultiSeries) {
      [...trimmed]
        .sort(
          (a, b) =>
            (Number((b as any).value) || 0) -
            (Number((a as any).value) || 0),
        )
        .slice(0, highlightTopN)
        .forEach((row) => barHighlightNames.add(String((row as any).name ?? "")));
    }
    const hasBarHighlight = barHighlightNames.size > 0;
    // "highlight the largest / smallest" maps to highlightExtremes (max|min|both);
    // the legacy highlightMaxMin boolean implies both. Either one lights up the bars.
    const barExtremes = chart.config.display?.highlightExtremes ?? null;
    const highlightMaxMin =
      (Boolean(chart.config.display?.highlightMaxMin) || !!barExtremes) &&
      !isMultiSeries;
    const highlight = (() => {
      if (!highlightMaxMin) return null;
      const vals = trimmed.map((d) => Number((d as any).value) || 0);
      if (vals.length < 2) return null;
      const max = Math.max(...vals);
      const min = Math.min(...vals);
      if (!Number.isFinite(max) || !Number.isFinite(min) || max === min)
        return null;
      const showMax =
        !barExtremes || barExtremes === "max" || barExtremes === "both";
      const showMin =
        !barExtremes || barExtremes === "min" || barExtremes === "both";
      return { max, min, showMax, showMin };
    })();

    const needsRotatedLabels = !useHorizontalBars && trimmed.length > 5;
    // Dense time series still render every bar/point, but printing every monthly
    // tick makes a 4-year chart unreadable. Derive a label cadence from the
    // available view size and always retain the final period. The same cadence
    // is reused for stack-total labels so values line up with visible months.
    const denseTimeAxis =
      barLooksTimeSeries && trimmed.length > (isExpanded ? 16 : 12);
    const targetTimeTicks = isExpanded ? 12 : 9;
    const timeTickStep = denseTimeAxis
      ? Math.max(
          1,
          Math.ceil((trimmed.length - 1) / Math.max(1, targetTimeTicks - 1)),
        )
      : 1;
    const showAtTimeCadence = (index: number) =>
      !denseTimeAxis ||
      index % timeTickStep === 0 ||
      index === trimmed.length - 1;
    const nonZeroSeriesCells = isMultiSeries
      ? trimmed.reduce(
          (count, row) =>
            count +
            seriesKeys.filter(
              (key) => Math.abs(Number((row as any)[key]) || 0) > 0,
            ).length,
          0,
        )
      : 0;
    const sparseBreakdownBars =
      isMultiSeries &&
      chart.type === "bar" &&
      seriesKeys.length >= 5 &&
      trimmed.length > 0 &&
      nonZeroSeriesCells <= trimmed.length * 1.6;
    const isStackedBarChart =
      effectiveChartType === "stacked_bar" && isMultiSeries;
    const shouldStackBreakdownBars = isStackedBarChart || sparseBreakdownBars;
    // A 100%-stacked composition (each bar's segments sum to 100%): the grand total is
    // always 100, so a per-bar total label is noise — and it must NEVER be drawn as its
    // own stacked bar (that would double the stack height → a 200% axis).
    const isPercentStack =
      Boolean(chart.config.display?.normalized) ||
      (shouldStackBreakdownBars &&
        chart.config.display?.valueFormat === "percent");
    // Show a grand-total label on top of each stack ONLY for absolute (non-percent)
    // stacks, and anchor it to the topmost real segment instead of an extra stacked bar.
    const showStackTotal =
      shouldStackBreakdownBars && !labelSeriesKey && !isPercentStack;
    const displayKeys = isMultiSeries ? seriesKeys.slice(0, 20) : [];
    // Only a ratio/PERCENTAGE series is non-additive: it lives on a different unit and
    // cannot share a dollar stack (e.g. a margin %, variance %, growth %). DOLLAR measures
    // — Gross Profit, Net Income, Contribution $ — ARE additive and stack on top of the
    // other bars, matching the reference BI (which stacks gross profit as a third segment
    // on a revenue+expenses column). Previously any measure whose NAME contained
    // "margin"/"profit"/"variance" was forced to render as a standalone side-by-side bar
    // even when it held dollars, which broke stacked-column follow-ups like "add gross
    // profit values". Percentages still stay out of the stack (and off the grand-total sum).
    const isNonAdditiveKey = (k: string) =>
      /%|\b(pct|percent|percentage|share|ratio|rate)\b/i.test(
        String(k).replace(/_/g, " "),
      );
    const additiveKeys = shouldStackBreakdownBars
      ? displayKeys.filter((k) => !isNonAdditiveKey(k))
      : displayKeys;
    const lastAdditiveKey =
      additiveKeys.length > 0 ? additiveKeys[additiveKeys.length - 1] : null;
    const chartData =
      isMultiSeries && (shouldStackBreakdownBars || labelSeriesKey)
        ? trimmed.map((row) => ({
            ...(row as any),
            _total: additiveKeys.reduce(
              (s, k) => s + (Number((row as any)[k]) || 0),
              0,
            ),
            _labelAnchor: shouldStackBreakdownBars
              ? additiveKeys.reduce(
                  (s, k) => s + (Number((row as any)[k]) || 0),
                  0,
                )
              : Math.max(
                  ...displayKeys.map((k) => Number((row as any)[k]) || 0),
                  0,
                ),
          }))
        : trimmed;

    const barHeight = useHorizontalBars
      ? isExpanded
        ? h
        : Math.max(h, trimmed.length * 26 + 32)
      : needsRotatedLabels
        ? h + 60
        : h;

    // Horizontal bars draw each value label to the RIGHT of the bar end. Reserve a
    // right margin wide enough for the WIDEST formatted label so it can never spill
    // outside the chart card ("bars getting out of box"). Derived from the actual
    // formatted values (fmtVal) — so "$493.1M", "1,234", or "85.1%" all fit — never
    // a hardcoded width.
    const hbarValueLabelsShown =
      !!labelSeriesKey || _forceLabels || trimmed.length <= 15;
    const hbarLabelChars = useHorizontalBars
      ? Math.max(
          6,
          ...trimmed.map((r) => {
            const n = Number((r as Record<string, unknown>).value);
            return Number.isFinite(n) ? fmtVal(n).length : 0;
          }),
        )
      : 0;
    const hbarRightMargin =
      useHorizontalBars && hbarValueLabelsShown
        ? Math.min(
            140,
            Math.max(
              44,
              Math.round(hbarLabelChars * (isExpanded ? 6.8 : 6.2) + 16),
            ),
          )
        : 12;

    const barMargin = useHorizontalBars
      ? {
          top: 6,
          right: hbarRightMargin,
          left: 8,
          bottom: isExpanded ? 20 : 14,
        }
      : needsRotatedLabels
        ? {
            top: isExpanded ? 28 : 22,
            right: 4,
            left: 12,
            bottom: isExpanded ? 108 : 90,
          }
        : shouldStackBreakdownBars || labelSeriesKey
          ? { top: 28, right: 4, left: 12, bottom: expandedBottomChartMargin }
          : {
              top: 8,
              right: 4,
              left: 12,
              bottom: isMultiSeries ? expandedBottomChartMargin : 10,
            };

    return (
      <div style={{ height: barHeight, width: "100%" }}>
        <ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={0}
          minHeight={0} initialDimension={{ width: 1, height: 1 }}
        >
          <BarChart
            data={chartData}
            margin={barMargin}
            layout={useHorizontalBars ? "vertical" : "horizontal"}
          >
            <defs>
              <linearGradient
                id={`grad-bar-${chart.id}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop
                  offset="0%"
                  stopColor="rgb(var(--color-accent-blue))"
                  stopOpacity={1}
                />
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
                  tickFormatter={(v: number) => fmtVal(Number(v) || 0)}
                  tickMargin={8}
                  height={
                    expandedXAxisHeight +
                    (yAxisTitle ? xAxisTitlePad || (isExpanded ? 22 : 18) : 0)
                  }
                  {...(yAxisTitle
                    ? {
                        label: {
                          value: yAxisTitle,
                          position: "insideBottom" as const,
                          offset: isExpanded ? -8 : -6,
                          fontSize: axisTitleFontSize,
                          fill: axisTitleFill,
                        },
                      }
                    : {})}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  tick={tickStyle}
                  tickLine={false}
                  axisLine={false}
                  // Size the label gutter to the longest name so full labels fit without
                  // truncation. Capped so bars keep room; expanded (modal) gets far more.
                  width={Math.min(
                    isExpanded ? 340 : 190,
                    Math.max(120, barNameMaxLen * (isExpanded ? 7.5 : 6.5)),
                  )}
                  tickMargin={10}
                  interval={0}
                  tickFormatter={(v: string) => {
                    const label = humanizeCategoryLabel(v);
                    // Only truncate when a name would overrun the gutter; the gutter is
                    // sized above so most names show in full.
                    const limit = isExpanded ? 46 : 24;
                    return label.length > limit
                      ? label.slice(0, limit - 1) + "…"
                      : label;
                  }}
                />
              </>
            ) : (
              <>
                <XAxis
                  dataKey="name"
                  tick={
                    needsRotatedLabels
                      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        (props: any) => {
                          const x = Number(props.x ?? 0);
                          const y = Number(props.y ?? 0);
                          const index = Number(props.index ?? 0);
                          if (!showAtTimeCadence(index)) return null;
                          const label = String(props.payload?.value ?? "");
                          const labelLimit = isExpanded ? 36 : 24;
                          const truncated =
                            label.length > labelLimit
                              ? label.slice(0, labelLimit - 1) + "…"
                              : label;
                          return (
                            <g transform={`translate(${x},${y})`}>
                              <text
                                x={0}
                                y={0}
                                dy={8}
                                textAnchor="end"
                                transform="rotate(-45)"
                                style={{
                                  ...tickStyle,
                                  fontSize: isExpanded ? 11 : 10,
                                }}
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
                  tickMargin={8}
                  height={
                    (needsRotatedLabels
                      ? isExpanded
                        ? 68
                        : 56
                      : expandedXAxisHeight) + xAxisTitlePad
                  }
                  {...xAxisTitleProp}
                />
                <YAxis
                  tick={tickStyle}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={yTick}
                  width={56 + yAxisTitleWidth}
                  tickMargin={8}
                  {...yAxisTitleProp}
                  {...(dispNormalized ||
                  (shouldStackBreakdownBars &&
                    chart.config.display?.valueFormat === "percent")
                    ? // A 100%-stacked composition (each bar's segments sum to 100%) must
                      // cap the axis at 100 — auto-scale otherwise sums the per-series maxima
                      // (e.g. → 220%). Only stacked multi-series percent charts; a YoY/growth %
                      // line is single-series and never hits this branch.
                      { domain: [0, 100] as [number, number] }
                    : {})}
                />
              </>
            )}
            <Tooltip
              cursor={{ fill: "rgba(var(--color-text-muted)/0.08)" }}
              content={
                <CustomTooltip
                  metric={chart.config.metric}
                  grouping={chart.config.grouping}
                  valueFormatter={(value: number, entry: any) =>
                    fmtSeriesValue(
                      Number(value) || 0,
                      String(entry?.dataKey ?? entry?.name ?? "value"),
                      chart.config.display?.valueFormat ?? null,
                    )
                  }
                />
              }
            />
            {refSeriesKey &&
              barRefValue != null &&
              Number.isFinite(barRefValue) &&
              !useHorizontalBars && (
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
                {displayKeys.map((k, idx) => {
                  const isDerived =
                    shouldStackBreakdownBars && isNonAdditiveKey(k);
                  return (
                    <Bar
                      key={k}
                      dataKey={k}
                      name={prettySeriesName(k)}
                      fill={PIE_COLORS[idx % PIE_COLORS.length]}
                      fillOpacity={
                        hasBarSeriesHighlight && !barHighlightedSeries.has(k)
                          ? 0.25
                          : 1
                      }
                      radius={
                        shouldStackBreakdownBars && !isDerived
                          ? [0, 0, 0, 0]
                          : [4, 4, 0, 0]
                      }
                      maxBarSize={
                        shouldStackBreakdownBars
                          ? isExpanded
                            ? 48
                            : 36
                          : isExpanded
                            ? 20
                            : 16
                      }
                      stackId={
                        shouldStackBreakdownBars && !isDerived
                          ? "stack"
                          : undefined
                      }
                      isAnimationActive={false}
                      cursor={canInspect ? "pointer" : undefined}
                      onClick={(payload: any) =>
                        emitFigure(
                          String(payload?.payload?.name ?? payload?.name ?? ""),
                          prettySeriesName(k),
                          payload?.payload?.[k] ?? payload?.value,
                        )
                      }
                    >
                      {/* "Highlight the largest client" (and any named-category highlight) on a
                        clustered/multi-measure column chart: keep every series' color but dim
                        the categories that weren't asked for, so the highlighted category's
                        bars (across ALL measures) stand out. Without these Cells the multi-
                        series renderer ignored display.highlightNames entirely — the emphasis
                        never rendered even though the backend computed the right name. */}
                      {hasBarHighlight
                        ? chartData.map((entry: any, ci: number) => {
                            const isHi = barHighlightNames.has(
                              String(entry?.name ?? ""),
                            );
                            return (
                              <Cell
                                key={ci}
                                fill={PIE_COLORS[idx % PIE_COLORS.length]}
                                fillOpacity={isHi ? 1 : 0.25}
                              />
                            );
                          })
                        : null}
                      {k === lastAdditiveKey &&
                        labelSeriesKey &&
                        shouldStackBreakdownBars && (
                          <LabelList
                            dataKey={k}
                            content={rowLabel(
                              labelSeriesKey,
                              (n) => fmtLabel(n),
                              -6,
                              chartData,
                            )}
                          />
                        )}
                      {!shouldStackBreakdownBars &&
                        (_forceLabels ||
                          barHighlightedSeries.has(k) ||
                          (displayKeys.length <= 4 &&
                            chartData.length <= 12)) && (
                          <LabelList
                            dataKey={k}
                            position="top"
                            offset={4}
                            style={{
                              fill: "rgb(var(--color-text-secondary))",
                              fontSize: isExpanded ? 10 : 9,
                              fontWeight: 600,
                            }}
                            formatter={(v: unknown) =>
                              fmtSeriesValue(
                                Number(v) || 0,
                                k,
                                chart.config.display?.valueFormat ?? null,
                              )
                            }
                          />
                        )}
                      {/* A derived/ratio measure isn't part of the additive stack (see
                        DERIVED_MEASURE_RE above), so it needs its own top label rather
                        than relying on the shared grand-total anchor below. */}
                      {isDerived && (
                        <LabelList
                          dataKey={k}
                          position="top"
                          offset={4}
                          style={{
                            fill: "rgb(var(--color-text-secondary))",
                            fontSize: isExpanded ? 10 : 9,
                            fontWeight: 600,
                          }}
                          formatter={(v: unknown) =>
                            fmtSeriesValue(
                              Number(v) || 0,
                              k,
                              chart.config.display?.valueFormat ?? null,
                            )
                          }
                        />
                      )}
                      {/* Grand-total label on top of the stack: anchored to the topmost
                        real (additive) segment, excluding any derived measure bars above
                        (no extra stacked bar, so the axis isn't doubled). */}
                      {showStackTotal && k === lastAdditiveKey && (
                        <LabelList
                          dataKey="_total"
                          content={(props: any) => {
                            const index = Number(props.index ?? 0);
                            if (!showAtTimeCadence(index)) return null;
                            const isFirst = index === 0;
                            const isLast = index === chartData.length - 1;
                            const barX = Number(props.x ?? 0);
                            const barWidth = Number(props.width ?? 0);
                            const x = isFirst
                              ? barX
                              : isLast
                                ? barX + barWidth
                                : barX + barWidth / 2;
                            const y = Number(props.y ?? 0) - 6;
                            return (
                              <text
                                x={x}
                                y={y}
                                textAnchor={
                                  isFirst ? "start" : isLast ? "end" : "middle"
                                }
                                fill="rgb(var(--color-text-muted))"
                                fontSize={isExpanded ? 10 : 9}
                                fontWeight={600}
                              >
                                {fmtVal(Number(props.value) || 0)}
                              </text>
                            );
                          }}
                        />
                      )}
                    </Bar>
                  );
                })}
                {labelSeriesKey && !shouldStackBreakdownBars && (
                  <Bar
                    dataKey="_labelAnchor"
                    fill="transparent"
                    isAnimationActive={false}
                    legendType="none"
                  >
                    <LabelList
                      dataKey="_labelAnchor"
                      position="top"
                      content={rowLabel(
                        labelSeriesKey,
                        (n) => fmtLabel(n),
                        -6,
                        chartData,
                      )}
                    />
                  </Bar>
                )}
                <Legend
                  verticalAlign="bottom"
                  height={expandedLegendHeight}
                  iconType="circle"
                  iconSize={8}
                  wrapperStyle={{
                    fontSize: isExpanded ? 11 : 10,
                    fontWeight: 600,
                    paddingTop: isExpanded ? 8 : 4,
                  }}
                  formatter={(value: string) => (
                    <span
                      style={{
                        color: "rgb(var(--color-text-secondary))",
                        opacity:
                          hasBarSeriesHighlight &&
                          !barHighlightedSeries.has(String(value))
                            ? 0.38
                            : 1,
                        fontWeight: barHighlightedSeries.has(String(value))
                          ? 800
                          : 600,
                      }}
                    >
                      {prettySeriesName(String(value))}
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
                cursor={canInspect ? "pointer" : undefined}
                onClick={(payload: any) =>
                  emitFigure(
                    String(payload?.payload?.name ?? payload?.name ?? ""),
                    undefined,
                    payload?.payload?.value ?? payload?.value,
                  )
                }
              >
                {hasBarHighlight
                  ? trimmed.map((entry: any, idx: number) => {
                      const isHi = barHighlightNames.has(
                        String(entry?.name ?? ""),
                      );
                      return (
                        <Cell
                          key={idx}
                          fill={isHi ? "#f59e0b" : colorAt(idx)}
                          fillOpacity={isHi ? 1 : 0.25}
                        />
                      );
                    })
                  : highlight
                    ? trimmed.map((entry: any, idx: number) => {
                        const v = Number(entry?.value) || 0;
                        const isMax = highlight.showMax && v === highlight.max;
                        const isMin = highlight.showMin && v === highlight.min;
                        return (
                          <Cell
                            key={idx}
                            fill={
                              isMax ? "#10b981" : isMin ? "#ef4444" : "#7c3aed"
                            }
                          />
                        );
                      })
                    : !barLooksTimeSeries
                      ? trimmed.map((_: any, idx: number) => (
                          <Cell key={idx} fill={colorAt(idx)} />
                        ))
                      : null}
                {labelSeriesKey ? (
                  <LabelList
                    dataKey="value"
                    position={useHorizontalBars ? "right" : "top"}
                    offset={useHorizontalBars ? 6 : 4}
                    content={rowLabel(
                      labelSeriesKey,
                      (n) => fmtLabel(n),
                      useHorizontalBars ? 0 : -6,
                      chartData,
                      useHorizontalBars,
                    )}
                  />
                ) : (
                  (_forceLabels ||
                    (useHorizontalBars
                      ? trimmed.length <= 15
                      : trimmed.length <= 12)) && (
                    <LabelList
                      dataKey="value"
                      position={useHorizontalBars ? "right" : "top"}
                      offset={useHorizontalBars ? 6 : 4}
                      style={{
                        fill: "rgb(var(--color-text-secondary))",
                        fontSize: isExpanded ? 10 : 9,
                        fontWeight: 600,
                      }}
                      formatter={(v: unknown) => fmtVal(Number(v) || 0)}
                    />
                  )
                )}
              </Bar>
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "treemap") {
    const colorMetricKey = chart.config.display?.colorMetric ?? null;
    const colorMetricLabel =
      chart.config.display?.colorMetricLabel ??
      colorMetricKey ??
      "Color metric";
    const colorMetricFormat =
      chart.config.display?.colorMetricFormat ?? "number";
    const sizeFormat = chart.config.display?.valueFormat ?? "number";
    const labelMode = chart.config.display?.labelMode ?? null;
    const labelFormat = chart.config.display?.labelFormat ?? null;
    const showContributionPct =
      labelMode === "percent" || labelFormat === "percent";
    const fmtTreemapSize = (value: number): string =>
      fmtByUnit(value, sizeFormat);
    const fmtColorMetric = (value: number): string => {
      if (colorMetricFormat === "percent") return fmtPercent(value);
      if (colorMetricFormat === "currency") return fmtCurrency(value);
      return fmtNumber(value);
    };
    const seriesKeys = inferNumericSeriesKeys(data).filter(
      (key) => key !== colorMetricKey,
    );
    const hasValueSeries = hasFiniteValueKey(data, "value");
    const nodes =
      !hasValueSeries && seriesKeys.length > 1
        ? data.flatMap((d) =>
            seriesKeys.map((key) => ({
              name: `${String((d as any).name ?? "")} / ${key.replace(/_/g, " ")}`,
              size: Math.abs(Number((d as any)[key]) || 0),
              signedValue: Number((d as any)[key]) || 0,
              colorValue: colorMetricKey
                ? Number((d as any)[colorMetricKey])
                : null,
            })),
          )
        : data
            .map((d) => ({
              name: String((d as any).name ?? ""),
              path: String((d as any).path ?? (d as any).name ?? ""),
              size: Math.abs(Number((d as any).value) || 0),
              signedValue: Number.isFinite(Number((d as any).signedValue))
                ? Number((d as any).signedValue)
                : Number((d as any).value) || 0,
              colorValue: colorMetricKey
                ? Number((d as any)[colorMetricKey])
                : null,
            }))
            .filter((n) => n.name && Number.isFinite(n.size) && n.size > 0)
            .slice(0, 200);
    const colorValues = nodes
      .map((node) => Number(node.colorValue))
      .filter((value) => Number.isFinite(value));
    const hasColorMetric = Boolean(colorMetricKey && colorValues.length > 0);
    const totalSize = nodes.reduce(
      (sum, node) => sum + (Number(node.size) || 0),
      0,
    );
    const minColorValue = hasColorMetric ? Math.min(...colorValues) : 0;
    const maxColorValue = hasColorMetric ? Math.max(...colorValues) : 1;
    const lerp = (from: number, to: number, t: number) =>
      Math.round(from + (to - from) * Math.max(0, Math.min(1, t)));
    const metricColor = (value: unknown, fallbackIndex: number): string => {
      const n = Number(value);
      if (!hasColorMetric || !Number.isFinite(n)) {
        return (
          PIE_COLORS[fallbackIndex % PIE_COLORS.length] ??
          "rgb(var(--color-accent-violet))"
        );
      }
      const t =
        maxColorValue === minColorValue
          ? 0.5
          : (n - minColorValue) / (maxColorValue - minColorValue);
      if (t < 0.5) {
        const k = t / 0.5;
        return `rgb(${lerp(34, 245, k)}, ${lerp(197, 158, k)}, ${lerp(94, 11, k)})`;
      }
      const k = (t - 0.5) / 0.5;
      return `rgb(${lerp(245, 239, k)}, ${lerp(158, 68, k)}, ${lerp(11, 68, k)})`;
    };

    const TreemapCell = ({
      x,
      y,
      width,
      height,
      name,
      size,
      index,
      colorValue,
      signedValue,
      path,
      depth,
    }: any) => {
      // Recharts invokes custom content once for its synthetic root. Drawing
      // that root produces a meaningless full-size "$0" rectangle behind the
      // real cells and can remain visible in unused pixels when expanded.
      if (depth === 0) return null;
      const color = metricColor(colorValue, index);
      // Lower thresholds so smaller cells (e.g. all 24 vendors) still get a label,
      // and always provide a hover tooltip so nothing is unreadable/"empty".
      const showLabel = width > 38 && height > 18;
      const showValue = showContributionPct
        ? width > 38 && height > 18
        : width > 50 && height > 34;
      const charBudget = Math.max(3, Math.floor(width / 7));
      const label = String(name ?? "");
      const hierarchyPath = String(path ?? name ?? "");
      const contributionPct =
        showContributionPct && Number.isFinite(totalSize) && totalSize > 0
          ? ((Number(size) || 0) / totalSize) * 100
          : null;
      const valueText =
        contributionPct === null
          ? fmtTreemapSize(Number(signedValue) || 0)
          : fmtPercent(contributionPct);
      const colorLine =
        hasColorMetric && Number.isFinite(Number(colorValue))
          ? `\n${colorMetricLabel}: ${fmtColorMetric(Number(colorValue))}`
          : "";
      const titleText =
        contributionPct === null
          ? `${hierarchyPath}: ${fmtTreemapSize(Number(signedValue) || 0)}${colorLine}`
          : `${hierarchyPath}: ${fmtTreemapSize(Number(signedValue) || 0)}\nContribution: ${fmtPercent(contributionPct)}${colorLine}`;
      return (
        <g>
          <title>{titleText}</title>
          <rect
            x={x}
            y={y}
            width={width}
            height={height}
            fill={color}
            stroke="rgb(var(--color-bg-card))"
            strokeWidth={2}
            rx={4}
          />
          {showLabel && (
            <>
              <text
                x={x + width / 2}
                y={y + height / 2 - (showValue ? 6 : 0)}
                textAnchor="middle"
                dominantBaseline="central"
                fill="white"
                fontSize={Math.min(12, Math.max(8, width / 9))}
                fontWeight={700}
                paintOrder="stroke"
                stroke="rgba(0,0,0,0.35)"
                strokeWidth={2}
                style={{ pointerEvents: "none" }}
              >
                {label.length > charBudget
                  ? label.slice(0, charBudget - 1) + "…"
                  : label}
              </text>
              {showValue && (
                <text
                  x={x + width / 2}
                  y={y + height / 2 + 10}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill="rgba(255,255,255,0.9)"
                  fontSize={Math.min(10, width / 10)}
                  paintOrder="stroke"
                  stroke="rgba(0,0,0,0.3)"
                  strokeWidth={1.5}
                  style={{ pointerEvents: "none" }}
                >
                  {valueText}
                </text>
              )}
            </>
          )}
        </g>
      );
    };

    return (
      <div style={{ height: wrapH, width: "100%" }}>
        {hasColorMetric && (
          <div className="mb-2 flex items-center justify-end gap-2 text-[10px] font-bold text-text-secondary">
            <span>{colorMetricLabel}</span>
            <span>{fmtColorMetric(minColorValue)}</span>
            <span
              className="h-2 w-24 rounded-full"
              style={{
                background:
                  "linear-gradient(90deg, rgb(34,197,94), rgb(245,158,11), rgb(239,68,68))",
              }}
            />
            <span>{fmtColorMetric(maxColorValue)}</span>
          </div>
        )}
        <ResponsiveContainer
          width="100%"
          height={hasColorMetric ? Math.max(80, h - 24) : "100%"}
          minWidth={0}
          minHeight={0} initialDimension={{ width: 1, height: 1 }}
        >
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
    const hasXY =
      firstRow && num(firstRow.x) !== null && num(firstRow.y) !== null;
    const numKeys = inferNumericSeriesKeys(data);
    const nameKey =
      firstRow && typeof firstRow.name === "string" ? "name" : undefined;
    // Single-measure categorical scatter ("gross margin % by client"): there's only one
    // numeric column, so plot the CATEGORY on x (a labelled dot per client) and the
    // measure on y — rather than x===y on a meaningless diagonal.
    const singleCat = !hasXY && numKeys.length < 2 && !!nameKey;
    const xKey = hasXY ? "x" : singleCat ? nameKey! : (numKeys[0] ?? "x");
    const yKey = hasXY
      ? "y"
      : singleCat
        ? (numKeys[0] ?? "value")
        : (numKeys[1] ?? numKeys[0] ?? "y");
    const points = data.map((d: any) => ({
      ...d,
      ...(nameKey
        ? { [nameKey]: humanizeCategoryLabel(d[nameKey]) }
        : {}),
      [xKey]: singleCat
        ? humanizeCategoryLabel(d[xKey])
        : (num(d[xKey]) ?? 0),
      [yKey]: num(d[yKey]) ?? 0,
    }));

    // Rich visualization: every point gets its own colour, its name printed on
    // the chart, and a colour-coded legend below so the user always knows which
    // dot is which. Labels are only drawn on the chart when the point count is
    // small enough to stay legible; otherwise the legend + tooltip carry it.
    const xLabel = chart.config.xAxisLabel?.trim() || xKey.replaceAll("_", " ");
    const yLabel = chart.config.yAxisLabel?.trim() || yKey.replaceAll("_", " ");
    const visibleYLabel =
      !isExpanded && yLabel.length > 16
        ? yLabel.replace(/\baverage\b/gi, "Avg").replace(/\bhours?\b/gi, "hrs")
        : yLabel;
    const xFmt = resolveAxisFormatFromMetadata(
      xLabel,
      "x",
      chart.config.display?.valueFormat ?? "number",
    );
    const yFmt = resolveAxisFormatFromMetadata(
      yLabel,
      "y",
      chart.config.display?.secondaryAxisFormat ??
        chart.config.display?.valueFormat ??
        "number",
    );
    // A single-category scatter with few points already names every point clearly on the
    // X-AXIS, so drawing the name AGAIN above each dot (and a third time in the footer
    // legend below) is triple redundancy that clutters the chart. Suppress those two only
    // when the x-axis can comfortably show every label; a true X-vs-Y scatter, or a
    // high-cardinality category scatter whose axis labels would thin/overlap, still needs
    // the inline labels + colour legend to stay identifiable.
    const singleCatClean = singleCat && data.length <= 8;
    const showInlineLabels = !!nameKey && data.length <= 18 && !singleCatClean;
    // "highlight the largest client" → emphasize the named point(s), dim the rest.
    const scatterHighlight = new Set(
      (chart.config.display?.highlightNames ?? []).map((s) => String(s)),
    );
    const hasScatterHighlight = scatterHighlight.size > 0 && !!nameKey;
    return (
      <ZoomableChartFrame
        height={wrapH}
        enableXZoom={!singleCat}
        xValues={singleCat ? [] : points.map((p: any) => Number(p[xKey]) || 0)}
        yValues={points.map((p: any) => Number(p[yKey]) || 0)}
        footer={
          nameKey && !singleCatClean ? (
            <div className="mt-1 flex max-h-[34%] flex-wrap gap-x-3 gap-y-1 overflow-y-auto px-1">
              {points.map((d, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 text-[9px] text-text-secondary"
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: PIE_COLORS[i % PIE_COLORS.length] }}
                  />
                  {String((d as any)[nameKey])}
                </span>
              ))}
            </div>
          ) : undefined
        }
      >
        {(view) => (
          <ResponsiveContainer
            width="100%"
            height="100%"
            minWidth={0}
            minHeight={0} initialDimension={{ width: 1, height: 1 }}
          >
            <ScatterChart
              margin={{
                top: 24,
                right: isExpanded ? 40 : 24,
                left: 12,
                bottom: 24,
              }}
              onClick={emitFromActive}
            >
              <CartesianGrid {...gridStyle} />
              <XAxis
                dataKey={xKey}
                type={singleCat ? "category" : "number"}
                name={xLabel}
                tick={tickStyle}
                tickLine={false}
                axisLine={false}
                interval={0}
                {...(singleCat
                  ? {}
                  : {
                      tickFormatter: (v: number) =>
                        fmtByUnit(Number(v) || 0, xFmt),
                      domain: view.x,
                      allowDataOverflow: true,
                    })}
                label={{
                  value: xLabel,
                  position: "insideBottom",
                  offset: -8,
                  fontSize: 10,
                  fill: "rgb(var(--color-text-muted))",
                }}
              />
              <YAxis
                dataKey={yKey}
                type="number"
                name={yLabel}
                tick={tickStyle}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => fmtByUnit(Number(v) || 0, yFmt)}
                width={64}
                tickMargin={8}
                domain={view.y}
                allowDataOverflow
                label={{
                  value: visibleYLabel,
                  angle: -90,
                  position: "insideLeft",
                  offset: 4,
                  fontSize: 10,
                  fill: "rgb(var(--color-text-muted))",
                }}
              />
              <Tooltip
                cursor={{ strokeDasharray: "3 3" }}
                content={({ payload }) => {
                  const d = payload?.[0]?.payload;
                  if (!d) return null;
                  return (
                    <div className="rounded-xl border border-default bg-bg-card/95 p-3 shadow-2xl backdrop-blur-sm text-[11px]">
                      {nameKey && (
                        <p className="font-bold text-text-primary mb-1">
                          {d[nameKey]}
                        </p>
                      )}
                      {!singleCat && (
                        <p className="text-text-secondary">
                          {xLabel}: {fmtByUnit(Number(d[xKey]) || 0, xFmt)}
                        </p>
                      )}
                      <p className="text-text-secondary">
                        {yLabel}: {fmtByUnit(Number(d[yKey]) || 0, yFmt)}
                      </p>
                    </div>
                  );
                }}
              />
              <Scatter
                data={points as any}
                fillOpacity={0.9}
                isAnimationActive={false}
              >
                {points.map((p, i) => {
                  const isHi =
                    hasScatterHighlight &&
                    scatterHighlight.has(String((p as any)[nameKey!]));
                  return (
                    <Cell
                      key={i}
                      fill={
                        isHi ? "#f59e0b" : PIE_COLORS[i % PIE_COLORS.length]
                      }
                      fillOpacity={hasScatterHighlight && !isHi ? 0.22 : 0.9}
                      stroke={isHi ? "#f59e0b" : "none"}
                      strokeWidth={isHi ? 3 : 0}
                    />
                  );
                })}
                {showInlineLabels && (
                  <LabelList
                    dataKey={nameKey}
                    position="top"
                    offset={8}
                    style={{
                      fontSize: 9,
                      fontWeight: 600,
                      fill: "rgb(var(--color-text-secondary))",
                    }}
                  />
                )}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        )}
      </ZoomableChartFrame>
    );
  }

  if (chart.type === "pie") {
    const labelMode = chart.config.display?.labelMode ?? "percent";
    // Filter only positive values and find the label key (may be "name", "dept", "vendor", etc.)
    const labelKey = (() => {
      const row = data[0] as any;
      if (!row) return "name";
      if (typeof row.name === "string") return "name";
      return (
        Object.keys(row).find(
          (k) => k !== "value" && typeof row[k] === "string",
        ) ?? "name"
      );
    })();
    const cleaned = data
      .map((d) => {
        const rawValue = Number((d as any).raw_value);
        const fallbackValue = Number((d as any).value) || 0;
        return {
          ...d,
          name: String((d as any)[labelKey] ?? (d as any).name ?? ""),
          rawValue: Number.isFinite(rawValue) ? rawValue : fallbackValue,
          value: Math.abs(fallbackValue),
        };
      })
      .filter((d) => d.value > 0);
    const total = cleaned.reduce((s, d) => s + d.value, 0);
    const enriched = cleaned.map((d) => ({ ...d, total }));
    // "Highlight the highest/lowest gross margin" → ring the extreme slice (gold for
    // max, blue for min) instead of isolating/dropping the others.
    const pieExtremes = chart.config.display?.highlightExtremes ?? null;
    let pieMaxIdx = -1;
    let pieMinIdx = -1;
    if (pieExtremes) {
      let mx = -Infinity;
      let mn = Infinity;
      enriched.forEach((d, i) => {
        if (d.value > mx) {
          mx = d.value;
          pieMaxIdx = i;
        }
        if (d.value < mn) {
          mn = d.value;
          pieMinIdx = i;
        }
      });
    }
    const pieRing = (i: number): string | null => {
      if (!pieExtremes) return null;
      if ((pieExtremes === "max" || pieExtremes === "both") && i === pieMaxIdx)
        return "#f59e0b";
      if ((pieExtremes === "min" || pieExtremes === "both") && i === pieMinIdx)
        return "#3b82f6";
      return null;
    };

    const renderLabel = ({
      cx,
      cy,
      midAngle,
      innerRadius,
      outerRadius,
      percent,
      value,
      payload,
    }: any) => {
      if (percent < 0.06) return null;
      const RADIAN = Math.PI / 180;
      const r = innerRadius + (outerRadius - innerRadius) * 0.55;
      const x = cx + r * Math.cos(-midAngle * RADIAN);
      const y = cy + r * Math.sin(-midAngle * RADIAN);
      const labelText =
        labelMode === "value"
          ? fmtVal(Number((payload as any)?.rawValue ?? value) || 0)
          : fmtPercent((Number(percent) || 0) * 100);
      return (
        <text
          x={x}
          y={y}
          fill="white"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={isExpanded ? 12 : 10}
          fontWeight="700"
        >
          {labelText}
        </text>
      );
    };

    return (
      <div style={{ height: wrapH, width: "100%" }}>
        <ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={0}
          minHeight={0} initialDimension={{ width: 1, height: 1 }}
        >
          <PieChart>
            <Pie
              data={enriched}
              cx="45%"
              cy="50%"
              innerRadius={0}
              outerRadius={isExpanded ? "65%" : "58%"}
              paddingAngle={3}
              dataKey="value"
              nameKey="name"
              labelLine={false}
              label={renderLabel}
              cursor={canInspect ? "pointer" : undefined}
              onClick={(d: any) =>
                emitFigure(
                  String(d?.name ?? d?.payload?.name ?? ""),
                  undefined,
                  d?.value ?? d?.payload?.value,
                )
              }
              isAnimationActive={false}
            >
              {enriched.map((_, i) => {
                const ring = pieRing(i);
                return (
                  <Cell
                    key={i}
                    fill={PIE_COLORS[i % PIE_COLORS.length]}
                    stroke={ring ?? "none"}
                    strokeWidth={ring ? 4 : undefined}
                  />
                );
              })}
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
            <Legend
              layout="vertical"
              align="right"
              verticalAlign="middle"
              iconType="circle"
              iconSize={8}
              formatter={(value: string) => (
                <span
                  style={{
                    fontSize: isExpanded ? 11 : 10,
                    color: "rgb(var(--color-text-secondary))",
                    fontWeight: 600,
                  }}
                >
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
    const cols = rows.length > 0 ? Object.keys(rows[0] ?? {}).slice(0, 8) : [];
    const isCurrencyCol = (col: string) =>
      col === "value" ||
      /amount|spend|revenue|income|expense|total|cost|profit/i.test(col);
    const isPercentCol = (col: string) =>
      /pct|percent|share|ratio|rate/i.test(col);

    // A KPI-snapshot table unions heterogeneous metrics (Gross Margin %, DSO (Days),
    // Revenue $, …). The unit of each row lives in its NAME, so the "value" column must be
    // formatted PER ROW — otherwise a 35% margin renders as "$35" and 30 days as "$30".
    const rowName = (r: any) => String(r?.name ?? r?.metric ?? "");
    const rowUnit = (name: string): "percent" | "days" | "currency" => {
      const s = name.toLowerCase();
      if (
        /%|\bpct\b|percent|margin|\brate\b|\bratio\b|\bshare\b|\bsla\b|\bcsat\b|utili[sz]ation/.test(
          s,
        )
      )
        return "percent";
      if (/\bdays?\b|\bdso\b|\bdpo\b|\bdio\b|\bccc\b/.test(s)) return "days";
      return "currency";
    };
    const formatValueByName = (n: number, name: string): string => {
      const u = rowUnit(name);
      if (u === "percent") return `${n.toFixed(1)}%`;
      if (u === "days") return `${Math.round(n)}d`;
      return fmtCurrency(n);
    };
    // "% Share" and the "Total Spend" header only make sense when EVERY row is the same
    // currency (a real spend breakdown). For a mixed-unit KPI list both are meaningless.
    const allCurrencyValues =
      cols.includes("value") &&
      rows.length > 0 &&
      rows.every((r) => rowUnit(rowName(r)) === "currency");
    const totalSpend = allCurrencyValues
      ? rows.reduce((s, r) => s + (Number((r as any).value) || 0), 0)
      : 0;
    const showShare = allCurrencyValues && totalSpend > 0;
    const valueHeader = allCurrencyValues ? "Total Spend" : "Value";

    const formatCell = (
      col: string,
      val: unknown,
      rowIdx: number,
      row: any,
    ): string => {
      if (col === "rank") return String(rowIdx + 1);
      const n = typeof val === "number" ? val : Number(val);
      if (!Number.isFinite(n)) return String(val ?? "");
      if (col === "value") return formatValueByName(n, rowName(row));
      if (isPercentCol(col)) return `${n.toFixed(1)}%`;
      if (isCurrencyCol(col)) return fmtCurrency(n);
      return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(2);
    };

    return (
      <div
        style={{ height: wrapH, width: "100%" }}
        className="overflow-hidden rounded-xl border border-default bg-bg-elevated/30"
      >
        <div className="h-full overflow-auto">
          <table className="w-full text-left text-[11px]">
            <thead className="sticky top-0 bg-bg-elevated/80 backdrop-blur">
              <tr>
                <th className="px-3 py-2 font-bold uppercase tracking-wider text-text-muted w-8">
                  #
                </th>
                {cols.map((c) => (
                  <th
                    key={c}
                    className="px-3 py-2 font-bold uppercase tracking-wider text-text-muted"
                  >
                    {c === "value" ? valueHeader : c.replaceAll("_", " ")}
                  </th>
                ))}
                {showShare && (
                  <th className="px-3 py-2 font-bold uppercase tracking-wider text-text-muted">
                    % Share
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => (
                <tr
                  key={idx}
                  className="border-t border-default/50 hover:bg-bg-elevated/40 transition-colors"
                >
                  <td className="px-3 py-2 text-text-muted font-mono text-center">
                    {idx + 1}
                  </td>
                  {cols.map((c) => (
                    <td
                      key={c}
                      className={`px-3 py-2 whitespace-nowrap ${isCurrencyCol(c) ? "text-text-primary font-semibold" : "text-text-secondary"}`}
                    >
                      {formatCell(c, (r as any)?.[c], idx, r)}
                    </td>
                  ))}
                  {showShare && (
                    <td className="px-3 py-2 text-text-muted font-mono">{`${(((Number((r as any).value) || 0) / totalSpend) * 100).toFixed(1)}%`}</td>
                  )}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td
                    className="px-3 py-3 text-text-muted"
                    colSpan={(cols.length || 1) + 2}
                  >
                    No rows
                  </td>
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
      return (
        Object.keys(row).find(
          (k) => k !== "value" && typeof row[k] === "string",
        ) ?? "name"
      );
    })();
    // Filter negatives/zeros and normalise to {name, value}
    const donutData = data
      .map((d) => ({
        name: String((d as any)[labelKey] ?? (d as any).name ?? ""),
        rawValue: Number.isFinite(Number((d as any).raw_value))
          ? Number((d as any).raw_value)
          : Number((d as any).value) || 0,
        value: Math.abs(Number((d as any).value) || 0),
      }))
      .filter((d) => d.value > 0);
    const donutTotal = donutData.reduce((s, d) => s + d.value, 0);
    const donutDataWithTotal = donutData.map((d) => ({
      ...d,
      total: donutTotal,
    }));
    const donutHasSignedSlices = donutDataWithTotal.some(
      (d) => (Number(d.rawValue) || 0) < 0,
    );
    const normalizedDonutHighlights = (
      chart.config.display?.highlightNames ?? []
    )
      .map((name) => String(name).trim().toLocaleLowerCase())
      .filter(Boolean);
    const isNamedDonutHighlight = (name: string) => {
      const normalizedName = name.trim().toLocaleLowerCase();
      return normalizedDonutHighlights.some(
        (highlight) =>
          normalizedName === highlight ||
          normalizedName.startsWith(`${highlight} `) ||
          normalizedName.startsWith(`${highlight}-`),
      );
    };
    // "Highlight the highest/lowest" → ring the extreme slice (gold max / blue min).
    const donutExtremes = chart.config.display?.highlightExtremes ?? null;
    let donutMaxIdx = -1;
    let donutMinIdx = -1;
    if (donutExtremes) {
      let mx = -Infinity;
      let mn = Infinity;
      donutDataWithTotal.forEach((d, i) => {
        if (d.value > mx) {
          mx = d.value;
          donutMaxIdx = i;
        }
        if (d.value < mn) {
          mn = d.value;
          donutMinIdx = i;
        }
      });
    }
    const donutRing = (i: number): string | null => {
      if (isNamedDonutHighlight(donutDataWithTotal[i]?.name ?? ""))
        return "#f59e0b";
      if (!donutExtremes) return null;
      if (
        (donutExtremes === "max" || donutExtremes === "both") &&
        i === donutMaxIdx
      )
        return "#f59e0b";
      if (
        (donutExtremes === "min" || donutExtremes === "both") &&
        i === donutMinIdx
      )
        return "#3b82f6";
      return null;
    };

    const renderDonutLabel = ({
      cx,
      cy,
      midAngle,
      innerRadius,
      outerRadius,
      percent,
      value,
      payload,
    }: any) => {
      if (percent < 0.07) return null;
      const RADIAN = Math.PI / 180;
      const r = innerRadius + (outerRadius - innerRadius) * 0.5;
      const x = cx + r * Math.cos(-midAngle * RADIAN);
      const y = cy + r * Math.sin(-midAngle * RADIAN);
      const labelText =
        labelMode === "value"
          ? fmtVal(Number((payload as any)?.rawValue ?? value) || 0)
          : fmtPercent((Number(percent) || 0) * 100);
      return (
        <text
          x={x}
          y={y}
          fill="white"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={isExpanded ? 11 : 9}
          fontWeight="700"
        >
          {labelText}
        </text>
      );
    };

    return (
      <div style={{ height: isExpanded ? "100%" : h + 20, width: "100%" }}>
        <ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={0}
          minHeight={0} initialDimension={{ width: 1, height: 1 }}
        >
          <PieChart>
            {donutTotal > 0 && !donutHasSignedSlices && (
              <text
                x="50%"
                y={isExpanded ? "50%" : "46%"}
                textAnchor="middle"
                dominantBaseline="central"
                fill="rgb(var(--color-text-primary))"
                fontSize={isExpanded ? 13 : 11}
                fontWeight={700}
              >
                {chart.config.display?.normalized
                  ? "100%"
                  : fmtSeriesValue(
                      donutTotal,
                      "value",
                      chart.config.display?.valueFormat ?? null,
                    )}
              </text>
            )}
            <Pie
              data={donutDataWithTotal}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy={isExpanded ? "50%" : "44%"}
              innerRadius={isExpanded ? 70 : 52}
              outerRadius={isExpanded ? 120 : 88}
              paddingAngle={2}
              labelLine={false}
              label={renderDonutLabel}
              cursor={canInspect ? "pointer" : undefined}
              onClick={(d: any) =>
                emitFigure(
                  String(d?.name ?? d?.payload?.name ?? ""),
                  undefined,
                  d?.value ?? d?.payload?.value,
                )
              }
              isAnimationActive={false}
            >
              {donutDataWithTotal.map((slice, i) => {
                const ring = donutRing(i);
                const hasNamedHighlight = normalizedDonutHighlights.length > 0;
                const isNamedHighlight = isNamedDonutHighlight(slice.name);
                return (
                  <Cell
                    key={i}
                    fill={COLORS[i % COLORS.length]}
                    fillOpacity={
                      hasNamedHighlight && !isNamedHighlight ? 0.38 : 1
                    }
                    stroke={ring ?? undefined}
                    strokeWidth={ring ? 4 : undefined}
                  />
                );
              })}
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
            <Legend
              iconType="circle"
              iconSize={8}
              verticalAlign="bottom"
              align="center"
              wrapperStyle={{ fontSize: isExpanded ? 11 : 10, paddingTop: 8 }}
              formatter={(value: string) => (
                <span
                  style={{
                    color: "rgb(var(--color-text-secondary))",
                    fontWeight: 600,
                  }}
                >
                  {value}
                </span>
              )}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // ── horizontal_bar (ranked horizontal bars) ────────────────────────────────
  if (chart.type === "horizontal_bar") {
    const sorted = [...data].sort(
      (a, b) =>
        (Number((b as any).value) || 0) - (Number((a as any).value) || 0),
    );
    return (
      <div
        style={{
          height: isExpanded ? "100%" : Math.max(h, sorted.length * 32 + 40),
          width: "100%",
        }}
      >
        <ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={0}
          minHeight={0} initialDimension={{ width: 1, height: 1 }}
        >
          <BarChart
            data={sorted}
            layout="vertical"
            margin={{ top: 4, right: 16, left: 8, bottom: 4 }}
            onClick={emitFromActive}
          >
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="rgba(var(--color-text-muted)/0.12)"
              horizontal={false}
            />
            <XAxis
              type="number"
              tick={{ fill: "rgb(var(--color-text-muted))", fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => fmtVal(v)}
            />
            <YAxis
              type="category"
              dataKey="name"
              tick={{ fill: "rgb(var(--color-text-muted))", fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              width={120}
            />
            <Tooltip
              content={
                <CustomTooltip
                  metric={chart.config.metric}
                  grouping={chart.config.grouping}
                  valueFormatter={(value: number, entry: any) =>
                    fmtSeriesValue(
                      Number(value) || 0,
                      String(entry?.dataKey ?? entry?.name ?? "value"),
                      chart.config.display?.valueFormat ?? null,
                    )
                  }
                />
              }
            />
            <Bar
              dataKey="value"
              fill="rgb(var(--color-accent-violet))"
              radius={[0, 4, 4, 0]}
              maxBarSize={24}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // ── histogram (distribution bars) ─────────────────────────────────────────
  if (chart.type === "histogram") {
    return (
      <div style={{ height: wrapH, width: "100%" }}>
        <ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={0}
          minHeight={0} initialDimension={{ width: 1, height: 1 }}
        >
          <BarChart
            data={data}
            margin={{ top: 8, right: 8, left: 8, bottom: 16 }}
            onClick={emitFromActive}
          >
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="rgba(var(--color-text-muted)/0.12)"
            />
            <XAxis
              dataKey="name"
              tick={{ fill: "rgb(var(--color-text-muted))", fontSize: 9 }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tick={{ fill: "rgb(var(--color-text-muted))", fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              width={40}
            />
            <Tooltip
              formatter={(v) => [`${Number(v) || 0} invoices`, "Count"]}
            />
            <Bar
              dataKey="value"
              fill="rgb(var(--color-accent-cyan))"
              radius={[4, 4, 0, 0]}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // ── pareto (bar + cumulative % line) ──────────────────────────────────────
  if (chart.type === "pareto") {
    // A pareto's LEFT axis is structurally the ranked absolute measure (e.g. revenue $);
    // the cumulative percentage always lives on the RIGHT axis. So the left axis must use
    // the measure's natural $/count format and never "percent" — otherwise a follow-up that
    // sets a chart-wide valueFormat="percent" (for the cumulative line) corrupts the $ axis
    // into nonsense like "7000000.0%".
    const fmtParetoLeft = (v: number): string =>
      _vfmt === "number"
        ? fmtNumber(Number(v) || 0)
        : fmtCurrency(Number(v) || 0);
    const sorted = [...data].sort(
      (a, b) =>
        (Number((b as any).value) || 0) - (Number((a as any).value) || 0),
    );
    const totalVal = sorted.reduce(
      (s, d) => s + (Number((d as any).value) || 0),
      0,
    );
    let cumSum = 0;
    const paretoData = sorted.map((d) => {
      cumSum += Number((d as any).value) || 0;
      return {
        ...(d as any),
        cumPct: totalVal > 0 ? Math.round((cumSum / totalVal) * 100) : 0,
      };
    });
    return (
      <div style={{ height: wrapH, width: "100%" }}>
        <ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={0}
          minHeight={0} initialDimension={{ width: 1, height: 1 }}
        >
          <ComposedChart
            data={paretoData}
            margin={{ top: 8, right: 40, left: 8, bottom: 16 }}
            onClick={emitFromActive}
          >
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="rgba(var(--color-text-muted)/0.12)"
            />
            <XAxis
              dataKey="name"
              tick={{ fill: "rgb(var(--color-text-muted))", fontSize: 9 }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              yAxisId="left"
              tick={{ fill: "rgb(var(--color-text-muted))", fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              width={56}
              tickFormatter={(v: number) => fmtParetoLeft(v)}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              domain={[0, 100]}
              tick={{ fill: "rgb(var(--color-text-muted))", fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => `${v}%`}
              width={36}
            />
            <Tooltip
              formatter={(v, name) =>
                name === "cumPct"
                  ? [`${Number(v) || 0}%`, "Cumulative %"]
                  : [fmtParetoLeft(Number(v) || 0), "Value"]
              }
            />
            <Bar
              yAxisId="left"
              dataKey="value"
              fill="rgb(var(--color-accent-violet))"
              radius={[4, 4, 0, 0]}
              isAnimationActive={false}
            />
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="cumPct"
              stroke="rgb(var(--color-accent-cyan))"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            <ReferenceLine
              yAxisId="right"
              y={80}
              stroke="rgb(var(--color-accent-cyan))"
              strokeDasharray="4 4"
              label={{
                value: "80%",
                position: "right",
                fontSize: 9,
                fill: "rgb(var(--color-accent-cyan))",
              }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // ── gauge (radial financial health) ──────────────────────────────────────
  if (chart.type === "gauge") {
    const raw = (data[0] as any) ?? {};
    const score = Math.max(0, Math.min(100, Number(raw.value) || 0));
    const label =
      raw.label ??
      (score >= 80
        ? "Excellent"
        : score >= 60
          ? "Good"
          : score >= 40
            ? "Fair"
            : "Needs Attention");
    const color =
      score >= 80
        ? "#10B981"
        : score >= 60
          ? "#0EA5E9"
          : score >= 40
            ? "#F59E0B"
            : "#EF4444";
    const gaugeData = [
      { name: "Score", value: score, fill: color },
      { name: "Remaining", value: 100 - score, fill: "transparent" },
    ];
    return (
      <div
        style={{ height: wrapH, width: "100%" }}
        className="flex flex-col items-center justify-center"
      >
        <ResponsiveContainer
          width="100%"
          height={isExpanded ? 300 : 200}
          minWidth={0}
          minHeight={0} initialDimension={{ width: 1, height: 1 }}
        >
          <RadialBarChart
            cx="50%"
            cy="70%"
            innerRadius="60%"
            outerRadius="90%"
            startAngle={180}
            endAngle={0}
            data={gaugeData}
          >
            <RadialBar
              dataKey="value"
              background={{ fill: "rgba(var(--color-text-muted)/0.1)" }}
              cornerRadius={8}
            >
              {gaugeData.map((entry, i) => (
                <Cell key={i} fill={entry.fill} />
              ))}
            </RadialBar>
          </RadialBarChart>
        </ResponsiveContainer>
        <div className="mt-[-40px] flex flex-col items-center gap-1">
          <p className="text-4xl font-black" style={{ color }}>
            {score}
          </p>
          <p className="text-sm font-semibold" style={{ color }}>
            {label}
          </p>
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
    // ClickHouse returns numerics as strings; coerce x/y/z. Axis labels come from
    // the chart's real xAxisLabel/yAxisLabel (the SQL's measure labels), never the
    // old hardcoded "Amount"/"Invoices" — those mislabeled every EBPO bubble.
    const num = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const zRaw = data.map((d) => num((d as any).z));
    const finiteZ = zRaw.filter((v): v is number => v !== null);
    const minZ = finiteZ.length ? Math.min(...finiteZ) : 0;
    const maxZ = finiteZ.length ? Math.max(...finiteZ) : 0;
    const zSpan = maxZ - minZ;
    // Normalize the size measure to [0,1] across its OWN min→max range so bubbles
    // visibly differ even when all values are large-but-close (the "size not
    // changing" bug). Equal values → uniform mid-size. No z → uniform.
    const bubbleData = data.map((d) => {
      const z = num((d as any).z);
      const norm = z === null || zSpan <= 0 ? 0.5 : (z - minZ) / zSpan;
      return {
        ...(d as any),
        ...(typeof (d as any).name === "string"
          ? { name: humanizeCategoryLabel((d as any).name) }
          : {}),
        x: num((d as any).x) ?? 0,
        y: num((d as any).y) ?? 0,
        _zsize: norm,
        _zval: z,
      };
    });
    const bubbleHasName =
      bubbleData[0] && typeof (bubbleData[0] as any).name === "string";
    const showBubbleLabels = bubbleHasName && bubbleData.length <= 16;
    const xLabel = chart.config.xAxisLabel?.trim() || "x";
    const yLabel = chart.config.yAxisLabel?.trim() || "y";
    const visibleBubbleYLabel =
      !isExpanded && yLabel.length > 16
        ? yLabel.replace(/\baverage\b/gi, "Avg").replace(/\bhours?\b/gi, "hrs")
        : yLabel;
    const xFmt = resolveAxisFormatFromMetadata(xLabel, "x", "number");
    const yFmt = resolveAxisFormatFromMetadata(yLabel, "y", "number");
    const zLabel =
      chart.config.display?.secondaryLabel ??
      chart.config.display?.colorMetricLabel ??
      "Bubble Size";
    const zFmt = resolveAxisFormatFromMetadata(
      zLabel,
      "z",
      chart.config.display?.valueFormat ?? "number",
    );
    const hasSize = finiteZ.length > 0 && zSpan > 0;
    const highlightCostWithoutRevenue = Boolean(
      chart.config.spec?.highlightCostWithoutRevenue,
    );
    const hasCostWithoutRevenue =
      highlightCostWithoutRevenue &&
      bubbleData.some(
        (point) => Number((point as any).y) > 0 && Number((point as any).x) <= 0,
      );
    const highlightLowPerformance = Boolean(
      chart.config.spec?.highlightLowPerformance,
    );
    const qualityKeys = Object.keys((bubbleData[0] ?? {}) as object).filter(
      (key) => /\b(?:sla|csat)\b/i.test(key),
    );
    const qualityThresholds = new Map(
      qualityKeys.map((key) => {
        const values = bubbleData
          .map((point) => toFiniteNumber((point as any)[key]))
          .filter((value): value is number => value !== null)
          .sort((a, b) => a - b);
        return [
          key,
          values.length
            ? values[Math.floor((values.length - 1) * 0.25)]!
            : Number.NEGATIVE_INFINITY,
        ] as const;
      }),
    );
    const isLowPerformancePoint = (point: Record<string, unknown>) =>
      highlightLowPerformance &&
      qualityKeys.some((key) => {
        const value = toFiniteNumber(point[key]);
        return value !== null && value <= (qualityThresholds.get(key) ?? -Infinity);
      });
    const hasLowPerformance = bubbleData.some((point) =>
      isLowPerformancePoint(point as Record<string, unknown>),
    );
    const hasBubbleHighlight = hasCostWithoutRevenue || hasLowPerformance;
    return (
      <ZoomableChartFrame
        height={wrapH}
        xValues={bubbleData.map((d: any) => Number(d.x) || 0)}
        yValues={bubbleData.map((d: any) => Number(d.y) || 0)}
        footer={
          <>
            {bubbleHasName && bubbleData.length <= 12 && (
              <div className="mt-1 flex max-h-[34%] flex-wrap gap-x-3 gap-y-1 overflow-y-auto px-1">
                {bubbleData.map((d, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 text-[9px] text-text-secondary"
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: PIE_COLORS[i % PIE_COLORS.length] }}
                    />
                    {String((d as any).name)}
                  </span>
                ))}
              </div>
            )}
            {!hasSize && (
              <p className="px-1 text-[9px] text-text-muted">
                Uniform size — no size measure in this chart.
              </p>
            )}
          </>
        }
      >
        {(view) => (
          <ResponsiveContainer
            width="100%"
            height="100%"
            minWidth={0}
            minHeight={0} initialDimension={{ width: 1, height: 1 }}
          >
            <ScatterChart
              margin={{
                // Named bubbles draw multi-line labels above the point. Reserve
                // enough headroom for the largest bubble + label so top-ranked
                // points are not cut by the SVG border.
                top: showBubbleLabels ? (isExpanded ? 64 : 72) : 14,
                right: 12,
                left: 8,
                bottom: 24,
              }}
              onClick={emitFromActive}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgba(var(--color-text-muted)/0.12)"
              />
              <XAxis
                type="number"
                dataKey="x"
                name={xLabel}
                domain={view.x}
                allowDataOverflow
                tick={{ fill: "rgb(var(--color-text-muted))", fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => fmtByUnit(Number(v) || 0, xFmt)}
                label={{
                  value: xLabel,
                  position: "insideBottom",
                  offset: -8,
                  fontSize: 10,
                  fill: "rgb(var(--color-text-muted))",
                }}
              />
              <YAxis
                type="number"
                dataKey="y"
                name={yLabel}
                domain={view.y}
                allowDataOverflow
                tick={{ fill: "rgb(var(--color-text-muted))", fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                width={64}
                tickMargin={8}
                tickFormatter={(v: number) => fmtByUnit(Number(v) || 0, yFmt)}
                label={{
                  value: visibleBubbleYLabel,
                  angle: -90,
                  position: "insideLeft",
                  offset: 4,
                  fontSize: 10,
                  fill: "rgb(var(--color-text-muted))",
                }}
              />
              <ZAxis
                type="number"
                dataKey="_zsize"
                domain={[0, 1]}
                range={[80, 620]}
              />
              <Tooltip
                cursor={{ strokeDasharray: "3 3" }}
                content={({ payload }) => {
                  const d = payload?.[0]?.payload;
                  if (!d) return null;
                  return (
                    <div className="rounded-lg border border-default bg-bg-elevated p-2 text-[10px] shadow-lg">
                      {d.name && (
                        <p className="font-semibold text-text-primary">
                          {d.name}
                        </p>
                      )}
                      <p className="text-text-muted">
                        {xLabel}: {fmtByUnit(Number(d.x) || 0, xFmt)}
                      </p>
                      <p className="text-text-muted">
                        {yLabel}: {fmtByUnit(Number(d.y) || 0, yFmt)}
                      </p>
                      {d._zval !== null && d._zval !== undefined && (
                        <p className="text-text-muted">
                          {zLabel}: {fmtByUnit(Number(d._zval) || 0, zFmt)}
                        </p>
                      )}
                      {qualityKeys.map((key) => (
                        <p key={key} className="text-text-muted">
                          {key}: {fmtByUnit(Number(d[key]) || 0, "percent")}
                        </p>
                      ))}
                    </div>
                  );
                }}
              />
              <Scatter data={bubbleData} fillOpacity={0.7}>
                {bubbleData.map((point, i) => {
                  const highlighted =
                    (hasCostWithoutRevenue &&
                      Number((point as any).y) > 0 &&
                      Number((point as any).x) <= 0) ||
                    isLowPerformancePoint(
                      point as Record<string, unknown>,
                    );
                  return (
                    <Cell
                      key={i}
                      fill={
                        highlighted
                          ? "#f59e0b"
                          : PIE_COLORS[i % PIE_COLORS.length]
                      }
                      fillOpacity={hasBubbleHighlight && !highlighted ? 0.24 : 0.85}
                      stroke={highlighted ? "#fbbf24" : "none"}
                      strokeWidth={highlighted ? 3 : 0}
                    />
                  );
                })}
                {showBubbleLabels && (
                  <LabelList
                    dataKey="name"
                    position="top"
                    offset={6}
                    style={{
                      fontSize: 9,
                      fontWeight: 600,
                      fill: "rgb(var(--color-text-secondary))",
                    }}
                  />
                )}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        )}
      </ZoomableChartFrame>
    );
  }

  // ── kpi (multi-card grid) ─────────────────────────────────────────────────
  if (chart.type === "kpi") {
    const iconMap: Record<string, string> = {
      revenue: "↑",
      expenses: "↓",
      profit: "◈",
      invoice: "◻",
      count: "#",
      overdue: "⚠",
    };
    const colorMap: Record<string, string> = {
      revenue: "text-emerald-400",
      expenses: "text-red-400",
      profit: "text-violet-400",
      invoice: "text-cyan-400",
      count: "text-blue-400",
      overdue: "text-amber-400",
    };
    return (
      <div className="grid h-full w-full grid-cols-2 gap-2 p-1 md:grid-cols-3">
        {data.map((item, i) => {
          const d = item as any;
          const fmt =
            d.format === "currency"
              ? fmtCurrency(d.value)
              : d.format === "percent"
                ? fmtPercent(Number(d.value) || 0)
                : fmtNumber(d.value);
          const icon = iconMap[d.icon ?? ""] ?? "◈";
          const color = colorMap[d.icon ?? ""] ?? "text-violet-400";
          return (
            <div
              key={i}
              className="flex flex-col items-center justify-center gap-1 rounded-xl border border-default bg-bg-elevated/40 p-3 text-center"
            >
              <span className={`text-lg ${color}`}>{icon}</span>
              <p className="text-[9px] font-bold uppercase tracking-widest text-text-muted">
                {d.label}
              </p>
              <p className={`text-lg font-black tracking-tight ${color}`}>
                {fmt}
              </p>
            </div>
          );
        })}
      </div>
    );
  }

  // ── heatmap (general grid: rows = series, columns = categories) ────────────
  if (chart.type === "heatmap" || chart.type === "matrix") {
    const rows = data.filter(Boolean);
    const colKeys = inferHeatmapSeriesKeys(rows);
    // Row-axis label for the corner header. `grouping` is often a placeholder for
    // dynamic EBPO charts ("dynamic"/"query"), which would mislabel the month/category
    // column as "Query". Prefer the real spec dimension, then xAxisLabel, and only fall
    // back to grouping when it's a meaningful token.
    const specDim = (chart.config as { spec?: { dimension?: string } }).spec
      ?.dimension;
    // When the columns are several DIFFERENT measures (e.g. Revenue, Cost, Gross Margin)
    // rather than periods/categories of one measure, a per-row total across the columns is
    // usually meaningless — summing revenue + cost + gross margin is nonsense (it equals
    // 2× revenue since margin = revenue − cost). By default we suppress those totals, but
    // if the user explicitly asked for row/grand totals we honor that display request.
    const specMeasures = (chart.config as { spec?: { measures?: string[] } })
      .spec?.measures;
    const multiMeasureColumns =
      Array.isArray(specMeasures) && specMeasures.length > 1;
    const forceTotals = chart.config.display?.showTotals === true;
    const showTotals =
      colKeys.length > 1 && (!multiMeasureColumns || forceTotals);
    const groupingToken =
      String(chart.config.grouping ?? "").split("_")[0] ?? "";
    const placeholder = /^(dynamic|query|row|name|)$/i;
    const rowAxis =
      (specDim && !placeholder.test(specDim) && specDim) ||
      (chart.config.xAxisLabel && String(chart.config.xAxisLabel)) ||
      (!placeholder.test(groupingToken) && groupingToken) ||
      "Category";
    const prettyAxis = (value: string) =>
      value
        .split("_")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
    const axisLabel = (axis: string) => prettyAxis(axis || "Name");
    const amount = (value: number) => fmtVal(value);
    // Percent/ratio heatmaps must NOT sum cells (sum of margins = nonsense like 5438%)
    // and missing combos arrive as null (ratio-of-sums over an empty slice) — render
    // those blank and aggregate column/row summaries as AVERAGES, not totals.
    const isPercentGrid = chart.config.display?.valueFormat === "percent";
    const cellNum = (row: DataRow, key: string): number | null => {
      const raw = (row as any)[key];
      if (raw === null || raw === undefined || raw === "") return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    };
    const lerp = (from: number, to: number, t: number) =>
      Math.round(from + (to - from) * Math.max(0, Math.min(1, t)));
    const rgb = (r: number, g: number, b: number) => `rgb(${r}, ${g}, ${b})`;
    const conditionalThreshold =
      typeof chart.config.display?.conditionalThreshold === "number"
        ? chart.config.display.conditionalThreshold
        : null;
    const palette = heatmapPalette(
      chart.config.metric,
      chart.title,
      chart.config.display?.conditionalColor ?? null,
    );
    const useRiskPalette = palette === "red";
    const cellTheme = (value: number, highlight: boolean) => {
      if (highlight) {
        return useRiskPalette
          ? { bg: "#dc2626", fg: "#ffffff" }
          : { bg: "#16a34a", fg: "#ffffff" };
      }
      const maxVal = Math.max(
        ...rows.flatMap((row) =>
          colKeys.map((key) =>
            Math.abs(toFiniteNumber((row as any)[key]) ?? 0),
          ),
        ),
        1,
      );
      const intensity = Math.min(1, Math.abs(value) / maxVal);
      const low = useRiskPalette
        ? { r: 34, g: 197, b: 94 }
        : { r: 248, g: 113, b: 113 };
      const high = useRiskPalette
        ? { r: 220, g: 38, b: 38 }
        : { r: 34, g: 197, b: 94 };
      if (intensity >= 0.5) {
        const t = (intensity - 0.5) / 0.5;
        const r = lerp(low.r, high.r, t);
        const g = lerp(low.g, high.g, t);
        const b = lerp(low.b, high.b, t);
        const fg = intensity >= 0.8 ? "#ffffff" : "#111827";
        return { bg: rgb(r, g, b), fg };
      }
      const t = intensity / 0.5;
      const mid = { r: 245, g: 158, b: 11 };
      const r = lerp(low.r, mid.r, t);
      const g = lerp(low.g, mid.g, t);
      const b = lerp(low.b, mid.b, t);
      return { bg: rgb(r, g, b), fg: intensity < 0.25 ? "#ffffff" : "#111827" };
    };
    // Aggregate non-null cells only. For percent grids use the MEAN (a sum of
    // percentages is meaningless); otherwise SUM. The header relabels accordingly.
    const aggCells = (vals: Array<number | null>): number => {
      const present = vals.filter((v): v is number => v !== null);
      if (present.length === 0) return 0;
      const sum = present.reduce((s, v) => s + v, 0);
      return isPercentGrid ? sum / present.length : sum;
    };
    const summaryHeader = isPercentGrid ? "Avg" : "Total";
    const rowTotals = rows.map((row) =>
      aggCells(colKeys.map((key) => cellNum(row, key))),
    );
    const colTotals = colKeys.map((key) =>
      aggCells(rows.map((row) => cellNum(row, key))),
    );
    const grandTotal = aggCells(
      rows.flatMap((row) => colKeys.map((key) => cellNum(row, key))),
    );

    // Dynamic "above average" conditional highlight (column / row / overall mean).
    const conditionalMode =
      chart.config.display?.conditionalThresholdMode ?? null;
    const meanOf = (vals: Array<number | null>): number => {
      const present = vals.filter((v): v is number => v !== null);
      return present.length
        ? present.reduce((s, v) => s + v, 0) / present.length
        : 0;
    };
    const colAverages: Record<string, number> = {};
    colKeys.forEach((key) => {
      colAverages[key] = meanOf(rows.map((row) => cellNum(row, key)));
    });
    const overallAverage = meanOf(
      rows.flatMap((row) => colKeys.map((key) => cellNum(row, key))),
    );
    const shouldHighlight = (value: number, colKey: string, rowAvg: number) => {
      if (chart.config.display?.conditionalColor == null) return false;
      if (conditionalThreshold !== null) return value >= conditionalThreshold;
      if (conditionalMode === "columnAverage")
        return value > (colAverages[colKey] ?? 0);
      if (conditionalMode === "rowAverage") return value > rowAvg;
      if (conditionalMode === "overallAverage") return value > overallAverage;
      return false;
    };

    // "Highlight the highest / lowest" → ring the SINGLE extreme cell(s) across the
    // whole grid. The ring color follows the palette so risk heatmaps keep high
    // values red while standard positive heatmaps keep high values green. Only the
    // first occurrence is ringed so a grid with many tied values (e.g. lots of 0%)
    // doesn't ring dozens of cells.
    const extremes = chart.config.display?.highlightExtremes ?? null;
    let maxPos: { r: number; c: number } | null = null;
    let minPos: { r: number; c: number } | null = null;
    if (extremes) {
      let maxV = -Infinity;
      let minV = Infinity;
      rows.forEach((row, r) =>
        colKeys.forEach((k, c) => {
          const v = cellNum(row, k);
          if (v === null) return; // skip missing cells so a blank isn't "lowest"
          if (v > maxV) {
            maxV = v;
            maxPos = { r, c };
          }
          if (v < minV) {
            minV = v;
            minPos = { r, c };
          }
        }),
      );
    }
    const extremeRing = (r: number, c: number): string | null => {
      if (!extremes) return null;
      const maxRing = useRiskPalette ? "#ef4444" : "#10b981";
      const minRing = useRiskPalette ? "#10b981" : "#ef4444";
      if (
        (extremes === "max" || extremes === "both") &&
        maxPos &&
        maxPos.r === r &&
        maxPos.c === c
      )
        return maxRing;
      if (
        (extremes === "min" || extremes === "both") &&
        minPos &&
        minPos.r === r &&
        minPos.c === c
      )
        return minRing;
      return null;
    };

    return (
      <div style={{ height: wrapH, width: "100%", overflowX: "auto" }}>
        <div className="mb-2 flex items-center gap-3 text-[10px] font-semibold text-text-muted">
          <span className="uppercase tracking-wider">Intensity</span>
          <span className="flex items-center gap-1">
            <span
              className={cn(
                "h-3 w-3 rounded-[3px]",
                useRiskPalette ? "bg-[#22c55e]" : "bg-[#f87171]",
              )}
            />
            {useRiskPalette ? "Low risk" : "Low"}
          </span>
          <span className="flex items-center gap-1">
            <span className="h-3 w-3 rounded-[3px] bg-[#f5b61b]" />
            Medium
          </span>
          <span className="flex items-center gap-1">
            <span
              className={cn(
                "h-3 w-3 rounded-[3px]",
                useRiskPalette ? "bg-[#dc2626]" : "bg-[#22c55e]",
              )}
            />
            {useRiskPalette ? "High overdue" : "High"}
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
              {showTotals && (
                <th className="rounded-md border border-default bg-bg-card px-3 py-2 text-center text-[11px] font-semibold text-text-muted shadow-sm">
                  {summaryHeader}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => {
              const rowLabel = String(
                (row as any).name ?? `Row ${rowIndex + 1}`,
              );
              const rowAvg = meanOf(colKeys.map((k) => cellNum(row, k)));
              return (
                <tr key={rowLabel}>
                  <th className="sticky left-0 z-10 rounded-md border border-default bg-bg-card px-3 py-2 text-left text-[11px] font-semibold text-text-muted shadow-sm">
                    {rowLabel}
                  </th>
                  {colKeys.map((key, colIndex) => {
                    const cv = cellNum(row, key);
                    // Missing combo (e.g. a business unit with no rows that month) →
                    // blank neutral cell, not a misleading "0.0%".
                    if (cv === null) {
                      return (
                        <td
                          key={key}
                          className="rounded-md border border-black/10 px-3 py-3 text-center text-[12px] font-semibold text-text-muted"
                          style={{
                            background: "rgba(var(--color-text-muted)/0.06)",
                          }}
                          title={`${rowLabel} / ${prettyAxis(key)}: no data`}
                        >
                          —
                        </td>
                      );
                    }
                    const value = cv;
                    const theme = cellTheme(
                      value,
                      shouldHighlight(value, key, rowAvg),
                    );
                    const ring = extremeRing(rowIndex, colIndex);
                    return (
                      <td
                        key={key}
                        className="rounded-md border border-black/10 px-3 py-3 text-center text-[12px] font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] transition-transform transition-opacity hover:-translate-y-[1px] hover:opacity-100"
                        style={{
                          background: theme.bg,
                          color: theme.fg,
                          ...(ring
                            ? {
                                outline: `3px solid ${ring}`,
                                outlineOffset: "-2px",
                                borderRadius: 6,
                              }
                            : {}),
                        }}
                        title={`${rowLabel} / ${prettyAxis(key)}: ${amount(value)}${ring === "#10b981" ? " (highest)" : ring === "#ef4444" ? " (lowest)" : ""}`}
                      >
                        {amount(value)}
                      </td>
                    );
                  })}
                  {showTotals && (
                    <td className="rounded-md border border-default bg-bg-elevated px-3 py-3 text-center text-[12px] font-bold text-text-primary shadow-sm">
                      {amount(rowTotals[rowIndex] ?? 0)}
                    </td>
                  )}
                </tr>
              );
            })}
            {showTotals && (
              <tr>
                <th className="sticky left-0 z-10 rounded-md border border-default bg-bg-card px-3 py-2 text-left text-[11px] font-bold text-text-primary shadow-sm">
                  {summaryHeader}
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
            )}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div style={{ height: wrapH, width: "100%" }}>
      <ResponsiveContainer
        width="100%"
        height="100%"
        minWidth={0}
        minHeight={0} initialDimension={{ width: 1, height: 1 }}
      >
        {(() => {
          const seriesKeys = inferNumericSeriesKeys(data);
          const hasValueSeries = hasFiniteValueKey(data, "value");
          const isMultiSeries = !hasValueSeries && seriesKeys.length > 0;

          if (isMultiSeries) {
            const visibleSeriesKeys = seriesKeys.slice(0, 6);
            const lineHighlightNames = (
              chart.config.display?.highlightNames ?? []
            ).map((name) => String(name).trim().toLocaleLowerCase());
            const hasLineHighlights = lineHighlightNames.length > 0;
            const isHighlightedLine = (key: string) => {
              if (!hasLineHighlights) return true;
              const normalizedKey = key.trim().toLocaleLowerCase();
              const normalizedPretty = prettySeriesName(key)
                .trim()
                .toLocaleLowerCase();
              return lineHighlightNames.some(
                (highlight) =>
                  normalizedKey === highlight ||
                  normalizedPretty === highlight ||
                  normalizedKey.startsWith(`${highlight} —`) ||
                  normalizedPretty.startsWith(`${highlight} —`) ||
                  normalizedKey.startsWith(`${highlight} -`) ||
                  normalizedPretty.startsWith(`${highlight} -`),
              );
            };
            const multiSeriesLabelMode = pointLabelMode(
              data.length,
              visibleSeriesKeys.length,
              _forceLabels,
              isExpanded,
            );
            const negativeSeriesValues =
              chart.config.display?.highlightNegative ||
              shouldForceNegativeEmphasis
                ? (data as any[]).flatMap((row) =>
                    seriesKeys
                      .map((key) => Number((row as any)?.[key]))
                      .filter((value) => Number.isFinite(value) && value < 0),
                  )
                : [];
            const minNegativeSeriesValue =
              negativeSeriesValues.length > 0
                ? Math.min(...negativeSeriesValues)
                : null;
            return (
              <LineChart
                data={data}
                margin={{
                  top: isExpanded ? 28 : 16,
                  right: isExpanded ? 54 : 30,
                  left: 12,
                  bottom: 0,
                }}
                onClick={emitFromActive}
              >
                <CartesianGrid {...gridStyle} />
                <XAxis dataKey="name" tick={tickStyle} />
                <YAxis
                  tick={tickStyle}
                  tickFormatter={(v: number) => fmtVal(Number(v) || 0)}
                  width={56}
                  tickMargin={8}
                />
                <Tooltip
                  content={
                    <CustomTooltip
                      metric={chart.config.metric}
                      grouping={chart.config.grouping}
                      valueFormatter={(value: number, entry: any) =>
                        fmtSeriesValue(
                          Number(value) || 0,
                          String(entry?.dataKey ?? entry?.name ?? ""),
                          chart.config.display?.valueFormat ?? null,
                        )
                      }
                    />
                  }
                />
                <Legend
                  verticalAlign="top"
                  height={24}
                  wrapperStyle={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: "rgb(var(--color-text-muted))",
                  }}
                />
                {(chart.config.display?.highlightNegative ||
                  shouldForceNegativeEmphasis) &&
                  (data as any[]).some((row) =>
                    seriesKeys.some((key) => Number((row as any)?.[key]) < 0),
                  ) && (
                    <ReferenceLine
                      y={0}
                      stroke="rgb(var(--color-danger))"
                      strokeWidth={1.5}
                      strokeDasharray="4 3"
                    />
                  )}
                {minNegativeSeriesValue != null && (
                  <ReferenceArea
                    y1={0}
                    y2={minNegativeSeriesValue}
                    fill="rgb(var(--color-danger))"
                    fillOpacity={0.08}
                  />
                )}
                {visibleSeriesKeys.flatMap((key, idx) => [
                  <Line
                    key={`line-${key}`}
                    type="monotone"
                    dataKey={key}
                    name={prettySeriesName(key)}
                    stroke={PIE_COLORS[idx % PIE_COLORS.length]}
                    strokeOpacity={isHighlightedLine(key) ? 1 : 0.28}
                    strokeWidth={isHighlightedLine(key) ? 3 : 1.5}
                    dot={false}
                    activeDot={inspectDot(key)}
                    isAnimationActive={false}
                  >
                    {multiSeriesLabelMode !== "none" && (
                      <LabelList
                        dataKey={key}
                        content={
                          multiSeriesLabelMode === "latest"
                            ? latestOnlyLabel(
                                data,
                                key,
                                (n) =>
                                  fmtSeriesValue(
                                    n,
                                    key,
                                    chart.config.display?.valueFormat ?? null,
                                  ),
                                idx,
                              )
                            : thinnedLabel(
                                multiSeriesLabelMode === "full"
                                  ? 1
                                  : labelStride(
                                      data.length,
                                      Math.max(
                                        4,
                                        Math.floor(
                                          12 /
                                            Math.max(
                                              1,
                                              visibleSeriesKeys.length,
                                            ),
                                        ),
                                      ),
                                    ),
                                (n) =>
                                  fmtSeriesValue(
                                    n,
                                    key,
                                    chart.config.display?.valueFormat ?? null,
                                  ),
                                -8,
                              )
                        }
                      />
                    )}
                  </Line>,
                  ...(chart.config.display?.highlightNegative ||
                  shouldForceNegativeEmphasis
                    ? (data as any[])
                        .filter((d) => Number((d as any)?.[key]) < 0)
                        .map((d) => (
                          <ReferenceDot
                            key={`neg-${key}-${String((d as any).name)}`}
                            x={String((d as any).name)}
                            y={Number((d as any)[key])}
                            r={5}
                            fill="rgb(var(--color-danger))"
                            stroke="rgb(var(--color-bg-card))"
                            strokeWidth={2}
                          />
                        ))
                    : []),
                ])}
              </LineChart>
            );
          }

          const singleSeriesLabelMode = pointLabelMode(
            data.length,
            1,
            _forceLabels,
            isExpanded,
          );
          return (
            <LineChart
              data={data}
              margin={{
                top: isExpanded ? 28 : 16,
                right: isExpanded ? 54 : 30,
                left: 12,
                bottom: 0,
              }}
              onClick={emitFromActive}
            >
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="name" tick={tickStyle} />
              <YAxis
                tick={tickStyle}
                tickFormatter={(v: number) => fmtVal(Number(v) || 0)}
                width={56}
                tickMargin={8}
              />
              <Tooltip
                content={
                  <CustomTooltip
                    metric={chart.config.metric}
                    grouping={chart.config.grouping}
                    valueFormatter={(value: number, entry: any) =>
                      fmtSeriesValue(
                        Number(value) || 0,
                        String(entry?.dataKey ?? entry?.name ?? "value"),
                        chart.config.display?.valueFormat ?? null,
                      )
                    }
                  />
                }
              />
              {(chart.config.display?.highlightNegative ||
                shouldForceNegativeEmphasis) &&
                (data as any[]).some((d) => Number((d as any)?.value) < 0) && (
                  <ReferenceLine
                    y={0}
                    stroke="rgb(var(--color-danger))"
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                  />
                )}
              {(chart.config.display?.highlightNegative ||
                shouldForceNegativeEmphasis) &&
                (data as any[]).some((d) => Number((d as any)?.value) < 0) && (
                  <ReferenceArea
                    y1={0}
                    y2={Math.min(
                      ...(data as any[])
                        .filter((d) => Number((d as any)?.value) < 0)
                        .map((d) => Number((d as any).value)),
                    )}
                    fill="rgb(var(--color-danger))"
                    fillOpacity={0.08}
                  />
                )}
              <Line
                type="monotone"
                dataKey="value"
                stroke="rgb(var(--color-accent-blue))"
                strokeWidth={2}
                dot={false}
                activeDot={inspectDot("value")}
                isAnimationActive={false}
              >
                {singleSeriesLabelMode !== "none" && (
                  <LabelList
                    dataKey="value"
                    content={
                      singleSeriesLabelMode === "latest"
                        ? latestOnlyLabel(data, "value", (n) =>
                            fmtSeriesValue(
                              n,
                              "value",
                              chart.config.display?.valueFormat ?? null,
                            ),
                          )
                        : thinnedLabel(
                            singleSeriesLabelMode === "full"
                              ? 1
                              : labelStride(data.length),
                            (n) =>
                              fmtSeriesValue(
                                n,
                                "value",
                                chart.config.display?.valueFormat ?? null,
                              ),
                            -8,
                          )
                    }
                  />
                )}
              </Line>
              {(chart.config.display?.highlightNegative ||
                shouldForceNegativeEmphasis) &&
                (data as any[])
                  .filter((d) => Number((d as any)?.value) < 0)
                  .map((d) => (
                    <ReferenceDot
                      key={`neg-${String((d as any).name)}`}
                      x={String((d as any).name)}
                      y={Number((d as any).value)}
                      r={5}
                      fill="rgb(var(--color-danger))"
                      stroke="rgb(var(--color-bg-card))"
                      strokeWidth={2}
                    />
                  ))}
            </LineChart>
          );
        })()}
      </ResponsiveContainer>
    </div>
  );
}

// ─── Chart Card ───────────────────────────────────────────────────────────────

function getEmptyMessage(chart: Chart): string {
  if (chart.config.metric === "dynamic")
    return "No data returned for this query — try rephrasing or check that your accounting data is synced";
  if (chart.config.orgName)
    return `No data synced for "${chart.config.orgName}" in this scope yet`;
  if (chart.config.grouping === "vendor")
    return "Vendor data requires a QuickBooks or Xero sync with bill-level detail";
  if (chart.config.grouping === "department")
    return "Department data requires accounting sync with department tagging enabled";
  if (chart.config.grouping === "class")
    return "Class data requires QuickBooks sync with class tracking enabled";
  if (
    chart.config.grouping === "account" ||
    chart.config.grouping === "category"
  ) {
    if (chart.config.metric === "revenue" || chart.config.metric === "expense")
      return "No matching accounts found in this GL data — this dataset may need a different grouping";
  }
  return "No data for this scope yet";
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

// A "largest client" chart with no year stated stitches together each calendar
// year's actual top-revenue client (see backend: buildPerYearLargestClientSql) —
// the client can differ by year, so surface who's who rather than leaving it
// implicit. Collapses to a single name once a specific year scope is active.
function LargestClientCaption({
  chart,
  selection,
}: {
  chart: Chart;
  selection?: ChartScopeSelection;
}) {
  const labels = (
    chart.config.display as { periodEntityLabels?: unknown } | null | undefined
  )?.periodEntityLabels as Array<{ year: number; client: string }> | undefined;
  if (!Array.isArray(labels) || labels.length === 0) return null;
  if (selection?.kind === "year") {
    const match = labels.find((entry) => entry.year === selection.year);
    if (!match) return null;
    return (
      <p className="mb-2 text-[10px] font-semibold text-text-muted">
        Largest client in {selection.year}:{" "}
        <span className="text-text-secondary">{match.client}</span>
      </p>
    );
  }
  return (
    <p className="mb-2 line-clamp-1 text-[10px] font-semibold text-text-muted">
      Largest client by year:{" "}
      {labels.map((entry, i) => (
        <span key={entry.year}>
          {i > 0 ? <span className="mx-1 text-text-muted/40">·</span> : null}
          {entry.year}{" "}
          <span className="text-text-secondary">{entry.client}</span>
        </span>
      ))}
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
  const canUseRange =
    meta.hasMonthlyData &&
    !!meta.minMonth &&
    !!meta.maxMonth &&
    data.length > 6;
  const months = enumerateMonths(meta.minMonth, meta.maxMonth);
  const [customOpen, setCustomOpen] = useState(false);
  const [editingBoundary, setEditingBoundary] = useState<"start" | "end">(
    "start",
  );
  const custom =
    active.kind === "custom"
      ? clampMonthRange(active.start, active.end, meta.minMonth, meta.maxMonth)
      : clampMonthRange(
          meta.minMonth ?? "",
          meta.maxMonth ?? "",
          meta.minMonth,
          meta.maxMonth,
        );
  const customYears = Array.from(
    new Set(months.map((month) => month.slice(0, 4))),
  );
  const allowedCustomYears =
    editingBoundary === "end"
      ? customYears.filter((year) => year >= custom.start.slice(0, 4))
      : customYears;
  const activeCustomYear =
    (editingBoundary === "start" ? custom.start : custom.end).slice(0, 4) ||
    allowedCustomYears[0] ||
    "";
  const visibleCustomMonths = months.filter((month) =>
    month.startsWith(activeCustomYear),
  );
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

              {customOpen && typeof document !== "undefined"
                ? createPortal(
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
                                const fallback =
                                  months.find((item) =>
                                    item.startsWith(year),
                                  ) ?? month;
                                const boundedFallback =
                                  editingBoundary === "end" &&
                                  fallback < custom.start
                                    ? custom.start
                                    : fallback;
                                const next =
                                  editingBoundary === "start"
                                    ? clampMonthRange(
                                        fallback,
                                        custom.end,
                                        meta.minMonth,
                                        meta.maxMonth,
                                      )
                                    : clampMonthRange(
                                        custom.start,
                                        boundedFallback,
                                        meta.minMonth,
                                        meta.maxMonth,
                                      );
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
                            const isSelected =
                              editingBoundary === "start"
                                ? custom.start === month
                                : custom.end === month;
                            const isDisabled =
                              editingBoundary === "end" && month < custom.start;
                            const monthName =
                              formatMonthKey(month).split(" ")[0];
                            return (
                              <button
                                type="button"
                                key={month}
                                disabled={isDisabled}
                                onClick={() => {
                                  if (isDisabled) return;
                                  const next =
                                    editingBoundary === "start"
                                      ? clampMonthRange(
                                          month,
                                          custom.end < month
                                            ? month
                                            : custom.end,
                                          meta.minMonth,
                                          meta.maxMonth,
                                        )
                                      : clampMonthRange(
                                          custom.start,
                                          month,
                                          meta.minMonth,
                                          meta.maxMonth,
                                        );
                                  onChange({ kind: "custom", ...next });
                                  if (editingBoundary === "start")
                                    setEditingBoundary("end");
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
                  )
                : null}
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
  onFigureClick,
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
  onFigureClick?: (arg: FigureClickArg) => void;
}) {
  const isEmpty = data.length === 0;
  const rangeNotice = meta?.rangeNotice ?? chart.rangeNotice ?? null;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{
        duration: 0.35,
        delay: index * 0.07,
        ease: [0.22, 1, 0.36, 1],
      }}
      onClick={() => !isEmpty && onExpand()}
      className={cn(
        "surface-card group relative flex min-w-0 flex-col p-4 transition-all duration-200",
        !isEmpty &&
          "cursor-pointer hover:-translate-y-0.5 hover:border-accent-violet/30 hover:shadow-xl hover:shadow-accent-violet/5",
      )}
      style={{ minHeight: chart.type === "metric" ? "auto" : 300 }}
    >
      {/* Header */}
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-text-primary">
            {chart.title}
          </h3>
          <p className="mt-0.5 line-clamp-1 text-[10px] text-text-muted">
            {chart.description ??
              `${chart.type} · ${chart.config.metric} / ${chart.config.grouping}`}
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

      <LargestClientCaption chart={chart} selection={scopeSelection} />
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
      <div className="min-h-0 min-w-0 flex-1 pointer-events-none">
        {isEmpty ? (
          <div className="flex h-full min-h-[160px] items-center justify-center rounded-xl bg-bg-elevated/30">
            <p className="text-xs text-text-muted text-center px-4">
              {rangeNotice ?? getEmptyMessage(chart)}
            </p>
          </div>
        ) : (
          <ChartErrorBoundary>
            {renderChart(chart, data, false, onFigureClick)}
          </ChartErrorBoundary>
        )}
      </div>

      {/* Footer: type badge + insight */}
      <div className="mt-3 flex min-w-0 items-center gap-2">
        <span className="shrink-0 rounded-full bg-bg-elevated px-2.5 py-0.5 text-[10px] font-semibold text-text-muted ring-1 ring-default">
          {prettyChartType(chart)}
        </span>
        <span className="shrink-0 rounded-full bg-bg-elevated px-2.5 py-0.5 text-[10px] font-semibold text-text-muted ring-1 ring-default">
          {describeScope(scopeSelection, data)}
        </span>
        {!isEmpty && (
          <div className="min-w-0 flex-1 overflow-hidden">
            <ChartInsight
              type={chart.type}
              data={data}
              valueFormat={chart.config.display?.valueFormat}
            />
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
  onFigureClick,
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
  onFigureClick?: (arg: FigureClickArg) => void;
}) {
  const versionLabel = version
    ? `Chart v${version.versionNumber}`
    : "Current dashboard";
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
              This dashboard doesn&apos;t have any charts. Ask the agent to
              build one to get started.
            </p>
          </div>
        ) : (
          charts.map((chart, index) => {
            const fullData = chartData[chart.id] ?? [];
            const scopeSelection =
              chartScopes[chart.id] ??
              defaultScopeFromTimeRange(chart.config.timeRange);
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
                onScopeChange={(selection) =>
                  onScopeChange(chart.id, selection)
                }
                onDelete={
                  onDeleteChart && chart.widgetId
                    ? () => onDeleteChart(chart)
                    : undefined
                }
                onFigureClick={onFigureClick}
              />
            );
          })
        )}
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
  const [chartVersions, setChartVersions] = useState<ChartVersionSnapshot[]>(
    [],
  );
  const [chartData, setChartData] = useState<Record<string, DataRow[]>>({});
  const [chartDataMeta, setChartDataMeta] = useState<
    Record<string, ChartDataMeta>
  >({});
  const [chartScopes, setChartScopes] = useState<
    Record<string, ChartScopeSelection>
  >({});
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedChartId, setExpandedChartId] = useState<string | null>(null);
  // Widget ids optimistically hidden while a header-delete is pending (or until
  // the server-confirmed refetch lands). Lets the card disappear immediately
  // while the actual DELETE is deferred behind the undo window.
  const [hiddenWidgetIds, setHiddenWidgetIds] = useState<Set<string>>(
    new Set(),
  );
  const [refreshNonce, setRefreshNonce] = useState(0);
  // Glass Ledger: provenance drawer for a clicked figure.
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidence, setEvidence] = useState<FigureEvidence | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const evidenceReqRef = useRef(0);
  const prevSessionRef = useRef<string | null | undefined>(sessionId);

  const handleFigureClick = async (arg: FigureClickArg) => {
    if (!arg.widgetId) return;
    const reqId = ++evidenceReqRef.current;
    setEvidenceOpen(true);
    setEvidenceLoading(true);
    setEvidence(null);
    setEvidenceError(null);
    try {
      const result = await agent.figureEvidence({
        widgetId: arg.widgetId,
        category: arg.category,
        series: arg.series,
        expected: arg.value,
      });
      // Ignore a stale response if the user clicked another bar meanwhile.
      if (reqId !== evidenceReqRef.current) return;
      setEvidence(result);
    } catch (err) {
      if (reqId !== evidenceReqRef.current) return;
      setEvidenceError(
        err instanceof ApiError ? err.message : "Couldn’t trace this figure.",
      );
    } finally {
      if (reqId === evidenceReqRef.current) setEvidenceLoading(false);
    }
  };

  // Switching chats (or starting a new one) must NOT keep showing the previous
  // dashboard's charts. Keep the render pure and clear the cached dashboard
  // state after the session id actually changes.
  useEffect(() => {
    if (prevSessionRef.current === sessionId) return;
    prevSessionRef.current = sessionId;

    setDashboard(null);
    setChartVersions([]);
    setChartData({});
    setChartDataMeta({});
    setChartScopes({});
    setShowVersionHistory(false);
    setExpandedChartId(null);
    setHiddenWidgetIds(new Set());
  }, [sessionId]);

  useEffect(() => {
    if (loading) return;

    const fetchDashboard = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const [latest, sessionDetail] = await Promise.all([
          sessionId
            ? agent.dashboardForSession(sessionId)
            : agent.latestDashboard(),
          sessionId
            ? agent.session(sessionId).catch(() => null)
            : Promise.resolve(null),
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
          const sessionHistory = sessionDetail
            ? buildChartVersionHistory(sessionDetail.messages)
            : [];
          const liveHistory = liveChartTurn
            ? buildChartVersionHistory([
                {
                  role: "assistant",
                  content: "",
                  metadata: liveChartTurn,
                } as ChatMessage,
              ])
            : [];
          const history = mergeChartVersionHistories(
            sessionHistory,
            liveHistory,
          );
          const chartsToLoad =
            history.length > 0
              ? history.flatMap((version) => version.charts)
              : charts;
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
            if (
              chart.config.metric !== "dynamic" &&
              Array.isArray(chart.snapshotData) &&
              chart.snapshotData.length > 0
            ) {
              dataMap[chart.id] = chart.snapshotData;
            }
            if (
              chart.rangeNotice ||
              chart.requestedRangeLabel ||
              chart.availableRange
            ) {
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
                    chart.config.metric === "dynamic"
                      ? (chart.widgetId ?? chart.id)
                      : null,
                  );
                  dataMap[chart.id] = (res.data ?? []) as DataRow[];
                  if (
                    res.rangeNotice ||
                    res.requestedRangeLabel ||
                    res.availableRange
                  ) {
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
            const next = new Set(
              [...prev].filter((id) => liveWidgetIds.has(id)),
            );
            return next.size === prev.size ? prev : next;
          });
          setChartScopes((current) => {
            const validIds = new Set(chartsToLoad.map((chart) => chart.id));
            return Object.fromEntries(
              Object.entries(current).filter(([chartId]) =>
                validIds.has(chartId),
              ),
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
  const liveVersion =
    sortedVersions.find((version) => version.charts.length > 0) ??
    newestVersion;
  const latestRemovedActive =
    !!newestVersion &&
    !!liveVersion &&
    newestVersion.versionNumber !== liveVersion.versionNumber;
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
  const expandedFullData = expandedChart
    ? (chartData[expandedChart.id] ?? [])
    : [];
  const expandedScope = expandedChart
    ? (chartScopes[expandedChart.id] ??
      defaultScopeFromTimeRange(expandedChart.config.timeRange))
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
          <h2 className="truncate text-base font-bold text-text-primary">
            {dashboard.title}
          </h2>
          <p className="mt-0.5 text-xs text-text-muted">
            {dashboard.description ??
              "AI-generated strategic intelligence dashboard"}
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
            <span className="font-semibold text-text-primary">
              v{liveVersion.versionNumber}
            </span>{" "}
            — the most recent chart still active.
          </p>
        </motion.div>
      ) : null}

      {chartVersions.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-default bg-bg-elevated/25 px-4 py-3">
          <p className="text-xs text-text-muted">
            Showing the live dashboard only. Previous versions are review-only
            history.
          </p>
          {historyVersions.length > 0 ? (
            <button
              type="button"
              onClick={() => setShowVersionHistory((open) => !open)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-default bg-bg-card/60 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-text-secondary transition-colors hover:border-accent-cyan/40 hover:text-accent-cyan"
            >
              <History size={12} />
              {showVersionHistory
                ? "Hide history"
                : `Show history (${historyVersions.length})`}
              <ChevronDown
                size={12}
                className={cn(
                  "transition-transform",
                  showVersionHistory && "rotate-180",
                )}
              />
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Chart history — each version stacks downward in the live dashboard */}
      <div className="space-y-4 pb-8">
        {visibleVersions.map((version, index) => (
          <div
            key={`${version.versionNumber}-${version.dashboardTitle}`}
            className="space-y-4"
          >
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
                (chart) =>
                  !chart.widgetId || !hiddenWidgetIds.has(chart.widgetId),
              )}
              chartData={chartData}
              chartDataMeta={chartDataMeta}
              chartScopes={chartScopes}
              isHistorical={
                latestVersionNumber !== null &&
                version.versionNumber !== latestVersionNumber
              }
              onExpandChart={(chartId) => setExpandedChartId(chartId)}
              onScopeChange={(chartId, selection) =>
                setChartScopes((current) => ({
                  ...current,
                  [chartId]: selection,
                }))
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
              onFigureClick={handleFigureClick}
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
              className="surface-card relative flex h-[92vh] w-[96vw] max-w-none flex-col p-4 sm:p-6 lg:p-8"
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
                (expandedChart.config.xAxisLabel ||
                  expandedChart.config.yAxisLabel) ? (
                  <p className="mt-2 text-xs font-medium text-text-muted">
                    {expandedChart.config.xAxisLabel ? (
                      <>
                        <span className="text-text-muted/70">X-Axis:</span>{" "}
                        {expandedChart.config.xAxisLabel}
                      </>
                    ) : null}
                    {expandedChart.config.xAxisLabel &&
                    expandedChart.config.yAxisLabel ? (
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
                  <LargestClientCaption
                    chart={expandedChart}
                    selection={expandedScope}
                  />
                  <ChartScopeControls
                    data={expandedFullData}
                    selection={expandedScope}
                    onChange={(selection) =>
                      expandedChart &&
                      setChartScopes((current) => ({
                        ...current,
                        [expandedChart.id]: selection,
                      }))
                    }
                  />
                </div>
              </div>

              <div className="min-h-0 w-full flex-1 rounded-2xl border border-default bg-bg-elevated/30 p-6">
                <ChartErrorBoundary>
                  {renderChart(
                    expandedChart,
                    expandedData,
                    true,
                    handleFigureClick,
                  )}
                </ChartErrorBoundary>
              </div>

              <div className="mt-5 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-text-muted">
                    {expandedData.length} data points · live data
                  </span>
                  <ChartInsight
                    type={expandedChart.type}
                    data={expandedData}
                    valueFormat={expandedChart.config.display?.valueFormat}
                  />
                </div>
                <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-text-muted">
                  NumeriQ Strategic Layer
                </span>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Glass Ledger: provenance behind a clicked figure */}
      <ProvenanceDrawer
        open={evidenceOpen}
        loading={evidenceLoading}
        evidence={evidence}
        error={evidenceError}
        onClose={() => setEvidenceOpen(false)}
      />
    </div>
  );
}
