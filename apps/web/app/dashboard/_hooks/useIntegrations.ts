"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, type Connection, type SyncJob } from "../../../lib/api";
import { useNumeriquApi } from "../../../lib/useNumeriquApi";

export type LoadState = "idle" | "loading" | "ready" | "error";

function toUserError(caught: unknown, fallback: string) {
  if (caught instanceof ApiError) return caught.toUserMessage(fallback);
  if (caught instanceof Error) return caught.message || fallback;
  return fallback;
}

export function useIntegrations() {
  const { integrations, loading } = useNumeriquApi();
  const [state, setState] = useState<LoadState>("idle");
  const [connections, setConnections] = useState<Connection[]>([]);
  const [jobs, setJobs] = useState<SyncJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [actionInFlight, setActionInFlight] = useState(false);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);

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
      setHasLoadedOnce(true);
    } catch (caught) {
      setConnections([]);
      setJobs([]);
      setError(toUserError(caught, "We could not load your integrations."));
      setState("error");
    }
  }, [integrations]);

  useEffect(() => {
    if (loading) return;
    void refresh();
  }, [refresh, loading]);

  async function connectProvider(provider: "xero" | "quickbooks") {
    setActionInFlight(true);
    try {
      const { url } = await integrations.connectProvider(provider);
      window.location.assign(url);
    } catch (caught) {
      setError(toUserError(caught, "Connection failed. Please try again."));
    } finally {
      setActionInFlight(false);
    }
  }

  async function runSync(id: string) {
    setPendingActionId(id);
    try {
      await integrations.syncConnection(id);
      await pollUntilJobSettles(id);
    } catch (caught) {
      setError(toUserError(caught, "Sync failed. Please retry."));
    } finally {
      setPendingActionId(null);
    }
  }

  async function runSyncAll() {
    setActionInFlight(true);
    try {
      await integrations.syncAllConnections();
      await refresh();
    } catch (caught) {
      setError(toUserError(caught, "Sync failed. Please retry."));
    } finally {
      setActionInFlight(false);
    }
  }

  async function deleteConnection(id: string) {
    setPendingActionId(id);
    try {
      await integrations.deleteConnection(id);
      await refresh();
    } catch (caught) {
      setError(toUserError(caught, "Could not disconnect that integration."));
    } finally {
      setPendingActionId(null);
    }
  }

  /**
   * Poll the jobs endpoint a small number of times until the most recent job
   * for this connection finishes (or fails). Avoids an arbitrary setTimeout.
   */
  async function pollUntilJobSettles(connectionId: string) {
    const start = Date.now();
    const timeoutMs = 12_000;
    while (Date.now() - start < timeoutMs) {
      try {
        const next = await integrations.syncJobs();
        setJobs(next);
        const latest = next.find((job) => job.connectionId === connectionId);
        if (latest && (latest.status === "SUCCEEDED" || latest.status === "FAILED")) {
          await refresh();
          return;
        }
      } catch {
        // suppress — refresh() will surface persistent issues if any
      }
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    await refresh();
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
    pendingActionId,
    actionInFlight,
    hasLoadedOnce,
  };
}
