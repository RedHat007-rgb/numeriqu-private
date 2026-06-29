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
import { formatMoneyWithCurrency, formatMoneyWithCurrencyFull, formatRelativeTime } from "./format";

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
    <div className="dashboard-surface h-full p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-accent-blue">
            Cash flow
          </p>
          <h2 className="mt-1.5 font-display text-xl font-bold text-text-primary md:text-[1.45rem]">
            Spend, runway, and net position
          </h2>
        </div>
        <p className="text-xs text-text-muted">Last computed {computedAt}</p>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-text-muted">
        <span className="inline-flex items-center gap-2">
          <span className="h-1.5 w-4 rounded bg-feedback-danger" /> Spend
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="h-1.5 w-4 rounded bg-feedback-success" /> Revenue
        </span>
        <span>
          Current spend: <span className="font-semibold text-text-primary">{formatMoneyWithCurrency(latestSpend, currency)}</span>
        </span>
        <span>
          Overdue exposure: <span className="font-semibold text-text-primary">{formatMoneyWithCurrency(latestOverdue, currency)}</span>
        </span>
      </div>

      <div className="mt-4 h-52">
        {series.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center rounded-2xl border border-dashed border-default px-5 text-center text-sm text-text-muted">
            <p className="font-medium text-text-secondary">No cash flow history yet</p>
            <p className="mt-1 max-w-md">Connect a source and sync at least one period to see spend, revenue, and net position move together.</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--color-text-muted) / 0.12)" />
              <XAxis dataKey="name" tick={{ fill: "rgb(var(--color-text-muted))", fontSize: 11 }} />
              <YAxis
                tick={{ fill: "rgb(var(--color-text-muted))", fontSize: 11 }}
                tickFormatter={(value) => formatMoneyWithCurrencyFull(Number(value), currency)}
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
