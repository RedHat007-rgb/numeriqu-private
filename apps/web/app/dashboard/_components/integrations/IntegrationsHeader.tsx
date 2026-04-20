"use client";

import { cardClass } from "../ui";

export function IntegrationsHeader({
  isLoading,
  onConnectXero,
  onConnectQuickbooks,
  onSyncAll,
  onRefresh,
}: {
  isLoading: boolean;
  onConnectXero: () => void;
  onConnectQuickbooks: () => void;
  onSyncAll: () => void;
  onRefresh: () => void;
}) {
  return (
    <section className={cardClass()}>
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-300">Data Plane</p>
          <h2 className="mt-2 font-display text-2xl font-bold text-white">Integrations and syncs</h2>
          <p className="mt-2 text-sm text-slate-400">
            OAuth connect creates a connection record, then sync jobs hydrate analytics.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <button
            onClick={onConnectXero}
            className="rounded-full border border-blue-400/40 px-4 py-2 text-sm text-blue-100 hover:bg-blue-500/10"
          >
            Connect Xero
          </button>
          <button
            onClick={onConnectQuickbooks}
            className="rounded-full border border-cyan-400/40 px-4 py-2 text-sm text-cyan-100 hover:bg-cyan-500/10"
          >
            Connect QuickBooks
          </button>
          <button onClick={onSyncAll} className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-100">
            Sync all
          </button>
          <button onClick={onRefresh} className="rounded-full border border-white/15 px-4 py-2 text-sm text-white hover:bg-white/10">
            {isLoading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>
    </section>
  );
}

