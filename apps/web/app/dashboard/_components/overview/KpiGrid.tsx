"use client";

import type { DashboardResponse } from "../../../../lib/api";
import { formatMoney, formatNumber } from "./format";
import { StatCard } from "./StatCard";

export function KpiGrid({ kpis, venture }: { kpis: DashboardResponse["kpis"]; venture: DashboardResponse["venture"] }) {
  return (
    <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <StatCard label="Revenue" value={formatMoney(kpis.totalRevenue)} detail={`${formatNumber(kpis.totalInvoices)} invoices`} />
      <StatCard label="Net Profit" value={formatMoney(kpis.netProfit)} detail={`${kpis.profitMargin.toFixed(1)}% margin`} />
      <StatCard label="Runway" value={`${venture.runwayMonths.toFixed(1)} mo`} detail={`${formatMoney(venture.burnRate)} burn`} />
      <StatCard label="Connections" value={String(kpis.orgCount)} detail={`${kpis.providerCount} providers online`} />
    </section>
  );
}

