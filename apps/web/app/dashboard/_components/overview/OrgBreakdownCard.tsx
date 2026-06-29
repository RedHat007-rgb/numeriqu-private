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

  return (
    <div className="dashboard-surface h-full p-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-accent-cyan">
        Spend exposure
      </p>
      <h2 className="mt-1.5 font-display text-xl font-bold text-text-primary md:text-[1.45rem]">
        Invoice status by amount
      </h2>

      <div className="mt-4">
        {items.length === 0 ? (
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-default bg-bg-elevated/25 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-muted">Open balance</p>
              <p className="mt-2 text-2xl font-bold text-text-primary">{formatMoneyWithCurrency(dashboard.kpis.openInvoiceAmount, currency)}</p>
              <p className="mt-1 text-sm text-text-muted">{formatNumber(dashboard.kpis.openInvoiceCount ?? 0)} invoices still open</p>
            </div>
            <div className="rounded-lg border border-dashed border-default px-4 py-5 text-sm text-text-muted">
              No status buckets yet. Once invoice aging is available, this card will split healthy receivables from overdue exposure.
            </div>
          </div>
        ) : (
          <div className="space-y-3.5">
            {items.map((item) => (
              <div key={item.name}>
                <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-text-primary">{item.name}</p>
                    <p className="text-text-muted">{formatNumber(item.count)} invoices</p>
                  </div>
                  <span className="font-mono text-accent-cyan">{formatMoneyWithCurrency(item.amount, currency)}</span>
                </div>
                <div className="h-2 rounded-full bg-bg-elevated/60">
                  <div
                    className="h-2 rounded-full bg-gradient-to-r from-accent-cyan to-accent-blue"
                    style={{ width: `${Math.max(6, (Math.abs(item.amount) / maxAmount) * 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
