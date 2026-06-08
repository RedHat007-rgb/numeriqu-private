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
    <div className="surface-card p-6">
      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent-cyan">
        Spend exposure
      </p>
      <h2 className="mt-2 font-display text-xl font-bold text-text-primary md:text-2xl">
        Invoice status by amount
      </h2>

      <div className="mt-6">
        {items.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-default px-4 py-8 text-center text-sm text-text-muted">
            No invoice exposure data yet. Connect an accounting source to populate spend status.
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
