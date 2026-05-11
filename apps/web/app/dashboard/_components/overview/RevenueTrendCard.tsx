"use client";

import { useMemo } from "react";
import type { DashboardResponse } from "../../../../lib/api";
import { formatMoney, formatRelativeTime } from "./format";

function MiniTrendChart({
  series,
}: {
  series: Array<{ label: string; revenue: number }>;
}) {
  const width = 540;
  const height = 200;

  const safe = series.length > 0 ? series : [{ label: "—", revenue: 0 }];
  const allValues = safe.flatMap((row) => [row.revenue]);
  const min = Math.min(...allValues, 0);
  const max = Math.max(...allValues, 1);
  const range = max - min || 1;

  function project(values: number[]) {
    if (values.length === 0) return [];
    const denominator = Math.max(values.length - 1, 1);
    return values.map((value, index) => ({
      x: (index / denominator) * width,
      y: height - ((value - min) / range) * (height - 24) - 12,
    }));
  }

  const revPoints = project(safe.map((row) => row.revenue));

  function buildPath(points: { x: number; y: number }[]) {
    if (points.length === 0) return "";
    return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
  }

  function buildArea(points: { x: number; y: number }[]) {
    if (points.length === 0) return "";
    return `${buildPath(points)} L ${width} ${height} L 0 ${height} Z`;
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-56 w-full overflow-visible"
      role="img"
      aria-label="Revenue trend"
    >
      <defs>
        <linearGradient id="revArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgb(var(--color-accent-blue))" stopOpacity="0.32" />
          <stop offset="100%" stopColor="rgb(var(--color-accent-blue))" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={buildArea(revPoints)} fill="url(#revArea)" />
      <path
        d={buildPath(revPoints)}
        fill="none"
        stroke="rgb(var(--color-accent-blue))"
        strokeWidth="3"
        strokeLinecap="round"
      />
      {revPoints.map((point) => (
        <circle key={`r-${point.x}-${point.y}`} cx={point.x} cy={point.y} r="3.5" fill="rgb(var(--color-accent-blue))" />
      ))}
    </svg>
  );
}

export function RevenueTrendCard({ dashboard }: { dashboard: DashboardResponse }) {
  const series = useMemo(
    () =>
      dashboard.charts.monthlyTrend.map((row) => ({
        label: row.month ?? row.name,
        revenue: row.revenue,
      })),
    [dashboard],
  );

  const latest = series[series.length - 1];
  const computedAt = formatRelativeTime(dashboard.meta.computedAt);

  return (
    <div className="surface-card p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent-blue">
            Revenue
          </p>
          <h2 className="mt-2 font-display text-xl font-bold text-text-primary md:text-2xl">
            Monthly performance
          </h2>
        </div>
        <p className="text-xs text-text-muted">Last computed {computedAt}</p>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-text-muted">
        <span className="inline-flex items-center gap-2">
          <span className="h-1.5 w-4 rounded bg-accent-blue" /> Revenue
        </span>
        {latest ? (
          <span>
            Latest month:{" "}
            <span className="font-semibold text-text-primary">{formatMoney(latest.revenue)}</span>{" "}
            revenue
          </span>
        ) : null}
      </div>

      <div className="mt-4">
        {series.length === 0 ? (
          <div className="flex h-56 flex-col items-center justify-center rounded-2xl border border-dashed border-default text-sm text-text-muted">
            <p className="font-medium text-text-secondary">No trend yet</p>
            <p>Connect a finance source and run a sync to see your trend.</p>
          </div>
        ) : (
          <MiniTrendChart series={series} />
        )}
      </div>
    </div>
  );
}
