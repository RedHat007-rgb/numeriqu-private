"use client";

import { useState } from "react";
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
  const { state, dashboard, error, refresh, hasLoadedOnce } = useDashboard();

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

      <SystemSnapshot meta={dashboard.meta} />
    </div>
  );
}
