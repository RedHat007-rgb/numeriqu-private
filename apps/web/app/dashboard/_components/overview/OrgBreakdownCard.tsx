"use client";

import type { DashboardResponse } from "../../../../lib/api";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { formatMoney } from "./format";

function Bars({
  items,
}: {
  items: Array<{ name: string; value: number; provider?: string }>;
}) {
  const max = Math.max(...items.map((item) => Math.abs(item.value)), 1);
  return (
    <div className="space-y-3.5">
      {items.map((item) => (
        <div key={item.name}>
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <div className="min-w-0">
              <p className="truncate font-medium text-text-primary">{item.name}</p>
              {item.provider ? (
                <p className="text-text-muted">{item.provider}</p>
              ) : null}
            </div>
            <span className="font-mono text-accent-cyan">{formatMoney(item.value)}</span>
          </div>
          <div className="h-2 rounded-full bg-bg-elevated/60">
            <div
              className="h-2 rounded-full bg-gradient-to-r from-accent-blue to-accent-cyan"
              style={{ width: `${Math.max(6, (Math.abs(item.value) / max) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export function OrgBreakdownCard({ dashboard }: { dashboard: DashboardResponse }) {
  // Use real grouping by org. Fall back to charts.orgBreakdown if connectedOrgs is empty.
  const items = dashboard.charts.orgBreakdown.map((row) => ({
    name: row.name,
    value: row.value,
    provider: row.provider,
  }));

  return (
    <div className="surface-card p-6">
      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent-cyan">
        Revenue by entity
      </p>
      <h2 className="mt-2 font-display text-xl font-bold text-text-primary md:text-2xl">
        Where revenue is concentrated
      </h2>

      <div className="mt-6">
        {items.length === 0 ? (
          <EmptyState
            title="No revenue breakdown yet"
            detail="Connect a finance source to populate per-entity revenue."
          />
        ) : (
          <Bars items={items} />
        )}
      </div>
    </div>
  );
}
