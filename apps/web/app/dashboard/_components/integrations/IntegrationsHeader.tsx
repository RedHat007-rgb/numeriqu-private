"use client";

import { Button } from "../../../../components/ui/Button";

type Props = {
  isLoading: boolean;
  actionInFlight: boolean;
  hasConnections: boolean;
  onConnectXero: () => void;
  onConnectQuickbooks: () => void;
  onSyncAll: () => void;
  onRefresh: () => void;
};

export function IntegrationsHeader({
  isLoading,
  actionInFlight,
  hasConnections,
  onConnectXero,
  onConnectQuickbooks,
  onSyncAll,
  onRefresh,
}: Props) {
  return (
    <section className="surface-card p-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent-blue">Integrations</p>
          <h2 className="mt-2 font-display text-2xl font-bold text-text-primary">
            Connect your sources
          </h2>
          <p className="mt-2 text-sm text-text-muted">
            Link Xero/QuickBooks, then run a sync to hydrate dashboards and the advisor.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={onConnectXero} disabled={actionInFlight}>
            Add Xero
          </Button>
          <Button variant="secondary" size="sm" onClick={onConnectQuickbooks} disabled={actionInFlight}>
            Add QuickBooks
          </Button>
          <Button
            size="sm"
            onClick={onSyncAll}
            loading={actionInFlight}
            disabled={!hasConnections}
            title={!hasConnections ? "Connect a source first" : undefined}
          >
            Run sync
          </Button>
          <Button variant="ghost" size="sm" onClick={onRefresh} disabled={isLoading}>
            {isLoading ? "Refreshing..." : "Refresh"}
          </Button>
        </div>
      </div>
    </section>
  );
}
