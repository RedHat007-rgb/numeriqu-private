"use client";

import { Button } from "../../../components/ui/Button";
import { ErrorBanner } from "../../../components/ui/ErrorBanner";
import { Skeleton } from "../../../components/ui/Skeleton";
import { ConnectionsPanel } from "../_components/integrations/ConnectionsPanel";
import { IntegrationsHeader } from "../_components/integrations/IntegrationsHeader";
import { SyncJobsPanel } from "../_components/integrations/SyncJobsPanel";
import { useIntegrations } from "../_hooks/useIntegrations";

export function IntegrationsPage() {
  const {
    state,
    connections,
    jobs,
    error,
    refresh,
    connectProvider,
    runSync,
    runSyncAll,
    deleteConnection,
    setError,
    pendingActionId,
    actionInFlight,
    hasLoadedOnce,
  } = useIntegrations();

  const initialLoading = state === "loading" && !hasLoadedOnce;

  return (
    <div className="space-y-6">
      <IntegrationsHeader
        isLoading={state === "loading"}
        actionInFlight={actionInFlight}
        hasConnections={connections.length > 0}
        onConnectXero={() => void connectProvider("xero")}
        onConnectQuickbooks={() => void connectProvider("quickbooks")}
        onSyncAll={() => void runSyncAll()}
        onRefresh={() => void refresh()}
      />

      {error ? (
        <ErrorBanner
          title={state === "error" ? "We couldn't load your integrations" : "Action failed"}
          tone="danger"
          onDismiss={() => setError(null)}
          action={
            <Button variant="secondary" size="sm" onClick={() => void refresh()}>
              Retry
            </Button>
          }
        >
          {error}
        </ErrorBanner>
      ) : null}

      {initialLoading ? (
        <section className="grid gap-6 lg:grid-cols-2">
          <Skeleton height={280} rounded="xl" />
          <Skeleton height={280} rounded="xl" />
        </section>
      ) : (
        <section className="grid gap-6 lg:grid-cols-2">
          <ConnectionsPanel
            connections={connections}
            pendingActionId={pendingActionId}
            onSync={(id) => void runSync(id)}
            onDelete={(id) => void deleteConnection(id)}
          />
          <SyncJobsPanel jobs={jobs} />
        </section>
      )}
    </div>
  );
}
