"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  RefreshCw,
  ChevronDown,
  ChevronUp,
  DollarSign,
  Clock,
  Zap,
  TrendingDown,
  BarChart3,
  ArrowUpRight,
  ArrowDownRight,
  Sparkles,
  ExternalLink,
  Maximize2,
  X,
} from "lucide-react";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
  Treemap,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { Button } from "../../../components/ui/Button";
import { ErrorBanner } from "../../../components/ui/ErrorBanner";
import { Skeleton } from "../../../components/ui/Skeleton";
import { EmptyState } from "../../../components/ui/EmptyState";
import { useNumeriquApi } from "../../../lib/useNumeriquApi";
import { ApiError, type WorkspaceDashboardSummary } from "../../../lib/api";
import { cn } from "../../../components/ui/cn";

// ─── Types ────────────────────────────────────────────────────────────────────

type SavedState = "loading" | "ready" | "error";
type ChartData = Array<Record<string, number | string>>;
type ZoomChartState = {
  dashboardId: string;
  dashboardTitle: string;
  chart: WorkspaceDashboardSummary["charts"][number];
  data: ChartData;
} | null;

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

function hasFiniteValueKey(rows: ChartData, key: string): boolean {
  return rows.some((row) => toFiniteNumber((row as any)?.[key]) !== null);
}

function inferNumericSeriesKeys(rows: ChartData): string[] {
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

// ─── Constants ────────────────────────────────────────────────────────────────

const PIE_COLORS = [
  "#7c3aed",
  "#3b82f6",
  "#06b6d4",
  "#14b8a6",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
];

const TICK = { fill: "rgb(var(--color-text-muted))", fontSize: 10 };
const GRID = { strokeDasharray: "3 3", stroke: "rgb(var(--color-text-muted) / 0.12)" };

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtCurrency(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function fmtNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(0);
}

function fmtPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function prettyChartType(type: string): string {
  const t = String(type || "").toLowerCase();
  if (t === "bar") return "Bar chart";
  if (t === "line") return "Line chart";
  if (t === "combo") return "Combo chart";
  if (t === "pie") return "Pie chart";
  if (t === "area") return "Area chart";
  if (t === "heatmap") return "Heatmap";
  if (t === "matrix") return "Matrix";
  if (t === "metric") return "Metric";
  if (t === "table") return "Table";
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "Chart";
}

function formatValue(metric: string, grouping: string, value: number): string {
  const metricKey = String(metric ?? "").toLowerCase();
  const isPercent =
    metric === "collection_rate" ||
    metric === "overdue_rate" ||
    /\b(pct|percent|percentage|share|ratio|rate)\b/.test(metricKey);
  if (isPercent) return fmtPercent(value);

  if (metric === "dso") return `${value.toFixed(1)}d`;

  const isCurrencyMetric =
    metric === "revenue" ||
    metric === "outstanding" ||
    metric === "overdue" ||
    metric === "paid" ||
    metric === "total_invoiced" ||
    metric === "avg_invoice" ||
    (metric === "invoices" && grouping === "status") ||
    /\b(spend|expense|revenue|income|cost|profit|margin|balance|cash|asset|liabil|equity|payable|receivable|debit|credit|amount|value)\b/.test(
      metricKey,
    );

  if (isCurrencyMetric) return fmtCurrency(value);

  return fmtNumber(value);
}

function formatWhen(value: string | null) {
  if (!value) return "not synced";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

// ─── Custom Tooltip ───────────────────────────────────────────────────────────

const CustomTooltip = ({ active, payload, label, metric, grouping }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-default bg-bg-card/95 p-3 shadow-xl backdrop-blur-sm">
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
              ? formatValue(String(metric ?? ""), String(grouping ?? ""), entry.value)
              : entry.value}
          </span>
        </div>
      ))}
    </div>
  );
};

// ─── Chart Insight Pill ───────────────────────────────────────────────────────

function InsightPill({ type, data }: { type: string; data: ChartData }) {
  if (data.length === 0) return null;

  if (type === "line" && data.length >= 2) {
    const first = Number(data[0]?.value) || 0;
    const last = Number(data[data.length - 1]?.value) || 0;
    if (first === 0) return null;
    const pct = ((last - first) / first) * 100;
    const up = pct >= 0;
    return (
      <span
        className={cn(
          "flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold",
          up
            ? "bg-feedback-success/10 text-feedback-success"
            : "bg-feedback-danger/10 text-feedback-danger",
        )}
      >
        {up ? <ArrowUpRight size={10} /> : <ArrowDownRight size={10} />}
        {Math.abs(pct).toFixed(1)}%
      </span>
    );
  }

  return null;
}

// ─── Chart Renderer ───────────────────────────────────────────────────────────

function ChartRenderer({
  type,
  data,
  chartId,
  metric,
  grouping,
  display,
}: {
  type: string;
  data: ChartData;
  chartId: string;
  metric: string;
  grouping: string;
  display?: {
    conditionalThreshold?: number | null;
    conditionalColor?: "green" | null;
  } | null;
}) {
  const h = 200;

  if (type === "metric") {
    const raw = data[0] as Record<string, number> | undefined;
    const metrics = [
      {
        label: "Burn",
        value: fmtCurrency(raw?.burnRate ?? 0),
        icon: TrendingDown,
        color: "text-feedback-danger",
        bg: "bg-feedback-danger/8",
      },
      {
        label: "Runway",
        value: `${raw?.runwayMonths ?? 0}mo`,
        icon: Clock,
        color: "text-feedback-warning",
        bg: "bg-feedback-warning/8",
      },
      {
        label: "Cash",
        value: fmtCurrency(raw?.cashOnHand ?? 0),
        icon: DollarSign,
        color: "text-accent-cyan",
        bg: "bg-accent-cyan/8",
      },
      {
        label: "Efficiency",
        value: `${raw?.efficiencyMultiplier ?? 0}x`,
        icon: Zap,
        color: "text-accent-violet",
        bg: "bg-accent-violet/8",
      },
    ];
    return (
      <div style={{ height: h }} className="grid grid-cols-2 gap-2 p-1">
        {metrics.map((m) => (
          <div
            key={m.label}
            className={cn("flex flex-col justify-between rounded-xl p-3", m.bg)}
          >
            <div className="flex items-center justify-between">
              <span className="text-[9px] font-bold uppercase tracking-wider text-text-muted">
                {m.label}
              </span>
              <m.icon size={11} className={m.color} />
            </div>
            <p className={cn("text-lg font-black", m.color)}>{m.value}</p>
          </div>
        ))}
      </div>
    );
  }

  if (type === "line") {
    const seriesKeys = inferNumericSeriesKeys(data);
    const hasValueSeries = hasFiniteValueKey(data, "value");
    const isMultiSeries = !hasValueSeries && seriesKeys.length > 0;

    if (isMultiSeries) {
      return (
        <div style={{ height: h }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 4, left: 12, bottom: 0 }}>
              <CartesianGrid {...GRID} />
              <XAxis
                dataKey="name"
                tick={TICK}
                tickLine={false}
                axisLine={false}
                minTickGap={14}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={TICK}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) =>
                  formatValue(metric, grouping, Number(v) || 0)
                }
                width={56}
                tickMargin={8}
              />
              <Tooltip content={<CustomTooltip metric={metric} grouping={grouping} />} />
              <Legend
                verticalAlign="top"
                height={24}
                wrapperStyle={{ fontSize: 10, fontWeight: 600, color: "rgb(var(--color-text-muted))" }}
              />
              {seriesKeys.slice(0, 8).map((key, idx) => (
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
          </ResponsiveContainer>
        </div>
      );
    }

    return (
      <div style={{ height: h }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 4, left: 12, bottom: 0 }}>
            <defs>
              <linearGradient id={`grad-${chartId}`} x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="5%"
                  stopColor="rgb(var(--color-accent-violet))"
                  stopOpacity={0.28}
                />
                <stop
                  offset="95%"
                  stopColor="rgb(var(--color-accent-violet))"
                  stopOpacity={0}
                />
              </linearGradient>
            </defs>
            <CartesianGrid {...GRID} />
            <XAxis
              dataKey="name"
              tick={TICK}
              tickLine={false}
              axisLine={false}
              minTickGap={14}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={TICK}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) =>
                formatValue(metric, grouping, Number(v) || 0)
              }
              width={56}
              tickMargin={8}
            />
            <Tooltip content={<CustomTooltip metric={metric} grouping={grouping} />} />
            <Area
              type="monotone"
              dataKey="value"
              stroke="rgb(var(--color-accent-violet))"
              strokeWidth={2}
              fill={`url(#grad-${chartId})`}
              dot={false}
              activeDot={{ r: 4 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (type === "bar") {
    const useHorizontalBars = grouping === "client" && data.length > 6;
    const trimmed = useHorizontalBars ? data.slice(0, 8) : data;
    const seriesKeys = inferNumericSeriesKeys(trimmed);
    const hasValueSeries = hasFiniteValueKey(trimmed, "value");
    const isMulti = grouping === "month" && !hasValueSeries && seriesKeys.length >= 1;
    return (
      <div style={{ height: useHorizontalBars ? Math.max(h, trimmed.length * 24 + 24) : h }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={trimmed}
            margin={useHorizontalBars ? { top: 6, right: 10, left: 8, bottom: 6 } : { top: 8, right: 4, left: 12, bottom: 0 }}
            layout={useHorizontalBars ? "vertical" : "horizontal"}
          >
            <defs>
              <linearGradient id={`grad-bar-${chartId}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgb(var(--color-accent-blue))" stopOpacity={1} />
                <stop
                  offset="100%"
                  stopColor="rgb(var(--color-accent-violet))"
                  stopOpacity={0.8}
                />
              </linearGradient>
            </defs>
            <CartesianGrid {...GRID} vertical={false} />
            {useHorizontalBars ? (
              <>
                <XAxis
                  type="number"
                  tick={TICK}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => formatValue(metric, grouping, Number(v) || 0)}
                  tickMargin={8}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  tick={TICK}
                  tickLine={false}
                  axisLine={false}
                  width={150}
                  tickMargin={10}
                  interval={0}
                  tickFormatter={(v: string) => {
                    const label = String(v ?? "");
                    return label.length > 18 ? label.slice(0, 17) + "…" : label;
                  }}
                />
              </>
            ) : (
              <>
            <XAxis
              dataKey="name"
              tick={TICK}
              tickLine={false}
              axisLine={false}
              minTickGap={14}
              interval="preserveStartEnd"
            />
                <YAxis
                  tick={TICK}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) =>
                    formatValue(metric, grouping, Number(v) || 0)
                  }
                  width={56}
                  tickMargin={8}
                />
              </>
            )}
            <Tooltip content={<CustomTooltip metric={metric} grouping={grouping} />} />
            {isMulti ? (
              <>
                {seriesKeys.slice(0, 4).map((k, idx) => (
                  <Bar
                    key={k}
                    dataKey={k}
                    fill={PIE_COLORS[idx % PIE_COLORS.length]}
                    radius={useHorizontalBars ? [6, 6, 6, 6] : [5, 5, 0, 0]}
                    maxBarSize={useHorizontalBars ? 16 : 28}
                  />
                ))}
                <Legend
                  verticalAlign="top"
                  height={24}
                  wrapperStyle={{ fontSize: 10, fontWeight: 600, color: "rgb(var(--color-text-muted))" }}
                />
              </>
            ) : (
              <Bar
                dataKey="value"
                fill={`url(#grad-bar-${chartId})`}
                radius={useHorizontalBars ? [6, 6, 6, 6] : [5, 5, 0, 0]}
                maxBarSize={useHorizontalBars ? 16 : 48}
              />
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (type === "pie") {
    const total = data.reduce((s, d) => s + (Number(d.value) || 0), 0);
    const enriched = data.map((d) => ({ ...d, total }));
    return (
      <div style={{ height: h }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={enriched}
              cx="45%"
              cy="50%"
              innerRadius="28%"
              outerRadius="55%"
              paddingAngle={3}
              dataKey="value"
              labelLine={false}
            >
              {enriched.map((_, i) => (
                <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} stroke="none" />
              ))}
            </Pie>
            <Tooltip content={<CustomTooltip metric={metric} grouping={grouping} />} />
            <Legend
              layout="vertical"
              align="right"
              verticalAlign="middle"
              iconType="circle"
              iconSize={7}
              formatter={(v: string) => (
                <span
                  style={{
                    fontSize: 10,
                    color: "rgb(var(--color-text-secondary))",
                    fontWeight: 600,
                  }}
                >
                  {v}
                </span>
              )}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (type === "table") {
    const rows = data.slice(0, 10);
    const cols = rows.length > 0 ? Object.keys(rows[0] ?? {}).slice(0, 6) : [];
    return (
      <div style={{ height: h }} className="overflow-hidden rounded-xl border border-default bg-bg-elevated/30">
        <div className="h-full overflow-auto">
          <table className="w-full text-left text-[11px]">
            <thead className="sticky top-0 bg-bg-elevated/80 backdrop-blur">
              <tr>
                {cols.map((c) => (
                  <th
                    key={c}
                    className="px-3 py-2 font-bold uppercase tracking-wider text-text-muted"
                  >
                    {c.replaceAll("_", " ")}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => (
                <tr key={idx} className="border-t border-default/50">
                  {cols.map((c) => (
                    <td key={c} className="px-3 py-2 text-text-secondary">
                      {String((r as any)?.[c] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td className="px-3 py-3 text-text-muted" colSpan={cols.length || 1}>
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

  if (type === "treemap") {
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
      const showLabel = width > 38 && height > 18;
      const showValue = width > 50 && height > 34;
      const label = String(name ?? "");
      const charBudget = Math.max(3, Math.floor(width / 7));
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

  if (type === "heatmap" || type === "matrix") {
    const rows = data.filter(Boolean);
    const colKeys = inferNumericSeriesKeys(rows).filter((k) => k !== "total");
    const rowAxis = String(grouping ?? "").split("_")[0] || "row";
    const prettyAxis = (value: string) =>
      value
        .split("_")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
    const axisLabel = (axis: string) => prettyAxis(axis || "Name");
    const amount = (value: number) => formatValue(metric, grouping, value);
    const lerp = (from: number, to: number, t: number) =>
      Math.round(from + (to - from) * Math.max(0, Math.min(1, t)));
    const rgb = (r: number, g: number, b: number) => `rgb(${r}, ${g}, ${b})`;
    const maxVal = Math.max(
      ...rows.flatMap((row) => colKeys.map((key) => Math.abs(Number((row as any)[key]) || 0))),
      1,
    );
    const conditionalThreshold =
      typeof display?.conditionalThreshold === "number"
        ? display.conditionalThreshold
        : null;
    const cellTheme = (value: number) => {
      if (
        conditionalThreshold !== null &&
        value >= conditionalThreshold &&
        display?.conditionalColor === "green"
      ) {
        return { bg: "#16a34a", fg: "#ffffff" };
      }
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
    <div style={{ height: h }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 4, left: 12, bottom: 0 }}>
          <CartesianGrid {...GRID} />
          <XAxis dataKey="name" tick={TICK} />
          <YAxis
            tick={TICK}
            tickFormatter={(v: number) =>
              formatValue(metric, grouping, Number(v) || 0)
            }
            width={56}
            tickMargin={8}
          />
          <Tooltip content={<CustomTooltip metric={metric} grouping={grouping} />} />
          <Line
            type="monotone"
            dataKey="value"
            stroke="rgb(var(--color-accent-blue))"
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Expanded Charts Grid ─────────────────────────────────────────────────────

function ExpandedDashboard({
  dashboard,
  chartData,
  loading,
  onZoom,
}: {
  dashboard: WorkspaceDashboardSummary;
  chartData: Record<string, ChartData>;
  loading: boolean;
  onZoom: (next: ZoomChartState) => void;
}) {
  if (loading) {
    return (
      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        {dashboard.charts.map((c) => (
          <motion.div
            key={c.id}
            animate={{ opacity: [0.3, 0.65, 0.3] }}
            transition={{ duration: 1.4, repeat: Infinity }}
            className="h-[260px] rounded-2xl bg-bg-elevated"
          />
        ))}
      </div>
    );
  }

  if (dashboard.charts.length === 0) {
    return (
      <p className="mt-4 text-sm text-text-muted">No charts in this dashboard.</p>
    );
  }

  return (
    <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
      {dashboard.charts.map((chart, i) => {
        const data = chartData[chart.id] ?? [];
        const description = (chart.chartConfig as any)?.description as string | undefined;
        const axisless = [
          "metric",
          "kpi",
          "gauge",
          "pie",
          "donut",
          "treemap",
          "heatmap",
          "matrix",
        ].includes(chart.type);
        const xAxisLabel = !axisless
          ? ((chart.queryConfig as any)?.xAxisLabel as string | undefined)?.trim()
          : undefined;
        const yAxisLabel = !axisless
          ? ((chart.queryConfig as any)?.yAxisLabel as string | undefined)?.trim()
          : undefined;
        return (
          <motion.div
            key={chart.id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.07, duration: 0.3 }}
            role="button"
            tabIndex={0}
            onClick={() =>
              onZoom({
                dashboardId: dashboard.id,
                dashboardTitle: dashboard.title,
                chart,
                data,
              })
            }
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onZoom({
                  dashboardId: dashboard.id,
                  dashboardTitle: dashboard.title,
                  chart,
                  data,
                });
              }
            }}
            className="surface-card group cursor-pointer p-4 outline-none transition-colors hover:border-accent-violet/25 focus-visible:ring-2 focus-visible:ring-accent-violet/35"
          >
            <div className="mb-2 flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h4 className="truncate text-sm font-semibold text-text-primary">
                  {chart.title}
                </h4>
                {description && (
                  <p className="mt-0.5 line-clamp-1 text-[10px] text-text-muted">
                    {description}
                  </p>
                )}
                {(xAxisLabel || yAxisLabel) && (
                  <p className="mt-1 line-clamp-1 text-[10px] font-medium text-text-muted/90">
                    {xAxisLabel && (
                      <>
                        <span className="text-text-muted/70">X:</span> {xAxisLabel}
                      </>
                    )}
                    {xAxisLabel && yAxisLabel && (
                      <span className="mx-1.5 text-text-muted/40">·</span>
                    )}
                    {yAxisLabel && (
                      <>
                        <span className="text-text-muted/70">Y:</span> {yAxisLabel}
                      </>
                    )}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <InsightPill type={chart.type} data={data} />
                <span className="rounded-lg border border-default bg-bg-elevated/40 p-1 text-text-muted opacity-0 transition-opacity group-hover:opacity-100">
                  <Maximize2 size={12} />
                </span>
              </div>
            </div>
            <div className="pointer-events-none">
              {data.length === 0 ? (
                <div className="flex h-[200px] items-center justify-center rounded-xl bg-bg-elevated/30">
                  <p className="text-xs text-text-muted">No data available</p>
                </div>
              ) : (
                <ChartRenderer
                  type={chart.type}
                  data={data}
                  chartId={chart.id}
                  metric={String((chart.queryConfig as any)?.metric ?? "")}
                  grouping={String((chart.queryConfig as any)?.grouping ?? "")}
                  display={(chart.queryConfig as any)?.display ?? null}
                />
              )}
            </div>
            <div className="mt-2">
              <span className="rounded-full bg-bg-elevated px-2 py-0.5 text-[10px] font-semibold text-text-muted ring-1 ring-default">
                {prettyChartType(chart.type)}
              </span>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}

// ─── DashboardsPage ───────────────────────────────────────────────────────────

export function DashboardsPage() {
  const router = useRouter();
  const { dashboards, agent } = useNumeriquApi();
  const [savedDashboards, setSavedDashboards] = useState<WorkspaceDashboardSummary[]>([]);
  const [savedLoadState, setSavedLoadState] = useState<SavedState>("loading");
  const [savedError, setSavedError] = useState<string | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [zoomChart, setZoomChart] = useState<ZoomChartState>(null);
  const [chartDataCache, setChartDataCache] = useState<
    Record<string, Record<string, ChartData>>
  >({});
  const [loadingCharts, setLoadingCharts] = useState<string | null>(null);

  async function loadSavedDashboards() {
    setSavedLoadState("loading");
    setSavedError(null);
    try {
      const payload = await dashboards.list();
      setSavedDashboards(payload);
      setSavedLoadState("ready");
    } catch (caught) {
      const message =
        caught instanceof ApiError
          ? caught.toUserMessage("We couldn't load saved dashboards right now.")
          : "We couldn't load saved dashboards right now.";
      setSavedError(message);
      setSavedLoadState("error");
    }
  }

  useEffect(() => {
    void loadSavedDashboards();
    const onFocus = () => void loadSavedDashboards();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!zoomChart) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZoomChart(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [zoomChart]);

  async function handleRefresh(dashboardId: string) {
    setRefreshingId(dashboardId);
    setSavedError(null);
    try {
      await dashboards.refresh(dashboardId);
      await loadSavedDashboards();
    } catch (caught) {
      const message =
        caught instanceof ApiError
          ? caught.toUserMessage("We couldn't refresh that dashboard right now.")
          : "We couldn't refresh that dashboard right now.";
      setSavedError(message);
    } finally {
      setRefreshingId(null);
    }
  }

  async function handleToggle(dashboard: WorkspaceDashboardSummary) {
    if (expandedId === dashboard.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(dashboard.id);
    if (chartDataCache[dashboard.id]) return;

    setLoadingCharts(dashboard.id);
    try {
      const dataMap: Record<string, ChartData> = {};
      await Promise.all(
        dashboard.charts.map(async (chart) => {
          const metric = (chart.queryConfig.metric as string) ?? "expense";
          const grouping = (chart.queryConfig.grouping as string) ?? "month";
          const timeRange = (chart.queryConfig as any)?.timeRange ?? null;
          const providerHint = (chart.queryConfig as any)?.providerHint ?? null;
          const clientName = (chart.queryConfig as any)?.clientName ?? null;
          const clientNames = (chart.queryConfig as any)?.clientNames ?? null;
          const orgId = (chart.queryConfig as any)?.orgId ?? null;
          const breakdown = (chart.queryConfig as any)?.breakdown ?? null;
          const topN = (chart.queryConfig as any)?.topN ?? null;
          try {
            const res = await agent.getMetrics(metric, grouping, timeRange, providerHint, clientName, clientNames, orgId, breakdown, topN);
            dataMap[chart.id] = (res.data ?? []) as ChartData;
          } catch {
            dataMap[chart.id] = [];
          }
        }),
      );
      setChartDataCache((prev) => ({ ...prev, [dashboard.id]: dataMap }));
    } finally {
      setLoadingCharts(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* Zoom modal (chart click) */}
      <AnimatePresence>
        {zoomChart ? (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setZoomChart(null);
            }}
          >
            <motion.div
              className="w-full max-w-5xl overflow-hidden rounded-3xl border border-default bg-bg-card shadow-2xl"
              initial={{ opacity: 0, y: 14, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.985 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="flex items-start justify-between gap-3 border-b border-default px-5 py-4">
                <div className="min-w-0">
                  <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-text-muted">
                    {zoomChart.dashboardTitle}
                  </p>
                  <h3 className="mt-1 truncate text-base font-semibold text-text-primary">
                    {zoomChart.chart.title}
                  </h3>
                  {(zoomChart.chart.chartConfig as any)?.description ? (
                    <p className="mt-1 line-clamp-2 text-xs text-text-secondary">
                      {String((zoomChart.chart.chartConfig as any)?.description ?? "")}
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => setZoomChart(null)}
                  className="rounded-xl border border-default bg-bg-elevated/40 p-2 text-text-muted transition-colors hover:border-accent-violet/25 hover:text-text-primary"
                  title="Close"
                >
                  <X size={14} />
                </button>
              </div>

              <div className="p-5">
                {zoomChart.data.length === 0 ? (
                  <div className="flex h-[420px] items-center justify-center rounded-2xl bg-bg-elevated/30">
                    <p className="text-sm text-text-muted">No data available</p>
                  </div>
                ) : (
                  <div className="rounded-2xl border border-default bg-bg-elevated/20 p-3">
                    <ChartRenderer
                      type={zoomChart.chart.type}
                      data={zoomChart.data}
                      chartId={zoomChart.chart.id}
                      metric={String((zoomChart.chart.queryConfig as any)?.metric ?? "")}
                      grouping={String((zoomChart.chart.queryConfig as any)?.grouping ?? "")}
                      display={(zoomChart.chart.queryConfig as any)?.display ?? null}
                    />
                  </div>
                )}
                <div className="mt-3 flex items-center justify-between">
                  <span className="rounded-full bg-bg-elevated px-2 py-0.5 text-[10px] font-semibold text-text-muted ring-1 ring-default">
                    {prettyChartType(zoomChart.chart.type)}
                  </span>
                  <p className="text-[10px] text-text-muted">
                    Click outside or press Esc to close
                  </p>
                </div>
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Page header */}
      <header className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent-violet">
            Dashboards
          </p>
          <h2 className="mt-2 font-display text-2xl font-bold text-text-primary md:text-3xl">
            Saved decision surfaces
          </h2>
          <p className="mt-1 text-sm text-text-muted">
            Click a dashboard to expand charts. Use Astra to generate or refine new ones.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void loadSavedDashboards()}
            loading={savedLoadState === "loading"}
          >
            <RefreshCw className="size-4" /> Reload
          </Button>
          <Button
            size="sm"
            onClick={() => router.push("/dashboard/agent")}
          >
            <Sparkles className="size-4" /> Open Astra
          </Button>
        </div>
      </header>

      {savedError && (
        <ErrorBanner
          title="Dashboard issue"
          tone="warning"
          onDismiss={() => setSavedError(null)}
        >
          {savedError}
        </ErrorBanner>
      )}

      <div className="surface-card p-6">
        <div className="space-y-3">
          {savedLoadState === "loading" ? (
            Array.from({ length: 3 }).map((_, idx) => (
              <Skeleton key={idx} height={94} rounded="xl" />
            ))
          ) : savedLoadState === "error" ? (
            <EmptyState
              title="Saved dashboards unavailable"
              detail="Retry once your connection is stable."
              action={
                <Button variant="secondary" size="sm" onClick={() => void loadSavedDashboards()}>
                  Retry
                </Button>
              }
            />
          ) : savedDashboards.length === 0 ? (
            <EmptyState
              title="No saved dashboards yet"
              detail="Create dashboards from Astra to build your board pack library."
              action={
                <Button size="sm" onClick={() => router.push("/dashboard/agent")}>
                  <Sparkles className="size-4" /> Open Astra
                </Button>
              }
            />
          ) : (
            savedDashboards.slice(0, 8).map((item, listIdx) => {
              const isExpanded = expandedId === item.id;
              const isLoadingThis = loadingCharts === item.id;

              return (
                <motion.div
                  key={item.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: listIdx * 0.06 }}
                  className={cn(
                    "rounded-2xl border bg-bg-elevated/40 transition-all duration-200",
                    isExpanded
                      ? "border-accent-violet/30 bg-accent-violet/4"
                      : "border-default hover:border-accent-violet/20",
                  )}
                >
                  {/* Header row */}
                  <div
                    role="button"
                    tabIndex={0}
                    className="w-full cursor-pointer select-none p-4 text-left"
                    onClick={() => void handleToggle(item)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") void handleToggle(item);
                    }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate font-semibold text-text-primary">
                            {item.title}
                          </p>
                          <span className="shrink-0 rounded-full bg-bg-elevated px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-text-muted">
                            {item.charts.length} charts
                          </span>
                        </div>
                        {item.description && (
                          <p className="mt-1 truncate text-sm text-text-secondary">
                            {item.description}
                          </p>
                        )}
                        <p className="mt-1.5 text-xs text-text-muted">
                          Synced {formatWhen(item.lastSyncedAt)} · updated{" "}
                          {formatWhen(item.updatedAt)}
                        </p>
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        <button
                          type="button"
                          title="Continue editing in Astra"
                          onClick={async (e) => {
                            e.stopPropagation();
                            try {
                              const result = await agent.getDashboardSession(item.id);
                              if (result?.sessionId) {
                                router.push(`/dashboard/agent?sessionId=${result.sessionId}`);
                              } else {
                                router.push("/dashboard/agent");
                              }
                            } catch {
                              router.push("/dashboard/agent");
                            }
                          }}
                          className="flex items-center gap-1 rounded-lg border border-default px-2 py-1 text-[10px] font-medium text-text-muted transition-colors hover:border-accent-violet/30 hover:text-accent-violet"
                        >
                          <ExternalLink size={10} />
                          Edit in Astra
                        </button>
                        <Button
                          variant="secondary"
                          size="sm"
                          loading={refreshingId === item.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleRefresh(item.id);
                          }}
                        >
                          <RefreshCw className="size-3.5" />
                        </Button>
                        {isExpanded ? (
                          <ChevronUp size={15} className="text-text-muted" />
                        ) : (
                          <ChevronDown size={15} className="text-text-muted" />
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Expanded charts */}
                  <AnimatePresence initial={false}>
                    {isExpanded && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                        className="overflow-hidden"
                      >
                        <div className="px-4 pb-4">
                          <ExpandedDashboard
                            dashboard={item}
                            chartData={chartDataCache[item.id] ?? {}}
                            loading={isLoadingThis}
                            onZoom={setZoomChart}
                          />
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
