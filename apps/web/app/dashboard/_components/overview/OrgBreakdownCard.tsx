"use client";

import { useMemo } from "react";
import type { DashboardResponse } from "../../../../lib/api";
import { cardClass, EmptyState } from "../ui";
import { formatMoney } from "./format";

function Bars({ items }: { items: Array<{ name: string; value: number }> }) {
  const max = Math.max(...items.map((item) => Math.abs(item.value)), 1);
  return (
    <div className="space-y-4">
      {items.length === 0 ? (
        <EmptyState title="No chart data yet" detail="Connect a finance source, then run a sync." />
      ) : (
        items.map((item) => (
          <div key={item.name}>
            <div className="mb-2 flex items-center justify-between text-xs text-slate-300">
              <span>{item.name}</span>
              <span className="font-mono text-cyan-300">{formatMoney(item.value)}</span>
            </div>
            <div className="h-2 rounded-full bg-white/10">
              <div
                className="h-2 rounded-full bg-gradient-to-r from-cyan-400 to-blue-500"
                style={{ width: `${Math.max(6, (Math.abs(item.value) / max) * 100)}%` }}
              />
            </div>
          </div>
        ))
      )}
    </div>
  );
}

export function OrgBreakdownCard({ dashboard }: { dashboard: DashboardResponse }) {
  const orgBars = useMemo(
    () => dashboard.charts.orgBreakdown.map((item) => ({ name: item.name, value: item.value })),
    [dashboard],
  );

  return (
    <div className={cardClass()}>
      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-300">Revenue by org</p>
      <h2 className="mt-2 font-display text-2xl font-bold">Connected companies</h2>
      <div className="mt-6">
        <Bars items={orgBars} />
      </div>
    </div>
  );
}

