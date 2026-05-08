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

const CustomTooltip = ({ active, payload, label }: any) => {
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
            {typeof entry.value === "number" && entry.value > 100
              ? fmtCurrency(entry.value)
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
}: {
  type: string;
  data: ChartData;
  chartId: string;
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
    return (
      <div style={{ height: h }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
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
            <XAxis dataKey="name" tick={TICK} tickLine={false} axisLine={false} />
            <YAxis
              tick={TICK}
              tickLine={false}
              axisLine={false}
              tickFormatter={fmtNumber}
              width={40}
            />
            <Tooltip content={<CustomTooltip />} />
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
    return (
      <div style={{ height: h }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
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
            <XAxis dataKey="name" tick={TICK} tickLine={false} axisLine={false} />
            <YAxis
              tick={TICK}
              tickLine={false}
              axisLine={false}
              tickFormatter={fmtNumber}
              width={40}
            />
            <Tooltip content={<CustomTooltip />} />
            <Bar
              dataKey="value"
              fill={`url(#grad-bar-${chartId})`}
              radius={[5, 5, 0, 0]}
              maxBarSize={48}
            />
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
            <Tooltip content={<CustomTooltip />} />
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

  return (
    <div style={{ height: h }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <CartesianGrid {...GRID} />
          <XAxis dataKey="name" tick={TICK} />
          <YAxis tick={TICK} tickFormatter={fmtNumber} width={40} />
          <Tooltip content={<CustomTooltip />} />
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
}: {
  dashboard: WorkspaceDashboardSummary;
  chartData: Record<string, ChartData>;
  loading: boolean;
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
        return (
          <motion.div
            key={chart.id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.07, duration: 0.3 }}
            className="rounded-2xl border border-default bg-bg-elevated/40 p-4"
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
              </div>
              <InsightPill type={chart.type} data={data} />
            </div>
            <div className="pointer-events-none">
              {data.length === 0 ? (
                <div className="flex h-[200px] items-center justify-center rounded-xl bg-bg-elevated/30">
                  <p className="text-xs text-text-muted">No data available</p>
                </div>
              ) : (
                <ChartRenderer type={chart.type} data={data} chartId={chart.id} />
              )}
            </div>
            <div className="mt-2">
              <span className="rounded-full bg-bg-elevated px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.18em] text-text-muted">
                {chart.type}
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
          const metric = (chart.queryConfig.metric as string) ?? "revenue";
          const grouping = (chart.queryConfig.grouping as string) ?? "month";
          try {
            const res = await agent.getMetrics(metric, grouping);
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
            Click a dashboard to expand charts. Use the Agent to generate or refine new ones.
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
            <Sparkles className="size-4" /> Open Agent
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
              detail="Create dashboards from the Agent to build your board pack library."
              action={
                <Button size="sm" onClick={() => router.push("/dashboard/agent")}>
                  <Sparkles className="size-4" /> Open Agent
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
                          title="Continue editing in Agent"
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
                          Edit in Agent
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
