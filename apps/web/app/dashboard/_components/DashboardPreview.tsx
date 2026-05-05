"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Maximize2, X } from "lucide-react";
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
} from "recharts";
import { ApiError } from "../../../lib/api";
import { useNumeriquApi } from "../../../lib/useNumeriquApi";
import { EmptyState } from "../../../components/ui/EmptyState";
import { ErrorBanner } from "../../../components/ui/ErrorBanner";
import { Skeleton } from "../../../components/ui/Skeleton";

interface ChartConfig {
  metric: string;
  grouping: string;
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

const COLORS = ["#3b82f6", "#7c3aed", "#06b6d4", "#14b8a6", "#f59e0b"];

export function DashboardPreview({ triggerSync }: { triggerSync: number }) {
  const { agent, loading } = useNumeriquApi();
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [chartData, setChartData] = useState<Record<string, Array<Record<string, unknown>>>>({});
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
          const cleanCharts: Chart[] = (latest.charts ?? []).map((chart) => ({
            id: chart.id,
            title: chart.title,
            description: chart.description ?? null,
            type: chart.type,
            config: chart.config,
            layoutIndex: chart.layoutIndex,
          }));
          const cleanDashboard: Dashboard = {
            id: latest.id,
            title: latest.title,
            description: latest.description ?? null,
            charts: cleanCharts,
          };
          setDashboard(cleanDashboard);
          const dataMap: Record<string, Array<Record<string, unknown>>> = {};
          await Promise.all(
            cleanCharts.map(async (chart) => {
              try {
                const res = await agent.getMetrics(chart.config.metric, chart.config.grouping);
                dataMap[chart.id] = res.data ?? [];
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
            ? caught.toUserMessage("We could not load the latest dashboard.")
            : "We could not load the latest dashboard.";
        setError(message);
      } finally {
        setIsLoading(false);
      }
    };

    void fetchDashboard();
  }, [agent, loading, triggerSync]);

  const renderChart = (chart: Chart, isExpanded = false) => {
    const data = (chartData[chart.id] ?? []) as Array<Record<string, number | string>>;
    const chartPx = isExpanded ? 520 : 220;
    return (
      <div className="w-full min-w-0" style={{ height: chartPx }}>
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          {chart.type === "bar" ? (
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--color-text-muted) / 0.12)" />
              <XAxis dataKey="name" stroke="rgb(var(--color-text-muted))" fontSize={isExpanded ? 12 : 10} />
              <YAxis stroke="rgb(var(--color-text-muted))" fontSize={isExpanded ? 12 : 10} />
              <Tooltip
                contentStyle={{
                  backgroundColor: "rgb(var(--color-bg-card))",
                  border: "1px solid rgb(var(--color-text-muted) / 0.18)",
                  borderRadius: "8px",
                }}
                itemStyle={{ color: "rgb(var(--color-text-primary))" }}
                labelStyle={{ color: "rgb(var(--color-text-secondary))" }}
              />
              <Bar dataKey="value" fill="rgb(var(--color-accent-violet))" radius={[4, 4, 0, 0]} />
            </BarChart>
          ) : chart.type === "pie" ? (
            <PieChart>
              <Pie
                data={data}
                cx="50%"
                cy="50%"
                innerRadius={isExpanded ? 80 : 40}
                outerRadius={isExpanded ? 140 : 70}
                paddingAngle={5}
                dataKey="value"
              >
                {data.map((_, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} stroke="none" />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  backgroundColor: "rgb(var(--color-bg-card))",
                  border: "1px solid rgb(var(--color-text-muted) / 0.18)",
                  borderRadius: "8px",
                }}
              />
            </PieChart>
          ) : (
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--color-text-muted) / 0.12)" />
              <XAxis dataKey="name" stroke="rgb(var(--color-text-muted))" fontSize={isExpanded ? 12 : 10} />
              <YAxis stroke="rgb(var(--color-text-muted))" fontSize={isExpanded ? 12 : 10} />
              <Tooltip
                contentStyle={{
                  backgroundColor: "rgb(var(--color-bg-card))",
                  border: "1px solid rgb(var(--color-text-muted) / 0.18)",
                  borderRadius: "8px",
                }}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke="rgb(var(--color-accent-blue))"
                strokeWidth={isExpanded ? 3 : 2}
                dot={isExpanded}
              />
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    );
  };

  if (isLoading && !dashboard) {
    return (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {Array.from({ length: 4 }).map((_, idx) => (
          <Skeleton key={idx} height={300} rounded="xl" />
        ))}
      </div>
    );
  }

  if (error) {
    return <ErrorBanner title="Dashboard unavailable" tone="danger">{error}</ErrorBanner>;
  }

  if (!dashboard) {
    return (
      <EmptyState
        title="No live dashboard yet"
        detail="Send the agent a mission like “Generate a board pack from the last 30 days” to synthesize one."
      />
    );
  }

  const expandedChart = dashboard.charts.find((chart) => chart.id === expandedChartId);

  return (
    <div className="space-y-6">
      <div className="surface-card flex items-center justify-between gap-3 border-feedback-success/20 bg-feedback-success/5 p-4">
        <div>
          <h2 className="text-lg font-bold text-text-primary">{dashboard.title}</h2>
          <p className="text-xs text-text-muted">{dashboard.description || "Synthesized analytical view"}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 animate-pulse rounded-full bg-feedback-success" aria-hidden />
          <span className="text-[10px] font-bold uppercase tracking-widest text-feedback-success">
            Live sync intelligence
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 pb-12 md:grid-cols-2">
        {dashboard.charts.map((chart) => (
          <div
            key={chart.id}
            role="button"
            tabIndex={0}
            className="cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue rounded-3xl"
            onClick={() => setExpandedChartId(chart.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setExpandedChartId(chart.id);
              }
            }}
          >
            <div className="surface-card relative flex h-[320px] flex-col p-4 transition-all hover:border-feedback-success/40">
              <div className="absolute right-4 top-4 opacity-0 transition-opacity group-hover:opacity-100">
                <Maximize2 size={14} className="text-feedback-success" />
              </div>
              <div className="mb-4">
                <h3 className="text-sm font-semibold text-text-primary">{chart.title}</h3>
                <p className="text-[10px] uppercase tracking-wider text-text-muted">
                  {chart.type} · {chart.config.metric}
                </p>
              </div>
              <div className="min-h-0 w-full flex-1 pointer-events-none">{renderChart(chart)}</div>
            </div>
          </div>
        ))}
      </div>

      <AnimatePresence>
        {expandedChart && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/80 backdrop-blur-xl"
              onClick={() => setExpandedChartId(null)}
            />
            <motion.div
              layoutId={expandedChart.id}
              initial={{ scale: 0.94, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.94, opacity: 0 }}
              className="surface-card relative flex h-[80vh] w-full max-w-5xl flex-col p-8"
            >
              <button
                onClick={() => setExpandedChartId(null)}
                className="absolute right-6 top-6 rounded-full bg-bg-elevated p-2 text-text-muted transition-colors hover:bg-bg-elevated/80 hover:text-text-primary"
                aria-label="Close detail view"
              >
                <X size={20} />
              </button>

              <div className="mb-8">
                <h2 className="mb-2 text-2xl font-bold text-text-primary">{expandedChart.title}</h2>
                <p className="text-sm text-text-muted">
                  {expandedChart.description ||
                    `Tactical analysis of ${expandedChart.config.metric} grouped by ${expandedChart.config.grouping}.`}
                </p>
              </div>

              <div className="min-h-0 w-full flex-1 rounded-2xl border border-default bg-bg-elevated/40 p-6">
                {renderChart(expandedChart, true)}
              </div>

              <div className="mt-8 flex items-center justify-between text-[10px] font-bold uppercase tracking-[0.2em] text-text-muted">
                <span>Mission intelligence unit</span>
                <span>NumeriQ strategic layer</span>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
