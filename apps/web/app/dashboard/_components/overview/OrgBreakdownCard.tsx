"use client";

import type { DashboardResponse } from "../../../../lib/api";
import { formatMoneyWithCurrency, formatNumber } from "./format";

export function InvoiceStatusCard({
  dashboard,
  currency,
}: {
  dashboard: DashboardResponse;
  currency: string;
}) {
  const items = dashboard.charts.invoiceStatus.map((row) => ({
    name: row.name,
    count: row.count,
    amount: row.amount,
  }));

  const maxAmount = Math.max(...items.map((item) => Math.abs(item.amount)), 1);
  const totalOutstanding = Math.max(Math.abs(dashboard.kpis.openInvoiceAmount ?? 0), 0);
  const overdueAmount = Math.max(Math.abs(dashboard.kpis.overdueAmount ?? 0), 0);
  const overdueShare = totalOutstanding > 0 ? overdueAmount / totalOutstanding : 0;
  const topBucket = items.reduce<(typeof items)[number] | null>(
    (highest, item) => (!highest || Math.abs(item.amount) > Math.abs(highest.amount) ? item : highest),
    null,
  );

  return (
    <div className="dashboard-focus-card h-full p-5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#7ecaff]">
        Receivables exposure
      </p>
      <h2 className="mt-2 font-display text-[1.45rem] font-bold text-white md:text-[1.55rem]">
        Where open balances are aging
      </h2>

      <div className="mt-4">
        {items.length === 0 ? (
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-[1rem] border border-white/10 bg-white/[0.04] p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#86a7d0]">Open balance</p>
              <p className="mt-2 text-2xl font-bold text-white">{formatMoneyWithCurrency(dashboard.kpis.openInvoiceAmount, currency)}</p>
              <p className="mt-1 text-sm text-[#b8c8e4]">{formatNumber(dashboard.kpis.openInvoiceCount ?? 0)} invoices still open</p>
            </div>
            <div className="rounded-[1rem] border border-dashed border-white/10 px-4 py-5 text-sm text-[#a8bfdf]">
              No status buckets yet. Once invoice aging is available, this card will split healthy receivables from overdue exposure.
            </div>
          </div>
        ) : (
          <div className="flex h-full flex-col justify-between">
            <div className="space-y-3.5">
              {items.map((item) => (
                <div key={item.name}>
                  <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-white">{item.name}</p>
                      <p className="text-[#9db4d8]">{formatNumber(item.count)} invoices</p>
                    </div>
                    <span className="font-mono text-[#8ad7ff]">{formatMoneyWithCurrency(item.amount, currency)}</span>
                  </div>
                  <div className="h-2 rounded-full bg-white/[0.06]">
                    <div
                      className="h-2 rounded-full bg-gradient-to-r from-[#00c7d2] to-[#4f8cff]"
                      style={{ width: `${Math.max(6, (Math.abs(item.amount) / maxAmount) * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-5 grid gap-3 border-t border-white/8 pt-4 md:grid-cols-3">
              <div className="rounded-[1rem] border border-white/8 bg-white/[0.03] p-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#86a7d0]">Overdue share</p>
                <p className="mt-1 text-lg font-bold text-white">{(overdueShare * 100).toFixed(1)}%</p>
                <p className="text-xs text-[#9db4d8]">{formatMoneyWithCurrency(overdueAmount, currency)} at risk</p>
              </div>
              <div className="rounded-[1rem] border border-white/8 bg-white/[0.03] p-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#86a7d0]">Largest bucket</p>
                <p className="mt-1 text-lg font-bold text-white">{topBucket?.name ?? "—"}</p>
                <p className="text-xs text-[#9db4d8]">{formatMoneyWithCurrency(topBucket?.amount ?? 0, currency)}</p>
              </div>
              <div className="rounded-[1rem] border border-white/8 bg-white/[0.03] p-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#86a7d0]">Invoices in play</p>
                <p className="mt-1 text-lg font-bold text-white">{formatNumber(dashboard.kpis.openInvoiceCount ?? 0)}</p>
                <p className="text-xs text-[#9db4d8]">Across all open aging buckets</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
