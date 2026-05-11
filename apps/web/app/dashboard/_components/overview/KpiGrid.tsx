"use client";

import type { DashboardResponse } from "../../../../lib/api";
import { formatMoney, formatNumber, formatPercentDelta } from "./format";
import { StatCard } from "./StatCard";

type Tone = "neutral" | "positive" | "negative";

function trendDelta(current: number, previous: number): { value: string; tone: Tone } | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) {
    if (current === 0) return null;
    return { value: "new", tone: current > 0 ? "positive" : "negative" };
  }
  const ratio = (current - previous) / Math.abs(previous);
  return {
    value: formatPercentDelta(ratio),
    tone: ratio > 0 ? "positive" : ratio < 0 ? "negative" : "neutral",
  };
}

type Props = {
  kpis: DashboardResponse["kpis"];
  venture: DashboardResponse["venture"];
  charts: DashboardResponse["charts"];
};

export function KpiGrid({ kpis, venture, charts }: Props) {
  const trend = charts.monthlyTrend ?? [];
  const last = trend[trend.length - 1];
  const prev = trend[trend.length - 2];

  const revenueDelta = last && prev ? trendDelta(last.revenue, prev.revenue) : null;
  const invoicesDelta = last && prev ? trendDelta(last.invoices, prev.invoices) : null;

  const openInvoiceAmount = kpis.openInvoiceAmount ?? kpis.totalExpenses ?? 0;
  const openInvoiceCount = kpis.openInvoiceCount ?? 0;
  const openTone: Tone = openInvoiceAmount > 0 ? "neutral" : "positive";
  const overdueTone: Tone = kpis.overdueAmount > 0 ? "negative" : "positive";

  return (
    <section
      aria-label="Key performance indicators"
      className="grid gap-4 lg:grid-cols-12"
    >
      <StatCard
        className="lg:col-span-6"
        label="Total Revenue"
        value={formatMoney(kpis.totalRevenue)}
        detail={`${formatNumber(kpis.totalInvoices)} invoices · avg ${formatMoney(
          kpis.avgInvoiceValue,
        )}`}
        delta={revenueDelta}
        emphasis="primary"
      />

      <StatCard
        className="lg:col-span-3"
        label="Open Invoices"
        value={formatMoney(openInvoiceAmount)}
        detail={`${formatNumber(openInvoiceCount)} open · ${formatMoney(kpis.overdueAmount)} overdue`}
        delta={
          openInvoiceAmount === 0 ? { value: "clear", tone: "positive" } : { value: "monitor", tone: openTone }
        }
      />

      <StatCard
        className="lg:col-span-3"
        label="Cash Runway"
        value={`${venture.runwayMonths.toFixed(1)} mo`}
        detail={`${formatMoney(venture.burnRate)} monthly burn`}
        delta={
          venture.runwayMonths === 0
            ? null
            : {
                value: venture.runwayMonths >= 12 ? "healthy" : venture.runwayMonths >= 6 ? "watch" : "tight",
                tone: venture.runwayMonths >= 12 ? "positive" : venture.runwayMonths >= 6 ? "neutral" : "negative",
              }
        }
      />

      <StatCard
        className="lg:col-span-3"
        label="Cash on Hand"
        value={formatMoney(venture.cashOnHand)}
        detail={`${kpis.orgCount} connected entities`}
      />

      <StatCard
        className="lg:col-span-3"
        label="Overdue"
        value={formatMoney(kpis.overdueAmount)}
        detail={`${formatNumber(kpis.overdueCount)} invoices past due`}
        delta={
          kpis.overdueAmount > 0
            ? { value: "needs follow-up", tone: overdueTone }
            : { value: "clean", tone: "positive" }
        }
      />

      <StatCard
        className="lg:col-span-3"
        label="Invoices"
        value={formatNumber(last?.invoices ?? kpis.totalInvoices)}
        detail={`${kpis.providerCount} providers online`}
        delta={invoicesDelta}
      />

      <StatCard
        className="lg:col-span-3"
        label="Avg invoice"
        value={formatMoney(kpis.avgInvoiceValue)}
        detail="Across the selected scope"
      />
    </section>
  );
}
