"use client";

import type { Connection } from "../../../../lib/api";
import { Button } from "../../../../components/ui/Button";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { StatusPill } from "../../../../components/ui/StatusPill";

type Props = {
  connections: Connection[];
  pendingActionId: string | null;
  onSync: (id: string) => void;
  onDelete: (id: string) => void;
};

function providerLabel(provider: string) {
  if (provider === "xero") return "Xero";
  if (provider === "quickbooks") return "QuickBooks";
  if (provider === "workday") return "Workday";
  if (provider === "dynamics365") return "Dynamics 365";
  return provider;
}

export function ConnectionsPanel({
  connections,
  pendingActionId,
  onSync,
  onDelete,
}: Props) {
  return (
    <div className="surface-card p-6">
      <p className="text-sm font-semibold text-text-secondary">Connections</p>
      <div className="mt-4 space-y-3">
        {connections.length === 0 ? (
          <EmptyState
            title="No active connections"
            detail="Connect Xero or QuickBooks to start syncing financial data into your workspace."
          />
        ) : (
          connections.map((connection) => {
            const pending = pendingActionId === connection.id;
            return (
              <div
                key={connection.id}
                className="rounded-2xl border border-default bg-surface-card/40 p-4"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-text-primary">
                      {connection.orgName}
                    </p>
                    <p className="text-xs uppercase tracking-[0.18em] text-text-muted">
                      {providerLabel(connection.provider)}
                    </p>
                  </div>
                  <StatusPill tone={connection.isActive ? "success" : "danger"}>
                    {connection.isActive ? "active" : "inactive"}
                  </StatusPill>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={() => onSync(connection.id)}
                    loading={pending}
                    disabled={pending}
                  >
                    Run sync
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onDelete(connection.id)}
                    disabled={pending}
                    className="hover:text-feedback-danger"
                  >
                    Disconnect
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
