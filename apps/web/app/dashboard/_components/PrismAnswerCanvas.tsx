"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Calculator, Maximize2, Table2, X } from "lucide-react";
import type {
  PrismAnswerEnvelope,
  PrismScenarioResult,
} from "../../../lib/api/types";

const SERIES_COLORS = [
  "rgb(var(--color-accent-blue))",
  "rgb(var(--color-accent-cyan))",
  "rgb(var(--color-accent-violet))",
];
const CHART_LAYOUT = {
  minimumTickCount: 4,
  minimumTickWidth: 88,
  pointLabelRowLimit: 12,
} as const;

function compactTick(value: unknown): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value ?? "");
  return new Intl.NumberFormat(undefined, {
    notation: Math.abs(numeric) >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(numeric);
}

function dimensionTick(value: unknown): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
    if (Number.isFinite(date.getTime())) {
      return new Intl.DateTimeFormat(undefined, {
        month: "short",
        year: "2-digit",
        timeZone: "UTC",
      }).format(date);
    }
  }
  return String(value ?? "");
}

type PrismSeries = NonNullable<
  PrismAnswerEnvelope["visualization"]
>["series"][number];

function formatChartValue(
  value: unknown,
  series?: PrismSeries,
  fractionDigits = 2,
): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value ?? "—");
  if (series?.unit === "percent") return `${compactTick(numeric)}%`;
  if (series?.unit === "currency" && series.currency) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: series.currency,
        notation: Math.abs(numeric) >= 10_000 ? "compact" : "standard",
        maximumFractionDigits: fractionDigits,
      }).format(numeric);
    } catch {
      return `${series.currency} ${compactTick(numeric)}`;
    }
  }
  return compactTick(numeric);
}

function ChartView({
  answer,
  expanded = false,
}: {
  answer: PrismAnswerEnvelope;
  expanded?: boolean;
}) {
  const visualization = answer.visualization;
  const chartRef = useRef<HTMLDivElement>(null);
  const [chartWidth, setChartWidth] = useState(0);
  useEffect(() => {
    const node = chartRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      setChartWidth(entry?.contentRect.width ?? 0);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const dimensionKey = useMemo(() => {
    if (!visualization?.rows[0]) return "name";
    const series = new Set(visualization.series.map((item) => item.key));
    return (
      Object.keys(visualization.rows[0]).find((key) => !series.has(key)) ??
      "name"
    );
  }, [visualization]);
  if (!visualization || visualization.kind === "table") return null;
  const showLabels =
    visualization.rows.length <= CHART_LAYOUT.pointLabelRowLimit;
  const maxXTicks = Math.max(
    CHART_LAYOUT.minimumTickCount,
    Math.floor(chartWidth / CHART_LAYOUT.minimumTickWidth),
  );
  const xInterval = Math.max(
    0,
    Math.ceil(visualization.rows.length / maxXTicks) - 1,
  );
  const primarySeries = visualization.series[0];
  const seriesFor = (name: unknown) =>
    visualization.series.find(
      (item) => item.key === name || item.label === name,
    );
  const common = {
    data: visualization.rows,
    margin: { top: 28, right: 24, left: 20, bottom: 52 },
  };

  return (
    <div
      role="img"
      ref={chartRef}
      aria-label={`${visualization.title}. An accessible data table follows the chart.`}
      className={
        expanded ? "h-full min-w-0 w-full" : "h-[320px] min-w-0 w-full"
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        {visualization.kind === "line" ? (
          <LineChart {...common}>
            <CartesianGrid stroke="rgb(var(--color-border-default) / 0.1)" />
            <XAxis
              dataKey={dimensionKey}
              tickFormatter={dimensionTick}
              tick={{ fill: "rgb(var(--color-text-muted))", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              interval={xInterval}
              angle={visualization.rows.length > 8 ? -30 : 0}
              textAnchor={visualization.rows.length > 8 ? "end" : "middle"}
              height={54}
            />
            <YAxis
              width={76}
              tickFormatter={(value) =>
                formatChartValue(value, primarySeries, 1)
              }
              tick={{ fill: "rgb(var(--color-text-muted))", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              labelFormatter={dimensionTick}
              formatter={(value, name) => [
                formatChartValue(value, seriesFor(name)),
                String(name),
              ]}
              contentStyle={{
                background: "rgb(var(--color-bg-surface))",
                border: "1px solid rgb(var(--color-border-default) / 0.2)",
                borderRadius: 12,
              }}
            />
            {visualization.series.map((series, index) => (
              <Line
                key={series.key}
                dataKey={series.key}
                name={series.label}
                stroke={SERIES_COLORS[index % SERIES_COLORS.length]}
                strokeWidth={2.5}
                isAnimationActive={false}
                dot={{ r: 3 }}
                activeDot={{ r: 5 }}
              >
                {showLabels ? (
                  <LabelList
                    dataKey={series.key}
                    position="top"
                    formatter={(value: unknown) =>
                      formatChartValue(value, series)
                    }
                    fill="rgb(var(--color-text-secondary))"
                    fontSize={10}
                  />
                ) : null}
              </Line>
            ))}
          </LineChart>
        ) : (
          <BarChart {...common} barCategoryGap="22%">
            <CartesianGrid
              vertical={false}
              stroke="rgb(var(--color-border-default) / 0.1)"
            />
            <XAxis
              dataKey={dimensionKey}
              tickFormatter={dimensionTick}
              tick={{ fill: "rgb(var(--color-text-muted))", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              interval={xInterval}
              angle={visualization.rows.length > 8 ? -30 : 0}
              textAnchor={visualization.rows.length > 8 ? "end" : "middle"}
              height={54}
            />
            <YAxis
              width={76}
              tickFormatter={(value) =>
                formatChartValue(value, primarySeries, 1)
              }
              tick={{ fill: "rgb(var(--color-text-muted))", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              labelFormatter={dimensionTick}
              formatter={(value, name) => [
                formatChartValue(value, seriesFor(name)),
                String(name),
              ]}
              contentStyle={{
                background: "rgb(var(--color-bg-surface))",
                border: "1px solid rgb(var(--color-border-default) / 0.2)",
                borderRadius: 12,
              }}
            />
            {visualization.series.map((series, index) => (
              <Bar
                key={series.key}
                dataKey={series.key}
                name={series.label}
                fill={SERIES_COLORS[index % SERIES_COLORS.length]}
                radius={[5, 5, 0, 0]}
                isAnimationActive={false}
              >
                {showLabels ? (
                  <LabelList
                    dataKey={series.key}
                    position="top"
                    formatter={(value: unknown) =>
                      formatChartValue(value, series)
                    }
                    fill="rgb(var(--color-text-secondary))"
                    fontSize={10}
                  />
                ) : null}
              </Bar>
            ))}
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

function DataTable({ answer }: { answer: PrismAnswerEnvelope }) {
  const visualization = answer.visualization;
  if (!visualization?.rows.length) return null;
  const columns = Object.keys(visualization.rows[0]!);
  const seriesByKey = new Map(
    visualization.series.map((series) => [series.key, series]),
  );
  const dimensionKey = columns.find((column) => !seriesByKey.has(column));
  return (
    <div className="max-h-80 overflow-auto rounded-xl border border-default">
      <table className="w-full border-collapse text-left text-xs tabular-nums">
        <caption className="sr-only">{visualization.title} data</caption>
        <thead className="sticky top-0 bg-bg-surface">
          <tr>
            {columns.map((column) => (
              <th
                key={column}
                scope="col"
                className="border-b border-default px-3 py-2 font-semibold text-text-secondary"
              >
                {seriesByKey.get(column)?.label ??
                  (column === dimensionKey
                    ? visualization.dimensionLabel
                    : column.replaceAll("_", " "))}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visualization.rows.map((row, index) => (
            <tr
              key={index}
              className="border-b border-default/60 last:border-0"
            >
              {columns.map((column) => (
                <td
                  key={column}
                  className="whitespace-nowrap px-3 py-2 text-text-primary"
                >
                  {typeof row[column] === "number"
                    ? formatChartValue(row[column], seriesByKey.get(column))
                    : String(row[column] ?? "—")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PrismAnswerCanvas({
  answer,
  onAction,
  onEvaluateScenario,
}: {
  answer: PrismAnswerEnvelope;
  onAction: (action: PrismAnswerEnvelope["actions"][number]) => void;
  onEvaluateScenario?: (input: {
    baseline: string;
    unit: "currency" | "percent" | "number";
    currency?: string;
    assumptions: Array<{ label: string; basisPoints: number }>;
  }) => Promise<PrismScenarioResult>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showScenario, setShowScenario] = useState(false);
  const [scenarioMetricKey, setScenarioMetricKey] = useState(
    answer.metrics.find((metric) => metric.value !== null)?.key ?? "",
  );
  const [scenarioLabel, setScenarioLabel] = useState("");
  const [scenarioPercent, setScenarioPercent] = useState("");
  const [scenarioResult, setScenarioResult] =
    useState<PrismScenarioResult | null>(null);
  const [scenarioError, setScenarioError] = useState<string | null>(null);
  const [scenarioLoading, setScenarioLoading] = useState(false);
  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded]);
  const scenarioMetric = answer.metrics.find(
    (metric) => metric.key === scenarioMetricKey,
  );

  async function evaluateScenario() {
    const percent = Number(scenarioPercent);
    if (
      !onEvaluateScenario ||
      !scenarioMetric ||
      scenarioMetric.value === null ||
      !scenarioLabel.trim() ||
      !Number.isFinite(percent)
    ) {
      setScenarioError(
        "Select a verified metric and enter a valid assumption.",
      );
      return;
    }
    setScenarioLoading(true);
    setScenarioError(null);
    try {
      setScenarioResult(
        await onEvaluateScenario({
          baseline: String(scenarioMetric.value),
          unit:
            scenarioMetric.unit === "currency" ||
            scenarioMetric.unit === "percent"
              ? scenarioMetric.unit
              : "number",
          ...(scenarioMetric.currency
            ? { currency: scenarioMetric.currency }
            : {}),
          assumptions: [
            {
              label: scenarioLabel.trim(),
              basisPoints: Math.round(percent * 100),
            },
          ],
        }),
      );
    } catch (caught) {
      setScenarioError(
        caught instanceof Error
          ? caught.message
          : "Scenario calculation failed.",
      );
    } finally {
      setScenarioLoading(false);
    }
  }

  const content = (
    <section aria-label={answer.title} className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {answer.metrics.map((metric) => (
          <div
            key={metric.key}
            className="rounded-xl border border-default bg-bg-surface/60 p-3"
          >
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">
              {metric.label}
            </p>
            <p className="mt-1 text-xl font-bold tabular-nums text-text-primary">
              {metric.formattedValue}
            </p>
          </div>
        ))}
      </div>
      {answer.visualization ? (
        <div className="rounded-2xl border border-default bg-bg-surface/40 p-3 sm:p-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-text-primary">
              {answer.visualization.title}
            </h3>
            {answer.visualization.kind !== "table" ? (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                aria-label="Expand chart"
                className="flex h-10 w-10 items-center justify-center rounded-xl border border-default text-text-secondary hover:text-text-primary"
              >
                <Maximize2 size={15} />
              </button>
            ) : null}
          </div>
          {answer.visualization.kind === "table" ? (
            <DataTable answer={answer} />
          ) : (
            <ChartView answer={answer} />
          )}
          <details
            className="mt-2"
            hidden={answer.visualization.kind === "table"}
          >
            <summary className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-text-secondary">
              <Table2 size={14} /> View accessible data table
            </summary>
            <div className="mt-2">
              <DataTable answer={answer} />
            </div>
          </details>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {answer.actions.map((action) => (
          <button
            key={action.id}
            type="button"
            onClick={() => onAction(action)}
            className="min-h-10 rounded-xl border border-default bg-bg-surface/50 px-3 text-xs font-semibold text-text-secondary hover:border-accent-blue/40 hover:text-text-primary"
          >
            {action.label}
          </button>
        ))}
        {onEvaluateScenario &&
        answer.metrics.some((metric) => metric.value !== null) ? (
          <button
            type="button"
            onClick={() => setShowScenario((value) => !value)}
            className="flex min-h-10 items-center gap-2 rounded-xl border border-default bg-bg-surface/50 px-3 text-xs font-semibold text-text-secondary hover:border-accent-blue/40 hover:text-text-primary"
          >
            <Calculator size={14} /> Model scenario
          </button>
        ) : null}
      </div>
      {showScenario && scenarioMetric ? (
        <div className="space-y-3 rounded-2xl border border-default bg-bg-surface/40 p-4">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              Scenario sensitivity
            </h3>
            <p className="mt-1 text-xs text-text-muted">
              Uses the verified baseline and labels every change as your
              assumption.
            </p>
          </div>
          <div className="grid gap-2 md:grid-cols-[1fr_1fr_9rem_auto]">
            <label className="space-y-1 text-xs text-text-secondary">
              Metric
              <select
                value={scenarioMetricKey}
                onChange={(event) => setScenarioMetricKey(event.target.value)}
                className="min-h-11 w-full rounded-xl border border-default bg-bg-card px-3 text-text-primary"
              >
                {answer.metrics
                  .filter((metric) => metric.value !== null)
                  .map((metric) => (
                    <option key={metric.key} value={metric.key}>
                      {metric.label}
                    </option>
                  ))}
              </select>
            </label>
            <label className="space-y-1 text-xs text-text-secondary">
              Assumption
              <input
                value={scenarioLabel}
                onChange={(event) => setScenarioLabel(event.target.value)}
                placeholder="Price, volume, cost…"
                maxLength={120}
                className="min-h-11 w-full rounded-xl border border-default bg-bg-card px-3 text-text-primary"
              />
            </label>
            <label className="space-y-1 text-xs text-text-secondary">
              Change (%)
              <input
                type="number"
                step="0.01"
                value={scenarioPercent}
                onChange={(event) => setScenarioPercent(event.target.value)}
                className="min-h-11 w-full rounded-xl border border-default bg-bg-card px-3 text-right tabular-nums text-text-primary"
              />
            </label>
            <button
              type="button"
              disabled={scenarioLoading}
              onClick={evaluateScenario}
              className="min-h-11 self-end rounded-xl bg-accent-blue px-4 text-xs font-semibold text-white disabled:opacity-50"
            >
              {scenarioLoading ? "Calculating…" : "Calculate"}
            </button>
          </div>
          {scenarioError ? (
            <p role="alert" className="text-xs text-red-400">
              {scenarioError}
            </p>
          ) : null}
          {scenarioResult ? (
            <div aria-live="polite" className="grid gap-2 sm:grid-cols-3">
              {[
                ["Baseline", scenarioResult.baseline],
                ["Scenario", scenarioResult.result],
                ["Impact", scenarioResult.totalImpact],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="rounded-xl border border-default p-3"
                >
                  <p className="text-[10px] uppercase text-text-muted">
                    {label}
                  </p>
                  <p className="mt-1 font-semibold tabular-nums text-text-primary">
                    {formatChartValue(value, scenarioMetric)}
                  </p>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );

  return (
    <>
      {content}
      {expanded && answer.visualization ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Expanded chart: ${answer.visualization.title}`}
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/75 p-3 sm:p-8"
        >
          <div className="max-h-full w-full max-w-6xl overflow-auto rounded-3xl border border-default bg-bg-card p-4 shadow-2xl sm:p-6">
            <div className="mb-3 flex items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-bold text-text-primary">
                  {answer.visualization.title}
                </h2>
                <p className="text-xs text-text-muted">{answer.period}</p>
              </div>
              <button
                type="button"
                autoFocus
                onClick={() => setExpanded(false)}
                aria-label="Close expanded chart"
                className="flex h-11 w-11 items-center justify-center rounded-xl border border-default text-text-secondary"
              >
                <X size={17} />
              </button>
            </div>
            <div className="h-[min(58vh,620px)]">
              <ChartView answer={answer} expanded />
            </div>
            <details className="mt-4" open>
              <summary className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-text-secondary">
                <Table2 size={14} /> Data table
              </summary>
              <div className="mt-2">
                <DataTable answer={answer} />
              </div>
            </details>
          </div>
        </div>
      ) : null}
    </>
  );
}
