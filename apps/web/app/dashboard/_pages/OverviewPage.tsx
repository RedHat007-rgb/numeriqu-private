"use client";

import { useDashboard } from "../_hooks/useDashboard";
import { KpiGrid } from "../_components/overview/KpiGrid";
import { OrgBreakdownCard } from "../_components/overview/OrgBreakdownCard";
import { RevenueTrendCard } from "../_components/overview/RevenueTrendCard";
import { SystemSnapshot } from "../_components/overview/SystemSnapshot";

export function OverviewPage() {
  const { state, dashboard, error } = useDashboard();

  return (
    <div className="space-y-6">
      {state === "error" && error ? (
        <div className="rounded-2xl border border-amber-400/20 bg-amber-400/10 p-4 text-amber-100">{error}</div>
      ) : null}
      <KpiGrid kpis={dashboard.kpis} venture={dashboard.venture} />
      <section className="grid gap-6 xl:grid-cols-[1.25fr_0.75fr]">
        <RevenueTrendCard dashboard={dashboard} />
        <OrgBreakdownCard dashboard={dashboard} />
      </section>
      <SystemSnapshot meta={dashboard.meta} />
    </div>
  );
}
