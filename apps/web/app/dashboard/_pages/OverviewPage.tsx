"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "../../../components/ui/Button";
import { ErrorBanner } from "../../../components/ui/ErrorBanner";
import { Skeleton } from "../../../components/ui/Skeleton";
import { useDashboard } from "../_hooks/useDashboard";
import { ConnectedEntitiesCard } from "../_components/overview/ConnectedEntitiesCard";
import { KpiGrid } from "../_components/overview/KpiGrid";
import { NextActionsCard } from "../_components/overview/NextActionsCard";
import { OrgBreakdownCard } from "../_components/overview/OrgBreakdownCard";
import { RevenueTrendCard } from "../_components/overview/RevenueTrendCard";
import { SystemSnapshot } from "../_components/overview/SystemSnapshot";
import { useNumeriquApi } from "../../../lib/useNumeriquApi";
import { ApiError, type WorkspaceDashboardSummary } from "../../../lib/api";
import { EmptyState } from "../../../components/ui/EmptyState";

type SavedState = "loading" | "ready" | "error";

function formatWhen(value: string | null) {
  if (!value) return "not synced";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function OverviewSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-12">
        <Skeleton height={180} rounded="xl" className="lg:col-span-6" />
        <Skeleton height={180} rounded="xl" className="lg:col-span-3" />
        <Skeleton height={180} rounded="xl" className="lg:col-span-3" />
        <Skeleton height={180} rounded="xl" className="lg:col-span-3" />
        <Skeleton height={180} rounded="xl" className="lg:col-span-3" />
        <Skeleton height={180} rounded="xl" className="lg:col-span-3" />
        <Skeleton height={180} rounded="xl" className="lg:col-span-3" />
      </div>
      <div className="grid gap-6 xl:grid-cols-[1.25fr_0.75fr]">
        <Skeleton height={320} rounded="xl" />
        <Skeleton height={320} rounded="xl" />
      </div>
      <Skeleton height={220} rounded="xl" />
    </div>
  );
}

export function OverviewPage() {
  const { dashboards } = useNumeriquApi();
  const { state, dashboard, error, refresh, hasLoadedOnce } = useDashboard();
  const [savedDashboards, setSavedDashboards] = useState<WorkspaceDashboardSummary[]>([]);
  const [savedLoadState, setSavedLoadState] = useState<SavedState>("loading");
  const [savedError, setSavedError] = useState<string | null>(null);
  const [refreshingDashboardId, setRefreshingDashboardId] = useState<string | null>(null);

  async function loadSavedDashboards() {
    setSavedLoadState("loading");
    setSavedError(null);
    try {
      const payload = await dashboards.list();
      setSavedDashboards(payload);
      setSavedLoadState("ready");
    } catch (caught) {
      const message =
        caught instanceof ApiError
          ? caught.toUserMessage("We couldn't load saved dashboards right now.")
          : "We couldn't load saved dashboards right now.";
      setSavedError(message);
      setSavedLoadState("error");
    }
  }

  useEffect(() => {
    void loadSavedDashboards();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleRefreshDashboard(dashboardId: string) {
    setRefreshingDashboardId(dashboardId);
    setSavedError(null);
    try {
      await dashboards.refresh(dashboardId);
      await Promise.all([loadSavedDashboards(), refresh()]);
    } catch (caught) {
      const message =
        caught instanceof ApiError
          ? caught.toUserMessage("We couldn't refresh that dashboard right now.")
          : "We couldn't refresh that dashboard right now.";
      setSavedError(message);
    } finally {
      setRefreshingDashboardId(null);
    }
  }

  if (state === "loading" && !hasLoadedOnce) {
    return <OverviewSkeleton />;
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent-blue">Overview</p>
          <h2 className="mt-2 font-display text-2xl font-bold text-text-primary md:text-3xl">
            What changed in your finances
          </h2>
          <p className="mt-1 text-sm text-text-muted">
            North Star metrics first, then trend context, then actions. Every number is scoped to your synced entities.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void refresh()}
          loading={state === "loading"}
        >
          {state === "loading" ? "Refreshing..." : "Refresh overview"}
        </Button>
      </header>

      {state === "error" && error ? (
        <ErrorBanner
          title="We couldn't load your overview"
          tone="danger"
          action={
            <Button variant="secondary" size="sm" onClick={() => void refresh()}>
              Retry
            </Button>
          }
        >
          {error}
        </ErrorBanner>
      ) : null}

      <KpiGrid kpis={dashboard.kpis} venture={dashboard.venture} charts={dashboard.charts} />

      <section className="grid gap-6 xl:grid-cols-[1.25fr_0.75fr]">
        <RevenueTrendCard dashboard={dashboard} />
        <OrgBreakdownCard dashboard={dashboard} />
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <NextActionsCard insights={dashboard.insights} />
        <ConnectedEntitiesCard orgs={dashboard.connectedOrgs} />
      </section>

      <section className="surface-card p-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent-blue">Dashboards</p>
            <h3 className="mt-2 text-xl font-semibold text-text-primary">Saved decision surfaces</h3>
            <p className="mt-1 text-sm text-text-muted">
              Reopen or run live refresh on saved dashboards.
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => void loadSavedDashboards()}>
            Reload list
          </Button>
        </div>

        {savedError ? (
          <ErrorBanner className="mt-4" title="Dashboard refresh issue" tone="warning" onDismiss={() => setSavedError(null)}>
            {savedError}
          </ErrorBanner>
        ) : null}

        <div className="mt-4 space-y-3">
          {savedLoadState === "loading" ? (
            Array.from({ length: 3 }).map((_, idx) => <Skeleton key={idx} height={94} rounded="xl" />)
          ) : savedLoadState === "error" ? (
            <EmptyState
              title="Saved dashboards unavailable"
              detail="Retry once your connection is stable."
              action={
                <Button variant="secondary" size="sm" onClick={() => void loadSavedDashboards()}>
                  Retry
                </Button>
              }
            />
          ) : savedDashboards.length === 0 ? (
            <EmptyState
              title="No saved dashboards yet"
              detail="Create dashboards from the Agent Workbench to build your board pack library."
            />
          ) : (
            savedDashboards.slice(0, 8).map((item) => (
              <div key={item.id} className="rounded-xl border border-default bg-bg-elevated/40 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-text-primary">{item.title}</p>
                    {item.description ? (
                      <p className="mt-1 truncate text-sm text-text-secondary">{item.description}</p>
                    ) : null}
                    <p className="mt-2 text-xs text-text-muted">
                      Last synced {formatWhen(item.lastSyncedAt)} · updated {formatWhen(item.updatedAt)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-text-muted">{item.charts.length} charts</span>
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={refreshingDashboardId === item.id}
                      onClick={() => void handleRefreshDashboard(item.id)}
                    >
                      <RefreshCw className="size-4" /> Refresh
                    </Button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <SystemSnapshot meta={dashboard.meta} />
    </div>
  );
}
