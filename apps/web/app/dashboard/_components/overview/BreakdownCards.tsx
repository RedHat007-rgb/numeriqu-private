"use client";

import type { LucideIcon } from "lucide-react";
import { Building2, Coins, Gauge, Layers, MapPin } from "lucide-react";
import { cn } from "../../../../components/ui/cn";
import type { DashboardResponse } from "../../../../lib/api";
import { formatMoneyWithCurrency, formatNumber, formatPercentDelta } from "./format";

type BarTone = "brand" | "positive" | "warning";

type BarItem = {
  name: string;
  valueLabel: string;
  subLabel?: string;
  /** 0..1 — width of the progress bar */
  fraction: number;
  tone?: BarTone;
};

type FooterStat = { label: string; value: string; detail?: string };

function barClass(tone: BarTone) {
  if (tone === "positive") return "from-[#2fd47a] to-[#00c7d2]";
  if (tone === "warning") return "from-[#f59e0b] to-[#ff5f7a]";
  return "from-[#00c7d2] to-[#4f8cff]";
}

/**
 * A ranked horizontal-bar card in the existing boardroom design language
 * (`dashboard-focus-card`). Reused for every CFO dimensional breakdown so the
 * cost/workforce/BU/delivery cards read as one coherent family.
 */
export function RankedBreakdownCard({
  eyebrow,
  title,
  icon: Icon,
  items,
  emptyLabel,
  footer,
}: {
  eyebrow: string;
  title: string;
  icon: LucideIcon;
  items: BarItem[];
  emptyLabel: string;
  footer?: FooterStat[];
}) {
  return (
    <section className="dashboard-focus-card h-full overflow-hidden p-5">
      <div className="flex items-start justify-between gap-4 border-b border-white/8 pb-4">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#7ecaff]">{eyebrow}</p>
          <h2 className="mt-2 max-w-[24ch] font-display text-[1.35rem] font-bold leading-tight text-white md:text-[1.5rem]">
            {title}
          </h2>
        </div>
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] text-[#8bd3ff]">
          <Icon className="h-5 w-5" />
        </div>
      </div>

      {items.length === 0 ? (
        <div className="mt-4 rounded-[1rem] border border-dashed border-white/10 px-4 py-6 text-sm leading-6 text-[#a8bfdf]">
          {emptyLabel}
        </div>
      ) : (
        <div className="mt-4 flex h-full flex-col">
          <div className="space-y-3.5">
            {items.map((item, index) => (
              <div key={`${item.name}-${index}`}>
                <div className="mb-1.5 flex items-end justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-white">{item.name}</p>
                    {item.subLabel ? <p className="text-[#9db4d8]">{item.subLabel}</p> : null}
                  </div>
                  <span className="shrink-0 font-mono text-[#8ad7ff]">{item.valueLabel}</span>
                </div>
                <div className="h-2 rounded-full bg-white/[0.06]">
                  <div
                    className={cn("h-2 rounded-full bg-gradient-to-r", barClass(item.tone ?? "brand"))}
                    style={{ width: `${Math.max(6, Math.min(100, item.fraction * 100))}%` }}
                  />
                </div>
              </div>
            ))}
          </div>

          {footer && footer.length > 0 ? (
            <div className="mt-5 grid gap-3 border-t border-white/8 pt-4 md:grid-cols-3">
              {footer.map((stat) => (
                <div key={stat.label} className="rounded-[1rem] border border-white/8 bg-white/[0.03] p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#86a7d0]">{stat.label}</p>
                  <p className="mt-1 truncate text-lg font-bold text-white">{stat.value}</p>
                  {stat.detail ? <p className="truncate text-xs text-[#9db4d8]">{stat.detail}</p> : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function maxOf(values: number[]) {
  return Math.max(...values, 1);
}

/* ------------------------------------------------------------------ */
/* Card builders — each reads real data off `dashboard.cfo`.           */
/* ------------------------------------------------------------------ */

export function BusinessUnitBreakdownCard({
  dashboard,
  currency,
}: {
  dashboard: DashboardResponse;
  currency: string;
}) {
  const units = dashboard.cfo?.businessUnits ?? [];
  const max = maxOf(units.map((u) => u.revenue));
  const top = units[0];
  const bestMargin = units.reduce<(typeof units)[number] | null>(
    (best, u) => (!best || u.marginPct > best.marginPct ? u : best),
    null,
  );

  return (
    <RankedBreakdownCard
      eyebrow="Portfolio mix"
      title="Where revenue and margin concentrate by business unit"
      icon={Building2}
      emptyLabel="No business-unit revenue in scope yet. Once EBPO revenue is synced, this card ranks each unit by revenue and gross margin."
      items={units.map((u) => ({
        name: u.name,
        valueLabel: formatMoneyWithCurrency(u.revenue, currency),
        subLabel: `${formatPercentDelta(u.marginPct / 100)} gross margin`,
        fraction: u.revenue / max,
        tone: u.marginPct >= 30 ? "positive" : u.marginPct < 15 ? "warning" : "brand",
      }))}
      footer={
        top
          ? [
              { label: "Top unit", value: top.name, detail: formatMoneyWithCurrency(top.revenue, currency) },
              {
                label: "Best margin",
                value: bestMargin ? bestMargin.name : "—",
                detail: bestMargin ? formatPercentDelta(bestMargin.marginPct / 100) : undefined,
              },
              { label: "Units in scope", value: formatNumber(units.length) },
            ]
          : undefined
      }
    />
  );
}

export function CostElementsCard({
  dashboard,
  currency,
}: {
  dashboard: DashboardResponse;
  currency: string;
}) {
  const elements = dashboard.cfo?.costElements ?? [];
  const total = elements.reduce((sum, e) => sum + e.value, 0);
  const max = maxOf(elements.map((e) => e.value));
  const largest = elements[0];

  return (
    <RankedBreakdownCard
      eyebrow="Cost structure"
      title="Which cost elements consume the operating budget"
      icon={Coins}
      emptyLabel="No cost elements in scope yet. This card breaks total operating cost into total cost, base salary, overtime, bonus and benefits."
      items={elements.map((e) => ({
        name: e.name,
        valueLabel: formatMoneyWithCurrency(e.value, currency),
        subLabel: total > 0 ? `${((e.value / total) * 100).toFixed(1)}% of cost` : undefined,
        fraction: e.value / max,
        tone: e.name === "Overtime" ? "warning" : "brand",
      }))}
      footer={
        largest
          ? [
              { label: "Total cost", value: formatMoneyWithCurrency(total, currency) },
              {
                label: "Largest element",
                value: largest.name,
                detail: total > 0 ? `${((largest.value / total) * 100).toFixed(1)}% of cost` : undefined,
              },
              { label: "Elements", value: formatNumber(elements.length) },
            ]
          : undefined
      }
    />
  );
}

export function WorkforceByDepartmentCard({
  dashboard,
  currency,
}: {
  dashboard: DashboardResponse;
  currency: string;
}) {
  const depts = dashboard.cfo?.headcountByDepartment ?? [];
  // Totals come from the backend over the FULL range (all departments), so they don't
  // understate when the bars are capped at the top 6. Fall back to the row sum only if the
  // backend didn't supply them.
  const totalHeadcount =
    dashboard.cfo?.workforceHeadcount ?? depts.reduce((sum, d) => sum + d.headcount, 0);
  const totalPayroll =
    dashboard.cfo?.workforcePayroll ?? depts.reduce((sum, d) => sum + d.payroll, 0);
  const max = maxOf(depts.map((d) => d.headcount));
  const top = depts[0];

  return (
    <RankedBreakdownCard
      eyebrow="Workforce"
      title="How headcount and payroll are distributed by department"
      icon={Layers}
      emptyLabel="No department headcount in scope yet. Once payroll is synced, this card ranks departments by headcount and monthly payroll."
      items={depts.map((d) => ({
        name: d.name,
        valueLabel: `${formatNumber(d.headcount)} FTE`,
        subLabel: `${formatMoneyWithCurrency(d.payroll, currency)} payroll`,
        fraction: d.headcount / max,
      }))}
      footer={
        top
          ? [
              { label: "Total headcount", value: `${formatNumber(totalHeadcount)} FTE` },
              { label: "Largest team", value: top.name, detail: `${formatNumber(top.headcount)} FTE` },
              { label: "Total payroll", value: formatMoneyWithCurrency(totalPayroll, currency) },
            ]
          : undefined
      }
    />
  );
}

export function WorkforceByGeographyCard({ dashboard }: { dashboard: DashboardResponse }) {
  const geos = dashboard.cfo?.headcountByGeography ?? [];
  // Use the backend's full-range totals so percentages and the country count reflect ALL
  // countries, not just the top-6 shown as bars. Fall back to row-derived values.
  const total = dashboard.cfo?.workforceHeadcount ?? geos.reduce((sum, g) => sum + g.headcount, 0);
  const countryCount = dashboard.cfo?.workforceCountries ?? geos.length;
  const max = maxOf(geos.map((g) => g.headcount));
  const top = geos[0];

  return (
    <RankedBreakdownCard
      eyebrow="Global footprint"
      title="Where the delivery workforce sits by geography"
      icon={MapPin}
      emptyLabel="No geographic headcount in scope yet. Once payroll is synced, this card ranks countries by delivery headcount."
      items={geos.map((g) => ({
        name: g.name,
        valueLabel: `${formatNumber(g.headcount)} FTE`,
        subLabel: total > 0 ? `${((g.headcount / total) * 100).toFixed(1)}% of workforce` : undefined,
        fraction: g.headcount / max,
      }))}
      footer={
        top
          ? [
              { label: "Countries", value: formatNumber(countryCount) },
              {
                label: "Largest base",
                value: top.name,
                detail: total > 0 ? `${((top.headcount / total) * 100).toFixed(1)}% of FTE` : undefined,
              },
              { label: "Total FTE", value: formatNumber(total) },
            ]
          : undefined
      }
    />
  );
}

export function DeliveryCenterScorecardCard({ dashboard }: { dashboard: DashboardResponse }) {
  const centers = dashboard.cfo?.deliveryCenters ?? [];
  const best = centers[0];
  const avgUtil =
    centers.length > 0 ? centers.reduce((sum, c) => sum + c.utilizationPct, 0) / centers.length : 0;

  return (
    <RankedBreakdownCard
      eyebrow="Service delivery"
      title="Which delivery centers protect SLA and utilization"
      icon={Gauge}
      emptyLabel="No delivery-center operations in scope yet. Once operations data is synced, this card ranks centers by SLA with utilization and CSAT."
      items={centers.map((c) => ({
        name: c.name,
        valueLabel: formatPercentDelta(c.slaPct / 100),
        subLabel: `${formatPercentDelta(c.utilizationPct / 100)} util · ${formatPercentDelta(c.csatPct / 100)} CSAT`,
        fraction: c.slaPct / 100,
        tone: c.slaPct >= 95 ? "positive" : c.slaPct < 90 ? "warning" : "brand",
      }))}
      footer={
        best
          ? [
              { label: "Best center", value: best.name, detail: `${formatPercentDelta(best.slaPct / 100)} SLA` },
              { label: "Avg utilization", value: formatPercentDelta(avgUtil / 100) },
              { label: "Centers", value: formatNumber(centers.length) },
            ]
          : undefined
      }
    />
  );
}
