"use client";

import { useMemo } from "react";
import type { DashboardResponse } from "../../../../lib/api";
import { cardClass } from "../ui";

function MiniLineChart({ data }: { data: number[] }) {
  const width = 520;
  const height = 180;
  const safeData = data.length > 0 ? data : [0, 0, 0, 0];
  const min = Math.min(...safeData);
  const max = Math.max(...safeData);
  const range = max - min || 1;
  const points = safeData.map((value, index) => {
    const denominator = Math.max(safeData.length - 1, 1);
    return {
      x: (index / denominator) * width,
      y: height - ((value - min) / range) * (height - 20) - 10,
    };
  });

  const line = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
  const area = `${line} L ${width} ${height} L 0 ${height} Z`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-48 w-full overflow-visible">
      <defs>
        <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#7c3aed" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#trendFill)" />
      <path d={line} fill="none" stroke="#38bdf8" strokeWidth="4" strokeLinecap="round" />
      {points.map((point) => (
        <circle key={`${point.x}-${point.y}`} cx={point.x} cy={point.y} r="4" fill="#e0f2fe" />
      ))}
    </svg>
  );
}

export function RevenueTrendCard({ dashboard }: { dashboard: DashboardResponse }) {
  const trendData = useMemo(() => dashboard.charts.monthlyTrend.map((item) => item.revenue), [dashboard]);

  return (
    <div className={cardClass()}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-blue-300">Revenue Trend</p>
          <h2 className="mt-2 font-display text-2xl font-bold">Monthly performance</h2>
        </div>
        <p className="text-sm text-slate-400">API latency {dashboard.meta.latencyMs}ms</p>
      </div>
      <div className="mt-6">
        <MiniLineChart data={trendData} />
      </div>
    </div>
  );
}

