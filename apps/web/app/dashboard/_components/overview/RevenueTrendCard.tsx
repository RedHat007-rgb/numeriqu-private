"use client";

import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DashboardResponse } from "../../../../lib/api";
import { formatMoneyAxis, formatMoneyWithCurrency, formatMoneyWithCurrencyFull, formatRelativeTime } from "./format";

function CashflowTooltip({
  active,
  payload,
  currency,
}: {
  active?: boolean;
  payload?: Array<{ value?: number; payload?: { name?: string } }>;
  currency: string;
}) {
  if (!active || !payload?.length) return null;
  const item = payload[0];
  const value = Number(item?.value ?? 0);
  const label = item?.payload?.name ?? "Cash flow";

  return (
    <div className="rounded-xl border border-default bg-bg-card/95 px-3 py-2 shadow-2xl backdrop-blur-sm">
      <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-text-muted">{label}</p>
      <p className="mt-1 text-sm font-semibold text-text-primary">
        {formatMoneyWithCurrencyFull(value, currency)}
      </p>
    </div>
  );
}

export function CashflowCard({
  dashboard,
  currency,
}: {
  dashboard: DashboardResponse;
  currency: string;
}) {
  const series = useMemo(
    () =>
      dashboard.charts.cashflowWaterfall.map((row) => ({
        name: row.name,
        value: row.value,
        fill: row.fill,
      })),
    [dashboard],
  );

  const latestSpend = Math.abs(dashboard.kpis.totalExpenses ?? 0);
  const latestOverdue = Math.abs(dashboard.kpis.overdueAmount ?? 0);
  const computedAt = formatRelativeTime(dashboard.meta.computedAt);

  return (
    <div className="dashboard-focus-card h-full p-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#7ecaff]">
            Capital bridge
          </p>
          <h2 className="mt-2 font-display text-[1.45rem] font-bold text-white md:text-[1.55rem]">
            How revenue survives cost and payroll
          </h2>
        </div>
        <p className="text-xs text-[#8ea9d0]">Updated {computedAt}</p>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-[#a8bfdf]">
        <span className="inline-flex items-center gap-2">
          <span className="h-1.5 w-4 rounded bg-feedback-danger" /> Spend
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="h-1.5 w-4 rounded bg-feedback-success" /> Revenue
        </span>
        <span>
          Current spend: <span className="font-semibold text-white">{formatMoneyWithCurrency(latestSpend, currency)}</span>
        </span>
        <span>
          Overdue exposure: <span className="font-semibold text-white">{formatMoneyWithCurrency(latestOverdue, currency)}</span>
        </span>
      </div>

      <div className="mt-4 h-52">
        {series.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center rounded-[1.1rem] border border-dashed border-white/10 px-5 text-center text-sm text-[#a8bfdf]">
            <p className="font-medium text-white">No capital bridge yet</p>
            <p className="mt-1 max-w-md">Connect a source and sync at least one period to see spend, revenue, and net position move together.</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={series} margin={{ top: 8, right: 8, left: 12, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--color-text-muted) / 0.12)" />
              <XAxis dataKey="name" tick={{ fill: "rgb(var(--color-text-muted))", fontSize: 11 }} />
              <YAxis
                width={76}
                tick={{ fill: "rgb(var(--color-text-muted))", fontSize: 11 }}
                tickFormatter={(value) => formatMoneyAxis(Number(value), currency)}
              />
              <Tooltip content={<CashflowTooltip currency={currency} />} />
              <Bar dataKey="value" radius={[8, 8, 0, 0]}>
                {series.map((entry) => (
                  <Cell key={entry.name} fill={entry.fill ?? "rgb(var(--color-accent-blue))"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
