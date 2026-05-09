"use client";

import { useEffect, useState } from "react";
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
} from "recharts";
import { ApiError } from "../../../lib/api";
import { useNumeriquApi } from "../../../lib/useNumeriquApi";
import { EmptyState } from "../../../components/ui/EmptyState";
import { ErrorBanner } from "../../../components/ui/ErrorBanner";
import { cn } from "../../../components/ui/cn";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface ChartConfig {
  metric: string;
  grouping: string;
  description?: string;
}

interface Chart {
  id: string;
  title: string;
  description?: string | null;
  type: string;
  config: ChartConfig;
  layoutIndex?: number;
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

// ─── Constants ────────────────────────────────────────────────────────────────

const PIE_COLORS = ["#7c3aed", "#3b82f6", "#06b6d4", "#14b8a6", "#f59e0b", "#ef4444", "#8b5cf6"];

// ─── Formatters ───────────────────────────────────────────────────────────────

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

function formatValue(metric: string, grouping: string, value: number): string {
  const isPercent = metric === "collection_rate" || metric === "overdue_rate";
  if (isPercent) return `${value.toFixed(1)}%`;

  const isCurrencyMetric =
    metric === "revenue" ||
    metric === "outstanding" ||
    metric === "overdue" ||
    metric === "paid" ||
    metric === "total_invoiced" ||
    metric === "avg_invoice" ||
    (metric === "invoices" && grouping === "status");

  if (isCurrencyMetric) return fmtCurrency(value);
  return fmtNumber(value);
}

// ─── Custom Tooltip ───────────────────────────────────────────────────────────

const CustomTooltip = ({ active, payload, label, metric, grouping }: any) => {
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
              ? formatValue(String(metric ?? ""), String(grouping ?? ""), entry.value)
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

const PieTooltip = ({ active, payload, metric, grouping }: any) => {
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
        {pct ? ` · ${pct}%` : ""}
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
    const vals = data.map((d) => Number(d.value) || 0);
    const max = Math.max(...vals);
    const maxEntry = data.find((d) => Number(d.value) === max);
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
      sub: "revenue / burn",
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

function renderChart(chart: Chart, data: DataRow[], isExpanded: boolean) {
  const h = isExpanded ? 480 : 240;

  if (chart.type === "metric") {
    const raw = data[0] as VentureData | undefined;
    return (
      <div className="flex w-full items-center justify-center py-2">
        <VentureMetricCard data={raw ?? {}} />
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

  if (chart.type === "line") {
    const vals = data.map((d) => Number(d.value) || 0);
    const avg = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;

    return (
      <div style={{ height: h, width: "100%" }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={`grad-line-${chart.id}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="rgb(var(--color-accent-violet))" stopOpacity={0.3} />
                <stop offset="95%" stopColor="rgb(var(--color-accent-violet))" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid {...gridStyle} />
            <XAxis dataKey="name" tick={tickStyle} tickLine={false} axisLine={false} />
            <YAxis
              tick={tickStyle}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) =>
                formatValue(chart.config.metric, chart.config.grouping, Number(v) || 0)
              }
              width={42}
            />
            <Tooltip
              content={
                <CustomTooltip metric={chart.config.metric} grouping={chart.config.grouping} />
              }
            />
            {isExpanded && avg > 0 && (
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
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "bar") {
    const isClientGrouping = chart.config.grouping === "client";
    const barHeight = isClientGrouping ? h + 40 : h;
    const barMargin = isClientGrouping
      ? { top: 8, right: 4, left: 0, bottom: 60 }
      : { top: 8, right: 4, left: 0, bottom: 0 };

    return (
      <div style={{ height: barHeight, width: "100%" }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={barMargin}>
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
            <XAxis
              dataKey="name"
              tick={
                isClientGrouping
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  ? (props: any) => {
                      const x = Number(props.x ?? 0);
                      const y = Number(props.y ?? 0);
                      const label = String(props.payload?.value ?? "");
                      const truncated = label.length > 14 ? label.slice(0, 13) + "…" : label;
                      return (
                        <g transform={`translate(${x},${y})`}>
                          <text
                            x={0}
                            y={0}
                            dy={12}
                            textAnchor="end"
                            transform="rotate(-35)"
                            style={{ ...tickStyle, fontSize: isExpanded ? 11 : 9 }}
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
              interval={0}
            />
            <YAxis
              tick={tickStyle}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) =>
                formatValue(chart.config.metric, chart.config.grouping, Number(v) || 0)
              }
              width={42}
            />
            <Tooltip
              content={
                <CustomTooltip metric={chart.config.metric} grouping={chart.config.grouping} />
              }
            />
            <Bar
              dataKey="value"
              fill={`url(#grad-bar-${chart.id})`}
              radius={[6, 6, 0, 0]}
              maxBarSize={56}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "pie") {
    const total = data.reduce((s, d) => s + (Number(d.value) || 0), 0);
    const enriched = data.map((d) => ({ ...d, total }));

    const renderLabel = ({
      cx,
      cy,
      midAngle,
      innerRadius,
      outerRadius,
      percent,
    }: any) => {
      if (percent < 0.07) return null;
      const RADIAN = Math.PI / 180;
      const r = innerRadius + (outerRadius - innerRadius) * 0.55;
      const x = cx + r * Math.cos(-midAngle * RADIAN);
      const y = cy + r * Math.sin(-midAngle * RADIAN);
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
          {`${(percent * 100).toFixed(0)}%`}
        </text>
      );
    };

    return (
      <div style={{ height: h, width: "100%" }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={enriched}
              cx="45%"
              cy="50%"
              innerRadius={isExpanded ? "35%" : "28%"}
              outerRadius={isExpanded ? "65%" : "58%"}
              paddingAngle={3}
              dataKey="value"
              labelLine={false}
              label={renderLabel}
            >
              {enriched.map((_, i) => (
                <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} stroke="none" />
              ))}
            </Pie>
            <Tooltip
              content={<PieTooltip metric={chart.config.metric} grouping={chart.config.grouping} />}
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
                    fontSize: 11,
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
    const cols = rows.length > 0 ? Object.keys(rows[0] ?? {}).slice(0, 7) : [];
    return (
      <div style={{ height: h, width: "100%" }} className="overflow-hidden rounded-xl border border-default bg-bg-elevated/30">
        <div className="h-full overflow-auto">
          <table className="w-full text-left text-[11px]">
            <thead className="sticky top-0 bg-bg-elevated/80 backdrop-blur">
              <tr>
                {cols.map((c) => (
                  <th key={c} className="px-3 py-2 font-bold uppercase tracking-wider text-text-muted">
                    {c.replaceAll("_", " ")}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => (
                <tr key={idx} className="border-t border-default/50">
                  {cols.map((c) => (
                    <td key={c} className="px-3 py-2 text-text-secondary whitespace-nowrap">
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

  return (
    <div style={{ height: h, width: "100%" }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <CartesianGrid {...gridStyle} />
          <XAxis dataKey="name" tick={tickStyle} />
          <YAxis
            tick={tickStyle}
            tickFormatter={(v: number) =>
              formatValue(chart.config.metric, chart.config.grouping, Number(v) || 0)
            }
            width={42}
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
      </ResponsiveContainer>
    </div>
  );
}

// ─── Chart Card ───────────────────────────────────────────────────────────────

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
            <p className="text-xs text-text-muted">No data — connect your ERP to populate</p>
          </div>
        ) : (
          renderChart(chart, data, false)
        )}
      </div>

      {/* Footer: type badge + insight */}
      <div className="mt-3 flex min-w-0 items-center gap-2">
        <span className="shrink-0 rounded-full bg-bg-elevated px-2.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.2em] text-text-muted">
          {chart.type}
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

// ─── DashboardPreview ─────────────────────────────────────────────────────────

export function DashboardPreview({
  triggerSync,
  isGenerating = false,
}: {
  triggerSync: number;
  isGenerating?: boolean;
}) {
  const { agent, loading } = useNumeriquApi();
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [chartData, setChartData] = useState<Record<string, DataRow[]>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedChartId, setExpandedChartId] = useState<string | null>(null);

  useEffect(() => {
    if (loading) return;

    const fetchDashboard = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const latest = await agent.latestDashboard();
        if (latest) {
          const charts: Chart[] = (latest.charts ?? []).map((c) => ({
            id: c.id,
            title: c.title,
            description: c.description ?? null,
            type: c.type,
            config: c.config as ChartConfig,
            layoutIndex: c.layoutIndex,
          }));
          setDashboard({
            id: latest.id,
            title: latest.title,
            description: latest.description ?? null,
            charts,
          });

          const dataMap: Record<string, DataRow[]> = {};
          await Promise.all(
            charts.map(async (chart) => {
              try {
                const res = await agent.getMetrics(
                  chart.config.metric,
                  chart.config.grouping,
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
  }, [agent, loading, triggerSync]);

  // ── Loading / Generating state ──────────────────────────────────────────────

  if (isGenerating && !dashboard) {
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

  const expandedChart = dashboard.charts.find((c) => c.id === expandedChartId);
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

      {/* Chart grid — single column so each chart gets full panel width */}
      <div className="grid grid-cols-1 gap-4 pb-8">
        {dashboard.charts.map((chart, index) => (
          <ChartCard
            key={chart.id}
            chart={chart}
            data={chartData[chart.id] ?? []}
            index={index}
            onExpand={() => setExpandedChartId(chart.id)}
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
              </div>

              <div className="min-h-0 w-full flex-1 rounded-2xl border border-default bg-bg-elevated/30 p-6">
                {renderChart(expandedChart, expandedData, true)}
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
