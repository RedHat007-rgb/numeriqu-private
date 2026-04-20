"use client";

import { IntegrationsHeader } from "../_components/integrations/IntegrationsHeader";
import { ConnectionsPanel } from "../_components/integrations/ConnectionsPanel";
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
  } = useIntegrations();

  async function safeConnect(provider: "xero" | "quickbooks") {
    try {
      await connectProvider(provider);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Connection failed.");
    }
  }

  async function safeSync(id: string) {
    try {
      await runSync(id);
      setTimeout(() => void refresh(), 1200);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sync failed.");
    }
  }

  async function safeSyncAll() {
    try {
      await runSyncAll();
      setTimeout(() => void refresh(), 1200);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sync failed.");
    }
  }

  async function safeDelete(id: string) {
    try {
      await deleteConnection(id);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Disconnect failed.");
    }
  }

  return (
    <div className="space-y-6">
      {state === "error" && error ? (
        <div className="rounded-2xl border border-amber-400/20 bg-amber-400/10 p-4 text-amber-100">{error}</div>
      ) : null}

      <IntegrationsHeader
        isLoading={state === "loading"}
        onConnectXero={() => void safeConnect("xero")}
        onConnectQuickbooks={() => void safeConnect("quickbooks")}
        onSyncAll={() => void safeSyncAll()}
        onRefresh={() => void refresh()}
      />

      <section className="grid gap-6 lg:grid-cols-2">
        <ConnectionsPanel
          connections={connections}
          onSync={(id) => void safeSync(id)}
          onDelete={(id) => void safeDelete(id)}
        />
        <SyncJobsPanel jobs={jobs} />
      </section>
    </div>
  );
}
