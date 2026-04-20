"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, type Connection, type SyncJob } from "../../../lib/api";
import { useNumeriquApi } from "../../../lib/useNumeriquApi";

type LoadState = "idle" | "loading" | "ready" | "error";

export function useIntegrations() {
  const { integrations, loading } = useNumeriquApi();
  const [state, setState] = useState<LoadState>("idle");
  const [connections, setConnections] = useState<Connection[]>([]);
  const [jobs, setJobs] = useState<SyncJob[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setState("loading");
    try {
      const [connectionPayload, jobsPayload] = await Promise.all([
        integrations.connections(),
        integrations.syncJobs(),
      ]);
      setConnections(connectionPayload);
      setJobs(jobsPayload);
      setError(null);
      setState("ready");
    } catch (caught) {
      setConnections([]);
      setJobs([]);
      setError(caught instanceof ApiError ? caught.message : "Could not load integrations.");
      setState("error");
    }
  }, [integrations]);

  useEffect(() => {
    if (loading) return;
    void refresh();
  }, [refresh, loading]);

  async function connectProvider(provider: "xero" | "quickbooks") {
    const { url } = await integrations.connectProvider(provider);
    window.location.assign(url);
  }

  async function runSync(id: string) {
    await integrations.syncConnection(id);
  }

  async function runSyncAll() {
    await integrations.syncAllConnections();
  }

  async function deleteConnection(id: string) {
    await integrations.deleteConnection(id);
  }

  return {
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
  };
}
